/**
 * Golden-set evaluation for search_vault.
 *
 * A static, versioned set of query scenarios with known answers, so retrieval
 * quality becomes a number that can be compared across changes instead of an
 * impression formed from a handful of spot checks.
 *
 *   node bench/eval-golden.mjs --dataset=bench/datasets/fixture.golden.json
 *   node bench/eval-golden.mjs --dataset=... --baseline          # record
 *   node bench/eval-golden.mjs --dataset=... --compare           # gate
 *
 * Dataset schema:
 * {
 *   "vault": "<path, absolute or relative to repo root>",
 *   "cases": [{
 *     "id": "unique-id",
 *     "scenario": "identifier | exact-entity | typo | paraphrase | attribute",
 *     "query": "text passed to search_vault",
 *     "relevant": ["Path/To/Note.md", ...],   // any of these counts as a hit
 *     "primary": "Path/To/Note.md",           // optional: must rank at #1
 *     "expectTiers": ["lexical"],             // optional: tiers that must run
 *     "forbidTiers": ["semantic"],            // optional: tiers that must not
 *     "requiresSemantic": true                // optional: skipped without Ollama
 *   }]
 * }
 *
 * `forbidTiers` is what keeps the cheap path honest: an identifier lookup that
 * quietly starts paying for an embedding round trip is a regression even when
 * its results are unchanged.
 *
 * Baselines are stored per mode. Scores with the semantic tier off are legitimately
 * lower, so comparing across modes would report a regression that is really just a
 * missing Ollama.
 *
 * ── Why this harness refuses to score ────────────────────────────────────────
 *
 * At runtime a failed embedding degrades to an empty result on purpose, so an
 * unreachable Ollama never breaks a user's search. Measured, that same
 * behaviour is a lie: the run reports a *lower quality score* when what actually
 * happened was that the machine was busy. Observed directly on this repo, five
 * runs of identical code gave hit rates of 100/100/100/92/92% and MRR
 * 0.896/0.917/0.854/0.833/0.833 — a spread larger than any ranking change the
 * release claimed, produced entirely by per-query embedder failures that the
 * tier's own status never reflected because the status was sampled before the
 * queries ran.
 *
 * So the harness snapshots the tier's degradation counters around every case.
 * If any case was answered by a degraded tier, no metric is printed and the
 * process exits non-zero. A refusal is a usable signal; a number that silently
 * mixes infrastructure failure into retrieval quality is not.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphIndex } from "../dist/graph.js";
import { loadConfig } from "../dist/config.js";
import { SemanticIndex, attachSemanticIndex } from "../dist/semantic.js";
import { cascadeSearch } from "../dist/search.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Args ─────────────────────────────────────────────────────────────────────

let datasetPath = join(repoRoot, "bench", "datasets", "fixture.golden.json");
let mode = "report";
let limit = 10;
let noSemantic = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "--baseline") mode = "baseline";
  else if (arg === "--compare") mode = "compare";
  else if (arg === "--no-semantic") noSemantic = true;
  else {
    const match = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (!match) continue;
    if (match[1] === "dataset") datasetPath = resolve(repoRoot, match[2]);
    else if (match[1] === "limit") limit = Number(match[2]) || limit;
  }
}

const dataset = JSON.parse(await readFile(datasetPath, "utf-8"));
const vaultPath = isAbsolute(dataset.vault) ? dataset.vault : join(repoRoot, dataset.vault);

if (!existsSync(vaultPath)) {
  console.error(`Vault not found: ${vaultPath}`);
  process.exit(1);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const config = await loadConfig(vaultPath);
const graph = new GraphIndex(vaultPath);
await graph.build();

let semanticIndex = null;
let semanticReady = false;
if (!noSemantic && config.semantic.enabled) {
  semanticIndex = new SemanticIndex(vaultPath, config.semantic);
  attachSemanticIndex(graph, semanticIndex);
  await semanticIndex.load();
  process.stdout.write(`Embedding ${graph.nodeCount} notes... `);
  await semanticIndex.refresh(graph);
  semanticReady = semanticIndex.status === "ready";
  console.log(semanticReady ? "ready." : `${semanticIndex.status}: ${semanticIndex.stats.reason}`);
}

/**
 * A semantic run was asked for and could not be delivered.
 *
 * Falling back to lexical numbers here would be the same laundering the
 * per-case check exists to stop, one level up: the run would print a real-looking
 * score for a configuration nobody asked to measure. `--no-semantic` is how you
 * ask for a lexical measurement.
 */
if (!noSemantic && config.semantic.enabled && !semanticReady) {
  console.error(
    `\nREFUSING TO SCORE: a semantic run was requested but the tier is ` +
      `${semanticIndex?.status ?? "absent"} (${semanticIndex?.stats.reason ?? "no index"}).\n` +
      `  Start Ollama, or pass --no-semantic to measure the lexical tiers on purpose.\n`,
  );
  process.exit(2);
}

/** Failures the tier absorbed so far, or null when there is no tier to ask. */
const degradationCount = () => {
  if (!semanticIndex) return null;
  const { queryFailures, indexFailures } = semanticIndex.degradation;
  return queryFailures + indexFailures;
};

// ─── Metrics ──────────────────────────────────────────────────────────────────

/** Reciprocal rank of the first relevant hit, or 0 if none appear. */
function reciprocalRank(paths, relevant) {
  for (let i = 0; i < paths.length; i++) {
    if (relevant.includes(paths[i])) return 1 / (i + 1);
  }
  return 0;
}

const results = [];
const skipped = [];
/** Cases whose answer was shaped by an embedder failure rather than by ranking. */
const degraded = [];

for (const testCase of dataset.cases) {
  // A case that only makes sense with embeddings is not a failure without them.
  if (testCase.requiresSemantic && !semanticReady) {
    skipped.push(testCase.id);
    continue;
  }

  const failuresBefore = degradationCount();
  const { results: hits, tiersUsed } = await cascadeSearch(graph, testCase.query, limit, undefined);
  const failuresAfter = degradationCount();

  // The tier swallowed an error while answering *this* query, so whatever it
  // returned describes the machine, not the ranking. Recording the case and
  // continuing gives a complete picture of how bad the run was before refusing.
  if (failuresBefore !== null && failuresAfter > failuresBefore) {
    degraded.push({
      id: testCase.id,
      query: testCase.query,
      reason: semanticIndex.degradation.lastReason,
    });
  }

  const paths = hits.map((h) => h.path);
  const relevant = testCase.relevant ?? [];

  const found = relevant.filter((p) => paths.includes(p));
  const rr = reciprocalRank(paths, relevant);
  const primaryOk = testCase.primary ? paths[0] === testCase.primary : null;
  // Tier expectations that name the semantic tier only hold when it is running.
  const expectTiers = (testCase.expectTiers ?? []).filter(
    (t) => semanticReady || t !== "semantic",
  );
  const tierOk =
    expectTiers.every((t) => tiersUsed.includes(t)) &&
    (testCase.forbidTiers ?? []).every((t) => !tiersUsed.includes(t));

  results.push({
    id: testCase.id,
    scenario: testCase.scenario,
    query: testCase.query,
    hit: found.length > 0,
    recall: relevant.length > 0 ? found.length / relevant.length : null,
    rr,
    rank: paths.findIndex((p) => relevant.includes(p)),
    primaryOk,
    tierOk,
    tiersUsed,
    top3: paths.slice(0, 3),
  });
}

// ─── Refuse a degraded run ────────────────────────────────────────────────────

// Anything below this point turns the per-case record into a published number.
// A run where the embedder failed has no number worth publishing, so it stops
// here rather than averaging an infrastructure fault into a quality metric.
if (degraded.length > 0) {
  console.error(`\n${"═".repeat(78)}`);
  console.error(`REFUSING TO SCORE: the semantic tier failed on ${degraded.length} of ${results.length} case(s).`);
  console.error("═".repeat(78));
  for (const d of degraded) {
    console.error(`  ${d.id.padEnd(28)} "${d.query}"`);
    console.error(`  ${" ".repeat(28)} ${d.reason}`);
  }
  console.error(
    `\n  Those cases were answered without embeddings, so their ranks measure the\n` +
      `  machine rather than the code. Re-run on an idle machine, or raise\n` +
      `  OIL_SEMANTIC_TIMEOUT_MS (currently ${config.semantic.timeoutMs}ms per input).\n`,
  );
  process.exit(2);
}

// ─── Aggregate ────────────────────────────────────────────────────────────────

const byScenario = new Map();
for (const r of results) {
  const bucket = byScenario.get(r.scenario) ?? [];
  bucket.push(r);
  byScenario.set(r.scenario, bucket);
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * Counts behind each rate.
 *
 * A percentage on a set this size is a trap: at N=12, one case moving is eight
 * points, which reads like a trend and is not. Printing `11/12` beside `92%`
 * makes the sample size impossible to overlook — the published 87%→93% claim
 * this harness is meant to support was 13/15→14/15, a single case.
 */
const counts = {
  hit: results.filter((r) => r.hit).length,
  primary: results.filter((r) => r.primaryOk === true).length,
  primary_total: results.filter((r) => r.primaryOk !== null).length,
  tier: results.filter((r) => r.tierOk).length,
  recall_total: results.filter((r) => r.recall !== null).length,
};

const summary = {
  dataset: dataset.name ?? datasetPath,
  mode: noSemantic ? "lexical" : semanticReady ? "semantic" : "lexical",
  cases: results.length,
  skipped: skipped.length,
  semantic: noSemantic ? "off" : semanticReady ? "on" : "unavailable",
  hit_rate: Number(mean(results.map((r) => (r.hit ? 1 : 0))).toFixed(4)),
  hit_count: counts.hit,
  mrr: Number(mean(results.map((r) => r.rr)).toFixed(4)),
  recall: Number(mean(results.filter((r) => r.recall !== null).map((r) => r.recall)).toFixed(4)),
  recall_cases: counts.recall_total,
  primary_accuracy: Number(
    mean(results.filter((r) => r.primaryOk !== null).map((r) => (r.primaryOk ? 1 : 0))).toFixed(4),
  ),
  primary_count: counts.primary,
  primary_cases: counts.primary_total,
  tier_routing: Number(mean(results.map((r) => (r.tierOk ? 1 : 0))).toFixed(4)),
  tier_count: counts.tier,
  by_scenario: Object.fromEntries(
    [...byScenario].map(([scenario, bucket]) => [
      scenario,
      {
        cases: bucket.length,
        hit_count: bucket.filter((r) => r.hit).length,
        hit_rate: Number(mean(bucket.map((r) => (r.hit ? 1 : 0))).toFixed(4)),
        mrr: Number(mean(bucket.map((r) => r.rr)).toFixed(4)),
      },
    ]),
  ),
};

// ─── Report ───────────────────────────────────────────────────────────────────

const pct = (n) => `${(n * 100).toFixed(0)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log(`Golden set: ${summary.dataset}   (semantic ${summary.semantic})`);
console.log("═".repeat(78));

for (const [scenario, bucket] of byScenario) {
  console.log(`\n  ${scenario}`);
  for (const r of bucket) {
    const status = !r.tierOk ? "TIER" : r.hit ? (r.primaryOk === false ? "rank" : "ok  ") : "MISS";
    console.log(`    ${status}  ${r.id.padEnd(28)} rank ${r.rank < 0 ? "—" : r.rank}  tiers ${r.tiersUsed.join("+")}`);
    if (!r.hit || r.primaryOk === false || !r.tierOk) {
      console.log(`          "${r.query}"`);
      console.log(`          top3: ${r.top3.join(", ") || "(none)"}`);
    }
  }
}

console.log(`\n${"─".repeat(78)}`);
if (skipped.length > 0) {
  console.log(`  skipped           ${skipped.length} case(s) needing the semantic tier: ${skipped.join(", ")}`);
}
console.log(`  hit rate          ${pct(summary.hit_rate)}   (${counts.hit}/${results.length})`);
console.log(`  MRR               ${summary.mrr.toFixed(3)}   (over ${results.length} case(s))`);
console.log(`  recall            ${pct(summary.recall)}   (mean over ${counts.recall_total} case(s))`);
console.log(
  `  primary accuracy  ${pct(summary.primary_accuracy)}   (${counts.primary}/${counts.primary_total})`,
);
console.log(`  tier routing      ${pct(summary.tier_routing)}   (${counts.tier}/${results.length})`);
console.log(`\n  One case is worth ${(100 / results.length).toFixed(1)} points of hit rate at this sample size.`);
console.log();

// ─── Baseline ─────────────────────────────────────────────────────────────────

// Baselines are per mode: a lexical-only run scores lower by design, and
// comparing it against a semantic baseline would flag a missing Ollama as a
// code regression.
const baselinePath = datasetPath.replace(
  /\.json$/,
  summary.mode === "semantic" ? ".baseline.json" : ".lexical.baseline.json",
);

if (mode === "baseline") {
  await writeFile(baselinePath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  console.log(`Baseline written to ${baselinePath}\n`);
} else if (mode === "compare") {
  if (!existsSync(baselinePath)) {
    console.error(`No ${summary.mode} baseline at ${baselinePath}. Run with --baseline first.`);
    process.exit(1);
  }
  const previous = JSON.parse(await readFile(baselinePath, "utf-8"));
  if (previous.mode && previous.mode !== summary.mode) {
    console.error(
      `Baseline was recorded in ${previous.mode} mode but this run is ${summary.mode}. Refusing to compare.`,
    );
    process.exit(1);
  }
  const metrics = ["hit_rate", "mrr", "recall", "primary_accuracy", "tier_routing"];
  let regressed = false;

  console.log("Comparison against baseline\n");
  for (const metric of metrics) {
    const before = previous[metric] ?? 0;
    const after = summary[metric] ?? 0;
    const delta = after - before;
    // A small tolerance absorbs tie-order noise without hiding a real drop.
    const bad = delta < -0.02;
    if (bad) regressed = true;
    console.log(
      `  ${metric.padEnd(18)} ${before.toFixed(3)} → ${after.toFixed(3)}  ${
        delta >= 0 ? "+" : ""
      }${delta.toFixed(3)}${bad ? "   REGRESSION" : ""}`,
    );
  }
  console.log();
  process.exit(regressed ? 1 : 0);
}
