/**
 * Tests for gate.ts — write gate engine: diff generation, tier routing,
 * write execution, section appending, audit logging, gated flow.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  generateDiff,
  isAutoConfirmed,
  executeWrite,
  appendToSection,
  logWrite,
  queueGatedWrite,
  confirmWrite,
  rejectWrite,
  generateCompactBatchDiff,
} from "../gate.js";
import { SessionCache } from "../cache.js";
import type { OilConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;
let config: OilConfig;
let cache: SessionCache;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-gate-"));
  vaultRoot = join(tempDir, "vault");
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(join(vaultRoot, "notes"), { recursive: true });
  await mkdir(join(vaultRoot, "_agent-log"), { recursive: true });
  config = { ...DEFAULT_CONFIG };
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  cache = new SessionCache();
});

// ─── generateDiff ─────────────────────────────────────────────────────────────

describe("generateDiff", () => {
  it("returns a diff with unique ID", () => {
    const d1 = generateDiff("write_note", "notes/a.md", "content", true);
    const d2 = generateDiff("write_note", "notes/b.md", "content", true);
    expect(d1.id).toBeTruthy();
    expect(d1.id).not.toBe(d2.id);
  });

  it("marks new notes as 'Create new note'", () => {
    const d = generateDiff("write_note", "notes/new.md", "hello", true);
    expect(d.diff).toContain("Create new note");
    expect(d.operation).toBe("write_note");
    expect(d.path).toBe("notes/new.md");
  });

  it("marks updates as 'Update existing note'", () => {
    const d = generateDiff("patch_note", "notes/old.md", "updated", false);
    expect(d.diff).toContain("Update existing note");
  });

  it("truncates long content with char count", () => {
    const longContent = "x".repeat(2000);
    const d = generateDiff("write_note", "a.md", longContent, true);
    expect(d.diff).toContain("2000 chars total");
    expect(d.diff).not.toContain("x".repeat(2000));
  });

  it("includes side effects when provided", () => {
    const d = generateDiff("write_note", "a.md", "content", true, [
      "Update customer file",
      "Invalidate cache",
    ]);
    expect(d.diff).toContain("Side effects");
    expect(d.diff).toContain("Update customer file");
    expect(d.sideEffects).toHaveLength(2);
  });

  it("omits side effects section when none provided", () => {
    const d = generateDiff("write_note", "a.md", "content", true);
    expect(d.diff).not.toContain("Side effects");
  });
});

// ─── isAutoConfirmed ──────────────────────────────────────────────────────────

describe("isAutoConfirmed", () => {
  it("returns true for operations in autoConfirmedOperations", () => {
    expect(isAutoConfirmed(config, "log_agent_action")).toBe(true);
    expect(isAutoConfirmed(config, "capture_connect_hook")).toBe(true);
  });

  it("returns false for non-auto-confirmed operations", () => {
    expect(isAutoConfirmed(config, "write_note")).toBe(false);
    expect(isAutoConfirmed(config, "draft_meeting_note")).toBe(false);
  });

  it("returns true for patch_note targeting auto-confirmed sections", () => {
    expect(isAutoConfirmed(config, "patch_note", "Agent Insights")).toBe(true);
    expect(isAutoConfirmed(config, "patch_note", "Connect Hooks")).toBe(true);
  });

  it("returns false for patch_note targeting non-auto-confirmed sections", () => {
    expect(isAutoConfirmed(config, "patch_note", "Opportunities")).toBe(false);
    expect(isAutoConfirmed(config, "patch_note", "Team")).toBe(false);
  });

  it("returns false for patch_note without targetSection", () => {
    expect(isAutoConfirmed(config, "patch_note")).toBe(false);
  });
});

// ─── executeWrite ─────────────────────────────────────────────────────────────

describe("executeWrite", () => {
  it("creates a new file", async () => {
    await executeWrite(vaultRoot, "notes/created.md", "# New Note\n", "create");
    const content = await readFile(join(vaultRoot, "notes/created.md"), "utf-8");
    expect(content).toBe("# New Note\n");
  });

  it("overwrites an existing file", async () => {
    await writeFile(join(vaultRoot, "notes/overwrite.md"), "old", "utf-8");
    await executeWrite(vaultRoot, "notes/overwrite.md", "new content", "overwrite");
    const content = await readFile(join(vaultRoot, "notes/overwrite.md"), "utf-8");
    expect(content).toBe("new content");
  });

  it("appends to an existing file", async () => {
    await writeFile(join(vaultRoot, "notes/append.md"), "line1\n", "utf-8");
    await executeWrite(vaultRoot, "notes/append.md", "line2\n", "append");
    const content = await readFile(join(vaultRoot, "notes/append.md"), "utf-8");
    expect(content).toBe("line1\nline2\n");
  });

  it("creates parent directories if needed", async () => {
    await executeWrite(vaultRoot, "deep/nested/dir/note.md", "deep", "create");
    const content = await readFile(join(vaultRoot, "deep/nested/dir/note.md"), "utf-8");
    expect(content).toBe("deep");
  });

  it("rejects path traversal", async () => {
    await expect(
      executeWrite(vaultRoot, "../escape.md", "evil", "create"),
    ).rejects.toThrow("Path traversal denied");
  });
});

// ─── appendToSection ──────────────────────────────────────────────────────────

describe("appendToSection", () => {
  it("appends content under an existing heading", async () => {
    const notePath = "notes/section-test.md";
    const fullPath = join(vaultRoot, notePath);
    await writeFile(
      fullPath,
      "# Note\n\n## Agent Insights\n\n- old insight\n\n## Team\n\n- Alice\n",
      "utf-8",
    );

    await appendToSection(vaultRoot, notePath, "Agent Insights", "- new insight");

    const result = await readFile(fullPath, "utf-8");
    expect(result).toContain("- old insight");
    expect(result).toContain("- new insight");
    // New insight should be between Agent Insights heading and Team heading
    const agentIdx = result.indexOf("## Agent Insights");
    const teamIdx = result.indexOf("## Team");
    const newIdx = result.indexOf("- new insight");
    expect(newIdx).toBeGreaterThan(agentIdx);
    expect(newIdx).toBeLessThan(teamIdx);
  });

  it("creates heading at end of file if not found", async () => {
    const notePath = "notes/no-heading.md";
    const fullPath = join(vaultRoot, notePath);
    await writeFile(fullPath, "# Note\n\nSome content\n", "utf-8");

    await appendToSection(vaultRoot, notePath, "New Section", "- item");

    const result = await readFile(fullPath, "utf-8");
    expect(result).toContain("## New Section");
    expect(result).toContain("- item");
  });

  it("prepends content when operation is prepend", async () => {
    const notePath = "notes/prepend-test.md";
    const fullPath = join(vaultRoot, notePath);
    await writeFile(
      fullPath,
      "# Note\n\n## Insights\n\n- existing\n",
      "utf-8",
    );

    await appendToSection(vaultRoot, notePath, "Insights", "- first", "prepend");

    const result = await readFile(fullPath, "utf-8");
    const firstIdx = result.indexOf("- first");
    const existingIdx = result.indexOf("- existing");
    expect(firstIdx).toBeLessThan(existingIdx);
  });
});

// ─── logWrite ─────────────────────────────────────────────────────────────────

describe("logWrite", () => {
  it("creates a new log file with header when none exists", async () => {
    await logWrite(vaultRoot, config, {
      tier: "auto",
      operation: "test_op",
      path: "notes/test.md",
      detail: "test detail",
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    const logPath = join(vaultRoot, `_agent-log/${dateStr}.md`);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("# Agent Log");
    expect(content).toContain("test_op [auto]");
    expect(content).toContain("notes/test.md");
    expect(content).toContain("test detail");
  });

  it("appends to existing log file", async () => {
    await logWrite(vaultRoot, config, {
      tier: "gated",
      operation: "op1",
      path: "a.md",
    });
    await logWrite(vaultRoot, config, {
      tier: "auto",
      operation: "op2",
      path: "b.md",
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    const logPath = join(vaultRoot, `_agent-log/${dateStr}.md`);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("op1 [gated]");
    expect(content).toContain("op2 [auto]");
  });
});

// ─── Gated write flow ─────────────────────────────────────────────────────────

describe("queueGatedWrite + confirmWrite + rejectWrite", () => {
  it("queues a write and retrieves it from cache", () => {
    const diff = generateDiff("write_note", "notes/gated.md", "content", true);
    const writeId = queueGatedWrite(cache, diff, {
      content: "content",
      mode: "create",
    });
    expect(writeId).toBe(diff.id);
    expect(cache.getPendingWrite(writeId)).toBeDefined();
  });

  it("confirms a pending write and executes it", async () => {
    const diff = generateDiff("write_note", "notes/confirm-test.md", "confirmed content", true);
    queueGatedWrite(cache, diff, {
      content: "confirmed content",
      mode: "create",
    });

    const result = await confirmWrite(vaultRoot, config, cache, diff.id);
    expect(result.success).toBe(true);
    expect(result.path).toBe("notes/confirm-test.md");

    // File should exist
    const content = await readFile(join(vaultRoot, "notes/confirm-test.md"), "utf-8");
    expect(content).toBe("confirmed content");

    // Pending write should be removed
    expect(cache.getPendingWrite(diff.id)).toBeUndefined();
  });

  it("returns error for nonexistent write ID on confirm", async () => {
    const result = await confirmWrite(vaultRoot, config, cache, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No pending write");
  });

  it("rejects a pending write without executing", () => {
    const diff = generateDiff("write_note", "notes/reject.md", "content", true);
    queueGatedWrite(cache, diff, { content: "content", mode: "create" });

    const result = rejectWrite(cache, diff.id);
    expect(result.success).toBe(true);
    expect(cache.getPendingWrite(diff.id)).toBeUndefined();
  });

  it("returns error for nonexistent write ID on reject", () => {
    const result = rejectWrite(cache, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No pending write");
  });
});

// ─── generateCompactBatchDiff ─────────────────────────────────────────────────

describe("generateCompactBatchDiff", () => {
  it("lists all items when count ≤ 5", () => {
    const items = [
      { path: "a.md", detail: "add tag" },
      { path: "b.md", detail: "add tag" },
    ];
    const diff = generateCompactBatchDiff("apply_tags", "Add #customer tag", items);
    expect(diff.diff).toContain("a.md");
    expect(diff.diff).toContain("b.md");
    expect(diff.diff).toContain("Notes affected:** 2");
    expect(diff.diff).not.toContain("more");
  });

  it("shows folder summary + first 5 when count > 5", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      path: `Customers/Contoso/note-${i}.md`,
      detail: "tagged",
    }));
    const diff = generateCompactBatchDiff("apply_tags", "Bulk tag", items);
    expect(diff.diff).toContain("Notes affected:** 8");
    expect(diff.diff).toContain("By folder:");
    expect(diff.diff).toContain("Customers/Contoso/");
    expect(diff.diff).toContain("First 5 notes:");
    expect(diff.diff).toContain("and 3 more");
  });

  it("groups items by folder in compact mode", () => {
    const items = [
      { path: "Customers/A/note.md", detail: "d" },
      { path: "Customers/A/note2.md", detail: "d" },
      { path: "Customers/B/note.md", detail: "d" },
      { path: "Customers/B/note2.md", detail: "d" },
      { path: "Customers/B/note3.md", detail: "d" },
      { path: "root.md", detail: "d" },
    ];
    const diff = generateCompactBatchDiff("apply_tags", "Bulk", items);
    expect(diff.diff).toContain("Customers/A/");
    expect(diff.diff).toContain("Customers/B/");
    expect(diff.diff).toContain("(root)");
  });
});
