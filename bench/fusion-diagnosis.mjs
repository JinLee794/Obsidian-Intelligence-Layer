/**
 * Where does a correct answer get lost — retrieval, or fusion?
 *
 * For each golden case, reports the target note's rank inside each tier and its
 * rank after reciprocal rank fusion. A target that ranks well in a tier but
 * poorly after fusion is a ranking-policy problem, not a retrieval one.
 *
 *   node bench/fusion-diagnosis.mjs [vault] [--dataset=<path>]
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GraphIndex } from "../dist/graph.js";
import { loadConfig } from "../dist/config.js";
import { SemanticIndex, attachSemanticIndex } from "../dist/semantic.js";
import { cascadeSearch, lexicalSearch, fuzzySearch, semanticSearch } from "../dist/search.js";

const args = process.argv.slice(2);
const datasetArg = args.find((a) => a.startsWith("--dataset="))?.slice("--dataset=".length);
const vault = args.find((a) => !a.startsWith("--")) ?? process.env.OBSIDIAN_VAULT_PATH;

const config = await loadConfig(vault);
const datasetPath = datasetArg
  ? resolve(process.cwd(), datasetArg)
  : new URL("./datasets/sandbox.local.json", import.meta.url);
const dataset = JSON.parse(await readFile(datasetPath, "utf-8"));

const graph = new GraphIndex(vault);
await graph.build();

const semantic = new SemanticIndex(vault, config.semantic);
attachSemanticIndex(graph, semantic);
await semantic.load();
await semantic.refresh(graph);
console.log(`semantic: ${semantic.status}\n`);

const DEPTH = 30;

/** Best rank of any relevant path in a list, or -1. */
function bestRank(paths, relevant) {
  let best = -1;
  for (const target of relevant) {
    const idx = paths.indexOf(target);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

const fmt = (n) => (n < 0 ? "—" : String(n)).padStart(5);

console.log("Rank of the best relevant note, per tier and after fusion\n");
console.log("  case                        lexical  fuzzy  semantic   fused(30)  returned(10)");

const cases = dataset.cases.filter((c) => c.scenario === "paraphrase");

for (const testCase of cases) {
  const relevant = testCase.relevant;

  const lex = lexicalSearch(graph, testCase.query, DEPTH).map((h) => h.path);
  const fuz = fuzzySearch(graph, testCase.query, DEPTH).map((h) => h.path);
  const sem = (await semanticSearch(graph, testCase.query, DEPTH)).map((h) => h.path);

  const wide = await cascadeSearch(graph, testCase.query, DEPTH, undefined);
  const narrow = await cascadeSearch(graph, testCase.query, 10, undefined);

  console.log(
    `  ${testCase.id.padEnd(26)} ${fmt(bestRank(lex, relevant))}  ${fmt(bestRank(fuz, relevant))}  ` +
      `${fmt(bestRank(sem, relevant))}     ${fmt(bestRank(wide.results.map((r) => r.path), relevant))}` +
      `      ${fmt(bestRank(narrow.results.map((r) => r.path), relevant))}`,
  );
}

console.log(
  "\n  A target ranked well in `semantic` but poorly in `fused` is lost to ranking\n" +
    "  policy, not retrieval: every tier contributes with equal weight, so a page of\n" +
    "  partial-word lexical matches outvotes a single confident semantic hit.\n",
);
