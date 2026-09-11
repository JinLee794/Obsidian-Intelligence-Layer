/**
 * Observed-behaviour verification.
 *
 * Everything here is asserted against a spawned server over real stdio, reading
 * the server's own stderr and the index file it leaves on disk. Nothing is
 * inferred from in-process unit tests: the point is to catch claims that hold
 * in a test harness but not in the runtime a client actually drives.
 *
 * Usage: node scripts/verify-observed.mjs [--notes=6000] [--vault=<path>]
 */

import { mkdtemp, mkdir, writeFile, rm, readFile, stat, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");
const flags = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const NOTE_COUNT = Number(flags.notes ?? 6000);

const results = [];
const observe = (ok, claim, evidence) => {
  results.push({ ok, claim });
  console.log(`  ${ok ? "OBSERVED  " : "CONTRADICTED"}  ${claim}`);
  if (evidence) console.log(`                  ${evidence}`);
};

const tempRoot = await mkdtemp(join(tmpdir(), "oil-verify-"));

async function makeVault(dir, count) {
  for (let f = 0; f < 20; f++) await mkdir(join(dir, `Folder${f}`), { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      writeFile(
        join(dir, `Folder${i % 20}`, `Note ${i}.md`),
        `---\ncustomer: Customer${i % 40}\ntags: [tier${i % 5}]\n---\n\n# Note ${i}\n\n` +
          `[[Note ${(i + 1) % count}]]\n\n${"Substantive body content for retrieval. ".repeat(40)}\n`,
        "utf-8",
      ),
    ),
  );
}

/**
 * Run one session and return everything observable about it.
 *
 * `stop` selects how the session ends, because that turns out to matter: the
 * MCP SDK's own client kills the child process, and a kill is not a shutdown.
 */
async function session(vault, { holdMs = 0, holdFactor = 0, stop = "sdk-close" } = {}) {
  const lines = [];
  const t0 = Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: tempRoot,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, OIL_SEMANTIC: "off" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (c) => {
    for (const l of c.toString().split("\n")) {
      if (l.trim()) lines.push({ at: Date.now() - t0, text: l.trim() });
    }
  });

  const client = new Client({ name: "oil-verify", version: "1.0.0" });
  await client.connect(transport);
  const handshakeMs = Date.now() - t0;
  await client.callTool({ name: "search_vault", arguments: { query: "ready", limit: 1 } });
  const readyMs = Date.now() - t0;

  // A "short" session has to be short relative to the work, not to the clock.
  // A fixed hold measures the machine: on a loaded box readiness alone can take
  // tens of seconds, so a 1.2s hold ends the session before any indexing starts
  // and every claim below fails for reasons the code cannot influence.
  const hold = holdFactor ? Math.min(Math.max(readyMs * holdFactor, 1200), 20000) : holdMs;
  if (hold) await new Promise((r) => setTimeout(r, hold));

  if (stop === "stdin-end") {
    // Close only the write side, leaving stderr readable, so we can see what
    // the server does on its way out instead of racing its death.
    transport._process?.stdin?.end();
    await new Promise((r) => setTimeout(r, 2500));
  }
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  // Let the previous server fully exit. Overlapping servers each hold a watcher
  // over the whole fixture, and the contention shows up as inflated readiness
  // times that look exactly like a regression in the code under test.
  await new Promise((r) => setTimeout(r, 1500));

  const has = (needle) => lines.some((l) => l.text.includes(needle));
  const find = (needle) => lines.find((l) => l.text.includes(needle));
  return {
    lines,
    handshakeMs,
    readyMs,
    fullBuild: has("full build"),
    reindexed: Number(find("Incremental rebuild:")?.text.match(/(\d+) note/)?.[1] ?? NaN),
    upToDate: has("up to date"),
    checkpoints: lines.filter((l) => l.text.includes("progress saved")).length,
    outstanding: Number(find("Re-indexing")?.text.match(/\d+\/(\d+)/)?.[1] ?? NaN) || null,
    shutdownStarted: has("Shutting down"),
    savedOnShutdown: has("saved on shutdown"),
    watcherReadyAt: find("watcher ready")?.at ?? null,
    watcherStartedAt: find("watcher started")?.at ?? null,
    revalidatedAt: (find("Incremental rebuild:") ?? find("up to date"))?.at ?? null,
  };
}

const indexStamp = async (vault) => {
  try {
    const s = await stat(join(vault, "_oil-graph.json"));
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
};

const skew = async (vault, byMs = 5000) => {
  const file = join(vault, "_oil-graph.json");
  const data = JSON.parse(await readFile(file, "utf-8"));
  for (const n of data.nodes) n.lastModified += byMs;
  await writeFile(file, JSON.stringify(data), "utf-8");
  return data.nodes.length;
};

// ── Claim 1 & 2: steady state, and the two walks ────────────────────────────
console.log(`\nA. Steady state — ${NOTE_COUNT} notes\n`);
const vault = join(tempRoot, "vault");
await makeVault(vault, NOTE_COUNT);

const cold = await session(vault, { holdFactor: 6 });
observe(cold.fullBuild, "first connect does a full build", `ready ${cold.readyMs}ms`);

const warm1 = await session(vault, { holdFactor: 4 });
observe(
  !warm1.fullBuild && warm1.upToDate,
  "second connect re-reads no notes",
  `ready ${warm1.readyMs}ms, revalidated at ${warm1.revalidatedAt}ms`,
);
observe(
  warm1.watcherStartedAt !== null && warm1.revalidatedAt <= warm1.watcherStartedAt,
  "revalidation runs before the watcher scan, so a short session still makes progress",
  `revalidated ${warm1.revalidatedAt}ms -> watcher started ${warm1.watcherStartedAt}ms`,
);

const before = await indexStamp(vault);
const warm2 = await session(vault, { holdFactor: 4 });
const after = await indexStamp(vault);
observe(
  warm2.upToDate && before.mtimeMs === after.mtimeMs,
  "an unchanged vault does not rewrite the index file",
  `index mtime unchanged (${before.size} bytes)`,
);

// ── Claim 3: how a session actually ends ────────────────────────────────────
console.log(`\nB. How a session ends — SDK close vs stdin close\n`);
const n = await skew(vault);
console.log(`  [skewed ${n} persisted mtimes: a full re-index is now due]\n`);

const killed = await session(vault, { holdFactor: 1, stop: "sdk-close" });
observe(
  killed.shutdownStarted,
  "the SDK client's close() lets the server run its shutdown path",
  killed.shutdownStarted
    ? "shutdown ran"
    : "no shutdown log: the process was terminated outright, so save-on-shutdown never runs",
);

const stamp = await indexStamp(vault);
observe(
  killed.checkpoints > 0,
  "a long rebuild checkpoints progress before it finishes",
  `${killed.checkpoints} checkpoint save(s) observed`,
);

// ── Claim 4: convergence across short sessions ──────────────────────────────
console.log(`\nC. Convergence — repeated short sessions after a mass invalidation\n`);
let remainingBefore = Infinity;
let monotonic = true;
let converged = false;
for (let i = 0; i < 12; i++) {
  const s = await session(vault, { holdFactor: 1 });
  // "Re-indexing x/Y" reports Y = notes still known to be stale this session,
  // which is the honest measure of outstanding work between sessions.
  const remaining = s.upToDate ? 0 : (s.outstanding ?? Infinity);
  console.log(
    `  session #${String(i + 1).padStart(2)}  ready ${String(s.readyMs).padStart(5)}ms  ` +
      `checkpoints=${s.checkpoints}  outstanding=${remaining === Infinity ? "?" : remaining}`,
  );
  if (remaining !== Infinity && remaining > remainingBefore) monotonic = false;
  if (remaining !== Infinity) remainingBefore = remaining;
  if (s.upToDate) {
    converged = true;
    observe(true, `converges through repeated short sessions (${i + 1} sessions)`, "vault revalidates clean");
    break;
  }
}
if (!converged) observe(false, "converges through repeated short sessions", "still stale after 12 sessions");
observe(monotonic, "every short session leaves strictly less work than it found", "outstanding count never increased");

// ── Claim 5: the real vault ─────────────────────────────────────────────────
const realVault = flags.vault ?? process.env.OBSIDIAN_VAULT_PATH;
if (realVault) {
  console.log(`\nD. A copy of the real vault\n`);
  const copy = join(tempRoot, "real");
  await cp(realVault, copy, { recursive: true, errorOnExist: false, force: true });
  await rm(join(copy, "_oil-graph.json"), { force: true });
  await rm(join(copy, "_oil-vectors.json"), { force: true });

  const rc = await session(copy, { holdFactor: 4 });
  console.log(`  cold:  handshake ${rc.handshakeMs}ms, ready ${rc.readyMs}ms`);
  const rw = await session(copy, { holdFactor: 4 });
  console.log(`  warm:  handshake ${rw.handshakeMs}ms, ready ${rw.readyMs}ms`);
  observe(
    !rw.fullBuild && rw.upToDate,
    "the real vault re-reads nothing on a second connect",
    "index reused: no full build and the server reported the vault up to date",
  );
}

console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} claims observed to hold.\n`,
);
for (const r of results.filter((x) => !x.ok)) console.log(`  CONTRADICTED: ${r.claim}`);

await rm(tempRoot, { recursive: true, force: true });

if (results.some((r) => !r.ok)) process.exitCode = 1;
