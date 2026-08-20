/**
 * OIL — MCP Server
 * Obsidian Intelligence Layer server entry point.
 *
 * Startup sequence: config → tools → transport connected → vault hydrates in
 * the background. The handshake deliberately precedes all vault work: a stdio
 * server that indexes before it connects makes its own availability a function
 * of vault size and filesystem latency, and a client that times out waiting
 * cannot tell "slow" from "broken".
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOilServer } from "./server.js";

async function main(): Promise<void> {
  // ── Resolve vault path ─────────────────────────────────────────────────
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error(
      "Error: OBSIDIAN_VAULT_PATH environment variable is required.\n" +
        "Set it to the absolute path of your Obsidian vault.",
    );
    process.exit(1);
  }

  console.error(`[OIL] Starting — vault: ${vaultPath}`);

  installProcessGuards();

  const oil = await createOilServer(vaultPath);
  console.error("[OIL] Tools registered.");

  // ── Connect transport before touching the vault ────────────────────────
  const transport = new StdioServerTransport();
  await oil.server.connect(transport);
  console.error("[OIL] MCP server ready — indexing vault in background.");

  oil.hydration.begin();

  // ── Graceful shutdown ──────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[OIL] Shutting down...");
    await oil.shutdown().catch((err) => console.error("[OIL] Shutdown error:", err));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The ordinary end of an MCP session is the client closing stdin, which
  // raises no signal at all. Without this the shutdown path — and the index
  // save it performs — only ran when someone killed the process by hand.
  oil.server.server.onclose = () => void shutdown();
}

/**
 * Keep the server alive through faults that are not its business to die on.
 *
 * chokidar emits `error` for EMFILE, ENOSPC and permission failures — routine
 * on a synced or virus-scanned vault — and an EventEmitter with no `error`
 * listener throws. Node 20+ likewise exits on an unhandled rejection. Either
 * would take down a server that is otherwise perfectly able to answer, so both
 * are logged loudly and survived instead.
 */
function installProcessGuards(): void {
  process.on("uncaughtException", (err) => {
    console.error("[OIL] Uncaught exception — server continues:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[OIL] Unhandled rejection — server continues:", reason);
  });
}

main().catch((err) => {
  console.error("[OIL] Fatal error:", err);
  process.exit(1);
});
