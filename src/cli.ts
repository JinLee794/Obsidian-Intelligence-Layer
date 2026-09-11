#!/usr/bin/env node

/**
 * OIL CLI — npx entry point.
 *
 * Usage:
 *   npx obsidian-intelligence-layer mcp [flags]
 *   npx obsidian-intelligence-layer doctor
 *
 * Environment:
 *   OBSIDIAN_VAULT_PATH — absolute path to the Obsidian vault (required).
 *   Can also be set via a .env file in the current working directory.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { recordFlagOrigin } from "./config.js";

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

const USAGE = `Usage: obsidian-intelligence-layer <command> [flags]

Commands:
  mcp                       Start the MCP server over stdio.
  doctor                    Check vault, Ollama and effective settings, then exit.
                            Exits 0 if everything checks out, 1 if a check
                            failed, 2 if a check could not be confirmed.

Flags (equivalent env vars in parentheses):
  --vault=<path>            Vault to serve (OBSIDIAN_VAULT_PATH)
  --no-semantic             Disable the semantic tier (OIL_SEMANTIC=off)
  --semantic-model=<name>   Embedding model (OIL_SEMANTIC_MODEL)
  --semantic-endpoint=<url> Ollama base URL (OIL_SEMANTIC_ENDPOINT)
  --semantic-min-score=<n>  Cosine floor for a hit (OIL_SEMANTIC_MIN_SCORE)

Flags win over the environment, which wins over oil.config.yaml in the vault.`;

/**
 * Translate flags into the environment the server already reads, so an MCP
 * client can drive every setting from either `args` or `env` — whichever its
 * config format makes easier.
 *
 * Each translation is recorded, because the translation is lossy in the one
 * place it matters: once a flag has become an environment variable, the server
 * can no longer tell a user who passed `--no-semantic` why the tier is off
 * without being told which layer really set it.
 */
function applyFlags(argv: string[]): string | null {
  const setEnv = (name: string, value: string) => {
    process.env[name] = value;
    recordFlagOrigin(name);
  };

  for (const arg of argv) {
    if (arg === "--no-semantic") {
      setEnv("OIL_SEMANTIC", "off");
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) return arg;

    const [, name, value] = match;
    switch (name) {
      case "vault":
        setEnv("OBSIDIAN_VAULT_PATH", resolve(value));
        break;
      case "semantic-model":
        setEnv("OIL_SEMANTIC_MODEL", value);
        break;
      case "semantic-endpoint":
        setEnv("OIL_SEMANTIC_ENDPOINT", value);
        break;
      case "semantic-min-score":
        setEnv("OIL_SEMANTIC_MIN_SCORE", value);
        break;
      default:
        return arg;
    }
  }
  return null;
}

// ── Route subcommand ───────────────────────────────────────────────
const [command, ...flags] = process.argv.slice(2);
const unknown = applyFlags(flags);

if (unknown) {
  console.error(`Unknown option: ${unknown}\n\n${USAGE}`);
  process.exit(1);
} else if (command === "mcp") {
  await import("./index.js");
} else if (command === "doctor") {
  const { runDoctor } = await import("./doctor.js");
  process.exit(await runDoctor());
} else {
  console.error(USAGE);
  process.exit(1);
}
