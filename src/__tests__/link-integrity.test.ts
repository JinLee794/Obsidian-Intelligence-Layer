/**
 * Link integrity — end-to-end proof that OIL neither mis-reports valid links as
 * broken nor silently accepts unresolvable ones.
 *
 * Regression context: frontmatter `aliases` were never indexed, so in a real
 * 273-note vault every `[[BlueKC]]` and `[[Jin Lee (HLS US SE)]]` link resolved
 * to nothing — 43 phantom broken links, and the backlinks they should have
 * produced were invisible to traversal. Nothing detected it, because
 * `check_vault_health` did not check link integrity at all.
 *
 * These tests cover both halves: resolution (read path) and the write tools
 * that agents use to author links (write path).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { setupHarness, type TestHarness } from "./harness.js";

let tempDir: string;
let vaultRoot: string;
let harness: TestHarness;

/** Mirrors the real vault: customer + profile notes reachable only by alias. */
const CUSTOMER_NOTE = `---
type: Customer
tags: [customer]
tpid: "803897"
aliases:
  - "BlueKC"
  - "BCBS OF KANSAS CITY"
---

# BCBS OF KANSAS CITY

## Team

- Someone (CSA)

## Agent Insights

- 2026-08-20 Seeded insight
`;

const PROFILE_NOTE = `---
type: Reference
aliases:
  - "Jin Lee (HLS US SE)"
  - "Jin Lee"
---

# My Profile
`;

async function healthReport(h: TestHarness) {
  return h.server.callToolJson("check_vault_health", {});
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-links-"));
  vaultRoot = join(tempDir, "vault");

  await mkdir(join(vaultRoot, "Customers/BCBS OF KANSAS CITY/opportunities"), {
    recursive: true,
  });
  await mkdir(join(vaultRoot, "Customers/BCBS OF KANSAS CITY/milestones"), {
    recursive: true,
  });
  await mkdir(join(vaultRoot, "Reference"), { recursive: true });
  await mkdir(join(vaultRoot, "People"), { recursive: true });
  await mkdir(join(vaultRoot, "Meetings"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Customers/BCBS OF KANSAS CITY/BCBS OF KANSAS CITY.md"),
    CUSTOMER_NOTE,
    "utf-8",
  );
  await writeFile(join(vaultRoot, "Reference/My Profile.md"), PROFILE_NOTE, "utf-8");

  harness = await setupHarness(vaultRoot);
}, 30_000);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("link integrity — clean vault", () => {
  it("reports no broken links when every target resolves", async () => {
    const res = await healthReport(harness);
    expect(res.report.brokenLinks).toEqual([]);
  });
});

describe("link integrity — write path", () => {
  it("resolves alias-only links written through create_note", async () => {
    const created = await harness.server.callToolJson("create_note", {
      path: "People/Roster Author.md",
      content: `---
type: Person
---

# Roster Author

Covers [[BlueKC | AI-Assisted Prior Authorization]] with [[Jin Lee (HLS US SE)]].
`,
    });
    expect(created.status).toBe("created");

    const node = harness.graph.getNode("People/Roster Author.md");
    expect(
      node!.outLinks.has("Customers/BCBS OF KANSAS CITY/BCBS OF KANSAS CITY.md"),
    ).toBe(true);
    expect(node!.outLinks.has("Reference/My Profile.md")).toBe(true);

    const res = await healthReport(harness);
    expect(res.report.brokenLinks).toEqual([]);
  }, 30_000);

  it("records the backlink so traversal can reach the writer", async () => {
    const related = await harness.server.callToolJson("get_related_entities", {
      path: "Reference/My Profile.md",
      max_hops: 1,
    });
    expect(JSON.stringify(related)).toContain("People/Roster Author.md");
  });

  it("keeps links resolved when atomic_append adds one", async () => {
    const meta = await harness.server.callToolJson("get_note_metadata", {
      path: "Customers/BCBS OF KANSAS CITY/BCBS OF KANSAS CITY.md",
    });

    const appended = await harness.server.callToolJson("atomic_append", {
      path: "Customers/BCBS OF KANSAS CITY/BCBS OF KANSAS CITY.md",
      heading: "Agent Insights",
      content: "- 2026-08-20 Coordinated with [[Jin Lee]] on prior auth",
      expected_mtime: meta.mtime_ms,
    });
    expect(appended.status).toBe("executed");

    const res = await healthReport(harness);
    expect(res.report.brokenLinks).toEqual([]);
  }, 30_000);
});

describe("link integrity — detection is not vacuous", () => {
  it("reports a target that resolves to nothing", async () => {
    await harness.server.callToolJson("create_note", {
      path: "People/Typo Author.md",
      content: `---
type: Person
---

# Typo Author

Mentions [[Blue KC]] and [[Jin Lee (HLS US SEE)]].
`,
    });

    const res = await healthReport(harness);
    const targets = res.report.brokenLinks.map((l: { target: string }) => l.target).sort();
    expect(targets).toEqual(["Blue KC", "Jin Lee (HLS US SEE)"]);
    expect(
      res.report.brokenLinks.every(
        (l: { path: string }) => l.path === "People/Typo Author.md",
      ),
    ).toBe(true);
  }, 30_000);

  it("surfaces broken links in the tool's issue summary", async () => {
    const res = await healthReport(harness);
    expect(
      res.issues.some((i: string) => i.includes("broken wikilink")),
    ).toBe(true);
  });

  it("clears the report once the missing target note is created", async () => {
    await harness.server.callToolJson("create_note", {
      path: "People/Blue KC.md",
      content: "---\ntype: Person\n---\n\n# Blue KC\n",
    });
    await harness.server.callToolJson("create_note", {
      path: "People/Jin Lee (HLS US SEE).md",
      content: "---\ntype: Person\n---\n\n# Jin Lee (HLS US SEE)\n",
    });

    const res = await healthReport(harness);
    expect(res.report.brokenLinks).toEqual([]);
  }, 60_000);
});

describe("link integrity — attachment embeds", () => {
  it("does not report non-markdown embeds as broken links", async () => {
    const embedDir = await mkdtemp(join(tmpdir(), "oil-embed-"));
    const root = join(embedDir, "vault");
    await mkdir(root, { recursive: true });

    await writeFile(
      join(root, "Briefing.md"),
      `# Briefing

![[consumption-hygiene.pdf]]
![[architecture diagram.png]]

Links to [[Appendix]].
`,
      "utf-8",
    );
    await writeFile(join(root, "Appendix.md"), "# Appendix\n", "utf-8");

    const graph = new GraphIndex(root);
    await graph.build();

    expect(graph.getBrokenLinks()).toEqual([]);

    await rm(embedDir, { recursive: true, force: true });
  });

  it("still reports a missing markdown target that carries an .md suffix", async () => {
    const mdDir = await mkdtemp(join(tmpdir(), "oil-mdext-"));
    const root = join(mdDir, "vault");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "Source.md"), "# Source\n\nSee [[Missing.md]].\n", "utf-8");

    const graph = new GraphIndex(root);
    await graph.build();

    expect(graph.getBrokenLinks()).toEqual([{ path: "Source.md", target: "Missing.md" }]);

    await rm(mdDir, { recursive: true, force: true });
  });
});

describe("link integrity — links inside markdown tables", () => {
  it("follows a table link whose alias pipe is escaped as \\|", async () => {
    const tableDir = await mkdtemp(join(tmpdir(), "oil-table-"));
    const root = join(tableDir, "vault");
    await mkdir(join(root, "Projects"), { recursive: true });
    await writeFile(join(root, "Projects/Helix.md"), "# Helix\n", "utf-8");
    await writeFile(
      join(root, "Milestone.md"),
      "# Milestone\n\n| Field | Value |\n| --- | --- |\n| Project | [[Projects/Helix\\|Project Helix]] |\n| Owner | [[Nobody \\|Ghost]] |\n",
      "utf-8",
    );

    const graph = new GraphIndex(root);
    await graph.build();

    expect(graph.getNode("Milestone.md")!.outLinks.has("Projects/Helix.md")).toBe(true);
    expect(graph.getBrokenLinks()).toEqual([{ path: "Milestone.md", target: "Nobody" }]);

    await rm(tableDir, { recursive: true, force: true });
  });

  it("repairs table-link targets in an index saved by an older release", async () => {
    const tableDir = await mkdtemp(join(tmpdir(), "oil-table-old-"));
    const root = join(tableDir, "vault");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "Helix.md"), "# Helix\n", "utf-8");
    await writeFile(join(root, "Milestone.md"), "# Milestone\n\n| [[Helix\\|H]] |\n", "utf-8");
    const old = {
      version: 2,
      builtAt: new Date().toISOString(),
      nodes: [
        { path: "Helix.md", title: "Helix", tags: [], headings: [], frontmatter: {}, rawOutLinks: [], lastModified: 0 },
        { path: "Milestone.md", title: "Milestone", tags: [], headings: [], frontmatter: {}, rawOutLinks: ["Helix\\"], lastModified: 0 },
      ],
    };
    await writeFile(join(root, "_oil-graph.json"), JSON.stringify(old), "utf-8");

    const graph = new GraphIndex(root);
    expect(await graph.loadFromDisk("_oil-graph.json")).toBe(true);

    expect(graph.getNode("Milestone.md")!.outLinks.has("Helix.md")).toBe(true);
    expect(graph.getBrokenLinks()).toEqual([]);

    await rm(tableDir, { recursive: true, force: true });
  });
});
