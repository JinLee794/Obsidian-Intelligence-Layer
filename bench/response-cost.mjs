#!/usr/bin/env node
/**
 * Measures per-call response cost and the overhead of pretty-printed JSON.
 *
 *   node bench/response-cost.mjs [vaultPath]
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const vault = process.argv[2] ?? resolve(root, "bench/fixtures/vault");

const child = spawn(process.execPath, [resolve(root, "dist/index.js")], {
  env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, OIL_SEMANTIC: "off" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const fn = pending.get(msg.id);
    if (fn) {
      pending.delete(msg.id);
      fn(msg);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "response-cost", version: "0" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const calls = [
  ["get_health", {}],
  ["search_vault", { query: "Contoso" }],
  ["search_vault", { query: "migration risk" }],
  ["query_frontmatter", {}],
  ["query_frontmatter", { key: "type" }],
  ["get_related_entities", { path: "Customers/Contoso.md" }],
  ["get_note_metadata", { path: "Customers/Contoso.md" }],
  ["get_customer_context", { customer: "Contoso" }],
  ["get_customer_context", { customer: "Contoso", view: "brief" }],
  ["check_vault_health", {}],
];

const dump = process.env.DUMP ? process.env.DUMP.split(",") : [];

const rows = [];
for (const [name, args] of calls) {
  const res = await send("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
  if (dump.includes(name)) console.log(`\n===== ${name} =====\n${text}\n`);
  let compact = text.length;
  try {
    compact = JSON.stringify(JSON.parse(text)).length;
  } catch {}
  rows.push({
    call: `${name}(${Object.keys(args).join(",") || "-"})`,
    chars: text.length,
    tokens: Math.round(text.length / 4),
    compact,
    saved_pct: Math.round(((text.length - compact) / text.length) * 100),
  });
}

console.table(rows);
const t = rows.reduce((s, r) => s + r.chars, 0);
const c = rows.reduce((s, r) => s + r.compact, 0);
console.log(
  `\nTotal pretty: ${t} chars  compact: ${c} chars  saving: ${Math.round(((t - c) / t) * 100)}%`,
);

child.kill();
