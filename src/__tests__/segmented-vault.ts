/**
 * A small vault shaped like a real one — people, customer hubs, meetings over
 * several years, daily notes, a project folder and a root note, with links
 * that mostly cross folders — for the segmented-layout and migrate-graph tests.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const INDEX_FILE = "_oil-graph.json";
export const SEGMENT_DIR = ".oil-graph";
export const SKELETON = join(SEGMENT_DIR, "skeleton.json");

const PEOPLE = [
  "Alice Adams",
  "Bruno Baker",
  "Chen Cho",
  "Dana Diaz",
  "Elif Erdem",
  "Farah Faris",
  "Goran Gill",
  "Hana Hart",
  "2nd Line Support",
];
const CUSTOMERS = ["Contoso", "Fabrikam", "Northwind", "Tailspin"];
const YEARS = [2022, 2023, 2024, 2025];
const MEETINGS_PER_YEAR = 6;

export const PERSON_NOTE = "People/Alice Adams.md";
export const HUB_NOTE = "Customers/Contoso/Contoso.md";
export const OPPORTUNITY_NOTE = "Customers/Contoso/Contoso Opportunity.md";

/** About 1.5 KB of prose, so note bodies, not metadata, dominate the index. */
function filler(seed: string): string {
  return Array.from(
    { length: 16 },
    (_, i) => `Point ${i} for ${seed}: follow up on the rollout plan, pricing and the next review date.`,
  ).join("\n");
}

function note(frontmatter: string[], title: string, lines: string[]): string {
  return `---\n${frontmatter.join("\n")}\n---\n\n# ${title}\n\n${lines.join("\n")}\n\n## Notes\n\n${filler(title)}\n`;
}

/** Write the vault and return the relative path of every note in it. */
export async function seedVault(root: string): Promise<string[]> {
  const files = new Map<string, string>();

  PEOPLE.forEach((name, i) => {
    const customer = CUSTOMERS[i % CUSTOMERS.length];
    files.set(
      `People/${name}.md`,
      note(["type: person", `aliases: [${name.split(" ")[0]}]`, "tags: [person]"], name, [
        `Works with [[${customer}]].`,
      ]),
    );
  });

  CUSTOMERS.forEach((customer, i) => {
    const next = CUSTOMERS[(i + 1) % CUSTOMERS.length];
    files.set(
      `Customers/${customer}/${customer}.md`,
      note(["type: customer", `aliases: [${customer} Ltd]`, "tags: [customer]"], customer, [
        `Stakeholders: [[${PEOPLE[i]}]], [[${PEOPLE[i + 4]}]].`,
        `Partners with [[${next} Ltd]].`,
      ]),
    );
    files.set(
      `Customers/${customer}/${customer} Opportunity.md`,
      note(["type: opportunity", `customer: "[[${customer}]]"`], `${customer} Opportunity`, [
        `Account: [[${customer}]].`,
      ]),
    );
  });

  for (const year of YEARS) {
    for (let i = 0; i < MEETINGS_PER_YEAR; i++) {
      const customer = CUSTOMERS[i % CUSTOMERS.length];
      const date = `${year}-${String(i + 1).padStart(2, "0")}-15`;
      const title = `${date} ${customer} sync`;
      files.set(
        `Meetings/${title}.md`,
        note(["type: meeting", `date: ${date}`, `customer: "[[${customer}]]"`, "tags: [meeting]"], title, [
          `Customer: [[${customer}]]`,
          `Attendees: [[${PEOPLE[i]}]], [[${PEOPLE[(i + 3) % PEOPLE.length]}]]`,
          `- [ ] Send the follow-up to ${customer}`,
        ]),
      );
    }
  }

  files.set("Daily/2024-05-01.md", note(["date: 2024-05-01"], "2024-05-01", ["Prep for [[2024-05-15 Contoso sync]]."]));
  files.set("Daily/2025-02-03.md", note(["date: 2025-02-03"], "2025-02-03", ["Called [[Dana]] about [[Fabrikam]]."]));
  files.set("Projects/Roadmap.md", note(["type: project"], "Roadmap", ["Covers [[Contoso]] and [[Northwind Ltd]]."]));
  files.set("Index.md", note(["type: index"], "Index", CUSTOMERS.map((c) => `- [[${c}]]`)));

  for (const [path, text] of files) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf-8");
  }
  return [...files.keys()];
}

export function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every file under a directory with its size and mtime, to prove nothing was written. */
export async function snapshotTree(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), path);
      else {
        const info = await stat(join(current, entry.name));
        out.push(`${path}:${info.size}:${info.mtimeMs}`);
      }
    }
  };
  await walk(dir, "");
  return out.sort().join("\n");
}
