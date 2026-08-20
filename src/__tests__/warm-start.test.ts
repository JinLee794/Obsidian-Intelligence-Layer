/**
 * Warm-start contract — what a *repeat* connect is allowed to cost.
 *
 * The startup contract next door proves the handshake is never gated on vault
 * work. This proves the complementary half: that the work behind the handshake
 * happens once rather than on every connect.
 *
 * Both regressions are silent. A server that re-reads the whole vault on every
 * session still answers every tool call correctly — it just quietly burns the
 * user's disk, and on a synced or network vault it never finishes before the
 * session ends, so it starts over next time and never converges. Nothing in a
 * tool-behaviour test can see that, so it is asserted here in terms of the two
 * things that actually move: how many notes get re-read, and whether the result
 * survives the session that produced it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphIndex } from "../graph.js";
import { createOilServer, type OilServer } from "../server.js";

const INDEX_FILE = "_oil-graph.json";
const NOTE_COUNT = 120;

let vault: string;
let tempDir: string;
const started: OilServer[] = [];

async function seedVault(count = NOTE_COUNT): Promise<void> {
  await mkdir(join(vault, "Notes"), { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      writeFile(
        join(vault, "Notes", `Note ${i}.md`),
        `---\ntags: [tier${i % 3}]\n---\n\n# Note ${i}\n\n[[Note ${(i + 1) % count}]]\n\nBody ${i}.\n`,
        "utf-8",
      ),
    ),
  );
}

/** A fresh index that loads the persisted file, as a new session would. */
async function reopen(): Promise<GraphIndex> {
  const graph = new GraphIndex(vault);
  await graph.loadFromDisk(INDEX_FILE);
  return graph;
}

/** Rewrite every recorded mtime, the way a sync or restore does. */
async function skewPersistedMtimes(byMs = 5_000): Promise<void> {
  const file = join(vault, INDEX_FILE);
  const data = JSON.parse(await readFile(file, "utf-8"));
  for (const node of data.nodes) node.lastModified += byMs;
  await writeFile(file, JSON.stringify(data), "utf-8");
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-warm-"));
  vault = join(tempDir, "vault");
  await seedVault();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((oil) => oil.shutdown().catch(() => undefined)));
  await rm(tempDir, { recursive: true, force: true });
});

describe("warm start — the vault is read once, not once per connect", () => {
  it("re-reads nothing on a second connect when the vault has not changed", async () => {
    const first = new GraphIndex(vault);
    await first.build();
    await first.saveToDisk(INDEX_FILE);

    const second = await reopen();
    const reindexed = await second.buildIncremental(INDEX_FILE);

    expect(reindexed).toBe(0);
    expect(second.nodeCount).toBe(NOTE_COUNT);
  });

  it("re-reads only the notes that actually changed", async () => {
    const first = new GraphIndex(vault);
    await first.build();
    await first.saveToDisk(INDEX_FILE);

    const changed = join(vault, "Notes", "Note 7.md");
    await writeFile(changed, "---\ntags: [edited]\n---\n\n# Note 7\n\nRewritten.\n", "utf-8");

    const second = await reopen();
    expect(await second.buildIncremental(INDEX_FILE)).toBe(1);
    expect(second.getNode("Notes/Note 7.md")?.tags).toContain("edited");
  });

  it("notices a deletion without re-reading the survivors", async () => {
    const first = new GraphIndex(vault);
    await first.build();
    await first.saveToDisk(INDEX_FILE);

    await rm(join(vault, "Notes", "Note 3.md"));

    const second = await reopen();
    expect(await second.buildIncremental(INDEX_FILE)).toBe(1);
    expect(second.nodeCount).toBe(NOTE_COUNT - 1);
  });
});

describe("warm start — a mass mtime change converges in one session", () => {
  /**
   * Sync clients, restores from backup and `git pull` all rewrite mtimes
   * without changing content, which invalidates every entry at once. That is
   * survivable if it costs one re-index; it is not survivable if the result is
   * dropped, because then it recurs on every connect forever.
   */
  it("re-indexes once and the next session finds nothing to do", async () => {
    const first = new GraphIndex(vault);
    await first.build();
    await first.saveToDisk(INDEX_FILE);

    await skewPersistedMtimes();

    const afterSkew = await reopen();
    expect(await afterSkew.buildIncremental(INDEX_FILE)).toBe(NOTE_COUNT);

    const next = await reopen();
    expect(await next.buildIncremental(INDEX_FILE)).toBe(0);
  });
});

describe("warm start — indexing survives the session that did it", () => {
  it("reports itself dirty until persisted, and clean afterwards", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    expect(graph.dirty).toBe(true);

    await graph.saveToDisk(INDEX_FILE);
    expect(graph.dirty).toBe(false);
  });

  it("flushes pending work on shutdown instead of discarding it", async () => {
    // A session that indexed but never saved: exactly the state a client
    // disconnecting mid-rebuild leaves behind.
    const graph = new GraphIndex(vault);
    await graph.build();
    expect(graph.dirty).toBe(true);

    await expect(stat(join(vault, INDEX_FILE))).rejects.toThrow();

    expect(await graph.flush(INDEX_FILE)).toBe(true);
    const persisted = JSON.parse(await readFile(join(vault, INDEX_FILE), "utf-8"));
    expect(persisted.nodes).toHaveLength(NOTE_COUNT);
  });

  it("does not rewrite the index when there is nothing new to persist", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    await graph.saveToDisk(INDEX_FILE);
    const firstWrite = (await stat(join(vault, INDEX_FILE))).mtimeMs;

    expect(await graph.flush(INDEX_FILE)).toBe(false);
    expect((await stat(join(vault, INDEX_FILE))).mtimeMs).toBe(firstWrite);
  });

  it("persists through the server's own shutdown path", async () => {
    const oil = await createOilServer(vault, { watch: false });
    oil.hydration.begin();
    await oil.hydration.whenReady();

    await oil.shutdown();

    const persisted = JSON.parse(await readFile(join(vault, INDEX_FILE), "utf-8"));
    expect(persisted.nodes).toHaveLength(NOTE_COUNT);

    // And the next session finds it already done.
    const next = await reopen();
    expect(await next.buildIncremental(INDEX_FILE)).toBe(0);
  });
});

describe("warm start — parallel reads keep the index deterministic", () => {
  /**
   * Notes are read concurrently but folded in list order. If that ordering were
   * ever dropped, a title collision would resolve to whichever read finished
   * first and the index would differ between identical runs.
   */
  it("produces an identical index across repeated builds", async () => {
    await writeFile(join(vault, "Notes", "Dup A.md"), "# Shared Title\n\nFirst.\n", "utf-8");
    await writeFile(join(vault, "Notes", "Dup B.md"), "# Shared Title\n\nSecond.\n", "utf-8");
    // Resolution of the ambiguous title is observable through the link target.
    await writeFile(join(vault, "Notes", "Linker.md"), "# Linker\n\n[[Shared Title]]\n", "utf-8");

    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const graph = new GraphIndex(vault);
        await graph.build();
        return graph.getForwardLinks("Notes/Linker.md")[0]?.path;
      }),
    );

    expect(runs[0]).toBeDefined();
    expect(new Set(runs).size).toBe(1);
  });

  it("indexes every note despite reading them concurrently", async () => {
    const graph = new GraphIndex(vault);
    await graph.build();
    expect(graph.nodeCount).toBe(NOTE_COUNT);

    // Backlinks depend on every node being present before resolution runs.
    const backlinks = graph.getBacklinks("Notes/Note 5.md");
    expect(backlinks.length).toBeGreaterThan(0);
  });

  it("tolerates a note vanishing mid-walk", async () => {
    const graph = new GraphIndex(vault);
    const doomed = join(vault, "Notes", "Note 11.md");
    const build = graph.build();
    await rm(doomed, { force: true });
    await expect(build).resolves.toBeUndefined();
    expect(graph.nodeCount).toBeGreaterThanOrEqual(NOTE_COUNT - 1);
  });
});

describe("warm start — a touched-but-identical note is still cheap", () => {
  it("re-reads only the touched note, not the vault", async () => {
    const first = new GraphIndex(vault);
    await first.build();
    await first.saveToDisk(INDEX_FILE);

    const target = join(vault, "Notes", "Note 2.md");
    const later = new Date(Date.now() + 10_000);
    await utimes(target, later, later);

    const second = await reopen();
    expect(await second.buildIncremental(INDEX_FILE)).toBe(1);
  });
});
