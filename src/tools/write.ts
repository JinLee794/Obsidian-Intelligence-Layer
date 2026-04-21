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
import {
  errorCodeFromUnknown,
  errorResponse,
  jsonResponse,
  noteRef,
} from "../tool-responses.js";
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
      if (pathErr) {
        return validationError(
          `atomic_append: ${pathErr}`,
          "INVALID_INPUT",
          {
            retryable: true,
            next_step:
              "Use a vault-relative path like Customers/Contoso.md without ../ segments or absolute prefixes, then retry atomic_append.",
          },
        );
      }
      if (!Number.isFinite(expected_mtime)) {
        return validationError(
          "atomic_append: expected_mtime must be a finite number",
          "INVALID_INPUT",
          {
            retryable: true,
            suggested_tools: ["get_note_metadata"],
            next_step:
              "Call get_note_metadata on the target note and retry atomic_append with its mtime_ms as expected_mtime.",
          },
        );
      }

      try {
        return await withWriteLock(path, async () => {
          const before = await getMtime(vaultPath, path);
          if (!mtimeMatches(before, expected_mtime)) {
            return errorResponse(
              "CONFLICT",
              "Stale write rejected: expected_mtime does not match current file state",
              {
                path,
                ref: noteRef(path, heading),
                expected_mtime,
                current_mtime: before,
              },
              {
                retryable: true,
                suggested_tools: ["get_note_metadata"],
                next_step:
                  "Call get_note_metadata on the same path to fetch the latest mtime_ms, then retry atomic_append with that fresh value.",
              },
            );
          }

          await appendToSection(vaultPath, path, heading, content, "append");
          cache.invalidateNote(path);

          const after = await getMtime(vaultPath, path);

          // Audit log (fire-and-forget)
          try {
            await logWrite(vaultPath, config, {
              tier: "auto",
              operation: "atomic_append",
              path,
              detail: `append to §${heading} (mtime ${before} → ${after})`,
            });
          } catch {}

          return jsonResponse({
            status: "executed",
            path,
            ref: noteRef(path, heading),
            heading,
            previous_mtime: before,
            mtime_ms: after,
            version: after,
          });
        });
      } catch (err) {
        return errorResponse(
          errorCodeFromUnknown(err),
          `Failed to append: ${err instanceof Error ? err.message : String(err)}`,
          { path, ref: noteRef(path, heading) },
        );
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
      if (pathErr) {
        return validationError(
          `atomic_replace: ${pathErr}`,
          "INVALID_INPUT",
          {
            retryable: true,
            next_step:
              "Use a vault-relative path like Customers/Contoso.md without ../ segments or absolute prefixes, then retry atomic_replace.",
          },
        );
      }
      if (!Number.isFinite(expected_mtime)) {
        return validationError(
          "atomic_replace: expected_mtime must be a finite number",
          "INVALID_INPUT",
          {
            retryable: true,
            suggested_tools: ["get_note_metadata"],
            next_step:
              "Call get_note_metadata on the target note and retry atomic_replace with its mtime_ms as expected_mtime.",
          },
        );
      }

      try {
        return await withWriteLock(path, async () => {
          const before = await getMtime(vaultPath, path);
          if (!mtimeMatches(before, expected_mtime)) {
            return errorResponse(
              "CONFLICT",
              "Stale write rejected: expected_mtime does not match current file state",
              {
                path,
                ref: noteRef(path),
                expected_mtime,
                current_mtime: before,
              },
              {
                retryable: true,
                suggested_tools: ["get_note_metadata"],
                next_step:
                  "Call get_note_metadata on the same path to fetch the latest mtime_ms, then retry atomic_replace with that fresh value.",
              },
            );
          }

          await executeWrite(vaultPath, path, content, "overwrite");
          cache.invalidateNote(path);

          const after = await getMtime(vaultPath, path);

          // Audit log (fire-and-forget)
          try {
            await logWrite(vaultPath, config, {
              tier: "auto",
              operation: "atomic_replace",
              path,
              detail: `full replace (mtime ${before} → ${after})`,
            });
          } catch {}

          return jsonResponse({
            status: "executed",
            path,
            ref: noteRef(path),
            previous_mtime: before,
            mtime_ms: after,
            version: after,
          });
        });
      } catch (err) {
        return errorResponse(
          errorCodeFromUnknown(err),
          `Failed to replace: ${err instanceof Error ? err.message : String(err)}`,
          { path, ref: noteRef(path) },
        );
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
      if (pathErr) {
        return validationError(
          `create_note: ${pathErr}`,
          "INVALID_INPUT",
          {
            retryable: true,
            next_step:
              "Use a vault-relative path like Daily/2026-03-19.md without ../ segments or absolute prefixes, then retry create_note.",
          },
        );
      }

      try {
        return await withWriteLock(path, async () => {
          const exists = await noteExists(vaultPath, path);
          if (exists) {
            return errorResponse(
              "CONFLICT",
              "Note already exists — use atomic_replace to update it",
              { path, ref: noteRef(path) },
              {
                retryable: false,
                suggested_tools: ["get_note_metadata", "atomic_replace"],
                next_step:
                  "If you intended to update this note, call get_note_metadata for the current mtime_ms and then use atomic_replace instead of create_note.",
              },
            );
          }

          await executeWrite(vaultPath, path, content, "create");
          cache.invalidateNote(path);

          try {
            await logWrite(vaultPath, config, {
              tier: "auto",
              operation: "create_note",
              path,
              detail: "created new note",
            });
          } catch {}

          // Wait for mtime to stabilize — Obsidian may touch new files
          // within ~1-2s (indexing, metadata injection). Returning before
          // it settles would give the agent a stale mtime.
          const after = await getStableMtime(vaultPath, path);
          return jsonResponse({
            status: "created",
            path,
            ref: noteRef(path),
            mtime_ms: after,
            version: after,
          });
        });
      } catch (err) {
        return errorResponse(
          errorCodeFromUnknown(err),
          `Failed to create: ${err instanceof Error ? err.message : String(err)}`,
          { path, ref: noteRef(path) },
        );
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
        return jsonResponse({
          date: dateStr,
          path: logPath,
          ref: noteRef(logPath),
          log: content,
        });
      } catch {
        return jsonResponse({
          date: dateStr,
          path: logPath,
          ref: noteRef(logPath),
          log: null,
          message: "No log entries for this date.",
        });
      }
    },
  );
}

async function getMtime(vaultPath: string, path: string): Promise<number> {
  const fullPath = securePath(vaultPath, path);
  const fileStats = await stat(fullPath);
  return fileStats.mtimeMs;
}

/**
 * Wait for the file mtime to stabilize (stop changing).
 * Obsidian's file watcher can touch newly created/written files within ~1-2s
 * (indexing, metadata injection). If we return the mtime before it settles,
 * the agent's next atomic write will fail with "Stale write rejected".
 *
 * Strategy: wait `settleDelayMs` (default 1s) to let Obsidian's watcher fire,
 * then poll in `intervalMs` steps until two consecutive reads match or
 * `maxWaitMs` is exhausted.
 */
async function getStableMtime(
  vaultPath: string,
  path: string,
  maxWaitMs = 4000,
  settleDelayMs = 1000,
  intervalMs = 300,
): Promise<number> {
  // Let Obsidian's file-watcher debounce fire before we start checking
  await new Promise((r) => setTimeout(r, settleDelayMs));

  let prev = await getMtime(vaultPath, path);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const cur = await getMtime(vaultPath, path);
    if (mtimeMatches(cur, prev)) return cur;
    prev = cur;
  }
  return prev;
}

function mtimeMatches(current: number, expected: number): boolean {
  // File systems can vary by sub-millisecond precision.
  return Math.abs(current - expected) <= 1;
}

const writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = path.replace(/\\/g, "/");
  const prior = writeLocks.get(key) ?? Promise.resolve();

  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);

  writeLocks.set(key, queued);
  await prior;

  try {
    return await work();
  } finally {
    release?.();
    if (writeLocks.get(key) === queued) {
      writeLocks.delete(key);
    }
  }
}
