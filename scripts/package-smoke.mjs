import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureVault = join(repoRoot, "bench", "fixtures", "vault");
const tempRoot = await mkdtemp(join(tmpdir(), "oil-package-smoke-"));
const consumerRoot = join(tempRoot, "consumer");
const smokeVault = join(tempRoot, "vault");

/**
 * Locate npm's JS entry point.
 *
 * Spawning `npm.cmd` directly fails with EINVAL on modern Node for Windows,
 * and `npm_execpath` points at pnpm or yarn when the developer uses one — but
 * only npm implements `pack --pack-destination`. Running npm-cli.js under the
 * current Node avoids both problems.
 */
function resolveNpmCli() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && existsSync(fromEnv)) return fromEnv;

  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundled)) return bundled;

  // Linux and macOS installs usually put node in bin/ with npm one level up.
  const unixish = join(
    dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(unixish)) return unixish;

  throw new Error("Could not locate npm-cli.js; install npm alongside Node to run this check.");
}

const npmCli = resolveNpmCli();

function runNpm(args, cwd) {
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
}

/** Run the packaged CLI and capture its output, without throwing on a non-zero exit. */
function runPackagedCli(cliPath, args, cwd, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

async function withTimeout(promise, label, timeoutMs = 60_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let client;
let transport;
const stderr = [];

try {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  if (!manifest.files?.includes("dist")) {
    throw new Error("Package manifest must include dist in published files");
  }
  if (manifest.bin?.["obsidian-intelligence-layer"] !== "dist/cli.js") {
    throw new Error("Package manifest must map the CLI binary to dist/cli.js");
  }
  if (manifest.scripts?.prepare !== "npm run build") {
    throw new Error("Package manifest must build dist during Git installation");
  }

  await cp(fixtureVault, smokeVault, { recursive: true });
  await writeFile(
    join(tempRoot, "package.json"),
    JSON.stringify({ private: true }),
  );
  runNpm(["pack", repoRoot, "--pack-destination", tempRoot], tempRoot);

  const tarballs = (await readdir(tempRoot)).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(`Expected one package tarball, found ${tarballs.length}`);
  }

  await writeFile(
    join(tempRoot, "package.json"),
    JSON.stringify({ private: true, dependencies: {} }),
  );
  runNpm(
    ["install", join(tempRoot, tarballs[0]), "--prefix", consumerRoot],
    tempRoot,
  );

  const packageRoot = join(
    consumerRoot,
    "node_modules",
    "@jinlee794",
    "obsidian-intelligence-layer",
  );
  await access(join(packageRoot, "dist", "cli.js"));

  const executable = join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32"
      ? "obsidian-intelligence-layer.cmd"
      : "obsidian-intelligence-layer",
  );
  await access(executable);

  const packagedCli = join(packageRoot, "dist", "cli.js");

  // ── The optional semantic component, as a consumer would meet it ──────────
  //
  // Ollama is not an npm dependency and may be absent on any machine that
  // installs this package, so the contract is that its absence is reportable
  // and never fatal. Both halves are checked against the packed artifact, not
  // the working tree.
  const doctor = runPackagedCli(packagedCli, ["doctor", `--vault=${smokeVault}`], consumerRoot);
  if (!/semantic settings/i.test(doctor.output)) {
    throw new Error(`Packaged doctor did not report effective settings:\n${doctor.output}`);
  }

  const optedOut = runPackagedCli(
    packagedCli,
    ["doctor", `--vault=${smokeVault}`, "--no-semantic"],
    consumerRoot,
  );
  if (optedOut.status !== 0) {
    throw new Error(
      `Packaged doctor must succeed with the semantic tier off, got exit ${optedOut.status}:\n${optedOut.output}`,
    );
  }
  if (!/enabled\s+false/.test(optedOut.output)) {
    throw new Error(`--no-semantic did not disable the tier:\n${optedOut.output}`);
  }

  /** Connect to the packaged server with a given environment and assert it serves. */
  async function connectAndProbe(label, extraEnv) {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [packagedCli, "mcp"],
      cwd: consumerRoot,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: smokeVault, ...extraEnv },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      stderr.push(chunk.toString());
      process.stderr.write(chunk);
    });
    transport.onerror = (error) => {
      console.error(`Packaged server transport error (${label}):`, error);
    };

    client = new Client({ name: "oil-package-smoke", version: "1.0.0" });
    await withTimeout(client.connect(transport), `MCP initialization (${label})`);
    const { tools } = await withTimeout(client.listTools(), `MCP tools/list (${label})`);
    if (!tools.some((tool) => tool.name === "get_health")) {
      throw new Error(`Packaged server did not expose get_health (${label})`);
    }

    const health = JSON.parse(
      (await withTimeout(client.callTool({ name: "get_health", arguments: {} }), `get_health (${label})`))
        .content[0].text,
    );

    // Search must work regardless of the optional tier — that is the point of
    // it being optional, and the backwards-compatibility guarantee.
    const search = JSON.parse(
      (
        await withTimeout(
          client.callTool({ name: "search_vault", arguments: { query: "Contoso", limit: 3 } }),
          `search_vault (${label})`,
        )
      ).content[0].text,
    );
    if (!Array.isArray(search.results) || search.results.length === 0) {
      throw new Error(`Packaged server returned no search results (${label})`);
    }

    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    client = undefined;
    transport = undefined;
    return { tools, health };
  }

  // A consumer turning the tier off from their MCP client config.
  const off = await connectAndProbe("semantic off", { OIL_SEMANTIC: "off" });
  if (off.health.semantic?.status !== "disabled") {
    throw new Error(
      `OIL_SEMANTIC=off did not reach the packaged server: semantic.status=${off.health.semantic?.status}`,
    );
  }

  // The case every existing install hits: the tier is on by default and Ollama
  // is simply not there. The server must still start and still answer.
  const noOllama = await connectAndProbe("semantic on, no Ollama", {
    OIL_SEMANTIC: "on",
    OIL_SEMANTIC_ENDPOINT: "http://127.0.0.1:1",
  });
  if (noOllama.health.semantic?.status === "ready") {
    throw new Error("Semantic tier reported ready against an unreachable endpoint");
  }

  console.log(
    `Package smoke test passed: installed CLI completed MCP initialization, exposed ${off.tools.length} tools, ` +
      "and served search both with the semantic tier disabled and with it enabled but Ollama absent.",
  );
} catch (error) {
  if (stderr?.length) {
    console.error("Packaged server stderr:\n" + stderr.join(""));
  }
  throw error;
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (process.env.OIL_KEEP_SMOKE_TEMP) {
    console.error(`Preserved package smoke directory: ${tempRoot}`);
  } else {
    await rm(tempRoot, { recursive: true, force: true });
  }
}