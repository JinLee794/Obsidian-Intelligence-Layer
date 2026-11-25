/**
 * OIL — `migrate-graph` command
 *
 * Moves the vault's graph index to the segmented layout (`.oil-graph/`), checks
 * it, or moves it back. Without a mode flag it only reports what it would do.
 */

import { loadConfig } from "./config.js";
import { graphOptionsFor } from "./graph-segments.js";
import { migrateGraph } from "./graph-migrate.js";
import type { LayoutStatus, MigrateAction, MigrateReport } from "./graph-migrate.js";

export interface MigrateGraphCliArgs {
  action: MigrateAction;
  json: boolean;
  keepLegacy: boolean;
  rebuild: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeLayout(status: LayoutStatus): string {
  switch (status.active) {
    case "segmented":
      return (
        `segmented — ${status.segmented.dir}/ (${status.segmented.nodes} notes, ` +
        `${status.segmented.segments} segments, ${formatBytes(status.segmented.bytes)})`
      );
    case "single":
      return `single file — ${status.single.file} (${formatBytes(status.single.bytes)})`;
    default:
      return "none persisted";
  }
}

const SOURCE_LABEL: Record<NonNullable<MigrateReport["source"]>, string> = {
  single: "the single file",
  segmented: "the segmented index",
  backup: "the backup file",
  build: "a fresh build from the notes",
};

function formatReport(report: MigrateReport): string[] {
  const lines: string[] = [`Graph index — ${report.vault}`];
  if (report.changed) {
    lines.push(`Before: ${describeLayout(report.before)}`, `After:  ${describeLayout(report.after)}`);
  } else {
    lines.push(`Layout: ${describeLayout(report.before)}`);
  }
  if (report.source) {
    lines.push(`Source: ${SOURCE_LABEL[report.source]}${report.nodes !== undefined ? ` (${report.nodes} notes)` : ""}`);
  }

  const plan = report.plan;
  if (plan) {
    lines.push(
      "",
      report.action === "plan" ? "Segmented layout would be:" : "Segmented layout:",
      `  ${plan.segments} segments + skeleton (${formatBytes(plan.skeletonBytes)}), ${formatBytes(plan.totalBytes)} in all`,
    );
    if (plan.largestSegment) {
      lines.push(
        `  largest segment ${plan.largestSegment.key}: ${plan.largestSegment.notes} notes, ${formatBytes(plan.largestSegment.bytes)}`,
      );
    }
    lines.push(
      `  a one-note edit rewrites ~${formatBytes(plan.typicalFlushBytes)}` +
        (plan.legacyBytes ? ` (the single file rewrites ${formatBytes(plan.legacyBytes)})` : ""),
    );
  }
  if (report.written) {
    lines.push(`Wrote ${report.written.files} file(s), ${formatBytes(report.written.bytes)}.`);
  }
  if (report.parity) {
    const p = report.parity;
    const label = report.action === "verify" ? "Compared with a fresh build" : "Checked by reloading";
    lines.push(
      `${label}: ${p.nodes} notes — ${p.ok ? "match" : "MISMATCH"}` +
        (p.ambiguousLinkDiffs ? ` (${p.ambiguousLinkDiffs} ambiguous-name link difference(s))` : ""),
    );
  }

  if (report.messages.length) lines.push("", ...report.messages);
  if (report.errors.length) lines.push("", ...report.errors.map((e) => `Error: ${e}`));
  if (report.action !== "plan" && report.action !== "verify") {
    lines.push("", report.ok ? "Done." : "Failed — see the errors above.");
  } else if (report.action === "verify") {
    lines.push("", report.ok ? "Verified." : "Verification failed — see the errors above.");
  }
  return lines;
}

export async function runMigrateGraphCli(args: MigrateGraphCliArgs): Promise<number> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error("Error: set OBSIDIAN_VAULT_PATH or pass --vault=<path>.");
    return 1;
  }

  try {
    const config = await loadConfig(vaultPath);
    const { layout, segmentPolicy } = graphOptionsFor(config);
    const report = await migrateGraph(vaultPath, args.action, {
      graphIndexFile: config.search.graphIndexFile,
      segmentPolicy,
      configuredLayout: layout,
      keepLegacy: args.keepLegacy,
      rebuild: args.rebuild,
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report).join("\n"));
    return report.ok ? 0 : 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
