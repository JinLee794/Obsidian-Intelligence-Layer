import { execFileSync } from "node:child_process";
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
const npmCli = process.env.npm_execpath;
const tempRoot = await mkdtemp(join(tmpdir(), "oil-package-smoke-"));
const consumerRoot = join(tempRoot, "consumer");
const smokeVault = join(tempRoot, "vault");

function runNpm(args, cwd) {
  if (!npmCli) {
    throw new Error("npm_execpath is required; run this check through npm");
  }
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
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

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, "dist", "cli.js"), "mcp"],
    cwd: consumerRoot,
    env: {
      ...process.env,
      OBSIDIAN_VAULT_PATH: smokeVault,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr.push(chunk.toString());
    process.stderr.write(chunk);
  });
  transport.onerror = (error) => {
    console.error("Packaged server transport error:", error);
  };

  client = new Client({ name: "oil-package-smoke", version: "1.0.0" });
  await withTimeout(client.connect(transport), "MCP initialization");
  const { tools } = await withTimeout(client.listTools(), "MCP tools/list");
  if (!tools.some((tool) => tool.name === "get_health")) {
    throw new Error("Packaged server did not expose the get_health tool");
  }

  console.log(
    `Package smoke test passed: installed CLI completed MCP initialization and exposed ${tools.length} tools.`,
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