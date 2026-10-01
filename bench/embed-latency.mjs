/** Measure real Ollama embed latency by batch size, using this vault's actual notes. */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const vault = process.env.OBSIDIAN_VAULT_PATH ?? process.argv[2];

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = (await collect(vault)).slice(0, 64);
const texts = [];
for (const file of files) {
  const raw = await readFile(file, "utf-8");
  texts.push(raw.replace(/\s+/g, " ").slice(0, 1500));
}

const sizes = texts.map((t) => t.length);
console.log(`\nsampled ${texts.length} notes; chars per note: min ${Math.min(...sizes)} avg ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} max ${Math.max(...sizes)}\n`);

for (const batch of [1, 4, 8, 16]) {
  const inputs = texts.slice(0, batch);
  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:11434/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", input: inputs }),
  });
  const ok = res.ok;
  await res.text();
  const ms = Date.now() - t0;
  console.log(`  batch ${String(batch).padStart(2)}  ${String(ms).padStart(6)} ms  ${(ms / batch).toFixed(0)} ms/note  ok=${ok}`);
}
console.log();
