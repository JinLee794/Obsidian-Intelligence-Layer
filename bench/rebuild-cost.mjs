/**
 * Rebuild cost after a single-note edit — where does the post-edit stall go?
 *   node bench/rebuild-cost.mjs [noteCount]
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { GraphIndex } from "../dist/graph.js";
import { lexicalSearch, fuzzySearch, invalidateSearchIndex } from "../dist/search.js";

const NOTE_COUNT = Number(process.argv[2]) || 10000;

const root = await mkdtemp(join(tmpdir(), "oil-rebuild-"));
const vault = join(root, "vault");
await mkdir(join(vault, "Notes"), { recursive: true });

for (let i = 0; i < NOTE_COUNT; i++) {
  await writeFile(
    join(vault, "Notes", `note-${i}.md`),
    `---\ntags: [routine, team-${i % 20}]\nstatus: active\n---\n# Working Note ${i}\n\n` +
      `## Session ${i % 40}\n\nRoutine notes for iteration ${i} covering planning, ` +
      `follow-up actions, and review of the ${i % 12} milestone.\n`,
    "utf-8",
  );
}

const graph = new GraphIndex(vault);
await graph.build();

function timeSync(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const ms = (n) => `${n.toFixed(1)} ms`;

// Cold build of each derived index, measured separately.
invalidateSearchIndex();
const bm25Cold = timeSync(() => lexicalSearch(graph, "milestone", 10));
const fuseCold = timeSync(() => fuzzySearch(graph, "milestone", 10));

// Warm queries for reference.
const bm25Warm = timeSync(() => lexicalSearch(graph, "planning", 10));
const fuseWarm = timeSync(() => fuzzySearch(graph, "planning", 10));

// A single-note edit, then the next query of each kind.
await writeFile(
  join(vault, "Notes", "note-7.md"),
  `---\ntags: [routine]\n---\n# Working Note 7\n\n## Session 7\n\nEdited body text.\n`,
  "utf-8",
);
const updateMs = await (async () => {
  const t0 = performance.now();
  await graph.updateNote("Notes/note-7.md");
  return performance.now() - t0;
})();

const bm25AfterEdit = timeSync(() => lexicalSearch(graph, "milestone", 10));
const fuseAfterEdit = timeSync(() => fuzzySearch(graph, "milestone", 10));

console.log(`\nRebuild cost at ${NOTE_COUNT} notes\n`);
console.log(`  graph.updateNote (1 note)      ${ms(updateMs)}`);
console.log();
console.log(`  BM25  cold build               ${ms(bm25Cold)}`);
console.log(`  BM25  warm query               ${ms(bm25Warm)}`);
console.log(`  BM25  first query after edit   ${ms(bm25AfterEdit)}`);
console.log(`  BM25  index update overhead    ${ms(Math.max(0, bm25AfterEdit - bm25Warm))}`);
console.log();
console.log(`  fuse  cold build               ${ms(fuseCold)}`);
console.log(`  fuse  warm query               ${ms(fuseWarm)}`);
console.log(`  fuse  first query after edit   ${ms(fuseAfterEdit)}`);
console.log(`  fuse  index update overhead    ${ms(Math.max(0, fuseAfterEdit - fuseWarm))}`);
console.log();
console.log(
  `  index update overhead total    ${ms(
    Math.max(0, bm25AfterEdit - bm25Warm) + Math.max(0, fuseAfterEdit - fuseWarm),
  )}`,
);
console.log();

await rm(root, { recursive: true, force: true });
