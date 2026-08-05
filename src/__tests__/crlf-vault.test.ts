/**
 * CRLF regression suite — issue #2.
 *
 * The existing fixtures are all LF, which is exactly why the CRLF blocker
 * (P1) shipped undetected: every line-oriented parser split on "\n" and
 * matched with `.`-based regexes, and `.` never matches "\r".
 *
 * These tests build a byte-identical pair of vaults (one LF, one CRLF) and
 * assert that every parse and retrieval surface produces the same result.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { VaultWatcher } from "../watcher.js";
import { loadConfig } from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";
import { registerCoreTools } from "../tools/core.js";
import { registerRetrieveTools } from "../tools/retrieve.js";
import { registerWriteTools } from "../tools/write.js";
import { registerDomainTools } from "../tools/domain.js";
import { MockMcpServer } from "./harness.js";
import {
  parseSections,
  parseTeam,
  parseOpportunities,
  parseMilestones,
  parseActionItems,
  parseNote,
  normalizeLineEndings,
  detectLineEnding,
  resolveTeamSection,
} from "../vault.js";
import { checkVaultHealth } from "../hygiene.js";
import { extractPrefetchIds } from "../correlate.js";

// ── Fixture content (authored in LF, materialized in both conventions) ────────

const CUSTOMER_NOTE = `---
tags: [customer]
tpid: "778899"
accountid: "5f2c1d90-1111-4d2e-9a3b-0c1d2e3f4a5b"
---

# Contoso Ltd

## Summary

Strategic migration account.

## Team

- [[Jin Lee (HLS US SE)]] — Sr Solution Engineer Cloud & AI
- [[Andrea Welker (She/Her)]] — Strat Acct Tech Strategist
- Bob Chen - Cloud Architect
- Ada Lovelace (Engineer)
- [[Dave Wilson]]

## Opportunities

- Azure Migration Wave 2 (opportunityid: a1b2c3d4-1111-2222-3333-444455556666)

## Milestones

- MS-14 Landing Zone Signoff (milestoneid: 99887766-aaaa-bbbb-cccc-ddddeeeeffff)

## Agent Insights

- 2026-07-01 Confirmed cutover window with platform team.

## Connect Hooks

- Sponsor prefers Thursday reviews.

## Task Activity Log

- [ ] Follow up on network dependency @jinlee
- [x] Send recap deck
`;

const MEETING_NOTE = `---
date: 2026-07-15
customer: Contoso
---

# Migration Review

## Notes

Discussed the landing zone.

## Actions

- [ ] Draft rollback plan [[Jin Lee]]
`;

/** Materialize a vault with a specific line-ending convention. */
async function buildVault(root: string, eol: "\n" | "\r\n"): Promise<void> {
  const convert = (s: string) => (eol === "\n" ? s : s.replace(/\n/g, "\r\n"));

  await mkdir(join(root, "Customers/Contoso"), { recursive: true });
  await mkdir(join(root, "Meetings"), { recursive: true });
  await mkdir(join(root, "People"), { recursive: true });

  await writeFile(
    join(root, "Customers/Contoso/Contoso.md"),
    convert(CUSTOMER_NOTE),
    "utf-8",
  );
  await writeFile(
    join(root, "Meetings/2026-07-15-Contoso-Migration-Review.md"),
    convert(MEETING_NOTE),
    "utf-8",
  );
  await writeFile(
    join(root, "People/Jin Lee.md"),
    convert(`---\ncustomers: [Contoso]\n---\n\n# Jin Lee\n\nSolution engineer.\n`),
    "utf-8",
  );
  // Person note whose filename carries the org suffix, matching the roster
  // wikilink `[[Jin Lee (HLS US SE)]]` exactly.
  await writeFile(
    join(root, "People/Jin Lee (HLS US SE).md"),
    convert(`---\ncustomers: [Contoso]\n---\n\n# Jin Lee (HLS US SE)\n\nSr Solution Engineer.\n`),
    "utf-8",
  );
}

interface Harness {
  server: MockMcpServer;
  graph: GraphIndex;
  cache: SessionCache;
  root: string;
}

async function harnessFor(root: string): Promise<Harness> {
  const config = await loadConfig(root);
  const graph = new GraphIndex(root);
  await graph.build();
  const cache = new SessionCache();
  const server = new MockMcpServer();
  const watcher = new VaultWatcher(root, graph, cache);

  registerCoreTools(server as any, root, graph, cache, watcher, config);
  registerRetrieveTools(server as any, root, graph, cache, config);
  registerWriteTools(server as any, root, graph, cache, config);
  registerDomainTools(server as any, root, graph, cache, config);

  return { server, graph, cache, root };
}

let tempDir: string;
let lfRoot: string;
let crlfRoot: string;
let lf: Harness;
let crlf: Harness;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-crlf-"));
  lfRoot = join(tempDir, "lf-vault");
  crlfRoot = join(tempDir, "crlf-vault");

  await buildVault(lfRoot, "\n");
  await buildVault(crlfRoot, "\r\n");

  lf = await harnessFor(lfRoot);
  crlf = await harnessFor(crlfRoot);
}, 30_000);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── P1: pure parse layer ──────────────────────────────────────────────────────

describe("P1 — CRLF line endings in pure parsers", () => {
  const lfBody = "## Team\n\n- [[Ada Lovelace]] — Engineer\n\n## Summary\n\ntext\n";
  const crlfBody = lfBody.replace(/\n/g, "\r\n");
  const crBody = lfBody.replace(/\n/g, "\r");

  it("the fixture vault really is CRLF on disk", async () => {
    const raw = await readFile(join(crlfRoot, "Customers/Contoso/Contoso.md"), "utf-8");
    expect(raw.includes("\r\n")).toBe(true);

    const lfRaw = await readFile(join(lfRoot, "Customers/Contoso/Contoso.md"), "utf-8");
    expect(lfRaw.includes("\r")).toBe(false);
  });

  it("parseSections returns identical sections for LF, CRLF, and CR", () => {
    expect(parseSections(lfBody).size).toBe(2);
    expect(parseSections(crlfBody).size).toBe(2);
    expect(parseSections(crBody).size).toBe(2);
    expect([...parseSections(crlfBody).keys()]).toEqual(["Team", "Summary"]);
    expect(parseSections(crlfBody).get("Summary")).toBe("text");
  });

  it("section bodies carry no stray carriage returns", () => {
    const team = parseSections(crlfBody).get("Team")!;
    expect(team.includes("\r")).toBe(false);
    expect(team).toBe("- [[Ada Lovelace]] — Engineer");
  });

  it("parseTeam, parseOpportunities, parseMilestones agree across conventions", () => {
    const sectionsLf = parseSections(CUSTOMER_NOTE);
    const sectionsCrlf = parseSections(CUSTOMER_NOTE.replace(/\n/g, "\r\n"));

    expect(parseTeam(sectionsCrlf.get("Team")!)).toEqual(
      parseTeam(sectionsLf.get("Team")!),
    );
    expect(parseOpportunities(sectionsCrlf.get("Opportunities")!)).toEqual(
      parseOpportunities(sectionsLf.get("Opportunities")!),
    );
    expect(parseMilestones(sectionsCrlf.get("Milestones")!)).toEqual(
      parseMilestones(sectionsLf.get("Milestones")!),
    );
  });

  it("parseActionItems finds tasks in CRLF content without trailing \\r", () => {
    const items = parseActionItems(CUSTOMER_NOTE.replace(/\n/g, "\r\n"), "x.md");
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("Follow up on network dependency @jinlee");
    expect(items[0].text.includes("\r")).toBe(false);
    expect(items[1].done).toBe(true);
  });

  it("parseNote produces an identical structure for CRLF input", () => {
    const a = parseNote("Customers/Contoso.md", CUSTOMER_NOTE);
    const b = parseNote("Customers/Contoso.md", CUSTOMER_NOTE.replace(/\n/g, "\r\n"));

    expect(b.title).toBe(a.title);
    expect(b.content).toBe(a.content);
    expect([...b.sections.entries()]).toEqual([...a.sections.entries()]);
    expect(b.wikilinks).toEqual(a.wikilinks);
    expect(b.tags).toEqual(a.tags);
  });

  it("normalizeLineEndings and detectLineEnding behave", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("no newlines")).toBe("\n");
  });
});

// ── P1: tool surfaces ─────────────────────────────────────────────────────────

describe("P1 — CRLF vault retrieval surfaces", () => {
  const notePath = "Customers/Contoso/Contoso.md";

  it("read_note_section returns the section body (not NOT_FOUND)", async () => {
    const result = await crlf.server.callToolJson("read_note_section", {
      path: notePath,
      heading: "Team",
    });
    expect(result.error_code).toBeUndefined();
    expect(result.content).toContain("Sr Solution Engineer");
    expect(result.content.includes("\r")).toBe(false);
  });

  it("get_note_metadata headings match read_note_section availability", async () => {
    const meta = await crlf.server.callToolJson("get_note_metadata", { path: notePath });
    expect(meta.headings).toContain("Team");
    expect(meta.headings).toContain("Task Activity Log");

    // The two code paths must never disagree — that was the confusing part of #2.
    const missing = await crlf.server.callToolJson("read_note_section", {
      path: notePath,
      heading: "__nope__",
    });
    expect(missing.available_headings).toEqual(meta.headings);
    expect(missing.available_headings.length).toBeGreaterThan(0);
  });

  it("get_customer_context populates team, insights and connect hooks", async () => {
    const ctx = await crlf.server.callToolJson("get_customer_context", {
      customer: "Contoso",
    });
    expect(ctx.team.length).toBe(5);
    expect(ctx.agentInsights.length).toBeGreaterThan(0);
    expect(ctx.connectHooks).toBeTruthy();
    expect(ctx.openItems.length).toBeGreaterThan(0);
  });

  it("get_customer_context output is identical between LF and CRLF vaults", async () => {
    const stripVolatile = (o: any) => {
      const { customer_mtime_ms, customer_version, ...rest } = o;
      return rest;
    };
    const a = await lf.server.callToolJson("get_customer_context", { customer: "Contoso" });
    const b = await crlf.server.callToolJson("get_customer_context", { customer: "Contoso" });
    expect(stripVolatile(b)).toEqual(stripVolatile(a));
  });

  it("check_vault_health reports hasTeam/hasConnectHooks true", async () => {
    const health = await crlf.server.callToolJson("check_vault_health", {
      customers: ["Contoso"],
    });
    const contoso = health.report.customers[0];
    expect(contoso.hasTeam).toBe(true);
    expect(contoso.hasConnectHooks).toBe(true);
    expect(health.issues).not.toContain("Contoso: no ## Team section");
  });

  it("prepare_crm_prefetch returns team members from a CRLF roster", async () => {
    const pre = await crlf.server.callToolJson("prepare_crm_prefetch", {
      customers: ["Contoso"],
    });
    expect(pre.prefetch[0].teamMembers.length).toBe(5);
    expect(pre.prefetch[0].opportunityGuids.length).toBe(1);
  });

  it("graph headings and wikilinks index correctly for CRLF notes", () => {
    const node = crlf.graph.getNode("Customers/Contoso/Contoso.md")!;
    expect(node).toBeDefined();
    expect(node.headings).toContain("Team");
    expect(node.title).toBe("Contoso Ltd");
    expect(node.tags).toContain("customer");
  });

  it("get_related_entities resolves customer → People through the roster", () => {
    // The roster links [[Jin Lee (HLS US SE)]]; on a CRLF vault the ## Team
    // section used to parse to nothing, so this traversal returned nothing.
    const related = crlf.graph.getRelatedNotes("Customers/Contoso/Contoso.md", 2);
    expect(related.some((r) => r.path === "People/Jin Lee (HLS US SE).md")).toBe(true);

    const lfRelated = lf.graph.getRelatedNotes("Customers/Contoso/Contoso.md", 2);
    expect(related.map((r) => r.path).sort()).toEqual(
      lfRelated.map((r) => r.path).sort(),
    );
  });
});

// ── P7: parseTeam and names containing parentheses ────────────────────────────

describe("P7 — parseTeam handles parentheses in display names", () => {
  it("does not split inside a wikilinked name with an org suffix", () => {
    const team = parseTeam("- [[Jin Lee (HLS US SE)]] — Sr Solution Engineer Cloud & AI");
    expect(team).toEqual([
      { name: "Jin Lee (HLS US SE)", role: "Sr Solution Engineer Cloud & AI" },
    ]);
  });

  it("does not split inside a pronoun suffix", () => {
    const team = parseTeam("- [[Andrea Welker (She/Her)]] — Strat Acct Tech Strategist");
    expect(team).toEqual([
      { name: "Andrea Welker (She/Her)", role: "Strat Acct Tech Strategist" },
    ]);
  });

  it("handles a bare (unlinked) parenthetical name with an em-dash role", () => {
    expect(parseTeam("- Jin Lee (HLS US SE) — Sr Solution Engineer")).toEqual([
      { name: "Jin Lee (HLS US SE)", role: "Sr Solution Engineer" },
    ]);
  });

  it("still supports the legacy shapes", () => {
    expect(parseTeam("- Bob Chen - Cloud Architect")).toEqual([
      { name: "Bob Chen", role: "Cloud Architect" },
    ]);
    expect(parseTeam("- Ada Lovelace (Engineer)")).toEqual([
      { name: "Ada Lovelace", role: "Engineer" },
    ]);
    expect(parseTeam("- [[Dave Wilson]]")).toEqual([{ name: "Dave Wilson" }]);
    expect(parseTeam("- Grace Hopper – Rear Admiral")).toEqual([
      { name: "Grace Hopper", role: "Rear Admiral" },
    ]);
  });

  it("keeps hyphenated names intact", () => {
    expect(parseTeam("- Jean-Luc Picard — Captain")).toEqual([
      { name: "Jean-Luc Picard", role: "Captain" },
    ]);
    expect(parseTeam("- Jean-Luc Picard")).toEqual([{ name: "Jean-Luc Picard" }]);
  });

  it("resolves aliased wikilinks to the target name", () => {
    expect(parseTeam("- [[People/Jin Lee|Jin Lee]] — SE")).toEqual([
      { name: "People/Jin Lee", role: "SE" },
    ]);
  });

  it("never leaks bracket residue into the role", () => {
    for (const member of parseTeam(parseSections(CUSTOMER_NOTE).get("Team")!)) {
      expect(member.role ?? "").not.toContain("]]");
      expect(member.name).not.toContain("]]");
    }
  });
});

// ── P4: hasTeam accepts the same headings as get_customer_context ─────────────

describe("P4 — team section resolution is shared", () => {
  it("resolveTeamSection accepts every supported heading variant", () => {
    for (const heading of ["Team", "Microsoft Team", "Key Stakeholders", "Stakeholders"]) {
      const sections = new Map([[heading, "- Ada Lovelace — Engineer"]]);
      expect(resolveTeamSection(sections)).toBe("- Ada Lovelace — Engineer");
    }
    expect(resolveTeamSection(new Map([["Notes", "x"]]))).toBe("");
  });

  it("hasTeam is true for a vault that uses ## Microsoft Team", async () => {
    const root = join(tempDir, "msteam-vault");
    await mkdir(join(root, "Customers/Fabrikam"), { recursive: true });
    await writeFile(
      join(root, "Customers/Fabrikam/Fabrikam.md"),
      "---\ntags: [customer]\n---\r\n\r\n# Fabrikam\r\n\r\n## Microsoft Team\r\n\r\n- [[Ada Lovelace]] — Engineer\r\n\r\n## Connect\r\n\r\n- Prefers email.\r\n",
      "utf-8",
    );

    const graph = new GraphIndex(root);
    await graph.build();
    const cache = new SessionCache();
    const report = await checkVaultHealth(root, graph, DEFAULT_CONFIG, cache, ["Fabrikam"]);

    expect(report.customers[0].hasTeam).toBe(true);
    expect(report.customers[0].hasConnectHooks).toBe(true);
  });
});

// ── P2: cache invalidation ────────────────────────────────────────────────────

describe("P2 — SessionCache does not serve stale content", () => {
  it("invalidateNote matches regardless of path separator style", async () => {
    const cache = new SessionCache();
    const note = parseNote("Customers/Contoso.md", CUSTOMER_NOTE);

    cache.putNote("Customers/Contoso.md", note);
    // The Windows watcher produced backslash paths — this used to miss.
    cache.invalidateNote("Customers\\Contoso.md");
    expect(cache.getNote("Customers/Contoso.md")).toBeUndefined();

    cache.putNote("Customers\\Contoso.md", note);
    expect(cache.getNote("Customers/Contoso.md")).toBeDefined();
  });

  it("revalidates against the file mtime when the caller supplies one", () => {
    const cache = new SessionCache();
    const note = parseNote("a.md", CUSTOMER_NOTE);

    cache.putNote("a.md", note, 1000);
    expect(cache.getNote("a.md", 1000)).toBeDefined();
    // File changed underneath us — the cached copy must be discarded.
    expect(cache.getNote("a.md", 2000)).toBeUndefined();
    expect(cache.getNote("a.md", 2000)).toBeUndefined();
  });

  it("check_vault_health reflects an external edit immediately (no TTL wait)", async () => {
    const root = join(tempDir, "external-edit-vault");
    const notePath = join(root, "Customers/Adventure/Adventure.md");
    await mkdir(join(root, "Customers/Adventure"), { recursive: true });
    await writeFile(
      notePath,
      "---\ntags: [customer]\n---\n\n# Adventure Works\n\n## Summary\n\nNo roster yet.\n",
      "utf-8",
    );

    const graph = new GraphIndex(root);
    await graph.build();
    const cache = new SessionCache();

    const before = await checkVaultHealth(root, graph, DEFAULT_CONFIG, cache, ["Adventure"]);
    expect(before.customers[0].hasTeam).toBe(false);

    // Simulate an external edit (Obsidian / sync script) with CRLF endings,
    // and a mtime the OS will report as different.
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(
      notePath,
      "---\ntags: [customer]\n---\r\n\r\n# Adventure Works\r\n\r\n## Team\r\n\r\n- [[Ada Lovelace]] — Engineer\r\n",
      "utf-8",
    );

    const after = await checkVaultHealth(root, graph, DEFAULT_CONFIG, cache, ["Adventure"]);
    expect(after.customers[0].hasTeam).toBe(true);
  });

  it("graph updateNote/removeNote accept Windows-style separators", async () => {
    const graph = new GraphIndex(crlfRoot);
    await graph.build();

    expect(graph.getNode("Customers\\Contoso\\Contoso.md")).toBeDefined();
    await graph.updateNote("Customers\\Contoso\\Contoso.md");
    expect(graph.getNode("Customers/Contoso/Contoso.md")).toBeDefined();

    graph.removeNote("Customers\\Contoso\\Contoso.md");
    expect(graph.getNode("Customers/Contoso/Contoso.md")).toBeUndefined();
  });

  it("watcher does not ignore the whole vault when the root is a dot-directory", async () => {
    // Real-world layout: `<repo>/.vault`. The previous `ignored` rule tested a
    // dot-segment pattern against the ABSOLUTE path, so every file under a
    // dotted vault root was ignored and no invalidation ever fired.
    const dotRoot = join(tempDir, ".vault");
    await mkdir(join(dotRoot, "Customers"), { recursive: true });

    const graph = new GraphIndex(dotRoot);
    const cache = new SessionCache();
    const watcher = new VaultWatcher(dotRoot, graph, cache);
    const shouldIgnore = (p: string): boolean =>
      (watcher as unknown as { shouldIgnore(p: string): boolean }).shouldIgnore(p);

    expect(shouldIgnore(join(dotRoot, "Customers/Contoso.md"))).toBe(false);
    expect(shouldIgnore(join(dotRoot, "Customers"))).toBe(false);
    expect(shouldIgnore(dotRoot)).toBe(false);

    // Genuinely ignorable paths are still ignored, based on vault-relative segments.
    expect(shouldIgnore(join(dotRoot, ".obsidian/workspace.json"))).toBe(true);
    expect(shouldIgnore(join(dotRoot, "Customers/.hidden.md"))).toBe(true);
    expect(shouldIgnore(join(dotRoot, "node_modules/pkg/readme.md"))).toBe(true);
  });

  it("writes update the graph inline, without waiting on the watcher debounce", async () => {
    const root = join(tempDir, "write-sync-vault");
    await mkdir(join(root, "People"), { recursive: true });
    await writeFile(
      join(root, "People/Grace Hopper.md"),
      "---\ncustomers: [Initech]\n---\n\n# Grace Hopper\n",
      "utf-8",
    );

    const config = await loadConfig(root);
    const graph = new GraphIndex(root);
    await graph.build();
    const cache = new SessionCache();
    const server = new MockMcpServer();
    registerRetrieveTools(server as any, root, graph, cache, config);
    registerWriteTools(server as any, root, graph, cache, config);

    // No watcher is running at all here — the write path itself must re-index.
    const created = await server.callToolRaw("create_note", {
      path: "Customers/Initech.md",
      content:
        "---\ntags: [customer]\ntpid: \"424242\"\n---\r\n\r\n# Initech\r\n\r\n## Team\r\n\r\n- [[Grace Hopper]] — Engineer\r\n",
    });
    expect(JSON.parse(created).status).toBe("created");

    expect(graph.getNode("Customers/Initech.md")).toBeDefined();

    const related = await server.callToolRaw("get_related_entities", {
      path: "Customers/Initech.md",
      max_hops: 2,
    });
    expect(related).toContain("People/Grace Hopper.md");

    const byFm = await server.callToolRaw("query_frontmatter", {
      key: "tpid",
      value_fragment: "424242",
    });
    expect(byFm).toContain("Customers/Initech.md");
  });
});

// ── P5: entity naming precedence ──────────────────────────────────────────────

describe("P5 — entity names prefer frontmatter title", () => {
  it("uses frontmatter title instead of a decorative H1", async () => {
    const root = join(tempDir, "entity-title-vault");
    await mkdir(join(root, "Customers/Globex/opportunities"), { recursive: true });
    await mkdir(join(root, "Customers/Globex/milestones"), { recursive: true });
    await writeFile(
      join(root, "Customers/Globex/Globex.md"),
      "---\ntags: [customer]\n---\r\n\r\n# Globex\r\n",
      "utf-8",
    );
    await writeFile(
      join(root, "Customers/Globex/opportunities/wave-2.md"),
      "---\ntitle: Azure Migration Wave 2\nopportunityId: a1b2c3d4-1111-2222-3333-444455556666\n---\r\n\r\n# 🎯\r\n",
      "utf-8",
    );
    await writeFile(
      join(root, "Customers/Globex/milestones/ms-14.md"),
      "---\ntitle: Landing Zone Signoff\nmilestoneId: 99887766-aaaa-bbbb-cccc-ddddeeeeffff\n---\r\n\r\n# 🚩\r\n",
      "utf-8",
    );

    const { readOpportunityNotes, readMilestoneNotes } = await import("../vault.js");
    const opps = await readOpportunityNotes(root, DEFAULT_CONFIG, "Globex");
    const miles = await readMilestoneNotes(root, DEFAULT_CONFIG, "Globex");

    expect(opps[0].name).toBe("Azure Migration Wave 2");
    expect(miles[0].name).toBe("Landing Zone Signoff");
  });

  it("falls back to H1 then filename when no frontmatter title exists", async () => {
    const root = join(tempDir, "entity-fallback-vault");
    await mkdir(join(root, "Customers/Initech/opportunities"), { recursive: true });
    await writeFile(
      join(root, "Customers/Initech/Initech.md"),
      "---\ntags: [customer]\n---\n\n# Initech\n",
      "utf-8",
    );
    await writeFile(
      join(root, "Customers/Initech/opportunities/renewal.md"),
      "---\nstage: Inspire & Design\n---\r\n\r\n# Annual Renewal\r\n",
      "utf-8",
    );

    const { readOpportunityNotes } = await import("../vault.js");
    const opps = await readOpportunityNotes(root, DEFAULT_CONFIG, "Initech");
    expect(opps[0].name).toBe("Annual Renewal");
    expect(opps[0].stage).toBe("Inspire & Design");
  });
});

// ── P6: OData hints ───────────────────────────────────────────────────────────

describe("P6 — prepare_crm_prefetch emits type-correct OData filters", () => {
  it("account_filter uses the account GUID, tpid is exposed separately", async () => {
    const result = await crlf.server.callToolJson("prepare_crm_prefetch", {
      customers: ["Contoso"],
    });
    const hints = result.prefetch[0].odata_hints;

    expect(hints.account_filter).toBe(
      "_msp_accountid_value eq '5f2c1d90-1111-4d2e-9a3b-0c1d2e3f4a5b'",
    );
    // The TPID must never be fed into a GUID lookup field.
    expect(hints.account_filter).not.toContain("778899");
    expect(hints.tpid_filter).toBe("msp_mstopparentid eq '778899'");
  });

  it("opportunity_filter is a complete, syntactically valid expression", async () => {
    const result = await crlf.server.callToolJson("prepare_crm_prefetch", {
      customers: ["Contoso"],
    });
    const filter: string = result.prefetch[0].odata_hints.opportunity_filter;
    const guids: string[] = result.prefetch[0].opportunityGuids;

    // No truncation: every known GUID appears, and the expression is balanced.
    for (const g of guids) expect(filter).toContain(g);
    expect(filter.endsWith("'")).toBe(true);
    expect((filter.match(/'/g) ?? []).length % 2).toBe(0);
    expect(filter).not.toContain("[truncated]");
  });

  it("emits complete data for multiple customers in one call", async () => {
    const result = await crlf.server.callToolJson("prepare_crm_prefetch", {
      customers: ["Contoso", "Contoso"],
    });
    expect(result.prefetch).toHaveLength(2);
    for (const p of result.prefetch) {
      expect(p.teamMembers).toHaveLength(5);
      expect(JSON.stringify(p)).not.toContain("[truncated]");
    }
  });
});

// ── P3: response completeness ─────────────────────────────────────────────────

describe("P3 — composite responses are complete and self-consistent", () => {
  it("get_customer_context arrays match check_vault_health counts", async () => {
    const ctx = await crlf.server.callToolJson("get_customer_context", {
      customer: "Contoso",
      view: "full",
    });
    const health = await crlf.server.callToolJson("check_vault_health", {
      customers: ["Contoso"],
    });
    const freshness = health.report.customers[0];

    expect(ctx.opportunities).toHaveLength(freshness.opportunityCompleteness.total);
    expect(ctx.milestones).toHaveLength(freshness.milestoneCompleteness.total);
  });

  it("brief is genuinely smaller than full, and neither is truncated", async () => {
    const brief = await crlf.server.callToolRaw("get_customer_context", {
      customer: "Contoso",
      view: "brief",
    });
    const full = await crlf.server.callToolRaw("get_customer_context", {
      customer: "Contoso",
      view: "full",
    });

    expect(brief.length).toBeLessThan(full.length);
    for (const payload of [brief, full]) {
      expect(payload).not.toContain("LIMIT_EXCEEDED");
      expect(payload).not.toContain("RESULTS_TRUNCATED");
      expect(payload).not.toContain("[truncated]");
    }

    const briefJson = JSON.parse(brief);
    expect(briefJson.error_code).toBeUndefined();
    expect(briefJson.team).toHaveLength(5);
  });
});

// ── Write path: CRLF preservation ─────────────────────────────────────────────

describe("write operations preserve the document's line endings", () => {
  it("atomic_append keeps a CRLF note CRLF and stays readable", async () => {
    const path = "Customers/Contoso/Contoso.md";
    const meta = await crlf.server.callToolJson("get_note_metadata", { path });

    const result = await crlf.server.callToolJson("atomic_append", {
      path,
      heading: "Agent Insights",
      content: "- 2026-08-04 Appended by the CRLF regression test.",
      expected_mtime: meta.mtime_ms,
    });
    expect(result.status).toBe("executed");

    const raw = await readFile(join(crlfRoot, path), "utf-8");
    // No mixed endings: every LF must be part of a CRLF pair.
    expect(/[^\r]\n/.test(raw)).toBe(false);
    expect(raw).toContain("Appended by the CRLF regression test.");

    // And the appended content is retrievable through the section reader.
    const section = await crlf.server.callToolJson("read_note_section", {
      path,
      heading: "Agent Insights",
    });
    expect(section.content).toContain("Appended by the CRLF regression test.");

    // Sibling sections survive intact.
    const team = await crlf.server.callToolJson("read_note_section", {
      path,
      heading: "Team",
    });
    expect(team.content).toContain("Sr Solution Engineer");
  });

  it("atomic_append keeps an LF note LF", async () => {
    const path = "Customers/Contoso/Contoso.md";
    const meta = await lf.server.callToolJson("get_note_metadata", { path });
    await lf.server.callToolJson("atomic_append", {
      path,
      heading: "Agent Insights",
      content: "- 2026-08-04 LF append.",
      expected_mtime: meta.mtime_ms,
    });

    const raw = await readFile(join(lfRoot, path), "utf-8");
    expect(raw.includes("\r")).toBe(false);
    expect(raw).toContain("LF append.");
  });

  it("create_note then read_note_section round-trips CRLF content", async () => {
    const path = "Meetings/2026-08-04-CRLF-Roundtrip.md";
    const body = "---\ndate: 2026-08-04\ncustomer: Contoso\n---\r\n\r\n# CRLF Roundtrip\r\n\r\n## Decisions\r\n\r\n- Ship the fix.\r\n";

    const created = await crlf.server.callToolJson("create_note", { path, content: body });
    expect(created.status).toBe("created");

    const section = await crlf.server.callToolJson("read_note_section", {
      path,
      heading: "Decisions",
    });
    expect(section.content).toBe("- Ship the fix.");

    const onDisk = await stat(join(crlfRoot, path));
    expect(onDisk.isFile()).toBe(true);
  });

  it("extractPrefetchIds stays correct after a write + cache invalidation", async () => {
    const config = await loadConfig(crlfRoot);
    const ids = await extractPrefetchIds(
      crlfRoot,
      crlf.graph,
      config,
      crlf.cache,
      ["Contoso"],
    );
    expect(ids[0].teamMembers).toHaveLength(5);
    expect(ids[0].accountid).toBe("5f2c1d90-1111-4d2e-9a3b-0c1d2e3f4a5b");
    expect(ids[0].tpid).toBe("778899");
  });
});
