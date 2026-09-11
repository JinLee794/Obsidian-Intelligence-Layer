#!/usr/bin/env node
/**
 * Measures the shape of backlink resolution for a burst of ordinary body edits.
 *
 * The resolved-note counts are the portable result. Timings include filesystem
 * I/O and machine load, so they are reported only as non-portable context.
 *
 *   node bench/burst-cost.mjs [vaultSizes]
 *   node bench/burst-cost.mjs 379,2000,6000
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphIndex } from "../dist/graph.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sizes = (process.argv[2] ?? "379,2000,6000")
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n >= 200);
const burstSize = 200;

if (sizes.length === 0) {
  console.error("Provide at least one integer vault size of 200 or more.");
  process.exit(1);
}

const fixtureRoot = await mkdtemp(join(root, ".oil-burst-cost-"));
const rows = [];

try {
  for (const vaultSize of sizes) {
    const vault = join(fixtureRoot, `vault-${vaultSize}`);
    await mkdir(vault, { recursive: true });

    await Promise.all(
      Array.from({ length: vaultSize }, (_, i) =>
        writeFile(
          join(vault, `note-${i}.md`),
          `# Note ${i}\n\n[[Note ${(i + 1) % vaultSize}]]\n\nInitial body ${i}.\n`,
          "utf-8",
        ),
      ),
    );

    const graph = new GraphIndex(vault);
    await graph.build();

    let resolvedNotes = 0;
    const resolveLinksForNote = graph.resolveLinksForNote.bind(graph);
    graph.resolveLinksForNote = (notePath) => {
      resolvedNotes++;
      return resolveLinksForNote(notePath);
    };

    const legacyStarted = performance.now();
    for (let i = 0; i < burstSize; i++) graph.resolveLinks();
    const legacyMs = performance.now() - legacyStarted;
    const legacyResolved = resolvedNotes;

    await Promise.all(
      Array.from({ length: burstSize }, (_, i) =>
        writeFile(
          join(vault, `note-${i}.md`),
          `# Note ${i}\n\n[[Note ${(i + 1) % vaultSize}]]\n\nEdited body ${i}.\n`,
          "utf-8",
        ),
      ),
    );

    resolvedNotes = 0;
    const batchedStarted = performance.now();
    await graph.updateNotes(Array.from({ length: burstSize }, (_, i) => `note-${i}.md`));
    const batchedMs = performance.now() - batchedStarted;

    rows.push({
      "vault notes": vaultSize,
      "burst files": burstSize,
      "legacy resolved": legacyResolved,
      "batched resolved": resolvedNotes,
      "legacy ms*": Number(legacyMs.toFixed(1)),
      "batched ms*": Number(batchedMs.toFixed(1)),
    });
  }

  console.log("\nBurst backlink-resolution shape\n");
  console.table(rows);
  console.log("* Wall-clock timings are I/O- and load-dependent; resolved-note counts are portable.");

  const failed = rows.some(
    (row) =>
      row["legacy resolved"] !== row["vault notes"] * row["burst files"] ||
      row["batched resolved"] !== row["burst files"],
  );
  if (failed) process.exitCode = 1;
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
