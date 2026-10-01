/**
 * Tests for gate.ts — write execution, section appending, audit logging.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { executeWrite, appendToSection, logWrite } from "../gate.js";
import type { OilConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;
let config: OilConfig;

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
    await logWrite(vaultRoot, config, { operation: "op1", path: "a.md" });
    await logWrite(vaultRoot, config, { operation: "op2", path: "b.md" });

    const dateStr = new Date().toISOString().slice(0, 10);
    const logPath = join(vaultRoot, `_agent-log/${dateStr}.md`);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("op1 [auto]");
    expect(content).toContain("op2 [auto]");
  });

  it("writes nothing when logAllWrites is disabled", async () => {
    const quietRoot = join(tempDir, "quiet-vault");
    await mkdir(quietRoot, { recursive: true });
    const quietConfig: OilConfig = {
      ...config,
      audit: { logAllWrites: false },
    };

    await logWrite(quietRoot, quietConfig, { operation: "test_op", path: "a.md" });

    const dateStr = new Date().toISOString().slice(0, 10);
    await expect(
      readFile(join(quietRoot, `_agent-log/${dateStr}.md`), "utf-8"),
    ).rejects.toThrow();
  });
});
