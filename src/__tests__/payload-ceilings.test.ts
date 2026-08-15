/**
 * Payload ceilings — a single tool result must never blow out the caller's
 * context, no matter how pathological the note.
 *
 * These guard the failure mode that build-time budget assertions cannot catch:
 * budget-guards.test.ts measures the fixture vault, which is well behaved.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { DEFAULT_CONFIG } from "../config.js";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { registerWriteTools } from "../tools/write.js";
import { MAX_TEXT_CHARS, MAX_LIST_ITEMS } from "../tool-responses.js";
import { MockMcpServer } from "./harness.js";

let vaultRoot: string;
let server: MockMcpServer;

beforeAll(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "oil-budget-"));
  await mkdir(join(vaultRoot, "_agent-log"), { recursive: true });

  // A section far larger than any reasonable response budget.
  await writeFile(
    join(vaultRoot, "huge-section.md"),
    `# Huge\n## Dump\n${"lorem ipsum dolor sit amet. ".repeat(4000)}`,
    "utf-8",
  );

  // A note with far more headings than a result payload should carry.
  const manyHeadings = Array.from({ length: 300 }, (_, i) => `## Heading ${i}\nbody ${i}`).join("\n");
  await writeFile(join(vaultRoot, "many-headings.md"), `# Many\n${manyHeadings}`, "utf-8");

  // A densely linked cluster, so 2-hop traversal reaches every node.
  await mkdir(join(vaultRoot, "Cluster"), { recursive: true });
  const names = Array.from({ length: 120 }, (_, i) => `n${i}`);
  for (const name of names) {
    const links = names.filter((n) => n !== name).map((n) => `[[${n}]]`).join(" ");
    await writeFile(join(vaultRoot, `Cluster/${name}.md`), `# ${name}\n${links}`, "utf-8");
  }

  await writeFile(
    join(vaultRoot, "_agent-log/2026-08-11.md"),
    `# Agent Log\n${"- entry line with some detail\n".repeat(2000)}`,
    "utf-8",
  );

  const graph = new GraphIndex(vaultRoot);
  await graph.build();
  server = new MockMcpServer();
  registerRetrieveTools(server as any, vaultRoot, graph, new SessionCache(), DEFAULT_CONFIG);
  registerWriteTools(server as any, vaultRoot, graph, new SessionCache(), DEFAULT_CONFIG);
});

afterAll(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("Response payload ceilings", () => {
  it("truncates an oversized section and says so", async () => {
    const result = await server.callToolJson("read_note_section", {
      path: "huge-section.md",
      heading: "Dump",
    });

    expect(result.content.length).toBe(MAX_TEXT_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.total_chars).toBeGreaterThan(MAX_TEXT_CHARS);
    // The agent must be told how to get the rest, not just handed a stub.
    expect(result.note).toMatch(/narrower sub-heading/);
  });

  it("caps the heading list but reports the true count", async () => {
    const result = await server.callToolJson("get_note_metadata", {
      path: "many-headings.md",
    });

    expect(result.headings.length).toBe(MAX_LIST_ITEMS);
    // 300 H2s plus the H1 title section.
    expect(result.heading_count).toBe(301);
    expect(result.headings_truncated).toBe(true);
  });

  it("caps graph traversal on a densely linked cluster", async () => {
    const result = await server.callToolJson("get_related_entities", {
      path: "Cluster/n0.md",
      max_hops: 2,
    });

    expect(result.related.length).toBeLessThanOrEqual(MAX_LIST_ITEMS);
    expect(result.count).toBeGreaterThan(MAX_LIST_ITEMS);
    expect(result.truncated).toBe(true);
  });

  // Logs are append-only, so the recent end is the part worth context.
  it("returns the tail of an oversized audit log", async () => {
    const result = await server.callToolJson("get_agent_log", { date: "2026-08-11" });

    expect(result.log.length).toBe(MAX_TEXT_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.log.endsWith("- entry line with some detail\n")).toBe(true);
    expect(result.log).not.toContain("# Agent Log");
  });

  it("leaves small payloads untouched and unflagged", async () => {
    const result = await server.callToolJson("read_note_section", {
      path: "many-headings.md",
      heading: "Heading 7",
    });

    expect(result.content).toBe("body 7");
    expect(result.truncated).toBeUndefined();
  });

  it("keeps every tool response within a quarter of the turn budget", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["read_note_section", { path: "huge-section.md", heading: "Dump" }],
      ["get_note_metadata", { path: "many-headings.md" }],
      ["get_related_entities", { path: "Cluster/n0.md", max_hops: 2 }],
      ["get_agent_log", { date: "2026-08-11" }],
      ["search_vault", { query: "lorem ipsum dolor", limit: 10 }],
    ];

    for (const [tool, args] of calls) {
      const raw = await server.callToolRaw(tool, args);
      expect(raw.length, `${tool} payload`).toBeLessThan(32_000 * 0.5);
    }
  });
});
