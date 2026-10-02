/**
 * OIL — Configuration parser
 * Reads oil.config.yaml from the vault root with sensible defaults.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ArchiveConfig,
  ArchiveRule,
  ConfigProvenance,
  ConfigSource,
  OilConfig,
  SemanticProvenance,
} from "./types.js";

/** Nothing has overridden anything yet. */
function defaultProvenance(): ConfigProvenance {
  return {
    semantic: {
      enabled: "default",
      endpoint: "default",
      model: "default",
      minScore: "default",
    },
  };
}

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
    excludeFolders: [],
  },
  semantic: {
    enabled: true,
    endpoint: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
    indexFile: "_oil-vectors.json",
    // Measured against nomic-embed-text on a 360-note vault: real queries score
    // 0.554-0.749 against their best note, gibberish 0.451-0.531, and off-topic
    // English 0.432-0.454. The previous 0.45 sat below every noise score, so the
    // floor admitted everything and "no match" was unreachable.
    minScore: 0.5,
    // Measured against CPU-only Ollama on real notes: four inputs per request
    // is both the fastest per note (~0.9s vs ~1.7s at sixteen) and the least
    // likely to trip a timeout.
    batchSize: 4,
    timeoutMs: 15000,
  },
  audit: {
    logAllWrites: true,
  },
  archive: defaultArchiveConfig(),
  provenance: defaultProvenance(),
};

/** Built fresh every time: the nested arrays must never be shared between configs. */
export function defaultArchiveConfig(): ArchiveConfig {
  return {
    enabled: false,
    mode: "move",
    root: "Archive/",
    run: "manual",
    maxPerRun: 200,
    manifestFile: ".oil-archive.json",
    protect: {
      tags: ["keep"],
      frontmatter: { pinned: true },
      folders: [],
      recentBacklinkDays: 0,
      restoredGraceDays: 90,
    },
    rules: [],
    index: { search: "fallback", breadcrumbs: true, embedArchived: false },
  };
}

// ─── Archive block ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function warnArchive(message: string): void {
  console.error(`[OIL] Config: archive — ${message}`);
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  key: string,
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  warnArchive(`ignoring ${key}='${String(value)}' — expected ${allowed.join(" | ")}.`);
  return fallback;
}

function pickNumber(value: unknown, fallback: number, key: string): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  warnArchive(`ignoring ${key}='${String(value)}' — expected a non-negative number.`);
  return fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickStrings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item).trim()).filter(Boolean);
}

const stripHash = (tag: string) => tag.replace(/^#/, "");

/**
 * Parse the `archive:` block of `oil.config.yaml`.
 *
 * Handled apart from the generic snake→camel remap on purpose: rules and
 * protections name the user's own frontmatter keys, and a generic remap would
 * rewrite `date_field: closed_on` into a key the vault does not have.
 */
export function parseArchiveConfig(raw: unknown): ArchiveConfig {
  const config = defaultArchiveConfig();
  if (raw === undefined || raw === null) return config;
  if (!isRecord(raw)) {
    warnArchive("expected a mapping; archiving stays off.");
    return config;
  }

  config.enabled = pickBoolean(raw.enabled, config.enabled);
  config.mode = pickEnum(raw.mode, ["move", "flag"] as const, config.mode, "mode");
  if (typeof raw.root === "string" && raw.root.trim()) {
    const root = raw.root.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (root) config.root = `${root}/`;
  }
  config.run = pickEnum(raw.run, ["manual", "on_start", "daily"] as const, config.run, "run");
  config.maxPerRun = pickNumber(raw.max_per_run, config.maxPerRun, "max_per_run");
  if (typeof raw.manifest_file === "string" && raw.manifest_file.trim()) {
    config.manifestFile = raw.manifest_file.trim();
  }

  if (raw.protect !== undefined) {
    if (!isRecord(raw.protect)) {
      warnArchive("ignoring protect — expected a mapping.");
    } else {
      const p = raw.protect;
      const tags = pickStrings(p.tags);
      if (tags) config.protect.tags = tags.map(stripHash);
      if (p.frontmatter !== undefined) {
        if (isRecord(p.frontmatter)) config.protect.frontmatter = { ...p.frontmatter };
        else warnArchive("ignoring protect.frontmatter — expected a mapping.");
      }
      const folders = pickStrings(p.folders);
      if (folders) config.protect.folders = folders;
      config.protect.recentBacklinkDays = pickNumber(
        p.recent_backlink_days,
        config.protect.recentBacklinkDays,
        "protect.recent_backlink_days",
      );
      config.protect.restoredGraceDays = pickNumber(
        p.restored_grace_days,
        config.protect.restoredGraceDays,
        "protect.restored_grace_days",
      );
    }
  }

  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) {
      warnArchive("ignoring rules — expected a list.");
    } else {
      raw.rules.forEach((entry, i) => {
        const rule = parseArchiveRule(entry, i);
        if (rule) config.rules.push(rule);
      });
    }
  }

  if (raw.index !== undefined) {
    if (!isRecord(raw.index)) {
      warnArchive("ignoring index — expected a mapping.");
    } else {
      config.index.search = pickEnum(
        raw.index.search,
        ["fallback", "never", "always"] as const,
        config.index.search,
        "index.search",
      );
      config.index.breadcrumbs = pickBoolean(raw.index.breadcrumbs, config.index.breadcrumbs);
      config.index.embedArchived = pickBoolean(
        raw.index.embed_archived,
        config.index.embedArchived,
      );
    }
  }

  return config;
}

function parseArchiveRule(entry: unknown, index: number): ArchiveRule | null {
  const label = `rules[${index}]`;
  if (!isRecord(entry)) {
    warnArchive(`ignoring ${label} — expected a mapping.`);
    return null;
  }
  const rule: ArchiveRule = {
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : label,
  };
  if (typeof entry.folder === "string" && entry.folder.trim()) rule.folder = entry.folder.trim();
  if (entry.older_than_days !== undefined) {
    const days = pickNumber(entry.older_than_days, NaN, `${label}.older_than_days`);
    if (Number.isFinite(days)) rule.olderThanDays = days;
  }
  if (typeof entry.date_field === "string" && entry.date_field.trim()) {
    rule.dateField = entry.date_field.trim();
  }
  if (entry.frontmatter !== undefined) {
    if (isRecord(entry.frontmatter)) rule.frontmatter = { ...entry.frontmatter };
    else warnArchive(`ignoring ${label}.frontmatter — expected a mapping.`);
  }
  const tags = pickStrings(entry.tags);
  if (tags && tags.length) rule.tags = tags.map(stripHash);

  // A rule with no condition would match every note in the vault.
  if (!rule.folder && rule.olderThanDays === undefined && !rule.frontmatter && !rule.tags) {
    warnArchive(`ignoring ${label} ('${rule.name}') — it names no condition and would match every note.`);
    return null;
  }
  return rule;
}

// ─── Flag provenance ──────────────────────────────────────────────────────────

/**
 * Environment variables that were set by a command-line flag rather than by the
 * client's `env` block.
 *
 * The CLI translates every flag into the environment variable the server
 * already reads, which is what makes `args` and `env` interchangeable for a
 * client — but it also erases the difference between them. Recording the
 * translation is the only way the server can later say `--no-semantic` instead
 * of guessing.
 */
const flagOrigins = new Set<string>();

/** Called by the CLI as it translates a flag into its environment variable. */
export function recordFlagOrigin(envVar: string): void {
  flagOrigins.add(envVar);
}

/** Test seam — flag origins are process-wide, so a suite has to reset them. */
export function clearFlagOrigins(): void {
  flagOrigins.clear();
}

function envSource(envVar: string): ConfigSource {
  return flagOrigins.has(envVar) ? "flag" : "environment";
}

/** How a value's origin reads in a diagnostic line. */
export function describeConfigSource(source: ConfigSource): string {
  switch (source) {
    case "flag":
      return "command-line flag";
    case "environment":
      return "environment variable";
    case "oil.config.yaml":
      return "oil.config.yaml";
    default:
      return "built-in default";
  }
}

/**
 * Why the semantic tier is off, naming only the layer that actually turned it
 * off. `default` never disables the tier, so an unknown source is reported
 * without naming one at all rather than inventing a file.
 */
export function describeSemanticDisabledBy(source: ConfigSource | undefined): string {
  switch (source) {
    case "flag":
      return "Disabled by the --no-semantic flag";
    case "environment":
      return "Disabled by OIL_SEMANTIC in the environment";
    case "oil.config.yaml":
      return "Disabled in oil.config.yaml";
    default:
      return "Disabled by this server's configuration";
  }
}

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
    exclude_folders: "excludeFolders",
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
  const semanticSources: SemanticProvenance = { ...config.provenance.semantic };

  const enabled = parseBoolean(env.OIL_SEMANTIC);
  if (enabled !== undefined) {
    semantic.enabled = enabled;
    semanticSources.enabled = envSource("OIL_SEMANTIC");
  }

  if (env.OIL_SEMANTIC_ENDPOINT) {
    semantic.endpoint = env.OIL_SEMANTIC_ENDPOINT;
    semanticSources.endpoint = envSource("OIL_SEMANTIC_ENDPOINT");
  }
  if (env.OIL_SEMANTIC_MODEL) {
    semantic.model = env.OIL_SEMANTIC_MODEL;
    semanticSources.model = envSource("OIL_SEMANTIC_MODEL");
  }

  const minScore = parseNumber(env.OIL_SEMANTIC_MIN_SCORE, "OIL_SEMANTIC_MIN_SCORE");
  if (minScore !== undefined) {
    semantic.minScore = minScore;
    semanticSources.minScore = envSource("OIL_SEMANTIC_MIN_SCORE");
  }

  // Reachable from the environment so a measurement harness can tighten or
  // loosen the budget without editing a vault's config — and so the
  // degradation path can be provoked deliberately in a test.
  const timeoutMs = parseNumber(env.OIL_SEMANTIC_TIMEOUT_MS, "OIL_SEMANTIC_TIMEOUT_MS");
  if (timeoutMs !== undefined) semantic.timeoutMs = timeoutMs;

  const search = { ...config.search };
  if (env.OIL_EXCLUDE_FOLDERS !== undefined && env.OIL_EXCLUDE_FOLDERS.trim() !== "") {
    search.excludeFolders = env.OIL_EXCLUDE_FOLDERS.split(",")
      .map((folder) => folder.trim())
      .filter(Boolean);
  }

  return { ...config, search, semantic, provenance: { semantic: semanticSources } };
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
 * Which semantic settings this YAML actually names.
 *
 * Only keys the file states get attributed to it: a value the file leaves alone
 * is still the default's, and claiming otherwise would misdirect a reader just
 * as surely as naming the wrong file.
 */
function semanticSourcesFromYaml(remapped: Record<string, unknown>): SemanticProvenance {
  const sources = defaultProvenance().semantic;
  const block = remapped.semantic;
  if (block === null || typeof block !== "object" || Array.isArray(block)) return sources;

  for (const key of ["enabled", "endpoint", "model", "minScore"] as const) {
    if ((block as Record<string, unknown>)[key] !== undefined) {
      sources[key] = "oil.config.yaml";
    }
  }
  return sources;
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
      return applyEnvOverrides(freshDefaults());
    }
    const { archive: rawArchive, ...rest } = applyLegacyAliases(parsed);
    const remapped = remapYaml(rest);
    // Provenance is derived, never declared: a `provenance` block in the file
    // would otherwise let a vault assert where its own values came from.
    delete remapped.provenance;

    const merged = deepMerge(
      freshDefaults() as unknown as Record<string, unknown>,
      remapped,
    ) as unknown as OilConfig;

    return applyEnvOverrides({
      ...merged,
      archive: parseArchiveConfig(rawArchive),
      provenance: { semantic: semanticSourcesFromYaml(remapped) },
    });
  } catch {
    // Config file doesn't exist — use defaults
    return applyEnvOverrides(freshDefaults());
  }
}

/** A private copy, so a caller's overrides never write through to DEFAULTS. */
function freshDefaults(): OilConfig {
  return { ...DEFAULTS, archive: defaultArchiveConfig(), provenance: defaultProvenance() };
}

export { DEFAULTS as DEFAULT_CONFIG };
