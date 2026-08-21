/**
 * `doctor` — the exit code and the verdict wording.
 *
 * These tests exist because the model check used to report `ok` and exit 0 for
 * a model that was not there. That reads as a pass, and it is not one: whether
 * an absent model is harmless depends on whether the name is real and the
 * machine is online, neither of which `doctor` can see from Ollama's tag list.
 *
 * Both futures were observed on a live Ollama during the fix. `all-minilm`,
 * absent but real, was pulled on first use and the tier came up with 384-dim
 * vectors. `definitely-not-a-real-model` returned HTTP 500 from the pull and
 * the tier stayed unavailable for the life of the process. Same `doctor`
 * output before this change; opposite outcomes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor } from "../doctor.js";
import { clearFlagOrigins } from "../config.js";

/** Ollama stands in as a tag list; that is all `doctor` asks it for. */
async function startOllamaStub(models: string[]): Promise<{ server: Server; endpoint: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

describe("doctor — exit code and verdict", () => {
  let vault: string;
  let stub: { server: Server; endpoint: string };
  let lines: string[];
  let restoreLog: () => void;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), "oil-doctor-"));
    stub = await startOllamaStub(["nomic-embed-text:latest"]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    await rm(vault, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearFlagOrigins();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OIL_") || key === "OBSIDIAN_VAULT_PATH") delete process.env[key];
    }
    process.env.OBSIDIAN_VAULT_PATH = vault;
    process.env.OIL_SEMANTIC_ENDPOINT = stub.endpoint;

    lines = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    restoreLog = () => void (console.log = original);
  });

  afterEach(() => {
    restoreLog();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OIL_") || key === "OBSIDIAN_VAULT_PATH") delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  const output = () => lines.join("\n");

  it("passes, and says so, when the model is installed", async () => {
    process.env.OIL_SEMANTIC_MODEL = "nomic-embed-text";
    const code = await runDoctor();
    expect(code).toBe(0);
    expect(output()).toContain("ok    model: nomic-embed-text is installed");
    expect(output()).toContain("All checks passed");
  });

  it("does not claim a pass, or exit 0, when the model is absent", async () => {
    process.env.OIL_SEMANTIC_MODEL = "some-model-nobody-installed";
    const code = await runDoctor();

    // The defect in one assertion: this used to be 0.
    expect(code).not.toBe(0);
    expect(code).toBe(2);
    expect(output()).toContain("warn  model:");
    expect(output()).not.toContain("All checks passed");
  });

  it("declines to predict that an absent model will be pulled successfully", async () => {
    process.env.OIL_SEMANTIC_MODEL = "some-model-nobody-installed";
    await runDoctor();

    // The old wording promised an outcome doctor cannot know. A pull of a name
    // that is not in the registry returns HTTP 500 and the tier never comes up.
    expect(output()).not.toMatch(/will be pulled on first use/);
    expect(output()).toContain("unverified");
    expect(output()).toMatch(/ollama pull some-model-nobody-installed/);
  });

  it("separates a failure from something merely unconfirmed", async () => {
    process.env.OIL_SEMANTIC_ENDPOINT = "http://127.0.0.1:1";
    const code = await runDoctor();
    expect(code).toBe(1);
    expect(output()).toContain("FAIL  ollama:");
  });

  it("exits 1, not 2, when the vault is the thing that is wrong", async () => {
    process.env.OBSIDIAN_VAULT_PATH = join(vault, "no-such-directory");
    const code = await runDoctor();
    expect(code).toBe(1);
    expect(output()).toContain("FAIL  vault:");
  });

  it("stays green with the semantic tier off, so opting out is not an error", async () => {
    // `scripts/package-smoke.mjs` gates on exactly this.
    process.env.OIL_SEMANTIC = "off";
    const code = await runDoctor();
    expect(code).toBe(0);
    expect(output()).toContain("ok    semantic tier: disabled by configuration");
  });
});
