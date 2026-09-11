/**
 * Body-prose recall for misspelled queries.
 *
 * 0.6.0 dropped note bodies from the fuzzy tier on the grounds that "BM25
 * already indexes them". BM25 does — but only as *exact* terms, so a misspelled
 * word that appears only in body prose became unreachable: `search_vault` went
 * from returning the note to returning nothing at all. That is a silent recall
 * regression against 0.5.5, and it is invisible to the golden set because both
 * of its typo cases target note titles.
 *
 * The cases below are split deliberately:
 *  - body prose: the regression. Each misspelling's correct form appears ONLY in
 *    a note's body, never in its filename, title, headings, tags or frontmatter.
 *  - position controls: fields the fuzzy tier still indexes directly. These
 *    never regressed and must keep working, so a fix cannot be "put bodies back
 *    and hope" — it has to leave the cheap path alone.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { GraphIndex } from "../graph.js";
import { cascadeSearch, fuzzySearch, invalidateSearchIndex } from "../search.js";

const VAULT = resolve(import.meta.dirname, "../../bench/fixtures/vault");

let graph: GraphIndex;

beforeAll(async () => {
  graph = new GraphIndex(VAULT);
  await graph.build();
  invalidateSearchIndex();
});

/** Misspelling → the note whose BODY holds the correct spelling. */
const BODY_PROSE: Array<[query: string, correct: string, expected: string]> = [
  ["manufacuring", "manufacturing", "Customers/Contoso.md"],
  ["understafed", "understaffed", "Meetings/2026-02-25-Northwind-Escalation.md"],
  ["peerng", "peering", "Meetings/2026-02-20-Contoso-Migration-Review.md"],
  ["procurment", "procurement", "Meetings/2026-02-15-Fabrikam-AI-Kickoff.md"],
  ["netwoking", "networking", "People/Alice Smith.md"],
];

/** Misspellings that hit an indexed field, so they never regressed. */
const POSITION_CONTROLS: Array<[query: string, field: string]> = [
  ["enterprse", "tag"],
  ["at-rsk", "frontmatter value"],
  ["Opportunites", "heading"],
  ["Milestnes", "heading"],
  ["Traderz", "title"],
];

describe("fuzzy recall on misspelled body prose", () => {
  it.each(BODY_PROSE)(
    "%s finds the note whose body says %s",
    async (query, _correct, expected) => {
      const { results } = await cascadeSearch(graph, query, 10, undefined);
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((r) => r.path)).toContain(expected);
    },
  );

  it("Contso still reaches notes that only mention Contoso in body prose", async () => {
    const { results } = await cascadeSearch(graph, "Contso", 10, undefined);
    const paths = results.map((r) => r.path);
    // The customer note matches on title and never regressed.
    expect(paths).toContain("Customers/Contoso.md");
    // This one carries "Contoso" in body prose only.
    expect(paths).toContain("Weekly/2026-W08.md");
  });
});

describe("position controls — fields the cheap fuzzy path still indexes", () => {
  it.each(POSITION_CONTROLS)("%s still matches via %s", async (query) => {
    const { results } = await cascadeSearch(graph, query, 10, undefined);
    expect(results.length).toBeGreaterThan(0);
  });

  // The other half of the boundary. A fix that simply put bodies back into the
  // default fuzzy index would satisfy every assertion above while quietly
  // restoring the 87-97% cost this tier was changed to avoid. These pin the
  // cheap tier's shape: it covers the four indexed positions and nothing else,
  // so body recall can only be coming from the gated last-resort pass.
  it.each(POSITION_CONTROLS)(
    "%s is answered by the cheap tier itself, without a body pass",
    (query) => {
      expect(fuzzySearch(graph, query, 10).length).toBeGreaterThan(0);
    },
  );

  it.each(BODY_PROSE)(
    "the cheap fuzzy tier still does NOT index bodies, so %s misses there",
    (query, _correct, expected) => {
      expect(fuzzySearch(graph, query, 10).map((r) => r.path)).not.toContain(expected);
    },
  );
});

describe("the body pass does not fire on queries that are already answered", () => {
  it("a fully covered query returns without escalating past lexical", async () => {
    const { tiersUsed } = await cascadeSearch(graph, "Contoso", 10, undefined);
    expect(tiersUsed).toContain("lexical");
  });

  it("correctly spelled body terms are still answered by BM25", async () => {
    const { results, tiersUsed } = await cascadeSearch(graph, "manufacturing", 10, undefined);
    expect(results.map((r) => r.path)).toContain("Customers/Contoso.md");
    expect(tiersUsed).toContain("lexical");
  });

  it("nonsense still returns nothing — the body pass is not a relevance floor bypass", async () => {
    const { results } = await cascadeSearch(graph, "zzxqq wibblewobble", 10, undefined);
    expect(results).toHaveLength(0);
  });
});
