/**
 * OIL — Domain tools (v0.5.1)
 *
 * Cherry-picked high-value domain tools from v0.4 orient + composite modules.
 * These embed deterministic business logic that the LLM cannot reliably
 * reconstruct from generic primitives:
 *
 *   1. get_customer_context — deterministic assembly of customer state
 *   2. prepare_crm_prefetch — exact OData filter construction from vault IDs
 *   3. check_vault_health   — encoded business rules for hygiene scoring
 *
 * Combined with v0.5's 7 generic primitives (retrieve + write), this gives
 * a 10-tool surface: low schema overhead, high accuracy on critical paths.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig, CustomerContext, NoteRef, ActionItem } from "../types.js";
import { validateCustomerName, validationError } from "../validation.js";
import {
  readNote,
  parseTeam,
  parseActionItems,
  resolveCustomerPath,
  readOpportunityNotes,
  readMilestoneNotes,
  readInsightsPartitioned,
  readMeetingsFromFrontmatter,
} from "../vault.js";
import { extractPrefetchIds } from "../correlate.js";
import { checkVaultHealth } from "../hygiene.js";

/**
 * Register the 3 high-value domain tools on the MCP server.
 */
export function registerDomainTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  cache: SessionCache,
  config: OilConfig,
): void {
  // ── get_customer_context ──────────────────────────────────────────────

  server.registerTool(
    "get_customer_context",
    {
      description:
        "Full assembled context for a named customer — frontmatter, opportunities with GUIDs, milestones, team composition, recent meetings, linked people, open action items, and optionally similar customers.",
      inputSchema: {
        customer: z.string().describe("Customer name or folder name under Customers/"),
        lookback_days: z
          .number()
          .optional()
          .describe("How far back to pull meetings/activity (default 90)"),
        include_similar: z
          .boolean()
          .optional()
          .describe("Include similar customer patterns by shared tags (default: false)"),
        include_open_items: z
          .boolean()
          .optional()
          .describe("Include open action items across linked notes (default: true)"),
        assignee: z
          .string()
          .optional()
          .describe("Filter open items to a specific person"),
      },
    },
    async ({ customer, lookback_days, include_similar, include_open_items, assignee }) => {
      const custErr = validateCustomerName(customer);
      if (custErr) return validationError(`get_customer_context: ${custErr}`);

      const lookback = lookback_days ?? 90;
      const customerFile = await resolveCustomerPath(vaultPath, config, customer);

      // Read customer note (with cache)
      let parsed = cache.getNote(customerFile);
      if (!parsed) {
        try {
          parsed = await readNote(vaultPath, customerFile);
          cache.putNote(customerFile, parsed);
        } catch {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Customer file not found: ${customerFile}` }),
              },
            ],
          };
        }
      }

      // Parse structured sections
      const teamSection = parsed.sections.get("Team") ?? "";
      const connectSection = parsed.sections.get("Connect Hooks") ?? "";

      // Read entities — prefers sub-notes, falls back to section parsing
      const opportunities = await readOpportunityNotes(vaultPath, config, customer);
      const milestones = await readMilestoneNotes(vaultPath, config, customer);
      const team = parseTeam(teamSection);

      // Agent Insights — partitioned sub-notes first, fallback to monolithic section
      const insightsResult = await readInsightsPartitioned(vaultPath, config, customer);
      let agentInsights: string[];
      if (insightsResult.partitioned) {
        agentInsights = insightsResult.entries;
      } else {
        const insightsSection = parsed.sections.get("Agent Insights") ?? "";
        agentInsights = insightsSection
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => l.replace(/^[-*]\s+/, "").trim());
      }

      // Linked people: find People notes that reference this customer (graph-indexed)
      const linkedPeople = findLinkedPeople(graph, config, customer);

      // Recent meetings — prefer frontmatter index (O(1)), fall back to graph scan
      const fmMeetings = readMeetingsFromFrontmatter(parsed.frontmatter, lookback);
      const recentMeetings = fmMeetings ?? findRecentMeetings(graph, config, customer, lookback);

      // Open action items (default: included)
      let openItems: ActionItem[] = [];
      if (include_open_items !== false) {
        openItems = await findOpenItems(vaultPath, graph, config, customer, cache);
        if (assignee) {
          openItems = openItems.filter(
            (i) => i.assignee && i.assignee.toLowerCase() === assignee.toLowerCase(),
          );
        }
      }

      // Similar customers (by shared tags, opt-in)
      let similarCustomers: NoteRef[] = [];
      if (include_similar && parsed.tags.length > 0) {
        const customerNotes = graph.getNotesByFolder(config.schema.customersRoot);
        similarCustomers = customerNotes.filter((ref) => {
          if (ref.path === customerFile) return false;
          const node = graph.getNode(ref.path);
          if (!node) return false;
          return parsed!.tags.some((t) => node.tags.includes(t));
        });
      }

      const result: CustomerContext = {
        frontmatter: parsed.frontmatter as CustomerContext["frontmatter"],
        opportunities,
        milestones,
        team,
        agentInsights,
        connectHooks: connectSection || null,
        linkedPeople,
        recentMeetings,
        openItems,
        similarCustomers,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── prepare_crm_prefetch ──────────────────────────────────────────────

  server.registerTool(
    "prepare_crm_prefetch",
    {
      description:
        "Extracts all vault-known MSX identifiers (opportunity GUIDs, TPIDs, account IDs, milestone IDs) for one or more customers. Returns structured data with OData filter hints ready for CRM query construction.",
      inputSchema: {
        customers: z
          .array(z.string())
          .describe("Customer names to extract IDs for"),
      },
    },
    async ({ customers }) => {
      for (const c of customers) {
        const custErr = validateCustomerName(c);
        if (custErr) return validationError(`prepare_crm_prefetch: customer '${c}' — ${custErr}`);
      }

      const prefetchData = await extractPrefetchIds(vaultPath, graph, config, cache, customers);

      // Shape for copilot: include OData filter hints
      const shaped = prefetchData.map((p) => ({
        ...p,
        odata_hints: {
          opportunity_filter: p.opportunityGuids.length
            ? p.opportunityGuids
                .map((g: string) => `_msp_opportunityid_value eq '${g}'`)
                .join(" or ")
            : null,
          account_filter: p.tpid ? `_msp_accountid_value eq '${p.tpid}'` : null,
        },
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { prefetch: shaped, _note: "Use odata_hints directly in crm_query $filter expressions." },
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
      description:
        "Comprehensive vault health report. Surfaces stale Agent Insights (>30d), incomplete opportunity/milestone IDs, missing sections, orphaned meetings, and roster gaps.",
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

      const report = await checkVaultHealth(vaultPath, graph, config, cache, customers);

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
                summary:
                  issues.length > 0
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
}

// ─── Helpers (ported from orient.ts) ────────────────────────────────────────

function findLinkedPeople(
  graph: GraphIndex,
  config: OilConfig,
  customer: string,
): NoteRef[] {
  const peopleNotes = graph.getNotesByFolder(config.schema.peopleRoot);
  return peopleNotes.filter((note) => {
    const node = graph.getNode(note.path);
    if (!node) return false;
    const customers = node.frontmatter.customers;
    if (Array.isArray(customers)) {
      return customers.some(
        (c) => typeof c === "string" && c.toLowerCase() === customer.toLowerCase(),
      );
    }
    return false;
  });
}

function findRecentMeetings(
  graph: GraphIndex,
  config: OilConfig,
  customer: string,
  lookbackDays: number,
): NoteRef[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const meetingNotes = graph.getNotesByFolder(config.schema.meetingsRoot);
  return meetingNotes.filter((note) => {
    const node = graph.getNode(note.path);
    if (!node) return false;

    const fm = node.frontmatter;
    const noteCustomer = fm[config.frontmatterSchema.customerField];
    if (
      typeof noteCustomer !== "string" ||
      noteCustomer.toLowerCase() !== customer.toLowerCase()
    ) {
      return false;
    }

    const dateStr = fm[config.frontmatterSchema.dateField];
    if (typeof dateStr === "string") {
      const noteDate = new Date(dateStr);
      return noteDate >= cutoff;
    }
    return true;
  });
}

async function findOpenItems(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  customer: string,
  cache: SessionCache,
): Promise<ActionItem[]> {
  const items: ActionItem[] = [];

  const customerFile = await resolveCustomerPath(vaultPath, config, customer);
  const forwardLinks = graph.getForwardLinks(customerFile);
  const backlinks = graph.getBacklinks(customerFile);
  const meetingNotes = findRecentMeetings(graph, config, customer, 90);

  const allPaths = new Set<string>();
  allPaths.add(customerFile);
  for (const ref of [...forwardLinks, ...backlinks, ...meetingNotes]) {
    allPaths.add(ref.path);
  }

  for (const notePath of allPaths) {
    let parsed = cache.getNote(notePath);
    if (!parsed) {
      try {
        parsed = await readNote(vaultPath, notePath);
        cache.putNote(notePath, parsed);
      } catch {
        continue;
      }
    }
    const noteItems = parseActionItems(parsed.content, notePath);
    items.push(...noteItems.filter((item) => !item.done));
  }

  return items;
}
