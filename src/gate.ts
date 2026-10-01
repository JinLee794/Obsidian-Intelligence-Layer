/**
 * OIL — Write execution and audit logging
 * Concurrency is enforced by the mtime checks in tools/write.ts; this module
 * only performs the write and records it to _agent-log/.
 */

import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { OilConfig } from "./types.js";
import { securePath, noteExists, detectLineEnding, normalizeLineEndings } from "./vault.js";

// ─── Write Execution ──────────────────────────────────────────────────────────

/**
 * Execute a write operation — actually writes to the vault filesystem.
 */
export async function executeWrite(
  vaultPath: string,
  path: string,
  content: string,
  mode: "create" | "overwrite" | "append",
): Promise<void> {
  const fullPath = securePath(vaultPath, path);
  const dir = dirname(fullPath);
  await mkdir(dir, { recursive: true });

  if (mode === "append") {
    await appendFile(fullPath, content, "utf-8");
  } else {
    await writeFile(fullPath, content, "utf-8");
  }
}

/**
 * Append content under a specific heading section in a note.
 * If the heading doesn't exist, creates it at the end of the file.
 */
export async function appendToSection(
  vaultPath: string,
  path: string,
  heading: string,
  content: string,
  operation: "append" | "prepend" = "append",
): Promise<void> {
  const fullPath = securePath(vaultPath, path);
  const { readFile: readFileFs } = await import("node:fs/promises");
  const original = await readFileFs(fullPath, "utf-8");

  // Work in LF, then restore the document's own convention so a CRLF note
  // never ends up with mixed line endings (which breaks naive line parsers).
  const eol = detectLineEnding(original);
  const raw = normalizeLineEndings(original);
  const body = normalizeLineEndings(content);

  const headingPattern = new RegExp(
    `^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`,
    "m",
  );
  const match = headingPattern.exec(raw);

  let result: string;

  if (match) {
    const insertPos = match.index + match[0].length;

    // A section ends at the NEXT HEADING OF ANY LEVEL, matching parseSections().
    // Ending it at the next same-or-higher heading instead would append past a
    // section's own sub-headings — so a write to "Agent Insights" would land
    // outside what read_note_section() reports for "Agent Insights", and an
    // agent verifying its own write would not find it. For an H1 title, whose
    // siblings are all deeper, the content went to end-of-file entirely.
    const rest = raw.slice(insertPos);
    const nextMatch = /^#{1,6}\s+/m.exec(rest);
    const sectionEnd = nextMatch ? insertPos + nextMatch.index : raw.length;

    if (operation === "prepend") {
      result =
        raw.slice(0, insertPos) +
        "\n" +
        body +
        "\n" +
        raw.slice(insertPos);
    } else {
      // Append before the next heading (or at EOF)
      const before = raw.slice(0, sectionEnd).trimEnd();
      result = before + "\n" + body + "\n" + raw.slice(sectionEnd);
    }
  } else {
    // Heading doesn't exist — add at end of file
    result = raw.trimEnd() + "\n\n## " + heading + "\n\n" + body + "\n";
  }

  await writeFile(fullPath, eol === "\r\n" ? result.replace(/\n/g, "\r\n") : result, "utf-8");
}

/**
 * Replace the body of one heading section, leaving the heading line and the
 * rest of the note untouched. Returns false if the heading does not exist.
 *
 * Section boundaries follow the same "next heading of any level" rule as
 * appendToSection and parseSections, so what is replaced is exactly what
 * read_note_section reports.
 */
export async function replaceSection(
  vaultPath: string,
  path: string,
  heading: string,
  content: string,
): Promise<boolean> {
  const fullPath = securePath(vaultPath, path);
  const { readFile: readFileFs } = await import("node:fs/promises");
  const original = await readFileFs(fullPath, "utf-8");

  const eol = detectLineEnding(original);
  const raw = normalizeLineEndings(original);
  const body = normalizeLineEndings(content);

  const headingPattern = new RegExp(
    `^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`,
    "m",
  );
  const match = headingPattern.exec(raw);
  if (!match) return false;

  const insertPos = match.index + match[0].length;
  const rest = raw.slice(insertPos);
  const nextMatch = /^#{1,6}\s+/m.exec(rest);
  const sectionEnd = nextMatch ? insertPos + nextMatch.index : raw.length;

  const tail = raw.slice(sectionEnd);
  const result =
    raw.slice(0, insertPos) + "\n\n" + body.trim() + (tail ? "\n\n" + tail : "\n");

  await writeFile(fullPath, eol === "\r\n" ? result.replace(/\n/g, "\r\n") : result, "utf-8");
  return true;
}

// ─── Audit Logging ────────────────────────────────────────────────────────────

/**
 * Log a write operation to _agent-log/YYYY-MM-DD.md
 */
export async function logWrite(
  vaultPath: string,
  config: OilConfig,
  entry: {
    operation: string;
    path: string;
    detail?: string;
  },
): Promise<void> {
  if (!config.audit.logAllWrites) return;

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19);
  const logPath = `${config.schema.agentLog}${dateStr}.md`;
  const fullPath = securePath(vaultPath, logPath);

  const dir = dirname(fullPath);
  await mkdir(dir, { recursive: true });

  const logEntry = [
    "",
    // The [auto] marker is retained so previously written logs stay parseable.
    `### ${timeStr} — ${entry.operation} [auto]`,
    `- **Path:** \`${entry.path}\``,
  ];
  if (entry.detail) {
    logEntry.push(`- **Detail:** ${entry.detail}`);
  }
  logEntry.push("");

  // Check if log file exists to add header
  const exists = await noteExists(vaultPath, logPath);
  if (!exists) {
    const header = `---\ndate: ${dateStr}\ntags: [agent-log]\n---\n\n# Agent Log — ${dateStr}\n`;
    await writeFile(fullPath, header + logEntry.join("\n"), "utf-8");
  } else {
    await appendFile(fullPath, logEntry.join("\n"), "utf-8");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
