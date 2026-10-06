import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { realpathSync } from "node:fs";

export function copilotHome() {
    return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

/** Per-user storage for settings and the analytics database. */
export function artifactsDir() {
    return join(copilotHome(), "extensions", "oil-canvas", "artifacts");
}

export function sessionStateDir() {
    return join(copilotHome(), "session-state");
}

/** Normalize a vault-relative note path to forward slashes without a leading slash. */
export function normalizeNotePath(p) {
    if (typeof p !== "string") return null;
    const trimmed = p.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
    if (!trimmed || trimmed.split("/").includes("..")) return null;
    return trimmed;
}

/**
 * Resolve a vault-relative path to an absolute path, refusing anything that
 * escapes the vault (including via symlinks once the target exists).
 */
export function resolveInVault(vaultPath, notePath) {
    const rel = normalizeNotePath(notePath);
    if (!vaultPath || !rel) return null;
    const root = resolve(vaultPath);
    const abs = resolve(root, rel);
    if (!isInside(root, abs)) return null;
    try {
        const realRoot = realpathSync(root);
        const realAbs = realpathSync(abs);
        if (!isInside(realRoot, realAbs)) return null;
    } catch {
        // Target may not exist yet (e.g. before create_note); the lexical check above suffices.
    }
    return abs;
}

function isInside(root, abs) {
    const r = relative(root, abs);
    return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}
