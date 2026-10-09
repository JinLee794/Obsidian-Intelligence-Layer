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

import { readdir, stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAliases, type GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig, CustomerContext, NoteRef, ActionItem } from "../types.js";
import { errorCodeFromUnknown, errorResponse, jsonResponse, noteRef } from "../tool-responses.js";
import { validateCustomerName, validationError } from "../validation.js";
import { normalizeValue } from "../frontmatter.js";
import {
  readNote,
  parseTeam,
  parseActionItems,
  resolveCustomerPath,
  customerNameFromPath,
  resolveEntityName,
  securePath,
  readOpportunityNotes,
  readMilestoneNotes,
  readInsightsPartitioned,
  readMeetingsFromFrontmatter,
  looksLikeTpid,
  resolveCustomerByTpid,
  resolveTeamSection,
  resolveConnectHooksSection,
  splitLines,
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
        customer: z.string().describe("Canonical customer name, unique hub title or declared alias, or TPID"),
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
      if (!resolvedCustomer.trim()) {
        return validationError("get_customer_context: Customer name must not be blank");
      }

      const lookback = lookback_days ?? 90;
      let customerFile: string;
      let customerStats: Awaited<ReturnType<typeof stat>>;

      try {
        const candidates = await findCustomerMatches(vaultPath, graph, config, resolvedCustomer);
        if (candidates.length > 1) {
          return errorResponse(
            "CONFLICT",
            `Ambiguous customer name "${customer}". Use an exact canonical customer name from the candidates.`,
            { customer, candidates },
            {
              retryable: true,
              suggested_tools: ["get_customer_context", "get_note_metadata"],
              next_step:
                "Choose a candidate's exact customer name and retry get_customer_context; use its customer_path to inspect the hub first.",
            },
          );
        }
        if (candidates[0]) resolvedCustomer = candidates[0].customer;

        const canonicalErr = validateCustomerName(resolvedCustomer);
        if (canonicalErr) return validationError(`get_customer_context: ${canonicalErr}`);

        customerFile = await resolveCustomerPath(vaultPath, config, resolvedCustomer);
        customerStats = await stat(securePath(vaultPath, customerFile));
      } catch (err) {
        return errorResponse(
          errorCodeFromUnknown(err),
          `Customer file could not be read for ${resolvedCustomer}: ${err instanceof Error ? err.message : String(err)}`,
          { customer: resolvedCustomer },
          {
            retryable: true,
            suggested_tools: ["query_frontmatter", "search_vault"],
            next_step:
              "Inspect customer hubs with search_vault or query_frontmatter (key 'aliases' or 'alias'), then retry with an exact canonical customer name or a unique declared alias. No fuzzy or parent-account mapping is applied.",
          },
        );
      }

      // Read customer note (with cache, revalidated against the file's mtime
      // so external edits are never served stale)
      let parsed = cache.getNote(customerFile, customerStats.mtimeMs);
      if (!parsed) {
        try {
          parsed = await readNote(vaultPath, customerFile);
          cache.putNote(customerFile, parsed, customerStats.mtimeMs);
        } catch (err) {
          return errorResponse(errorCodeFromUnknown(err), `Customer file could not be read: ${customerFile}`, {
            customer: resolvedCustomer,
            customer_path: customerFile,
          });
        }
      }

      // Parse structured sections (shared resolver — hygiene uses the same one)
      const teamSection = resolveTeamSection(parsed.sections);
      const connectSection = resolveConnectHooksSection(parsed.sections);

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
        agentInsights = splitLines(insightsSection)
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

      const envelope = {
        customer: resolvedCustomer,
        customer_path: customerFile,
        customer_mtime_ms: customerStats.mtimeMs,
        customer_version: customerStats.mtimeMs,
        view: requestedView,
      };

      if (requestedView === "brief") {
        return jsonResponse({
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
        });
      }

      if (requestedView === "write") {
        return jsonResponse({
          ...envelope,
          ...result,
          write_targets: {
            customer_note: customerFile,
            meetings_root: config.schema.meetingsRoot,
            headings: {
              agent_insights: "Agent Insights",
              connect_hooks: "Connect Hooks",
              team: "Team",
            },
          },
        });
      }

      return jsonResponse({
        ...envelope,
        ...result,
      });
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
            odata_hints: {
              opportunity_filter: p.opportunityGuids.length
                ? p.opportunityGuids
                    .map((g: string) => `_msp_opportunityid_value eq '${g}'`)
                    .join(" or ")
                : null,
              // `_msp_accountid_value` is a GUID lookup — it must be built from
              // accountid, never from TPID (a separate business identifier that
              // lives on `accounts.msp_mstopparentid`).
              account_filter: p.accountid
                ? `_msp_accountid_value eq '${p.accountid}'`
                : null,
              tpid_filter: p.tpid ? `msp_mstopparentid eq '${p.tpid}'` : null,
              _entities: {
                account_filter: "opportunity/milestone (lookup by account GUID)",
                tpid_filter: "accounts (business identifier)",
              },
            },
          };
        }),
      );

      return jsonResponse({
        prefetch: shaped,
        _note:
          "Use odata_hints directly in crm_query $filter expressions. " +
          "account_filter targets opportunity/milestone lookups by account GUID; " +
          "tpid_filter targets the accounts entity. Values are never truncated.",
      });
    },
  );

  // ── check_vault_health ────────────────────────────────────────────────

  server.registerTool(
    "check_vault_health",
    {
      description:
        "Comprehensive vault health report. Surfaces stale Agent Insights (>30d), incomplete opportunity/milestone IDs, missing sections, orphaned meetings, broken wikilinks, and roster gaps.",
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
      if (report.brokenLinks.length > 0) {
        const distinct = new Set(report.brokenLinks.map((l) => l.target));
        issues.push(
          `${report.brokenLinks.length} broken wikilink(s) across ${distinct.size} unresolved target(s)`,
        );
      }

      return jsonResponse({
        report,
        issues,
        summary:
          issues.length > 0
            ? `${issues.length} issue(s) found across ${report.totalCustomers} customers`
            : `All ${report.totalCustomers} customers healthy`,
      });
    },
  );
}

// ─── Helpers (ported from orient.ts) ────────────────────────────────────────

interface CustomerCandidate {
  customer: string;
  customer_path: string;
}

/**
 * Identity lookup for context reads only. Path construction for new notes and
 * other workflows deliberately remains literal in resolveCustomerPath.
 */
async function findCustomerMatches(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  input: string,
): Promise<CustomerCandidate[]> {
  const hubs = new Map<string, CustomerCandidate & { names: Set<string> }>();
  const root = config.schema.customersRoot;
  const normalize = (name: string) => normalizeValue(name).replace(/\s+/g, " ");
  const normalizedInput = normalize(input);
  const exactNested = `${root}${input}/${input}.md`;
  const exactFlat = `${root}${input}.md`;
  const exact = graph.getNode(exactNested) ?? graph.getNode(exactFlat);
  if (exact) return [{ customer: input, customer_path: exact.path }];

  // The graph may not yet contain a newly created hub. Check literal spelling
  // on disk before aliases; stat alone is case-insensitive on Windows.
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(securePath(vaultPath, root), { withFileTypes: true });
  } catch (err) {
    if (errorCodeFromUnknown(err) === "NOT_FOUND") return [];
    throw err;
  }
  if (entries.some((entry) => entry.isDirectory() && entry.name === input)) {
    try {
      await stat(securePath(vaultPath, exactNested));
      return [{ customer: input, customer_path: exactNested }];
    } catch (err) {
      if (errorCodeFromUnknown(err) !== "NOT_FOUND") throw err;
    }
  }
  if (entries.some((entry) => entry.isFile() && entry.name === `${input}.md`)) {
    return [{ customer: input, customer_path: exactFlat }];
  }

  for (const ref of graph.getNotesByFolder(root)) {
    const customer = customerNameFromPath(ref.path, config);
    const nested = `${root}${customer}/${customer}.md`;
    const flat = `${root}${customer}.md`;
    if (ref.path !== nested && ref.path !== flat) continue;
    const node = graph.getNode(ref.path);
    if (!node) continue;

    let hub = hubs.get(customer);
    if (!hub) {
      hub = { customer, customer_path: ref.path, names: new Set() };
      hubs.set(customer, hub);
    }
    // A flat and nested hub for the same identity retain nested precedence.
    if (ref.path === nested) hub.customer_path = nested;
    for (const name of [customer, resolveEntityName(node, config), node.title, ...readAliases(node.frontmatter)]) {
      hub.names.add(normalize(name));
    }
  }

  return [...hubs.values()]
    .filter((hub) => hub.names.has(normalizedInput))
    .map(({ customer, customer_path }) => ({ customer, customer_path }))
    .sort((a, b) => a.customer_path < b.customer_path ? -1 : a.customer_path > b.customer_path ? 1 : 0);
}

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
