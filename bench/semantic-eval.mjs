/**
 * Semantic tier evaluation harness.
 *
 * Runs against a real Ollama when one is reachable, and otherwise against a
 * built-in stub that serves deterministic 768-dimension vectors. The stub
 * exercises every mechanical property of the tier at full scale — batching,
 * change detection, persistence, reload, cosine ranking, memory — but it cannot
 * say anything about retrieval *quality*, so the recall section is skipped
 * unless a real model is answering.
 *
 *   node bench/semantic-eval.mjs [noteCount ...]
 */

import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { GraphIndex } from "../dist/graph.js";
import { DEFAULT_CONFIG } from "../dist/config.js";
import { SemanticIndex, attachSemanticIndex, detachSemanticIndex } from "../dist/semantic.js";
import { cascadeSearch } from "../dist/search.js";

const DIMENSIONS = 768;
const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const NOTE_COUNTS = SIZES.length > 0 ? SIZES : [500, 2000, 5000];

// ─── Ground truth: paraphrase queries with no lexical overlap with the target ──

const CONCEPTS = [
  {
    slug: "northwind-renewal",
    title: "Northwind Renewal Risk",
    body: "The account has ignored three consecutive outreach attempts and their contract expires at the end of next quarter. Sentiment in the last executive briefing was cold.",
    query: "which customer looks like it might churn soon",
  },
  {
    slug: "landing-zone",
    title: "Woodgrove Landing Zone",
    body: "Hub and spoke topology with ExpressRoute circuits terminating in the shared services subscription. Firewall rules are managed centrally.",
    query: "how do we wire the corporate datacenter into the cloud",
  },
  {
    slug: "copilot-seats",
    title: "Fabrikam Copilot Adoption",
    body: "Two hundred and ninety licences were purchased but weekly active usage sits near eleven percent. Enablement sessions have not been scheduled.",
    query: "where are we paying for software nobody uses",
  },
  {
    slug: "cost-spike",
    title: "Litware Spend Anomaly",
    body: "Compute charges tripled in March after an autoscale rule was misconfigured on the batch processing cluster.",
    query: "unexpected billing increase investigation",
  },
  {
    slug: "compliance",
    title: "Tailspin Audit Findings",
    body: "The assessor flagged missing encryption at rest on two storage accounts and incomplete retention policies for privileged access logs.",
    query: "regulatory gaps we still need to close",
  },
  {
    slug: "stakeholder",
    title: "Proseware Leadership Change",
    body: "A new chief information security officer started in February and has paused all in-flight workstreams pending her own review.",
    query: "who is the new decision maker blocking progress",
  },
  {
    slug: "migration-wave",
    title: "Contoso Wave Two Cutover",
    body: "Forty virtual machines move over the Easter weekend. Rollback window is six hours and the database team is on standby.",
    query: "when do the servers get moved across",
  },
  {
    slug: "skills-gap",
    title: "Lucerne Enablement Plan",
    body: "The platform team has no Kubernetes experience. Training vouchers were issued but nobody has redeemed them yet.",
    query: "team lacks technical expertise to operate the system",
  },
];

// ─── Synthetic vault ──────────────────────────────────────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER_TOPICS = [
  "sprint planning", "quarterly forecast", "support ticket triage",
  "vendor evaluation", "hiring loop", "release checklist",
  "capacity model", "incident postmortem", "roadmap grooming",
];

async function buildVault(dir, noteCount) {
  const rand = mulberry32(7);
  for (const folder of ["Customers", "Meetings", "Daily", "Projects"]) {
    await mkdir(join(dir, folder), { recursive: true });
  }

  // Ground-truth notes first, so their paths are known.
  for (const concept of CONCEPTS) {
    await writeFile(
      join(dir, "Customers", `${concept.slug}.md`),
      `---\ntags: [customer]\n---\n# ${concept.title}\n\n## Summary\n\n${concept.body}\n`,
      "utf-8",
    );
  }

  // Filler notes to reach scale.
  const remaining = Math.max(0, noteCount - CONCEPTS.length);
  for (let i = 0; i < remaining; i++) {
    const topic = FILLER_TOPICS[Math.floor(rand() * FILLER_TOPICS.length)];
    const folder = ["Meetings", "Daily", "Projects"][i % 3];
    await writeFile(
      join(dir, folder, `note-${i}.md`),
      `---\ntags: [routine]\ndate: 2026-0${(i % 9) + 1}-15\n---\n# Note ${i}\n\n## ${topic}\n\n` +
        `Routine working notes covering ${topic} for iteration ${i}. ` +
        `Action items were captured and owners assigned during the session.\n`,
      "utf-8",
    );
  }
  return CONCEPTS.map((c) => `Customers/${c.slug}.md`);
}

// ─── Stub Ollama ──────────────────────────────────────────────────────────────

function stubVector(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    if (code < 97 || code > 122) continue;
    vector[(code * 31 + i) % DIMENSIONS] += 1;
  }
  return vector;
}

async function startStub() {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const inputs = JSON.parse(body || "{}").input ?? [];
      calls += inputs.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: inputs.map(stubVector) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    get calls() { return calls; },
    reset() { calls = 0; },
    close: () => new Promise((r) => server.close(r)),
  };
}

async function detectOllama() {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const { models = [] } = await res.json();
    // An empty model list still counts: the server pulls the embedding model on
    // first use, and that path is exactly what a fresh install exercises.
    return models.map((m) => m.name);
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ms = (n) => `${n.toFixed(1)} ms`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { value, elapsed: performance.now() - t0 };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const liveModels = await detectOllama();
const useReal = Array.isArray(liveModels);
const stub = useReal ? null : await startStub();

console.log("═".repeat(78));
console.log(
  useReal
    ? `Embedder: LIVE Ollama — models: ${liveModels.length > 0 ? liveModels.join(", ") : "none yet (will be pulled on first use)"}`
    : `Embedder: STUB (${DIMENSIONS}-dim, deterministic). Quality section will be skipped.`,
);
console.log("═".repeat(78));

const rows = [];

for (const noteCount of NOTE_COUNTS) {
  const root = await mkdtemp(join(tmpdir(), `oil-semeval-${noteCount}-`));
  const vault = join(root, "vault");
  await mkdir(vault, { recursive: true });
  const truthPaths = await buildVault(vault, noteCount);

  const graph = new GraphIndex(vault);
  const graphBuild = await timed(() => graph.build());

  const config = {
    ...DEFAULT_CONFIG.semantic,
    ...(useReal ? {} : { endpoint: stub.endpoint }),
    minScore: 0.2,
  };

  // ── Cold embed ──────────────────────────────────────────────────────────
  if (stub) stub.reset();
  const index = new SemanticIndex(vault, config);
  const cold = await timed(() => index.refresh(graph));

  if (index.status !== "ready") {
    console.log(`\n[${noteCount}] FAILED: ${index.status} — ${index.stats.reason}`);
    await rm(root, { recursive: true, force: true });
    continue;
  }

  // ── Sidecar ─────────────────────────────────────────────────────────────
  const sidecar = await stat(join(vault, config.indexFile));

  // ── Reload from disk ────────────────────────────────────────────────────
  const reloaded = new SemanticIndex(vault, config);
  const reload = await timed(() => reloaded.load());
  if (stub) stub.reset();
  const noop = await timed(() => reloaded.refresh(graph));
  const reembeddedOnRestart = stub ? stub.calls : 0;

  // ── Incremental: touch one note ─────────────────────────────────────────
  await writeFile(
    join(vault, "Customers", `${CONCEPTS[0].slug}.md`),
    `---\ntags: [customer]\n---\n# ${CONCEPTS[0].title}\n\n## Summary\n\n${CONCEPTS[0].body} Updated with a fresh paragraph.\n`,
    "utf-8",
  );
  await graph.updateNote(`Customers/${CONCEPTS[0].slug}.md`);
  if (stub) stub.reset();
  const incremental = await timed(() => reloaded.refresh(graph));
  const reembeddedOnEdit = stub ? stub.calls : 0;

  // ── Query latency (vector search only, query vector cached) ─────────────
  await index.search("warmup query", 10);
  const latencies = [];
  for (const concept of CONCEPTS) {
    await index.search(concept.query, 10); // prime the query cache
    const run = await timed(() => index.search(concept.query, 10));
    latencies.push(run.elapsed);
  }

  // ── End-to-end cascade ──────────────────────────────────────────────────
  attachSemanticIndex(graph, index);
  // The note edited above bumped graph.version, so the first cascade call would
  // otherwise rebuild the BM25 and fuse indexes and be timed as query latency.
  const rebuild = await timed(() => cascadeSearch(graph, "warmup", 10, undefined));
  const cascadeLatencies = [];
  let hits = 0;
  let semanticTierUsed = 0;
  for (const [i, concept] of CONCEPTS.entries()) {
    const run = await timed(() => cascadeSearch(graph, concept.query, 10, undefined));
    cascadeLatencies.push(run.elapsed);
    if (run.value.tiersUsed.includes("semantic")) semanticTierUsed++;
    if (run.value.results.some((r) => r.path === truthPaths[i])) hits++;
  }

  // ── Escalation gate: an exact-title query must not touch the embedder ───
  if (stub) stub.reset();
  const confident = await cascadeSearch(graph, "Litware Spend Anomaly", 10, undefined);
  const embedCallsOnConfidentQuery = stub ? stub.calls : 0;

  detachSemanticIndex(graph);
  // Searching schedules a background refresh; drain it before the vault is
  // deleted, or its save races the cleanup and logs a spurious ENOENT.
  await index.refresh(graph);
  await reloaded.refresh(graph);

  rows.push({
    noteCount,
    indexed: index.stats.note_count,
    graphBuildMs: graphBuild.elapsed,
    coldMs: cold.elapsed,
    perNoteMs: cold.elapsed / index.stats.note_count,
    vectorBytes: index.stats.note_count * index.stats.dimensions * 4,
    sidecarBytes: sidecar.size,
    reloadMs: reload.elapsed,
    noopMs: noop.elapsed,
    reembeddedOnRestart,
    incrementalMs: incremental.elapsed,
    reembeddedOnEdit,
    vectorP50: percentile(latencies, 50),
    vectorP95: percentile(latencies, 95),
    rebuildMs: rebuild.elapsed,
    cascadeP50: percentile(cascadeLatencies, 50),
    cascadeP95: percentile(cascadeLatencies, 95),
    semanticTierUsed,
    recall: hits / CONCEPTS.length,
    confidentTiers: confident.tiersUsed.join("+"),
    embedCallsOnConfidentQuery,
  });

  await rm(root, { recursive: true, force: true });
}

if (stub) await stub.close();

// ─── Report ───────────────────────────────────────────────────────────────────

const pad = (v, w) => String(v).padStart(w);

console.log("\n── Indexing ──────────────────────────────────────────────────────────────────");
console.log("  notes   graph     cold embed   per note   vectors    sidecar");
for (const r of rows) {
  console.log(
    `  ${pad(r.noteCount, 5)}   ${pad(ms(r.graphBuildMs), 9)} ${pad(ms(r.coldMs), 12)} ` +
      `${pad(r.perNoteMs.toFixed(2) + " ms", 10)} ${pad(mb(r.vectorBytes), 10)} ${pad(mb(r.sidecarBytes), 10)}`,
  );
}

console.log("\n── Restart & incremental update ──────────────────────────────────────────────");
console.log("  notes   sidecar load   no-op refresh   re-embedded   1-note edit   re-embedded");
for (const r of rows) {
  console.log(
    `  ${pad(r.noteCount, 5)}   ${pad(ms(r.reloadMs), 12)} ${pad(ms(r.noopMs), 15)} ` +
      `${pad(r.reembeddedOnRestart, 13)} ${pad(ms(r.incrementalMs), 13)} ${pad(r.reembeddedOnEdit, 12)}`,
  );
}

console.log("\n── Query latency ─────────────────────────────────────────────────────────────");
console.log("  notes   vector p50   vector p95   cascade p50   cascade p95   1st call after edit");
for (const r of rows) {
  console.log(
    `  ${pad(r.noteCount, 5)}   ${pad(ms(r.vectorP50), 12)} ${pad(ms(r.vectorP95), 12)} ` +
      `${pad(ms(r.cascadeP50), 13)} ${pad(ms(r.cascadeP95), 13)} ${pad(ms(r.rebuildMs), 21)}`,
  );
}

console.log("\n── Escalation gate ───────────────────────────────────────────────────────────");
for (const r of rows) {
  console.log(
    `  ${pad(r.noteCount, 5)} notes: exact-title query used [${r.confidentTiers}], ` +
      `embed calls: ${r.embedCallsOnConfidentQuery} (must be 0); ` +
      `semantic tier engaged on ${r.semanticTierUsed}/${CONCEPTS.length} paraphrase queries`,
  );
}

console.log("\n── Retrieval quality (paraphrase queries, top-10) ────────────────────────────");
if (useReal) {
  for (const r of rows) {
    console.log(`  ${pad(r.noteCount, 5)} notes: recall@10 = ${(r.recall * 100).toFixed(0)}%`);
  }
} else {
  console.log("  SKIPPED — a stub embedder cannot model meaning. Install Ollama and re-run");
  console.log("  this script to measure recall on the paraphrase set.");
}
console.log();
