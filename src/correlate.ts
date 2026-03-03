/**
 * OIL — Correlation Engine
 * Cross-references external entities with vault data.
 * Powers VAULT-CORRELATE and VAULT-PREFETCH protocol phases.
 */

import type { GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import type {
  OilConfig,
  PrefetchIds,
  ExternalEntity,
  CorrelationMatch,
  DriftSnapshot,
  NoteRef,
} from "./types.js";
import {
  readNote,
  parseOpportunities,
  parseMilestones,
  parseTeam,
  listFolder,
  resolveCustomerPath,
  readOpportunityNotes,
  readMilestoneNotes,
  listCustomerNames,
  customerNameFromPath,
} from "./vault.js";

// ─── VAULT-PREFETCH: ID Extraction ───────────────────────────────────────────

/**
 * Extract all MSX identifiers from vault customer files.
 * Returns CRM-ready ID bundles for precise query construction.
 */
export async function extractPrefetchIds(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  customerNames: string[],
): Promise<PrefetchIds[]> {
  const results: PrefetchIds[] = [];

  for (const customer of customerNames) {
    const path = await resolveCustomerPath(vaultPath, config, customer);

    let parsed = cache.getNote(path);
    if (!parsed) {
      try {
        parsed = await readNote(vaultPath, path);
        cache.putNote(path, parsed);
      } catch {
        results.push({
          customer,
          opportunityGuids: [],
          milestoneIds: [],
          milestoneNumbers: [],
          teamMembers: [],
        });
        continue;
      }
    }

    // Extract IDs from frontmatter
    const tpid =
      typeof parsed.frontmatter.tpid === "string"
        ? parsed.frontmatter.tpid
        : undefined;
    const accountid =
      typeof parsed.frontmatter.accountid === "string"
        ? parsed.frontmatter.accountid
        : undefined;

    // Read entities — prefers sub-notes, falls back to section parsing
    const opps = await readOpportunityNotes(vaultPath, config, customer);
    const milestones = await readMilestoneNotes(vaultPath, config, customer);
    const team = parseTeam(parsed.sections.get("Team") ?? "");

    results.push({
      customer,
      tpid,
      accountid,
      opportunityGuids: opps.filter((o) => o.guid).map((o) => o.guid!),
      milestoneIds: milestones.filter((m) => m.id).map((m) => m.id!),
      milestoneNumbers: milestones
        .filter((m) => m.number)
        .map((m) => m.number!),
      teamMembers: team,
    });
  }

  return results;
}

// ─── VAULT-CORRELATE: Entity Matching ─────────────────────────────────────────

/**
 * Cross-reference external entities with vault data.
 * Matches people, customers, meetings, and opportunities to vault notes.
 */
export async function correlateEntities(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  entities: ExternalEntity[],
  dateRange?: { start: string; end: string },
): Promise<{ matches: CorrelationMatch[]; peopleToCustomers: Record<string, string[]> }> {
  // Build people→customer lookup from vault
  const peopleToCustomers = await buildPeopleCustomerMap(
    vaultPath, graph, config, cache,
  );

  const matches: CorrelationMatch[] = [];

  for (const entity of entities) {
    const match = await matchEntity(
      vaultPath, graph, config, cache,
      entity, dateRange, peopleToCustomers,
    );
    matches.push(match);
  }

  return { matches, peopleToCustomers };
}

/**
 * Build a lookup map: person name → customer associations.
 */
async function buildPeopleCustomerMap(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  const peopleNotes = graph.getNotesByFolder(config.schema.peopleRoot);

  for (const ref of peopleNotes) {
    const node = graph.getNode(ref.path);
    if (!node) continue;

    const customers = node.frontmatter.customers;
    if (Array.isArray(customers) && customers.length > 0) {
      const personName = ref.title.toLowerCase();
      map[personName] = customers.map((c) =>
        typeof c === "string" ? c : String(c),
      );
    }
  }

  return map;
}

/**
 * Match a single external entity against vault data.
 */
async function matchEntity(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  entity: ExternalEntity,
  dateRange: { start: string; end: string } | undefined,
  peopleToCustomers: Record<string, string[]>,
): Promise<CorrelationMatch> {
  const nameLower = entity.name.toLowerCase();
  const matchedNotes: NoteRef[] = [];
  const customerAssociations: Set<string> = new Set();
  let confidence: "exact" | "fuzzy" | "unresolved" = "unresolved";

  switch (entity.type) {
    case "person": {
      // Check People/ notes
      const personPath = graph.resolveTitle(entity.name);
      if (personPath) {
        const node = graph.getNode(personPath);
        if (node) {
          matchedNotes.push({ path: personPath, title: entity.name, tags: node.tags });
          confidence = "exact";
        }
      }

      // Check people→customer map
      const customers = peopleToCustomers[nameLower];
      if (customers) {
        for (const c of customers) customerAssociations.add(c);
      }

      // Also look for backlinks
      if (personPath) {
        const backlinks = graph.getBacklinks(personPath);
        for (const bl of backlinks) {
          const blNode = graph.getNode(bl.path);
          if (blNode?.frontmatter.customer) {
            customerAssociations.add(String(blNode.frontmatter.customer));
          }
        }
      }

      if (confidence === "unresolved" && customerAssociations.size > 0) {
        confidence = "fuzzy";
      }
      break;
    }

    case "customer": {
      // Direct customer file lookup (supports nested and flat layouts)
      const customerFile = await resolveCustomerPath(vaultPath, config, entity.name);
      const node = graph.getNode(customerFile);
      if (node) {
        matchedNotes.push({ path: customerFile, title: entity.name, tags: node.tags });
        customerAssociations.add(entity.name);
        confidence = "exact";
      } else {
        // Fuzzy title search
        const resolved = graph.resolveTitle(entity.name);
        if (resolved?.startsWith(config.schema.customersRoot)) {
          matchedNotes.push({ path: resolved, title: entity.name, tags: [] });
          customerAssociations.add(entity.name);
          confidence = "fuzzy";
        }
      }
      break;
    }

    case "meeting": {
      // Search meetings by date and name
      const meetingNotes = graph.getNotesByFolder(config.schema.meetingsRoot);
      for (const ref of meetingNotes) {
        const node = graph.getNode(ref.path);
        if (!node) continue;

        // Match by date range if provided
        const noteDate = node.frontmatter.date;
        if (dateRange && typeof noteDate === "string") {
          if (noteDate < dateRange.start || noteDate > dateRange.end) continue;
        } else if (entity.date && typeof noteDate === "string") {
          if (noteDate !== entity.date) continue;
        }

        // Match by title or customer
        if (
          ref.title.toLowerCase().includes(nameLower) ||
          String(node.frontmatter.customer ?? "").toLowerCase().includes(nameLower)
        ) {
          matchedNotes.push(ref);
          if (node.frontmatter.customer) {
            customerAssociations.add(String(node.frontmatter.customer));
          }
          confidence = confidence === "unresolved" ? "fuzzy" : confidence;
        }
      }
      break;
    }

    case "opportunity": {
      // Search customer entity sub-notes and customer file sections for opportunity
      const allCustomers = await listCustomerNames(vaultPath, config);
      for (const custName of allCustomers) {
        const opps = await readOpportunityNotes(vaultPath, config, custName);
        const found = opps.find(
          (o) =>
            o.name.toLowerCase().includes(nameLower) ||
            o.guid?.toLowerCase() === nameLower,
        );
        if (found) {
          const custPath = await resolveCustomerPath(vaultPath, config, custName);
          matchedNotes.push({
            path: custPath,
            title: custName,
            tags: [],
          });
          customerAssociations.add(custName);
          confidence = found.guid ? "exact" : "fuzzy";
        }
      }
      break;
    }

    default: {
      // Generic: search titles and tags
      const resolved = graph.resolveTitle(entity.name);
      if (resolved) {
        const node = graph.getNode(resolved);
        if (node) {
          matchedNotes.push({ path: resolved, title: entity.name, tags: node.tags });
          confidence = "exact";
        }
      }
      break;
    }
  }

  return {
    entity,
    matchedNotes,
    customerAssociations: [...customerAssociations],
    confidence,
  };
}

// ─── Drift Snapshot ───────────────────────────────────────────────────────────

/**
 * Build a vault-side snapshot of a customer's data for CRM comparison.
 * Returns opportunity stages, milestones, team — structured for copilot
 * to diff against live CRM state.
 */
export async function buildDriftSnapshot(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  customerName: string,
): Promise<DriftSnapshot> {
  const path = await resolveCustomerPath(vaultPath, config, customerName);

  let parsed = cache.getNote(path);
  if (!parsed) {
    try {
      parsed = await readNote(vaultPath, path);
      cache.putNote(path, parsed);
    } catch {
      return {
        customer: customerName,
        opportunities: [],
        milestones: [],
        team: [],
        lastAgentInsightDate: null,
        frontmatter: {},
      };
    }
  }

  // Read entities — prefers sub-notes, falls back to section parsing
  const opportunities = await readOpportunityNotes(vaultPath, config, customerName);
  const milestones = await readMilestoneNotes(vaultPath, config, customerName);
  const team = parseTeam(parsed.sections.get("Team") ?? "");

  // Find most recent Agent Insight date
  const insightsSection = parsed.sections.get("Agent Insights") ?? "";
  const dateMatches = insightsSection.match(/\d{4}-\d{2}-\d{2}/g);
  const lastAgentInsightDate = dateMatches
    ? dateMatches.sort().pop() ?? null
    : null;

  return {
    customer: customerName,
    opportunities,
    milestones,
    team,
    lastAgentInsightDate,
    frontmatter: parsed.frontmatter,
  };
}
