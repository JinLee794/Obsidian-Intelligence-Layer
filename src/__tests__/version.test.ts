/**
 * The server version is duplicated in `src/version.ts` and `package.json`.
 *
 * A published server that reports the wrong version through `get_health` is
 * hard to notice and confusing to debug, and a comment asking people to keep two
 * files in sync is not a mechanism.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

describe("version metadata", () => {
  it("matches the package manifest", async () => {
    const manifest = JSON.parse(await readFile(resolve(REPO_ROOT, "package.json"), "utf-8"));
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  it("uses the unscoped package name as the server identity", async () => {
    const manifest = JSON.parse(await readFile(resolve(REPO_ROOT, "package.json"), "utf-8"));
    expect(manifest.name.endsWith(SERVER_NAME)).toBe(true);
  });

  it("is a semver triple, optionally with a prerelease tag", () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("has a changelog entry for the current version", async () => {
    const changelog = await readFile(resolve(REPO_ROOT, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain(`## [${SERVER_VERSION}]`);
  });
});
