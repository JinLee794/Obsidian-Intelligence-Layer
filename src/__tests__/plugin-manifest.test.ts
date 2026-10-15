/**
 * The Copilot plugin pins the MCP server to an exact GitHub Packages version,
 * and that pin — not
 * `package.json` — decides what a user actually installs.
 *
 * These two versions are deliberately decoupled. The working tree runs ahead of
 * what is released, so an earlier version of this file asserting "pin ==
 * package.json version" was wrong in the dangerous direction: it forced the
 * marketplace to advertise `v0.7.0-beta.1`, a prerelease tag that was later
 * deleted from the remote. `npx --package=github:...#v0.7.0-beta.1` then fails
 * outright for every user, while passing every test on the machine that wrote it.
 *
 * So the pin is the source of truth here, and what this file enforces is that
 * (a) everything the user sees agrees with the pin, and (b) the pin names a
 * version that was actually released.
 *
 * The skill assertions enforce the other half of the plugin's budget: a bundled
 * skill is only worth its context if it says something the tool surface cannot.
 * Tool descriptions, parameter schemas and `agent_guidance` already cover tool
 * choice and error recovery, so the skill is held to the territory they can't
 * reach — the states where there are no tools to consult.
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const PLUGIN_ROOT = resolve(REPO_ROOT, "plugins/oil-vault-kit");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(REPO_ROOT, path), "utf-8"));
}

/** Compare text without letting a checkout's line-ending policy fail the test. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

const packageJson = await readJson("package.json");
const pluginJson = await readJson("plugins/oil-vault-kit/plugin.json");
const mcpJson = await readJson("plugins/oil-vault-kit/.mcp.json");
const marketplaceJson = await readJson(".github/plugin/marketplace.json");

/** The version the plugin actually installs — read from the pin, not assumed. */
const PINNED = /^--package=@mcaps-microsoft\/obsidian-intelligence-layer@(.+)$/;

const PINNED_VERSION = (() => {
  const servers = mcpJson.mcpServers as Record<string, { args?: string[] }>;
  const args = servers.oil?.args ?? [];
  const pkgArg = args.find((arg) => arg.startsWith("--package="));
  const match = PINNED.exec(pkgArg ?? "");
  if (!match) throw new Error("plugin .mcp.json does not pin the server to a GitHub Packages version");
  return match[1];
})();

/** The exact `--package` argument every pinned invocation must use. */
const PINNED_PACKAGE_ARG = `--package=@mcaps-microsoft/obsidian-intelligence-layer@${PINNED_VERSION}`;

/** The public release tarball documented for installs outside the org. */
const PUBLIC_TARBALL_ARG =
  `--package=https://github.com/JinLee794/Obsidian-Intelligence-Layer/releases/download/v${PINNED_VERSION}/mcaps-microsoft-obsidian-intelligence-layer-${PINNED_VERSION}.tgz`;

describe("plugin manifest", () => {
  it("declares a kebab-case name", () => {
    expect(pluginJson.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect((pluginJson.name as string).length).toBeLessThanOrEqual(64);
  });

  it("advertises the version it actually installs", () => {
    // Not `package.json`: the working tree runs ahead of what is released, and a
    // plugin that advertises an unreleased version installs a different one.
    expect(pluginJson.version).toBe(PINNED_VERSION);
  });

  it("points at components that exist", async () => {
    for (const [field, expected] of [
      ["skills", "skills/"],
      ["mcpServers", ".mcp.json"],
    ] as const) {
      expect(pluginJson[field]).toBe(expected);
      await expect(stat(resolve(PLUGIN_ROOT, expected))).resolves.toBeDefined();
    }
  });
});

describe("plugin MCP configuration", () => {
  const servers = mcpJson.mcpServers as Record<string, Record<string, unknown>>;

  it("names the server `oil`", () => {
    // The `memory` skill scopes itself with `allowed-tools: mcp_oil_*`, and the
    // README's client snippets use the same key. Renaming the server silently
    // unscopes the skill.
    expect(Object.keys(servers)).toEqual(["oil"]);
  });

  it("pins the server to an exact GitHub Packages version", () => {
    // A `github:` spec makes npx re-resolve the repository with git on every
    // launch — ~6.5s and several git processes per session even when cached,
    // which a burst of parallel sessions multiplies. The registry package ships
    // the built bundle, so launch is a cache revalidation and nothing else.
    const args = servers.oil.args as string[];
    const pkgArg = args.find((arg) => arg.startsWith("--package="));
    expect(pkgArg).toBe(PINNED_PACKAGE_ARG);
  });

  it("pins the package this repository publishes", () => {
    // publish.yml publishes package.json's name; a pin naming anything else
    // installs a package nobody releases.
    expect(packageJson.name).toBe("@mcaps-microsoft/obsidian-intelligence-layer");
    expect(PUBLIC_TARBALL_ARG).toContain(
      `/mcaps-microsoft-obsidian-intelligence-layer-${PINNED_VERSION}.tgz`,
    );
  });

  it("pins a version that was actually released", async () => {
    // The pinned version has to be published to GitHub Packages by the mirror's
    // publish.yml, and only a released version has a changelog entry. This is
    // the offline half of that guarantee; the release process owns publishing.
    const changelog = await readFile(resolve(REPO_ROOT, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain(`## [${PINNED_VERSION}]`);
  });

  it("does not pin a prerelease", () => {
    // Prerelease tags are the ones that get force-moved or deleted once the real
    // release lands — `v0.7.0-beta.1` was deleted from the remote while the
    // marketplace still advertised it, breaking installs for everyone.
    expect(PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("starts the MCP subcommand over stdio", () => {
    expect(servers.oil.type).toBe("stdio");
    expect(servers.oil.command).toBe("npx");
    expect(servers.oil.args).toContain("mcp");
  });

  it("takes the vault path from the environment and nothing else", () => {
    // Ollama settings are deliberately absent: referencing an unset variable
    // here would make the optional semantic tier look like required config.
    expect(servers.oil.env).toEqual({
      OBSIDIAN_VAULT_PATH: "${OBSIDIAN_VAULT_PATH}",
    });
  });
});

describe("documented npx invocations", () => {
  // An unpinned `npx --package=github:owner/repo` resolves the default branch,
  // which can lag the release the plugin actually runs. That shipped once: the
  // `doctor` command in this skill fetched a `main` that had no `doctor`
  // subcommand, so a healthy install looked like a broken one.
  it("pins every documented invocation to the pinned release", async () => {
    const docs = [
      "README.md",
      "plugins/oil-vault-kit/README.md",
      "plugins/oil-vault-kit/skills/oil-setup/SKILL.md",
      "plugins/oil-vault-kit/.mcp.json",
    ];
    // Any install spec for this server: the registry package, the public
    // release tarball, or a `github:` ref to either repository.
    const pattern =
      /--package=(?:@mcaps-microsoft\/obsidian-intelligence-layer(?:@[\w.\-]*)?|github:(?:JinLee794|mcaps-microsoft)\/Obsidian-Intelligence-Layer(?:#[\w.\-]*)?|https:\/\/github\.com\/JinLee794\/Obsidian-Intelligence-Layer\/[^\s"`]*)/g;

    for (const doc of docs) {
      const body = await readFile(resolve(REPO_ROOT, doc), "utf-8");
      const found = [...body.matchAll(pattern)];
      expect(found.length, `${doc} documents no npx invocation`).toBeGreaterThan(0);
      for (const match of found) {
        expect([PINNED_PACKAGE_ARG, PUBLIC_TARBALL_ARG], `stale npx invocation in ${doc}`).toContain(
          match[0],
        );
      }
    }
  });
});

describe("marketplace manifest", () => {
  it("lists the plugin at a source path that resolves", async () => {
    const plugins = marketplaceJson.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe(pluginJson.name);
    await expect(
      stat(resolve(REPO_ROOT, plugins[0].source as string, "plugin.json")),
    ).resolves.toBeDefined();
  });

  it("advertises the same version as the plugin", () => {
    const plugins = marketplaceJson.plugins as Array<Record<string, unknown>>;
    const metadata = marketplaceJson.metadata as Record<string, unknown>;
    expect(plugins[0].version).toBe(PINNED_VERSION);
    expect(metadata.version).toBe(PINNED_VERSION);
  });

  it("names an owner, which the CLI requires", () => {
    const owner = marketplaceJson.owner as Record<string, unknown>;
    expect(typeof owner?.name).toBe("string");
  });
});

describe("bundled canvas extension", () => {
  const EXT_ROOT = resolve(PLUGIN_ROOT, "extensions/oil-canvas");

  it("sits where the CLI discovers plugin extensions", async () => {
    // A manifest without `$schema` loads `extensions/<name>/extension.mjs` from
    // the plugin root. Declaring the Agent Plugins `$schema` moves discovery to
    // `com.github.copilot/extensions/`, which would silently drop the canvas.
    expect(pluginJson.$schema).toBeUndefined();
    await expect(stat(resolve(EXT_ROOT, "extension.mjs"))).resolves.toBeDefined();
  });

  it("imports nothing a plugin install cannot provide", async () => {
    // Plugins are copied, not `npm install`ed: only Node built-ins and the SDK
    // the CLI injects are guaranteed to resolve.
    const files = ["extension.mjs", ...(await readdir(resolve(EXT_ROOT, "lib"))).map((f) => `lib/${f}`)];
    for (const file of files.filter((f) => f.endsWith(".mjs"))) {
      const body = await readFile(resolve(EXT_ROOT, file), "utf-8");
      for (const [, fromSpec, dynSpec, bareSpec] of body.matchAll(
        /\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|^\s*import\s+"([^"]+)"/gm,
      )) {
        const spec = fromSpec ?? dynSpec ?? bareSpec;
        if (spec.startsWith(".")) continue;
        expect(spec, `${file} imports ${spec}`).toMatch(/^(node:|@github\/copilot-sdk\/extension$)/);
      }
    }
  });

  it("is loaded in development through a shim, not a copy", async () => {
    // A copied extension drifts from the shipped one; the shim cannot.
    const shim = await readFile(resolve(REPO_ROOT, ".github/extensions/oil-canvas/extension.mjs"), "utf-8");
    expect(shim.trim()).toBe(
      'import "../../../plugins/oil-vault-kit/extensions/oil-canvas/extension.mjs";',
    );
  });
});

describe("bundled skills", () => {
  it("keeps the bundled skill set minimal and deliberate", async () => {
    // Every bundled skill is loaded into the skill index for the whole session.
    // The plugin ships exactly one, because the rest of what an agent needs to
    // drive OIL is already in the tool descriptions, parameter schemas, and
    // `agent_guidance` the server returns on failure. Adding a skill that
    // restates any of those pays context to say something twice.
    const entries = await readdir(resolve(PLUGIN_ROOT, "skills"), { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual(["oil-setup"]);
  });

  it("declares a name matching its directory", async () => {
    const body = await readFile(resolve(PLUGIN_ROOT, "skills/oil-setup/SKILL.md"), "utf-8");
    expect(body).toMatch(/^---\r?\n(.*\r?\n)*?name: oil-setup\r?\n/);
  });

  it("stays out of territory the tool surface already covers", async () => {
    const body = await readFile(resolve(PLUGIN_ROOT, "skills/oil-setup/SKILL.md"), "utf-8");

    // `semantic_search`'s own description already says to prefer `search_vault`
    // for ordinary lookups, and each write tool's CONFLICT response already
    // returns the exact recovery sequence in `agent_guidance.next_step`. A skill
    // repeating either is dead weight that can also drift out of sync with it.
    expect(body).not.toMatch(/prefer\s+`?search_vault`?/i);
    expect(body).not.toMatch(/expected_mtime|atomic_append|CONFLICT/);

    // What it must keep is the case the tool surface cannot reach: no tools.
    expect(body).toContain("OBSIDIAN_VAULT_PATH");
    expect(body).toMatch(/unavailable/i);
  });

  it("documents the Ollama dependency as optional", async () => {
    // If that claim ever leaves the skill, an agent will start reporting OIL as
    // down when it is merely lexical.
    const body = await readFile(resolve(PLUGIN_ROOT, "skills/oil-setup/SKILL.md"), "utf-8");
    expect(body).toContain("OIL_SEMANTIC=off");
    expect(body).toMatch(/ollama\.com/i);
  });
});
