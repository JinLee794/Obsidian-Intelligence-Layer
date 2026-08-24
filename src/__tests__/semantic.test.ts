/**
 * Semantic tier — Ollama-backed embeddings.
 *
 * A loopback HTTP stub stands in for Ollama so these tests assert the tier's
 * own contract (change detection, persistence, degradation, fusion) without
 * requiring a model on the machine running them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { DEFAULT_CONFIG } from "../config.js";
import {
  SemanticIndex,
  attachSemanticIndex,
  detachSemanticIndex,
  semanticRemedy,
} from "../semantic.js";
import { cascadeSearch, invalidateSearchIndex } from "../search.js";
import type { SemanticConfig } from "../types.js";

// ─── Fake Ollama ──────────────────────────────────────────────────────────────

const DIMENSIONS = 8;

/**
 * Deterministic pseudo-embedding: a bag-of-characters projection. Not a real
 * language model, but it is stable and gives texts sharing vocabulary a higher
 * cosine than texts that don't — enough to exercise ranking.
 */
function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const char of text.toLowerCase()) {
    const code = char.charCodeAt(0);
    if (code < 97 || code > 122) continue;
    vector[(code - 97) % DIMENSIONS] += 1;
  }
  return vector;
}

interface Stub {
  server: Server;
  endpoint: string;
  /** Requests seen, so tests can assert re-embedding actually was skipped. */
  embedCalls: string[][];
  failNext: boolean;
}

async function startStub(): Promise<Stub> {
  const stub: Partial<Stub> = { embedCalls: [], failNext: false };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (stub.failNext) {
        res.writeHead(500).end("stub failure");
        return;
      }
      // Reachability probes hit the tag listing; only /api/embed is an embed.
      if (req.url?.startsWith("/api/tags")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "stub-model" }] }));
        return;
      }
      const parsed = JSON.parse(body || "{}") as { input?: string[] };
      const inputs = parsed.input ?? [];
      stub.embedCalls!.push(inputs);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: inputs.map(fakeEmbedding) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");

  stub.server = server;
  stub.endpoint = `http://127.0.0.1:${address.port}`;
  return stub as Stub;
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

let tempDir: string;
let vaultRoot: string;
let graph: GraphIndex;
let stub: Stub;

function makeConfig(overrides: Partial<SemanticConfig> = {}): SemanticConfig {
  return { ...DEFAULT_CONFIG.semantic, endpoint: stub.endpoint, ...overrides };
}

beforeAll(async () => {
  stub = await startStub();
  tempDir = await mkdtemp(join(tmpdir(), "oil-semantic-"));
  vaultRoot = join(tempDir, "vault");
  await mkdir(join(vaultRoot, "Customers"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso.md"),
    `---\ntags: [customer]\n---\n# Contoso\n\nCloud migration engagement.\n`,
    "utf-8",
  );
  await writeFile(
    join(vaultRoot, "Customers/Northwind.md"),
    `---\ntags: [customer]\n---\n# Northwind\n\nRenewal at risk.\n`,
    "utf-8",
  );

  graph = new GraphIndex(vaultRoot);
  await graph.build();
  invalidateSearchIndex();
});

afterAll(async () => {
  detachSemanticIndex(graph);
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  stub.embedCalls.length = 0;
  stub.failNext = false;
});

// ─── Indexing ─────────────────────────────────────────────────────────────────

describe("SemanticIndex — indexing", () => {
  it("embeds every note on first refresh and reports ready", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    await index.refresh(graph);

    expect(index.status).toBe("ready");
    expect(index.stats.note_count).toBe(2);
    expect(index.stats.dimensions).toBe(DIMENSIONS);
    expect(stub.embedCalls.flat()).toHaveLength(2);
  });

  it("skips notes whose text has not changed", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    await index.refresh(graph);
    stub.embedCalls.length = 0;

    await index.refresh(graph);
    expect(stub.embedCalls).toHaveLength(0);
    expect(index.stats.note_count).toBe(2);
  });

  it("persists vectors so a restart costs no embedding calls", async () => {
    const first = new SemanticIndex(vaultRoot, makeConfig());
    await first.refresh(graph);
    stub.embedCalls.length = 0;

    const second = new SemanticIndex(vaultRoot, makeConfig());
    await second.load();
    await second.refresh(graph);

    expect(stub.embedCalls).toHaveLength(0);
    expect(second.stats.note_count).toBe(2);
  });

  it("discards the sidecar when the model changes", async () => {
    const first = new SemanticIndex(vaultRoot, makeConfig({ model: "model-a" }));
    await first.refresh(graph);

    const second = new SemanticIndex(vaultRoot, makeConfig({ model: "model-b" }));
    await second.load();
    expect(second.stats.note_count).toBe(0);
  });

  it("writes the sidecar to the configured vault-relative path", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    await index.refresh(graph);

    const raw = await readFile(join(vaultRoot, DEFAULT_CONFIG.semantic.indexFile), "utf-8");
    const parsed = JSON.parse(raw) as { entries: Record<string, unknown> };
    expect(Object.keys(parsed.entries).sort()).toEqual([
      "Customers/Contoso.md",
      "Customers/Northwind.md",
    ]);
  });

  it("does nothing at all when disabled", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ enabled: false }));
    await index.refresh(graph);

    expect(index.status).toBe("disabled");
    expect(stub.embedCalls).toHaveLength(0);
    expect(await index.search("migration", 5)).toEqual([]);
  });
});

// ─── Degradation ──────────────────────────────────────────────────────────────

describe("SemanticIndex — degradation", () => {
  it("marks itself unavailable instead of throwing when Ollama fails", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    stub.failNext = true;

    await expect(index.refresh(graph)).resolves.toBeUndefined();
    expect(index.status).toBe("unavailable");
    expect(index.stats.reason).toContain("500");
  });

  it("returns no hits rather than failing a search when the endpoint is down", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    await index.refresh(graph);

    stub.failNext = true;
    expect(await index.search("anything at all", 5)).toEqual([]);
  });

  it("leaves the cascade working when the tier is unreachable", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ endpoint: "http://127.0.0.1:1" }));
    attachSemanticIndex(graph, index);
    try {
      const { results, tiersUsed } = await cascadeSearch(graph, "Cntoso", 5, undefined);
      expect(tiersUsed).not.toContain("semantic");
      expect(results.length).toBeGreaterThan(0);
    } finally {
      detachSemanticIndex(graph);
    }
  });

  it("surfaces the reason Ollama gave, not just the status code", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    stub.failNext = true;
    await index.refresh(graph);

    expect(index.stats.reason).toContain("stub failure");
  });

  it("recovers on a later refresh after a transient failure", async () => {
    // Ollama can fail a batch while a model loads or memory is tight. Recovery
    // has to be automatic, since nothing prompts a user to retry an index.
    const index = new SemanticIndex(vaultRoot, makeConfig());
    stub.failNext = true;
    await index.refresh(graph);
    expect(index.status).toBe("unavailable");

    stub.failNext = false;
    await index.refresh(graph);

    expect(index.status).toBe("ready");
    expect(index.stats.reason).toBeNull();
    expect(index.stats.note_count).toBe(2);
  });

  // A reason without a remedy makes an agent report "the tier is down" and
  // stop. The fix has to travel with the diagnosis, because `doctor` — which
  // has always carried remedies — is a CLI a client never runs.
  it("carries a remedy alongside the reason when the tier is not serving", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ endpoint: "http://127.0.0.1:1" }));
    await index.refresh(graph);

    expect(index.status).toBe("unavailable");
    expect(index.stats.remedy).toContain("ollama.com");
    expect(index.stats.remedy).toContain("http://127.0.0.1:1");
    expect(index.stats.remedy).toContain("keyword tiers");
  });

  it("offers no remedy while the tier is healthy", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    await index.refresh(graph);

    expect(index.status).toBe("ready");
    expect(index.stats.remedy).toBeNull();
  });
  it("retries automatically via ensureFresh after a failure", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig());
    stub.failNext = true;
    await index.refresh(graph);
    expect(index.status).toBe("unavailable");

    // A failed pass must not record the graph version, or the tier would
    // consider itself current and never try again.
    stub.failNext = false;
    index.ensureFresh(graph);
    await index.refresh(graph);

    expect(index.status).toBe("ready");
  });

  it("does not report ready from a cached index alone", async () => {
    // Every query still has to be embedded, so a complete sidecar with no
    // reachable Ollama is not a working tier.
    const first = new SemanticIndex(vaultRoot, makeConfig());
    await first.refresh(graph);
    expect(first.status).toBe("ready");

    const offline = new SemanticIndex(
      vaultRoot,
      makeConfig({ endpoint: "http://127.0.0.1:1" }),
    );
    await offline.load();
    expect(offline.stats.note_count).toBe(2);

    await offline.refresh(graph);
    expect(offline.status).toBe("unavailable");
    expect(offline.stats.reason).toBeTruthy();
  });

  it("re-checks the endpoint after a query fails, rather than trusting an earlier success", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: -1 }));
    await index.refresh(graph);
    expect(index.status).toBe("ready");

    // Ollama goes away after the index was already built and verified.
    stub.failNext = true;
    expect(await index.search("anything", 5)).toEqual([]);
    expect(index.status).toBe("unavailable");

    // Nothing needs embedding, so this refresh takes the cached-index path. It
    // must still probe rather than assume the earlier success still holds.
    stub.failNext = true;
    await index.refresh(graph);
    expect(index.status).toBe("unavailable");

    stub.failNext = false;
    await index.refresh(graph);
    expect(index.status).toBe("ready");
  });
});

// ─── Query ────────────────────────────────────────────────────────────────────

describe("SemanticIndex — query", () => {
  it("caches the query vector across repeated searches", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: -1 }));
    await index.refresh(graph);
    stub.embedCalls.length = 0;

    await index.search("migration", 5);
    await index.search("migration", 5);
    expect(stub.embedCalls).toHaveLength(1);
  });

  it("honours the minimum-score floor", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: 1.1 }));
    await index.refresh(graph);
    expect(await index.search("migration", 5)).toEqual([]);
  });

  it("applies the accept filter", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: -1 }));
    await index.refresh(graph);

    const hits = await index.search("migration", 5, (path) => path.includes("Northwind"));
    expect(hits.every((hit) => hit.path.includes("Northwind"))).toBe(true);
  });

  it("returns hits ordered by descending similarity", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: -1 }));
    await index.refresh(graph);

    const hits = await index.search("cloud migration engagement", 5);
    expect(hits.length).toBeGreaterThan(1);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });
});

// ─── Cascade integration ──────────────────────────────────────────────────────

describe("cascadeSearch — semantic tier", () => {
  it("reports the semantic tier once it contributes results", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: -1 }));
    await index.refresh(graph);
    attachSemanticIndex(graph, index);

    try {
      const { tiersUsed, results } = await cascadeSearch(graph, "Cntoso", 5, undefined);
      expect(tiersUsed).toContain("semantic");
      expect(results.some((r) => r.matchedBy.includes("semantic"))).toBe(true);
    } finally {
      detachSemanticIndex(graph);
    }
  });

  it("never pays for an embedding call when lexical covers the query", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: -1 }));
    await index.refresh(graph);
    attachSemanticIndex(graph, index);
    stub.embedCalls.length = 0;

    try {
      // The default limit, not limit=1. A specific query rarely fills a page of
      // ten, and gating the tier on result count rather than term coverage made
      // it embed on nearly every query.
      const { tiersUsed } = await cascadeSearch(graph, "Contoso", 10, undefined);
      expect(tiersUsed).not.toContain("semantic");
      expect(stub.embedCalls).toHaveLength(0);
    } finally {
      detachSemanticIndex(graph);
    }
  });

  it("does not embed when a partial-coverage query is still fully matched", async () => {
    const index = new SemanticIndex(vaultRoot, makeConfig({ minScore: -1 }));
    await index.refresh(graph);
    attachSemanticIndex(graph, index);
    stub.embedCalls.length = 0;

    try {
      await cascadeSearch(graph, "customer", 10, undefined);
      expect(stub.embedCalls).toHaveLength(0);
    } finally {
      detachSemanticIndex(graph);
    }
  });
});

describe("semanticRemedy", () => {
  const model = "nomic-embed-text";
  const endpoint = "http://127.0.0.1:11434";

  it("tells a disabled tier how to turn itself on", () => {
    const remedy = semanticRemedy("disabled", "Disabled in oil.config.yaml", model, endpoint);
    expect(remedy).toContain("OIL_SEMANTIC=on");
    expect(remedy).toContain("oil.config.yaml");
  });

  it("points a connection failure at installing and running Ollama", () => {
    const remedy = semanticRemedy("unavailable", "fetch failed (ECONNREFUSED)", model, endpoint);
    expect(remedy).toContain("https://ollama.com");
    expect(remedy).toContain(endpoint);
  });

  it("points a reachable-but-failing Ollama at the model instead", () => {
    // Ollama named itself in the error, so it answered — telling the user to
    // install it would send them to fix something that is already working.
    const remedy = semanticRemedy(
      "unavailable",
      "Ollama /api/embed returned HTTP 500",
      model,
      endpoint,
    );
    expect(remedy).toContain(`ollama pull ${model}`);
    expect(remedy).not.toContain("https://ollama.com");
  });

  it("stays silent for states that resolve themselves", () => {
    for (const status of ["cold", "indexing", "ready"] as const) {
      expect(semanticRemedy(status, null, model, endpoint)).toBeNull();
    }
  });

  it("never instructs anyone to install software automatically", () => {
    // The remedy is read by an agent that can run shell commands. It must read
    // as guidance for the user, not as a command for the agent to execute.
    const remedies = [
      semanticRemedy("disabled", null, model, endpoint),
      semanticRemedy("unavailable", "fetch failed (ECONNREFUSED)", model, endpoint),
    ];
    for (const remedy of remedies) {
      expect(remedy).not.toMatch(/winget|brew install|apt-get|curl .*\| ?sh/i);
    }
  });
});
