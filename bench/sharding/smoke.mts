// Smoke test: real GraphIndex + bm25Search load through the no-install loader.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphIndex } from "../../src/graph.js";
import { bm25Search } from "../../src/bm25.js";

const root = mkdtempSync(join(tmpdir(), "oil-shard-smoke-"));
try {
  mkdirSync(join(root, "Customers", "Contoso"), { recursive: true });
  mkdirSync(join(root, "People"), { recursive: true });
  writeFileSync(
    join(root, "Customers", "Contoso", "Contoso.md"),
    "---\ntype: customer\naliases: [CTSO, Contoso Ltd]\ntpid: \"TP-1001\"\ntags:\n  - customer\n---\n# Contoso\n\n## Overview\nWorks with [[Alice Smith]].\n",
  );
  writeFileSync(
    join(root, "People", "Alice Smith.md"),
    "---\ntype: person\ncustomers: [Contoso]\n---\n# Alice Smith\nChampion at [[CTSO]]. #champion\n",
  );
  const g = new GraphIndex(root);
  await g.build();
  console.log("nodes", g.nodeCount, "backlinks(Contoso)", g.getBacklinks("Customers/Contoso/Contoso.md").map((r) => r.path));
  console.log("bm25", bm25Search(g, "contoso", 5).map((h) => [h.path, h.score.toFixed(3)]));
  console.log("bm25 tpid", bm25Search(g, "TP-1001", 5).map((h) => h.path));
  await g.saveToDisk("_oil-graph.json");
  console.log("cache bytes", statSync(join(root, "_oil-graph.json")).size);
  const g2 = new GraphIndex(root);
  const ok = await g2.loadFromDisk("_oil-graph.json");
  console.log("loaded", ok, g2.nodeCount, g2.getNode("Customers/Contoso/Contoso.md")?.frontmatter);
} finally {
  rmSync(root, { recursive: true, force: true });
}
