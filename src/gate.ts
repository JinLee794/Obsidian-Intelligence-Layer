/**
 * OIL — Tiered Write Gate Engine
 * Routes writes through auto-confirmed (Tier 1) or gated (Tier 2) paths.
 * All writes are logged to _agent-log/ for auditability.
 */

import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { OilConfig, PendingWrite } from "./types.js";
import type { SessionCache } from "./cache.js";
import { securePath, noteExists } from "./vault.js";

// ─── Diff Generation ──────────────────────────────────────────────────────────

export interface WriteDiff {
  id: string;
  operation: string;
  path: string;
  diff: string;
  sideEffects?: string[];
}

/**
 * Generate a markdown-formatted diff for human review.
 */
export function generateDiff(
  operation: string,
  path: string,
  content: string,
  isNew: boolean,
  sideEffects?: string[],
): WriteDiff {
  const id = randomUUID();
  const lines = [
    `## Proposed Write — ${operation}`,
    "",
    `**Action:** ${isNew ? "Create new note" : "Update existing note"}`,
    `**Path:** \`${path}\``,
    "",
    "**Content preview:**",
    "",
    content.length > 1000
      ? `${content.slice(0, 1000)}\n\n*... (${content.length} chars total)*`
      : content,
  ];

  if (sideEffects?.length) {
    lines.push("", "**Side effects:**");
    for (const effect of sideEffects) {
      lines.push(`  - ${effect}`);
    }
  }

  lines.push("", 'Reply **confirm** to execute, or describe changes you want made.');

  return {
    id,
    operation,
    path,
    diff: lines.join("\n"),
    sideEffects,
  };
}

// ─── Tier Routing ─────────────────────────────────────────────────────────────

/**
 * Check if an operation is auto-confirmed (Tier 1).
 */
export function isAutoConfirmed(
  config: OilConfig,
  operation: string,
  targetSection?: string,
): boolean {
  // Check if operation is in the auto-confirmed list
  if (config.writeGate.autoConfirmedOperations.includes(operation)) {
    return true;
  }

  // Check if the target section is in the auto-confirmed sections list
  if (
    operation === "patch_note" &&
    targetSection &&
    config.writeGate.autoConfirmedSections.includes(targetSection)
  ) {
    return true;
  }

  return false;
}

// ─── Write Execution ──────────────────────────────────────────────────────────

/**
 * Execute a write operation — actually writes to the vault filesystem.
 * Used both by auto-confirmed and by gated writes after confirmation.
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
  const raw = await readFileFs(fullPath, "utf-8");

  const headingPattern = new RegExp(
    `^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`,
    "m",
  );
  const match = headingPattern.exec(raw);

  let result: string;

  if (match) {
    const headingLevel = match[1].length;
    const insertPos = match.index + match[0].length;

    // Find the end of this section (next heading of same or higher level, or EOF)
    const rest = raw.slice(insertPos);
    const nextHeadingPattern = new RegExp(
      `^#{1,${headingLevel}}\\s+`,
      "m",
    );
    const nextMatch = nextHeadingPattern.exec(rest);
    const sectionEnd = nextMatch
      ? insertPos + nextMatch.index
      : raw.length;

    if (operation === "prepend") {
      result =
        raw.slice(0, insertPos) +
        "\n" +
        content +
        "\n" +
        raw.slice(insertPos);
    } else {
      // Append before the next heading (or at EOF)
      const before = raw.slice(0, sectionEnd).trimEnd();
      result = before + "\n" + content + "\n" + raw.slice(sectionEnd);
    }
  } else {
    // Heading doesn't exist — add at end of file
    result = raw.trimEnd() + "\n\n## " + heading + "\n\n" + content + "\n";
  }

  await writeFile(fullPath, result, "utf-8");
}

// ─── Audit Logging ────────────────────────────────────────────────────────────

/**
 * Log a write operation to _agent-log/YYYY-MM-DD.md
 */
export async function logWrite(
  vaultPath: string,
  config: OilConfig,
  entry: {
    tier: "auto" | "gated";
    operation: string;
    path: string;
    detail?: string;
  },
): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19);
  const logPath = `${config.schema.agentLog}${dateStr}.md`;
  const fullPath = securePath(vaultPath, logPath);

  const dir = dirname(fullPath);
  await mkdir(dir, { recursive: true });

  const logEntry = [
    "",
    `### ${timeStr} — ${entry.operation} [${entry.tier}]`,
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

// ─── Gated Write Flow ─────────────────────────────────────────────────────────

/**
 * Queue a gated write — stores the pending operation for later confirmation.
 */
export function queueGatedWrite(
  cache: SessionCache,
  diff: WriteDiff,
  writePayload: {
    content: string;
    mode: "create" | "overwrite" | "append" | "move";
    sourcePath?: string;
  },
): string {
  const pending: PendingWrite = {
    id: diff.id,
    operation: diff.operation,
    path: diff.path,
    diff: JSON.stringify({
      diffText: diff.diff,
      content: writePayload.content,
      mode: writePayload.mode,
      sideEffects: diff.sideEffects,
      ...(writePayload.sourcePath ? { sourcePath: writePayload.sourcePath } : {}),
    }),
    createdAt: new Date(),
  };
  cache.addPendingWrite(pending);
  return diff.id;
}

/**
 * Confirm and execute a pending gated write.
 */
export async function confirmWrite(
  vaultPath: string,
  config: OilConfig,
  cache: SessionCache,
  writeId: string,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const pending = cache.getPendingWrite(writeId);
  if (!pending) {
    return { success: false, error: `No pending write with ID: ${writeId}` };
  }

  const payload = JSON.parse(pending.diff) as {
    content: string;
    mode: "create" | "overwrite" | "append" | "move";
    sourcePath?: string;
  };

  if (payload.mode === "move" && payload.sourcePath) {
    // Move operation: create new file, delete old file
    await executeWrite(vaultPath, pending.path, payload.content, "create");
    const oldFullPath = securePath(vaultPath, payload.sourcePath);
    const { unlink } = await import("node:fs/promises");
    await unlink(oldFullPath);
  } else {
    await executeWrite(vaultPath, pending.path, payload.content, payload.mode === "move" ? "create" : payload.mode);
  }

  await logWrite(vaultPath, config, {
    tier: "gated",
    operation: pending.operation,
    path: pending.path,
    detail: payload.mode === "move"
      ? `Moved from ${payload.sourcePath} (confirmed by user)`
      : "Confirmed by user",
  });

  cache.removePendingWrite(writeId);
  return { success: true, path: pending.path };
}

/**
 * Reject a pending gated write.
 */
export function rejectWrite(
  cache: SessionCache,
  writeId: string,
): { success: boolean; error?: string } {
  const pending = cache.getPendingWrite(writeId);
  if (!pending) {
    return { success: false, error: `No pending write with ID: ${writeId}` };
  }
  cache.removePendingWrite(writeId);
  return { success: true };
}

// ─── Compact Batch Diff ───────────────────────────────────────────────────────

/**
 * Generate a compact batch diff for bulk operations (apply_tags, batch promote).
 * When item count > 5, shows a folder summary + first 5 items instead of
 * listing every individual change.
 */
export function generateCompactBatchDiff(
  operation: string,
  label: string,
  items: { path: string; detail: string }[],
): WriteDiff {
  const id = randomUUID();
  const compact = items.length > 5;

  const lines = [
    `## Batch Operation — ${operation}`,
    "",
    `**Action:** ${label}`,
    `**Notes affected:** ${items.length}`,
    "",
  ];

  if (compact) {
    // Group by folder
    const byFolder = new Map<string, number>();
    for (const item of items) {
      const slash = item.path.lastIndexOf("/");
      const folder = slash >= 0 ? item.path.slice(0, slash + 1) : "(root)";
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
    }

    lines.push("**By folder:**");
    for (const [folder, count] of [...byFolder.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${folder}**: ${count} note(s)`);
    }
    lines.push("", "**First 5 notes:**");
    for (const item of items.slice(0, 5)) {
      lines.push(`- \`${item.path}\`: ${item.detail}`);
    }
    lines.push(`- *... and ${items.length - 5} more*`);
  } else {
    for (const item of items) {
      lines.push(`- \`${item.path}\`: ${item.detail}`);
    }
  }

  lines.push("", "Reply **confirm** to execute, or describe changes you want made.");

  return {
    id,
    operation,
    path: `(${items.length} notes)`,
    diff: lines.join("\n"),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
