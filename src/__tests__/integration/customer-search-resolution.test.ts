import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setupHarness, type TestHarness } from "../harness.js";

// Mirrors failures observed in a real vault: hubs are named by legal account
// name ("X CORPORATION", "X (Former Name)") while agents ask for short names.
let vault: string;
let harness: TestHarness;

async function put(path: string, content: string): Promise<void> {
  const file = join(vault, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

const context = (customer: string) =>
  harness.server.callToolJson("get_customer_context", { customer, view: "brief" });

const hub = (name: string, body = "") => put(`Customers/${name}/${name}.md`, `---
type: Customer
title: "${name}"
aliases:
  - "${name}"
---
# ${name}
${body}`);

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), "oil-customer-search-"));
  await hub("NORTHWIND TRADERS CORPORATION");
  await put("Customers/NORTHWIND TRADERS CORPORATION/opportunities/Proseware Platform.md", `---
opportunityId: "00000000-0000-0000-0000-000000000009"
---
# Proseware Platform

Proseware is the Northwind subsidiary. Fourth Coffee was the incumbent vendor.
`);
  await hub("Tailspin (Wingtip Toys)");
  await hub("ALPINE SKI HOUSE AND COMPANY");
  await hub("LITWARE SYSTEMS CORPORATION");
  // Another customer's notes mention Litware far more often than Litware's own hub does.
  for (let i = 0; i < 6; i++) {
    await put(`Customers/Tailspin (Wingtip Toys)/milestones/Litware Integration ${i}.md`,
      `# Litware Integration ${i}\n\nLitware Litware Litware EHR integration work.\n`);
  }
  await hub("MARGIE TRAVEL EAST");
  await hub("MARGIE TRAVEL WEST");
  await hub("CITY GENERAL HOSPITAL");
  harness = await setupHarness(vault);
});

afterAll(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe("Search-assisted customer resolution", () => {
  it.each([
    ["Northwind", "NORTHWIND TRADERS CORPORATION", "name"],
    ["northwind traders", "NORTHWIND TRADERS CORPORATION", "name"],
    ["Nortwind", "NORTHWIND TRADERS CORPORATION", "name"],
    ["Tailspin", "Tailspin (Wingtip Toys)", "name"],
    ["Wingtip Toys", "Tailspin (Wingtip Toys)", "name"],
    ["Alpine Ski House", "ALPINE SKI HOUSE AND COMPANY", "name"],
    ["ASH", "ALPINE SKI HOUSE AND COMPANY", "acronym"],
    ["Litware", "LITWARE SYSTEMS CORPORATION", "name"],
    ["City General", "CITY GENERAL HOSPITAL", "name"],
  ])("resolves %s to %s by %s evidence", async (input, customer, evidence) => {
    const result = await context(input);
    expect(result.error).toBeUndefined();
    expect(result.customer).toBe(customer);
    expect(result.customer_path).toBe(`Customers/${customer}/${customer}.md`);
    expect(result.resolution).toEqual({ input, via: "name_match", evidence });
  });

  it("returns the exact path without a resolution marker", async () => {
    const result = await context("NORTHWIND TRADERS CORPORATION");
    expect(result.customer).toBe("NORTHWIND TRADERS CORPORATION");
    expect(result.resolution).toBeUndefined();
  });

  it("reports ambiguity when several customers' names match", async () => {
    const result = await context("Margie Travel");
    expect(result.error_code).toBe("CONFLICT");
    expect(result.candidates).toEqual([
      { customer: "MARGIE TRAVEL EAST", customer_path: "Customers/MARGIE TRAVEL EAST/MARGIE TRAVEL EAST.md" },
      { customer: "MARGIE TRAVEL WEST", customer_path: "Customers/MARGIE TRAVEL WEST/MARGIE TRAVEL WEST.md" },
    ]);
  });

  it.each(["Proseware", "Fourth Coffee"])(
    "suggests, but never resolves to, a customer whose notes only mention %s",
    async (input) => {
      const result = await context(input);
      expect(result.error_code).toBe("NOT_FOUND");
      expect(result.customer_path).toBeUndefined();
      expect(result.suggestions?.[0]).toMatchObject({
        customer: "NORTHWIND TRADERS CORPORATION",
        customer_path: "Customers/NORTHWIND TRADERS CORPORATION/NORTHWIND TRADERS CORPORATION.md",
      });
      expect(result.agent_guidance.next_step).toMatch(/mention/);
    },
  );

  it.each(["Hospital", "Corporation", "Systems Corp", "Unknown Vendor", "EHR"])(
    "does not resolve generic or unrelated input %s",
    async (input) => {
      const result = await context(input);
      expect(result.error_code).toBe("NOT_FOUND");
      expect(result.customer_path).toBeUndefined();
    },
  );
});
