/**
 * OIL — CRM identifier extraction
 * Pulls vault-stored MSX identifiers so the agent can query CRM directly.
 */

import type { GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import type { OilConfig, PrefetchIds } from "./types.js";
import {
  readNote,
  parseTeam,
  resolveCustomerPath,
  readOpportunityNotes,
  readMilestoneNotes,
  resolveTeamSection,
} from "./vault.js";

/**
 * Extract all MSX identifiers from vault customer files.
 * Returns CRM-ready ID bundles for precise query construction.
 */
export async function extractPrefetchIds(
  vaultPath: string,
  _graph: GraphIndex,
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

    // Extract IDs from frontmatter (supports top-level and nested MSX structure)
    const msxObj =
      typeof parsed.frontmatter.MSX === "object" && parsed.frontmatter.MSX !== null
        ? (parsed.frontmatter.MSX as Record<string, unknown>)
        : null;
    const tpid =
      typeof parsed.frontmatter.tpid === "string"
        ? parsed.frontmatter.tpid
        : typeof msxObj?.tpid === "string"
          ? msxObj.tpid
          : undefined;
    const accountid =
      typeof parsed.frontmatter.accountid === "string"
        ? parsed.frontmatter.accountid
        : typeof parsed.frontmatter.accountId === "string"
          ? parsed.frontmatter.accountId
          : typeof msxObj?.accountId === "string"
            ? msxObj.accountId
            : typeof msxObj?.accountid === "string"
              ? msxObj.accountid
              : undefined;

    // Read entities — prefers sub-notes, falls back to section parsing
    const opps = await readOpportunityNotes(vaultPath, config, customer);
    const milestones = await readMilestoneNotes(vaultPath, config, customer);
    const team = parseTeam(resolveTeamSection(parsed.sections));

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
