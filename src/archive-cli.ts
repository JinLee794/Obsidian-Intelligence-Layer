/**
 * OIL — `archive` and `restore` commands
 *
 * The same engine the `manage_archive` tool drives, for a terminal or a
 * scheduled task. Without `--apply` the archive command only reports.
 */

import { loadConfig } from "./config.js";
import { GraphIndex } from "./graph.js";
import { applyArchive, applyArchivePolicy, planArchive, restoreArchived } from "./archive.js";

export interface ArchiveCliArgs {
  command: "archive" | "restore";
  apply: boolean;
  json: boolean;
  path?: string;
  runId?: string;
}

export async function runArchiveCli(args: ArchiveCliArgs): Promise<number> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error("Error: set OBSIDIAN_VAULT_PATH or pass --vault=<path>.");
    return 1;
  }

  const config = await loadConfig(vaultPath);
  applyArchivePolicy(config);
  const graph = new GraphIndex(vaultPath);
  const graphFile = config.search.graphIndexFile;
  // Reuse the server's persisted index when there is one; rules judge by it.
  if (await graph.loadFromDisk(graphFile)) await graph.buildIncremental(graphFile);
  else await graph.build();

  const print = (payload: unknown, text: string[]) => {
    console.log(args.json ? JSON.stringify(payload, null, 2) : text.join("\n"));
  };

  try {
    if (args.command === "restore") {
      if (!args.path && !args.runId) {
        console.error("restore needs a note path or --run=<id>.");
        return 1;
      }
      const result = await restoreArchived(vaultPath, graph, config, {
        path: args.path,
        runId: args.runId,
      });
      await graph.saveToDisk(graphFile).catch(() => {});
      print(result, [
        `Restored ${result.restored.length} note(s)${result.runId ? ` (run ${result.runId})` : ""}.`,
        ...result.restored.map((e) => `  ${e.from} → ${e.to}`),
        ...result.skipped.map((s) => `  skipped ${s.path}: ${s.reason}`),
        `Links rewritten: ${result.linksRewritten}`,
      ]);
      return result.restored.length > 0 || result.skipped.length === 0 ? 0 : 1;
    }

    const plan = await planArchive(vaultPath, graph, config);
    if (!args.apply) {
      print(plan, [
        `Archive plan — ${plan.enabled ? "enabled" : "DISABLED"}, ${plan.mode} mode, root ${plan.root}`,
        `Would archive ${plan.candidates.length} note(s)${plan.deferred ? ` (+${plan.deferred} deferred by max_per_run)` : ""}:`,
        ...plan.candidates.map((c) => `  ${c.path}${c.target !== c.path ? ` → ${c.target}` : ""}  [${c.reason}]`),
        ...(plan.protected.length
          ? [`Protected (${plan.protected.length}):`, ...plan.protected.map((p) => `  ${p.path}  [${p.reason}]`)]
          : []),
        "",
        plan.enabled
          ? "Nothing was changed. Re-run with --apply to archive."
          : "Nothing was changed. Set archive.enabled: true in oil.config.yaml to apply.",
      ]);
      return 0;
    }

    const result = await applyArchive(vaultPath, graph, config, { plan });
    await graph.saveToDisk(graphFile).catch(() => {});
    print(result, [
      `Archived ${result.archived.length} note(s)${result.runId ? ` — run ${result.runId}` : ""}.`,
      ...result.archived.map((e) => `  ${e.from}${e.to !== e.from ? ` → ${e.to}` : " (flagged)"}`),
      ...result.skipped.map((s) => `  skipped ${s.path}: ${s.reason}`),
      `Links rewritten: ${result.linksRewritten}`,
      ...(result.breadcrumbs.length ? [`Breadcrumbs: ${result.breadcrumbs.join(", ")}`] : []),
      ...(result.deferred ? [`Deferred to the next run: ${result.deferred}`] : []),
      ...(result.runId ? [`Undo with: obsidian-intelligence-layer restore --run=${result.runId}`] : []),
    ]);
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
