/**
 * What a consumer actually experiences after installing the package.
 *
 * The smoke test proves the server initializes. This checks the human-facing
 * surface: that `doctor` explains the setup, that search still answers with no
 * Ollama, and that a query needing meaning says so instead of failing silently.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureVault = join(repoRoot, "bench", "fixtures", "vault");

function resolveNpmCli() {
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundled)) return bundled;
  const unixish = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(unixish)) return unixish;
  throw new Error("npm-cli.js not found");
}
const npmCli = resolveNpmCli();
const runNpm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, env: process.env, stdio: "pipe" });

const tempRoot = await mkdtemp(join(tmpdir(), "oil-consumer-"));
const consumer = join(tempRoot, "consumer");
const vault = join(tempRoot, "vault");
await cp(fixtureVault, vault, { recursive: true });
await rm(join(vault, "_oil-vectors.json"), { force: true });
await rm(join(vault, "_oil-graph.json"), { force: true });
await writeFile(join(tempRoot, "package.json"), JSON.stringify({ private: true }));

console.log("Packing and installing as a consumer would...");
runNpm(["pack", repoRoot, "--pack-destination", tempRoot], tempRoot);
const tarball = (await readdir(tempRoot)).find((f) => f.endsWith(".tgz"));
runNpm(["install", join(tempRoot, tarball), "--prefix", consumer], tempRoot);

const cli = join(consumer, "node_modules", "@jinlee794", "obsidian-intelligence-layer", "dist", "cli.js");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("\n── What `doctor` tells a new user ──────────────────────────────\n");
const doctor = spawnSync(process.execPath, [cli, "doctor", `--vault=${vault}`], {
  encoding: "utf8",
  env: { ...process.env, OIL_SEMANTIC_ENDPOINT: "http://127.0.0.1:1" },
});
console.log(doctor.stdout.split("\n").map((l) => `    ${l}`).join("\n"));

check("doctor names the vault", doctor.stdout.includes(vault));
check("doctor reports Ollama unreachable", /ollama/i.test(doctor.stdout));
check("doctor suggests what to do", /install ollama|OIL_SEMANTIC=off/i.test(doctor.stdout));
check("doctor shows effective settings", doctor.stdout.includes("effective semantic settings"));

console.log("\n── What the agent sees with no Ollama ──────────────────────────\n");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "mcp"],
  cwd: consumer,
  env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, OIL_SEMANTIC_ENDPOINT: "http://127.0.0.1:1" },
  stderr: "pipe",
});
const client = new Client({ name: "oil-consumer-ux", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const health = await call("get_health", {});
check(
  "get_health explains the tier state",
  health.semantic.status !== "ready" && Boolean(health.semantic.reason),
  JSON.stringify(health.semantic),
);

const keyword = await call("search_vault", { query: "Contoso", limit: 3 });
check("keyword search still works", keyword.results.length > 0);
check("no nagging on a query that worked", keyword.semantic_status === undefined);

const conceptual = await call("search_vault", {
  query: "which relationship looks like it is going badly",
  limit: 5,
});
check("a conceptual query explains the missing tier", Boolean(conceptual.semantic_status));
if (conceptual.semantic_status) console.log(`\n    "${conceptual.semantic_status}"`);

await client.close().catch(() => {});
await transport.close().catch(() => {});
await rm(tempRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
