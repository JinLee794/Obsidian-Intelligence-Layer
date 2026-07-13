import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateVault } from "../../bench/fixtures/generate-vault.js";
import { listAllNotes } from "../vault.js";

describe("synthetic vault generator cardinality", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the requested number of unique benchmark notes plus one audit note", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oil-generator-cardinality-"));
    const vaultPath = join(tempDir, "vault");
    const generated = await generateVault({ noteCount: 2_000, outputDir: vaultPath });
    const actual = await listAllNotes(vaultPath);

    expect(generated.noteCount).toBe(2_000);
    expect(actual.length).toBe(2_001);
    expect(new Set(actual).size).toBe(actual.length);
  }, 30_000);
});