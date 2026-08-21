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
import { spawn } from "node:child_process";
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
 *
 * It is deliberately generous, because an absolute wall-clock budget measures
 * the machine as much as the code — a loaded laptop or a shared CI runner will
 * blow a tight one while the code is perfectly correct. The load-bearing
 * assertion is the scale-invariance check below, which compares this fixture's
 * handshake against a tiny vault's on the same machine at the same moment. That
 * is what actually distinguishes "the handshake waits for the vault" from "this
 * box is busy", and it holds regardless of how fast the box is.
 */
const BUDGET_MS = Number(flags.budget ?? 8000);

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
};

/**
 * Baseline handshake cost on this machine, at this moment.
 *
 * Everything a handshake legitimately costs — process spawn, module import,
 * transport setup — is independent of note count, so measuring it against a
 * five-note vault isolates the machine's contribution from the code's. Filled
 * in before the real sessions run.
 */
let baselineMs = 0;

/**
 * Whether timing on this machine is worth asserting on at all.
 *
 * A five-note vault handshake is almost entirely process spawn and module
 * import; when even that takes seconds, the box is saturated and every
 * subsequent number describes the box rather than the code. Timing checks
 * downgrade to advisory in that case, because a contract that fails for
 * reasons the code cannot influence gets ignored, and an ignored contract
 * protects nothing. The ordering assertions below are unaffected — they are
 * machine-independent by construction, and they are the actual guarantee.
 */
const TRUSTWORTHY_BASELINE_MS = 2500;
let timingIsTrustworthy = true;

/**
 * Fail a handshake only when it is both slow in absolute terms and slow
 * relative to this machine's own baseline.
 *
 * A bare wall-clock budget measures the hardware as much as the code: on a
 * loaded laptop or a shared CI runner it fails while the code is correct.
 * Requiring both conditions keeps the check sensitive to the regression it
 * exists for — the handshake becoming a function of vault size — while staying
 * immune to the box simply being busy.
 */
/**
 * Wall-clock assertions are opt-in via `OIL_PERF=1`.
 *
 * `timingIsTrustworthy` is sampled once, before any work — so it cannot see
 * load that arrives later in the run, and in `check:release` it reliably does:
 * the E2E script runs straight after a full vitest suite. Observed in one such
 * run, on a machine whose opening baseline looked fine at 987ms: the warm
 * handshake took 11,172ms here against 1,244ms standalone, and the concurrency
 * block measured 8,156ms against a `cold` sampled at 1,110ms earlier in the
 * same run. Load is not constant across a run, so comparing two phases of one
 * run does not cancel it either.
 *
 * Nothing is lost by gating: the contract this script exists for is structural
 * and every part of it is asserted separately and unconditionally — readiness
 * is announced before the vault is read, the index hydrates behind the
 * handshake, a missing vault is reported rather than fatal, a corrupt index is
 * rebuilt, concurrent sessions report a coherent index, and closing stdin exits
 * through the shutdown path. Those hold or fail regardless of how busy the box
 * is. The milliseconds only quantify them.
 */
const PERF = process.env.OIL_PERF === "1";

const checkHandshake = (handshakeMs, label, { concurrency = 1 } = {}) => {
  // Concurrent sessions share one CPU, so the slowest of N cold starts cannot
  // cost what a single one does — scaling the ceiling by N is the difference
  // between measuring contention and measuring the machine.
  const relativeCeiling = (baselineMs * 3 + 1500) * concurrency;
  const ok = handshakeMs < BUDGET_MS * concurrency || handshakeMs < relativeCeiling;
  const detail =
    `${label} handshake ${handshakeMs}ms (budget ${BUDGET_MS * concurrency}ms, ` +
    `machine baseline ${baselineMs}ms -> ceiling ${Math.round(relativeCeiling)}ms)`;
  if (!PERF) {
    console.log(`  ${ok ? "note " : "SLOW "} ${detail} — advisory, set OIL_PERF=1 to assert`);
    return;
  }
  if (!timingIsTrustworthy) {
    console.log(`  note  ${detail} — advisory, machine too loaded to judge`);
    return;
  }
  check(ok, detail);
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

const handshakeOf = async (vaultPath, { hydrate = false } = {}) => {
  const startedAt = Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: tempRoot,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath, OIL_SEMANTIC: "off" },
    stderr: "ignore",
  });
  const client = new Client({ name: "oil-startup-contract", version: "1.0.0" });
  await client.connect(transport);
  const elapsed = Date.now() - startedAt;
  if (hydrate) {
    await client.callTool(
      { name: "search_vault", arguments: { query: "ready", limit: 1 } },
      undefined,
      { timeout: 300_000 },
    );
  }
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  return elapsed;
};

try {
  console.log(`\nOIL startup contract — ${NOTE_COUNT} notes, budget ${BUDGET_MS}ms\n`);

  // Establish the warm handshake cost on this machine *before* building the
  // large vault. Sampling it afterwards measures the tail of the script's own
  // I/O storm rather than the machine: writing NOTE_COUNT files leaves the
  // filesystem and any on-access scanner busy for seconds. Observed with the
  // baseline taken after `buildVault()` on an idle box — 5464ms, against 1259ms
  // for the identical handshake on the identical vault later in the same run.
  // That inflates every derived ceiling fourfold and reports an idle machine as
  // loaded, so the check both permits too much and describes itself wrongly.
  //
  // Seed explicitly so the baseline cannot alternate between cold and warm
  // depending on whether a background five-note build finished.
  const tiny = join(tempRoot, "tiny-vault");
  await mkdir(tiny, { recursive: true });
  for (let i = 0; i < 5; i++) {
    await writeFile(join(tiny, `Tiny ${i}.md`), `# Tiny ${i}\n\nbody\n`, "utf-8");
  }
  await handshakeOf(tiny, { hydrate: true });
  const tinyWarmSamples = [];
  for (let i = 0; i < 5; i++) tinyWarmSamples.push(await handshakeOf(tiny));
  baselineMs = Math.min(...tinyWarmSamples);
  timingIsTrustworthy = baselineMs < TRUSTWORTHY_BASELINE_MS;
  console.log(
    `  machine baseline: ${baselineMs}ms warm handshake on a 5-note vault` +
      `${timingIsTrustworthy ? "" : " — LOADED, timing checks are advisory"}\n`,
  );

  await buildVault();

  // ── Cold: no persisted index, the worst case a new session can hit ────────
  const cold = await session("cold", async ({ client, handshakeMs }) => {
    checkHandshake(handshakeMs, `cold (${NOTE_COUNT} notes, no persisted index)`);

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
    checkHandshake(handshakeMs, "warm");
    const health = await waitForReady(client);
    check(health.index?.note_count === NOTE_COUNT, "warm start serves the persisted index");
  });

  console.log(`\n  cold handshake was ${cold}ms\n`);

  // ── The handshake must not scale with the vault ───────────────────────────
  //
  // This is the real contract. The regression being guarded is the handshake
  // becoming a function of vault size, and the only way to see that on an
  // arbitrarily fast or busy machine is to hold the machine constant and vary
  // the vault. A tiny vault measured back-to-back with the large one gives a
  // baseline for everything the handshake legitimately costs — process spawn,
  // module import, transport setup — none of which depends on note count.
  // ── The handshake must not scale with the vault ───────────────────────────
  //
  // Two assertions, deliberately. The ordering one is the guarantee: the server
  // announces itself ready *before* it touches the vault, which is true or
  // false regardless of how fast the machine is, and is exactly what regressed
  // when indexing sat in front of the transport. The timing one quantifies it,
  // and is advisory on a loaded box for the reasons given above.
  await unlink(join(vault, "_oil-graph.json")).catch(() => undefined);
  const ordering = await session("ordering", async ({ client, stderr }) => {
    // Wait for the vault work to actually happen, so its log line exists to be
    // ordered against the readiness line.
    await waitForReady(client);
    return stderr();
  });
  const readyAt = ordering.indexOf("MCP server ready");
  const buildAt = ordering.search(/full build|Graph index loaded/);
  check(
    readyAt !== -1 && (buildAt === -1 || readyAt < buildAt),
    "server announces readiness before it starts reading the vault",
  );

  // `ordering` awaited hydration above, so the large graph is persisted here.
  //
  // Interleave the two vaults and take the min of each, so any drift hits both
  // arms and single spikes are discarded. That makes the *ratio* trustworthy on
  // a busy box in a way no absolute number is — but it is reported, not
  // asserted, because it was observed not to catch the regression it names.
  //
  // With `hydration.begin(); await hydration.whenReady()` injected in front of
  // the transport in `src/server.ts` — the exact regression this script exists
  // for — this comparison read 668ms for 2000 notes against 762ms for 5 and
  // passed, while the ordering assertion above failed and the missing-vault
  // check failed with it. The reason is structural rather than a threshold
  // being wrong: by this point the 2000-note graph is *persisted*, and loading
  // a persisted index costs less than the spawn noise floor, so a warm-vs-warm
  // ratio cannot see a regression whose cost is a cold build. The cold path is
  // where that shows, and the ordering assertion covers it without a clock.
  //
  // Left in because the number is genuinely informative when it moves, and
  // because deleting it would hide the measurement that justifies the ordering
  // assertion carrying the contract. Asserting it would add flake risk — the
  // worst margin over five clean runs was 14% — in exchange for no coverage.
  const largeWarmSamples = [];
  const tinyNowSamples = [];
  for (let i = 0; i < 5; i++) {
    largeWarmSamples.push(await handshakeOf(vault));
    tinyNowSamples.push(await handshakeOf(tiny));
  }
  const largeHandshake = Math.min(...largeWarmSamples);
  const tinyNow = Math.min(...tinyNowSamples);
  const ceiling = tinyNow * 2 + 1000;
  const scaleDetail =
    `warm handshake is independent of vault size: ${NOTE_COUNT} notes ${largeHandshake}ms ` +
    `vs 5 notes ${tinyNow}ms (ceiling ${Math.round(ceiling)}ms)`;
  if (PERF && timingIsTrustworthy) {
    check(largeHandshake < ceiling, scaleDetail);
  } else {
    const marker = largeHandshake < ceiling ? "note " : "SLOW ";
    console.log(`  ${marker} ${scaleDetail} — advisory, set OIL_PERF=1 to assert`);
  }

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
    checkHandshake(Date.now() - startedAt, "missing-vault");
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
    checkHandshake(handshakeMs, "corrupt-index");
    const health = await waitForReady(client);
    check(health.index?.note_count === NOTE_COUNT, "corrupt index is rebuilt, not fatal");
  });

  // ── Several sessions on one vault, as a multi-session client does ─────────
  //
  // Four cold builds compete for one CPU, so the slowest legitimately costs a
  // multiple of a single cold start — this asserted a single-session ceiling
  // and so failed on a busy machine while the code was correct. The property
  // worth holding is that concurrency costs no *more* than running the sessions
  // one after another: that catches a deadlock or a pathological convoy, and
  // it is measured against this same run's cold handshake, so machine load
  // cancels out of both sides.
  await unlink(join(vault, "_oil-graph.json")).catch(() => undefined);
  const CONCURRENT_SESSIONS = 4;
  const concurrent = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      session(`concurrent-${i}`, async ({ client, handshakeMs }) => {
        const health = await callJson(client, "get_health");
        return { handshakeMs, notes: health.index?.note_count };
      }),
    ),
  );
  const slowest = Math.max(...concurrent.map((r) => r.handshakeMs));
  checkHandshake(slowest, `${CONCURRENT_SESSIONS} concurrent cold sessions (slowest)`, {
    concurrency: CONCURRENT_SESSIONS,
  });
  // Load-independent: no session may cost dramatically more than running them
  // all serially. The slack absorbs ordinary contention — four cold builds on a
  // box with fewer than four free cores legitimately approach the serial cost —
  // while a deadlock or a convoy is several times worse than this and still
  // fails. Both sides come from the same run, so machine load cancels.
  const CONVOY_SLACK = 1.5;
  const serialEquivalent = Math.round(cold * CONCURRENT_SESSIONS * CONVOY_SLACK);
  const convoyDetail =
    `concurrency does not convoy: slowest ${slowest}ms < ` +
    `${CONCURRENT_SESSIONS} x cold ${cold}ms x ${CONVOY_SLACK} = ${serialEquivalent}ms`;
  if (PERF && timingIsTrustworthy) {
    check(slowest < serialEquivalent, convoyDetail);
  } else {
    console.log(`  note  ${convoyDetail} — advisory, set OIL_PERF=1 to assert`);
  }
  check(
    concurrent.every((r) => r.notes === NOTE_COUNT || r.notes === 0),
    "every concurrent session reports a coherent index",
  );

  // ── Disconnect must be observed, and must be terminal ────────────────────
  //
  // The MCP stdio server transport subscribes to `data` and `error` only, so a
  // client hanging up raises no transport event; and a client's SIGTERM is a
  // TerminateProcess on Windows, which runs no handler. Both were true here
  // once: the server hung on EOF until the client escalated to SIGKILL, and the
  // index save on the way out never ran. Only stdin itself reports the hangup.
  {
    const child = spawn(process.execPath, [entry], {
      cwd: tempRoot,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, OIL_SEMANTIC: "off" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "startup-contract", version: "1.0.0" },
        },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 2000));

    const exited = new Promise((r) => child.on("exit", () => r(true)));
    child.stdin.end();
    const exitedCleanly = await Promise.race([
      exited,
      // Generous, because this asserts that the server exits at all, not how
      // fast. Before stdin was watched it never exited: the client had to
      // escalate to SIGKILL, and until then the process sat holding a watcher
      // over the whole vault.
      new Promise((r) => setTimeout(() => r(false), 20000)),
    ]);
    if (!exitedCleanly) child.kill("SIGKILL");

    check(exitedCleanly, "server exits when the client closes stdin (no hang, no SIGKILL needed)");
    check(
      stderr.includes("Shutting down"),
      "closing stdin runs the shutdown path, so the index is saved on the way out",
    );
  }

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
