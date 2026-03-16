#!/usr/bin/env node

/**
 * OIL CLI — npx entry point.
 *
 * Usage:
 *   npx obsidian-intelligence-layer mcp
 *
 * Environment:
 *   OBSIDIAN_VAULT_PATH — absolute path to the Obsidian vault (required).
 *   Can also be set via a .env file in the current working directory.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
const command = process.argv[2];

if (command === "mcp") {
  await import("./index.js");
} else {
  console.error(
    "Usage: obsidian-intelligence-layer mcp\n\n" +
      "Starts the OIL MCP server over stdio.\n" +
      "Requires OBSIDIAN_VAULT_PATH to be set.",
  );
  process.exit(1);
}
