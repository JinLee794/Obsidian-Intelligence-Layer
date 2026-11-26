// Seeded synthetic vault mirroring the real OIL vault's shape:
// People ~37%, Meetings ~20% (flat folder, dated 2020–2026 via frontmatter),
// Customers ~9% across 14 nested hub folders, the rest spread over misc folders.
// Bodies are 1–8 KB of Zipf-distributed words with cross-folder wikilinks,
// aliases, tags, `- [ ]` action items, frontmatter IDs and a few title
// collisions, so link resolution, IDF and lifecycle segmentation all matter.
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export const NOW = "2026-06-30";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CUSTOMERS: Array<[string, string]> = [
  ["Contoso", "CTSO"], ["Fabrikam", "FAB"], ["Northwind Traders", "NWT"],
  ["Tailspin Toys", "TST"], ["Adventure Works", "AW"], ["Litware", "LITW"],
  ["Woodgrove Bank", "WGB"], ["Proseware", "PRSW"], ["Wingtip Toys", "WTT"],
  ["Fourth Coffee", "4COF"], ["Alpine Ski House", "ASH"], ["Coho Winery", "COHO"],
  ["Lamna Healthcare", "LAMNA"], ["Relecloud", "RCLD"],
];
const FIRST = ["Alice","Bram","Chen","Dana","Elif","Farah","Goran","Hana","Ivan","Jun","Kiran","Lena","Mateo","Nadia","Omar","Priya","Quinn","Rosa","Sven","Tara","Uma","Victor","Wen","Ximena","Yusuf","Zara","Aiden","Bianca","Carlos","Deepa","Emil","Fiona","Gabriel","Hiro","Isla","Jonas","Keiko","Liam","Maya","Nikhil","Olga","Pavel","Rina","Sami","Tomas","Ulla","Vera","Wade","Yara","Zane","Anya","Boris","Clara","Diego","Esme","Felix","Greta","Hugo","Ines","Jakob"];
const LAST = ["Smith","Okafor","Nguyen","Garcia","Kowalski","Haddad","Tanaka","Silva","Novak","Brennan","Patel","Larsen","Moreau","Fischer","Rossi","Kim","Ivanova","Mendes","Osei","Lindqvist","Duarte","Yamamoto","Hughes","Bauer","Costa","Sato","Reyes","Weber","Ahmed","Kaur","Murphy","Schmidt","Dubois","Ito","Lopez","Petrov","Olsen","Wright","Chopra","Nakamura","Romero","Kruger","Vargas","Berg","Campbell","Singh","Morales","Hoffman","Jensen","Ali","Torres","Klein","Park","Russo","Watanabe","Ortiz","Wolf","Shah","Fernandez","Lund","Abara","Becker","Cruz","Doyle","Engel","Flores","Gupta","Holm","Ibrahim","Jansen","Keller","Lam","Mazur","Nair","Owens","Price","Quint","Rahman","Stone","Ueda"];
const TOPICS = ["Architecture Review","QBR","Migration Sync","Pricing Discussion","Security Workshop","Pilot Kickoff","Exec Briefing","Escalation Call","Roadmap Review","Data Platform Deep Dive","Landing Zone Design","Cost Optimization","Support Review","Renewal Planning"];
const DOMAIN = ["azure","migration","latency","throughput","pipeline","kubernetes","cluster","identity","network","firewall","budget","forecast","renewal","contract","pilot","workload","database","storage","analytics","governance","compliance","security","incident","outage","roadmap","milestone","deployment","monitoring","telemetry","capacity","quota","region","failover","backup","recovery","sizing","licensing","consumption","architecture","integration","gateway","endpoint","certificate","rotation","policy","sentinel","defender","fabric","synapse","databricks","openai","copilot","agent","model","inference","embedding","retrieval","search","index","vector","prompt","evaluation","benchmark","partner","stakeholder","sponsor","champion","decision","blocker","risk","dependency","timeline","estimate","proposal","workshop","enablement","training","adoption","usage","growth","pipeline","opportunity","forecasting","escalation","ticket","support","sla","uptime","throttling","scaling","autoscale","container","serverless","function","eventhub","servicebus","cosmos","postgres","sql","redis","cache","cdn","frontdoor","apim","entra","tenant","subscription","landing","zone","hub","spoke","peering","private","link","egress","ingress","dns"];

const SYLL = ["ka","lo","mi","ra","ven","tor","sel","dra","quo","pha","nex","lum","zor","bri","cal","dor","fen","gal","hin","jor","kel","mar","nor","pel","ris","sar","tal","vor","wen","yel","zan","ber","cin","dus","eph","fol","gri","hux","ith","jas","kro","lyn","mox","nup","orb","pry","qua","rix","sto","tru"];

function buildLexicon(rand: () => number): { words: string[]; cumulative: Float64Array } {
  const seen = new Set<string>();
  const words: string[] = [];
  // Domain words first so they land on the high-frequency end of the Zipf curve.
  for (const w of DOMAIN) if (!seen.has(w)) { seen.add(w); words.push(w); }
  while (words.length < 9000) {
    const n = 2 + Math.floor(rand() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += SYLL[Math.floor(rand() * SYLL.length)];
    if (!seen.has(w)) { seen.add(w); words.push(w); }
  }
  // Interleave a few domain words deeper into the tail too.
  const cumulative = new Float64Array(words.length);
  let total = 0;
  for (let i = 0; i < words.length; i++) {
    total += 1 / Math.pow(i + 3, 1.05);
    cumulative[i] = total;
  }
  for (let i = 0; i < words.length; i++) cumulative[i] /= total;
  return { words, cumulative };
}

const PHRASES = [
  "quantum ledger reconciliation",
  "sovereign landing zone",
  "private link egress",
  "throughput regression",
  "latency budget overrun",
  "token quota exhaustion",
  "cold start mitigation",
  "zero trust rollout",
];

export interface FixtureCustomer {
  name: string;
  abbr: string;
  hub: string;
  tpid: string;
}

export interface FixtureInfo {
  root: string;
  total: number;
  now: string;
  customers: FixtureCustomer[];
  /** Mixed query set for parity: names, aliases, IDs, body phrases, partials. */
  queries: string[];
  /** Notes to edit for the single-note flush test, spread across folders. */
  editTargets: string[];
  counts: Record<string, number>;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

export async function generateVault(root: string, total: number, seed = 42): Promise<FixtureInfo> {
  const rand = mulberry32(seed);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const { words, cumulative } = buildLexicon(mulberry32(seed + 1));
  const word = (): string => {
    const r = rand();
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1; else hi = mid;
    }
    return words[lo];
  };
  const sentence = (n: number): string => {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(word());
    const s = parts.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  };

  const nCustomerNotes = Math.max(CUSTOMERS.length * 2, Math.round(total * 0.09));
  const nPeople = Math.round(total * 0.37);
  const nMeetings = Math.round(total * 0.2);
  const nProjects = Math.round(total * 0.1);
  const nDaily = Math.round(total * 0.12);
  const nReference = Math.round(total * 0.07);
  const nInbox = Math.max(0, total - nCustomerNotes - nPeople - nMeetings - nProjects - nDaily - nReference);

  const customers: FixtureCustomer[] = CUSTOMERS.map(([name, abbr], i) => ({
    name,
    abbr,
    hub: `Customers/${name}/${name}.md`,
    tpid: `TP-${pad(100_000 + i * 7919, 6)}`,
  }));

  // ── names first, so bodies can link to anything ──────────────────────────
  const people: Array<{ name: string; customers: string[]; nick?: string; emp: string }> = [];
  const usedPeople = new Set<string>();
  let pi = 0;
  while (people.length < nPeople) {
    const f = FIRST[pi % FIRST.length];
    const l = LAST[Math.floor(pi / FIRST.length) % LAST.length];
    const round = Math.floor(pi / (FIRST.length * LAST.length));
    pi++;
    const name = round === 0 ? `${f} ${l}` : `${f} ${String.fromCharCode(65 + ((round - 1) % 26))}. ${l}${round > 26 ? ` ${round}` : ""}`;
    if (usedPeople.has(name)) continue;
    usedPeople.add(name);
    const c1 = pick(customers).name;
    const cs = rand() < 0.3 ? [c1, pick(customers).name].filter((v, i, a) => a.indexOf(v) === i) : [c1];
    people.push({
      name,
      customers: cs,
      nick: rand() < 0.2 ? `${f.slice(0, 3)} ${l}` : undefined,
      emp: `EMP-${pad(Math.floor(rand() * 1_000_000), 6)}`,
    });
  }

  const yearWeights: Array<[number, number]> = [[2020, 1], [2021, 1], [2022, 2], [2023, 2], [2024, 3], [2025, 4], [2026, 3]];
  const weightSum = yearWeights.reduce((s, [, w]) => s + w, 0);
  const randomDate = (): string => {
    let r = rand() * weightSum;
    let year = 2026;
    for (const [y, w] of yearWeights) { if (r < w) { year = y; break; } r -= w; }
    const maxMonth = year === 2026 ? 6 : 12;
    const month = 1 + Math.floor(rand() * maxMonth);
    const day = 1 + Math.floor(rand() * 28);
    return `${year}-${pad(month, 2)}-${pad(day, 2)}`;
  };

  const meetings: Array<{ title: string; customer: FixtureCustomer; date: string; id: string }> = [];
  const meetingTitles = new Set<string>();
  for (let i = 0; i < nMeetings; i++) {
    const customer = pick(customers);
    const date = randomDate();
    let title = `${date} ${customer.name} ${pick(TOPICS)}`;
    if (meetingTitles.has(title)) title = `${title} ${i}`;
    meetingTitles.add(title);
    meetings.push({ title, customer, date, id: `MTG-${pad(i * 37 + 11, 6)}` });
  }

  const files: Array<{ path: string; text: string }> = [];
  const linkTargets = (): string => {
    const r = rand();
    if (r < 0.2) {
      const c = pick(customers);
      const s = rand();
      return s < 0.6 ? `[[${c.name}]]` : s < 0.8 ? `[[${c.abbr}]]` : `[[${c.name}|${c.abbr}]]`;
    }
    if (r < 0.6) {
      const p = pick(people);
      return rand() < 0.15 && p.nick ? `[[${p.nick}]]` : rand() < 0.05 ? `[[People/${p.name}]]` : `[[${p.name}]]`;
    }
    if (r < 0.85) return `[[${pick(meetings).title}]]`;
    if (r < 0.97) return `[[Weekly Sync]]`;
    return `[[Idea ${Math.floor(rand() * 500)}]]`; // dangling
  };

  const body = (
    title: string,
    extraLinks: string[],
    opts: { actions?: boolean; headings?: string[] } = {},
  ): string => {
    const target = 1024 + Math.floor(rand() * 7168);
    const lines: string[] = [`# ${title}`, ""];
    const headings = opts.headings ?? ["Summary", "Notes", "Details"];
    let size = 0;
    let h = 0;
    const links = [...extraLinks];
    while (size < target) {
      if (h < headings.length && (size === 0 || rand() < 0.25)) {
        const level = rand() < 0.8 ? "##" : "###";
        lines.push(`${level} ${headings[h++]}`, "");
      }
      let para = "";
      const sentences = 2 + Math.floor(rand() * 4);
      for (let s = 0; s < sentences; s++) {
        para += sentence(6 + Math.floor(rand() * 12)) + " ";
        if (rand() < 0.12) para += `See ${links.length > 0 ? links.shift() : linkTargets()}. `;
        if (rand() < 0.05) para += `Ticket INC${pad(Math.floor(rand() * 10_000_000), 7)} raised. `;
        if (rand() < 0.04) para += `#${pick(["followup", "risk", "exec", "blocked", "win"])} `;
        if (rand() < 0.012) para += `Discussed ${pick(PHRASES)} in depth. `;
      }
      lines.push(para.trim(), "");
      size += para.length;
    }
    for (const l of links) lines.push(`Related: ${l}`);
    if (opts.actions) {
      lines.push("", "## Action Items", "");
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        lines.push(`- [${rand() < 0.4 ? "x" : " "}] ${sentence(5 + Math.floor(rand() * 6)).slice(0, -1)} (${pick(people).name})`);
      }
    }
    return lines.join("\n") + "\n";
  };
  const fm = (entries: Array<[string, string | string[]]>): string => {
    const out = ["---"];
    for (const [k, v] of entries) {
      if (Array.isArray(v)) {
        out.push(`${k}:`);
        for (const item of v) out.push(`  - ${item}`);
      } else {
        out.push(`${k}: ${v}`);
      }
    }
    out.push("---", "");
    return out.join("\n");
  };
  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // ── Customers ─────────────────────────────────────────────────────────────
  const customerSubTopics = ["Account Plan", "Opportunity", "Architecture", "Escalation", "Contract", "Risk Register", "Workshop", "Stakeholder Map"];
  let customerNotes = 0;
  for (const c of customers) {
    const peers = [pick(customers), pick(customers)].filter((x) => x.name !== c.name).map((x) => `[[${x.name}]]`);
    files.push({
      path: c.hub,
      text:
        fm([
          ["type", "customer"],
          ["status", "active"],
          ["tpid", `"${c.tpid}"`],
          ["aliases", [c.abbr, `${c.name} Inc`]],
          ["tags", ["customer", slug(c.name)]],
        ]) + body(c.name, [...peers, `[[${pick(people).name}]]`], { headings: ["Overview", "Stakeholders", "Opportunities", "Risks"], actions: true }),
    });
    files.push({
      path: `Customers/${c.name}/Overview.md`,
      text: fm([["type", "customer-overview"], ["customer", c.name]]) + body(`${c.name} Overview`, [`[[${c.name}]]`]),
    });
    customerNotes += 2;
  }
  for (let i = 0; customerNotes < nCustomerNotes; i++, customerNotes++) {
    const c = customers[i % customers.length];
    const topic = `${c.name} ${customerSubTopics[Math.floor(i / customers.length) % customerSubTopics.length]} ${Math.floor(i / (customers.length * customerSubTopics.length)) + 1}`;
    files.push({
      path: `Customers/${c.name}/${topic}.md`,
      text:
        fm([["type", "customer-note"], ["customer", c.name], ["status", pick(["open", "closed"])], ["tags", ["customer", slug(c.name)]]]) +
        body(topic, [`[[${c.name}]]`, `[[${pick(customers).name}]]`], { actions: rand() < 0.4 }),
    });
  }

  // ── People ────────────────────────────────────────────────────────────────
  for (const p of people) {
    const entries: Array<[string, string | string[]]> = [
      ["type", "person"],
      ["role", pick(["CTO", "Architect", "Engineer", "PM", "Director", "VP", "Analyst"])],
      ["employee_id", `"${p.emp}"`],
      ["customers", p.customers],
    ];
    if (p.nick) entries.push(["aliases", [p.nick]]);
    files.push({
      path: `People/${p.name}.md`,
      text: fm(entries) + body(p.name, p.customers.map((c) => `[[${c}]]`), { headings: ["Role", "Context", "History"] }),
    });
  }

  // ── Meetings (flat; lifecycle lives in frontmatter `date`) ────────────────
  for (const m of meetings) {
    const attendees = [pick(people).name, pick(people).name];
    files.push({
      path: `Meetings/${m.title}.md`,
      text:
        fm([
          ["type", "meeting"],
          ["customer", m.customer.name],
          ["date", m.date],
          ["status", pick(["open", "closed", "closed"])],
          ["meeting_id", `"${m.id}"`],
          ["attendees", attendees],
          ["tags", ["meeting", slug(m.customer.name)]],
        ]) + body(m.title, [`[[${m.customer.name}]]`, ...attendees.map((a) => `[[${a}]]`)], { actions: true, headings: ["Agenda", "Notes", "Decisions"] }),
    });
  }
  files.push({ path: "Meetings/Weekly Sync.md", text: fm([["type", "meeting-series"]]) + body("Weekly Sync", []) });

  // ── Misc folders ──────────────────────────────────────────────────────────
  for (let i = 0; i < nProjects; i++) {
    const c = pick(customers);
    // A few projects share a customer's exact name: title collisions are real.
    const title = i < 3 ? customers[i + 3].name : `${c.name} ${pick(["Migration", "Pilot", "Rollout", "Assessment", "Modernization"])} ${i}`;
    files.push({
      path: `Projects/${title}.md`,
      text:
        fm([["type", "project"], ["customer", c.name], ["status", pick(["active", "done", "paused"])], ["project_code", `"PRJ-${pad(i, 5)}"`]]) +
        body(title, [`[[${c.name}]]`, `[[${pick(customers).name}]]`, `[[${pick(meetings).title}]]`], { actions: rand() < 0.5 }),
    });
  }
  files.push({ path: "Projects/Weekly Sync.md", text: fm([["type", "project"]]) + body("Weekly Sync", []) });
  for (let i = 0; i < nDaily; i++) {
    const date = randomDate();
    files.push({
      path: `Daily/${date} ${i}.md`,
      text: fm([["type", "daily"], ["date", date]]) + body(`${date} ${i}`, [`[[${pick(meetings).title}]]`], { actions: rand() < 0.5 }),
    });
  }
  for (let i = 0; i < nReference; i++) {
    const title = `${pick(DOMAIN)} ${pick(DOMAIN)} guide ${i}`;
    files.push({ path: `Reference/${title}.md`, text: fm([["type", "reference"], ["tags", ["reference"]]]) + body(title, []) });
  }
  for (let i = 0; i < nInbox; i++) {
    const title = `Inbox ${sentence(3).slice(0, -1)} ${i}`;
    files.push({ path: `Inbox/${title}.md`, text: body(title, []) });
  }

  // ── write ─────────────────────────────────────────────────────────────────
  const dirs = new Set(files.map((f) => dirname(join(root, f.path))));
  for (const d of dirs) await mkdir(d, { recursive: true });
  let next = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (next < files.length) {
        const f = files[next++];
        await writeFile(join(root, f.path), f.text, "utf-8");
      }
    }),
  );

  const counts: Record<string, number> = {};
  for (const f of files) {
    const top = f.path.split("/")[0];
    counts[top] = (counts[top] ?? 0) + 1;
  }

  const queries = [
    ...customers.slice(0, 6).map((c) => c.name),
    ...people.slice(0, 6).map((p) => p.name),
    ...customers.slice(6, 11).map((c) => c.abbr),
    ...people.filter((p) => p.nick).slice(0, 2).map((p) => p.nick as string),
    ...customers.slice(0, 4).map((c) => c.tpid),
    ...meetings.slice(0, 3).map((m) => m.id),
    ...people.slice(10, 13).map((p) => p.emp),
    ...PHRASES.slice(0, 6),
    "migrat",
    "contos",
    "escalation risk renewal",
    "kubernetes failover",
  ];

  // Edit targets: weighted like the vault (people, meetings, customers, misc).
  const byFolder = (prefix: string) => files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
  const editTargets = [
    ...[0, 1, 2].map(() => pick(byFolder("People/"))),
    ...[0, 1].map(() => pick(byFolder("Meetings/"))),
    pick(byFolder("Customers/")),
    pick(byFolder("Projects/")),
    pick(byFolder("Daily/")),
    pick(byFolder("Reference/")),
    pick(byFolder("Inbox/").length > 0 ? byFolder("Inbox/") : byFolder("Reference/")),
  ];

  return { root, total: files.length, now: NOW, customers, queries, editTargets, counts };
}
