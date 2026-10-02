/**
 * OIL — Archive tool
 *
 * One tool for the whole lifecycle so the surface stays small: preview what the
 * vault's rules would archive, run them, or put notes back.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig } from "../types.js";
import { applyArchive, archiveStatus, planArchive, restoreArchived } from "../archive.js";
import { errorCodeFromUnknown, errorResponse, jsonResponse, truncateList } from "../tool-responses.js";
import { validateVaultPath, validationError } from "../validation.js";

export function registerArchiveTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  cache: SessionCache,
  config: OilConfig,
): void {
  server.registerTool(
    "manage_archive",
    {
      description:
        "Archive notes per the vault's oil.config.yaml `archive` rules. plan previews (no writes), apply archives, restore brings a note or a whole run back.",
      inputSchema: {
        action: z.enum(["plan", "apply", "restore"]).describe("plan | apply | restore"),
        path: z.string().optional().describe("restore: archived or original note path"),
        run_id: z.string().optional().describe("restore: undo every note from this run"),
      },
    },
    async ({ action, path, run_id }) => {
      try {
        if (action === "plan") {
          const plan = await planArchive(vaultPath, graph, config);
          const candidates = truncateList(plan.candidates);
          const kept = truncateList(plan.protected);
          return jsonResponse({
            enabled: plan.enabled,
            mode: plan.mode,
            root: plan.root,
            would_archive: plan.candidates.length,
            deferred: plan.deferred,
            candidates: candidates.items.map((c) => ({
              path: c.path,
              target: c.target,
              rule: c.rule,
              age_days: c.ageDays,
            })),
            ...(candidates.truncated ? { candidates_truncated: true } : {}),
            protected: kept.items,
            ...(kept.truncated ? { protected_truncated: true } : {}),
            ...(plan.enabled
              ? { next_step: "Call manage_archive with action: apply to archive these notes." }
              : { next_step: "Archiving is disabled. Set archive.enabled: true in oil.config.yaml to apply." }),
          });
        }

        if (action === "apply") {
          const result = await applyArchive(vaultPath, graph, config, { cache });
          const archived = truncateList(result.archived);
          return jsonResponse({
            run_id: result.runId,
            mode: result.mode,
            archived_count: result.archived.length,
            archived: archived.items,
            ...(archived.truncated ? { archived_truncated: true } : {}),
            skipped: result.skipped,
            links_rewritten: result.linksRewritten,
            breadcrumbs: result.breadcrumbs,
            deferred: result.deferred,
            status: await archiveStatus(vaultPath, graph, config),
          });
        }

        if (!path && !run_id) {
          return validationError("manage_archive: restore needs `path` or `run_id`.");
        }
        if (path) {
          const pathErr = validateVaultPath(path);
          if (pathErr) return validationError(`manage_archive: path — ${pathErr}`);
        }
        const result = await restoreArchived(
          vaultPath,
          graph,
          config,
          { path, runId: run_id },
          { cache },
        );
        return jsonResponse({
          run_id: result.runId,
          restored_count: result.restored.length,
          restored: result.restored.map(({ from, to }) => ({ from, to })),
          skipped: result.skipped,
          links_rewritten: result.linksRewritten,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const disabled = /disabled/i.test(message);
        return errorResponse(
          disabled ? "CAPABILITY_MISSING" : errorCodeFromUnknown(err),
          `manage_archive (${action}): ${message}`,
          {},
          disabled
            ? { retryable: false, next_step: "Set archive.enabled: true in oil.config.yaml, then restart OIL." }
            : undefined,
        );
      }
    },
  );
}
