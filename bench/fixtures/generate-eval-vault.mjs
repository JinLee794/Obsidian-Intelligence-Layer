/**
 * Generate the committed evaluation vault.
 *
 * Both this script and its output are checked in, so the eval vault can be
 * regenerated and diffed rather than taken on trust. Everything here is
 * literal — no PRNG, no UUID generation, no clock — so regenerating produces
 * byte-identical files on any machine:
 *
 *   node bench/fixtures/generate-eval-vault.mjs
 *   git diff --exit-code bench/fixtures/eval-vault
 *
 * Why a second vault rather than more cases against `bench/fixtures/vault`:
 * that vault holds twelve notes, and a search returning the top ten of twelve
 * finds a relevant note almost regardless of how it ranks. Its hit rate sits at
 * 100% and cannot move, which makes it useless for telling two ranking policies
 * apart. This vault is sixty notes across eight unrelated business domains, so a
 * query has something to be wrong about.
 *
 * The domains are deliberately disjoint — banking compliance, hospital privacy,
 * factory telemetry, travel cost control — because a vault of near-identical
 * notes makes every embedding look alike and turns paraphrase scoring into
 * noise. Distinct subject matter is what gives a paraphrase query one defensible
 * answer.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(here, "eval-vault");

/**
 * One customer and everything that hangs off it.
 *
 * Each cluster owns a subject nothing else in the vault discusses, so the note
 * a paraphrase should find is not a matter of opinion.
 */
const CLUSTERS = [
  {
    name: "Contoso",
    sector: "manufacturing",
    tpid: "TP-100200",
    accountid: "ACC-CONTOSO-001",
    status: "active",
    tags: ["customer", "enterprise"],
    summary:
      "Industrial manufacturer moving its plant scheduling estate out of two ageing datacentres and into Azure. The engagement is dominated by network design: hub-and-spoke topology, VNet peering between regions, and private endpoints for the scheduling databases.",
    opportunities: [
      { title: "Datacentre Exit Phase 2", guid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      { title: "Plant Scheduling Modernisation", guid: "f9e8d7c6-b5a4-3210-fedc-ba0987654321" },
    ],
    milestones: [
      { id: "MS-CTS-001", title: "Hub landing zone accepted", state: "complete" },
      { id: "MS-CTS-002", title: "First scheduling workload cut over", state: "in progress" },
      { id: "MS-CTS-003", title: "Second datacentre decommissioned", state: "planned" },
    ],
    insights: [
      "Landing zone review passed with no blocking findings.",
      "Peering between the two regions is the critical path for the next milestone.",
    ],
    people: [
      {
        name: "Alice Nakamura",
        role: "Cloud Solution Architect",
        expertise:
          "Designs hub-and-spoke network topologies and owns the peering and private endpoint design for the scheduling databases.",
      },
    ],
    project: {
      title: "Datacentre Exit Phase 2",
      slug: "datacentre-exit-phase-2",
      status: "in-progress",
      body:
        "Retire the Dortmund and Leeds datacentres by migrating plant scheduling, MES integration and the historian database into Azure. The hub landing zone is accepted. Remaining work is the region-to-region peering that the scheduling cutover depends on.",
    },
    meetings: [
      {
        date: "2026-02-20",
        title: "Datacentre exit review",
        discussion:
          "Walked the remaining datacentre exit plan. The hub landing zone is signed off. The scheduling workload cutover is blocked on VNet peering between the two regions, which needs a firewall rule change from the customer network team.",
        actions: [
          "Alice: submit the peering firewall change request",
          "Priya: confirm the historian database licence transfers",
        ],
      },
      {
        date: "2026-03-06",
        title: "Peering unblock",
        discussion:
          "The firewall change landed. Peering is established and validated end to end. Scheduling cutover is rescheduled for the first week of April, with a rollback plan back to the Leeds datacentre for forty-eight hours.",
        actions: ["Alice: publish the cutover runbook and rollback plan"],
      },
    ],
  },
  {
    name: "Fabrikam",
    sector: "retail",
    tpid: "TP-300400",
    accountid: "ACC-FABRIKAM-001",
    status: "active",
    tags: ["customer", "smb"],
    summary:
      "Mid-sized retailer piloting Microsoft 365 Copilot across its merchandising and store-support teams. The work is about adoption rather than infrastructure: licence assignment, prompt coaching for staff, and measuring whether the assistant actually saves anyone time.",
    opportunities: [
      { title: "Copilot Adoption Pilot", guid: "11223344-5566-7788-99aa-bbccddeeff00" },
    ],
    milestones: [
      { id: "MS-FAB-001", title: "Pilot cohort selected", state: "complete" },
      { id: "MS-FAB-002", title: "Licences assigned and training delivered", state: "in progress" },
    ],
    insights: [
      "Merchandising cohort is enthusiastic; store support needs more hand-holding.",
      "Procurement approved the pilot licence block for ninety days.",
    ],
    people: [
      {
        name: "Dev Okonkwo",
        role: "Adoption Specialist",
        expertise:
          "Runs generative AI assistant rollouts. Writes the prompt coaching material and measures time saved per task after a deployment.",
      },
    ],
    project: {
      title: "Copilot Adoption Pilot",
      slug: "copilot-adoption-pilot",
      status: "planning",
      body:
        "Ninety-day pilot of Microsoft 365 Copilot for forty merchandising and store-support staff. Success is measured on task time saved and weekly active use, not on licences sold.",
    },
    meetings: [
      {
        date: "2026-02-15",
        title: "Copilot pilot kickoff",
        discussion:
          "Agreed the pilot cohort, the ninety-day window and the two success measures. The customer wants evidence of time saved on weekly range planning before extending the pilot to the wider business.",
        actions: [
          "Dev: deliver prompt coaching sessions for both cohorts",
          "Dev: baseline how long range planning takes today",
        ],
      },
      {
        date: "2026-03-12",
        title: "Copilot pilot mid-point",
        discussion:
          "Merchandising is using the assistant daily and reports range planning is meaningfully quicker. Store support has barely touched it; the tasks are too short to benefit and the coaching missed that.",
        actions: ["Dev: rework the store-support coaching around longer tasks"],
      },
    ],
  },
  {
    name: "Northwind",
    sector: "retail",
    tpid: "TP-500600",
    accountid: "ACC-NORTHWIND-001",
    status: "at-risk",
    tags: ["customer", "enterprise", "at-risk"],
    summary:
      "Retail group whose analytics programme has stalled. The relationship has deteriorated over two quarters: milestones slip, the sponsor stopped attending, and the customer has begun evaluating a competing platform. This is the account most likely to churn.",
    opportunities: [
      { title: "Retail Analytics Platform", guid: "aabbccdd-1122-3344-5566-778899001122" },
      { title: "Demand Forecasting Refresh", guid: "11aa22bb-33cc-44dd-55ee-66ff77889900" },
    ],
    milestones: [
      { id: "MS-NWD-001", title: "Assessment accepted", state: "complete" },
      { id: "MS-NWD-002", title: "Analytics foundation delivered", state: "overdue" },
      { id: "MS-NWD-003", title: "Forecasting proof of concept", state: "blocked" },
    ],
    insights: [
      "Second milestone is thirty days overdue with no revised date agreed.",
      "Executive sponsor has missed three consecutive steering meetings.",
      "Customer has asked a competitor for a comparison proposal.",
    ],
    people: [
      {
        name: "Grace Aldridge",
        role: "Customer Success Account Manager",
        expertise:
          "Owns the Northwind relationship. Raised the account to leadership and is running the recovery plan.",
      },
    ],
    project: {
      title: "Retail Analytics Platform",
      slug: "retail-analytics-platform",
      status: "at-risk",
      body:
        "Analytics foundation for store and online sales reporting. Delivery has stalled: the customer data team is understaffed and the agreed foundation milestone is thirty days past its date.",
    },
    meetings: [
      {
        date: "2026-02-25",
        title: "Northwind escalation",
        discussion:
          "Formal escalation raised to leadership. The foundation milestone is thirty days overdue, the sponsor has disengaged, and the customer is talking to a competitor. Root cause is an understaffed customer data team rather than any technical blocker.",
        actions: [
          "Grace: agree a recovery plan with the customer within two weeks",
          "Grace: arrange an executive-to-executive meeting",
        ],
      },
      {
        date: "2026-03-18",
        title: "Northwind recovery checkpoint",
        discussion:
          "Recovery plan agreed and the sponsor attended. Scope for the foundation milestone is cut to store reporting only, with online reporting deferred. The competitive evaluation is still live.",
        actions: ["Grace: confirm the reduced foundation scope in writing"],
      },
    ],
  },
  {
    name: "Woodgrove",
    sector: "banking",
    tpid: "TP-700800",
    accountid: "ACC-WOODGROVE-001",
    status: "active",
    tags: ["customer", "enterprise", "regulated"],
    summary:
      "Retail bank preparing for a supervisory examination. Almost all the work is evidence: demonstrating separation of duties, retaining immutable audit trails, and proving that privileged access to payment systems is reviewed and approved.",
    opportunities: [
      { title: "Regulatory Evidence Platform", guid: "22334455-6677-8899-aabb-ccddeeff0011" },
    ],
    milestones: [
      { id: "MS-WDG-001", title: "Control mapping signed off", state: "complete" },
      { id: "MS-WDG-002", title: "Immutable audit retention live", state: "in progress" },
    ],
    insights: [
      "Examiners asked for two years of privileged access approvals, not one.",
      "Control mapping accepted without exception by internal audit.",
    ],
    people: [
      {
        name: "Marcus Bello",
        role: "Compliance Architect",
        expertise:
          "Maps regulatory control requirements onto platform capability. Owns evidence collection for supervisory examinations and privileged access review.",
      },
    ],
    project: {
      title: "Regulatory Evidence Platform",
      slug: "regulatory-evidence-platform",
      status: "in-progress",
      body:
        "Collect and retain the evidence a supervisory examination asks for: immutable audit trails, separation-of-duties attestations, and a reviewable record of every privileged access grant to payment systems.",
    },
    meetings: [
      {
        date: "2026-02-11",
        title: "Examination readiness review",
        discussion:
          "Reviewed what the examiners will ask for. Control mapping is accepted. The gap is retention: privileged access approvals are kept for one year and the examiners expect two.",
        actions: ["Marcus: extend audit retention to two years and prove immutability"],
      },
      {
        date: "2026-03-09",
        title: "Audit retention design",
        discussion:
          "Settled on write-once retention with a legal hold, so an approval record cannot be altered or deleted inside the retention window even by an administrator.",
        actions: ["Marcus: document the legal hold procedure for internal audit"],
      },
    ],
  },
  {
    name: "Tailspin",
    sector: "travel",
    tpid: "TP-900100",
    accountid: "ACC-TAILSPIN-001",
    status: "active",
    tags: ["customer", "smb"],
    summary:
      "Travel booking business whose monthly cloud bill has grown faster than its bookings. The engagement is financial: find the overspend, right-size what is oversized, and put a forecast in place so the finance team stops being surprised.",
    opportunities: [
      { title: "Cloud Spend Reduction", guid: "33445566-7788-99aa-bbcc-ddeeff001122" },
    ],
    milestones: [
      { id: "MS-TLS-001", title: "Spend baseline established", state: "complete" },
      { id: "MS-TLS-002", title: "Reserved capacity purchased", state: "in progress" },
    ],
    insights: [
      "Idle pre-production environments account for roughly a third of the monthly bill.",
      "Booking search tier is provisioned for peak season all year round.",
    ],
    people: [
      {
        name: "Sofia Renard",
        role: "FinOps Specialist",
        expertise:
          "Reduces cloud spend. Builds chargeback models, finds idle and oversized resources, and forecasts monthly bills for finance teams.",
      },
    ],
    project: {
      title: "Cloud Spend Reduction",
      slug: "cloud-spend-reduction",
      status: "in-progress",
      body:
        "Bring the monthly cloud bill back in line with bookings. Shut down idle pre-production environments outside working hours, right-size the booking search tier off-season, and buy reserved capacity for the steady-state baseline.",
    },
    meetings: [
      {
        date: "2026-02-06",
        title: "Spend baseline walkthrough",
        discussion:
          "Walked the last six months of billing. Pre-production environments run continuously and account for about a third of the bill. The booking search tier is sized for August peak in every month of the year.",
        actions: [
          "Sofia: schedule pre-production shutdown outside working hours",
          "Sofia: model reserved capacity against the steady-state baseline",
        ],
      },
      {
        date: "2026-03-04",
        title: "Reserved capacity decision",
        discussion:
          "Agreed a one-year reservation covering the steady-state baseline only, leaving peak season on demand. Finance accepted the forecast and wants a monthly variance report.",
        actions: ["Sofia: produce the monthly spend variance report"],
      },
    ],
  },
  {
    name: "Proseware",
    sector: "healthcare",
    tpid: "TP-110220",
    accountid: "ACC-PROSEWARE-001",
    status: "active",
    tags: ["customer", "enterprise", "regulated"],
    summary:
      "Hospital group modernising its clinical records estate. Every decision is constrained by patient confidentiality: which staff may read which records, how identifiable data is masked before it reaches a research environment, and where consent is recorded.",
    opportunities: [
      { title: "Clinical Records Modernisation", guid: "44556677-8899-aabb-ccdd-eeff00112233" },
    ],
    milestones: [
      { id: "MS-PRW-001", title: "Consent model agreed", state: "complete" },
      { id: "MS-PRW-002", title: "De-identification pipeline live", state: "in progress" },
    ],
    insights: [
      "Research environment must never receive directly identifying fields.",
      "Clinicians need break-glass access with after-the-fact review, not standing access.",
    ],
    people: [
      {
        name: "Hannah Vogt",
        role: "Data Protection Architect",
        expertise:
          "Protects patient confidentiality. Designs de-identification pipelines, consent capture, and break-glass access review for clinical records.",
      },
    ],
    project: {
      title: "Clinical Records Modernisation",
      slug: "clinical-records-modernisation",
      status: "in-progress",
      body:
        "Move clinical records onto a modern platform without weakening patient confidentiality. Directly identifying fields are removed before any record reaches the research environment, and clinician access outside a care relationship requires break-glass with review.",
    },
    meetings: [
      {
        date: "2026-02-18",
        title: "Consent and access model",
        discussion:
          "Agreed that consent is recorded per research purpose rather than once globally, and that clinicians get break-glass access reviewed after the fact instead of standing access to every record.",
        actions: ["Hannah: specify the break-glass review workflow"],
      },
      {
        date: "2026-03-16",
        title: "De-identification pipeline review",
        discussion:
          "Reviewed the masking rules. Names, addresses and identifiers are removed; dates are shifted per patient by a consistent offset so intervals survive. Free-text clinical notes remain the hard case.",
        actions: ["Hannah: evaluate free-text scrubbing before research release"],
      },
    ],
  },
  {
    name: "Litware",
    sector: "industrial",
    tpid: "TP-330440",
    accountid: "ACC-LITWARE-001",
    status: "active",
    tags: ["customer", "enterprise"],
    summary:
      "Equipment maker instrumenting its factory floor. Thousands of machines emit vibration and temperature readings; the problem is deciding what to process at the machine and what to ship to the cloud over a constrained site link.",
    opportunities: [
      { title: "Factory Telemetry Platform", guid: "55667788-99aa-bbcc-ddee-ff0011223344" },
    ],
    milestones: [
      { id: "MS-LTW-001", title: "Edge gateway pilot on one line", state: "complete" },
      { id: "MS-LTW-002", title: "Predictive maintenance model in production", state: "in progress" },
    ],
    insights: [
      "Site uplink cannot carry raw sensor readings; aggregation has to happen on the line.",
      "Vibration signatures predict bearing failure about nine days ahead.",
    ],
    people: [
      {
        name: "Tomas Lindqvist",
        role: "IoT Solution Architect",
        expertise:
          "Builds factory-floor telemetry systems. Decides what is aggregated on an edge gateway versus shipped upstream, and productionises predictive maintenance models.",
      },
    ],
    project: {
      title: "Factory Telemetry Platform",
      slug: "factory-telemetry-platform",
      status: "in-progress",
      body:
        "Collect vibration and temperature readings from production machinery, aggregate at an edge gateway on each line because the site uplink cannot carry raw readings, and predict bearing failures roughly nine days before they happen.",
    },
    meetings: [
      {
        date: "2026-02-13",
        title: "Edge versus cloud split",
        discussion:
          "Agreed the split. Raw vibration is windowed and reduced to features on the line gateway; only features and alerts cross the site uplink. Raw data is retained locally for seven days for incident investigation.",
        actions: ["Tomas: define the on-gateway feature set and retention"],
      },
      {
        date: "2026-03-20",
        title: "Predictive maintenance validation",
        discussion:
          "Validated the bearing failure model against a year of historical failures. It gives about nine days of warning with an acceptable false alarm rate, which is enough lead time to order parts.",
        actions: ["Tomas: route model alerts into the maintenance work order system"],
      },
    ],
  },
  {
    name: "Lucerne",
    sector: "energy",
    tpid: "TP-550660",
    accountid: "ACC-LUCERNE-001",
    status: "active",
    tags: ["customer", "enterprise"],
    summary:
      "Regional energy utility hardening itself against outages. The engagement is about what happens when a region fails: how quickly the grid control estate comes back, how much data loss is tolerable, and whether the failover has ever actually been rehearsed.",
    opportunities: [
      { title: "Grid Control Resiliency", guid: "66778899-aabb-ccdd-eeff-001122334455" },
    ],
    milestones: [
      { id: "MS-LCN-001", title: "Recovery objectives agreed", state: "complete" },
      { id: "MS-LCN-002", title: "Regional failover rehearsed end to end", state: "in progress" },
    ],
    insights: [
      "Grid control tolerates fifteen minutes of downtime and no data loss at all.",
      "Failover has been documented for two years but never actually rehearsed.",
    ],
    people: [
      {
        name: "Ingrid Solberg",
        role: "Resiliency Architect",
        expertise:
          "Plans for regional failure. Sets recovery time and recovery point objectives, designs failover, and runs the rehearsals that prove it works.",
      },
    ],
    project: {
      title: "Grid Control Resiliency",
      slug: "grid-control-resiliency",
      status: "in-progress",
      body:
        "Ensure grid control survives the loss of an entire region. Recovery objectives are fifteen minutes of downtime and zero data loss. The failover design exists on paper and has never been rehearsed, which is the substance of the remaining milestone.",
    },
    meetings: [
      {
        date: "2026-02-27",
        title: "Recovery objectives workshop",
        discussion:
          "Set recovery objectives per system. Grid control gets fifteen minutes and zero data loss; billing and reporting can tolerate four hours and fifteen minutes of loss. Synchronous replication is required for grid control alone.",
        actions: ["Ingrid: cost synchronous replication for grid control only"],
      },
      {
        date: "2026-03-24",
        title: "Failover rehearsal planning",
        discussion:
          "Planned the first real rehearsal. A full region will be taken out of service during a low-demand window, with the regulator notified in advance and a documented abort point thirty minutes in.",
        actions: ["Ingrid: schedule the rehearsal and notify the regulator"],
      },
    ],
  },
];

/** Weekly notes, as realistic cross-cluster distractors. */
const WEEKLIES = [
  {
    week: "2026-W07",
    date: "2026-02-13",
    lines: [
      "Woodgrove examination readiness reviewed; retention gap identified.",
      "Litware edge gateway pilot completed on the first line.",
      "Tailspin billing baseline walkthrough held.",
    ],
  },
  {
    week: "2026-W08",
    date: "2026-02-20",
    lines: [
      "Contoso datacentre exit review completed; peering is the critical path.",
      "Fabrikam Copilot pilot kicked off with two cohorts.",
      "Proseware consent and access model agreed.",
    ],
  },
  {
    week: "2026-W09",
    date: "2026-02-27",
    lines: [
      "Northwind escalated to leadership; recovery plan due within two weeks.",
      "Lucerne recovery objectives workshop held.",
    ],
  },
  {
    week: "2026-W10",
    date: "2026-03-06",
    lines: [
      "Contoso peering unblocked; scheduling cutover moved to April.",
      "Tailspin reserved capacity decision taken.",
    ],
  },
  {
    week: "2026-W11",
    date: "2026-03-13",
    lines: [
      "Fabrikam pilot mid-point: merchandising strong, store support weak.",
      "Woodgrove audit retention design settled on write-once with legal hold.",
    ],
  },
  {
    week: "2026-W12",
    date: "2026-03-20",
    lines: [
      "Northwind recovery checkpoint held; sponsor attended.",
      "Litware predictive maintenance model validated.",
      "Proseware de-identification pipeline reviewed.",
    ],
  },
];

/** Daily notes. Deliberately low-signal — they exist to be ranked past. */
const DAILY_DATES = [
  "2026-02-02", "2026-02-09", "2026-02-16", "2026-02-23",
  "2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23",
];

const DAILY_LINES = [
  "Cleared inbox and triaged action items across the portfolio.",
  "Internal review of engagement plans for the quarter.",
  "Drafted the portfolio status summary for the regional lead.",
  "Team sync on delivery capacity for the coming month.",
  "Updated milestone dates after the weekly customer calls.",
  "Reviewed open risks and closed the ones with no remaining exposure.",
  "Prepared material for the monthly portfolio review.",
  "Caught up on documentation left over from last week.",
];

function frontmatter(fields) {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      Array.isArray(value) ? `${key}: [${value.join(", ")}]` : `${key}: ${value}`,
    );
  return `---\n${lines.join("\n")}\n---\n`;
}

async function write(relPath, content) {
  const full = join(outputDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

let noteCount = 0;

for (const cluster of CLUSTERS) {
  // ── Customer ──
  const opportunities = cluster.opportunities
    .map((o) => `- **${o.title}** — GUID: \`${o.guid}\``)
    .join("\n");
  const milestones = cluster.milestones
    .map((m) => `- ${m.title} — ID: \`${m.id}\` (${m.state})`)
    .join("\n");
  const insights = cluster.insights.map((i) => `- ${i}`).join("\n");
  const team = cluster.people.map((p) => `| ${p.name} | ${p.role} |`).join("\n");

  await write(
    `Customers/${cluster.name}.md`,
    `${frontmatter({
      tags: cluster.tags,
      tpid: `"${cluster.tpid}"`,
      accountid: `"${cluster.accountid}"`,
      status: cluster.status,
      sector: cluster.sector,
    })}
# ${cluster.name}

${cluster.summary}

## Team

| Name | Role |
|------|------|
${team}

## Opportunities

${opportunities}

## Milestones

${milestones}

## Agent Insights

${insights}
`,
  );
  noteCount++;

  // ── People ──
  for (const person of cluster.people) {
    await write(
      `People/${person.name}.md`,
      `${frontmatter({ tags: ["person", "internal"], customers: [cluster.name], role: person.role })}
# ${person.name}

${person.role} supporting [[${cluster.name}]].

## Focus

${person.expertise}
`,
    );
    noteCount++;
  }

  // ── Project ──
  await write(
    `Projects/${cluster.project.slug}.md`,
    `${frontmatter({
      tags: ["project"],
      customer: cluster.name,
      status: cluster.project.status,
    })}
# ${cluster.project.title}

${cluster.project.body}

## Related

- [[${cluster.name}]]
${cluster.people.map((p) => `- [[${p.name}]]`).join("\n")}
`,
  );
  noteCount++;

  // ── Meetings ──
  for (const meeting of cluster.meetings) {
    const slug = meeting.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await write(
      `Meetings/${meeting.date}-${cluster.name}-${slug}.md`,
      `${frontmatter({
        tags: ["meeting"],
        date: `"${meeting.date}"`,
        customer: cluster.name,
        status: "completed",
      })}
# ${cluster.name} — ${meeting.title}

## Attendees

${cluster.people.map((p) => `- [[${p.name}]]`).join("\n")}

## Discussion

${meeting.discussion}

## Action Items

${meeting.actions.map((a) => `- [ ] ${a}`).join("\n")}
`,
    );
    noteCount++;
  }
}

for (const weekly of WEEKLIES) {
  await write(
    `Weekly/${weekly.week}.md`,
    `${frontmatter({ tags: ["weekly"], date: `"${weekly.date}"` })}
# ${weekly.week}

## Highlights

${weekly.lines.map((l) => `- ${l}`).join("\n")}
`,
  );
  noteCount++;
}

for (const [index, date] of DAILY_DATES.entries()) {
  await write(
    `Daily/${date}.md`,
    `${frontmatter({ tags: ["daily"], date: `"${date}"` })}
# ${date}

## Notes

- ${DAILY_LINES[index % DAILY_LINES.length]}
- ${DAILY_LINES[(index + 3) % DAILY_LINES.length]}
`,
  );
  noteCount++;
}

await write(
  "oil.config.yaml",
  `# Evaluation vault — matches the default schema.\nsearch:\n  exclude_folders: []\n`,
);

console.log(`Generated ${noteCount} notes into ${outputDir}`);
