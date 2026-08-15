/**
 * BM25 ranking — the properties that distinguish it from the fixed-constant
 * scorer it replaced: IDF, term-frequency saturation, and length normalisation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bm25Search, tokenize, invalidateBm25Index } from "../bm25.js";
import { GraphIndex } from "../graph.js";

let vaultRoot: string;
let graph: GraphIndex;

beforeAll(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "oil-bm25-"));
  await mkdir(join(vaultRoot, "Notes"), { recursive: true });

  const notes: Record<string, string> = {
    // "renewal" is common; "quantum" appears in exactly one note.
    "Notes/alpha.md": "# Alpha\nRenewal discussion with the customer.",
    "Notes/beta.md": "# Beta\nRenewal timeline slipped again.",
    "Notes/gamma.md": "# Gamma\nRenewal paperwork filed.",
    "Notes/quantum.md": "# Quantum\nQuantum telemetry rollout.",
    // Same single mention of "telemetry", but padded to many times the length.
    "Notes/short.md": "# Short\nTelemetry pipeline.",
    "Notes/long.md": `# Long\nTelemetry pipeline.\n\n${"unrelated filler prose. ".repeat(400)}`,
    // Repeats one term heavily — TF saturation should stop it dominating.
    "Notes/repetitive.md": `# Repetitive\n${"budget ".repeat(200)}`,
    "Notes/balanced.md": "# Balanced\nBudget freeze affects the migration schedule.",
  };

  for (const [path, body] of Object.entries(notes)) {
    await writeFile(join(vaultRoot, path), body, "utf-8");
  }

  graph = new GraphIndex(vaultRoot);
  await graph.build();
  invalidateBm25Index();
});

afterAll(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("tokenize", () => {
  it("lowercases and drops punctuation", () => {
    expect(tokenize("Contoso's Q3 — Renewal!")).toEqual(["contoso", "q3", "renewal"]);
  });

  it("keeps digits so IDs and dates stay searchable", () => {
    expect(tokenize("TPID 12345 on 2026-08-11")).toContain("12345");
    expect(tokenize("TPID 12345 on 2026-08-11")).toContain("2026");
  });

  it("drops stopwords and single characters", () => {
    expect(tokenize("the a of x renewal")).toEqual(["renewal"]);
  });
});

describe("bm25Search", () => {
  it("ranks a rare term's note above notes holding a common term", () => {
    const rare = bm25Search(graph, "quantum", 10);
    const common = bm25Search(graph, "renewal", 10);
    expect(rare[0].path).toBe("Notes/quantum.md");
    // IDF: one match on a rare term beats one match on a term in three notes.
    expect(rare[0].score).toBeGreaterThan(common[0].score);
  });

  // Without length normalisation the padded note would score the same as the
  // short one despite burying the term in 10 KB of filler.
  it("prefers a short note over a long one for the same single match", () => {
    const hits = bm25Search(graph, "telemetry", 10);
    const short = hits.findIndex((h) => h.path === "Notes/short.md");
    const long = hits.findIndex((h) => h.path === "Notes/long.md");
    expect(short).toBeGreaterThanOrEqual(0);
    expect(long).toBeGreaterThan(short);
  });

  // Term-frequency saturation: 200 repeats must not beat matching both terms.
  it("ranks a note matching every query term above one repeating a single term", () => {
    const hits = bm25Search(graph, "budget migration", 10);
    expect(hits[0].path).toBe("Notes/balanced.md");
  });

  it("reports which query terms matched", () => {
    const [top] = bm25Search(graph, "budget migration", 10);
    expect(top.matchedTerms.sort()).toEqual(["budget", "migration"]);
  });

  it("expands a prefix when the exact term is absent", () => {
    const hits = bm25Search(graph, "telemet", 10);
    expect(hits.some((h) => h.path === "Notes/short.md")).toBe(true);
  });

  it("returns nothing for a query of only stopwords", () => {
    expect(bm25Search(graph, "the and of", 10)).toEqual([]);
  });

  it("returns nothing when no term matches", () => {
    expect(bm25Search(graph, "zzzznomatch", 10)).toEqual([]);
  });

  it("applies the accept filter", () => {
    const hits = bm25Search(graph, "renewal", 10, (path) => path === "Notes/beta.md");
    expect(hits.map((h) => h.path)).toEqual(["Notes/beta.md"]);
  });

  it("respects the limit", () => {
    expect(bm25Search(graph, "renewal", 2)).toHaveLength(2);
  });
});
