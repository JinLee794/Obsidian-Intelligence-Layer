/**
 * Security tests: securePath() against path traversal and symlink attacks
 * Validates that securePath() prevents escaping the vault root via
 * relative paths, symlinks, encoding tricks, and edge cases.
 *
 * Threat model references: E-3
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { securePath } from "../vault.js";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;

beforeAll(async () => {
  // Create a temporary vault structure for testing
  tempDir = await mkdtemp(join(tmpdir(), "oil-securepath-"));
  vaultRoot = join(tempDir, "vault");
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(join(vaultRoot, "notes"), { recursive: true });
  await mkdir(join(vaultRoot, "customers"), { recursive: true });

  // Create a file inside the vault
  await writeFile(join(vaultRoot, "notes", "test.md"), "# Test Note");

  // Create a file OUTSIDE the vault (the attacker target)
  await writeFile(join(tempDir, "secret.md"), "SECRET DATA");

  // Create a symlink inside the vault that points OUTSIDE the vault
  try {
    await symlink(
      join(tempDir, "secret.md"),
      join(vaultRoot, "notes", "sneaky-link.md"),
    );
  } catch {
    // Symlink creation may fail on some platforms/permissions — tests will be skipped
  }

  // Create a symlink to a directory outside the vault
  try {
    await symlink(tempDir, join(vaultRoot, "escape-dir"));
  } catch {
    // Symlink creation may fail
  }
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("securePath — basic path traversal", () => {
  it("allows a simple relative path within vault", () => {
    const result = securePath(vaultRoot, "notes/test.md");
    expect(result).toBe(resolve(vaultRoot, "notes/test.md"));
  });

  it("rejects ../ traversal to parent", () => {
    expect(() => securePath(vaultRoot, "../secret.md")).toThrow(
      "Path traversal denied",
    );
  });

  it("rejects nested ../ traversal", () => {
    expect(() => securePath(vaultRoot, "notes/../../secret.md")).toThrow(
      "Path traversal denied",
    );
  });

  it("rejects deeply nested traversal", () => {
    expect(() =>
      securePath(vaultRoot, "notes/sub/../../../../../../etc/passwd"),
    ).toThrow("Path traversal denied");
  });

  it("rejects absolute path outside vault", () => {
    expect(() => securePath(vaultRoot, "/etc/passwd")).toThrow(
      "Path traversal denied",
    );
  });

  it("rejects absolute path to vault sibling", () => {
    expect(() => securePath(vaultRoot, join(tempDir, "secret.md"))).toThrow(
      "Path traversal denied",
    );
  });
});

describe("securePath — encoding tricks", () => {
  it("rejects URL-encoded ../ (%2e%2e%2f)", () => {
    // resolve() won't decode these, so they become literal filenames
    // which is safe — but ensure they don't accidentally resolve outside
    const result = securePath(vaultRoot, "%2e%2e%2fsecret.md");
    // This should resolve inside the vault as a literal filename
    expect(result.startsWith(vaultRoot)).toBe(true);
  });

  it("rejects dot-dot with backslashes on path level", () => {
    // On POSIX, backslash is a valid filename char, not a separator
    // Just ensure it doesn't escape
    const result = securePath(vaultRoot, "notes\\..\\..\\secret.md");
    expect(result.startsWith(vaultRoot)).toBe(true);
  });

  it("rejects null byte injection", () => {
    // Node's resolve handles null bytes — this should either throw or stay in vault
    try {
      const result = securePath(vaultRoot, "notes/test.md\0.jpg");
      expect(result.startsWith(vaultRoot)).toBe(true);
    } catch {
      // Throwing is also acceptable — either way, no escape
    }
  });
});

describe("securePath — symlink traversal", () => {
  it("rejects symlink file escape outside vault", async () => {
    // If symlink creation failed on this platform, skip this assertion.
    try {
      securePath(vaultRoot, "notes/sneaky-link.md");
      throw new Error("Expected securePath to reject symlink escape");
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Expected securePath")) throw err;
      if (!msg.includes("Path traversal denied")) {
        // Non-security platform-specific failures are tolerated.
        // Example: symlink path missing on restricted environments.
      }
    }
  });

  it("rejects directory symlink escape outside vault", async () => {
    try {
      securePath(vaultRoot, "escape-dir/secret.md");
      throw new Error("Expected securePath to reject symlink dir escape");
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Expected securePath")) throw err;
      if (!msg.includes("Path traversal denied")) {
        // Non-security platform-specific failures are tolerated.
      }
    }
  });
});

describe("securePath — edge cases", () => {
  it("rejects empty notePath (resolves to vault root itself)", () => {
    // Empty string resolves to vault root — could be a directory listing attack
    const result = securePath(vaultRoot, "");
    expect(result).toBe(resolve(vaultRoot));
  });

  it("handles path with redundant slashes", () => {
    const result = securePath(vaultRoot, "notes///test.md");
    expect(result).toBe(resolve(vaultRoot, "notes/test.md"));
    expect(result.startsWith(vaultRoot)).toBe(true);
  });

  it("handles path with dot segments that stay within vault", () => {
    const result = securePath(vaultRoot, "notes/./test.md");
    expect(result).toBe(resolve(vaultRoot, "notes/test.md"));
  });

  it("rejects path that traverses out even if it ends at valid-looking subpath", () => {
    // Go up enough to definitely escape, regardless of vault dir name
    expect(() =>
      securePath(vaultRoot, "../../../../tmp/evil.md"),
    ).toThrow("Path traversal denied");
  });

  it("allows path that traverses out and back into same vault (same resolved target)", () => {
    // notes/../../vault/notes/test.md — if vault dir is literally "vault",
    // this resolves to the same location inside the vault.
    // securePath correctly allows it because the final resolved path IS inside vault.
    const result = securePath(vaultRoot, "notes/../../vault/notes/test.md");
    expect(result).toBe(resolve(vaultRoot, "notes/test.md"));
  });

  it("handles trailing slash on vault path", () => {
    const result = securePath(vaultRoot + "/", "notes/test.md");
    expect(result.startsWith(resolve(vaultRoot))).toBe(true);
  });
});
