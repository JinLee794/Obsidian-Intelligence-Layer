/**
 * Benchmark harness — shared types and utilities for OIL vs bitbonsai comparison.
 *
 * Architecture:
 * - OIL is tested directly via its internal modules (graph, search, vault, etc.)
 * - bitbonsai is simulated via equivalent file-system operations matching its API
 *   (read_note, search_notes, list_directory, etc.)
 * - Both are measured against the same fixture vault with identical queries.
 *
 * Metrics captured:
 * 1. Token efficiency — estimated tokens in tool schemas + response payloads
 * 2. Call count — MCP round-trips needed per workflow scenario
 * 3. Latency — wall-clock time per operation and per workflow
 * 4. Retrieval quality — precision/recall against known ground truth
 * 5. Write safety — overhead of gated vs direct writes
 */

import { resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";
import matter from "gray-matter";

// ── Fixture vault path ──────────────────────────────────────────────────────

export const VAULT_PATH = resolve(import.meta.dirname, "fixtures/vault");

// ── Token estimation ────────────────────────────────────────────────────────

/**
 * Rough GPT-4 token estimate: ~4 chars per token for English text.
 * This is a fast heuristic — not a tiktoken call — sufficient for comparison.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Metric types ────────────────────────────────────────────────────────────

export interface CallMetric {
  server: "oil" | "bitbonsai";
  tool: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface WorkflowMetric {
  name: string;
  server: "oil" | "bitbonsai";
  calls: CallMetric[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  callCount: number;
}

export interface RetrievalMetric {
  server: "oil" | "bitbonsai";
  query: string;
  expected: string[];     // ground-truth paths
  returned: string[];     // paths returned by search
  precision: number;      // relevant ∩ returned / returned
  recall: number;         // relevant ∩ returned / relevant
  f1: number;
}

// ── Metric helpers ──────────────────────────────────────────────────────────

export function computePrecisionRecall(
  expected: string[],
  returned: string[],
): { precision: number; recall: number; f1: number } {
  const expectedSet = new Set(expected);
  const returnedSet = new Set(returned);
  const relevant = returned.filter((p) => expectedSet.has(p));

  const precision = returnedSet.size === 0 ? 0 : relevant.length / returnedSet.size;
  const recall = expectedSet.size === 0 ? 1 : relevant.length / expectedSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1 };
}

export function summarizeWorkflow(metrics: WorkflowMetric): string {
  const lines = [
    `## ${metrics.name} [${metrics.server}]`,
    `  Calls: ${metrics.callCount}`,
    `  Input tokens: ${metrics.totalInputTokens}`,
    `  Output tokens: ${metrics.totalOutputTokens}`,
    `  Total tokens: ${metrics.totalTokens}`,
    `  Latency: ${metrics.totalLatencyMs.toFixed(1)}ms`,
    "",
  ];
  for (const c of metrics.calls) {
    lines.push(`    ${c.tool}: ${c.outputTokens} out-tok, ${c.latencyMs.toFixed(1)}ms`);
  }
  return lines.join("\n");
}

export function buildWorkflowMetric(
  name: string,
  server: "oil" | "bitbonsai",
  calls: CallMetric[],
): WorkflowMetric {
  return {
    name,
    server,
    calls,
    totalInputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    totalTokens: calls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0),
    totalLatencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    callCount: calls.length,
  };
}

// ── Timing helper ───────────────────────────────────────────────────────────

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

// ── bitbonsai simulation layer ──────────────────────────────────────────────
// These functions replicate bitbonsai/mcp-obsidian's tool behavior using
// direct filesystem operations, matching its documented API responses.

const BB_EXCLUDED = new Set([".obsidian", ".trash", "node_modules", ".git"]);

/**
 * Simulates bitbonsai `list_directory` — returns dirs + files with filtering.
 */
export async function bbListDirectory(
  vaultPath: string,
  dirPath: string = "",
): Promise<{ dirs: string[]; files: string[] }> {
  const fullPath = join(vaultPath, dirPath);
  const entries = await readdir(fullPath, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (BB_EXCLUDED.has(entry.name) || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else {
      files.push(entry.name);
    }
  }
  return { dirs, files };
}

/**
 * Simulates bitbonsai `read_note` — returns frontmatter + content.
 */
export async function bbReadNote(
  vaultPath: string,
  notePath: string,
): Promise<{ fm: Record<string, unknown>; content: string }> {
  const fullPath = join(vaultPath, notePath);
  const raw = await readFile(fullPath, "utf-8");
  const { data, content } = matter(raw);
  return { fm: data, content };
}

/**
 * Simulates bitbonsai `search_notes` — BM25-style text search.
 * Simplified: case-insensitive substring match with match counting.
 */
export async function bbSearchNotes(
  vaultPath: string,
  query: string,
  limit: number = 5,
): Promise<Array<{ p: string; t: string; ex: string; mc: number }>> {
  const results: Array<{ p: string; t: string; ex: string; mc: number; score: number }> = [];
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/);

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (BB_EXCLUDED.has(entry.name) || entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".md")) {
        const raw = await readFile(join(dir, entry.name), "utf-8");
        const { data, content } = matter(raw);
        const fullText = `${data.title ?? ""} ${content}`.toLowerCase();
        let matchCount = 0;
        for (const term of terms) {
          const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
          const matches = fullText.match(re);
          if (matches) matchCount += matches.length;
        }
        if (matchCount > 0) {
          // BM25-like: term frequency normalized
          const tf = matchCount / (fullText.length / 100);
          const idx = fullText.indexOf(terms[0]);
          const start = Math.max(0, idx - 10);
          const excerpt = fullText.slice(start, start + 42);
          results.push({
            p: rel,
            t: (data.title as string) ?? basename(rel, ".md"),
            ex: `...${excerpt}...`,
            mc: matchCount,
            score: tf,
          });
        }
      }
    }
  }

  await walk(vaultPath, "");
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map(({ p, t, ex, mc }) => ({ p, t, ex, mc }));
}

/**
 * Simulates bitbonsai `get_frontmatter` — extract only frontmatter.
 */
export async function bbGetFrontmatter(
  vaultPath: string,
  notePath: string,
): Promise<Record<string, unknown>> {
  const fullPath = join(vaultPath, notePath);
  const raw = await readFile(fullPath, "utf-8");
  const { data } = matter(raw);
  return data;
}

/**
 * Simulates bitbonsai `get_vault_stats` — high-level vault stats.
 */
export async function bbGetVaultStats(
  vaultPath: string,
): Promise<{ notes: number; folders: number; size: number }> {
  let notes = 0;
  let folders = 0;
  let totalSize = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (BB_EXCLUDED.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        folders++;
        await walk(full);
      } else if (entry.name.endsWith(".md")) {
        notes++;
        const s = await stat(full);
        totalSize += s.size;
      }
    }
  }

  await walk(vaultPath);
  return { notes, folders, size: totalSize };
}

/**
 * Simulates bitbonsai `write_note` — direct file write with mode.
 */
export async function bbWriteNote(
  vaultPath: string,
  notePath: string,
  content: string,
  mode: "overwrite" | "append" | "prepend" = "overwrite",
): Promise<string> {
  const { writeFile: writeFileFs, appendFile: appendFileFs } = await import("node:fs/promises");
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  const fullPath = join(vaultPath, notePath);
  await mkdir(dirname(fullPath), { recursive: true });

  if (mode === "append") {
    await appendFileFs(fullPath, content, "utf-8");
  } else if (mode === "prepend") {
    const existing = await readFile(fullPath, "utf-8").catch(() => "");
    await writeFileFs(fullPath, content + existing, "utf-8");
  } else {
    await writeFileFs(fullPath, content, "utf-8");
  }
  return `Successfully wrote note: ${notePath} (mode: ${mode})`;
}

// ── Tool schema definitions (for token estimation) ──────────────────────────

/**
 * Approximate tool schema JSON sizes for both servers.
 * These are injected into LLM context every turn — the per-turn tax.
 */
export const OIL_TOOL_SCHEMAS = {
  get_vault_context: `{"name":"get_vault_context","description":"Returns a high-level map of the vault — its shape, scale, and most important nodes. The agent's first call in any new session.","inputSchema":{}}`,
  get_customer_context: `{"name":"get_customer_context","description":"Full assembled context for a named customer — customer file content, opportunities with GUIDs, team composition, recent meetings, linked people, open action items, and optionally similar customers.","inputSchema":{"customer":"string","lookback_days":"number?","include_similar":"boolean?","include_open_items":"boolean?","assignee":"string?"}}`,
  get_person_context: `{"name":"get_person_context","description":"Returns a person's vault profile — customer associations, org type, company, and linked notes.","inputSchema":{"name":"string"}}`,
  query_graph: `{"name":"query_graph","description":"Unified graph traversal — returns backlinks, forward links, or N-hop neighbourhood.","inputSchema":{"path":"string","direction":"in|out|neighborhood","hops":"number?","filter_tags":"string[]?","filter_folder":"string?"}}`,
  resolve_people_to_customers: `{"name":"resolve_people_to_customers","description":"Batch resolution of person names to customer associations.","inputSchema":{"names":"string[]"}}`,
  search_vault: `{"name":"search_vault","description":"Unified search across lexical and fuzzy tiers.","inputSchema":{"query":"string","tier":"lexical|fuzzy?","limit":"number?","filter_folder":"string?","filter_tags":"string[]?"}}`,
  query_notes: `{"name":"query_notes","description":"Frontmatter predicate query — relational-style filtering across all notes.","inputSchema":{"where":"object","and":"object[]?","or":"object[]?","order_by":"string?","limit":"number?","folder":"string?"}}`,
  find_similar_notes: `{"name":"find_similar_notes","description":"Tag-based similarity to a given note.","inputSchema":{"path":"string","top_n":"number?","method":"tags?"}}`,
  patch_note: `{"name":"patch_note","description":"Appends content to a specific heading section within a note.","inputSchema":{"path":"string","heading":"string","content":"string","operation":"append|prepend?"}}`,
  capture_connect_hook: `{"name":"capture_connect_hook","description":"Appends a formatted Connect hook to the customer file and backup.","inputSchema":{"customer":"string","hook":"object"}}`,
  log_agent_action: `{"name":"log_agent_action","description":"Records an agent decision to _agent-log/.","inputSchema":{"action":"string","context":"object","session_id":"string"}}`,
  draft_meeting_note: `{"name":"draft_meeting_note","description":"Generates a structured meeting note. Gated.","inputSchema":{"customer":"string","content":"string","attendees":"string[]?","date":"string?","title":"string?"}}`,
  update_customer_file: `{"name":"update_customer_file","description":"Proposes updates to a customer file. Gated.","inputSchema":{"customer":"string","frontmatter":"object?","sections":"object?"}}`,
  create_customer_file: `{"name":"create_customer_file","description":"Scaffolds a new customer file. Gated.","inputSchema":{"customer":"string","tpid":"string?","accountid":"string?","opportunities":"object[]?","team":"object[]?"}}`,
  write_note: `{"name":"write_note","description":"Low-level note write wrapped in confirmation gate. Always gated.","inputSchema":{"path":"string","content":"string","mode":"overwrite|append|prepend?"}}`,
  apply_tags: `{"name":"apply_tags","description":"Proposes tag additions/removals across notes. Gated.","inputSchema":{"paths":"string[]","tags":"string[]","operation":"add|remove"}}`,
  manage_pending_writes: `{"name":"manage_pending_writes","description":"List, confirm, or reject pending gated write operations.","inputSchema":{"action":"list|confirm|reject","write_id":"string?"}}`,
  prepare_crm_prefetch: `{"name":"prepare_crm_prefetch","description":"Extracts vault-known MSX identifiers for CRM query construction.","inputSchema":{"customers":"string[]"}}`,
  correlate_with_vault: `{"name":"correlate_with_vault","description":"Cross-references external entities with vault notes.","inputSchema":{"entities":"object[]","date_range":"object?"}}`,
  promote_findings: `{"name":"promote_findings","description":"Batch-promotes validated findings to customer files.","inputSchema":{"findings":"object[]"}}`,
  check_vault_health: `{"name":"check_vault_health","description":"Comprehensive vault health report.","inputSchema":{"customers":"string[]?"}}`,
  get_drift_report: `{"name":"get_drift_report","description":"Vault snapshot shaped for CRM drift detection.","inputSchema":{"customer":"string"}}`,
};

export const BB_TOOL_SCHEMAS = {
  read_note: `{"name":"read_note","description":"Read a note from the vault with parsed frontmatter.","inputSchema":{"path":"string","prettyPrint":"boolean?"}}`,
  write_note: `{"name":"write_note","description":"Write a note to the vault with optional frontmatter and write mode.","inputSchema":{"path":"string","content":"string","frontmatter":"object?","mode":"overwrite|append|prepend?"}}`,
  patch_note: `{"name":"patch_note","description":"Replace an exact string inside an existing note.","inputSchema":{"path":"string","oldString":"string","newString":"string","replaceAll":"boolean?"}}`,
  list_directory: `{"name":"list_directory","description":"List files and directories in the vault.","inputSchema":{"path":"string?","prettyPrint":"boolean?"}}`,
  delete_note: `{"name":"delete_note","description":"Delete a note from the vault (requires confirmation).","inputSchema":{"path":"string","confirmPath":"string"}}`,
  get_frontmatter: `{"name":"get_frontmatter","description":"Extract only the frontmatter from a note.","inputSchema":{"path":"string","prettyPrint":"boolean?"}}`,
  manage_tags: `{"name":"manage_tags","description":"Add, remove, or list tags in a note.","inputSchema":{"path":"string","operation":"add|remove|list","tags":"string[]?"}}`,
  search_notes: `{"name":"search_notes","description":"Search notes by content or frontmatter with BM25 reranking.","inputSchema":{"query":"string","limit":"number?","searchContent":"boolean?","searchFrontmatter":"boolean?","caseSensitive":"boolean?","prettyPrint":"boolean?"}}`,
  move_note: `{"name":"move_note","description":"Move or rename a note in the vault.","inputSchema":{"oldPath":"string","newPath":"string","overwrite":"boolean?"}}`,
  move_file: `{"name":"move_file","description":"Move or rename any file in the vault with confirmation.","inputSchema":{"oldPath":"string","newPath":"string","confirmOldPath":"string","confirmNewPath":"string","overwrite":"boolean?"}}`,
  read_multiple_notes: `{"name":"read_multiple_notes","description":"Read multiple notes in a batch (max 10).","inputSchema":{"paths":"string[]","includeContent":"boolean?","includeFrontmatter":"boolean?","prettyPrint":"boolean?"}}`,
  update_frontmatter: `{"name":"update_frontmatter","description":"Update frontmatter of a note without changing content.","inputSchema":{"path":"string","frontmatter":"object","merge":"boolean?"}}`,
  get_notes_info: `{"name":"get_notes_info","description":"Get metadata for notes without reading full content.","inputSchema":{"paths":"string[]","prettyPrint":"boolean?"}}`,
  get_vault_stats: `{"name":"get_vault_stats","description":"Get high-level vault statistics.","inputSchema":{"recentCount":"number?","prettyPrint":"boolean?"}}`,
};

/**
 * Total schema tokens — the per-turn context tax for each server.
 */
export function totalSchemaTokens(schemas: Record<string, string>): number {
  const combined = Object.values(schemas).join("\n");
  return estimateTokens(combined);
}
