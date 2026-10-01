/**
 * Live end-to-end check of the semantic tier through the real MCP server.
 *
 * Everything else exercises the library in-process against a stub embedder.
 * This spawns the packaged stdio server, waits for it to finish embedding a
 * real vault with a real Ollama model, and asks it questions through the
 * `search_vault` tool — the same path an agent takes. Queries are phrased to
 * share no vocabulary with the notes that should answer them, so a lexical hit
 * would be a coincidence rather than a pass.
 *
 *   node bench/semantic-live-check.mjs
 */

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureVault = join(repoRoot, "bench", "fixtures", "vault");
const cli = join(repoRoot, "dist", "cli.js");

/** Queries whose answer note shares no meaningful words with the question. */
const CASES = [
  {
    query: "which client relationship is deteriorating",
    expect: "Customers/Northwind.md",
  },
  {
    query: "who can help me with generative assistant rollouts",
    expect: "People/Dave Wilson.md",
  },
  {
    query: "moving datacentre workloads to the cloud",
    expect: "Projects/azure-migration.md",
  },
  {
    query: "a situation that had to be raised to management",
    expect: "Meetings/2026-02-25-Northwind-Escalation.md",
  },
];

/** An exact entity name — the lexical tiers must answer without embedding. */
const LEXICAL_CASE = { query: "Contoso", expect: "Customers/Contoso.md" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "oil-live-"));
const vault = join(tempRoot, "vault");
await cp(fixtureVault, vault, { recursive: true });

let client;
let transport;

try {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, OIL_SEMANTIC: "on" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  client = new Client({ name: "oil-live-check", version: "1.0.0" });
  await client.connect(transport);

  const callJson = async (name, args) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  console.log("\nLive semantic check — real MCP server, real Ollama\n");

  // ── Wait for the background embed to finish ───────────────────────────────
  let health;
  const deadline = Date.now() + 120_000;
  do {
    health = await callJson("get_health", {});
    if (health.semantic.status === "ready" || health.semantic.status === "unavailable") break;
    await sleep(500);
  } while (Date.now() < deadline);

  console.log(
    `  semantic tier: ${health.semantic.status} — model ${health.semantic.model}, ` +
      `${health.semantic.note_count} vectors, ${health.semantic.dimensions} dims` +
      `${health.semantic.reason ? ` (${health.semantic.reason})` : ""}\n`,
  );

  check("tier reports ready", health.semantic.status === "ready", health.semantic.reason ?? "");
  check(
    "every note is embedded",
    health.semantic.note_count === health.index.note_count,
    `${health.semantic.note_count} vectors vs ${health.index.note_count} notes`,
  );
  check(
    "real model dimensionality",
    health.semantic.dimensions === 768,
    `got ${health.semantic.dimensions}`,
  );

  if (health.semantic.status !== "ready") {
    throw new Error(`Semantic tier never became ready: ${health.semantic.reason}`);
  }

  // ── Paraphrase queries through the real tool ──────────────────────────────
  console.log("\n  paraphrase queries (no shared vocabulary with the answer)\n");
  for (const testCase of CASES) {
    const result = await callJson("search_vault", { query: testCase.query, limit: 5 });
    const paths = result.results.map((r) => r.path);
    const rank = paths.indexOf(testCase.expect);
    const hit = result.results[rank];

    console.log(`    "${testCase.query}"`);
    console.log(`      tiers: ${result.tiers_used.join(" + ")}  escalated: ${result.escalated}`);
    console.log(`      top:   ${paths.slice(0, 3).join(", ") || "(none)"}`);

    check(
      `  finds ${testCase.expect} in top 5`,
      rank >= 0,
      `not found; got ${JSON.stringify(paths)}`,
    );
    if (rank >= 0) {
      check(
        `  credited to the semantic tier`,
        hit.matched_by.includes("semantic"),
        `matched_by=${JSON.stringify(hit.matched_by)}`,
      );
    }
  }

  // ── The lexical fast path must not pay for embeddings ─────────────────────
  console.log("\n  exact entity query\n");
  const lexical = await callJson("search_vault", { query: LEXICAL_CASE.query, limit: 5 });
  console.log(`    "${LEXICAL_CASE.query}"`);
  console.log(`      tiers: ${lexical.tiers_used.join(" + ")}  escalated: ${lexical.escalated}`);
  check(
    "  answered without the semantic tier",
    !lexical.tiers_used.includes("semantic"),
    `tiers=${JSON.stringify(lexical.tiers_used)}`,
  );
  check(
    `  still returns ${LEXICAL_CASE.expect} first`,
    lexical.results[0]?.path === LEXICAL_CASE.expect,
    `got ${lexical.results[0]?.path}`,
  );
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
