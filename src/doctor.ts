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
import { describeConfigSource, loadConfig } from "./config.js";
import { describeError } from "./semantic.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import type { ConfigSource, SemanticConfig } from "./types.js";

/**
 * `ok` and `FAIL` are verdicts: this check looked, and it knows. `warn` is the
 * absence of a verdict — the check found something that may or may not be a
 * problem and cannot tell which from here. Collapsing that third case into `ok`
 * is what let a missing model be reported as a passed check.
 */
type CheckStatus = "ok" | "warn" | "fail";

interface Check {
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when it is not ok. */
  remedy?: string;
}

const BADGE: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

function render(checks: Check[]): void {
  for (const check of checks) {
    console.log(`  ${BADGE[check.status]}  ${check.label}: ${check.detail}`);
    if (check.status !== "ok" && check.remedy) console.log(`        → ${check.remedy}`);
  }
}

async function checkVault(vaultPath: string | undefined): Promise<Check> {
  if (!vaultPath) {
    return {
      label: "vault",
      status: "fail",
      detail: "OBSIDIAN_VAULT_PATH is not set",
      remedy: 'Set it in the "env" block of your MCP client config, or pass --vault=<path>.',
    };
  }
  try {
    const info = await stat(vaultPath);
    if (!info.isDirectory()) {
      return { label: "vault", status: "fail", detail: `${vaultPath} is not a directory` };
    }
    return { label: "vault", status: "ok", detail: vaultPath };
  } catch {
    return {
      label: "vault",
      status: "fail",
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
        status: "ok",
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
        status: "fail",
        detail: `not reachable at ${endpoint} (${describeError(err)})`,
        remedy:
          "Install Ollama from https://ollama.com and make sure it is running, " +
          "or set OIL_SEMANTIC=off to silence this. Search still works without it.",
      },
    ];
  }

  const checks: Check[] = [
    { label: "ollama", status: "ok", detail: `reachable at ${endpoint}` },
  ];

  // Ollama reports tags as `name:tag`; an untagged model means `:latest`.
  const wanted = semantic.model.includes(":") ? semantic.model : `${semantic.model}:latest`;
  const present = models.some((name) => name === wanted || name === semantic.model);

  // A model that is absent is pulled on first use — but only if the name exists
  // in the registry and the machine can reach it. Otherwise the pull returns
  // HTTP 500 and the tier stays unavailable for the life of the process. From
  // the tag list alone there is no way to tell those two futures apart, so this
  // check reports what it knows (the model is not here) and declines to
  // predict what it does not (whether that will matter).
  checks.push(
    present
      ? { label: "model", status: "ok", detail: `${semantic.model} is installed` }
      : {
          label: "model",
          status: "warn",
          detail:
            `${semantic.model} is not installed — unverified. OIL pulls it on first use, ` +
            "which fails if the name is wrong or this machine is offline.",
          remedy: `Pull it now to settle it either way: ollama pull ${semantic.model}`,
        },
  );

  return checks;
}

export async function runDoctor(): Promise<number> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;

  console.log(`\n${SERVER_NAME} ${SERVER_VERSION} — setup check\n`);

  const vaultCheck = await checkVault(vaultPath);
  render([vaultCheck]);
  if (vaultCheck.status === "fail") {
    console.log("\nCannot check further without a vault.\n");
    return 1;
  }

  const config = await loadConfig(vaultPath as string);
  const ollamaChecks = await checkOllama(config.semantic);
  render(ollamaChecks);

  // Naming the layer each value came from is the difference between "this is
  // the setting" and "this is why the setting is what it is" — the second is
  // the question someone runs `doctor` to answer.
  const from = (source: ConfigSource) => `(from ${describeConfigSource(source)})`;
  const sources = config.provenance.semantic;
  console.log("\n  effective semantic settings");
  console.log(`    enabled   ${config.semantic.enabled} ${from(sources.enabled)}`);
  console.log(`    endpoint  ${config.semantic.endpoint} ${from(sources.endpoint)}`);
  console.log(`    model     ${config.semantic.model} ${from(sources.model)}`);
  console.log(`    minScore  ${config.semantic.minScore} ${from(sources.minScore)}`);
  console.log(`    index     ${config.semantic.indexFile} (in the vault root)`);

  const all = [vaultCheck, ...ollamaChecks];
  const failed = all.filter((c) => c.status === "fail");
  const warned = all.filter((c) => c.status === "warn");

  // A warning is not a pass, so it must not be reported as one — that is the
  // whole defect. It is not a failure either, so it gets its own exit code:
  // callers gating on "is anything unresolved" check for non-zero, and callers
  // that only care about hard breakage check for 1.
  if (failed.length > 0) {
    console.log(
      `\n${failed.length} check(s) failed. Search still works without the semantic tier.\n`,
    );
    return 1;
  }
  if (warned.length > 0) {
    console.log(
      `\n${warned.length} check(s) could not be confirmed. Nothing is known to be broken, ` +
        "but nothing here proves the semantic tier will work either.\n",
    );
    return 2;
  }
  console.log("\nAll checks passed.\n");
  return 0;
}
