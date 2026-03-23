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
  },
  search: {
    defaultTier: "fuzzy",
    semanticModel: "local",
    semanticIndexFile: "_oil-index.json",
    graphIndexFile: "_oil-graph.json",
    backgroundIndexThresholdMs: 3000,
  },
  writeGate: {
    diffFormat: "markdown",
    logAllWrites: true,
    batchDiffMaxNotes: 50,
    autoConfirmedSections: ["Agent Insights", "Connect Hooks"],
    autoConfirmedOperations: [
      "log_agent_action",
      "capture_connect_hook",
      "patch_note_designated",
    ],
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
    default_tier: "defaultTier",
    semantic_model: "semanticModel",
    semantic_index_file: "semanticIndexFile",
    graph_index_file: "graphIndexFile",
    background_index_threshold_ms: "backgroundIndexThresholdMs",
    write_gate: "writeGate",
    diff_format: "diffFormat",
    log_all_writes: "logAllWrites",
    batch_diff_max_notes: "batchDiffMaxNotes",
    auto_confirmed_sections: "autoConfirmedSections",
    auto_confirmed_operations: "autoConfirmedOperations",
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
 * Load OIL configuration from `oil.config.yaml` in the vault root.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadConfig(vaultPath: string): Promise<OilConfig> {
  const configPath = join(vaultPath, "oil.config.yaml");

  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULTS };
    }
    const remapped = remapYaml(parsed);
    return deepMerge(
      DEFAULTS as unknown as Record<string, unknown>,
      remapped,
    ) as unknown as OilConfig;
  } catch {
    // Config file doesn't exist — use defaults
    return { ...DEFAULTS };
  }
}

export { DEFAULTS as DEFAULT_CONFIG };
