import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverObsidianVaults,
  getObsidianRegistryPaths,
  getOilUserConfigPath,
  loadOilUserConfig,
  pickVaultDirectory,
  resolveVaultPath,
  saveVaultProfile,
  validateVaultDirectory,
} from "../vault-path.js";

describe("vault path setup and resolution", () => {
  let tempDir: string;
  let configPath: string;
  let registryPath: string;
  let vaultA: string;
  let vaultB: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oil-vault-path-"));
    configPath = join(tempDir, "oil", "config.json");
    registryPath = join(tempDir, "obsidian", "obsidian.json");
    vaultA = join(tempDir, "Vault A");
    vaultB = join(tempDir, "Vault B");
    await createVault(vaultA, true);
    await createVault(vaultB, true);
    vaultA = await realpath(vaultA);
    vaultB = await realpath(vaultB);
    await mkdir(join(registryPath, ".."), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("publishes oil as the primary executable with the long compatibility alias", async () => {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dirname, "../../package.json"), "utf-8"),
    );

    expect(packageJson.bin).toEqual({
      oil: "dist/cli.js",
      "obsidian-intelligence-layer": "dist/cli.js",
    });
    expect(packageJson.scripts.prepare).toBe("npm run build");
  });

  it("uses platform-appropriate user configuration and Obsidian registry paths", () => {
    expect(getOilUserConfigPath({
      platform: "darwin",
      homeDir: "/Users/tester",
      env: {},
    })).toBe("/Users/tester/Library/Application Support/obsidian-intelligence-layer/config.json");
    expect(getOilUserConfigPath({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
    })).toContain("obsidian-intelligence-layer");
    expect(getObsidianRegistryPaths({
      platform: "linux",
      homeDir: "/home/tester",
      env: { XDG_CONFIG_HOME: "/custom/config" },
    })[0]).toBe("/custom/config/obsidian/obsidian.json");
  });

  it("validates marked vaults, markdown vaults, and rejects unrelated empty directories", async () => {
    const marked = await validateVaultDirectory(vaultA, { countNotes: true });
    expect(marked).toMatchObject({
      valid: true,
      hasObsidianConfig: true,
      hasNotes: true,
      noteCount: 1,
    });

    const notesOnly = join(tempDir, "notes-only");
    await mkdir(notesOnly);
    await writeFile(join(notesOnly, "Note.md"), "# Note\n", "utf-8");
    const notesValidation = await validateVaultDirectory(notesOnly);
    expect(notesValidation.valid).toBe(true);
    expect(notesValidation.warnings).toContain(
      "No .obsidian folder was found. OIL can use this directory, but Obsidian may not have opened it as a vault yet.",
    );

    const empty = join(tempDir, "empty");
    await mkdir(empty);
    const emptyValidation = await validateVaultDirectory(empty);
    expect(emptyValidation.valid).toBe(false);
    expect(emptyValidation.errors[0]).toContain("does not look like an Obsidian vault");
  });

  it("discovers and validates vaults from Obsidian's registry", async () => {
    await writeRegistry(registryPath, [
      { path: vaultA, open: true },
      { path: vaultB, open: false },
      { path: join(tempDir, "missing"), open: false },
    ]);

    const discovered = await discoverObsidianVaults({ registryPaths: [registryPath] });
    expect(discovered.map((vault) => vault.path)).toEqual(
      expect.arrayContaining([vaultA, vaultB, join(tempDir, "missing")]),
    );
    expect(discovered[0]).toMatchObject({ name: "Vault A", valid: true, registryOpen: true });
    expect(discovered.find((vault) => vault.path === join(tempDir, "missing"))?.valid).toBe(false);
  });

  it("persists canonical named profiles atomically and resolves the default", async () => {
    const saved = await saveVaultProfile("work", vaultA, { configPath });
    expect(saved.config.defaultProfile).toBe("work");
    expect(saved.config.profiles.work.path).toBe(vaultA);

    const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(onDisk.profiles.work.path).toBe(vaultA);
    const loaded = await loadOilUserConfig(configPath);
    expect(loaded).toEqual(saved.config);

    const resolved = await resolveVaultPath({
      configPath,
      registryPaths: [],
      allowRegistryDiscovery: false,
    });
    expect(resolved).toMatchObject({ path: vaultA, source: "saved-default", profile: "work" });
  });

  it("honors explicit and environment precedence without silently falling back", async () => {
    await saveVaultProfile("work", vaultA, { configPath });
    const explicit = await resolveVaultPath({
      explicitPath: vaultB,
      envPath: vaultA,
      configPath,
    });
    expect(explicit).toMatchObject({ path: vaultB, source: "explicit" });

    const environment = await resolveVaultPath({ envPath: vaultB, configPath });
    expect(environment).toMatchObject({ path: vaultB, source: "environment" });

    await expect(resolveVaultPath({
      envPath: join(tempDir, "missing"),
      configPath,
      registryPaths: [registryPath],
    })).rejects.toThrow("OBSIDIAN_VAULT_PATH is invalid");
  });

  it("uses one unambiguous valid registry vault and rejects multiple choices", async () => {
    await writeRegistry(registryPath, [{ path: vaultA, open: true }]);
    const one = await resolveVaultPath({ configPath, registryPaths: [registryPath] });
    expect(one).toMatchObject({ path: vaultA, source: "obsidian-registry" });

    await writeRegistry(registryPath, [
      { path: vaultA, open: true },
      { path: vaultB, open: false },
    ]);
    await expect(resolveVaultPath({ configPath, registryPaths: [registryPath] }))
      .rejects.toThrow("Multiple Obsidian vaults were found");
  });

  it("builds native macOS and Windows folder pickers without shell interpolation", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = (command: string, args: string[]) => {
      calls.push({ command, args });
      return command === "osascript" ? "/Users/tester/My Vault/\n" : "C:\\Vaults\\Work\r\n";
    };

    expect(pickVaultDirectory({ platform: "darwin", runner })).toBe("/Users/tester/My Vault");
    expect(pickVaultDirectory({ platform: "win32", runner })).toBe("C:\\Vaults\\Work");
    expect(calls[0].command).toBe("osascript");
    expect(calls[1].command).toBe("powershell.exe");
    expect(calls[1].args).toContain("-STA");
  });
});

async function createVault(path: string, withObsidianMarker: boolean): Promise<void> {
  await mkdir(path, { recursive: true });
  if (withObsidianMarker) await mkdir(join(path, ".obsidian"));
  await writeFile(join(path, "Welcome.md"), "# Welcome\n", "utf-8");
}

async function writeRegistry(
  path: string,
  vaults: Array<{ path: string; open: boolean }>,
): Promise<void> {
  await writeFile(path, JSON.stringify({
    vaults: Object.fromEntries(vaults.map((vault, index) => [String(index), vault])),
  }), "utf-8");
}
