/**
 * Cross-process index lock — the lease that keeps parallel sessions from all
 * indexing the same vault at once.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { acquireIndexLock, lockPath } from "../index-lock.js";

let tempDir: string;
const quiet = { log: () => {} };

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-lock-"));
  process.env.OIL_LOCK_DIR = join(tempDir, "locks");
});

afterAll(async () => {
  delete process.env.OIL_LOCK_DIR;
  delete process.env.OIL_INDEX_LOCK;
  await rm(tempDir, { recursive: true, force: true });
});

describe("acquireIndexLock", () => {
  it("lets exactly one holder in and turns the rest away without waiting", async () => {
    const vault = join(tempDir, "v1");
    const first = await acquireIndexLock(vault, "embed", quiet);
    const second = await acquireIndexLock(vault, "embed", quiet);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first!.release();

    const third = await acquireIndexLock(vault, "embed", quiet);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it("scopes leases by vault and by job", async () => {
    const a = await acquireIndexLock(join(tempDir, "va"), "graph", quiet);
    const b = await acquireIndexLock(join(tempDir, "vb"), "graph", quiet);
    const c = await acquireIndexLock(join(tempDir, "va"), "embed", quiet);
    expect([a, b, c].every(Boolean)).toBe(true);
    await Promise.all([a!.release(), b!.release(), c!.release()]);
  });

  it("queues a waiter behind the holder and reports that it waited", async () => {
    const vault = join(tempDir, "v2");
    const holder = await acquireIndexLock(vault, "graph", quiet);
    const waiting = acquireIndexLock(vault, "graph", { ...quiet, wait: true, pollMs: 20 });

    await new Promise((r) => setTimeout(r, 80));
    await holder!.release();

    const lease = await waiting;
    expect(lease).not.toBeNull();
    expect(lease!.waited).toBe(true);
    await lease!.release();
  });

  it("stops waiting after maxWaitMs rather than stranding the session", async () => {
    const vault = join(tempDir, "v3");
    const holder = await acquireIndexLock(vault, "graph", quiet);
    const lease = await acquireIndexLock(vault, "graph", {
      ...quiet,
      wait: true,
      pollMs: 10,
      maxWaitMs: 50,
    });
    expect(lease).not.toBeNull();
    expect(lease!.waited).toBe(true);
    await lease!.release();
    // Giving up never deletes the real holder's lease.
    expect(await holder!.held()).toBe(true);
    await holder!.release();
  });

  it("reclaims a lease whose heartbeat stopped, even from a live pid", async () => {
    const vault = join(tempDir, "v4");
    const path = lockPath(vault, "embed");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, host: hostname(), token: "old", job: "embed" }),
    );
    const past = new Date(Date.now() - 5 * 60_000);
    await utimes(path, past, past);

    const lease = await acquireIndexLock(vault, "embed", quiet);
    expect(lease).not.toBeNull();
    await lease!.release();
  });

  it("is a no-op when OIL_INDEX_LOCK=off", async () => {
    process.env.OIL_INDEX_LOCK = "off";
    try {
      const vault = join(tempDir, "v5");
      const a = await acquireIndexLock(vault, "embed", quiet);
      const b = await acquireIndexLock(vault, "embed", quiet);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    } finally {
      delete process.env.OIL_INDEX_LOCK;
    }
  });
});
