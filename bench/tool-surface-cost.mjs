#!/usr/bin/env node
/**
 * Measures the REAL idle context cost of the tool surface: spawns the built
 * server over stdio, calls tools/list, and reports per-tool serialized size.
 *
 * The unit test's `totalSchemaChars()` stringifies raw zod objects, which do
 * not serialize to their JSON Schema form — it undercounts. This does not.
 *
 *   node bench/tool-surface-cost.mjs [vaultPath]
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
    const resolveFn = pending.get(msg.id);
    if (resolveFn) {
      pending.delete(msg.id);
      resolveFn(msg);
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
  clientInfo: { name: "tool-surface-cost", version: "0" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const listed = await send("tools/list", {});
const tools = listed.result.tools;

const rows = tools
  .map((t) => {
    const whole = JSON.stringify(t).length;
    const desc = (t.description ?? "").length;
    const schema = JSON.stringify(t.inputSchema ?? {}).length;
    return {
      tool: t.name,
      chars: whole,
      desc,
      schema,
      params: Object.keys(t.inputSchema?.properties ?? {}).length,
    };
  })
  .sort((a, b) => b.chars - a.chars);

const total = JSON.stringify(tools).length;
console.log(`\nTools: ${tools.length}   Total tools/list payload: ${total} chars (~${Math.round(total / 4)} tokens)\n`);
console.table(rows);
console.log(
  `\ndescription chars: ${rows.reduce((s, r) => s + r.desc, 0)}` +
    `   schema chars: ${rows.reduce((s, r) => s + r.schema, 0)}`,
);

child.kill();
