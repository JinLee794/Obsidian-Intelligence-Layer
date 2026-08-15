/**
 * Tests for tools/write.ts — OIL v2 atomic write tools.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { registerWriteTools } from "../tools/write.js";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { OilConfig } from "../types.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockMcpServer } from "./harness.js";

let tempDir: string;
let vaultRoot: string;
let config: OilConfig;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-tools-write-v2-"));
  vaultRoot = join(tempDir, "vault");
  config = { ...DEFAULT_CONFIG };

  await mkdir(join(vaultRoot, "Customers/Contoso"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/Contoso/Contoso.md"),
    `---
tags: [customer]
---

# Contoso

## Agent Insights

- Initial insight

## Team

- Alice
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("write v2 — atomic_append", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("appends when expected_mtime matches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    const result = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- New validated insight",
      expected_mtime: stats,
    });

    expect(result.status).toBe("executed");
    expect(result.ref).toBe("Customers/Contoso/Contoso.md#Agent Insights");
    expect(result.version).toBe(result.mtime_ms);

    const content = await readFile(join(vaultRoot, "Customers/Contoso/Contoso.md"), "utf-8");
    expect(content).toContain("New validated insight");
  });

  it("rejects stale append when mtime mismatches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    await writeFile(
      join(vaultRoot, "Customers/Contoso/Contoso.md"),
      `---\ntags: [customer]\n---\n\n# Contoso\n\n## Agent Insights\n\n- Modified by another writer\n`,
      "utf-8",
    );

    const result = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- Should fail",
      expected_mtime: stats,
    });

    expect(result.error).toContain("Stale write rejected");
    expect(result.error_code).toBe("CONFLICT");
    expect(result.agent_guidance.suggested_tools).toContain("get_note_metadata");
  });

  it("serializes concurrent appends on the same path", async () => {
    await writeFile(
      join(vaultRoot, "Customers/Contoso/Contoso.md"),
      `---
tags: [customer]
---

# Contoso

## Agent Insights

- Initial insight

## Team

- Alice
`,
      "utf-8",
    );
    const stats = await readCurrentMtime(vaultRoot, config);

    const [first, second] = await Promise.all([
      server.callToolJson("atomic_append", {
        path: "Customers/Contoso/Contoso.md",
        heading: "Agent Insights",
        content: "- Concurrent A",
        expected_mtime: stats,
      }),
      server.callToolJson("atomic_append", {
        path: "Customers/Contoso/Contoso.md",
        heading: "Agent Insights",
        content: "- Concurrent B",
        expected_mtime: stats,
      }),
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.status === "executed")).toHaveLength(1);
    expect(results.filter((result) => result.error_code === "CONFLICT")).toHaveLength(1);

    const content = await readFile(join(vaultRoot, "Customers/Contoso/Contoso.md"), "utf-8");
    const appendedCount = Number(content.includes("Concurrent A")) + Number(content.includes("Concurrent B"));
    expect(appendedCount).toBe(1);
  });

  it("serializes concurrent create_note calls on the same path", async () => {
    const [first, second] = await Promise.all([
      server.callToolJson("create_note", {
        path: "Daily/2026-03-21.md",
        content: "# 2026-03-21\n\n- First create\n",
      }),
      server.callToolJson("create_note", {
        path: "Daily/2026-03-21.md",
        content: "# 2026-03-21\n\n- Second create\n",
      }),
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.error_code === "CONFLICT")).toHaveLength(1);

    const content = await readFile(join(vaultRoot, "Daily/2026-03-21.md"), "utf-8");
    const createdCount = Number(content.includes("First create")) + Number(content.includes("Second create"));
    expect(createdCount).toBe(1);
  });
});

describe("write v2 — atomic_replace", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("replaces full content when expected_mtime matches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    const result = await server.callToolJson("atomic_replace", {
      path: "Customers/Contoso/Contoso.md",
      content: "# Replaced\n\nFresh content",
      expected_mtime: stats,
    });

    expect(result.status).toBe("executed");
    expect(result.ref).toBe("Customers/Contoso/Contoso.md");
    expect(result.version).toBe(result.mtime_ms);

    const content = await readFile(join(vaultRoot, "Customers/Contoso/Contoso.md"), "utf-8");
    expect(content).toContain("# Replaced");
  });

  it("rejects stale replace when mtime mismatches", async () => {
    const stats = await readCurrentMtime(vaultRoot, config);

    await writeFile(
      join(vaultRoot, "Customers/Contoso/Contoso.md"),
      "# Concurrent update\n",
      "utf-8",
    );

    const result = await server.callToolJson("atomic_replace", {
      path: "Customers/Contoso/Contoso.md",
      content: "# Should not write",
      expected_mtime: stats,
    });

    expect(result.error).toContain("Stale write rejected");
    expect(result.error_code).toBe("CONFLICT");
    expect(result.agent_guidance.suggested_tools).toContain("get_note_metadata");
  });
});

describe("write/read integration", () => {
  it("uses get_note_metadata mtime_ms for a successful atomic update", async () => {
    const server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config);
    registerWriteTools(server as any, vaultRoot, graph, cache, config);

    const meta = await server.callToolJson("get_note_metadata", {
      path: "Customers/Contoso/Contoso.md",
    });

    const result = await server.callToolJson("atomic_append", {
      path: "Customers/Contoso/Contoso.md",
      heading: "Agent Insights",
      content: "- Update with metadata mtime",
      expected_mtime: meta.mtime_ms,
    });

    expect(result.status).toBe("executed");
  });

  // appendToSection and parseSections must agree on where a section ends.
  // They previously did not: appendToSection stopped at the next same-or-higher
  // heading, so a write to a heading that has sub-headings — or to the H1 title,
  // whose siblings are all deeper — landed outside the section the reader
  // reports, and an agent verifying its own write would not find it.
  it("writes where read_note_section will find it, for a heading with sub-headings", async () => {
    const notePath = "Customers/Nested.md";
    await writeFile(
      join(vaultRoot, notePath),
      `# Nested\n\n## Parent\n\nparent body\n\n### Child\n\nchild body\n\n## Other\n\nother body\n`,
      "utf-8",
    );

    const server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config);
    registerWriteTools(server as any, vaultRoot, graph, cache, config);

    const meta = await server.callToolJson("get_note_metadata", { path: notePath });
    const write = await server.callToolJson("atomic_append", {
      path: notePath,
      heading: "Parent",
      content: "- appended to parent",
      expected_mtime: meta.mtime_ms,
    });
    expect(write.status).toBe("executed");

    const parent = await server.callToolJson("read_note_section", {
      path: notePath,
      heading: "Parent",
    });
    expect(parent.content).toContain("appended to parent");

    const child = await server.callToolJson("read_note_section", {
      path: notePath,
      heading: "Child",
    });
    expect(child.content).not.toContain("appended to parent");
  });

  it("writes under an H1 title where read_note_section will find it", async () => {
    const notePath = "Customers/TitleOnly.md";
    await writeFile(
      join(vaultRoot, notePath),
      `# TitleOnly\n\n## Team\n\n- Alice\n`,
      "utf-8",
    );

    const server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerRetrieveTools(server as any, vaultRoot, graph, cache, config);
    registerWriteTools(server as any, vaultRoot, graph, cache, config);

    const meta = await server.callToolJson("get_note_metadata", { path: notePath });
    await server.callToolJson("atomic_append", {
      path: notePath,
      heading: "TitleOnly",
      content: "- under the title",
      expected_mtime: meta.mtime_ms,
    });

    const section = await server.callToolJson("read_note_section", {
      path: notePath,
      heading: "TitleOnly",
    });
    expect(section.content).toContain("under the title");
  });
});

describe("write v2 — create_note", () => {
  let server: MockMcpServer;

  beforeEach(async () => {
    server = new MockMcpServer();
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    registerWriteTools(server as any, vaultRoot, graph, cache, config);
  });

  it("creates a new note when the file does not exist", async () => {
    const result = await server.callToolJson("create_note", {
      path: "Daily/2026-03-19.md",
      content: "# 2026-03-19\n\n## Morning Triage\n\n- First item\n",
    });

    expect(result.status).toBe("created");
    expect(result.path).toBe("Daily/2026-03-19.md");
    expect(result.ref).toBe("Daily/2026-03-19.md");
    expect(result.mtime_ms).toBeGreaterThan(0);
    expect(result.version).toBe(result.mtime_ms);

    const content = await readFile(join(vaultRoot, "Daily/2026-03-19.md"), "utf-8");
    expect(content).toContain("# 2026-03-19");
    expect(content).toContain("First item");
  });

  it("rejects creation when the file already exists", async () => {
    const result = await server.callToolJson("create_note", {
      path: "Customers/Contoso/Contoso.md",
      content: "# Should not overwrite",
    });

    expect(result.error).toContain("already exists");
    expect(result.error_code).toBe("CONFLICT");
    expect(result.agent_guidance.suggested_tools).toContain("atomic_replace");
  });

  it("rejects path traversal attempts", async () => {
    const result = await server.callToolJson("create_note", {
      path: "../../../etc/passwd",
      content: "nope",
    });

    expect(result.error).toBeDefined();
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.agent_guidance.next_step).toContain("vault-relative path");
  });

  it("writes a retrievable audit entry for create_note", async () => {
    const result = await server.callToolJson("create_note", {
      path: "Daily/2026-03-20.md",
      content: "# 2026-03-20\n",
    });

    expect(result.status).toBe("created");

    const date = new Date().toISOString().slice(0, 10);
    const log = await server.callToolJson("get_agent_log", { date });

    expect(log.path).toBe(`_agent-log/${date}.md`);
    expect(log.ref).toBe(`_agent-log/${date}.md`);
    expect(log.log).toContain("create_note");
    expect(log.log).toContain("Daily/2026-03-20.md");
  });
});

async function readCurrentMtime(vaultRoot: string, _config: OilConfig): Promise<number> {
  const server = new MockMcpServer();
  const graph = new GraphIndex(vaultRoot);
  await graph.build();
  const cache = new SessionCache();
  registerRetrieveTools(server as any, vaultRoot, graph, cache, DEFAULT_CONFIG);
  const metadata = await server.callToolJson("get_note_metadata", {
    path: "Customers/Contoso/Contoso.md",
  });
  return metadata.mtime_ms;
}
