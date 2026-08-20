/**
 * Startup contract — spawned process budget.
 *
 * The in-process suite (src/__tests__/startup-contract.test.ts) proves the
 * ordering; this proves the number a client actually experiences, against the
 * built artifact, over real stdio, with a real MCP client.
 *
 * It exists because the regression it guards is silent: moving vault work back
 * in front of the transport breaks no test that asserts on tool output. What it
 * breaks is the handshake, and only on a vault large or slow enough to matter —
 * which is why the fixture here is deliberately large and deliberately cold.
 *
 * Usage: node scripts/startup-contract.mjs [--notes=2000] [--budget=3000]
 */

import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);

const NOTE_COUNT = Number(flags.notes ?? 2000);
/**
 * The handshake budget, in milliseconds.
 *
 * Set far below the MCP SDK's 60s request timeout and far below what indexing
 * this fixture costs (measured at ~6.4s cold for 2000 notes on a local SSD, and
 * unbounded on a synced or network vault). Any regression that re-couples the
 * handshake to vault size lands well outside it, on any machine.
 */
const BUDGET_MS = Number(flags.budget ?? 3000);

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
};

const tempRoot = await mkdtemp(join(tmpdir(), "oil-startup-contract-"));
const vault = join(tempRoot, "vault");

async function buildVault() {
  for (let folder = 0; folder < 20; folder++) {
    await mkdir(join(vault, `Folder${folder}`), { recursive: true });
  }
  await Promise.all(
    Array.from({ length: NOTE_COUNT }, (_, i) =>
      writeFile(
        join(vault, `Folder${i % 20}`, `Note ${i}.md`),
        `---\ncustomer: Customer${i % 40}\ntags: [tier${i % 5}]\n---\n\n# Note ${i}\n\n` +
          `[[Note ${(i + 1) % NOTE_COUNT}]]\n\n${"Substantive body content for retrieval. ".repeat(40)}\n`,
        "utf-8",
      ),
    ),
  );
}

/** Spawn the built server and time the handshake, exactly as a client would. */
async function session(label, run) {
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: tempRoot, // Deliberately not the repo: startup must not depend on cwd.
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, OIL_SEMANTIC: "off" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk.toString()));

  const client = new Client({ name: "oil-startup-contract", version: "1.0.0" });
  const startedAt = Date.now();
  try {
    await client.connect(transport);
    const handshakeMs = Date.now() - startedAt;
    return await run({ client, handshakeMs, stderr: () => stderrChunks.join("") });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (failures.length > 0 && stderrChunks.length > 0) {
      console.error(`\n--- server stderr (${label}) ---\n${stderrChunks.join("")}`);
    }
  }
}

const callJson = async (client, name, args = {}) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

/**
 * Block until the vault is hydrated, the way a caller does.
 *
 * `get_health` is ungated by design, so it reports a live snapshot rather than
 * waiting — reading `note_count` straight after connecting would race the
 * background build. Any gated tool is the honest way to wait.
 */
const waitForReady = async (client) => {
  await client.callTool({ name: "search_vault", arguments: { query: "ready", limit: 1 } });
  return callJson(client, "get_health");
};

try {
  console.log(`\nOIL startup contract — ${NOTE_COUNT} notes, budget ${BUDGET_MS}ms\n`);
  await buildVault();

  // ── Cold: no persisted index, the worst case a new session can hit ────────
  const cold = await session("cold", async ({ client, handshakeMs }) => {
    check(
      handshakeMs < BUDGET_MS,
      `cold handshake ${handshakeMs}ms < ${BUDGET_MS}ms budget (${NOTE_COUNT} notes, no persisted index)`,
    );

    const warming = await callJson(client, "get_health");
    check(
      typeof warming.startup?.phase === "string",
      `get_health answers during startup (phase=${warming.startup?.phase})`,
    );

    // A gated call waits for the index rather than answering from an empty one.
    const search = await callJson(client, "search_vault", { query: "Customer7", limit: 5 });
    check(
      Array.isArray(search.results) && search.results.length > 0,
      `first gated call returns real results (${search.results?.length ?? 0} hits)`,
    );

    const ready = await callJson(client, "get_health");
    check(
      ready.startup?.phase === "ready" && ready.index?.note_count === NOTE_COUNT,
      `index hydrated behind the handshake (${ready.index?.note_count}/${NOTE_COUNT} notes)`,
    );
    return handshakeMs;
  });

  // ── Warm: the persisted index the cold run just wrote ─────────────────────
  await session("warm", async ({ client, handshakeMs }) => {
    check(
      handshakeMs < BUDGET_MS,
      `warm handshake ${handshakeMs}ms < ${BUDGET_MS}ms budget`,
    );
    const health = await waitForReady(client);
    check(health.index?.note_count === NOTE_COUNT, "warm start serves the persisted index");
  });

  console.log(`\n  cold handshake was ${cold}ms\n`);

  // ── A vault that is not there must not be fatal ───────────────────────────
  const absent = join(tempRoot, "not-mounted");
  const absentTransport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: tempRoot,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: absent, OIL_SEMANTIC: "off" },
    stderr: "pipe",
  });
  const absentClient = new Client({ name: "oil-startup-contract", version: "1.0.0" });
  try {
    const startedAt = Date.now();
    await absentClient.connect(absentTransport);
    check(
      Date.now() - startedAt < BUDGET_MS,
      "server still completes the handshake when the vault is missing",
    );
    const health = await callJson(absentClient, "get_health");
    check(
      health.startup?.phase === "failed" && /does not exist/i.test(health.startup?.reason ?? ""),
      `missing vault is reported, not fatal (${health.startup?.reason ?? "no reason"})`,
    );
  } catch (err) {
    check(false, `missing vault killed the server: ${err.message}`);
  } finally {
    await absentClient.close().catch(() => undefined);
    await absentTransport.close().catch(() => undefined);
  }

  // ── A corrupt persisted index must degrade, not fail ──────────────────────
  await writeFile(join(vault, "_oil-graph.json"), '{"version":2,"nodes":[{"pa', "utf-8");
  await session("corrupt index", async ({ client, handshakeMs }) => {
    check(handshakeMs < BUDGET_MS, `corrupt-index handshake ${handshakeMs}ms < ${BUDGET_MS}ms`);
    const health = await waitForReady(client);
    check(health.index?.note_count === NOTE_COUNT, "corrupt index is rebuilt, not fatal");
  });

  // ── Several sessions on one vault, as a multi-session client does ─────────
  await unlink(join(vault, "_oil-graph.json")).catch(() => undefined);
  const concurrent = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      session(`concurrent-${i}`, async ({ client, handshakeMs }) => {
        const health = await callJson(client, "get_health");
        return { handshakeMs, notes: health.index?.note_count };
      }),
    ),
  );
  const slowest = Math.max(...concurrent.map((r) => r.handshakeMs));
  check(
    slowest < BUDGET_MS,
    `4 concurrent cold sessions all handshake within budget (slowest ${slowest}ms)`,
  );

  console.log("");
  if (failures.length > 0) {
    console.error(`Startup contract FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("Startup contract passed.\n");
  }
} finally {
  if (!process.env.OIL_KEEP_SMOKE_TEMP) {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`Preserved startup contract directory: ${tempRoot}`);
  }
}
