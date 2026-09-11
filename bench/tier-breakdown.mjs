/**
 * Tier cost breakdown — which tier actually dominates cascade latency at scale.
 *   node bench/tier-breakdown.mjs [noteCount]
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { GraphIndex } from "../dist/graph.js";
import { lexicalSearch, fuzzySearch } from "../dist/search.js";

const NOTE_COUNT = Number(process.argv[2]) || 5000;

const QUERIES = [
  { label: "short (1 token)", text: "Litware" },
  { label: "short (2 tokens)", text: "Litware anomaly" },
  { label: "medium (4 tokens)", text: "unexpected billing increase investigation" },
  { label: "long (7 tokens)", text: "which customer looks like it might churn soon" },
  { label: "long (9 tokens)", text: "how do we wire the corporate datacenter into the cloud" },
];

const root = await mkdtemp(join(tmpdir(), "oil-tier-"));
const vault = join(root, "vault");
await mkdir(join(vault, "Notes"), { recursive: true });

for (let i = 0; i < NOTE_COUNT; i++) {
  await writeFile(
    join(vault, "Notes", `note-${i}.md`),
    `---\ntags: [routine]\n---\n# Working Note ${i}\n\n## Session ${i % 40}\n\n` +
      `Routine notes for iteration ${i} covering planning and follow-up actions.\n`,
    "utf-8",
  );
}

const graph = new GraphIndex(vault);
await graph.build();

function median(fn, runs = 7) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

// Warm both indexes so we measure query cost, not build cost.
lexicalSearch(graph, "warmup", 30);
fuzzySearch(graph, "warmup", 30);

console.log(`\nTier cost at ${NOTE_COUNT} notes (median of 7, warm indexes)\n`);
console.log("  query                    BM25        fuzzy(fuse.js)   ratio");
for (const q of QUERIES) {
  const lex = median(() => lexicalSearch(graph, q.text, 30));
  const fuz = median(() => fuzzySearch(graph, q.text, 30));
  console.log(
    `  ${q.label.padEnd(20)} ${(lex.toFixed(2) + " ms").padStart(9)} ` +
      `${(fuz.toFixed(2) + " ms").padStart(15)} ${(fuz / lex).toFixed(0)}x`,
  );
}
console.log();

await rm(root, { recursive: true, force: true });
