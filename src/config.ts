/**
 * OIL — Configuration parser
 * Reads oil.config.yaml from the vault root with sensible defaults.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { OilConfig } from "./types.js";

const DEFAULTS: OilConfig = {
  schema: {
    customersRoot: "Customers/",
    peopleRoot: "People/",
    meetingsRoot: "Meetings/",
    projectsRoot: "Projects/",
    weeklyRoot: "Weekly/",
    templatesRoot: "Templates/",
    agentLog: "_agent-log/",
    connectHooksBackup: ".connect/hooks/hooks.md",
    opportunitiesSubdir: "opportunities/",
    milestonesSubdir: "milestones/",
    insightsSubdir: "insights/",
  },
  frontmatterSchema: {
    customerField: "customer",
    tagsField: "tags",
    dateField: "date",
    statusField: "status",
    projectField: "project",
    tpidField: "tpid",
    accountidField: "accountid",
    titleField: "title",
  },
  search: {
    graphIndexFile: "_oil-graph.json",
    backgroundIndexThresholdMs: 3000,
  },
  semantic: {
    enabled: true,
    endpoint: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
    indexFile: "_oil-vectors.json",
    minScore: 0.45,
    batchSize: 16,
    timeoutMs: 20000,
  },
  audit: {
    logAllWrites: true,
  },
};

/**
 * Deep merge two objects — source values override target.
 * Only merges plain objects; arrays and primitives are replaced wholesale.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (target as Record<string, unknown>)[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else if (srcVal !== undefined) {
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }
  return result;
}

/**
 * Fold the deprecated `write_gate` block into `audit`.
 * Applied before remapping so `audit` always wins, whichever block YAML lists last.
 */
function applyLegacyAliases(raw: Record<string, unknown>): Record<string, unknown> {
  if (!("write_gate" in raw)) return raw;

  const { write_gate: legacy, ...rest } = raw;
  const asObject = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  console.error(
    "[OIL] Config: `write_gate` is deprecated — rename it to `audit`. Using it for now.",
  );

  return { ...rest, audit: { ...asObject(legacy), ...asObject(rest.audit) } };
}

/**
 * Remap snake_case YAML keys to camelCase config keys.
 */
function remapYaml(raw: Record<string, unknown>): Record<string, unknown> {
  const keyMap: Record<string, string> = {
    customers_root: "customersRoot",
    people_root: "peopleRoot",
    meetings_root: "meetingsRoot",
    projects_root: "projectsRoot",
    weekly_root: "weeklyRoot",
    templates_root: "templatesRoot",
    agent_log: "agentLog",
    connect_hooks_backup: "connectHooksBackup",
    opportunities_subdir: "opportunitiesSubdir",
    milestones_subdir: "milestonesSubdir",
    insights_subdir: "insightsSubdir",
    frontmatter_schema: "frontmatterSchema",
    customer_field: "customerField",
    tags_field: "tagsField",
    date_field: "dateField",
    status_field: "statusField",
    project_field: "projectField",
    tpid_field: "tpidField",
    accountid_field: "accountidField",
    title_field: "titleField",
    graph_index_file: "graphIndexFile",
    background_index_threshold_ms: "backgroundIndexThresholdMs",
    index_file: "indexFile",
    min_score: "minScore",
    batch_size: "batchSize",
    timeout_ms: "timeoutMs",
    log_all_writes: "logAllWrites",
  };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const mappedKey = keyMap[key] ?? key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[mappedKey] = remapYaml(value as Record<string, unknown>);
    } else {
      result[mappedKey] = value;
    }
  }
  return result;
}

/**
 * Apply environment overrides on top of the vault's YAML.
 *
 * An MCP client configures a server through `command`, `args` and `env` — never
 * through a file inside the user's vault. Anything a user needs to decide at
 * connection time therefore has to be reachable from the environment, so these
 * take precedence over `oil.config.yaml`.
 */
export function applyEnvOverrides(
  config: OilConfig,
  env: NodeJS.ProcessEnv = process.env,
): OilConfig {
  const semantic = { ...config.semantic };

  const enabled = parseBoolean(env.OIL_SEMANTIC);
  if (enabled !== undefined) semantic.enabled = enabled;

  if (env.OIL_SEMANTIC_ENDPOINT) semantic.endpoint = env.OIL_SEMANTIC_ENDPOINT;
  if (env.OIL_SEMANTIC_MODEL) semantic.model = env.OIL_SEMANTIC_MODEL;

  const minScore = parseNumber(env.OIL_SEMANTIC_MIN_SCORE, "OIL_SEMANTIC_MIN_SCORE");
  if (minScore !== undefined) semantic.minScore = minScore;

  return { ...config, semantic };
}

/** Accepts the spellings people actually type, and warns rather than guessing. */
function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes", "enabled"].includes(value)) return true;
  if (["0", "false", "off", "no", "disabled"].includes(value)) return false;
  console.error(`[OIL] Config: ignoring OIL_SEMANTIC='${raw}' — expected on or off.`);
  return undefined;
}

function parseNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`[OIL] Config: ignoring ${name}='${raw}' — expected a number.`);
    return undefined;
  }
  return value;
}

/**
 * Load OIL configuration from `oil.config.yaml` in the vault root.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadConfig(vaultPath: string): Promise<OilConfig> {
  const configPath = join(vaultPath, "oil.config.yaml");

  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return applyEnvOverrides({ ...DEFAULTS });
    }
    const remapped = remapYaml(applyLegacyAliases(parsed));
    return applyEnvOverrides(
      deepMerge(
        DEFAULTS as unknown as Record<string, unknown>,
        remapped,
      ) as unknown as OilConfig,
    );
  } catch {
    // Config file doesn't exist — use defaults
    return applyEnvOverrides({ ...DEFAULTS });
  }
}

export { DEFAULTS as DEFAULT_CONFIG };
