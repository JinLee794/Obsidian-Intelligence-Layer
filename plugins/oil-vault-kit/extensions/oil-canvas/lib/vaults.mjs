import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve, parse as parsePath } from "node:path";
import { artifactsDir, copilotHome } from "./paths.mjs";

const MAX_CSS_BYTES = 2 * 1024 * 1024;

// ── Obsidian's own vault registry ───────────────────────────────────────

function obsidianConfigCandidates() {
    const home = homedir();
    switch (platform()) {
        case "win32":
            return [join(process.env.APPDATA || join(home, "AppData", "Roaming"), "obsidian", "obsidian.json")];
        case "darwin":
            return [join(home, "Library", "Application Support", "obsidian", "obsidian.json")];
        default:
            return [
                join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "obsidian", "obsidian.json"),
                join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
                join(home, "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json"),
            ];
    }
}

/** Vaults Obsidian desktop knows about, most recently opened first. */
export function listObsidianVaults() {
    const out = [];
    for (const file of obsidianConfigCandidates()) {
        const json = readJson(file);
        if (!json?.vaults) continue;
        for (const [id, v] of Object.entries(json.vaults)) {
            if (!v?.path) continue;
            out.push({
                id,
                name: basename(v.path),
                path: v.path,
                lastOpened: typeof v.ts === "number" ? new Date(v.ts).toISOString() : null,
                open: Boolean(v.open),
                exists: existsSync(v.path),
            });
        }
    }
    return out.sort((a, b) => (b.lastOpened || "").localeCompare(a.lastOpened || ""));
}

// ── Where OIL itself is pointed ─────────────────────────────────────────

/**
 * Vault paths that OIL MCP servers are configured to serve, from the process
 * environment, the user's Copilot MCP config, and workspace MCP configs.
 */
export function detectOilVaults(cwd) {
    const found = new Map();
    const add = (path, source) => {
        if (!path || typeof path !== "string" || path.includes("${")) return;
        const abs = resolve(path);
        if (!found.has(abs)) found.set(abs, { path: abs, name: basename(abs), sources: [] });
        found.get(abs).sources.push(source);
    };

    add(process.env.OBSIDIAN_VAULT_PATH, "OBSIDIAN_VAULT_PATH");

    const configs = [[join(copilotHome(), "mcp-config.json"), "~/.copilot/mcp-config.json"]];
    if (cwd) {
        for (const rel of [".mcp.json", join(".vscode", "mcp.json"), join(".github", "mcp.json")]) {
            configs.push([join(cwd, rel), rel]);
        }
    }
    for (const [file, label] of configs) {
        const json = readJson(file);
        const servers = json?.mcpServers || json?.servers;
        if (!servers || typeof servers !== "object") continue;
        for (const [name, cfg] of Object.entries(servers)) {
            if (!looksLikeOil(name, cfg)) continue;
            const env = cfg?.env || {};
            let p = env.OBSIDIAN_VAULT_PATH;
            if (typeof p === "string") {
                p = p.replace(/\$\{(?:env:)?([A-Z0-9_]+)\}/gi, (_, k) => process.env[k] ?? "${" + k + "}");
            }
            const argVault = (cfg?.args || []).find?.((a) => typeof a === "string" && a.startsWith("--vault="));
            add(p || (argVault ? argVault.slice("--vault=".length) : null), `${label} → ${name}`);
        }
    }
    return [...found.values()].map((v) => ({ ...v, exists: existsSync(v.path), isVault: isObsidianVault(v.path) }));
}

function looksLikeOil(name, cfg) {
    if (/\boil\b|obsidian-intelligence/i.test(name)) return true;
    const blob = JSON.stringify(cfg?.args || []) + (cfg?.command || "");
    return /obsidian-intelligence-layer/i.test(blob);
}

export function isObsidianVault(path) {
    try {
        return statSync(join(path, ".obsidian")).isDirectory();
    } catch {
        return false;
    }
}

// ── Persisted settings ──────────────────────────────────────────────────

const DEFAULT_SETTINGS = { vaultPath: null, useVaultTheme: true };

function settingsFile() {
    return join(artifactsDir(), "settings.json");
}

export function loadSettings() {
    return { ...DEFAULT_SETTINGS, ...(readJson(settingsFile()) || {}) };
}

export function saveSettings(settings) {
    const dir = artifactsDir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `settings.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, settingsFile());
    return settings;
}

// ── Vault appearance (theme + enabled CSS snippets) ─────────────────────

/** Collect the vault's active community theme and enabled snippets so notes render like they do in Obsidian. */
export function loadVaultAppearance(vaultPath) {
    const obsidianDir = join(vaultPath, ".obsidian");
    const appearance = readJson(join(obsidianDir, "appearance.json")) || {};
    const parts = [];
    let themeName = appearance.cssTheme || null;
    if (themeName) {
        const css =
            readCss(join(obsidianDir, "themes", themeName, "theme.css")) ??
            readCss(join(obsidianDir, "themes", `${themeName}.css`));
        if (css) parts.push(`/* theme: ${themeName} */\n${css}`);
        else themeName = null;
    }
    const snippets = [];
    for (const name of appearance.enabledCssSnippets || []) {
        const css = readCss(join(obsidianDir, "snippets", `${name}.css`));
        if (css) {
            snippets.push(name);
            parts.push(`/* snippet: ${name} */\n${css}`);
        }
    }
    return {
        themeName,
        snippets,
        // "obsidian" is Obsidian's dark base theme, "moonstone" its light one.
        baseTheme: appearance.theme === "obsidian" ? "dark" : appearance.theme === "moonstone" ? "light" : "system",
        accentColor: typeof appearance.accentColor === "string" ? appearance.accentColor : null,
        baseFontSize: typeof appearance.baseFontSize === "number" ? appearance.baseFontSize : null,
        css: parts.join("\n\n"),
    };
}

function readCss(file) {
    try {
        const st = statSync(file);
        if (!st.isFile() || st.size > MAX_CSS_BYTES) return null;
        // A stray "</style" would let theme text break out of the <style> element.
        return readFileSync(file, "utf8").replace(/<\/style/gi, "<\\/style");
    } catch {
        return null;
    }
}

// ── Folder browser for the setup flow ───────────────────────────────────

export function browseRoots() {
    const home = homedir();
    const roots = [{ label: "Home", path: home }];
    for (const name of ["Documents", "OneDrive", "Desktop"]) {
        const p = join(home, name);
        if (existsSync(p)) roots.push({ label: name, path: p });
    }
    for (const entry of safeReaddir(home)) {
        if (entry.isDirectory() && /^OneDrive - /.test(entry.name)) roots.push({ label: entry.name, path: join(home, entry.name) });
    }
    if (platform() === "win32") {
        for (let c = 67; c <= 90; c++) {
            const drive = `${String.fromCharCode(c)}:\\`;
            if (existsSync(drive)) roots.push({ label: drive, path: drive });
        }
    } else {
        roots.push({ label: "/", path: "/" });
        if (platform() === "darwin" && existsSync("/Volumes")) roots.push({ label: "Volumes", path: "/Volumes" });
    }
    return roots;
}

/** Subdirectories of `path`, flagging which ones are Obsidian vaults. Directory names only; file contents are never read. */
export function listDirectory(path) {
    const abs = resolve(path || homedir());
    const st = statSync(abs);
    if (!st.isDirectory()) throw new Error("Not a directory");
    const entries = [];
    let noteCount = 0;
    for (const e of safeReaddir(abs)) {
        if (e.isFile() && e.name.endsWith(".md")) noteCount++;
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name.startsWith("$")) continue;
        const full = join(abs, e.name);
        entries.push({ name: e.name, path: full, isVault: isObsidianVault(full) });
    }
    entries.sort((a, b) => Number(b.isVault) - Number(a.isVault) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const parent = dirname(abs);
    return {
        path: abs,
        name: basename(abs) || abs,
        parent: parent === abs || parsePath(abs).root === abs ? null : parent,
        isVault: isObsidianVault(abs),
        noteCount,
        entries,
    };
}

function safeReaddir(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}
