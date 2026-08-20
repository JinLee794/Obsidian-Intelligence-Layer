/**
 * Startup contract — the guarantees a client depends on to connect at all.
 *
 * These exist because the failure they cover is invisible to every other test
 * in this repo: tool behaviour was always exercised against an already-built
 * index, so a startup sequence whose cost scales with the vault could regress
 * without a single assertion turning red. What a client actually experiences is
 * time-to-handshake and whether the process survives, and that is what is
 * asserted here.
 *
 * Run against an in-memory transport rather than a spawned process: the
 * contract is about ordering and failure handling, both of which are decided in
 * `createOilServer`. The spawned-process budget lives in
 * `scripts/startup-contract.mjs`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOilServer, type OilServer } from "../server.js";
import { Hydration } from "../hydration.js";
import { VaultWatcher } from "../watcher.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";

/**
 * Budget for the handshake, in milliseconds.
 *
 * Generous on purpose — the point is not to police a few hundred milliseconds
 * but to fail loudly if vault work ever moves back in front of the transport,
 * because that is the change that turns a slow vault into a dead server.
 */
const HANDSHAKE_BUDGET_MS = 1_500;

/** Big enough that indexing it is unmistakably slower than the budget above. */
const NOTE_COUNT = 1_500;

let tempDir: string;
let vaultRoot: string;
const started: OilServer[] = [];

async function connect(
  vaultPath: string,
  options: Parameters<typeof createOilServer>[1] = {},
): Promise<{ client: Client; oil: OilServer; handshakeMs: number }> {
  const begunAt = Date.now();
  const oil = await createOilServer(vaultPath, {
    watch: false,
    // Generous on purpose: this is the harness budget, not the product's. Under
    // a full parallel suite the fixture build competes with 30+ other files, and
    // a gate that expires there tests the runner, not the server.
    hydration: { retryDelaysMs: [50], gateTimeoutMs: 60_000 },
    ...options,
  });
  started.push(oil);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await oil.server.connect(serverTransport);
  const client = new Client({ name: "startup-contract", version: "1.0.0" });
  await client.connect(clientTransport);
  const handshakeMs = Date.now() - begunAt;

  oil.hydration.begin();
  return { client, oil, handshakeMs };
}

async function health(client: Client): Promise<Record<string, any>> {
  const result = (await client.callTool({ name: "get_health", arguments: {} })) as {
    content: { text: string }[];
  };
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-startup-"));
  vaultRoot = join(tempDir, "vault");
  for (let folder = 0; folder < 10; folder++) {
    await mkdir(join(vaultRoot, `Folder${folder}`), { recursive: true });
  }
  await Promise.all(
    Array.from({ length: NOTE_COUNT }, (_, i) =>
      writeFile(
        join(vaultRoot, `Folder${i % 10}`, `Note ${i}.md`),
        `---\ncustomer: Customer${i % 25}\ntags: [tier${i % 4}]\n---\n\n# Note ${i}\n\n` +
          `[[Note ${(i + 1) % NOTE_COUNT}]]\n\n${"Substantive body content. ".repeat(60)}\n`,
        "utf-8",
      ),
    ),
  );
}, 120_000);

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.shutdown().catch(() => undefined);
  }
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("startup contract — handshake", () => {
  it("completes the MCP handshake before the vault is indexed", async () => {
    const { client, oil, handshakeMs } = await connect(vaultRoot);

    expect(handshakeMs).toBeLessThan(HANDSHAKE_BUDGET_MS);
    // The whole point: connected, but the index is demonstrably not built yet.
    expect(oil.hydration.ready).toBe(false);
    expect(oil.graph.getStats().noteCount).toBe(0);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("get_health");
  });

  it("answers get_health while the vault is still warming", async () => {
    const { client, oil } = await connect(vaultRoot);

    const warming = await health(client);
    expect(warming.startup.phase).toBe("warming");
    expect(warming.index.note_count).toBe(0);

    await oil.hydration.whenReady();

    const ready = await health(client);
    expect(ready.startup.phase).toBe("ready");
    expect(ready.startup.duration_ms).toBeGreaterThan(0);
    expect(ready.index.note_count).toBe(NOTE_COUNT);
  }, 120_000);

  it("holds a gated tool call until the index is usable, then serves it", async () => {
    const { client, oil } = await connect(vaultRoot);
    expect(oil.hydration.ready).toBe(false);

    // Issued while warming — it must wait rather than return an empty vault.
    const result = (await client.callTool({
      name: "search_vault",
      arguments: { query: "Customer3", limit: 5 },
    })) as { content: { text: string }[] };

    expect(oil.hydration.ready).toBe(true);
    expect(JSON.parse(result.content[0].text).results.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("startup contract — a vault that is not there", () => {
  it("still connects, and reports the reason instead of exiting", async () => {
    const absent = join(tempDir, "not-mounted-yet");
    const { client, oil, handshakeMs } = await connect(absent);

    expect(handshakeMs).toBeLessThan(HANDSHAKE_BUDGET_MS);
    await expect(oil.hydration.whenReady()).rejects.toThrow(/does not exist/i);

    const snapshot = await health(client);
    expect(snapshot.startup.phase).toBe("failed");
    expect(snapshot.startup.reason).toMatch(/does not exist/i);
  });

  it("names a vault path that is a file rather than a directory", async () => {
    const filePath = join(tempDir, "vault-is-a-file.md");
    await writeFile(filePath, "# not a vault", "utf-8");

    const { oil } = await connect(filePath);
    await expect(oil.hydration.whenReady()).rejects.toThrow(/not a directory/i);
  });

  it("surfaces the failure to gated tools as a diagnosis, not a hang", async () => {
    const { client } = await connect(join(tempDir, "also-absent"));

    // An error result, not a protocol failure and not a silent empty answer:
    // the caller is told what is wrong and that it is being retried.
    const result = (await client.callTool({
      name: "search_vault",
      arguments: { query: "anything" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not exist|unreadable/i);
    expect(result.content[0].text).toMatch(/retrying/i);
  });

  it("recovers on its own once the vault appears", async () => {
    const late = join(tempDir, "late-arrival");
    const { client, oil } = await connect(late);

    await expect(oil.hydration.whenReady()).rejects.toThrow();
    expect(oil.hydration.ready).toBe(false);

    await mkdir(late, { recursive: true });
    await writeFile(join(late, "Arrived.md"), "---\ntags: [x]\n---\n\n# Arrived\n", "utf-8");

    // No reconnect, no restart — the next call drives a fresh attempt.
    await oil.hydration.whenReady();
    const snapshot = await health(client);
    expect(snapshot.startup.phase).toBe("ready");
    expect(snapshot.index.note_count).toBe(1);
  });
});

describe("startup contract — degraded but serving", () => {
  it("rebuilds from a corrupt persisted index instead of failing", async () => {
    const vault = join(tempDir, "corrupt-index");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, "A.md"), "---\ntags: [a]\n---\n\n# A\n", "utf-8");
    await writeFile(join(vault, "_oil-graph.json"), '{"version":2,"nodes":[{"pa', "utf-8");

    const { client, oil } = await connect(vault);
    await oil.hydration.whenReady();

    const snapshot = await health(client);
    expect(snapshot.startup.phase).toBe("ready");
    expect(snapshot.index.note_count).toBe(1);
  });

  it("survives a watcher fault instead of throwing out of the event loop", async () => {
    const vault = join(tempDir, "watch-fault");
    await mkdir(vault, { recursive: true });

    const watcher = new VaultWatcher(vault, new GraphIndex(vault), new SessionCache());
    watcher.start();
    try {
      const inner = (watcher as unknown as { watcher: NodeJS.EventEmitter }).watcher;
      // An EventEmitter with no `error` listener throws on emit, which with no
      // process guard means the server simply disappears mid-session.
      expect(inner.listenerCount("error")).toBeGreaterThan(0);
      expect(() =>
        inner.emit("error", Object.assign(new Error("simulated"), { code: "EMFILE" })),
      ).not.toThrow();
      expect(watcher.getStatus().last_error).toMatch(/simulated/);
    } finally {
      await watcher.stop();
    }
  });

  it("does not let concurrent servers on one vault interfere", async () => {
    const vault = join(tempDir, "concurrent");
    await mkdir(vault, { recursive: true });
    for (let i = 0; i < 40; i++) {
      await writeFile(
        join(vault, `N${i}.md`),
        `---\ntags: [t${i % 3}]\n---\n\n# N${i}\n\nbody\n`,
        "utf-8",
      );
    }

    const instances = await Promise.all([connect(vault), connect(vault), connect(vault)]);
    await Promise.all(instances.map(({ oil }) => oil.hydration.whenReady()));

    for (const { client } of instances) {
      expect((await health(client)).index.note_count).toBe(40);
    }
  });
});

describe("hydration gate", () => {
  it("coalesces concurrent waiters onto a single attempt", async () => {
    let runs = 0;
    const hydration = new Hydration(async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    hydration.begin();
    await Promise.all([hydration.whenReady(), hydration.whenReady(), hydration.whenReady()]);

    expect(runs).toBe(1);
    expect(hydration.snapshot.phase).toBe("ready");
  });

  it("retries in the background after a failure", async () => {
    let attempts = 0;
    const hydration = new Hydration(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("vault not mounted");
      },
      { retryDelaysMs: [5] },
    );

    hydration.begin();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(hydration.snapshot.phase).toBe("ready");
    expect(attempts).toBe(3);
  });

  it("gives a waiting caller a reason rather than blocking forever", async () => {
    const hydration = new Hydration(() => new Promise<void>(() => {}), {
      gateTimeoutMs: 60,
      retryDelaysMs: [10_000],
    });

    hydration.begin();
    await expect(hydration.whenReady()).rejects.toThrow(/still indexing/i);
    hydration.stop();
  });

  it("never turns a failed attempt into an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const hydration = new Hydration(async () => {
        throw new Error("boom");
      }, { retryDelaysMs: [10_000] });

      // No caller ever awaits this — the pre-fix shape crashed the process here.
      hydration.begin();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hydration.snapshot.phase).toBe("failed");
      expect(seen).toHaveLength(0);
      hydration.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
