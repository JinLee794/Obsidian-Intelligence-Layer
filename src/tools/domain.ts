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

import { stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig, CustomerContext, NoteRef, ActionItem } from "../types.js";
import { boundedJsonResponse, errorResponse, noteRef } from "../tool-responses.js";
import { validateCustomerName, validationError } from "../validation.js";
import {
  readNote,
  parseTeam,
  parseActionItems,
  resolveCustomerPath,
  securePath,
  readOpportunityNotes,
  readMilestoneNotes,
  readInsightsPartitioned,
  readMeetingsFromFrontmatter,
  looksLikeTpid,
  resolveCustomerByTpid,
} from "../vault.js";
import { extractPrefetchIds } from "../correlate.js";
import { checkVaultHealth } from "../hygiene.js";

const DOMAIN_LIST_MAX = 50;
const DOMAIN_REFS_MAX = 20;
const DOMAIN_TEXT_MAX = 1_500;

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
        view: z
          .enum(["brief", "full", "write"])
          .optional()
          .describe("Response profile: brief for compact context, full for default detail, write for deterministic write targets"),
        assignee: z
          .string()
          .optional()
          .describe("Filter open items to a specific person"),
      },
    },
    async ({ customer, lookback_days, include_similar, include_open_items, assignee, view }) => {
      const requestedView = view ?? "full";

      // Auto-resolve TPID to customer name
      let resolvedCustomer = customer;
      if (looksLikeTpid(customer)) {
        const found = resolveCustomerByTpid(graph, config, customer);
        if (!found) {
          return errorResponse(
            "NOT_FOUND",
            `No customer found for TPID "${customer}". Check the TPID or use the customer name directly.`,
            { customer },
            {
              retryable: true,
              suggested_tools: ["query_frontmatter", "get_customer_context"],
              next_step:
                "Retry get_customer_context with the customer name, or call query_frontmatter with key 'tpid' and a shorter value_fragment to inspect known TPIDs.",
            },
          );
        }
        resolvedCustomer = found;
      }

      const custErr = validateCustomerName(resolvedCustomer);
      if (custErr) return validationError(`get_customer_context: ${custErr}`);

      const requestedLookback = lookback_days ?? 90;
      const lookback = Math.min(Math.max(1, Math.floor(requestedLookback)), 3_650);
      let customerFile: string;
      let customerStats: Awaited<ReturnType<typeof stat>>;

      try {
        customerFile = await resolveCustomerPath(vaultPath, config, resolvedCustomer);
        customerStats = await stat(securePath(vaultPath, customerFile));
      } catch {
        return errorResponse("NOT_FOUND", `Customer file not found for ${resolvedCustomer}`, {
          customer: resolvedCustomer,
        });
      }

      // Read customer note (with cache)
      let parsed = cache.getNote(customerFile);
      if (!parsed) {
        try {
          parsed = await readNote(vaultPath, customerFile);
          cache.putNote(customerFile, parsed);
        } catch {
          return errorResponse("NOT_FOUND", `Customer file not found: ${customerFile}`, {
            customer: resolvedCustomer,
            customer_path: customerFile,
            customer_ref: noteRef(customerFile),
          });
        }
      }

      // Parse structured sections (try common heading variants)
      const teamSection = parsed.sections.get("Team")
        ?? parsed.sections.get("Microsoft Team")
        ?? parsed.sections.get("Key Stakeholders")
        ?? parsed.sections.get("Stakeholders")
        ?? "";
      const connectSection = parsed.sections.get("Connect Hooks") ?? "";

      // Read entities — prefers sub-notes, falls back to section parsing
      const opportunities = await readOpportunityNotes(vaultPath, config, resolvedCustomer);
      const milestones = await readMilestoneNotes(vaultPath, config, resolvedCustomer);
      const team = parseTeam(teamSection);

      // Agent Insights — partitioned sub-notes first, fallback to monolithic section
      const insightsResult = await readInsightsPartitioned(vaultPath, config, resolvedCustomer);
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
      const linkedPeople = findLinkedPeople(graph, config, resolvedCustomer);

      // Recent meetings — prefer frontmatter index (O(1)), fall back to graph scan
      const fmMeetings = readMeetingsFromFrontmatter(parsed.frontmatter, lookback);
      const recentMeetings = fmMeetings ?? findRecentMeetings(graph, config, resolvedCustomer, lookback);

      // Open action items (default: included)
      let openItems: ActionItem[] = [];
      if (include_open_items !== false) {
        openItems = await findOpenItems(vaultPath, graph, config, resolvedCustomer, cache);
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

      const truncation = {
        opportunities: opportunities.length > DOMAIN_LIST_MAX,
        milestones: milestones.length > DOMAIN_LIST_MAX,
        team: team.length > DOMAIN_LIST_MAX,
        agentInsights: agentInsights.length > DOMAIN_LIST_MAX,
        linkedPeople: linkedPeople.length > DOMAIN_REFS_MAX,
        recentMeetings: recentMeetings.length > DOMAIN_REFS_MAX,
        openItems: openItems.length > DOMAIN_LIST_MAX,
        similarCustomers: similarCustomers.length > DOMAIN_REFS_MAX,
      };
      const result: CustomerContext = {
        frontmatter: boundFrontmatter(parsed.frontmatter) as CustomerContext["frontmatter"],
        opportunities: opportunities.slice(0, DOMAIN_LIST_MAX),
        milestones: milestones.slice(0, DOMAIN_LIST_MAX),
        team: team.slice(0, DOMAIN_LIST_MAX),
        agentInsights: agentInsights.slice(0, DOMAIN_LIST_MAX),
        connectHooks: connectSection ? connectSection.slice(0, DOMAIN_TEXT_MAX) : null,
        linkedPeople: linkedPeople.slice(0, DOMAIN_REFS_MAX),
        recentMeetings: recentMeetings.slice(0, DOMAIN_REFS_MAX),
        openItems: openItems.slice(0, DOMAIN_LIST_MAX),
        similarCustomers: similarCustomers.slice(0, DOMAIN_REFS_MAX),
      };

      const envelope = {
        customer: resolvedCustomer,
        customer_path: customerFile,
        customer_ref: noteRef(customerFile),
        customer_mtime_ms: customerStats.mtimeMs,
        customer_version: customerStats.mtimeMs,
        view: requestedView,
        catalog: {
          generation: graph.generation,
          state: graph.indexState,
        },
        truncated: Object.values(truncation).some(Boolean),
        truncation,
        warnings: [
          ...(requestedLookback > 3_650 ? [`LIMIT_CLAMPED:${requestedLookback}->3650`] : []),
          ...(Object.values(truncation).some(Boolean) ? ["RESULTS_TRUNCATED"] : []),
        ],
      };

      if (requestedView === "brief") {
        return boundedJsonResponse({
          ...envelope,
          frontmatter: result.frontmatter,
          opportunities: result.opportunities,
          milestones: result.milestones,
          team: result.team,
          linkedPeople: result.linkedPeople,
          recentMeetings: result.recentMeetings,
          openItems: result.openItems,
          summary: {
            agent_insight_count: result.agentInsights.length,
            connect_hooks_present: Boolean(result.connectHooks),
            similar_customer_count: result.similarCustomers.length,
          },
        }, 3_200);
      }

      if (requestedView === "write") {
        return boundedJsonResponse({
          ...envelope,
          ...result,
          write_targets: {
            customer_note: customerFile,
            customer_ref: noteRef(customerFile),
            meetings_root: config.schema.meetingsRoot,
            headings: {
              agent_insights: "Agent Insights",
              connect_hooks: "Connect Hooks",
              team: "Team",
            },
          },
        }, 4_800);
      }

      return boundedJsonResponse({
        ...envelope,
        ...result,
      }, 4_800);
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
      if (customers.length > DOMAIN_LIST_MAX) {
        return errorResponse(
          "LIMIT_EXCEEDED",
          `prepare_crm_prefetch accepts at most ${DOMAIN_LIST_MAX} customers per call.`,
          { requested: customers.length, maximum: DOMAIN_LIST_MAX },
        );
      }
      for (const c of customers) {
        const custErr = validateCustomerName(c);
        if (custErr) return validationError(`prepare_crm_prefetch: customer '${c}' — ${custErr}`);
      }

      const prefetchData = await extractPrefetchIds(vaultPath, graph, config, cache, customers);

      // Shape for copilot: include OData filter hints
      const shaped = await Promise.all(
        prefetchData.map(async (p) => {
          let customerPath: string | null = null;
          try {
            customerPath = await resolveCustomerPath(vaultPath, config, p.customer);
          } catch {
            customerPath = null;
          }

          return {
            ...p,
            customer_path: customerPath,
            customer_ref: customerPath ? noteRef(customerPath) : null,
            odata_hints: {
              opportunity_filter: p.opportunityGuids.length
                ? p.opportunityGuids
                    .map((g: string) => `_msp_opportunityid_value eq '${g}'`)
                    .join(" or ")
                : null,
              account_filter: p.tpid ? `_msp_accountid_value eq '${p.tpid}'` : null,
            },
          };
        }),
      );

      return boundedJsonResponse({
        prefetch: shaped,
        _note: "Use odata_hints directly in crm_query $filter expressions.",
        catalog: { generation: graph.generation, state: graph.indexState },
      }, 4_800);
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
      if (customers && customers.length > DOMAIN_LIST_MAX) {
        return errorResponse(
          "LIMIT_EXCEEDED",
          `check_vault_health accepts at most ${DOMAIN_LIST_MAX} named customers per call.`,
          { requested: customers.length, maximum: DOMAIN_LIST_MAX },
        );
      }
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

      const boundedReport = {
        ...report,
        customers: report.customers.slice(0, DOMAIN_LIST_MAX),
        orphanedMeetings: report.orphanedMeetings.slice(0, DOMAIN_LIST_MAX),
        rosterGaps: report.rosterGaps.slice(0, DOMAIN_LIST_MAX),
        structuralIssues: report.structuralIssues.slice(0, DOMAIN_LIST_MAX),
      };
      const reportTruncated = report.customers.length > DOMAIN_LIST_MAX
        || report.orphanedMeetings.length > DOMAIN_LIST_MAX
        || report.rosterGaps.length > DOMAIN_LIST_MAX
        || report.structuralIssues.length > DOMAIN_LIST_MAX
        || issues.length > 100;

      return boundedJsonResponse({
        report: boundedReport,
        issues: issues.slice(0, 100),
        orphaned_meeting_refs: boundedReport.orphanedMeetings.map((path) => noteRef(path)),
        catalog_warnings: graph.getWarningCounts(),
        catalog_issues: graph.getCatalogIssues().slice(0, 20),
        catalog: { generation: graph.generation, state: graph.indexState },
        truncated: reportTruncated,
        warnings: reportTruncated ? ["RESULTS_TRUNCATED"] : [],
        summary:
          issues.length > 0
            ? `${issues.length} issue(s) found across ${report.totalCustomers} customers`
            : `All ${report.totalCustomers} customers healthy`,
      }, 4_800);
    },
  );
}

function boundFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter).sort(([a], [b]) => a.localeCompare(b))) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const bounded = serialized.length > 500 ? `${serialized.slice(0, 497)}...` : value;
    if (JSON.stringify({ ...result, [key]: bounded }).length > 2_000) break;
    result[key] = bounded;
  }
  return result;
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
