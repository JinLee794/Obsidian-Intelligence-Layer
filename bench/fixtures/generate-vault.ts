/**
 * Synthetic vault generator — creates reproducible fixture vaults of arbitrary size.
 *
 * Usage:
 *   npx tsx bench/fixtures/generate-vault.ts [noteCount] [outputDir]
 *   npx tsx bench/fixtures/generate-vault.ts 500 /tmp/oil-synth-vault
 *
 * Defaults: 200 notes → bench/fixtures/synth-vault/
 *
 * Structure mirrors a real OIL vault:
 *   Customers/       — ~10% of notes
 *   People/          — ~10% of notes
 *   Meetings/        — ~25% of notes
 *   Projects/        — ~5% of notes
 *   Weekly/          — ~10% of notes
 *   Daily/           — ~40% of notes
 *   _agent-log/      — a few log files
 *
 * Each note has realistic frontmatter, wikilinks to other notes, headings, and body text.
 * Deterministic via a simple seeded PRNG so benchmarks are reproducible.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";

// ── Seeded PRNG (Mulberry32) ────────────────────────────────────────────────

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Data pools ──────────────────────────────────────────────────────────────

const COMPANY_NAMES = [
  "Contoso", "Fabrikam", "Northwind", "Woodgrove", "Tailspin",
  "Proseware", "Litware", "AdventureWorks", "Lucerne", "Humongous",
  "Trey", "Margie", "Datum", "Alpine", "Lamna",
];

const PERSON_NAMES = [
  "Alice Smith", "Bob Chen", "Carol Davis", "Dave Wilson", "Eve Martinez",
  "Frank Lee", "Grace Kim", "Henry Patel", "Irene Novak", "Jack Brown",
  "Karen White", "Leo Garcia", "Maria Johnson", "Nate Thompson", "Olivia Taylor",
];

const ROLES = ["CSA", "CSAM", "Specialist", "Principal", "Manager", "Director"];

const TAGS = [
  "customer", "enterprise", "smb", "meeting", "person", "project",
  "weekly", "daily", "risk", "escalation", "migration", "ai", "copilot",
  "onboarding", "review", "planning", "retrospective",
];

const TOPICS = [
  "Azure Migration", "Data Platform Modernization", "AI Copilot Pilot",
  "Security Posture Review", "Cost Optimization", "DevOps Maturity",
  "Landing Zone", "Networking Dependencies", "Identity Management",
  "Compliance Audit", "Performance Tuning", "Capacity Planning",
];

const INSIGHT_TEMPLATES = [
  "Pipeline health is strong. Both opportunities are on track.",
  "Flagged a potential delay on M2 due to networking dependencies.",
  "Onboarding complete. Customer is actively engaged.",
  "Risk escalation: missed last two syncs.",
  "Budget approval pending for next quarter.",
  "Successfully migrated first workload to production.",
  "Customer requested architecture review session.",
  "Stakeholder change: new CISO appointed.",
];

// ── Generator ───────────────────────────────────────────────────────────────

interface GeneratorOptions {
  noteCount: number;
  outputDir: string;
  seed?: number;
}

export async function generateVault(options: GeneratorOptions): Promise<{ noteCount: number; path: string }> {
  const { noteCount, outputDir, seed = 42 } = options;
  const rand = mulberry32(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const pickN = <T>(arr: T[], n: number): T[] => {
    const shuffled = [...arr].sort(() => rand() - 0.5);
    return shuffled.slice(0, n);
  };

  // Distribution
  const customerCount = Math.max(3, Math.floor(noteCount * 0.1));
  const peopleCount = Math.max(3, Math.floor(noteCount * 0.1));
  const meetingCount = Math.floor(noteCount * 0.25);
  const projectCount = Math.max(2, Math.floor(noteCount * 0.05));
  const weeklyCount = Math.floor(noteCount * 0.1);
  const dailyCount = noteCount - customerCount - peopleCount - meetingCount - projectCount - weeklyCount;

  // Create directories
  const dirs = ["Customers", "People", "Meetings", "Projects", "Weekly", "Daily", "_agent-log"];
  for (const dir of dirs) {
    await mkdir(join(outputDir, dir), { recursive: true });
  }

  // Track generated paths for cross-linking
  const customerPaths: string[] = [];
  const peoplePaths: string[] = [];
  let generated = 0;

  // ── Customers ──
  const usedCompanies = pickN(COMPANY_NAMES, Math.min(customerCount, COMPANY_NAMES.length));
  for (let i = 0; i < customerCount; i++) {
    const name = i < usedCompanies.length ? usedCompanies[i] : `Company-${i}`;
    const tags = pickN(["customer", "enterprise", "smb"], 2);
    const team = pickN(PERSON_NAMES, Math.floor(rand() * 3) + 1)
      .map((p) => `| ${p} | ${pick(ROLES)} |`)
      .join("\n");
    const insights = pickN(INSIGHT_TEMPLATES, Math.floor(rand() * 3) + 1)
      .map((ins, j) => `- 2026-02-${String(10 + j).padStart(2, "0")}: ${ins}`)
      .join("\n");

    const content = `---
tags: [${tags.join(", ")}]
tpid: "${100000 + i}"
status: ${pick(["active", "active", "active", "at-risk"])}
---

# ${name}

## Team

| Name | Role |
|------|------|
${team}

## Opportunities

- **${pick(TOPICS)}** — GUID: \`${crypto.randomUUID()}\`
- **${pick(TOPICS)}** — GUID: \`${crypto.randomUUID()}\`

## Milestones

- M1: ${pick(TOPICS)} — ID: \`MS-${String(i * 10 + 1).padStart(3, "0")}\`

## Agent Insights

${insights}

## Connect Hooks

- **2026-02-18** | Team/Org | Architecture review with ${name} engineering team
`;

    const path = `Customers/${name}.md`;
    await writeFile(join(outputDir, path), content, "utf-8");
    customerPaths.push(path);
    generated++;
  }

  // ── People ──
  const usedPeople = pickN(PERSON_NAMES, Math.min(peopleCount, PERSON_NAMES.length));
  for (let i = 0; i < peopleCount; i++) {
    const name = i < usedPeople.length ? usedPeople[i] : `Person-${i}`;
    const linkedCustomer = pick(customerPaths).replace("Customers/", "").replace(".md", "");

    const content = `---
tags: [person]
customers: [${linkedCustomer}]
---

# ${name}

${pick(ROLES)} for [[${linkedCustomer}]].

## Notes

- Working on ${pick(TOPICS)} with ${linkedCustomer}.
`;

    const path = `People/${name}.md`;
    await writeFile(join(outputDir, path), content, "utf-8");
    peoplePaths.push(path);
    generated++;
  }

  // ── Meetings ──
  const baseDate = new Date("2026-01-01");
  for (let i = 0; i < meetingCount; i++) {
    const date = new Date(baseDate.getTime() + i * 86400000 * (1 + Math.floor(rand() * 3)));
    const dateStr = date.toISOString().slice(0, 10);
    const customer = pick(customerPaths).replace("Customers/", "").replace(".md", "");
    const topic = pick(TOPICS);

    const content = `---
tags: [meeting]
customer: ${customer}
date: "${dateStr}"
---

# ${customer} — ${topic}

Meeting with [[${customer}]] to discuss ${topic.toLowerCase()}.

## Attendees

${pickN(PERSON_NAMES, Math.floor(rand() * 3) + 1).map((p) => `- [[${p}]]`).join("\n")}

## Notes

- Reviewed progress on ${topic.toLowerCase()}.
- ${pick(INSIGHT_TEMPLATES)}

## Action Items

- [ ] Follow up on ${pick(TOPICS).toLowerCase()} — @${pick(PERSON_NAMES)}
`;

    const path = `Meetings/${dateStr}-${customer}-${topic.replace(/\s+/g, "-").slice(0, 20)}.md`;
    await writeFile(join(outputDir, path), content, "utf-8");
    generated++;
  }

  // ── Projects ──
  for (let i = 0; i < projectCount; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const slug = topic.toLowerCase().replace(/\s+/g, "-");
    const customer = pick(customerPaths).replace("Customers/", "").replace(".md", "");

    const content = `---
tags: [project]
customer: ${customer}
status: ${pick(["active", "planning", "completed"])}
---

# ${topic}

Project for [[${customer}]].

## Overview

${topic} initiative targeting Q2 2026 completion.

## Milestones

- [ ] Phase 1: Planning
- [ ] Phase 2: Implementation
- [ ] Phase 3: Validation
`;

    await writeFile(join(outputDir, `Projects/${slug}.md`), content, "utf-8");
    generated++;
  }

  // ── Weekly ──
  for (let i = 0; i < weeklyCount; i++) {
    const weekNum = String(i + 1).padStart(2, "0");

    const content = `---
tags: [weekly]
---

# 2026-W${weekNum}

## Highlights

- ${pick(INSIGHT_TEMPLATES)}
- ${pick(INSIGHT_TEMPLATES)}

## Customers

${pickN(customerPaths, Math.min(3, customerPaths.length)).map((c) => `- [[${c.replace("Customers/", "").replace(".md", "")}]]`).join("\n")}

## Risks

- ${pick(["No major risks", "Escalation pending for Northwind", "Budget review needed"])}
`;

    await writeFile(join(outputDir, `Weekly/2026-W${weekNum}.md`), content, "utf-8");
    generated++;
  }

  // ── Daily ──
  for (let i = 0; i < dailyCount; i++) {
    const date = new Date(baseDate.getTime() + i * 86400000);
    const dateStr = date.toISOString().slice(0, 10);

    const content = `---
tags: [daily]
date: "${dateStr}"
---

# ${dateStr}

## Tasks

- ${pick(INSIGHT_TEMPLATES)}
- Follow up with [[${pick(customerPaths).replace("Customers/", "").replace(".md", "")}]]

## Notes

- ${pick(TOPICS)} discussion with ${pick(PERSON_NAMES)}.
`;

    await writeFile(join(outputDir, `Daily/${dateStr}.md`), content, "utf-8");
    generated++;
  }

  // ── Agent log ──
  await writeFile(
    join(outputDir, "_agent-log/2026-03-18.md"),
    `---
date: 2026-03-18
tags: [agent-log]
---

# Agent Log — 2026-03-18

### 14:30:00 — atomic_append [auto]
- **Path:** \`Customers/${pick(customerPaths).replace("Customers/", "")}\`
- **Detail:** append to §Agent Insights
`,
    "utf-8",
  );

  // ── Config ──
  await writeFile(
    join(outputDir, "oil.config.yaml"),
    `schema:
  customers_root: "Customers/"
  people_root: "People/"
  meetings_root: "Meetings/"
  projects_root: "Projects/"
  weekly_root: "Weekly/"
  templates_root: "Templates/"
  agent_log: "_agent-log/"

search:
  graph_index_file: "_oil-graph.json"

write_gate:
  diff_format: markdown
  log_all_writes: true
  auto_confirmed_sections:
    - Agent Insights
    - Connect Hooks
  auto_confirmed_operations:
    - log_agent_action
    - capture_connect_hook
`,
    "utf-8",
  );

  return { noteCount: generated, path: outputDir };
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("generate-vault.ts") || process.argv[1]?.endsWith("generate-vault.js")) {
  const count = parseInt(process.argv[2] ?? "200", 10);
  const outDir = process.argv[3] ?? resolve(import.meta.dirname, "synth-vault");

  generateVault({ noteCount: count, outputDir: outDir })
    .then(({ noteCount, path }) => {
      console.log(`Generated ${noteCount} notes in ${path}`);
    })
    .catch((err) => {
      console.error("Failed:", err);
      process.exit(1);
    });
}
