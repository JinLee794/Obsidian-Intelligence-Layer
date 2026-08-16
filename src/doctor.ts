/**
 * OIL — setup diagnostics.
 *
 * The semantic tier depends on Ollama, which cannot be bundled into an npm
 * package: it is a native application, and a postinstall step that fetched one
 * would break `npx --package=github:...` installs outright. So the tier is
 * optional at runtime, and this command exists to answer the question that
 * optionality creates — "is it actually on, and if not, why?" — without making
 * the user read server logs through an MCP client.
 */

import { stat } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { describeError } from "./semantic.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import type { SemanticConfig } from "./types.js";

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  /** What to do about it, when it is not ok. */
  remedy?: string;
}

function render(checks: Check[]): void {
  for (const check of checks) {
    console.log(`  ${check.ok ? "ok  " : "FAIL"}  ${check.label}: ${check.detail}`);
    if (!check.ok && check.remedy) console.log(`        → ${check.remedy}`);
  }
}

async function checkVault(vaultPath: string | undefined): Promise<Check> {
  if (!vaultPath) {
    return {
      label: "vault",
      ok: false,
      detail: "OBSIDIAN_VAULT_PATH is not set",
      remedy: 'Set it in the "env" block of your MCP client config, or pass --vault=<path>.',
    };
  }
  try {
    const info = await stat(vaultPath);
    if (!info.isDirectory()) {
      return { label: "vault", ok: false, detail: `${vaultPath} is not a directory` };
    }
    return { label: "vault", ok: true, detail: vaultPath };
  } catch {
    return {
      label: "vault",
      ok: false,
      detail: `${vaultPath} does not exist`,
      remedy: "Point OBSIDIAN_VAULT_PATH at the folder containing your notes.",
    };
  }
}

async function checkOllama(semantic: SemanticConfig): Promise<Check[]> {
  if (!semantic.enabled) {
    return [
      {
        label: "semantic tier",
        ok: true,
        detail: "disabled by configuration — search runs on the lexical tiers",
      },
    ];
  }

  const endpoint = semantic.endpoint.replace(/\/+$/, "");
  let models: string[];
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    models = (data.models ?? []).map((m) => m.name);
  } catch (err) {
    return [
      {
        label: "ollama",
        ok: false,
        detail: `not reachable at ${endpoint} (${describeError(err)})`,
        remedy:
          "Install Ollama from https://ollama.com and make sure it is running, " +
          "or set OIL_SEMANTIC=off to silence this. Search still works without it.",
      },
    ];
  }

  const checks: Check[] = [
    { label: "ollama", ok: true, detail: `reachable at ${endpoint}` },
  ];

  // Ollama reports tags as `name:tag`; an untagged model means `:latest`.
  const wanted = semantic.model.includes(":") ? semantic.model : `${semantic.model}:latest`;
  const present = models.some((name) => name === wanted || name === semantic.model);

  checks.push(
    present
      ? { label: "model", ok: true, detail: `${semantic.model} is installed` }
      : {
          label: "model",
          ok: true,
          detail: `${semantic.model} is not installed yet — it will be pulled on first use`,
          remedy: `Pull it now to avoid a delay later: ollama pull ${semantic.model}`,
        },
  );

  return checks;
}

export async function runDoctor(): Promise<number> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;

  console.log(`\n${SERVER_NAME} ${SERVER_VERSION} — setup check\n`);

  const vaultCheck = await checkVault(vaultPath);
  render([vaultCheck]);
  if (!vaultCheck.ok) {
    console.log("\nCannot check further without a vault.\n");
    return 1;
  }

  const config = await loadConfig(vaultPath as string);
  const ollamaChecks = await checkOllama(config.semantic);
  render(ollamaChecks);

  console.log("\n  effective semantic settings");
  console.log(`    enabled   ${config.semantic.enabled}`);
  console.log(`    endpoint  ${config.semantic.endpoint}`);
  console.log(`    model     ${config.semantic.model}`);
  console.log(`    minScore  ${config.semantic.minScore}`);
  console.log(`    index     ${config.semantic.indexFile} (in the vault root)`);

  const failed = [vaultCheck, ...ollamaChecks].filter((c) => !c.ok);
  console.log(
    failed.length === 0
      ? "\nAll checks passed.\n"
      : `\n${failed.length} check(s) need attention. Search still works without the semantic tier.\n`,
  );
  return failed.length === 0 ? 0 : 1;
}
