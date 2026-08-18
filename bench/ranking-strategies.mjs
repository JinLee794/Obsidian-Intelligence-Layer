/**
 * Compare ranking strategies against a golden set.
 *
 * The cascade currently fuses three tiers by rank. That is one choice among
 * several, and until now there was no way to check it was the right one: the
 * golden set could score the shipped build, but not answer "would a single tier,
 * or a score blend, or a different fusion constant, do better?"
 *
 * This runs each tier once per query, then scores every strategy over the same
 * retrieved candidates — so the comparison isolates ranking policy from
 * retrieval. Nothing here touches product configuration; strategies are computed
 * from the tiers' own output.
 *
 *   node bench/ranking-strategies.mjs [--dataset=<path>] [--vault=<path>]
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphIndex } from "../dist/graph.js";
import { loadConfig } from "../dist/config.js";
import { SemanticIndex, attachSemanticIndex } from "../dist/semantic.js";
import { lexicalSearch, fuzzySearch, semanticSearch } from "../dist/search.js";
import { tokenize } from "../dist/bm25.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Args ─────────────────────────────────────────────────────────────────────

let datasetPath = join(repoRoot, "bench", "datasets", "fixture.golden.json");
let vaultOverride = null;
/** Per-case ranks for two strategies, so a headline delta can be attributed. */
let detail = null;
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z-]+)=(.*)$/s.exec(arg);
  if (!m) continue;
  if (m[1] === "dataset") datasetPath = resolve(process.cwd(), m[2]);
  else if (m[1] === "vault") vaultOverride = m[2];
  else if (m[1] === "detail") detail = m[2].split(",").map((s) => s.trim());
}

const dataset = JSON.parse(await readFile(datasetPath, "utf-8"));
const vault =
  vaultOverride ?? (isAbsolute(dataset.vault) ? dataset.vault : join(repoRoot, dataset.vault));

// ─── Setup ────────────────────────────────────────────────────────────────────

const config = await loadConfig(vault);
const graph = new GraphIndex(vault);
await graph.build();

const semantic = new SemanticIndex(vault, config.semantic);
attachSemanticIndex(graph, semantic);
await semantic.load();
process.stdout.write(`Embedding ${graph.nodeCount} notes... `);
await semantic.refresh(graph);
console.log(semantic.status);
if (semantic.status !== "ready") {
  console.error(`Semantic tier is ${semantic.status}: ${semantic.stats.reason}`);
  process.exit(1);
}

const DEPTH = 30;
const LIMIT = 10;

// ─── Strategies ───────────────────────────────────────────────────────────────

/** Rank fusion: each list votes 1/(k + rank), scaled by the list's weight. */
function rrf(lists, k) {
  const scores = new Map();
  for (const { paths, weight = 1 } of lists) {
    paths.forEach((path, index) => {
      scores.set(path, (scores.get(path) ?? 0) + weight / (k + index + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
}

/**
 * Linear blend of normalised scores — the "standardise onto one scale" option.
 * Each tier's scores are already relative to its own top hit, which is the most
 * generous reading of a method whose weakness is exactly that the scales are
 * not commensurable.
 */
function linearBlend(tiers, weights) {
  const scores = new Map();
  for (const [name, hits] of Object.entries(tiers)) {
    const top = hits[0]?.score || 1;
    for (const hit of hits) {
      const normalised = hit.score / top;
      scores.set(hit.path, (scores.get(hit.path) ?? 0) + (weights[name] ?? 1) * normalised);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
}

const STRATEGIES = {
  "lexical only": ({ lex }) => lex.map((h) => h.path),
  "fuzzy only": ({ fuz }) => fuz.map((h) => h.path),
  "semantic only": ({ sem }) => sem.map((h) => h.path),
  "rrf equal (k=60)": ({ lex, fuz, sem }) =>
    rrf(
      [
        { paths: lex.map((h) => h.path) },
        { paths: fuz.map((h) => h.path) },
        { paths: sem.map((h) => h.path) },
      ],
      60,
    ),
  "rrf coverage (k=60)": ({ lex, fuz, sem, coverage }) =>
    rrf(
      [
        { paths: lex.map((h) => h.path), weight: coverage },
        { paths: fuz.map((h) => h.path) },
        { paths: sem.map((h) => h.path) },
      ],
      60,
    ),
  "rrf coverage (k=10)": ({ lex, fuz, sem, coverage }) =>
    rrf(
      [
        { paths: lex.map((h) => h.path), weight: coverage },
        { paths: fuz.map((h) => h.path) },
        { paths: sem.map((h) => h.path) },
      ],
      10,
    ),
  "rrf coverage (k=200)": ({ lex, fuz, sem, coverage }) =>
    rrf(
      [
        { paths: lex.map((h) => h.path), weight: coverage },
        { paths: fuz.map((h) => h.path) },
        { paths: sem.map((h) => h.path) },
      ],
      200,
    ),
  "score blend equal": ({ lex, fuz, sem }) =>
    linearBlend({ lex, fuz, sem }, { lex: 1, fuz: 1, sem: 1 }),
  "score blend coverage": ({ lex, fuz, sem, coverage }) =>
    linearBlend({ lex, fuz, sem }, { lex: coverage, fuz: 1, sem: 1 }),
};

// ─── Scoring ──────────────────────────────────────────────────────────────────

const LEXICAL_MIN_WEIGHT = 0.3;

const totals = Object.fromEntries(
  Object.keys(STRATEGIES).map((name) => [name, { hit: 0, rr: 0, recall: 0, cases: 0 }]),
);
const perCase = [];

for (const testCase of dataset.cases) {
  const relevant = testCase.relevant ?? [];
  if (relevant.length === 0) continue;

  const lex = lexicalSearch(graph, testCase.query, DEPTH);
  const fuz = fuzzySearch(graph, testCase.query, DEPTH);
  const sem = await semanticSearch(graph, testCase.query, DEPTH);

  const queryTerms = tokenize(testCase.query).length;
  const rawCoverage =
    lex.length > 0 && queryTerms > 0 ? lex[0].matchedTerms.length / queryTerms : 0;
  const coverage = Math.max(LEXICAL_MIN_WEIGHT, Math.min(1, rawCoverage));

  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const ranked = strategy({ lex, fuz, sem, coverage }).slice(0, LIMIT);
    const found = relevant.filter((p) => ranked.includes(p));
    const firstIdx = ranked.findIndex((p) => relevant.includes(p));

    const bucket = totals[name];
    bucket.cases += 1;
    if (found.length > 0) bucket.hit += 1;
    if (firstIdx >= 0) bucket.rr += 1 / (firstIdx + 1);
    bucket.recall += found.length / relevant.length;

    if (detail?.includes(name)) {
      let row = perCase.find((r) => r.id === testCase.id);
      if (!row) {
        row = { id: testCase.id, ranks: {} };
        perCase.push(row);
      }
      row.ranks[name] = firstIdx;
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

const pct = (n) => `${(n * 100).toFixed(0)}%`;

console.log(`\n${"═".repeat(70)}`);
console.log(`Ranking strategies — ${dataset.name ?? datasetPath}`);
console.log(`${totals[Object.keys(STRATEGIES)[0]].cases} cases, top ${LIMIT}`);
console.log("═".repeat(70));
console.log("\n  strategy                 hit rate    MRR    recall");

const rows = Object.entries(totals).map(([name, t]) => ({
  name,
  hit: t.hit / t.cases,
  mrr: t.rr / t.cases,
  recall: t.recall / t.cases,
}));

// Sort by MRR so the best ranking policy is visible at a glance, not by
// declaration order.
for (const row of [...rows].sort((a, b) => b.mrr - a.mrr)) {
  console.log(
    `  ${row.name.padEnd(24)} ${pct(row.hit).padStart(6)}   ${row.mrr.toFixed(3)}    ${pct(row.recall).padStart(5)}`,
  );
}

const shipped = rows.find((r) => r.name === "rrf coverage (k=60)");
const best = [...rows].sort((a, b) => b.mrr - a.mrr)[0];
console.log(
  best.name === shipped.name
    ? `\n  Shipped strategy is the best of those tested.\n`
    : `\n  '${best.name}' beats the shipped 'rrf coverage (k=60)' by ${(best.mrr - shipped.mrr).toFixed(3)} MRR.\n`,
);

if (detail && perCase.length > 0) {
  const [a, b] = detail;
  console.log(`  Per-case rank of the first relevant note (— = outside top ${LIMIT})\n`);
  console.log(`    case                         ${a.padEnd(22)} ${b}`);
  let differing = 0;
  for (const row of perCase) {
    const ra = row.ranks[a];
    const rb = row.ranks[b];
    if (ra === rb) continue;
    differing += 1;
    const f = (n) => (n < 0 ? "—" : String(n)).padStart(4);
    console.log(`    ${row.id.padEnd(28)} ${f(ra).padEnd(22)} ${f(rb)}`);
  }
  console.log(
    differing === 0
      ? "    (identical on every case)\n"
      : `\n    ${differing} of ${perCase.length} cases differ — a headline gap this small is worth\n` +
          "    attributing before tuning a constant on it.\n",
  );
}
