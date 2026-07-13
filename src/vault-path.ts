/**
 * OIL — User vault discovery and first-run configuration.
 *
 * Interactive UI belongs to the explicit CLI setup flow. The MCP runtime only
 * resolves and validates a previously selected path (or one unambiguous
 * Obsidian registry entry) so stdio initialization never blocks on a dialog.
 */

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_VERSION = 1;
const DEFAULT_PROFILE = "default";
const NOTE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const EXCLUDED_DIRECTORIES = new Set([".git", ".obsidian", ".trash", "node_modules"]);

export interface VaultProfile {
  path: string;
  updatedAt: string;
}

export interface OilUserConfig {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, VaultProfile>;
}

export interface VaultValidation {
  path: string;
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  hasObsidianConfig: boolean;
  hasOilConfig: boolean;
  hasNotes: boolean;
  noteCount?: number;
  errors: string[];
  warnings: string[];
}

export interface DiscoveredVault extends VaultValidation {
  name: string;
  source: "obsidian-registry";
  registryPath: string;
  registryOpen: boolean;
}

export type VaultPathSource =
  | "explicit"
  | "environment"
  | "profile"
  | "saved-default"
  | "obsidian-registry";

export interface ResolvedVaultPath {
  path: string;
  source: VaultPathSource;
  profile?: string;
  warnings: string[];
}

export interface PlatformPathsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ResolveVaultPathOptions extends PlatformPathsOptions {
  explicitPath?: string;
  envPath?: string;
  profileName?: string;
  configPath?: string;
  registryPaths?: string[];
  allowRegistryDiscovery?: boolean;
}

export interface SaveVaultProfileOptions extends PlatformPathsOptions {
  configPath?: string;
  setDefault?: boolean;
}

type PickerRunner = (
  command: string,
  args: string[],
) => string;

export interface PickVaultDirectoryOptions extends PlatformPathsOptions {
  runner?: PickerRunner;
}

/** Return the per-user OIL configuration file location. */
export function getOilUserConfigPath(options: PlatformPathsOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  if (env.OIL_CONFIG_PATH) return resolve(expandHome(env.OIL_CONFIG_PATH, home));
  if (env.OIL_CONFIG_HOME) {
    return join(resolve(expandHome(env.OIL_CONFIG_HOME, home)), "config.json");
  }
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "obsidian-intelligence-layer", "config.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "obsidian-intelligence-layer", "config.json");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "obsidian-intelligence-layer", "config.json");
}

/** Return all platform-specific Obsidian registry candidates in priority order. */
export function getObsidianRegistryPaths(options: PlatformPathsOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  if (platform === "win32") {
    return [join(env.APPDATA ?? join(home, "AppData", "Roaming"), "obsidian", "obsidian.json")];
  }
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "obsidian", "obsidian.json")];
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    join(xdg, "obsidian", "obsidian.json"),
    join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
  ];
}

export async function loadOilUserConfig(
  configPath = getOilUserConfigPath(),
): Promise<OilUserConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as Partial<OilUserConfig>;
    if (parsed.version !== CONFIG_VERSION || !parsed.profiles || typeof parsed.profiles !== "object") {
      throw new Error(`Unsupported or malformed OIL user configuration: ${configPath}`);
    }
    const profiles: Record<string, VaultProfile> = {};
    for (const [name, profile] of Object.entries(parsed.profiles)) {
      if (
        isValidProfileName(name)
        && profile
        && typeof profile.path === "string"
        && typeof profile.updatedAt === "string"
      ) {
        profiles[name] = profile;
      }
    }
    return {
      version: CONFIG_VERSION,
      ...(parsed.defaultProfile && isValidProfileName(parsed.defaultProfile)
        ? { defaultProfile: parsed.defaultProfile }
        : {}),
      profiles,
    };
  } catch (error) {
    if (isMissingFileError(error)) return { version: CONFIG_VERSION, profiles: {} };
    throw error;
  }
}

/** Atomically persist a canonical vault path as a named profile. */
export async function saveVaultProfile(
  profileName: string,
  vaultPath: string,
  options: SaveVaultProfileOptions = {},
): Promise<{ configPath: string; config: OilUserConfig; validation: VaultValidation }> {
  if (!isValidProfileName(profileName)) {
    throw new Error("Profile names may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  const validation = await validateVaultDirectory(vaultPath);
  if (!validation.valid) throw new Error(formatValidationFailure(validation));

  const configPath = options.configPath ?? getOilUserConfigPath(options);
  const config = await loadOilUserConfig(configPath);
  config.profiles[profileName] = {
    path: validation.path,
    updatedAt: new Date().toISOString(),
  };
  if (options.setDefault !== false || !config.defaultProfile) config.defaultProfile = profileName;

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600).catch(() => {});
  return { configPath, config, validation };
}

/**
 * Validate a vault candidate without mutating it. A directory qualifies when
 * it has Obsidian metadata, an OIL config, or at least one supported note.
 */
export async function validateVaultDirectory(
  inputPath: string,
  options: { countNotes?: boolean; allowEmpty?: boolean } = {},
): Promise<VaultValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const expanded = expandHome(inputPath.trim(), homedir());
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
  let canonical = absolute;
  let exists = false;
  let directory = false;
  let readable = false;

  if (!inputPath.trim()) errors.push("Vault path is empty.");
  try {
    const fileStats = await stat(absolute);
    exists = true;
    directory = fileStats.isDirectory();
    if (!directory) errors.push("Vault path is not a directory.");
    if (directory) canonical = await realpath(absolute);
  } catch (error) {
    if (isMissingFileError(error)) errors.push("Vault path does not exist.");
    else errors.push(`Vault path is not accessible: ${errorMessage(error)}`);
  }

  if (directory) {
    try {
      await access(canonical, constants.R_OK);
      await readdir(canonical);
      readable = true;
    } catch (error) {
      errors.push(`Vault directory is not readable: ${errorMessage(error)}`);
    }
  }

  const hasObsidianConfig = readable && await isDirectory(join(canonical, ".obsidian"));
  const hasOilConfig = readable && await isFile(join(canonical, "oil.config.yaml"));
  let noteCount: number | undefined;
  let hasNotes = false;
  if (readable) {
    noteCount = await countSupportedNotes(canonical, options.countNotes ? Number.POSITIVE_INFINITY : 1);
    hasNotes = noteCount > 0;
  }

  if (readable && !hasObsidianConfig && !hasOilConfig && !hasNotes && !options.allowEmpty) {
    errors.push("Directory does not look like an Obsidian vault: no .obsidian folder, oil.config.yaml, or supported notes were found.");
  }
  if (readable && !hasObsidianConfig) {
    warnings.push("No .obsidian folder was found. OIL can use this directory, but Obsidian may not have opened it as a vault yet.");
  }

  return {
    path: canonical,
    valid: errors.length === 0,
    exists,
    isDirectory: directory,
    readable,
    hasObsidianConfig,
    hasOilConfig,
    hasNotes,
    ...(options.countNotes ? { noteCount: noteCount ?? 0 } : {}),
    errors,
    warnings,
  };
}

/** Discover vaults already registered with the local Obsidian desktop app. */
export async function discoverObsidianVaults(
  options: PlatformPathsOptions & { registryPaths?: string[] } = {},
): Promise<DiscoveredVault[]> {
  const registryPaths = options.registryPaths ?? getObsidianRegistryPaths(options);
  const discovered = new Map<string, DiscoveredVault>();
  for (const registryPath of registryPaths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(registryPath, "utf-8"));
    } catch {
      continue;
    }
    const vaults = getRegistryVaultEntries(parsed);
    for (const entry of vaults) {
      let candidatePath: string;
      try {
        candidatePath = normalizeRegistryVaultPath(entry.path);
      } catch {
        continue;
      }
      const validation = await validateVaultDirectory(candidatePath);
      const key = validation.path.toLowerCase();
      const current = discovered.get(key);
      if (current?.registryOpen && !entry.open) continue;
      discovered.set(key, {
        ...validation,
        name: basename(validation.path) || validation.path,
        source: "obsidian-registry",
        registryPath,
        registryOpen: entry.open,
      });
    }
  }
  return [...discovered.values()].sort(
    (a, b) => Number(b.registryOpen) - Number(a.registryOpen) || a.name.localeCompare(b.name),
  );
}

/** Resolve the runtime vault without ever opening interactive UI. */
export async function resolveVaultPath(
  options: ResolveVaultPathOptions = {},
): Promise<ResolvedVaultPath> {
  const configPath = options.configPath ?? getOilUserConfigPath(options);
  const explicit = options.explicitPath?.trim();
  if (explicit) return validateResolved(explicit, "explicit");

  const environmentPath = options.envPath?.trim();
  if (environmentPath) return validateResolved(environmentPath, "environment");

  const config = await loadOilUserConfig(configPath);
  if (options.profileName) {
    const profile = config.profiles[options.profileName];
    if (!profile) {
      throw new Error(
        `OIL vault profile '${options.profileName}' does not exist. Run 'oil setup --profile ${options.profileName}'.`,
      );
    }
    return validateResolved(profile.path, "profile", options.profileName);
  }

  if (config.defaultProfile) {
    const profile = config.profiles[config.defaultProfile];
    if (!profile) {
      throw new Error(`OIL default profile '${config.defaultProfile}' is missing from ${configPath}. Run setup again.`);
    }
    return validateResolved(profile.path, "saved-default", config.defaultProfile);
  }

  if (options.allowRegistryDiscovery !== false) {
    const discovered = await discoverObsidianVaults({
      ...options,
      registryPaths: options.registryPaths,
    });
    const valid = discovered.filter((vault) => vault.valid);
    if (valid.length === 1) {
      return {
        path: valid[0].path,
        source: "obsidian-registry",
        warnings: valid[0].warnings,
      };
    }
    if (valid.length > 1) {
      throw new Error(
        `Multiple Obsidian vaults were found (${valid.map((vault) => vault.name).join(", ")}). Run 'oil setup' to choose one.`,
      );
    }
  }

  throw new Error(
    "No Obsidian vault is configured. Run 'oil setup' to choose one, or set OBSIDIAN_VAULT_PATH.",
  );
}

/** Open a native folder chooser during explicit CLI setup. */
export function pickVaultDirectory(options: PickVaultDirectoryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultPickerRunner;
  try {
    if (platform === "darwin") {
      return cleanPickerResult(runner("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Select your Obsidian vault folder")',
      ]));
    }
    if (platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = 'Select your Obsidian vault folder'",
        "$dialog.ShowNewFolderButton = $true",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
      ].join("; ");
      return cleanPickerResult(runner("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        script,
      ]));
    }
    try {
      return cleanPickerResult(runner("zenity", [
        "--file-selection",
        "--directory",
        "--title=Select your Obsidian vault folder",
      ]));
    } catch {
      return cleanPickerResult(runner("kdialog", ["--getexistingdirectory", resolve(".")]));
    }
  } catch {
    return null;
  }
}

export function isValidProfileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function validateResolved(
  candidate: string,
  source: VaultPathSource,
  profile?: string,
): Promise<ResolvedVaultPath> {
  return validateVaultDirectory(candidate).then((validation) => {
    if (!validation.valid) {
      throw new Error(`${source === "environment" ? "OBSIDIAN_VAULT_PATH" : "Configured vault path"} is invalid. ${formatValidationFailure(validation)}`);
    }
    return {
      path: validation.path,
      source,
      ...(profile ? { profile } : {}),
      warnings: validation.warnings,
    };
  });
}

function formatValidationFailure(validation: VaultValidation): string {
  return `${validation.path}: ${validation.errors.join(" ")}`;
}

function getRegistryVaultEntries(parsed: unknown): Array<{ path: string; open: boolean }> {
  if (!parsed || typeof parsed !== "object") return [];
  const rawVaults = (parsed as { vaults?: unknown }).vaults;
  if (!rawVaults || typeof rawVaults !== "object") return [];
  return Object.values(rawVaults as Record<string, unknown>).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as { path?: unknown; open?: unknown };
    return typeof entry.path === "string"
      ? [{ path: entry.path, open: entry.open === true }]
      : [];
  });
}

function normalizeRegistryVaultPath(value: string): string {
  if (value.startsWith("file://")) return fileURLToPath(value);
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch {}
  return resolve(expandHome(decoded, homedir()));
}

async function countSupportedNotes(root: string, maximum: number): Promise<number> {
  let count = 0;
  const pending = [root];
  while (pending.length > 0 && count < maximum) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          pending.push(join(current, entry.name));
        }
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      if (NOTE_EXTENSIONS.has(extension)) count++;
      if (count >= maximum) break;
    }
  }
  return count;
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

function defaultPickerRunner(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function cleanPickerResult(value: string): string | null {
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (cleaned === "/" || cleaned === "\\" || /^[A-Za-z]:[\\/]$/.test(cleaned)) return cleaned;
  return cleaned.replace(/[\\/]$/, "");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}