/**
 * OIL — Vault Hygiene Engine
 * Freshness scanning, staleness detection, completeness checks.
 * Powers the VAULT-HYGIENE protocol phase.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import type {
  OilConfig,
  CustomerFreshness,
  StaleEntry,
  StructuralIssue,
  VaultHealthReport,
} from "./types.js";
import {
  readNote,
  parseOpportunities,
  parseMilestones,
  parseTeam,
  securePath,
  listFolder,
  resolveCustomerPath,
  readOpportunityNotes,
  readMilestoneNotes,
  listCustomerNames,
  detectFlatCustomers,
} from "./vault.js";

const STALE_THRESHOLD_DAYS = 30;

// ─── Per-Customer Freshness ───────────────────────────────────────────────────

/**
 * Assess freshness of a single customer's vault data.
 */
export async function checkCustomerFreshness(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  customerName: string,
): Promise<CustomerFreshness> {
  const path = await resolveCustomerPath(vaultPath, config, customerName);

  // File modification time
  let lastModified: Date | null = null;
  try {
    const fullPath = securePath(vaultPath, path);
    const fileStat = await stat(fullPath);
    lastModified = fileStat.mtime;
  } catch {
    // File may not exist
  }

  // Read and parse
  let parsed = cache.getNote(path);
  if (!parsed) {
    try {
      parsed = await readNote(vaultPath, path);
      cache.putNote(path, parsed);
    } catch {
      return {
        customer: customerName,
        path,
        lastModified: null,
        lastValidated: null,
        staleInsights: [],
        opportunityCompleteness: { total: 0, withGuid: 0, missingGuid: [] },
        milestoneCompleteness: { total: 0, withId: 0, missingId: [] },
        hasTeam: false,
        hasConnectHooks: false,
      };
    }
  }

  // Stale Agent Insights
  const insightsSection = parsed.sections.get("Agent Insights") ?? "";
  const staleInsights = findStaleEntries(insightsSection);

// Opportunity completeness — prefers sub-notes, falls back to section parsing
    const opps = await readOpportunityNotes(vaultPath, config, customerName);
    const missingGuid = opps.filter((o) => !o.guid).map((o) => o.name);

    // Milestone completeness — prefers sub-notes, falls back to section parsing
    const milestones = await readMilestoneNotes(vaultPath, config, customerName);
  const missingId = milestones
    .filter((m) => !m.id && !m.number)
    .map((m) => m.name);

  // Section presence
  const teamSection = parsed.sections.get("Team") ?? "";
  const connectSection = parsed.sections.get("Connect Hooks") ?? "";

  // last_validated from frontmatter
  const rawValidated = parsed.frontmatter?.last_validated;
  const lastValidated =
    typeof rawValidated === "string" && rawValidated.length > 0
      ? rawValidated
      : null;

  return {
    customer: customerName,
    path,
    lastModified,
    lastValidated,
    staleInsights,
    opportunityCompleteness: {
      total: opps.length,
      withGuid: opps.length - missingGuid.length,
      missingGuid,
    },
    milestoneCompleteness: {
      total: milestones.length,
      withId: milestones.length - missingId.length,
      missingId,
    },
    hasTeam: teamSection.trim().length > 0,
    hasConnectHooks: connectSection.trim().length > 0,
  };
}

// ─── Vault-wide Health ────────────────────────────────────────────────────────

/**
 * Run a full vault health check across all customers.
 */
export async function checkVaultHealth(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  filterCustomers?: string[],
): Promise<VaultHealthReport> {
  // Get customer roster from vault (supports both nested and flat layouts)
  let customerNames: string[];
  try {
    customerNames = await listCustomerNames(vaultPath, config);
  } catch {
    return {
      totalCustomers: 0,
      customers: [],
      orphanedMeetings: [],
      rosterGaps: [],
      structuralIssues: [],
    };
  }

  // Filter if specified
  const targetNames = filterCustomers?.length
    ? customerNames.filter((n) =>
        filterCustomers.some(
          (f) => f.toLowerCase() === n.toLowerCase(),
        ),
      )
    : customerNames;

  // Check each customer
  const customers: CustomerFreshness[] = [];
  for (const name of targetNames) {
    const freshness = await checkCustomerFreshness(
      vaultPath, graph, config, cache, name,
    );
    customers.push(freshness);
  }

  // Find orphaned meetings (meetings not linked to any tracked customer)
  const orphanedMeetings = await findOrphanedMeetings(
    vaultPath, graph, config, cache, customerNames,
  );

  // Detect structural issues (flat-layout customers, misplaced entities)
  const structuralIssues = await detectStructuralIssues(vaultPath, config);

  return {
    totalCustomers: customerNames.length,
    customers,
    orphanedMeetings,
    rosterGaps: [], // Populated by copilot after CRM comparison
    structuralIssues,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse Agent Insights entries for dates and find stale ones.
 * Looks for date patterns (YYYY-MM-DD) at the start of list items.
 */
function findStaleEntries(insightsSection: string): StaleEntry[] {
  const now = new Date();
  const stale: StaleEntry[] = [];
  const lines = insightsSection.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    // Match: - 2026-01-15 Some insight text
    const dateMatch = line.match(
      /^[-*]\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/,
    );
    if (dateMatch) {
      const entryDate = new Date(dateMatch[1]);
      const ageDays = Math.floor(
        (now.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (ageDays > STALE_THRESHOLD_DAYS) {
        stale.push({
          text: dateMatch[2].trim(),
          date: dateMatch[1],
          ageDays,
        });
      }
    }
  }

  return stale;
}

/**
 * Find meeting notes that don't reference any tracked customer.
 */
async function findOrphanedMeetings(
  vaultPath: string,
  graph: GraphIndex,
  config: OilConfig,
  cache: SessionCache,
  customerNames: string[],
): Promise<string[]> {
  const meetingNotes = graph.getNotesByFolder(config.schema.meetingsRoot);
  const orphaned: string[] = [];
  const customerSet = new Set(customerNames.map((n) => n.toLowerCase()));

  for (const ref of meetingNotes) {
    const node = graph.getNode(ref.path);
    if (!node) continue;

    const customer = node.frontmatter.customer;
    if (
      typeof customer === "string" &&
      customerSet.has(customer.toLowerCase())
    ) {
      continue; // Linked to a tracked customer
    }

    // Check wikilinks for customer references
    const hasCustomerLink = node.outLinks
      ? [...node.outLinks].some((link) => {
          const linkName = link
            .replace(/^Customers\//, "")
            .replace(/\.md$/, "")
            .toLowerCase();
          return customerSet.has(linkName);
        })
      : false;

    if (!hasCustomerLink) {
      orphaned.push(ref.path);
    }
  }

  return orphaned;
}

// ─── Structural Issue Detection ───────────────────────────────────────────────

/**
 * Detect vault structure issues: flat-layout customers that should be nested,
 * and other layout mismatches.
 */
async function detectStructuralIssues(
  vaultPath: string,
  config: OilConfig,
): Promise<StructuralIssue[]> {
  const issues: StructuralIssue[] = [];

  const flatCustomers = await detectFlatCustomers(vaultPath, config);
  for (const { customer, currentPath, expectedPath } of flatCustomers) {
    issues.push({
      type: "flat-customer",
      currentPath,
      expectedPath,
      customer,
      detail: `Customer "${customer}" uses flat layout (${currentPath}). ` +
        `Nested layout (${expectedPath}) is required for sub-entity storage ` +
        `(opportunities/, milestones/). Use migrate_customer_structure to fix.`,
    });
  }

  return issues;
}
