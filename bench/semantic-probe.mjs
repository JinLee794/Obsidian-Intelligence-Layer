/**
 * Semantic probe — evaluate the semantic tier against a real vault, without
 * hand-labelled ground truth.
 *
 * Judging retrieval normally needs query/answer pairs nobody has time to write.
 * This sidesteps that three ways:
 *
 *   1. Link agreement. A wikilink is a human assertion that two notes are
 *      related. If the embedding space is capturing anything real about *this*
 *      vault, linked notes should rank near each other by cosine. Measured
 *      against a random-pair baseline, so a meaningless space scores ~50%.
 *   2. Score distribution. Shows whether `minScore` is filtering out real hits
 *      or letting everything through, on this vault's actual numbers.
 *   3. Nearest neighbours and query ablation, for eyeballing — you know your own
 *      notes, so ten sampled neighbourhoods tell you more than any metric.
 *
 * Runs against a temp copy, so it never writes a sidecar into your real vault.
 *
 *   node bench/semantic-probe.mjs [--vault=<path>] [--query="..."] [--samples=10]
 */

import { cp, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphIndex } from "../dist/graph.js";
import { loadConfig } from "../dist/config.js";
import { SemanticIndex, attachSemanticIndex, detachSemanticIndex } from "../dist/semantic.js";
import { cascadeSearch } from "../dist/search.js";

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const queries = [];
let vaultArg = process.env.OBSIDIAN_VAULT_PATH;
let samples = 8;
let fresh = false;

for (const arg of args) {
  if (arg === "--fresh") {
    fresh = true;
    continue;
  }
  const match = /^--([a-z-]+)=(.*)$/s.exec(arg);
  if (!match) continue;
  const [, name, value] = match;
  if (name === "vault") vaultArg = value;
  else if (name === "query") queries.push(value);
  else if (name === "samples") samples = Number(value) || samples;
}

if (!vaultArg) {
  console.error("No vault. Pass --vault=<path> or set OBSIDIAN_VAULT_PATH.");
  process.exit(1);
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

function decodeVector(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}

/** Vectors are stored normalised, so cosine is a dot product. */
function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function quantile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

// ─── Setup ────────────────────────────────────────────────────────────────────

// Scratch copy keyed on the vault path, so repeat runs reuse the cached vectors
// instead of paying for a full re-embed. Your real vault is never written to.
const scratchKey = createHash("sha256").update(vaultArg).digest("hex").slice(0, 12);
const tempRoot = join(tmpdir(), `oil-probe-${scratchKey}`);
const vault = join(tempRoot, "vault");

if (fresh && existsSync(tempRoot)) await rm(tempRoot, { recursive: true, force: true });

const reusing = existsSync(vault);
if (reusing) {
  console.log(`\nReusing cached scratch copy at ${tempRoot} (pass --fresh to rebuild).`);
  // Sync note content forward; the sidecar stays, so only edits get re-embedded.
  await cp(vaultArg, vault, { recursive: true, force: true });
} else {
  console.log(`\nCopying vault to a scratch directory (your vault is not modified)...`);
  await mkdir(tempRoot, { recursive: true });
  await cp(vaultArg, vault, { recursive: true });
}

const config = await loadConfig(vault);
if (!config.semantic.enabled) {
  console.error("Semantic tier is disabled by configuration. Nothing to probe.");
  process.exit(1);
}

const graph = new GraphIndex(vault);
await graph.build();

const semantic = new SemanticIndex(vault, config.semantic);
attachSemanticIndex(graph, semantic);
await semantic.load();

console.log(
  `Embedding ${graph.nodeCount} notes with '${config.semantic.model}'` +
    (reusing ? " (cached vectors reused where unchanged)" : "") + "...",
);
const embedStart = Date.now();
await semantic.refresh(graph);
if (semantic.status !== "ready") {
  console.error(`\nSemantic tier is ${semantic.status}: ${semantic.stats.reason}`);
  process.exit(1);
}
console.log(`Done in ${((Date.now() - embedStart) / 1000).toFixed(1)}s.\n`);

// ─── Load the vectors the tier just wrote ─────────────────────────────────────

const sidecar = JSON.parse(await readFile(join(vault, config.semantic.indexFile), "utf-8"));
const paths = Object.keys(sidecar.entries);
const vectors = new Map(paths.map((p) => [p, decodeVector(sidecar.entries[p].vector)]));

console.log("═".repeat(74));
console.log(`Semantic probe — ${vaultArg}`);
console.log("═".repeat(74));
console.log(`\n  ${paths.length} notes embedded, ${sidecar.dimensions} dimensions, model ${sidecar.model}`);

// ─── 1. Link agreement ────────────────────────────────────────────────────────

/** Percentile rank of `target` among all notes ordered by similarity to `source`. */
function percentileRank(source, target) {
  const sourceVector = vectors.get(source);
  const targetVector = vectors.get(target);
  if (!sourceVector || !targetVector) return null;

  const score = cosine(sourceVector, targetVector);
  let better = 0;
  let total = 0;
  for (const [path, vector] of vectors) {
    if (path === source) continue;
    total++;
    if (cosine(sourceVector, vector) > score) better++;
  }
  return total > 0 ? better / total : null;
}

const linkRanks = [];
for (const path of paths) {
  const node = graph.getNode(path);
  if (!node) continue;
  for (const target of node.outLinks) {
    const rank = percentileRank(path, target);
    if (rank !== null) linkRanks.push(rank);
  }
}

// Random pairs, as the null hypothesis this has to beat.
const randomRanks = [];
for (let i = 0; i < Math.min(300, paths.length * 2); i++) {
  const a = paths[Math.floor(Math.random() * paths.length)];
  const b = paths[Math.floor(Math.random() * paths.length)];
  if (a === b) continue;
  const rank = percentileRank(a, b);
  if (rank !== null) randomRanks.push(rank);
}

console.log("\n── Link agreement ──────────────────────────────────────────────────────");
console.log("   Where do notes you linked by hand rank by cosine? Lower is better;");
console.log("   a space that captured nothing would sit around 50%, same as random.\n");
if (linkRanks.length === 0) {
  console.log("   No resolved wikilinks in this vault — skipping.");
} else {
  console.log(`   linked pairs      ${linkRanks.length}`);
  console.log(`   median rank       ${pct(median(linkRanks))}   (random baseline ${pct(median(randomRanks))})`);
  console.log(`   top decile        ${pct(linkRanks.filter((r) => r <= 0.1).length / linkRanks.length)} of linked notes rank in the top 10%`);
  console.log(`   top percentile    ${pct(linkRanks.filter((r) => r <= 0.01).length / linkRanks.length)} rank in the top 1%`);

  const verdict =
    median(linkRanks) < 0.15
      ? "STRONG — embeddings track the structure you created by hand"
      : median(linkRanks) < 0.3
        ? "REASONABLE — related notes are nearby but not tightly clustered"
        : "WEAK — the space is barely better than random on this vault";
  console.log(`\n   verdict: ${verdict}`);
}

// ─── 2. Score distribution ────────────────────────────────────────────────────

const nearestScores = [];
for (const [path, vector] of vectors) {
  let best = -1;
  for (const [other, otherVector] of vectors) {
    if (other === path) continue;
    const score = cosine(vector, otherVector);
    if (score > best) best = score;
  }
  nearestScores.push(best);
}

console.log("\n── Score distribution ──────────────────────────────────────────────────");
console.log("   Cosine to each note's closest neighbour. Your minScore has to sit");
console.log("   below these or real matches get filtered out before you see them.\n");
console.log(`   min ${quantile(nearestScores, 0).toFixed(3)}   p10 ${quantile(nearestScores, 0.1).toFixed(3)}   median ${median(nearestScores).toFixed(3)}   p90 ${quantile(nearestScores, 0.9).toFixed(3)}`);
console.log(`   configured minScore: ${config.semantic.minScore}`);
const belowFloor = nearestScores.filter((s) => s < config.semantic.minScore).length;
if (belowFloor > 0) {
  console.log(
    `   WARNING: ${belowFloor} note(s) have no neighbour above the floor — they can never be returned.`,
  );
} else {
  console.log("   Every note has at least one neighbour above the floor.");
}

// ─── 3. Nearest neighbours, for eyeballing ────────────────────────────────────

console.log("\n── Nearest neighbours (sanity check these yourself) ─────────────────────\n");
const sampled = [...paths].sort(() => Math.random() - 0.5).slice(0, samples);
for (const path of sampled) {
  const vector = vectors.get(path);
  const neighbours = [];
  for (const [other, otherVector] of vectors) {
    if (other === path) continue;
    neighbours.push({ path: other, score: cosine(vector, otherVector) });
  }
  neighbours.sort((a, b) => b.score - a.score);
  console.log(`   ${path}`);
  for (const n of neighbours.slice(0, 3)) {
    console.log(`      ${n.score.toFixed(3)}  ${n.path}`);
  }
  console.log();
}

// ─── 4. Query ablation ────────────────────────────────────────────────────────

if (queries.length > 0) {
  console.log("── Query-to-note scores (this is what minScore gates) ──────────────────\n");
  console.log("   Note-to-note similarity above runs high for any model; what the floor");
  console.log("   actually filters is a short query against a long note. Those score");
  console.log("   lower, so a floor tuned on note pairs will silently discard real hits.\n");

  for (const query of queries) {
    const hits = await semantic.search(query, 10);
    const allScores = hits.map((h) => h.score);
    console.log(`   "${query}"`);
    if (allScores.length === 0) {
      console.log(`      no hits above minScore ${config.semantic.minScore} — floor is too high\n`);
      continue;
    }
    console.log(
      `      top ${allScores.length}: ${allScores[0].toFixed(3)} … ${allScores[allScores.length - 1].toFixed(3)}`,
    );
    for (const hit of hits.slice(0, 3)) {
      console.log(`      ${hit.score.toFixed(3)}  ${hit.path}`);
    }
    console.log();
  }
}

if (queries.length > 0) {
  console.log("── Query ablation: what the semantic tier adds ──────────────────────────\n");
  for (const query of queries) {
    detachSemanticIndex(graph);
    const without = await cascadeSearch(graph, query, 10, undefined);
    attachSemanticIndex(graph, semantic);
    const with_ = await cascadeSearch(graph, query, 10, undefined);

    const lexicalPaths = new Set(without.results.map((r) => r.path));
    const added = with_.results.filter((r) => !lexicalPaths.has(r.path));

    console.log(`   "${query}"`);
    console.log(`      tiers: ${with_.tiers_used?.join(" + ") ?? with_.tiersUsed.join(" + ")}`);
    console.log(`      lexical-only top 3: ${without.results.slice(0, 3).map((r) => r.path).join(", ") || "(none)"}`);
    console.log(`      with semantic top 3: ${with_.results.slice(0, 3).map((r) => r.path).join(", ") || "(none)"}`);
    if (added.length > 0) {
      console.log(`      surfaced ONLY by semantic:`);
      for (const hit of added.slice(0, 5)) console.log(`         ${hit.path}`);
    } else {
      console.log("      semantic added nothing new for this query");
    }
    console.log();
  }
} else {
  console.log("── Query ablation ──────────────────────────────────────────────────────");
  console.log("   Pass --query=\"...\" (repeatable) to see which notes only the");
  console.log("   semantic tier surfaces for questions you actually care about.\n");
}

detachSemanticIndex(graph);
console.log(`Scratch copy kept at ${tempRoot} for fast re-runs; delete it or pass --fresh to reset.\n`);
