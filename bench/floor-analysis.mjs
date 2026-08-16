/**
 * Does a relevance floor exist that separates real queries from gibberish?
 *
 * Uses the vectors already cached in the vault, so this is fast.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT_PATH;
const sidecar = JSON.parse(await readFile(join(vault, "_oil-vectors.json"), "utf-8"));
const paths = Object.keys(sidecar.entries);

function decode(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}
const vectors = new Map(paths.map((p) => [p, decode(sidecar.entries[p].vector)]));

async function embed(text) {
  const res = await fetch("http://127.0.0.1:11434/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: sidecar.model, input: [text] }),
  });
  const { embeddings } = await res.json();
  let sum = 0;
  for (const v of embeddings[0]) sum += v * v;
  const mag = Math.sqrt(sum) || 1;
  return Float32Array.from(embeddings[0].map((v) => v / mag));
}

function topScores(qv, n = 10) {
  const scored = [];
  for (const [path, vec] of vectors) {
    let s = 0;
    for (let i = 0; i < qv.length; i++) s += qv[i] * vec[i];
    scored.push({ path, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

const REAL = [
  "automating approval of treatments before they happen",
  "pharmaceutical firm reserving dedicated model throughput",
  "which customer is expanding their AI footprint",
  "prior authorization milestones",
  "who owns the BCBS relationship",
];

const GIBBERISH = [
  "zzxqq wibblewobble",
  "florp glimmer zonktastic",
  "qqqq xxxx yyyy zzzz",
  "asdfgh jklmnop qwerty",
  "blorpity snizzlefritz",
];

const OFF_TOPIC = [
  "recipe for sourdough bread",
  "how to change a bicycle tyre",
  "medieval french poetry",
];

async function report(label, queries) {
  console.log(`\n${label}`);
  console.log("  top1     top5     top10    query");
  const top1s = [];
  for (const q of queries) {
    const qv = await embed(q);
    const top = topScores(qv, 10);
    top1s.push(top[0].score);
    console.log(
      `  ${top[0].score.toFixed(3)}    ${top[4].score.toFixed(3)}    ${top[9].score.toFixed(3)}    "${q}"`,
    );
  }
  const sorted = [...top1s].sort((a, b) => a - b);
  return { min: sorted[0], max: sorted[sorted.length - 1], median: sorted[Math.floor(sorted.length / 2)] };
}

const real = await report("REAL queries (should pass a floor)", REAL);
const gib = await report("GIBBERISH (should be rejected)", GIBBERISH);
const off = await report("OFF-TOPIC but real English (should be rejected)", OFF_TOPIC);

console.log("\n─────────────────────────────────────────────────────────");
console.log(`  real     top1: min ${real.min.toFixed(3)}  median ${real.median.toFixed(3)}  max ${real.max.toFixed(3)}`);
console.log(`  gibberish top1: min ${gib.min.toFixed(3)}  median ${gib.median.toFixed(3)}  max ${gib.max.toFixed(3)}`);
console.log(`  off-topic top1: min ${off.min.toFixed(3)}  median ${off.median.toFixed(3)}  max ${off.max.toFixed(3)}`);

const gap = real.min - Math.max(gib.max, off.max);
console.log(
  gap > 0
    ? `\n  SEPARABLE: a floor between ${Math.max(gib.max, off.max).toFixed(3)} and ${real.min.toFixed(3)} rejects noise and keeps real hits.`
    : `\n  NOT SEPARABLE by a fixed floor: worst real query (${real.min.toFixed(3)}) scores below best noise query (${Math.max(gib.max, off.max).toFixed(3)}).`,
);
console.log();
