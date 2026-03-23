/**
 * OIL — Orient tools
 * "Where am I?" tools — the agent's first calls in any session.
 * All fully autonomous (no confirmation gate).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphIndex } from "../graph.js";
import type { SessionCache } from "../cache.js";
import type { OilConfig } from "../types.js";
import {
  validateCustomerName,
  validateVaultPath,
  validationError,
} from "../validation.js";
import {
  readNote,
  buildFolderTree,
  listFolder,
  parseOpportunities,
  parseMilestones,
  parseTeam,
  parseActionItems,
  toNoteRef,
  resolveCustomerPath,
  readOpportunityNotes,
  readMilestoneNotes,
  listCustomerEntities,
  readInsightsPartitioned,
  readMeetingsFromFrontmatter,
} from "../vault.js";
import type {
  CustomerContext,
  PersonContext,
  NoteRef,
  PeopleResolutionResult,
  OpportunityRef,
  MilestoneRef,
} from "../types.js";

/**
 * Register all Orient tools on the MCP server.
 */
export function registerOrientTools(
  server: McpServer,
  vaultPath: string,
  graph: GraphIndex,
  cache: SessionCache,
  config: OilConfig,
): void {
  // ── get_vault_context ─────────────────────────────────────────────────

  server.registerTool(
    "get_vault_context",
    {
      description: "Returns a high-level map of the vault — its shape, scale, and most important nodes. The agent's first call in any new session.",
      inputSchema: {},
    },    async () => {
      const folderStructure = await buildFolderTree(vaultPath);
      const stats = graph.getStats();

      const result = {
        folderStructure,
        noteCount: stats.noteCount,
        topTags: stats.topTags,
        mostLinkedNotes: stats.mostLinkedNotes,
        schemaVersion: "0.1.0",
        lastIndexed: graph.lastIndexed.toISOString(),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── get_customer_context ──────────────────────────────────────────────

  server.registerTool(
    "get_customer_context",
    {
      description: "Full assembled context for a named customer — customer file content, opportunities with GUIDs, team composition, recent meetings, linked people, open action items, and optionally similar customers. Primary tool for VAULT-PREFETCH.",
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
                text: JSON.stringify({
                  error: `Customer file not found: ${customerFile}`,
                }),
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

      // Linked people: find People notes that reference this customer
      const linkedPeople = findLinkedPeople(graph, config, customer);

      // Recent meetings — prefer frontmatter index (O(1)), fall back to graph scan
      const fmMeetings = readMeetingsFromFrontmatter(parsed.frontmatter, lookback);
      const recentMeetings = fmMeetings ?? findRecentMeetings(
        graph,
        config,
        customer,
        lookback,
      );

      // Open action items (default: included)
      let openItems: import("../types.js").ActionItem[] = [];
      if (include_open_items !== false) {
        openItems = await findOpenItems(
          vaultPath,
          graph,
          config,
          customer,
          cache,
        );
        if (assignee) {
          openItems = openItems.filter(
            (i) =>
              i.assignee &&
              i.assignee.toLowerCase() === assignee.toLowerCase(),
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

  // ── get_person_context ────────────────────────────────────────────────

  server.registerTool(
    "get_person_context",
    {
      description: "Returns a person's vault profile — customer associations, org type, company, and linked notes. Used for M365 entity resolution.",
      inputSchema: {
        name: z.string().describe("Person name (matches People/{name}.md)"),
      },
    },
    async ({ name }) => {
      const nameErr = validateCustomerName(name);
      if (nameErr) return validationError(`get_person_context: person name — ${nameErr}`);

      const personFile = `${config.schema.peopleRoot}${name}.md`;

      let parsed = cache.getNote(personFile);
      if (!parsed) {
        try {
          parsed = await readNote(vaultPath, personFile);
          cache.putNote(personFile, parsed);
        } catch {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Person file not found: ${personFile}`,
                }),
              },
            ],
          };
        }
      }

      const fm = parsed.frontmatter;
      const linkedCustomers = Array.isArray(fm.customers)
        ? (fm.customers as string[])
        : [];

      // Recent meetings where this person appears
      const recentMeetings = findMeetingsForPerson(graph, config, name);

      const backlinks = graph.getBacklinks(personFile);

      const result: PersonContext = {
        frontmatter: {
          tags: Array.isArray(fm.tags) ? fm.tags : [],
          company: typeof fm.company === "string" ? fm.company : undefined,
          org: fm.org as PersonContext["frontmatter"]["org"],
          customers: linkedCustomers,
        },
        email: typeof fm.email === "string" ? fm.email : undefined,
        teamsId: typeof fm.teams_id === "string" ? fm.teams_id : undefined,
        linkedCustomers,
        recentMeetings,
        backlinks,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── query_graph ────────────────────────────────────────────────────────

  server.registerTool(
    "query_graph",
    {
      description:
        "Unified graph traversal — returns backlinks (in), forward links (out), or N-hop neighbourhood for a note.",
      inputSchema: {
        path: z.string().describe("Note path within the vault"),
        direction: z
          .enum(["in", "out", "neighborhood"])
          .describe(
            '"in" = backlinks, "out" = forward links, "neighborhood" = N-hop traversal',
          ),
        hops: z
          .number()
          .optional()
          .describe("Hops for neighborhood traversal (default: 2)"),
        filter_tags: z
          .array(z.string())
          .optional()
          .describe("Filter results to notes with these tags"),
        filter_folder: z
          .string()
          .optional()
          .describe("Filter results to this folder prefix"),
      },
    },
    async ({ path, direction, hops, filter_tags, filter_folder }) => {
      const pathErr = validateVaultPath(path);
      if (pathErr) return validationError(`query_graph: ${pathErr}`);
      if (filter_folder) {
        const folderErr = validateVaultPath(filter_folder);
        if (folderErr) return validationError(`query_graph: filter_folder — ${folderErr}`);
      }

      const cacheKey = `graph:${direction}:${path}:${hops ?? 2}:${filter_tags?.join(",") ?? ""}:${filter_folder ?? ""}`;
      let result = cache.getTraversal(cacheKey);

      if (!result) {
        if (direction === "in") {
          result = graph.getBacklinks(path);
        } else if (direction === "out") {
          result = graph.getForwardLinks(path);
        } else {
          result = graph.getRelatedNotes(path, hops ?? 2, {
            tags: filter_tags,
            folder: filter_folder,
          });
        }
        cache.putTraversal(cacheKey, result);
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ── resolve_people_to_customers ───────────────────────────────────────

  server.registerTool(
    "resolve_people_to_customers",
    {
      description: "Batch resolution of person names to customer associations. Primary tool for WorkIQ Entity Resolution.",
      inputSchema: {
        names: z
          .array(z.string())
          .describe("List of person names to resolve"),
      },
    },
    async ({ names }) => {
      const result = await resolvePeople(
        vaultPath,
        graph,
        config,
        cache,
        names,
      );

      // Apply confidence thresholds:
      // exact → auto-use, fuzzy → ask user, unresolved → skip
      const autoUse: Record<string, typeof result.resolved[string]> = {};
      const needsConfirmation: Record<string, typeof result.resolved[string]> = {};
      for (const [name, resolution] of Object.entries(result.resolved)) {
        if (resolution.confidence === "exact") {
          autoUse[name] = resolution;
        } else {
          needsConfirmation[name] = resolution;
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          autoUse,
          needsConfirmation,
          skipped: result.unresolved,
          _meta: {
            policy: "exact→auto-use | fuzzy→ask user | unresolved→skip",
            totalNames: names.length,
            autoUseCount: Object.keys(autoUse).length,
            needsConfirmationCount: Object.keys(needsConfirmation).length,
            skippedCount: result.unresolved.length,
          },
        }, null, 2) }],
      };
    },
  );

  // ── oil_get_opportunity_context ──────────────────────────────────────────

  server.registerTool(
    "oil_get_opportunity_context",
    {
      description: "[OIL/Vault] Returns all opportunities for a customer as structured data from the Obsidian vault — entity sub-notes (with full frontmatter) or section parsing fallback. Each opportunity includes GUID, status, stage, owner, and salesplay when available. NOT a CRM query — use MSX tools for live CRM data.",
      inputSchema: {
        customer: z.string().describe("Customer name"),
      },
    },
    async ({ customer }) => {
      const custErr = validateCustomerName(customer);
      if (custErr) return validationError(`oil_get_opportunity_context: ${custErr}`);

      const opportunities: OpportunityRef[] = await readOpportunityNotes(
        vaultPath, config, customer,
      );

      if (opportunities.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              customer,
              opportunities: [],
              _note: "No opportunities found. Check customer name or vault structure.",
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ customer, opportunities }, null, 2),
        }],
      };
    },
  );

  // ── oil_get_milestone_context ────────────────────────────────────────────

  server.registerTool(
    "oil_get_milestone_context",
    {
      description: "[OIL/Vault] Returns all milestones for a customer as structured data from the Obsidian vault — entity sub-notes (with full frontmatter) or section parsing fallback. Each milestone includes ID, number, status, date, owner, and linked opportunity when available. NOT a CRM query — use MSX tools for live CRM data.",
      inputSchema: {
        customer: z.string().describe("Customer name"),
      },
    },
    async ({ customer }) => {
      const custErr = validateCustomerName(customer);
      if (custErr) return validationError(`oil_get_milestone_context: ${custErr}`);

      const milestones: MilestoneRef[] = await readMilestoneNotes(
        vaultPath, config, customer,
      );

      if (milestones.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              customer,
              milestones: [],
              _note: "No milestones found. Check customer name or vault structure.",
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ customer, milestones }, null, 2),
        }],
      };
    },
  );
}

// ─── Helper Functions ───────────────────────────────────────────────────────

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
        (c) =>
          typeof c === "string" &&
          c.toLowerCase() === customer.toLowerCase(),
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
    return true; // Include if no date to be safe
  });
}

function findMeetingsForPerson(
  graph: GraphIndex,
  config: OilConfig,
  personName: string,
): NoteRef[] {
  const meetingNotes = graph.getNotesByFolder(config.schema.meetingsRoot);
  return meetingNotes.filter((note) => {
    const node = graph.getNode(note.path);
    if (!node) return false;

    // Check if this person is in action_owners or if the note links to the person
    const actionOwners = node.frontmatter.action_owners;
    if (Array.isArray(actionOwners)) {
      if (
        actionOwners.some(
          (o) =>
            typeof o === "string" &&
            o.toLowerCase() === personName.toLowerCase(),
        )
      ) {
        return true;
      }
    }

    // Check wikilinks
    return node.outLinks.has(
      `${config.schema.peopleRoot}${personName}.md`,
    );
  });
}

async function findOpenItems(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  customer: string,
  cache: SessionCache,
): Promise<import("../types.js").ActionItem[]> {
  const items: import("../types.js").ActionItem[] = [];

  // Collect all note paths linked to this customer
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

async function resolvePeople(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  names: string[],
): Promise<PeopleResolutionResult> {
  const resolved: PeopleResolutionResult["resolved"] = {};
  const unresolved: string[] = [];

  for (const name of names) {
    const personFile = `${config.schema.peopleRoot}${name}.md`;
    let parsed = cache.getNote(personFile);

    if (!parsed) {
      try {
        parsed = await readNote(vaultPath, personFile);
        cache.putNote(personFile, parsed);
      } catch {
        // Try fuzzy match on title index
        const resolvedPath = graph.resolveTitle(name);
        if (resolvedPath && resolvedPath.startsWith(config.schema.peopleRoot)) {
          try {
            parsed = await readNote(vaultPath, resolvedPath);
            cache.putNote(resolvedPath, parsed);
          } catch {
            unresolved.push(name);
            continue;
          }
        } else {
          unresolved.push(name);
          continue;
        }
      }
    }

    const fm = parsed.frontmatter;
    const customers = Array.isArray(fm.customers) ? (fm.customers as string[]) : [];
    const company = typeof fm.company === "string" ? fm.company : "";
    const org = (fm.org as "internal" | "customer" | "partner") ?? "customer";
    const isExact = parsed.path === personFile;

    resolved[name] = {
      customers,
      company,
      org,
      confidence: isExact ? "exact" : "fuzzy",
    };
  }

  return { resolved, unresolved };
}
