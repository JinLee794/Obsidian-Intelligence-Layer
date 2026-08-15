/**
 * Tests for config.ts — defaults, snake_case remapping, legacy key aliases,
 * and the environment overrides an MCP client uses to configure a connection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadConfig, applyEnvOverrides, DEFAULT_CONFIG } from "../config.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-config-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function vaultWithConfig(name: string, yaml: string): Promise<string> {
  const root = join(tempDir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "oil.config.yaml"), yaml, "utf-8");
  return root;
}

describe("loadConfig", () => {
  it("falls back to defaults when no config file exists", async () => {
    const root = join(tempDir, "bare");
    await mkdir(root, { recursive: true });
    const config = await loadConfig(root);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("remaps snake_case keys and merges over defaults", async () => {
    const root = await vaultWithConfig(
      "snake",
      "schema:\n  customers_root: \"Accounts/\"\naudit:\n  log_all_writes: false\n",
    );
    const config = await loadConfig(root);
    expect(config.schema.customersRoot).toBe("Accounts/");
    expect(config.audit.logAllWrites).toBe(false);
    // Untouched keys keep their defaults
    expect(config.schema.peopleRoot).toBe(DEFAULT_CONFIG.schema.peopleRoot);
  });

  it("accepts the legacy write_gate block as audit", async () => {
    const root = await vaultWithConfig(
      "legacy",
      "write_gate:\n  log_all_writes: false\n",
    );
    const config = await loadConfig(root);
    expect(config.audit.logAllWrites).toBe(false);
  });

  it("prefers audit over legacy write_gate regardless of key order", async () => {
    const legacyFirst = await vaultWithConfig(
      "both-legacy-first",
      "write_gate:\n  log_all_writes: true\naudit:\n  log_all_writes: false\n",
    );
    const auditFirst = await vaultWithConfig(
      "both-audit-first",
      "audit:\n  log_all_writes: false\nwrite_gate:\n  log_all_writes: true\n",
    );
    expect((await loadConfig(legacyFirst)).audit.logAllWrites).toBe(false);
    expect((await loadConfig(auditFirst)).audit.logAllWrites).toBe(false);
  });

  it("defaults log_all_writes to true when the block is absent", async () => {
    const root = await vaultWithConfig("no-audit", "schema:\n  weekly_root: \"Reviews/\"\n");
    const config = await loadConfig(root);
    expect(config.audit.logAllWrites).toBe(true);
  });
});

describe("applyEnvOverrides", () => {
  it("leaves config untouched when nothing is set", () => {
    expect(applyEnvOverrides(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG);
  });

  it("disables the semantic tier from the environment", () => {
    for (const value of ["off", "false", "0", "no", "disabled", "OFF"]) {
      const config = applyEnvOverrides(DEFAULT_CONFIG, { OIL_SEMANTIC: value });
      expect(config.semantic.enabled, value).toBe(false);
    }
  });

  it("enables the semantic tier from the environment", () => {
    const disabled = { ...DEFAULT_CONFIG, semantic: { ...DEFAULT_CONFIG.semantic, enabled: false } };
    for (const value of ["on", "true", "1", "yes", "enabled"]) {
      expect(applyEnvOverrides(disabled, { OIL_SEMANTIC: value }).semantic.enabled, value).toBe(true);
    }
  });

  it("overrides endpoint, model and score floor", () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      OIL_SEMANTIC_ENDPOINT: "http://127.0.0.1:9999",
      OIL_SEMANTIC_MODEL: "mxbai-embed-large",
      OIL_SEMANTIC_MIN_SCORE: "0.7",
    });
    expect(config.semantic.endpoint).toBe("http://127.0.0.1:9999");
    expect(config.semantic.model).toBe("mxbai-embed-large");
    expect(config.semantic.minScore).toBe(0.7);
  });

  it("ignores unparseable values rather than guessing", () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      OIL_SEMANTIC: "maybe",
      OIL_SEMANTIC_MIN_SCORE: "high",
    });
    expect(config.semantic.enabled).toBe(DEFAULT_CONFIG.semantic.enabled);
    expect(config.semantic.minScore).toBe(DEFAULT_CONFIG.semantic.minScore);
  });

  it("ignores empty values, so an unset client variable is not an override", () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      OIL_SEMANTIC: "",
      OIL_SEMANTIC_ENDPOINT: undefined,
    });
    expect(config.semantic.enabled).toBe(DEFAULT_CONFIG.semantic.enabled);
    expect(config.semantic.endpoint).toBe(DEFAULT_CONFIG.semantic.endpoint);
  });

  it("does not mutate the config it was given", () => {
    const original = structuredClone(DEFAULT_CONFIG);
    applyEnvOverrides(DEFAULT_CONFIG, { OIL_SEMANTIC: "off" });
    expect(DEFAULT_CONFIG).toEqual(original);
  });
});

describe("loadConfig — environment precedence", () => {
  it("lets the environment win over oil.config.yaml", async () => {
    const root = await vaultWithConfig(
      "env-precedence",
      "semantic:\n  enabled: true\n  model: \"from-yaml\"\n",
    );

    process.env.OIL_SEMANTIC = "off";
    process.env.OIL_SEMANTIC_MODEL = "from-env";
    try {
      const config = await loadConfig(root);
      expect(config.semantic.enabled).toBe(false);
      expect(config.semantic.model).toBe("from-env");
    } finally {
      delete process.env.OIL_SEMANTIC;
      delete process.env.OIL_SEMANTIC_MODEL;
    }
  });

  it("still reads oil.config.yaml for anything the environment omits", async () => {
    const root = await vaultWithConfig(
      "env-partial",
      "semantic:\n  model: \"from-yaml\"\n  min_score: 0.9\n",
    );

    process.env.OIL_SEMANTIC = "off";
    try {
      const config = await loadConfig(root);
      expect(config.semantic.enabled).toBe(false);
      expect(config.semantic.model).toBe("from-yaml");
      expect(config.semantic.minScore).toBe(0.9);
    } finally {
      delete process.env.OIL_SEMANTIC;
    }
  });
});
