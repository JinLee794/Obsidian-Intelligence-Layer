#!/usr/bin/env node

/**
 * OIL CLI — npx entry point.
 *
 * Usage:
 *   oil setup
 *   oil mcp
 *
 * Environment:
 *   OBSIDIAN_VAULT_PATH — optional explicit path to the Obsidian vault.
 *   Can also be set via a .env file in the current working directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { basename, join, resolve } from "node:path";
import {
  discoverObsidianVaults,
  getOilUserConfigPath,
  loadOilUserConfig,
  pickVaultDirectory,
  resolveVaultPath,
  saveVaultProfile,
  validateVaultDirectory,
  type DiscoveredVault,
} from "./vault-path.js";

// ── Load .env from cwd (simple key=value, no dotenv dependency) ────
const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  const lines = readFileSync(envFile, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ── Route subcommand ───────────────────────────────────────────────
const [command = "help", ...args] = process.argv.slice(2);

try {
  if (command === "mcp") {
    const vault = optionValue(args, "--vault");
    const profile = optionValue(args, "--profile");
    if (vault && profile) throw new Error("Use either --vault or --profile, not both.");
    if (vault) process.env.OBSIDIAN_VAULT_PATH = vault;
    if (profile) {
      process.env.OIL_VAULT_PROFILE = profile;
      delete process.env.OBSIDIAN_VAULT_PATH;
    }
    await import("./index.js");
  } else if (command === "setup") {
    await runSetup(args);
  } else if (command === "list-vaults") {
    await runListVaults();
  } else if (command === "doctor") {
    await runDoctor(args);
  } else if (command === "init") {
    await runInit(args);
  } else if (["help", "--help", "-h"].includes(command)) {
    printHelp();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function runSetup(args: string[]): Promise<void> {
  const requestedPath = optionValue(args, "--vault");
  const profile = optionValue(args, "--profile") ?? "default";
  const forceBrowse = args.includes("--browse");
  if (requestedPath && forceBrowse) throw new Error("Use either --vault or --browse, not both.");

  let selectedPath = requestedPath;
  if (!selectedPath && forceBrowse) selectedPath = pickVaultDirectory() ?? undefined;
  if (!selectedPath && !forceBrowse) {
    const discovered = (await discoverObsidianVaults()).filter((vault) => vault.valid);
    selectedPath = await selectDiscoveredVault(discovered);
  }
  if (!selectedPath && !forceBrowse) {
    selectedPath = pickVaultDirectory() ?? undefined;
  }
  if (!selectedPath && stdin.isTTY) {
    selectedPath = await promptText("Enter the absolute path to your Obsidian vault: ");
  }
  if (!selectedPath) {
    throw new Error("No vault was selected. Retry with setup --vault /absolute/path/to/vault.");
  }

  const saved = await saveVaultProfile(profile, selectedPath, { setDefault: true });
  console.log(`Configured OIL profile '${profile}' for ${saved.validation.path}`);
  console.log(`Saved user configuration: ${saved.configPath}`);
  for (const warning of saved.validation.warnings) console.log(`Warning: ${warning}`);
  console.log("Run 'oil doctor' to verify the configuration.");
}

async function runListVaults(): Promise<void> {
  const configPath = getOilUserConfigPath();
  const [config, discovered] = await Promise.all([
    loadOilUserConfig(configPath),
    discoverObsidianVaults(),
  ]);

  console.log(`OIL profiles (${configPath})`);
  const profileEntries = Object.entries(config.profiles);
  if (profileEntries.length === 0) console.log("  (none)");
  for (const [name, profile] of profileEntries) {
    const marker = config.defaultProfile === name ? "*" : " ";
    const validation = await validateVaultDirectory(profile.path);
    console.log(` ${marker} ${name}: ${profile.path} [${validation.valid ? "ready" : "invalid"}]`);
  }

  console.log("\nObsidian registry");
  if (discovered.length === 0) console.log("  (no local registry entries found)");
  for (const vault of discovered) {
    console.log(` ${vault.registryOpen ? "*" : " "} ${vault.name}: ${vault.path} [${vault.valid ? "ready" : "invalid"}]`);
    for (const error of vault.errors) console.log(`     - ${error}`);
  }
}

async function runDoctor(args: string[]): Promise<void> {
  const explicitPath = optionValue(args, "--vault");
  const profileName = optionValue(args, "--profile") ?? process.env.OIL_VAULT_PROFILE;
  const resolved = await resolveVaultPath({
    explicitPath,
    envPath: explicitPath || profileName ? undefined : process.env.OBSIDIAN_VAULT_PATH,
    profileName,
  });
  const validation = await validateVaultDirectory(resolved.path, { countNotes: true });
  console.log("OIL vault diagnostic");
  console.log(`  Path: ${validation.path}`);
  console.log(`  Source: ${resolved.source}${resolved.profile ? ` (${resolved.profile})` : ""}`);
  console.log(`  Readable: ${validation.readable ? "yes" : "no"}`);
  console.log(`  Obsidian metadata: ${validation.hasObsidianConfig ? "found" : "not found"}`);
  console.log(`  OIL config: ${validation.hasOilConfig ? "found" : "defaults"}`);
  console.log(`  Supported notes: ${validation.noteCount ?? 0}`);
  for (const warning of validation.warnings) console.log(`  Warning: ${warning}`);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  console.log("  Result: ready");
}

async function runInit(args: string[]): Promise<void> {
  const targetArgument = positionalArguments(args)[0];
  if (!targetArgument) throw new Error("init requires a target directory.");
  const target = resolve(targetArgument);
  const profile = optionValue(args, "--profile") ?? "default";
  const confirmed = args.includes("--yes") || await confirmInit(target);
  if (!confirmed) {
    console.log("Cancelled. No files were created.");
    return;
  }

  await mkdir(target, { recursive: true });
  for (const folder of ["Customers", "People", "Meetings", "Projects", "Weekly", "Templates"]) {
    await mkdir(join(target, folder), { recursive: true });
  }
  const oilConfig = join(target, "oil.config.yaml");
  if (!existsSync(oilConfig)) {
    await writeFile(
      oilConfig,
      "# OIL vault configuration. Omit settings to use the documented defaults.\nschema: {}\n",
      "utf-8",
    );
  }
  const saved = await saveVaultProfile(profile, target, { setDefault: true });
  console.log(`Created an OIL-ready vault directory at ${saved.validation.path}`);
  console.log(`Configured profile '${profile}' as the default.`);
  console.log("Open this folder in Obsidian to let Obsidian create its own .obsidian settings.");
}

async function selectDiscoveredVault(vaults: DiscoveredVault[]): Promise<string | undefined> {
  if (vaults.length === 0) return undefined;
  if (!stdin.isTTY) return vaults.length === 1 ? vaults[0].path : undefined;
  if (vaults.length === 1) {
    const accepted = await promptYesNo(`Use detected Obsidian vault '${vaults[0].name}' (${vaults[0].path})?`, true);
    return accepted ? vaults[0].path : undefined;
  }

  console.log("Detected Obsidian vaults:");
  vaults.forEach((vault, index) => {
    console.log(`  ${index + 1}. ${vault.name} — ${vault.path}${vault.registryOpen ? " (currently open)" : ""}`);
  });
  console.log("  b. Browse for another folder");
  const answer = (await promptText("Choose a vault: ")).toLowerCase();
  if (answer === "b" || answer === "browse") return undefined;
  const selected = Number.parseInt(answer, 10);
  if (!Number.isInteger(selected) || selected < 1 || selected > vaults.length) {
    throw new Error("Invalid vault selection.");
  }
  return vaults[selected - 1].path;
}

async function confirmInit(target: string): Promise<boolean> {
  if (!stdin.isTTY) {
    throw new Error("Non-interactive init requires --yes.");
  }
  let context = "a new directory";
  try {
    const entries = await readdir(target);
    context = entries.length === 0 ? "an empty directory" : `an existing directory containing ${entries.length} item(s)`;
    const targetStats = await stat(target);
    if (!targetStats.isDirectory()) throw new Error("Target exists and is not a directory.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
  }
  return promptYesNo(`Initialize ${context} at ${target}?`, false);
}

async function promptYesNo(message: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const answer = (await promptText(`${message}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

async function promptText(message: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(message)).trim();
  } finally {
    readline.close();
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function positionalArguments(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--vault", "--profile"].includes(arg)) {
      index++;
      continue;
    }
    if (!arg.startsWith("--")) positionals.push(arg);
  }
  return positionals;
}

function printHelp(): void {
  console.log(
    "Obsidian Intelligence Layer (OIL)\n\n" +
      "Usage:\n" +
      "  oil setup [--vault PATH | --browse] [--profile NAME]\n" +
      "  oil list-vaults\n" +
      "  oil doctor [--vault PATH | --profile NAME]\n" +
      "  oil init PATH [--profile NAME] [--yes]\n" +
      "  oil mcp [--vault PATH | --profile NAME]\n\n" +
      "Run setup once to discover or select a vault. MCP startup remains non-interactive.\n" +
      `Default user configuration: ${getOilUserConfigPath()}\n` +
      `Current directory: ${basename(process.cwd())}`,
  );
}
