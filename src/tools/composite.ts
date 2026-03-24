/**
 * OIL — Composite tools (Phase 3)
 * Cross-MCP support: prefetch, correlate, promote, hygiene, drift.
 * These tools shape vault data for copilot orchestration across MCPs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig } from "../types.js";
import { validateCustomerName, validationError } from "../validation.js";
import { listFolder, noteExists, resolveCustomerPath, looksLikeTpid, resolveCustomerByTpid } from "../vault.js";
import { extractPrefetchIds, correlateEntities, buildDriftSnapshot } from "../correlate.js";
import { checkVaultHealth, checkCustomerFreshness } from "../hygiene.js";
import {
  isAutoConfirmed,
  appendToSection,
  logWrite,
  generateDiff,
  queueGatedWrite,
} from "../gate.js";

/**
 * Register all Phase 3 composite tools on the MCP server.
 */
export function registerCompositeTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  cache: SessionCache,
  config: OilConfig,
): void {
  // ── prepare_crm_prefetch ──────────────────────────────────────────────

  server.registerTool(
    "prepare_crm_prefetch",
    {
      description: "VAULT-PREFETCH as a tool — extracts all vault-known MSX identifiers (opportunity GUIDs, TPIDs, account IDs, milestone IDs) for one or more customers. Returns structured data ready for CRM query construction.",
      inputSchema: {
        customers: z
          .array(z.string())
          .describe("Customer names to extract IDs for"),
      },
    },
    async ({ customers }) => {
      // Resolve TPIDs to customer names before validation
      const resolvedCustomers = customers.map((c) => {
        if (looksLikeTpid(c)) {
          return resolveCustomerByTpid(graph, config, c) ?? c;
        }
        return c;
      });

      for (const c of resolvedCustomers) {
        const custErr = validateCustomerName(c);
        if (custErr) return validationError(`prepare_crm_prefetch: customer '${c}' — ${custErr}`);
      }

      const prefetchData = await extractPrefetchIds(
        vaultPath, graph, config, cache, resolvedCustomers,
      );

      // Shape for copilot: include OData filter hints
      const shaped = prefetchData.map((p) => ({
        ...p,
        odata_hints: {
          opportunity_filter: p.opportunityGuids.length
            ? p.opportunityGuids
                .map((g) => `_msp_opportunityid_value eq '${g}'`)
                .join(" or ")
            : null,
          account_filter: p.tpid
            ? `_msp_accountid_value eq '${p.tpid}'`
            : null,
        },
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                prefetch: shaped,
                _note: "Use odata_hints directly in crm_query $filter expressions.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── correlate_with_vault ──────────────────────────────────────────────

  server.registerTool(
    "correlate_with_vault",
    {
      description: "VAULT-CORRELATE — cross-references external entities (people, customers, meetings, opportunities) with vault notes. Returns matched notes, people→customer associations, and unresolved entities.",
      inputSchema: {
        entities: z
          .array(
            z.object({
              name: z.string().describe("Entity name"),
              type: z
                .enum(["person", "customer", "meeting", "opportunity", "other"])
                .describe("Entity type"),
              date: z
                .string()
                .optional()
                .describe("Associated date (ISO format)"),
            }),
          )
          .describe("External entities to correlate"),
        date_range: z
          .object({
            start: z.string().describe("Start date (ISO)"),
            end: z.string().describe("End date (ISO)"),
          })
          .optional()
          .describe("Date range to scope correlation"),
      },
    },
    async ({ entities, date_range }) => {
      if (date_range) {
        const { isValidIsoDate } = await import("../validation.js");
        if (!isValidIsoDate(date_range.start)) return validationError("correlate_with_vault: date_range.start must be a valid ISO date");
        if (!isValidIsoDate(date_range.end)) return validationError("correlate_with_vault: date_range.end must be a valid ISO date");
      }

      const result = await correlateEntities(
        vaultPath, graph, config, cache, entities, date_range,
      );

      // Summarise for copilot
      const resolved = result.matches.filter((m) => m.confidence !== "unresolved");
      const unresolved = result.matches.filter((m) => m.confidence === "unresolved");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                matches: result.matches,
                peopleToCustomers: result.peopleToCustomers,
                summary: {
                  total: entities.length,
                  resolved: resolved.length,
                  unresolved: unresolved.length,
                  unresolvedNames: unresolved.map((u) => u.entity.name),
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── promote_findings ──────────────────────────────────────────────────

  server.registerTool(
    "promote_findings",
    {
      description: "VAULT-PROMOTE — batch-promotes validated findings to customer files. Auto-confirmed for designated sections (Agent Insights, Connect Hooks); gated for others. Generates a batch diff when multiple customers are affected.",
      inputSchema: {
        findings: z
          .array(
            z.object({
              customer: z.string().describe("Customer name"),
              section: z
                .string()
                .describe("Target section heading (e.g. 'Agent Insights')"),
              content: z.string().describe("Content to append"),
            }),
          )
          .describe("Validated findings to promote"),
      },
    },
    async ({ findings }) => {
      for (const f of findings) {
        const custErr = validateCustomerName(f.customer);
        if (custErr) return validationError(`promote_findings: customer '${f.customer}' — ${custErr}`);
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const executed: { customer: string; section: string; path: string }[] = [];
      const gatedItems: { customer: string; section: string; content: string; path: string }[] = [];

      for (const finding of findings) {
        const path = await resolveCustomerPath(vaultPath, config, finding.customer);

        // Datestamp the content
        const stamped = `- ${dateStr} ${finding.content}`;

        if (isAutoConfirmed(config, "patch_note", finding.section)) {
          // Tier 1 — execute immediately
          const exists = await noteExists(vaultPath, path);
          if (!exists) {
            // Can't auto-append to a non-existent file — queue it
            gatedItems.push({ ...finding, path });
            continue;
          }

          await appendToSection(vaultPath, path, finding.section, stamped);
          cache.invalidateNote(path);

          await logWrite(vaultPath, config, {
            tier: "auto",
            operation: "promote_findings",
            path,
            detail: `append to §${finding.section}`,
          });

          executed.push({ customer: finding.customer, section: finding.section, path });
        } else {
          gatedItems.push({ ...finding, path });
        }
      }

      // If there are gated items, generate a batch diff
      let batchWriteId: string | null = null;
      let batchDiff: string | null = null;

      if (gatedItems.length > 0) {
        const batchContent = gatedItems
          .map((g) => `### ${g.customer} → §${g.section}\n\n${g.content}`)
          .join("\n\n---\n\n");

        const diff = generateDiff(
          "promote_findings",
          `[batch: ${gatedItems.length} customer(s)]`,
          batchContent,
          false,
          gatedItems.map(
            (g) => `\`${g.path}\` § \`## ${g.section}\` ← append`,
          ),
        );

        // Store metadata so confirm can reconstruct per-file writes
        queueGatedWrite(cache, diff, {
          content: JSON.stringify({
            type: "batch_promote",
            items: gatedItems.map((g) => ({
              path: g.path,
              section: g.section,
              content: `- ${dateStr} ${g.content}`,
            })),
          }),
          mode: "append",
        });

        batchWriteId = diff.id;
        batchDiff = diff.diff;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                executed,
                pending: batchWriteId
                  ? { writeId: batchWriteId, diff: batchDiff, count: gatedItems.length }
                  : null,
                summary: `${executed.length} auto-confirmed, ${gatedItems.length} gated`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── check_vault_health ────────────────────────────────────────────────

  server.registerTool(
    "check_vault_health",
    {
      description: "VAULT-HYGIENE — comprehensive vault health report. Surfaces stale Agent Insights (>30d), incomplete opportunity/milestone IDs, missing sections, orphaned meetings, and roster gaps.",
      inputSchema: {
        customers: z
          .array(z.string())
          .optional()
          .describe("Filter to specific customers (default: all)"),
      },
    },
    async ({ customers }) => {
      if (customers) {
        for (const c of customers) {
          const custErr = validateCustomerName(c);
          if (custErr) return validationError(`check_vault_health: customer '${c}' — ${custErr}`);
        }
      }

      const report = await checkVaultHealth(
        vaultPath, graph, config, cache, customers,
      );

      // Build actionable summary
      const issues: string[] = [];

      for (const c of report.customers) {
        if (c.staleInsights.length > 0) {
          issues.push(
            `${c.customer}: ${c.staleInsights.length} stale Agent Insight(s) (oldest: ${c.staleInsights[0].ageDays}d)`,
          );
        }
        if (c.opportunityCompleteness.missingGuid.length > 0) {
          issues.push(
            `${c.customer}: ${c.opportunityCompleteness.missingGuid.length} opportunity(ies) missing GUIDs`,
          );
        }
        if (c.milestoneCompleteness.missingId.length > 0) {
          issues.push(
            `${c.customer}: ${c.milestoneCompleteness.missingId.length} milestone(s) missing IDs`,
          );
        }
        if (!c.hasTeam) {
          issues.push(`${c.customer}: no ## Team section`);
        }
      }

      if (report.orphanedMeetings.length > 0) {
        issues.push(
          `${report.orphanedMeetings.length} meeting(s) not linked to tracked customers`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                report,
                issues,
                summary: issues.length > 0
                  ? `${issues.length} issue(s) found across ${report.totalCustomers} customers`
                  : `All ${report.totalCustomers} customers healthy`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── get_drift_report ──────────────────────────────────────────────────

  server.registerTool(
    "get_drift_report",
    {
      description: "Structures vault-side opportunity, milestone, and team data for a customer so the copilot can compare against live CRM state. Returns a snapshot shaped for drift detection.",
      inputSchema: {
        customer: z.string().describe("Customer name"),
      },
    },
    async ({ customer }) => {
      const custErr = validateCustomerName(customer);
      if (custErr) return validationError(`get_drift_report: ${custErr}`);

      const snapshot = await buildDriftSnapshot(
        vaultPath, graph, config, cache, customer,
      );

      // Add comparison instructions for the copilot
      const comparisonHints = {
        _instructions: "Compare this vault snapshot against CRM live data:",
        checks: [
          "Vault opportunities vs CRM opportunities — flag any missing, new, or stage-changed",
          "Vault milestone IDs vs CRM milestones — flag ID mismatches or missing entries",
          "Vault team vs CRM deal team — flag membership changes",
          `Last Agent Insight: ${snapshot.lastAgentInsightDate ?? "none"} — flag if >30d stale`,
        ],
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                snapshot,
                comparisonHints,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
