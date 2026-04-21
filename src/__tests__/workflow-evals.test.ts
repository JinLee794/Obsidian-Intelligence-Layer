/**
 * Workflow evals — scenario tests that exercise multi-tool task paths.
 *
 * These are model-free for now: they validate that the tool sequence exposes
 * enough structured context for an agent to complete common workflows without
 * depending on a live LLM in CI.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FIXTURE_VAULT,
  setupHarness,
  type MockMcpServer,
} from "./harness.js";

let tempDir: string;
let vaultRoot: string;
let server: MockMcpServer;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oil-workflow-evals-"));
  vaultRoot = join(tempDir, "vault");
  await cp(FIXTURE_VAULT, vaultRoot, { recursive: true });
  ({ server } = await setupHarness(vaultRoot));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("workflow evals", () => {
  it("meeting-prep workflow surfaces customer, CRM, and hygiene context in three calls", async () => {
    const trace: string[] = [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      trace.push(tool);
      return server.callToolJson(tool, args);
    };

    const brief = await call("get_customer_context", {
      customer: "Contoso",
      view: "brief",
    });
    const prefetch = await call("prepare_crm_prefetch", {
      customers: ["Contoso"],
    });
    const health = await call("check_vault_health", {
      customers: ["Contoso"],
    });

    expect(trace).toEqual([
      "get_customer_context",
      "prepare_crm_prefetch",
      "check_vault_health",
    ]);
    expect(brief.customer).toBe("Contoso");
    expect(brief.view).toBe("brief");
    expect(brief.customer_ref).toBe("Customers/Contoso.md");
    expect(prefetch.prefetch[0].customer).toBe("Contoso");
    expect(prefetch.prefetch[0].customer_ref).toBe("Customers/Contoso.md");
    expect(typeof health.summary).toBe("string");
    expect(Array.isArray(health.issues)).toBe(true);
  });

  it("stale-write recovery workflow succeeds after a re-read", async () => {
    const trace: string[] = [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      trace.push(tool);
      return server.callToolJson(tool, args);
    };

    const writeView = await call("get_customer_context", {
      customer: "Contoso",
      view: "write",
    });

    const firstWrite = await call("atomic_append", {
      path: writeView.write_targets.customer_note,
      heading: writeView.write_targets.headings.agent_insights,
      content: "- Workflow eval append 1",
      expected_mtime: writeView.customer_mtime_ms,
    });

    const staleWrite = await call("atomic_append", {
      path: writeView.write_targets.customer_note,
      heading: writeView.write_targets.headings.agent_insights,
      content: "- Workflow eval stale append",
      expected_mtime: writeView.customer_mtime_ms,
    });

    const freshMeta = await call("get_note_metadata", {
      path: writeView.write_targets.customer_note,
    });

    const recoveredWrite = await call("atomic_append", {
      path: writeView.write_targets.customer_note,
      heading: writeView.write_targets.headings.agent_insights,
      content: "- Workflow eval append 2",
      expected_mtime: freshMeta.mtime_ms,
    });

    const section = await call("read_note_section", {
      path: writeView.write_targets.customer_note,
      heading: writeView.write_targets.headings.agent_insights,
    });

    expect(trace).toEqual([
      "get_customer_context",
      "atomic_append",
      "atomic_append",
      "get_note_metadata",
      "atomic_append",
      "read_note_section",
    ]);
    expect(firstWrite.status).toBe("executed");
    expect(staleWrite.error_code).toBe("CONFLICT");
    expect(staleWrite.agent_guidance.suggested_tools).toContain("get_note_metadata");
    expect(recoveredWrite.status).toBe("executed");
    expect(section.content).toContain("Workflow eval append 1");
    expect(section.content).toContain("Workflow eval append 2");
  });

  it("migration blocker workflow yields answerable evidence from search plus sections", async () => {
    const trace: string[] = [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      trace.push(tool);
      return server.callToolJson(tool, args);
    };

    const search = await call("search_vault", {
      query: "networking dependencies",
      limit: 5,
    });

    const customerSection = await call("read_note_section", {
      path: "Customers/Contoso.md",
      heading: "Agent Insights",
    });

    const meetingSection = await call("read_note_section", {
      path: "Meetings/2026-02-20-Contoso-Migration-Review.md",
      heading: "Action Items",
    });

    expect(trace).toEqual([
      "search_vault",
      "read_note_section",
      "read_note_section",
    ]);
    expect(
      search.some((result: { path: string }) =>
        [
          "Customers/Contoso.md",
          "Meetings/2026-02-20-Contoso-Migration-Review.md",
        ].includes(result.path),
      ),
    ).toBe(true);
    expect(customerSection.content).toContain("delay on M2");
    expect(meetingSection.content).toContain("VNet peering");

    const meetingRaw = await readFile(
      join(vaultRoot, "Meetings/2026-02-20-Contoso-Migration-Review.md"),
      "utf-8",
    );
    expect(meetingRaw).toContain("network peering dependencies");
  });
});