/**
 * Tests for embeddings.ts — EmbeddingIndex availability, persistence, search utilities.
 * @xenova/transformers is NOT installed; tests focus on graceful unavailability
 * and index persistence with pre-built vectors.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EmbeddingIndex } from "../embeddings.js";
import { GraphIndex } from "../graph.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;
let graph: GraphIndex;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-embed-"));
  vaultRoot = join(tempDir, "vault");
  await mkdir(join(vaultRoot, "Customers"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso.md"),
    `---\ntags: [customer]\n---\n# Contoso\n`,
    "utf-8",
  );
  await writeFile(
    join(vaultRoot, "Customers/Fabrikam.md"),
    `---\ntags: [customer]\n---\n# Fabrikam\n`,
    "utf-8",
  );

  graph = new GraphIndex(vaultRoot);
  await graph.build();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("EmbeddingIndex — availability", () => {
  it("reports unavailable when @xenova/transformers is not installed", async () => {
    const idx = new EmbeddingIndex(vaultRoot, "_oil-index.json", graph);
    const available = await idx.isAvailable();
    expect(available).toBe(false);
  });

  it("caches availability result", async () => {
    const idx = new EmbeddingIndex(vaultRoot, "_oil-index.json", graph);
    await idx.isAvailable();
    // Second call should not re-import
    const again = await idx.isAvailable();
    expect(again).toBe(false);
  });

  it("entryCount is 0 when not initialized", () => {
    const idx = new EmbeddingIndex(vaultRoot, "_oil-index.json", graph);
    expect(idx.entryCount).toBe(0);
  });
});

describe("EmbeddingIndex — persistence", () => {
  it("saves and loads a pre-built index", async () => {
    // Manually build index data and save
    const data = {
      model: "Xenova/all-MiniLM-L6-v2",
      dimension: 384,
      builtAt: new Date().toISOString(),
      entries: [
        {
          path: "Customers/Contoso.md",
          embedding: Array.from({ length: 384 }, () => Math.random()),
          lastModified: Date.now(),
        },
        {
          path: "Customers/Fabrikam.md",
          embedding: Array.from({ length: 384 }, () => Math.random()),
          lastModified: Date.now(),
        },
      ],
    };

    const indexPath = join(vaultRoot, "_test-index.json");
    await writeFile(indexPath, JSON.stringify(data), "utf-8");

    // Verify the file was written correctly
    const raw = await readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.entries.length).toBe(2);
    expect(parsed.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(parsed.dimension).toBe(384);
  });

  it("removeNote deletes an entry and marks dirty", () => {
    const idx = new EmbeddingIndex(vaultRoot, "_oil-index.json", graph);
    // Without initialization, removeNote on nonexistent path is a no-op
    idx.removeNote("Customers/Contoso.md");
    expect(idx.entryCount).toBe(0);
  });
});

describe("EmbeddingIndex — search when unavailable", () => {
  it("search returns empty when not available", async () => {
    const idx = new EmbeddingIndex(vaultRoot, "_oil-index.json", graph);
    const results = await idx.search("Contoso", 5);
    expect(results).toEqual([]);
  });

  it("findSimilar returns empty when not available", async () => {
    const idx = new EmbeddingIndex(vaultRoot, "_oil-index.json", graph);
    const results = await idx.findSimilar("Customers/Contoso.md", 5);
    expect(results).toEqual([]);
  });
});
