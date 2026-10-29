// Runs the pinned OIL server inside this process.
//
// `npx` costs every session three extra processes on Windows (cmd → npx-cli →
// cmd → node) and a registry revalidation on each launch. This launcher
// installs each pinned version once into a per-user cache, then imports the
// self-contained `bundle/cli.js` directly, so a session runs one node process.
//
// Usage: node oil-mcp.mjs --package=@mcaps-microsoft/obsidian-intelligence-layer@X.Y.Z <command> [flags]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PIN = /^--package=(@mcaps-microsoft\/obsidian-intelligence-layer@(\d+\.\d+\.\d+))$/;

const args = process.argv.slice(2);
const pinArg = args.find((arg) => arg.startsWith("--package="));
const pin = PIN.exec(pinArg ?? "");
if (!pin) {
  console.error(
    `oil-mcp: expected --package=@mcaps-microsoft/obsidian-intelligence-layer@X.Y.Z, got ${pinArg ?? "nothing"}`,
  );
  process.exit(1);
}
const [, spec, version] = pin;

const cacheRoot =
  process.env.OIL_MCP_CACHE ||
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "oil-mcp")
    : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "oil-mcp"));
const installDir = join(cacheRoot, version);
const cliOf = (root) =>
  join(root, "node_modules", "@mcaps-microsoft", "obsidian-intelligence-layer", "bundle", "cli.js");

if (!existsSync(cliOf(installDir))) install();

const cli = cliOf(installDir);
process.argv = [process.argv[0], cli, ...args.filter((arg) => arg !== pinArg)];
await import(pathToFileURL(cli).href);

function install() {
  // Parallel sessions may race to install the same version: each installs into
  // its own directory and the first rename wins.
  const staging = `${installDir}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), '{ "private": true }\n');

  // stdout is the MCP channel, so npm's output goes to stderr. A shell is how
  // `npm.cmd` runs on Windows; the command needs no quoting because the spec
  // matched PIN above and the install path is the cwd.
  const npm = spawnSync(`npm install --no-audit --no-fund --loglevel=error ${spec}`, {
    cwd: staging,
    stdio: ["ignore", 2, 2],
    shell: true,
  });
  if (npm.status !== 0 || !existsSync(cliOf(staging))) {
    rmSync(staging, { recursive: true, force: true });
    console.error(`oil-mcp: npm install ${spec} failed (exit ${npm.status ?? npm.error?.message})`);
    process.exit(1);
  }

  if (existsSync(installDir) && !existsSync(cliOf(installDir))) {
    rmSync(installDir, { recursive: true, force: true });
  }
  try {
    renameSync(staging, installDir);
  } catch (error) {
    if (!existsSync(cliOf(installDir))) throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
