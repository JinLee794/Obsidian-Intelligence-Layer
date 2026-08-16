/**
 * Discoverability of the optional semantic tier.
 *
 * The tier fails quietly by design, which is right for reliability and wrong for
 * discovery: a user inside an MCP client cannot see stderr, so without an
 * in-band signal they never learn meaning-based search exists or why it is off.
 * These pin when that signal appears — and, just as importantly, when it does
 * not, since a notice on every healthy query is noise.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { DEFAULT_CONFIG } from "../config.js";
import { SemanticIndex, attachSemanticIndex, detachSemanticIndex } from "../semantic.js";
import { invalidateSearchIndex } from "../search.js";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { MockMcpServer } from "./harness.js";

let tempDir: string;
let vault: string;
let graph: GraphIndex;
let server: MockMcpServer;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-discover-"));
  vault = join(tempDir, "vault");
  await mkdir(join(vault, "Customers"), { recursive: true });
  await writeFile(
    join(vault, "Customers/Contoso.md"),
    `---\ntags: [customer]\n---\n# Contoso\n\n## Status\n\nMigration underway.\n`,
    "utf-8",
  );

  graph = new GraphIndex(vault);
  await graph.build();
  invalidateSearchIndex();

  server = new MockMcpServer();
  registerRetrieveTools(server as never, vault, graph, new SessionCache(), DEFAULT_CONFIG);
});

afterAll(async () => {
  detachSemanticIndex(graph);
  await rm(tempDir, { recursive: true, force: true });
});

/** A query no lexical tier can cover, so the cascade escalates. */
const ESCALATING = "conceptual question about organisational strategy";

describe("semantic tier discoverability", () => {
  it("says nothing when no semantic index is attached", async () => {
    detachSemanticIndex(graph);
    const result = await server.callToolJson("search_vault", { query: ESCALATING, limit: 5 });
    expect(result.escalated).not.toBeNull();
    expect(result.semantic_status).toBeUndefined();
  });

  it("explains itself when the tier is configured but unreachable", async () => {
    const index = new SemanticIndex(vault, {
      ...DEFAULT_CONFIG.semantic,
      endpoint: "http://127.0.0.1:1",
    });
    attachSemanticIndex(graph, index);
    await index.refresh(graph);

    try {
      const result = await server.callToolJson("search_vault", { query: ESCALATING, limit: 5 });
      expect(result.semantic_status).toBeTruthy();
      // Actionable, not just a status code.
      expect(result.semantic_status).toContain("Ollama");
      expect(result.semantic_status).toContain("doctor");
    } finally {
      detachSemanticIndex(graph);
    }
  });

  it("stays silent when the user turned the tier off", async () => {
    // Someone who opted out does not need to be told about it on every query.
    const index = new SemanticIndex(vault, { ...DEFAULT_CONFIG.semantic, enabled: false });
    attachSemanticIndex(graph, index);

    try {
      const result = await server.callToolJson("search_vault", { query: ESCALATING, limit: 5 });
      expect(result.semantic_status).toBeUndefined();
    } finally {
      detachSemanticIndex(graph);
    }
  });

  it("stays silent on a query the lexical tiers answered", async () => {
    const index = new SemanticIndex(vault, {
      ...DEFAULT_CONFIG.semantic,
      endpoint: "http://127.0.0.1:1",
    });
    attachSemanticIndex(graph, index);
    await index.refresh(graph);

    try {
      const result = await server.callToolJson("search_vault", { query: "Contoso", limit: 1 });
      expect(result.escalated).toBeNull();
      expect(result.semantic_status).toBeUndefined();
    } finally {
      detachSemanticIndex(graph);
    }
  });
});
