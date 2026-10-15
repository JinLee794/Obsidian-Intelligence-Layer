/**
 * OIL — Cross-process index lock
 *
 * Every MCP client session spawns its own stdio OIL process. On a machine with
 * many parallel sessions they all start together, and each one used to walk the
 * vault and send every changed note to Ollama at the same moment — N copies of
 * the most expensive work OIL does, all producing the same sidecar files.
 *
 * This lock makes that work a per-vault singleton. One process (the leader)
 * holds a lease file and does the indexing; the others either wait for it
 * (graph rebuild, which they need before they can serve) or skip it and pick up
 * the leader's persisted output (embeddings, which are optional).
 *
 * The lease lives in the OS temp directory, not the vault: a vault is often
 * cloud-synced, and a lock file synced to another machine is a lock held by a
 * process that does not exist there.
 *
 * Liveness is judged two ways so a crashed holder never wedges the vault:
 * the holder's pid is probed, and the holder refreshes the file's mtime on a
 * heartbeat — a lease whose heartbeat has stopped is stale even if its pid has
 * been recycled by an unrelated process.
 */

import { createHash, randomBytes } from "node:crypto";
import { unlinkSync, readFileSync } from "node:fs";
import { open, readFile, stat, unlink, utimes, mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type IndexJob = "graph" | "embed" | "archive";

export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  job: IndexJob;
  vault: string;
  acquiredAt: string;
}

export interface IndexLease {
  /** True when this process had to wait for another holder first. */
  readonly waited: boolean;
  /** False once another process has taken the lease over (e.g. after a stall). */
  held(): Promise<boolean>;
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** Wait for the current holder instead of returning null. */
  wait?: boolean;
  /** Give up waiting after this long and proceed without the lock. */
  maxWaitMs?: number;
  pollMs?: number;
  /** A lease whose heartbeat is older than this is treated as abandoned. */
  staleMs?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 15 * 60_000;

/** `OIL_INDEX_LOCK=off` restores the old every-process-indexes behaviour. */
export function indexLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OIL_INDEX_LOCK?.trim().toLowerCase();
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

export function lockDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.OIL_LOCK_DIR?.trim() || join(tmpdir(), "oil-locks");
}

/** One lock per vault and job. Case-folded on Windows, where paths are. */
export function lockPath(vaultPath: string, job: IndexJob, env = process.env): string {
  let key = resolve(vaultPath);
  if (process.platform === "win32") key = key.toLowerCase();
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(lockDirectory(env), `${digest}-${job}.lock`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(path: string): Promise<{ owner: LockOwner | null; raw: string; mtimeMs: number } | null> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf-8"), stat(path)]);
    let owner: LockOwner | null = null;
    try {
      owner = JSON.parse(raw) as LockOwner;
    } catch {
      // A holder that died between create and write leaves an empty file.
    }
    return { owner, raw, mtimeMs: info.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Describe the current holder, for logs and health output. */
export async function describeHolder(vaultPath: string, job: IndexJob): Promise<string | null> {
  const current = await readOwner(lockPath(vaultPath, job)).catch(() => null);
  if (!current?.owner) return null;
  return `pid ${current.owner.pid} since ${current.owner.acquiredAt}`;
}

function isStale(
  current: { owner: LockOwner | null; mtimeMs: number },
  staleMs: number,
): boolean {
  if (Date.now() - current.mtimeMs > staleMs) return true;
  const owner = current.owner;
  if (!owner) return Date.now() - current.mtimeMs > 5_000;
  // A pid from another host cannot be probed; rely on the heartbeat alone.
  if (owner.host !== hostname()) return false;
  return !pidAlive(owner.pid);
}

/** Leases this process holds, removed synchronously if it exits uncleanly. */
const heldPaths = new Map<string, string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [path, token] of heldPaths) {
      try {
        const owner = JSON.parse(readFileSync(path, "utf-8")) as LockOwner;
        if (owner.token === token) unlinkSync(path);
      } catch {
        // Already gone, or someone else's now.
      }
    }
  });
}

async function tryCreate(path: string, owner: LockOwner): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(owner), "utf-8");
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Take the lease for `job` on `vaultPath`.
 *
 * Returns null when another live process holds it and `wait` is false. With
 * `wait`, polls until the holder releases or goes stale; after `maxWaitMs` it
 * returns a no-op lease so a wedged holder can delay a session but never strand
 * it. Lock-directory failures likewise degrade to a no-op lease: coordination is
 * an optimisation and must never be the reason a server cannot index.
 */
export async function acquireIndexLock(
  vaultPath: string,
  job: IndexJob,
  options: AcquireOptions = {},
): Promise<IndexLease | null> {
  const log = options.log ?? ((message: string) => console.error(message));
  if (!indexLockEnabled()) return unlockedLease(false);

  const path = lockPath(vaultPath, job);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.min(DEFAULT_HEARTBEAT_MS, staleMs / 3);

  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: randomBytes(8).toString("hex"),
    job,
    vault: resolve(vaultPath),
    acquiredAt: new Date().toISOString(),
  };

  try {
    await mkdir(lockDirectory(), { recursive: true });
  } catch (err) {
    log(`[OIL] Index lock unavailable (${(err as Error).message}) — indexing without coordination.`);
    return unlockedLease(false);
  }

  const started = Date.now();
  let waited = false;
  let announced = false;

  for (;;) {
    try {
      if (await tryCreate(path, owner)) {
        return heldLease(path, owner, waited, heartbeatMs);
      }
      const current = await readOwner(path);
      if (current && isStale(current, staleMs)) {
        // Re-read immediately before removing so a lease that was just
        // re-created by a faster process is not deleted out from under it.
        const again = await readOwner(path);
        if (again && again.raw === current.raw) {
          log(
            `[OIL] Index lock (${job}) held by ${current.owner ? `pid ${current.owner.pid}` : "an unknown process"} is stale — taking over.`,
          );
          await unlink(path).catch(() => {});
        }
        continue;
      }
      if (!current) continue; // Released between our create and read.

      if (!options.wait) return null;
      waited = true;
      if (!announced) {
        announced = true;
        log(
          `[OIL] Another OIL process (pid ${current.owner?.pid ?? "?"}) is running the ${job} job for this vault — waiting for it.`,
        );
      }
      if (Date.now() - started >= maxWaitMs) {
        log(`[OIL] Gave up waiting for the ${job} lock after ${Math.round(maxWaitMs / 1000)}s — proceeding without it.`);
        return unlockedLease(true);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    } catch (err) {
      log(`[OIL] Index lock error (${(err as Error).message}) — indexing without coordination.`);
      return unlockedLease(waited);
    }
  }
}

function unlockedLease(waited: boolean): IndexLease {
  return {
    waited,
    held: async () => true,
    release: async () => {},
  };
}

function heldLease(path: string, owner: LockOwner, waited: boolean, heartbeatMs: number): IndexLease {
  installExitHook();
  heldPaths.set(path, owner.token);

  let lost = false;
  const isOurs = async (): Promise<boolean> => {
    if (lost) return false;
    const current = await readOwner(path).catch(() => null);
    if (current?.owner?.token === owner.token) return true;
    lost = true;
    return false;
  };

  const heartbeat = setInterval(() => {
    void (async () => {
      if (!(await isOurs())) {
        clearInterval(heartbeat);
        return;
      }
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
    })();
  }, heartbeatMs);
  heartbeat.unref?.();

  let released = false;
  return {
    waited,
    held: isOurs,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      heldPaths.delete(path);
      if (await isOurs()) await unlink(path).catch(() => {});
    },
  };
}
