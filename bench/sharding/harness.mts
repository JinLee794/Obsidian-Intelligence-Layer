// Benchmark harness: A (real GraphIndex + Bm25Index) vs B (skeleton + segments,
// folder policy) vs B2 (finer segments) vs C (independent per-folder graphs).
//
//   node --expose-gc --import ./bench/sharding/loader/register.mjs \
//        bench/sharding/harness.mts --size 5000 --runs 5
//
// Writes bench/sharding/results-<size>.json. Vaults are synthetic and live in
// os.tmpdir(); every root is checked before use and removed afterwards.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── write accounting: wrap fs/promises.writeFile before anything imports it ──
const require = createRequire(import.meta.url);
const fsp = require("node:fs/promises");
const realWriteFile = fsp.writeFile;
const writeLog: Array<{ file: string; bytes: number }> = [];
let recordWrites = false;
fsp.writeFile = function (file: unknown, data: unknown, ...rest: unknown[]) {
  if (recordWrites) {
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : (data as Uint8Array)?.byteLength ?? 0;
    writeLog.push({ file: String(file), bytes });
  }
  return realWriteFile.call(this, file, data, ...rest);
};
syncBuiltinESMExports();

const { mkdtemp, rm, readFile, readdir, stat, appendFile, utimes, writeFile } = await import("node:fs/promises");
const { GraphIndex } = await import("../../src/graph.js");
const { bm25Search } = await import("../../src/bm25.js");
const { generateVault, mulberry32 } = await import("./fixtures.mjs");
const { SegmentedGraph } = await import("./segmented.mjs");
const { IndependentGraphs } = await import("./independent.mjs");

type GI = InstanceType<typeof GraphIndex>;
type SG = InstanceType<typeof SegmentedGraph>;

const origErr = console.error;
console.error = (...a: unknown[]) => {
  if (typeof a[0] === "string" && a[0].startsWith("[OIL]")) return;
  origErr(...a);
};

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const SIZE = arg("size", 1400);
const RUNS = Math.max(1, arg("runs", 5));
const MASS_RUNS = Math.max(1, arg("mass-runs", RUNS));
if (!Number.isInteger(SIZE) || SIZE < 500 || !Number.isInteger(RUNS) || !Number.isInteger(MASS_RUNS)) {
  console.error(
    `harness: --size must be an integer >= 500 and --runs/--mass-runs integers (got size=${argv[argv.indexOf("--size") + 1]}).\n` +
      `  e.g. node --expose-gc --import ./bench/sharding/loader/register.mjs bench/sharding/harness.mts --size 1400 --runs 5`,
  );
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const A_FILE = "_oil-graph.json";
const gc = (globalThis as any).gc as (() => void) | undefined;

// ── stats helpers ───────────────────────────────────────────────────────────
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = sorted(xs), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = sorted(xs);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const summary = (xs: number[]) => ({ n: xs.length, median: median(xs), p95: pct(xs, 95), min: Math.min(...xs), max: Math.max(...xs) });
const now = () => performance.now();
const jaccard = (x: string[], y: string[]) => {
  const X = new Set(x), Y = new Set(y);
  const uni = new Set([...X, ...Y]).size;
  return uni === 0 ? 1 : [...X].filter((v) => Y.has(v)).length / uni;
};
const setEq = (x: Set<string>, y: Set<string>) => x.size === y.size && [...x].every((v) => y.has(v));

function assertSafeRoot(root: string): void {
  const r = resolve(root).toLowerCase();
  const t = resolve(tmpdir()).toLowerCase();
  if (!r.startsWith(t) || r.includes("onedrive") || r.includes("obsidian")) {
    throw new Error(`refusing non-temp vault root: ${root}`);
  }
}

// ── variants ────────────────────────────────────────────────────────────────
type VName = "A" | "B" | "B2";
const VARIANTS: VName[] = ["A", "B", "B2"];
const order = (run: number): VName[] => (run % 2 === 0 ? VARIANTS : [...VARIANTS].reverse());

interface Hit { path: string; score: number }
interface V {
  name: VName;
  g: GI;
  search(q: string, limit: number, accept?: (p: string) => boolean): Promise<Hit[]>;
  flush(): Promise<unknown>;
  revalidate(): Promise<number>;
}

function wrapA(g: GI): V {
  return {
    name: "A",
    g,
    search: async (q, l, acc) => bm25Search(g, q, l, acc),
    flush: () => g.flush(A_FILE),
    revalidate: () => g.buildIncremental(A_FILE),
  };
}
function wrapB(name: VName, g: SG): V {
  return {
    name,
    g,
    search: (q, l, acc) => g.search(q, l, acc),
    flush: () => g.flushAll(),
    revalidate: () => g.revalidate(),
  };
}
async function warm(name: VName, root: string): Promise<V> {
  if (name === "A") {
    const g = new GraphIndex(root);
    if (!(await g.loadFromDisk(A_FILE))) throw new Error("A cache missing");
    return wrapA(g);
  }
  const g = new SegmentedGraph(root, name === "B" ? "folder" : "fine");
  if (!(await g.loadWarm())) throw new Error(`${name} cache missing`);
  return wrapB(name, g);
}
async function cold(name: VName, root: string): Promise<{ v: V; buildMs: number; saveMs: number }> {
  const t0 = now();
  let v: V;
  if (name === "A") {
    const g = new GraphIndex(root);
    await g.build();
    v = wrapA(g);
  } else {
    const g = new SegmentedGraph(root, name === "B" ? "folder" : "fine");
    await g.build();
    v = wrapB(name, g);
  }
  const t1 = now();
  if (name === "A") await v.g.saveToDisk(A_FILE);
  else await (v.g as SG).save();
  return { v, buildMs: t1 - t0, saveMs: now() - t1 };
}

// ── query models (shared by every variant; skeleton data only) ──────────────
const DAY = 86_400_000;
function dateOf(g: GI, p: string): string | undefined {
  const d = g.getNode(p)?.frontmatter?.date;
  return typeof d === "string" ? d : undefined;
}
function meetingsFor(g: GI, customer: string, nowIso: string, days: number): string[] {
  const cutoff = new Date(Date.parse(nowIso) - days * DAY).toISOString().slice(0, 10);
  const out: string[] = [];
  for (const ref of g.getNotesByFolder("Meetings/")) {
    const fm = g.getNode(ref.path)?.frontmatter;
    if (!fm || String(fm.customer ?? "").toLowerCase() !== customer.toLowerCase()) continue;
    const d = dateOf(g, ref.path);
    if (d && d >= cutoff) out.push(ref.path);
  }
  return out;
}
/** S1b scope: hub folder ∪ hub links ∪ hub backlinks ∪ last-year meetings. */
function neighborhood(g: GI, c: { name: string; hub: string }, nowIso: string): Set<string> {
  const s = new Set<string>();
  for (const ref of g.getNotesByFolder(`Customers/${c.name}/`)) s.add(ref.path);
  for (const ref of g.getForwardLinks(c.hub)) s.add(ref.path);
  for (const ref of g.getBacklinks(c.hub)) s.add(ref.path);
  for (const p of meetingsFor(g, c.name, nowIso, 365)) s.add(p);
  return s;
}
/** S4: modelled on tools/domain.ts get_customer_context (people, meetings, open items). */
async function customerContext(g: GI, root: string, c: { name: string; hub: string }, nowIso: string) {
  const people: string[] = [];
  for (const ref of g.getNotesByFolder("People/")) {
    const list = g.getNode(ref.path)?.frontmatter?.customers;
    if (Array.isArray(list) && list.some((x) => String(x).toLowerCase() === c.name.toLowerCase())) people.push(ref.path);
  }
  const meetings = meetingsFor(g, c.name, nowIso, 90);
  const sources = new Set<string>([c.hub, ...meetings]);
  for (const ref of g.getForwardLinks(c.hub)) sources.add(ref.path);
  for (const ref of g.getBacklinks(c.hub)) sources.add(ref.path);
  const open: string[] = [];
  for (const p of [...sources].sort()) {
    const text = await readFile(join(root, p), "utf-8").catch(() => "");
    for (const line of text.split("\n")) {
      const m = /^\s*- \[ \]\s+(.*)$/.exec(line);
      if (m) open.push(`${p}::${m[1].trim()}`);
    }
  }
  return { people: people.sort(), meetings: meetings.sort(), open };
}

type QType = "S1a" | "S1b" | "S2" | "S3" | "S4" | "S5";
async function runQuery(v: V, type: QType, root: string, info: any, ci: number, q: string): Promise<unknown> {
  const c = info.customers[ci % info.customers.length];
  switch (type) {
    case "S1a": {
      const prefix = `Customers/${c.name}/`;
      return v.search(q, 10, (p) => p.startsWith(prefix));
    }
    case "S1b": {
      const scope = neighborhood(v.g, c, info.now);
      return v.search(q, 10, (p) => scope.has(p));
    }
    case "S2": {
      const prefix = ci % 2 === 0 ? "Projects/" : "Meetings/";
      return v.search(q, 10, (p) => p.startsWith(prefix));
    }
    case "S3":
      return v.g.getBacklinks(c.hub).map((r) => r.path).sort();
    case "S4":
      return customerContext(v.g, root, c, info.now);
    case "S5":
      return v.search(q, 10);
  }
}
const scopedStrings = (c: { name: string }) => [`${c.name} escalation`, "renewal risk", "migration pipeline", "latency budget overrun"];

// ── file sizes ──────────────────────────────────────────────────────────────
async function persisted(root: string) {
  const a = (await stat(join(root, A_FILE))).size;
  const out: Record<string, unknown> = { A: { total: a } };
  for (const [name, dir] of [["B", "_oil-shards-folder"], ["B2", "_oil-shards-fine"]] as const) {
    const files = (await readdir(join(root, dir))).filter((f) => f.endsWith(".json"));
    let total = 0, skeleton = 0, stats = 0, largest = 0, largestKey = "", segs = 0;
    for (const f of files) {
      const size = (await stat(join(root, dir, f))).size;
      total += size;
      if (f === "skeleton.json") skeleton = size;
      else if (f === "stats.json") stats = size;
      else {
        segs++;
        if (size > largest) { largest = size; largestKey = f; }
      }
    }
    out[name] = { total, skeleton, stats, segments: segs, largestSegment: largest, largestSegmentFile: largestKey };
  }
  return out;
}

function classify(file: string): string {
  if (file.includes(A_FILE)) return "graph";
  if (file.includes("skeleton.json")) return "skeleton";
  if (file.includes("stats.json")) return "stats";
  if (file.includes("seg-")) return "segment";
  return "other";
}
/** Cache files → {mtime,size}; a cross-check that does not depend on the writeFile patch. */
async function snapshot(): Promise<Map<string, { m: number; s: number }>> {
  const out = new Map<string, { m: number; s: number }>();
  const add = async (p: string) => {
    const st = await stat(p).catch(() => null);
    if (st) out.set(p, { m: st.mtimeMs, s: st.size });
  };
  await add(join(snapRoot, A_FILE));
  for (const dir of ["_oil-shards-folder", "_oil-shards-fine"]) {
    const files = await readdir(join(snapRoot, dir)).catch(() => [] as string[]);
    for (const f of files) await add(join(snapRoot, dir, f));
  }
  return out;
}
let snapRoot = "";

async function measureWrites<T>(fn: () => Promise<T>) {
  const before = await snapshot();
  writeLog.length = 0;
  recordWrites = true;
  const h = monitorEventLoopDelay({ resolution: 1 });
  const realStringify = JSON.stringify;
  let maxStringify = 0;
  JSON.stringify = function (this: unknown, ...a: Parameters<typeof JSON.stringify>) {
    const t = now();
    const r = realStringify.apply(JSON, a);
    maxStringify = Math.max(maxStringify, now() - t);
    return r;
  } as typeof JSON.stringify;
  h.enable();
  const t0 = now();
  let result: T;
  try {
    result = await fn();
  } finally {
    h.disable();
    JSON.stringify = realStringify;
    recordWrites = false;
  }
  const ms = now() - t0;
  const byKind: Record<string, { files: number; bytes: number }> = {};
  let bytes = 0;
  for (const w of writeLog) {
    const k = classify(w.file);
    byKind[k] ??= { files: 0, bytes: 0 };
    byKind[k].files++;
    byKind[k].bytes += w.bytes;
    bytes += w.bytes;
  }
  // Final size of every cache file that changed (undercounts repeated checkpoints of one file).
  let changedBytes = 0;
  for (const [p, a] of await snapshot()) {
    const b = before.get(p);
    if (!b || b.m !== a.m || b.s !== a.s) changedBytes += a.s;
  }
  return { result: result!, ms, bytes, writes: writeLog.length, byKind, changedBytes, elMaxMs: h.max / 1e6, stringifyMaxMs: maxStringify };
}

// ── parity ──────────────────────────────────────────────────────────────────
function linkParity(a: GI, other: { fwd(p: string): Set<string>; back(p: string): Set<string> }) {
  let ok = 0, fwdBad = 0, backBad = 0;
  const paths = a.getNotesByFolder("").map((r) => r.path);
  const examples: string[] = [];
  for (const p of paths) {
    const f = setEq(new Set(a.getForwardLinks(p).map((r) => r.path)), other.fwd(p));
    const b = setEq(new Set(a.getBacklinks(p).map((r) => r.path)), other.back(p));
    if (f && b) ok++;
    else if (examples.length < 5) examples.push(p);
    if (!f) fwdBad++;
    if (!b) backBad++;
  }
  return { notes: paths.length, equal: ok, rate: ok / paths.length, fwdMismatch: fwdBad, backMismatch: backBad, examples };
}
const graphLinks = (g: GI) => ({
  fwd: (p: string) => new Set(g.getForwardLinks(p).map((r) => r.path)),
  back: (p: string) => new Set(g.getBacklinks(p).map((r) => r.path)),
});

async function searchParity(a: V, b: { search: V["search"] }, info: any) {
  const rows: Array<{ type: string; q: string; jaccard: number; exact: boolean }> = [];
  const cmp = async (type: string, q: string, acc?: (p: string) => boolean) => {
    const ha = await a.search(q, 10, acc);
    const hb = await b.search(q, 10, acc);
    const exact = ha.length === hb.length && ha.every((h, i) => h.path === hb[i].path && Math.abs(h.score - hb[i].score) < 1e-9);
    rows.push({ type, q, jaccard: jaccard(ha.map((h) => h.path), hb.map((h) => h.path)), exact });
  };
  for (const q of info.queries) await cmp("S5", q);
  for (let ci = 0; ci < info.customers.length; ci++) {
    const c = info.customers[ci];
    const scope = neighborhood(a.g, c, info.now);
    for (const q of scopedStrings(c)) {
      await cmp("S1a", q, (p) => p.startsWith(`Customers/${c.name}/`));
      await cmp("S1b", q, (p) => scope.has(p));
    }
    await cmp("S2", scopedStrings(c)[1 + (ci % 3)], (p) => p.startsWith(ci % 2 === 0 ? "Projects/" : "Meetings/"));
  }
  const byType: Record<string, { n: number; meanJaccard: number; minJaccard: number; exactRate: number }> = {};
  for (const t of new Set(rows.map((r) => r.type))) {
    const rs = rows.filter((r) => r.type === t);
    byType[t] = {
      n: rs.length,
      meanJaccard: rs.reduce((s, r) => s + r.jaccard, 0) / rs.length,
      minJaccard: Math.min(...rs.map((r) => r.jaccard)),
      exactRate: rs.filter((r) => r.exact).length / rs.length,
    };
  }
  const all = rows.reduce((s, r) => s + r.jaccard, 0) / rows.length;
  const worst = rows.filter((r) => r.jaccard < 1).slice(0, 5);
  return { queries: rows.length, meanJaccard: all, exactRate: rows.filter((r) => r.exact).length / rows.length, byType, worst };
}

async function contextParity(a: V, b: V, root: string, info: any) {
  let equal = 0;
  for (let ci = 0; ci < info.customers.length; ci++) {
    const x = await customerContext(a.g, root, info.customers[ci], info.now);
    const y = await customerContext(b.g, root, info.customers[ci], info.now);
    if (JSON.stringify(x) === JSON.stringify(y)) equal++;
  }
  return { customers: info.customers.length, equal };
}

// ── main ────────────────────────────────────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), `oil-shard-${SIZE}-`));
assertSafeRoot(root);
snapRoot = root;
const results: any = { size: SIZE, runs: RUNS, massRuns: MASS_RUNS, node: process.version, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString() };
const log = (msg: string) => origErr(`[bench ${SIZE}] ${new Date().toISOString().slice(11, 19)} ${msg}`);

try {
  // Fixture
  let t = now();
  const info = await generateVault(root, SIZE);
  results.fixture = { genMs: now() - t, notes: info.total, counts: info.counts, editTargets: info.editTargets };
  log(`fixture ${info.total} notes in ${(now() - t).toFixed(0)} ms`);

  // 1. Cold build (interleaved) + C
  const coldRes: Record<string, { build: number[]; save: number[] }> = { A: { build: [], save: [] }, B: { build: [], save: [] }, B2: { build: [], save: [] }, C: { build: [], save: [] } };
  for (let r = 0; r < RUNS; r++) {
    for (const name of order(r)) {
      const { buildMs, saveMs } = await cold(name, root);
      coldRes[name].build.push(buildMs);
      coldRes[name].save.push(saveMs);
    }
    t = now();
    const c = new IndependentGraphs(root);
    await c.build();
    coldRes.C.build.push(now() - t);
    coldRes.C.save.push(0);
    log(`cold run ${r + 1}/${RUNS}`);
  }
  results.coldBuild = Object.fromEntries(
    Object.entries(coldRes).map(([k, v]) => [k, { build: summary(v.build), save: summary(v.save), total: summary(v.build.map((b, i) => b + v.save[i])) }]),
  );
  results.persistedBytes = await persisted(root);
  log(`persisted ${JSON.stringify(results.persistedBytes)}`);
  {
    // Self-check: the wrapped writeFile must see graph.ts's named-import writes.
    const a = await warm("A", root);
    const chk = await measureWrites(() => a.g.saveToDisk(A_FILE));
    const onDisk = (await stat(join(root, A_FILE))).size;
    results.writeAccountingCheck = { counted: chk.bytes, changedBytes: chk.changedBytes, onDisk, ok: chk.bytes === onDisk };
    if (!results.writeAccountingCheck.ok) log(`WARNING write accounting ${JSON.stringify(results.writeAccountingCheck)}; use changedBytes`);
  }

  // 2. Parity after cold build (A, B, B2, C) and after warm load
  {
    const a = (await cold("A", root)).v;
    const b = (await cold("B", root)).v;
    const b2 = (await cold("B2", root)).v;
    const c = new IndependentGraphs(root);
    await c.build();
    results.parity = {
      coldLinks: { B: linkParity(a.g, graphLinks(b.g)), B2: linkParity(a.g, graphLinks(b2.g)) },
      coldSearch: { B: await searchParity(a, b, info), B2: await searchParity(a, b2, info) },
      coldContext: { B: await contextParity(a, b, root, info), B2: await contextParity(a, b2, root, info) },
    };
    results.driftC = {
      links: linkParity(a.g, { fwd: (p) => c.forward(p), back: (p) => c.back(p) }),
      search: await searchParity(a, { search: async (q, l, acc) => c.search(q, l, acc) }, info),
      crossEdges: [...c.edges.values()].reduce((n, s) => n + s.size, 0),
      unresolvedAfterCross: c.unresolved,
      brokenInA: a.g.getBrokenLinks().length,
    };
    const wa = await warm("A", root), wb = await warm("B", root), wb2 = await warm("B2", root);
    results.parity.warmLinks = { B: linkParity(wa.g, graphLinks(wb.g)), B2: linkParity(wa.g, graphLinks(wb2.g)) };
    results.parity.warmSearch = { B: await searchParity(wa, wb, info), B2: await searchParity(wa, wb2, info) };
    log(`parity B links ${results.parity.coldLinks.B.rate} search ${results.parity.coldSearch.B.meanJaccard.toFixed(4)}; C links ${results.driftC.links.rate.toFixed(4)} search ${results.driftC.search.meanJaccard.toFixed(4)}`);
  }

  // 3. Warm load → first answer (fresh instance per measurement, interleaved)
  const firstTypes: Array<{ id: string; type: QType; reval: boolean }> = [
    { id: "S1a", type: "S1a", reval: false },
    { id: "S1b", type: "S1b", reval: false },
    { id: "S4", type: "S4", reval: false },
    { id: "S5", type: "S5", reval: false },
    { id: "S1b+reval", type: "S1b", reval: true },
  ];
  const warmRes: any = {};
  for (const ft of firstTypes) {
    warmRes[ft.id] = Object.fromEntries(VARIANTS.map((n) => [n, { loadMs: [] as number[], revalMs: [] as number[], queryMs: [] as number[], totalMs: [] as number[], segmentsLoaded: [] as number[] }]));
  }
  for (let r = 0; r < RUNS; r++) {
    for (const ft of firstTypes) {
      for (const name of order(r)) {
        gc?.();
        const c = info.customers[r % info.customers.length];
        const q = ft.type === "S5" ? info.queries[r % info.queries.length] : `${c.name} escalation`;
        const t0 = now();
        const v = await warm(name, root);
        const t1 = now();
        if (ft.reval) await v.revalidate();
        const t2 = now();
        await runQuery(v, ft.type, root, info, r, q);
        const t3 = now();
        const m = warmRes[ft.id][name];
        m.loadMs.push(t1 - t0);
        m.revalMs.push(t2 - t1);
        m.queryMs.push(t3 - t2);
        m.totalMs.push(t3 - t0);
        m.segmentsLoaded.push(name === "A" ? 0 : (v.g as SG).loadedSegmentCount);
      }
    }
    log(`warm run ${r + 1}/${RUNS}`);
  }
  results.warmFirstAnswer = Object.fromEntries(
    Object.entries(warmRes).map(([id, per]: [string, any]) => [
      id,
      Object.fromEntries(Object.entries(per).map(([n, m]: [string, any]) => [n, {
        load: summary(m.loadMs), reval: summary(m.revalMs), query: summary(m.queryMs), total: summary(m.totalMs), segmentsLoaded: median(m.segmentsLoaded),
      }])),
    ]),
  );
  for (const n of ["B", "B2"] as const) {
    results.warmFirstAnswer.segmentsTotal ??= {};
    const g = (await warm(n, root)).g as SG;
    results.warmFirstAnswer.segmentsTotal[n] = g.allSegmentKeys().size;
  }

  // 4. Heap after warm load and after a customer-scoped query
  if (gc) {
    const heap: any = Object.fromEntries(VARIANTS.map((n) => [n, { afterLoad: [] as number[], afterS1b: [] as number[], afterS5: [] as number[] }]));
    for (let r = 0; r < Math.min(RUNS, 3); r++) {
      for (const name of order(r)) {
        gc(); gc();
        const base = process.memoryUsage().heapUsed;
        let v: V | null = await warm(name, root);
        gc(); gc();
        heap[name].afterLoad.push(process.memoryUsage().heapUsed - base);
        await runQuery(v, "S1b", root, info, r, `${info.customers[r].name} escalation`);
        gc(); gc();
        heap[name].afterS1b.push(process.memoryUsage().heapUsed - base);
        await runQuery(v, "S5", root, info, r, info.queries[r]);
        gc(); gc();
        heap[name].afterS5.push(process.memoryUsage().heapUsed - base);
        v = null;
      }
    }
    results.heapBytes = Object.fromEntries(Object.entries(heap).map(([n, m]: [string, any]) => [n, {
      afterLoad: median(m.afterLoad), afterS1b: median(m.afterS1b), afterS5: median(m.afterS5),
    }]));
  } else {
    results.heapBytes = "skipped: run with --expose-gc";
  }

  // 5. Steady-state query latency (warm instances, everything touched once)
  {
    const vs = Object.fromEntries(await Promise.all(VARIANTS.map(async (n) => [n, await warm(n, root)] as const))) as Record<VName, V>;
    const types: QType[] = ["S1a", "S1b", "S2", "S3", "S4", "S5"];
    const lat: any = Object.fromEntries(types.map((t) => [t, Object.fromEntries(VARIANTS.map((n) => [n, [] as number[]]))]));
    const jobs: Array<{ type: QType; ci: number; q: string }> = [];
    for (let ci = 0; ci < info.customers.length; ci++) {
      for (const q of scopedStrings(info.customers[ci])) {
        for (const type of ["S1a", "S1b", "S2"] as QType[]) jobs.push({ type, ci, q });
      }
      jobs.push({ type: "S3", ci, q: "" });
      jobs.push({ type: "S4", ci, q: "" });
    }
    info.queries.forEach((q: string, i: number) => jobs.push({ type: "S5", ci: i, q }));
    for (const j of jobs) for (const n of VARIANTS) await runQuery(vs[n], j.type, root, info, j.ci, j.q);
    for (let rep = 0; rep < 3; rep++) {
      for (const j of jobs) {
        for (const n of order(rep)) {
          const t0 = now();
          await runQuery(vs[n], j.type, root, info, j.ci, j.q);
          lat[j.type][n].push(now() - t0);
        }
      }
    }
    results.steadyQueryMs = Object.fromEntries(types.map((t) => [t, Object.fromEntries(VARIANTS.map((n) => [n, { p50: median(lat[t][n]), p95: pct(lat[t][n], 95), n: lat[t][n].length }]))]));
    log("steady-state queries done");
  }

  // 6. Single-note edit → flush (fresh warm instances per run)
  {
    const edits: any = Object.fromEntries(VARIANTS.map((n) => [n, [] as any[]]));
    for (let r = 0; r < RUNS; r++) {
      const vs = {} as Record<VName, V>;
      for (const n of VARIANTS) vs[n] = await warm(n, root);
      for (const [ti, target] of info.editTargets.entries()) {
        await appendFile(join(root, target), `\n- [ ] Edited marker run${r} target${ti} zq${r}x${ti}\n`);
        for (const n of order(r + ti)) {
          const t0 = now();
          await vs[n].g.updateNotes([target]);
          const updateMs = now() - t0;
          const m = await measureWrites(() => vs[n].flush());
          edits[n].push({ run: r, target, folder: target.split("/")[0], updateMs, flushMs: m.ms, bytes: m.bytes, changedBytes: m.changedBytes, writes: m.writes, byKind: m.byKind, elMaxMs: m.elMaxMs, stringifyMaxMs: m.stringifyMaxMs });
        }
      }
      log(`edit run ${r + 1}/${RUNS}`);
    }
    const agg = (rows: any[]) => ({
      n: rows.length,
      meanBytes: rows.reduce((s, x) => s + x.bytes, 0) / rows.length,
      medianBytes: median(rows.map((x) => x.bytes)),
      maxBytes: Math.max(...rows.map((x) => x.bytes)),
      medianChangedBytes: median(rows.map((x) => x.changedBytes)),
      updateMs: summary(rows.map((x) => x.updateMs)),
      flushMs: summary(rows.map((x) => x.flushMs)),
      elMaxMs: summary(rows.map((x) => x.elMaxMs)),
      stringifyMaxMs: summary(rows.map((x) => x.stringifyMaxMs)),
    });
    results.singleEdit = {};
    for (const n of VARIANTS) {
      const rows = edits[n];
      const byFolder: Record<string, unknown> = {};
      for (const f of new Set(rows.map((x: any) => x.folder))) byFolder[f as string] = agg(rows.filter((x: any) => x.folder === f));
      results.singleEdit[n] = { all: agg(rows), byFolder };
    }
    // Persistence parity after edits: reload everything from disk.
    const wa = await warm("A", root), wb = await warm("B", root), wb2 = await warm("B2", root);
    results.parity.afterEditLinks = { B: linkParity(wa.g, graphLinks(wb.g)), B2: linkParity(wa.g, graphLinks(wb2.g)) };
    results.parity.afterEditSearch = {
      B: await searchParity(wa, wb, { ...info, queries: [...info.queries, "zq0x0", "edited marker"] }),
      B2: await searchParity(wa, wb2, { ...info, queries: [...info.queries, "zq0x0", "edited marker"] }),
    };
    results.parity.afterEditContext = { B: await contextParity(wa, wb, root, info) };
  }

  // 7. Mass invalidation: touch 30% of note mtimes, then revalidate
  {
    const all = (await warm("A", root)).g.getNotesByFolder("").map((r) => r.path);
    const mass: any = Object.fromEntries(VARIANTS.map((n) => [n, [] as any[]]));
    for (let r = 0; r < MASS_RUNS; r++) {
      const rand = mulberry32(1000 + r);
      const touched = all.filter(() => rand() < 0.3);
      const when = new Date(Date.now() + (r + 1) * 60_000);
      for (const p of touched) await utimes(join(root, p), when, when);
      for (const n of order(r)) {
        const v = await warm(n, root);
        const m = await measureWrites(() => v.revalidate());
        mass[n].push({
          touched: touched.length, reindexed: m.result, ms: m.ms, bytes: m.bytes, writes: m.writes, byKind: m.byKind,
          checkpoints: (m.byKind.graph?.files ?? m.byKind.skeleton?.files ?? 0), elMaxMs: m.elMaxMs, stringifyMaxMs: m.stringifyMaxMs,
          segmentsLoaded: n === "A" ? 0 : (v.g as SG).loadedSegmentCount,
        });
      }
      log(`mass run ${r + 1}/${MASS_RUNS}`);
    }
    results.massInvalidation = Object.fromEntries(VARIANTS.map((n) => [n, {
      touched: mass[n][0]?.touched,
      bytes: summary(mass[n].map((x: any) => x.bytes)),
      ms: summary(mass[n].map((x: any) => x.ms)),
      saves: median(mass[n].map((x: any) => x.checkpoints)),
      elMaxMs: summary(mass[n].map((x: any) => x.elMaxMs)),
      segmentsLoaded: median(mass[n].map((x: any) => x.segmentsLoaded)),
      runs: mass[n],
    }]));
    const wa = await warm("A", root), wb = await warm("B", root), wb2 = await warm("B2", root);
    results.parity.afterMassLinks = { B: linkParity(wa.g, graphLinks(wb.g)), B2: linkParity(wa.g, graphLinks(wb2.g)) };
    results.parity.afterMassSearch = { B: await searchParity(wa, wb, info), B2: await searchParity(wa, wb2, info) };
  }

  results.finishedAt = new Date().toISOString();
  await writeFile(join(HERE, `results-${SIZE}.json`), JSON.stringify(results, null, 2));
  log(`wrote results-${SIZE}.json`);
} finally {
  await rm(root, { recursive: true, force: true });
}
