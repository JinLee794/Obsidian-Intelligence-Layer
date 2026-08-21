/**
 * Golden-set regression gate.
 *
 * Runs the committed golden set through the production search path on every
 * `npm test`, so a retrieval regression fails the build instead of waiting to be
 * noticed. The semantic tier is deliberately off here: it needs Ollama, which CI
 * does not have, and a quality gate that only runs on one machine is not a gate.
 *
 * Cases marked `requiresSemantic` are skipped. Those are covered by
 * `bench/eval-golden.mjs` against a live model, which is where paraphrase
 * quality is measured.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { GraphIndex } from "../graph.js";
import { cascadeSearch } from "../search.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

// Both committed sets run here. `fixture.golden.json` is twelve notes, which is
// small enough that returning the top ten finds a relevant note almost however
// it ranks; `eval.golden.json` is fifty-four notes across eight domains that
// share no vocabulary, so it can still tell two rankings apart. A gate that only
// runs the saturated set would pass through a regression the other one catches.
const DATASETS = [
  resolve(REPO_ROOT, "bench/datasets/fixture.golden.json"),
  resolve(REPO_ROOT, "bench/datasets/eval.golden.json"),
];

interface GoldenCase {
  id: string;
  scenario: string;
  query: string;
  relevant?: string[];
  primary?: string;
  expectTiers?: string[];
  forbidTiers?: string[];
  requiresSemantic?: boolean;
}

for (const DATASET of DATASETS) {
  let graph: GraphIndex;
  let cases: GoldenCase[];

  beforeAll(async () => {
    const dataset = JSON.parse(await readFile(DATASET, "utf-8")) as {
      vault: string;
      cases: GoldenCase[];
    };
    cases = dataset.cases.filter((c) => !c.requiresSemantic);

    graph = new GraphIndex(resolve(REPO_ROOT, dataset.vault));
    await graph.build();
  });

  describe(`golden set — lexical tiers — ${basename(DATASET)}`, () => {
    it("covers every non-semantic scenario type", () => {
    const scenarios = new Set(cases.map((c) => c.scenario));
    expect([...scenarios].sort()).toEqual(["attribute", "exact-entity", "identifier", "typo"]);
  });

  it("finds a relevant note for every case", async () => {
    const misses: string[] = [];
    for (const testCase of cases) {
      const { results } = await cascadeSearch(graph, testCase.query, 10, undefined);
      const paths = results.map((r) => r.path);
      if (!(testCase.relevant ?? []).some((p) => paths.includes(p))) {
        misses.push(`${testCase.id}: got ${JSON.stringify(paths.slice(0, 3))}`);
      }
    }
    // Assert on a fraction, not a boolean, so a failure names the denominator.
    // A bare percentage on a set this size lets one case moving look like a
    // trend, which is how a single case flipping got published as a ranking
    // improvement in this project.
    expect(`${cases.length - misses.length}/${cases.length}`).toBe(`${cases.length}/${cases.length}`);
    expect(misses).toEqual([]);
  });

  it("ranks the primary answer first where one is named", async () => {
    const wrong: string[] = [];
    for (const testCase of cases) {
      if (!testCase.primary) continue;
      const { results } = await cascadeSearch(graph, testCase.query, 10, undefined);
      if (results[0]?.path !== testCase.primary) {
        wrong.push(`${testCase.id}: expected ${testCase.primary}, got ${results[0]?.path}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("routes each query to the tiers it declares", async () => {
    // The negative half matters most: a cheap lookup that starts escalating is a
    // regression even when its results are unchanged.
    const violations: string[] = [];
    for (const testCase of cases) {
      const { tiersUsed } = await cascadeSearch(graph, testCase.query, 10, undefined);
      for (const tier of testCase.expectTiers ?? []) {
        if (tier === "semantic") continue;
        if (!tiersUsed.includes(tier)) {
          violations.push(`${testCase.id}: expected tier ${tier}, ran ${tiersUsed.join("+")}`);
        }
      }
      for (const tier of testCase.forbidTiers ?? []) {
        if (tiersUsed.includes(tier)) {
          violations.push(`${testCase.id}: forbidden tier ${tier} ran`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
  });
}
