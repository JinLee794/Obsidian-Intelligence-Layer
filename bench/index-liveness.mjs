/**
 * Index liveness validation — end-to-end, through the real tool layer.
 *
 * Unit tests prove the incremental index equals a full rebuild. This proves the
 * wiring around it: that a file changing on disk, or a write going through the
 * MCP tools, actually reaches BM25, the fuzzy index and the semantic tier, and
 * that stale state is genuinely gone rather than merely outranked.
 *
 *   node bench/index-liveness.mjs [noteCount]
 */

import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GraphIndex } from "../dist/graph.js";
import { SessionCache } from "../dist/cache.js";
import { VaultWatcher } from "../dist/watcher.js";
import { DEFAULT_CONFIG } from "../dist/config.js";
import { SemanticIndex, attachSemanticIndex } from "../dist/semantic.js";
import { lexicalSearch, fuzzySearch } from "../dist/search.js";
import { exactFieldSearch } from "../dist/bm25.js";
import { registerRetrieveTools } from "../dist/tools/retrieve.js";
import { registerWriteTools } from "../dist/tools/write.js";

const NOTE_COUNT = Number(process.argv[2]) || 2000;
const DIMENSIONS = 768;
/** chokidar debounce (300ms) + awaitWriteFinish (200ms) plus slack. */
const WATCH_SETTLE_MS = 1600;

// ─── Assertions ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Minimal MCP server ───────────────────────────────────────────────────────

class MockMcpServer {
  tools = new Map();
  registerTool(name, config, handler) {
    this.tools.set(name, { config, handler });
  }
  async call(name, args) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    const result = await tool.handler(args);
    return JSON.parse(result.content[0].text);
  }
}

// ─── Stub Ollama ──────────────────────────────────────────────────────────────

function stubVector(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    if (code >= 97 && code <= 122) vector[(code * 31 + i) % DIMENSIONS] += 1;
  }
  return vector;
}

async function startStub() {
  const state = { embedded: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const inputs = JSON.parse(body || "{}").input ?? [];
      state.embedded.push(...inputs);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: inputs.map(stubVector) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.endpoint = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

// ─── Vault ────────────────────────────────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), "oil-liveness-"));
const vault = join(root, "vault");
await mkdir(join(vault, "Customers"), { recursive: true });
await mkdir(join(vault, "Notes"), { recursive: true });

await writeFile(
  join(vault, "Customers/Zephyr.md"),
  `---\ntags: [customer]\ntpid: TPID-ZEPH\n---\n# Zephyr Dynamics\n\n## Status\n\nOriginalmarker content about quarterly planning.\n`,
  "utf-8",
);
for (let i = 0; i < NOTE_COUNT; i++) {
  await writeFile(
    join(vault, "Notes", `note-${i}.md`),
    `---\ntags: [routine]\n---\n# Working Note ${i}\n\n## Session ${i % 30}\n\nRoutine notes for iteration ${i}.\n`,
    "utf-8",
  );
}

const stub = await startStub();
const config = {
  ...DEFAULT_CONFIG,
  semantic: { ...DEFAULT_CONFIG.semantic, endpoint: stub.endpoint, minScore: -1 },
};

const graph = new GraphIndex(vault);
await graph.build();

const cache = new SessionCache();
const semantic = new SemanticIndex(vault, config.semantic);
attachSemanticIndex(graph, semantic);
await semantic.refresh(graph);

const server = new MockMcpServer();
registerRetrieveTools(server, vault, graph, cache, config);
registerWriteTools(server, vault, graph, cache, config);

const watcher = new VaultWatcher(vault, graph, cache);
watcher.start();
await watcher.whenReady();

const search = async (query, limit = 10) =>
  (await server.call("search_vault", { query, limit })).results.map((r) => r.path);

/**
 * The tier floor is deliberately wide open in this harness, so an escalating
 * query still returns semantically "nearest" notes. Staleness therefore has to
 * be checked as absence of the specific note plus an empty lexical tier, never
 * as an empty result set.
 */
const lexicalPaths = (query) => lexicalSearch(graph, query, 20).map((r) => r.path);

console.log(`\nIndex liveness — ${NOTE_COUNT + 1} notes\n`);

// ─── 1. Baseline ──────────────────────────────────────────────────────────────

console.log("Baseline");
check(
  "seeded note is searchable by a unique body term",
  (await search("Originalmarker")).includes("Customers/Zephyr.md"),
);
check(
  "semantic index covers every note",
  semantic.stats.note_count === graph.nodeCount,
  `vectors=${semantic.stats.note_count} nodes=${graph.nodeCount}`,
);

// ─── 2. Watcher-driven edit ───────────────────────────────────────────────────

console.log("\nWatcher — in-place edit");
const embeddedBeforeEdit = stub.embedded.length;
await writeFile(
  join(vault, "Customers/Zephyr.md"),
  `---\ntags: [customer]\ntpid: TPID-ZEPH\n---\n# Zephyr Dynamics\n\n## Status\n\nReplacedmarker content about renewal escalation.\n`,
  "utf-8",
);
await sleep(WATCH_SETTLE_MS);

check(
  "watcher re-read the note from disk",
  graph.getNode("Customers/Zephyr.md")?.bodySnippet.includes("Replacedmarker") === true,
  "graph node still holds stale content",
);
check(
  "new body term is searchable",
  lexicalPaths("Replacedmarker").includes("Customers/Zephyr.md"),
);

if (process.env.OIL_DEBUG) {
  const node = graph.getNode("Customers/Zephyr.md");
  console.log("    debug bodySnippet:", JSON.stringify(node?.bodySnippet));
  console.log("    debug nodeCount:", graph.nodeCount);
}

check(
  "old body term no longer matches the note",
  !lexicalPaths("Originalmarker").includes("Customers/Zephyr.md") &&
    !(await search("Originalmarker")).includes("Customers/Zephyr.md"),
  `lexical=${JSON.stringify(lexicalPaths("Originalmarker"))}`,
);

// Drain any refresh already scheduled by an escalating query, then judge by
// what was embedded rather than when: note texts are multi-line, queries are not.
await semantic.refresh(graph);
const embeddedSinceEdit = stub.embedded.slice(embeddedBeforeEdit);
const notesReEmbedded = embeddedSinceEdit.filter((text) => text.includes("\n"));
check(
  "semantic re-embedded exactly one note, and it is the edited one",
  notesReEmbedded.length === 1 && notesReEmbedded[0].includes("Replacedmarker"),
  `re-embedded ${notesReEmbedded.length} note(s)`,
);

// ─── 3. Watcher-driven create ─────────────────────────────────────────────────

console.log("\nWatcher — new file");
await writeFile(
  join(vault, "Customers/Novelty.md"),
  `---\ntags: [customer]\ntpid: TPID-NOVEL\n---\n# Novelty Corp\n\n## Status\n\nBrandnewmarker onboarding notes.\n`,
  "utf-8",
);
await sleep(WATCH_SETTLE_MS);

check("new note is searchable", lexicalPaths("Brandnewmarker").includes("Customers/Novelty.md"));
check(
  "new note answers an exact frontmatter lookup",
  (await search("TPID-NOVEL")).includes("Customers/Novelty.md"),
);
check("graph counted the new note", graph.nodeCount === NOTE_COUNT + 2, `nodeCount=${graph.nodeCount}`);

// ─── 4. Watcher-driven delete ─────────────────────────────────────────────────

console.log("\nWatcher — delete");
await unlink(join(vault, "Customers/Zephyr.md"));
await sleep(WATCH_SETTLE_MS);

check(
  "deleted note leaves no lexical trace",
  lexicalPaths("Replacedmarker").length === 0 &&
    !(await search("Replacedmarker")).includes("Customers/Zephyr.md"),
  `lexical=${JSON.stringify(lexicalPaths("Replacedmarker"))}`,
);
check(
  "deleted note leaves no exact-field trace",
  exactFieldSearch(graph, "TPID-ZEPH").length === 0,
  `exact=${JSON.stringify(exactFieldSearch(graph, "TPID-ZEPH").map((h) => h.path))}`,
);
check(
  "deleted note is out of the fuzzy index",
  fuzzySearch(graph, "Zephyr Dynamics", 10).every((r) => r.path !== "Customers/Zephyr.md"),
);
await semantic.refresh(graph);
check(
  "semantic dropped the deleted note",
  semantic.stats.note_count === graph.nodeCount,
  `vectors=${semantic.stats.note_count} nodes=${graph.nodeCount}`,
);

// ─── 5. Write tools are visible immediately ───────────────────────────────────

console.log("\nWrite tools — no watcher wait");
await server.call("create_note", {
  path: "Customers/Written.md",
  content: `---\ntags: [customer]\n---\n# Written Corp\n\n## Status\n\nToolwrittenmarker first draft.\n`,
});
check(
  "create_note is searchable with no delay",
  lexicalPaths("Toolwrittenmarker").includes("Customers/Written.md"),
);

const meta = await server.call("get_note_metadata", { path: "Customers/Written.md" });
await server.call("atomic_append", {
  path: "Customers/Written.md",
  heading: "Status",
  content: "Appendedmarker follow-up.",
  expected_mtime: meta.mtime_ms,
});
check(
  "atomic_append is searchable with no delay",
  lexicalPaths("Appendedmarker").includes("Customers/Written.md"),
);

// ─── 6. Equivalence against a full rebuild, at scale ──────────────────────────

console.log("\nEquivalence after all mutations");
await sleep(WATCH_SETTLE_MS);

const fresh = new GraphIndex(vault);
await fresh.build();

check(
  "node count matches a fresh build",
  graph.nodeCount === fresh.nodeCount,
  `incremental=${graph.nodeCount} fresh=${fresh.nodeCount}`,
);

let rankingMatches = true;
let firstMismatch = "";
for (const query of ["routine", "iteration", "customer", "Novelty", "session planning", "Appendedmarker"]) {
  const incremental = JSON.stringify(lexicalSearch(graph, query, 20));
  const rebuilt = JSON.stringify(lexicalSearch(fresh, query, 20));
  if (incremental !== rebuilt) {
    rankingMatches = false;
    firstMismatch = query;
    break;
  }
}
check("BM25 ranking identical to a fresh rebuild", rankingMatches, `first mismatch: ${firstMismatch}`);

let fuzzyMatches = true;
for (const query of ["Novelty", "Written", "Working Note"]) {
  const a = fuzzySearch(graph, query, 20).map((r) => r.path).sort().join("|");
  const b = fuzzySearch(fresh, query, 20).map((r) => r.path).sort().join("|");
  if (a !== b) {
    fuzzyMatches = false;
    firstMismatch = query;
    break;
  }
}
check("fuzzy membership identical to a fresh rebuild", fuzzyMatches, `first mismatch: ${firstMismatch}`);

// ─── 7. Semantic tier participates in the cascade ─────────────────────────────

console.log("\nSemantic tier in the cascade");
const escalated = await server.call("search_vault", {
  query: "something entirely unrelated to any indexed vocabulary whatsoever",
  limit: 5,
});
check(
  "semantic tier engages when lexical cannot cover the query",
  escalated.tiers_used.includes("semantic"),
  `tiers=${JSON.stringify(escalated.tiers_used)}`,
);

const confident = await server.call("search_vault", { query: "Novelty Corp", limit: 10 });
check(
  "semantic tier stays out of a confident lexical answer",
  !confident.tiers_used.includes("semantic"),
  `tiers=${JSON.stringify(confident.tiers_used)}`,
);

// ─── Teardown ─────────────────────────────────────────────────────────────────

await watcher.stop();
await semantic.refresh(graph);
await stub.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
