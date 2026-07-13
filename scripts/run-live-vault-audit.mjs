import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
if (!vaultPath) {
  console.error("OBSIDIAN_VAULT_PATH is required for the read-only live vault audit.");
  process.exit(1);
}

const resolvedVault = resolve(vaultPath);
if (!existsSync(resolvedVault)) {
  console.error(`Vault path does not exist: ${resolvedVault}`);
  process.exit(1);
}

const vitest = process.platform === "win32"
  ? resolve("node_modules/.bin/vitest.cmd")
  : resolve("node_modules/.bin/vitest");

const result = spawnSync(
  vitest,
  ["run", "live-vault-audit", "--pool=threads", "--reporter=verbose"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      OBSIDIAN_VAULT_PATH: resolvedVault,
      OIL_RUN_LIVE_VAULT_AUDIT: "1",
    },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
