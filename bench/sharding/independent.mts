// Variant C: fully independent per-folder graphs.
//
// Each top-level folder is its own GraphIndex rooted at that folder, so it
// resolves links against its own notes only. Links a shard cannot resolve go
// to a cross-folder edge table, resolved against the other shards in folder
// order. Search fans out to every routed shard (each with its own BM25 IDF)
// and merges with A's sort. This measures how far the independent design
// drifts from the single-graph semantics, not a tuned implementation.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { GraphIndex } from "../../src/graph.js";
import { bm25Search, type Bm25Hit } from "../../src/bm25.js";

interface Shard {
  folder: string;
  graph: GraphIndex;
}

export class IndependentGraphs {
  readonly root: string;
  shards: Shard[] = [];
  edges = new Map<string, Set<string>>();
  reverse = new Map<string, Set<string>>();
  unresolved = 0;

  constructor(root: string) {
    this.root = root;
  }

  async build(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    this.shards = folders.map((folder) => ({ folder, graph: new GraphIndex(join(this.root, folder)) }));
    await Promise.all(this.shards.map((s) => s.graph.build()));
    this.buildEdges();
  }

  private shardOf(path: string): Shard | undefined {
    const slash = path.indexOf("/");
    const folder = slash < 0 ? "" : path.slice(0, slash);
    return this.shards.find((s) => s.folder === folder);
  }

  /** Resolve a link one shard could not, against the others. */
  private resolveCross(from: Shard, target: string): string | undefined {
    const slash = target.indexOf("/");
    if (slash > 0) {
      const shard = this.shards.find((s) => s.folder === target.slice(0, slash));
      if (shard) {
        const rel = target.slice(slash + 1);
        const hit = shard.graph.getNode(rel.endsWith(".md") ? rel : `${rel}.md`);
        if (hit) return `${shard.folder}/${hit.path}`;
      }
    }
    for (const shard of this.shards) {
      if (shard === from) continue;
      const hit = (shard.graph as any).resolveWikilink(target) as string | undefined;
      if (hit) return `${shard.folder}/${hit}`;
    }
    return undefined;
  }

  private buildEdges(): void {
    this.edges.clear();
    this.reverse.clear();
    this.unresolved = 0;
    for (const shard of this.shards) {
      for (const { path, target } of shard.graph.getBrokenLinks()) {
        const to = this.resolveCross(shard, target);
        if (!to) {
          this.unresolved++;
          continue;
        }
        const from = `${shard.folder}/${path}`;
        if (from === to) continue;
        let out = this.edges.get(from);
        if (!out) this.edges.set(from, (out = new Set()));
        out.add(to);
        let back = this.reverse.get(to);
        if (!back) this.reverse.set(to, (back = new Set()));
        back.add(from);
      }
    }
  }

  forward(path: string): Set<string> {
    const shard = this.shardOf(path);
    const out = new Set<string>();
    if (!shard) return out;
    for (const ref of shard.graph.getForwardLinks(path.slice(shard.folder.length + 1))) {
      out.add(`${shard.folder}/${ref.path}`);
    }
    for (const p of this.edges.get(path) ?? []) out.add(p);
    return out;
  }

  back(path: string): Set<string> {
    const shard = this.shardOf(path);
    const out = new Set<string>();
    if (!shard) return out;
    for (const ref of shard.graph.getBacklinks(path.slice(shard.folder.length + 1))) {
      out.add(`${shard.folder}/${ref.path}`);
    }
    for (const p of this.reverse.get(path) ?? []) out.add(p);
    return out;
  }

  get noteCount(): number {
    return this.shards.reduce((n, s) => n + s.graph.getStats().noteCount, 0);
  }

  search(query: string, limit: number, accept?: (path: string) => boolean): Bm25Hit[] {
    const merged: Bm25Hit[] = [];
    for (const shard of this.shards) {
      const prefix = `${shard.folder}/`;
      const local = accept ? (p: string) => accept(prefix + p) : undefined;
      for (const hit of bm25Search(shard.graph, query, limit, local)) {
        merged.push({ ...hit, path: prefix + hit.path });
      }
    }
    merged.sort(
      (a, b) => b.matchedTerms.length - a.matchedTerms.length || b.score - a.score || a.path.localeCompare(b.path),
    );
    return merged.slice(0, limit);
  }
}
