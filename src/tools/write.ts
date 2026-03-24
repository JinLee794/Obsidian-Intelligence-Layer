/**
 * OIL — Write tools (v2)
 * Atomic writes with strict mtime checks and audit logging.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig } from "../types.js";
import { validateVaultPath, validationError } from "../validation.js";
import { securePath, noteExists } from "../vault.js";
import { appendToSection, executeWrite, logWrite } from "../gate.js";

/**
 * Register all Write tools on the MCP server.
 */
export function registerWriteTools(
  server: McpServer,
  vaultPath: string,
  _graph: GraphIndex,
  cache: SessionCache,
  config: OilConfig,
): void {
  // ── atomic_append ─────────────────────────────────────────────────────

  server.registerTool(
    "atomic_append",
    {
      description:
        "Append content to a heading section only if the file mtime matches expected_mtime.",
      inputSchema: {
        path: z.string().describe("Note path within the vault"),
        heading: z.string().describe("Heading to append under"),
        content: z.string().describe("Content to append"),
        expected_mtime: z
          .number()
          .describe("Expected file modification timestamp in milliseconds (use get_note_metadata.mtime_ms)"),
      },
    },
    async ({ path, heading, content, expected_mtime }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`atomic_append: ${pathErr}`);
      if (!Number.isFinite(expected_mtime)) {
        return validationError("atomic_append: expected_mtime must be a finite number");
      }

      try {
        const before = await getMtime(vaultPath, path);
        if (!mtimeMatches(before, expected_mtime)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Stale write rejected: expected_mtime does not match current file state",
                  expected_mtime,
                  current_mtime: before,
                }),
              },
            ],
          };
        }

        await appendToSection(vaultPath, path, heading, content, "append");
        cache.invalidateNote(path);

        const after = await getMtime(vaultPath, path);

        // Audit log (fire-and-forget)
        logWrite(vaultPath, config, {
          tier: "auto",
          operation: "atomic_append",
          path,
          detail: `append to §${heading} (mtime ${before} → ${after})`,
        }).catch(() => {});

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "executed",
                  path,
                  heading,
                  previous_mtime: before,
                  mtime_ms: after,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to append: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }
    },
  );

  // ── atomic_replace ────────────────────────────────────────────────────

  server.registerTool(
    "atomic_replace",
    {
      description:
        "Replace full note content only if the file mtime matches expected_mtime.",
      inputSchema: {
        path: z.string().describe("Note path within the vault"),
        content: z.string().describe("Full replacement content"),
        expected_mtime: z
          .number()
          .describe("Expected file modification timestamp in milliseconds (use get_note_metadata.mtime_ms)"),
      },
    },
    async ({ path, content, expected_mtime }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`atomic_replace: ${pathErr}`);
      if (!Number.isFinite(expected_mtime)) {
        return validationError("atomic_replace: expected_mtime must be a finite number");
      }

      try {
        const before = await getMtime(vaultPath, path);
        if (!mtimeMatches(before, expected_mtime)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Stale write rejected: expected_mtime does not match current file state",
                  expected_mtime,
                  current_mtime: before,
                }),
              },
            ],
          };
        }

        await executeWrite(vaultPath, path, content, "overwrite");
        cache.invalidateNote(path);

        const after = await getMtime(vaultPath, path);

        // Audit log (fire-and-forget)
        logWrite(vaultPath, config, {
          tier: "auto",
          operation: "atomic_replace",
          path,
          detail: `full replace (mtime ${before} → ${after})`,
        }).catch(() => {});

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "executed",
                  path,
                  previous_mtime: before,
                  mtime_ms: after,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to replace: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }
    },
  );

  // ── create_note ───────────────────────────────────────────────────────

  server.registerTool(
    "create_note",
    {
      description:
        "Create a new note in the vault. Fails if the note already exists — use atomic_replace to update existing notes.",
      inputSchema: {
        path: z.string().describe("Note path within the vault (e.g. Daily/2026-03-19.md)"),
        content: z.string().describe("Full content for the new note"),
      },
    },
    async ({ path, content }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`create_note: ${pathErr}`);

      try {
        const exists = await noteExists(vaultPath, path);
        if (exists) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Note already exists — use atomic_replace to update it",
                  path,
                }),
              },
            ],
          };
        }

        await executeWrite(vaultPath, path, content, "create");
        cache.invalidateNote(path);

        const after = await getMtime(vaultPath, path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "created",
                  path,
                  mtime_ms: after,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to create: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }
    },
  );

  // ── get_agent_log ───────────────────────────────────────────────────

  server.registerTool(
    "get_agent_log",
    {
      description:
        "Read the agent audit log for a given date. Returns all logged write operations with timestamps, paths, and details.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe("Date in YYYY-MM-DD format (default: today)"),
      },
    },
    async ({ date }) => {
      const dateStr = date ?? new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return validationError("get_agent_log: date must be YYYY-MM-DD format");
      }

      const logPath = `${config.schema.agentLog}${dateStr}.md`;
      try {
        const fullPath = securePath(vaultPath, logPath);
        const content = await readFile(fullPath, "utf-8");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ date: dateStr, path: logPath, log: content }, null, 2),
            },
          ],
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ date: dateStr, path: logPath, log: null, message: "No log entries for this date." }),
            },
          ],
        };
      }
    },
  );
}

async function getMtime(vaultPath: string, path: string): Promise<number> {
  const fullPath = securePath(vaultPath, path);
  const fileStats = await stat(fullPath);
  return fileStats.mtimeMs;
}

function mtimeMatches(current: number, expected: number): boolean {
  // File systems can vary by sub-millisecond precision.
  return Math.abs(current - expected) <= 1;
}
