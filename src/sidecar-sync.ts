/**
 * OIL — Sidecars in a cloud-synced vault
 *
 * The graph and vector sidecars live in the vault root so every machine that
 * opens the vault shares one index. When two machines rewrite the same file
 * before the sync client has reconciled them, the client keeps both and renames
 * one: OneDrive appends the machine name (`_oil-graph-DESKTOP-ABC.json`,
 * `_oil-vectors-Jin's MacBook Pro (2).json`), Dropbox adds "conflicted copy",
 * Google Drive appends ` (1)`, Syncthing inserts `.sync-conflict-…`. Nothing ever
 * reads those copies, so left alone they accumulate per machine as pure bloat.
 *
 * This module finds them so the owning index can fold anything useful back into
 * the canonical file and delete the rest, and it compares mtimes the way synced
 * files actually report them.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/** How a sync client decorates the name of a file it had to fork. */
const CONFLICT_MIDDLE = /^(?:-.+|\s\(.+\)|\.sync-conflict-.+)$/;

/** Temp files younger than this may belong to a save still in flight. */
const STALE_TEMP_MS = 60_000;

/**
 * Sync-conflict copies of the sidecar at `fullPath`, as absolute paths.
 *
 * Matches by name only; callers confirm a candidate is really one of their own
 * files by parsing it before acting on it.
 */
export async function findConflictCopies(fullPath: string): Promise<string[]> {
  const dir = dirname(fullPath);
  const base = basename(fullPath);
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      if (name === base || !name.startsWith(stem) || !name.endsWith(ext)) return false;
      if (name.endsWith(".tmp")) return false;
      return CONFLICT_MIDDLE.test(name.slice(stem.length, name.length - ext.length));
    })
    .map((name) => join(dir, name));
}

/** Delete files, ignoring any already gone. Returns how many were removed. */
export async function removeFiles(paths: string[]): Promise<number> {
  const results = await Promise.all(
    paths.map((path) =>
      unlink(path).then(
        () => true,
        () => false,
      ),
    ),
  );
  return results.filter(Boolean).length;
}

/**
 * Remove temp files orphaned when a process was killed between write and
 * rename. Only sweeps files old enough not to belong to a live save.
 */
export async function sweepStaleTemps(fullPath: string): Promise<void> {
  try {
    const dir = dirname(fullPath);
    const prefix = `${basename(fullPath)}.`;
    const cutoff = Date.now() - STALE_TEMP_MS;
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
        .map(async (name) => {
          const candidate = join(dir, name);
          const info = await stat(candidate).catch(() => null);
          if (info && info.mtimeMs < cutoff) await unlink(candidate).catch(() => {});
        }),
    );
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Whether two mtimes describe the same write.
 *
 * Machines sharing a synced vault do not report mtimes at the same precision:
 * OneDrive on macOS truncates to whole seconds where Windows keeps sub-millisecond
 * values. Compared exactly, every note looks modified whenever the index crosses
 * machines, so each one re-reads the vault and rewrites the shared index — which
 * is how the sync client ends up forking it. A whole-second value is therefore
 * treated as equal to any finer value that truncates to it.
 */
export function sameMtime(a: number, b: number): boolean {
  if (Math.abs(a - b) <= 1) return true;
  if (a % 1000 === 0) return Math.floor(b / 1000) * 1000 === a;
  if (b % 1000 === 0) return Math.floor(a / 1000) * 1000 === b;
  return false;
}
