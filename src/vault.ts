/**
 * OIL — Vault filesystem layer
 * Safe file reads, frontmatter parsing, path security, markdown section parsing.
 */

import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, extname, basename, dirname, isAbsolute } from "node:path";
import matter from "gray-matter";
import type {
  NoteFrontmatter,
  NoteRef,
  ActionItem,
  OpportunityRef,
  MilestoneRef,
  TeamMember,
  OilConfig,
} from "./types.js";

// ─── Path Security ────────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const EXCLUDED_DIRS = new Set([".obsidian", ".trash", "node_modules", ".git"]);

/**
 * Validates and resolves a path within the vault.
 * Prevents path traversal attacks outside the vault root.
 */
export function securePath(vaultPath: string, notePath: string): string {
  const vaultResolved = resolve(vaultPath);
  const resolved = resolve(vaultResolved, notePath);

  // Lexical traversal guard first.
  const lexicalRel = relative(vaultResolved, resolved);
  if (lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
    throw new Error(`Path traversal denied: ${notePath}`);
  }

  // Realpath guard: deny symlink escapes by checking the real filesystem target
  // (or nearest existing ancestor for non-existing paths) stays under vault root.
  let vaultReal: string;
  try {
    vaultReal = realpathSync(vaultResolved);
  } catch {
    throw new Error(`Vault path is not accessible: ${vaultPath}`);
  }

  let pathToCheck = resolved;
  if (!existsSync(pathToCheck)) {
    let cursor = dirname(pathToCheck);
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    pathToCheck = cursor;
  }

  let targetReal: string;
  try {
    targetReal = realpathSync(pathToCheck);
  } catch {
    throw new Error(`Path traversal denied: ${notePath}`);
  }

  const realRel = relative(vaultReal, targetReal);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`Path traversal denied: ${notePath}`);
  }

  return resolved;
}

/**
 * Check if a file has an allowed extension for reading.
 */
export function isAllowedFile(filePath: string): boolean {
  return ALLOWED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Check if a directory should be excluded from indexing.
 */
function isExcludedDir(dirName: string): boolean {
  return EXCLUDED_DIRS.has(dirName) || dirName.startsWith(".");
}

// ─── Line Endings ─────────────────────────────────────────────────────────────

/**
 * Collapse CRLF/CR line endings to LF.
 *
 * Every line-oriented parser in OIL splits on "\n" and matches headings/list
 * items with `.`-based regexes, and `.` never matches `\r`. Without this,
 * Windows-authored (CRLF) notes silently parse to zero sections, zero team
 * members and zero action items. Normalize once at the parse boundary.
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

/**
 * Split text into lines regardless of the source line-ending convention.
 */
export function splitLines(content: string): string[] {
  return content.split(/\r\n?|\n/);
}

/**
 * Detect the dominant line ending of an existing document so writes can
 * preserve it instead of introducing mixed endings.
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const lf = (content.match(/\n/g) ?? []).length;
  // `lf` counts CRLF too — compare CRLF against bare LF occurrences.
  return crlf >= lf - crlf ? "\r\n" : "\n";
}

// ─── Note Reading ─────────────────────────────────────────────────────────────

export interface ParsedNote {
  path: string;
  title: string;
  frontmatter: NoteFrontmatter;
  content: string;
  sections: Map<string, string>;
  wikilinks: string[];
  tags: string[];
}

/**
 * Read and parse a single markdown note — frontmatter, sections, wikilinks.
 */
export async function readNote(
  vaultPath: string,
  notePath: string,
): Promise<ParsedNote> {
  const fullPath = securePath(vaultPath, notePath);
  const raw = await readFile(fullPath, "utf-8");
  return parseNote(notePath, raw);
}

/**
 * Parse a markdown string into a structured note.
 */
export function parseNote(notePath: string, raw: string): ParsedNote {
  // Normalize line endings before anything else — every downstream parser
  // splits on "\n" and uses `.`-based regexes that cannot match "\r".
  const { data: frontmatter, content: rawContent } = matter(normalizeLineEndings(raw));
  const content = normalizeLineEndings(rawContent);
  const title = extractTitle(notePath, content);
  const sections = parseSections(content);
  const wikilinks = extractWikilinks(content);
  const tags = extractTags(frontmatter, content);

  return {
    path: notePath,
    title,
    frontmatter: frontmatter as NoteFrontmatter,
    content,
    sections,
    wikilinks,
    tags,
  };
}

/**
 * Derive a note title: first H1 heading, then filename.
 */
function extractTitle(notePath: string, content: string): string {
  const h1Match = normalizeLineEndings(content).match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return basename(notePath, extname(notePath));
}

/**
 * Parse markdown into heading → content sections.
 * Returns a Map of "## Heading" → content beneath it.
 */
export function parseSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = splitLines(content);
  let currentHeading = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading) {
        sections.set(currentHeading, currentContent.join("\n").trim());
      }
      currentHeading = headingMatch[2].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  // Capture last section
  if (currentHeading) {
    sections.set(currentHeading, currentContent.join("\n").trim());
  }

  return sections;
}

/**
 * Extract all `[[wikilinks]]` from content. Returns resolved link targets.
 */
export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return [...new Set(links)];
}

/**
 * Extract tags from both frontmatter and inline #tags.
 */
function extractTags(
  frontmatter: Record<string, unknown>,
  content: string,
): string[] {
  const tags = new Set<string>();

  // Frontmatter tags
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === "string") tags.add(t);
    }
  } else if (typeof fmTags === "string") {
    tags.add(fmTags);
  }

  // Inline #tags — match #word but not inside code blocks or links
  const inlineTagRegex = /(?:^|\s)#([a-zA-Z][\w-/]*)/g;
  let match;
  while ((match = inlineTagRegex.exec(content)) !== null) {
    tags.add(match[1]);
  }

  return [...tags];
}

// ─── Vault Traversal ──────────────────────────────────────────────────────────

/**
 * Recursively list all markdown files in the vault.
 */
export async function listAllNotes(vaultPath: string): Promise<string[]> {
  const notes: string[] = [];
  await walkDir(vaultPath, vaultPath, notes);
  return notes;
}

async function walkDir(
  root: string,
  dir: string,
  results: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!isExcludedDir(entry.name)) {
        await walkDir(root, join(dir, entry.name), results);
      }
    } else if (entry.isFile() && isAllowedFile(entry.name)) {
      // Normalize to forward slashes — Obsidian uses POSIX paths regardless of OS
      results.push(relative(root, join(dir, entry.name)).replace(/\\/g, "/"));
    }
  }
}

/**
 * List files directly in a specific folder (not recursive).
 */
export async function listFolder(
  vaultPath: string,
  folderPath: string,
): Promise<string[]> {
  const fullPath = securePath(vaultPath, folderPath);
  const entries = await readdir(fullPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && isAllowedFile(e.name))
    .map((e) => join(folderPath, e.name));
}

/**
 * Check if a file exists in the vault.
 */
export async function noteExists(
  vaultPath: string,
  notePath: string,
): Promise<boolean> {
  try {
    const fullPath = securePath(vaultPath, notePath);
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

// ─── Section & Entity Parsing ─────────────────────────────────────────────────

/**
 * Parse opportunity references from the ## Opportunities section.
 * Looks for lines with name and optional GUID patterns.
 */
export function parseOpportunities(section: string): OpportunityRef[] {
  const opps: OpportunityRef[] = [];
  const lines = splitLines(section).filter((l) => l.trim());

  for (const line of lines) {
    // Match: - Name (`opportunityid: GUID`) or - Name (GUID)
    const guidMatch = line.match(
      /(?:opportunityid:\s*)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    // Extract name from markdown list item or line start
    const nameMatch = line.match(/^[-*]\s+(?:\[.\]\s+)?(.+?)(?:\s*[\(`]|$)/);

    if (nameMatch) {
      opps.push({
        name: nameMatch[1].trim(),
        guid: guidMatch?.[1],
      });
    } else if (guidMatch) {
      // Line has a GUID but no clear name format
      const cleanLine = line.replace(/[-*]\s+/, "").trim();
      opps.push({
        name: cleanLine.split(/\s*[\(`]/)[0].trim(),
        guid: guidMatch[1],
      });
    }
  }
  return opps;
}

/**
 * Parse milestone references from the ## Milestones section.
 */
export function parseMilestones(section: string): MilestoneRef[] {
  const milestones: MilestoneRef[] = [];
  const lines = splitLines(section).filter((l) => l.trim());

  for (const line of lines) {
    const idMatch = line.match(
      /(?:milestoneid:\s*)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    const numberMatch = line.match(/(?:milestone\s*#?\s*|MS-?)(\d+)/i);
    const nameMatch = line.match(/^[-*]\s+(?:\[.\]\s+)?(.+?)(?:\s*[\(`]|$)/);

    if (nameMatch || idMatch || numberMatch) {
      milestones.push({
        name: nameMatch
          ? nameMatch[1].trim()
          : line.replace(/[-*]\s+/, "").trim(),
        id: idMatch?.[1],
        number: numberMatch?.[1],
      });
    }
  }
  return milestones;
}

/**
 * Parse team members from the ## Team section.
 *
 * Handles the common corporate-directory shapes:
 *   - [[Jin Lee (HLS US SE)]] — Sr Solution Engineer
 *   - Andrea Welker (She/Her) — Strat Acct Tech Strategist
 *   - Bob Chen - Cloud Architect
 *   - Ada Lovelace (Engineer)
 *   - [[Dave Wilson]]
 *
 * Parentheses inside a display name must NOT be treated as the role
 * separator; a parenthetical is only a role when it closes at end of line
 * and no explicit separator (—, –, spaced -) was found first.
 */
export function parseTeam(section: string): TeamMember[] {
  const team: TeamMember[] = [];
  const lines = splitLines(section).filter((l) => l.trim());

  for (const line of lines) {
    const listMatch = line.match(/^\s*[-*]\s+(?:\[.\]\s+)?(.+)/);
    if (!listMatch) continue;

    const entry = listMatch[1].trim();
    if (!entry) continue;

    let name: string;
    let rest: string;

    // A leading wikilink is the authoritative name boundary — everything
    // inside [[...]] belongs to the name, parentheses included.
    const leadingLink = entry.match(/^\[\[([^\]]+)]]/);
    if (leadingLink) {
      name = leadingLink[1].split("|")[0].trim();
      rest = entry.slice(leadingLink[0].length).trim();
    } else {
      const sepIdx = findTopLevelSeparator(entry);
      if (sepIdx >= 0) {
        name = entry.slice(0, sepIdx).trim();
        rest = entry.slice(sepIdx + 1).trim();
      } else {
        // Only treat a parenthetical as the role when it closes at end of line.
        const trailingParen = entry.match(/^(.+?)\s*\(([^()]*)\)$/);
        if (trailingParen) {
          name = trailingParen[1].trim();
          rest = trailingParen[2].trim();
        } else {
          name = entry;
          rest = "";
        }
      }
    }

    const role = cleanRole(rest);
    name = name.replace(/\[\[|]]/g, "").trim();
    if (!name) continue;

    team.push(role ? { name, role } : { name });
  }
  return team;
}

/**
 * Index of the first name/role separator that sits outside any bracket or
 * parenthesis group. Returns -1 when there is none.
 */
function findTopLevelSeparator(entry: string): number {
  let paren = 0;
  let bracket = 0;

  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (paren === 0 && bracket === 0) {
      if (ch === "—" || ch === "–") return i;
      // A plain hyphen only separates when surrounded by whitespace,
      // so hyphenated names (Jean-Luc) stay intact.
      if (ch === "-" && /\s/.test(entry[i - 1] ?? "") && /\s/.test(entry[i + 1] ?? "")) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Strip a leading separator and a wrapping parenthesis from the role remainder.
 */
function cleanRole(rest: string): string | undefined {
  let role = rest.replace(/^\s*(?:[—–-]|\()\s*/, "").trim();
  if (role.endsWith(")") && !role.includes("(")) {
    role = role.slice(0, -1).trim();
  }
  role = role.replace(/\[\[|]]/g, "").trim();
  return role.length > 0 ? role : undefined;
}

/**
 * Parse action items (task syntax: `- [ ]` and `- [x]`) from content.
 */
export function parseActionItems(
  content: string,
  sourcePath: string,
): ActionItem[] {
  const items: ActionItem[] = [];
  const regex = /^[-*]\s+\[([ xX])\]\s+(.+)$/gm;
  let match;

  while ((match = regex.exec(normalizeLineEndings(content))) !== null) {
    const done = match[1].toLowerCase() === "x";
    const text = match[2].trim();

    // Try to extract assignee from patterns like "@name" or "[[Name]]"
    const assigneeWiki = text.match(/\[\[([^\]]+)\]\]/);
    const assigneeAt = text.match(/@(\w+)/);

    items.push({
      text,
      source: sourcePath,
      assignee: assigneeWiki?.[1] ?? assigneeAt?.[1],
      done,
    });
  }
  return items;
}

/**
 * Create a NoteRef from a parsed note.
 */
export function toNoteRef(note: ParsedNote): NoteRef {
  const excerpt =
    note.content.slice(0, 200).replace(/\n/g, " ").trim() || undefined;
  return {
    path: note.path,
    title: note.title,
    tags: note.tags,
    excerpt,
  };
}

// ─── Section Resolution ───────────────────────────────────────────────────────

/** Heading variants that all mean "the customer team roster". */
export const TEAM_SECTION_HEADINGS = [
  "Team",
  "Microsoft Team",
  "Key Stakeholders",
  "Stakeholders",
] as const;

/** Heading variants that all mean "connect hooks". */
export const CONNECT_HOOKS_SECTION_HEADINGS = [
  "Connect Hooks",
  "Connect",
] as const;

/**
 * Resolve the team roster section from a parsed note, accepting every heading
 * variant OIL supports. Single source of truth so retrieval (get_customer_context)
 * and hygiene (hasTeam) can never disagree about whether a roster exists.
 */
export function resolveTeamSection(sections: Map<string, string>): string {
  return resolveSection(sections, TEAM_SECTION_HEADINGS);
}

/**
 * Resolve the connect hooks section, accepting all supported heading variants.
 */
export function resolveConnectHooksSection(sections: Map<string, string>): string {
  return resolveSection(sections, CONNECT_HOOKS_SECTION_HEADINGS);
}

function resolveSection(
  sections: Map<string, string>,
  headings: readonly string[],
): string {
  for (const heading of headings) {
    const value = sections.get(heading);
    if (value !== undefined) return value;
  }
  // Case-insensitive fallback — Obsidian headings are author-typed.
  const lowered = new Map<string, string>();
  for (const [key, value] of sections) lowered.set(key.toLowerCase(), value);
  for (const heading of headings) {
    const value = lowered.get(heading.toLowerCase());
    if (value !== undefined) return value;
  }
  return "";
}

/**
 * Resolve an entity display name using catalog precedence:
 * frontmatter title → first H1 → filename.
 *
 * `note.title` alone surfaces decorative H1s (e.g. "🎯") as the entity name.
 */
export function resolveEntityName(note: ParsedNote, config: OilConfig): string {
  const titleField = config.frontmatterSchema.titleField ?? "title";
  const fmTitle = note.frontmatter[titleField as keyof NoteFrontmatter];
  if (typeof fmTitle === "string" && fmTitle.trim().length > 0) {
    return fmTitle.trim();
  }
  if (typeof fmTitle === "number") return String(fmTitle);
  return note.title;
}

// ─── Customer Path Resolution ─────────────────────────────────────────────────

/**
 * Resolve the customer note path.
 * Tries nested layout first: Customers/X/X.md
 * Falls back to flat layout: Customers/X.md
 * Returns the path that exists, or the nested path if neither exists.
 */
export async function resolveCustomerPath(
  vaultPath: string,
  config: OilConfig,
  customer: string,
): Promise<string> {
  const nested = `${config.schema.customersRoot}${customer}/${customer}.md`;
  const flat = `${config.schema.customersRoot}${customer}.md`;

  if (await noteExists(vaultPath, nested)) return nested;
  if (await noteExists(vaultPath, flat)) return flat;
  // Default to nested for new files
  return nested;
}

/**
 * Detect whether a string looks like a TPID (numeric identifier).
 * TPIDs are purely numeric strings, typically 5-12 digits.
 */
export function looksLikeTpid(input: string): boolean {
  return /^\d{4,15}$/.test(input.trim());
}

/**
 * Resolve a TPID to a customer folder name by scanning the graph index
 * for customer notes whose frontmatter tpid field matches.
 * Returns the customer name (folder name) or undefined if not found.
 */
export function resolveCustomerByTpid(
  graph: import("./graph.js").GraphIndex,
  config: OilConfig,
  tpid: string,
): string | undefined {
  const customerNotes = graph.getNotesByFolder(config.schema.customersRoot);
  for (const ref of customerNotes) {
    const node = graph.getNode(ref.path);
    if (!node) continue;
    const noteTpid = node.frontmatter[config.frontmatterSchema.tpidField];
    if (
      typeof noteTpid === "string" &&
      noteTpid.replace(/^"|"$/g, "").trim() === tpid.trim()
    ) {
      return customerNameFromPath(ref.path, config);
    }
  }
  return undefined;
}

/**
 * Extract the customer name from a resolved customer path.
 * Handles both nested (Customers/X/X.md) and flat (Customers/X.md) layouts.
 */
export function customerNameFromPath(
  path: string,
  config: OilConfig,
): string {
  const rel = path.replace(config.schema.customersRoot, "");
  // Nested: "Contoso/Contoso.md" → "Contoso"
  if (rel.includes("/")) return rel.split("/")[0];
  // Flat: "Contoso.md" → "Contoso"
  return rel.replace(/\.md$/, "");
}

/**
 * List entity sub-notes for a customer (opportunities or milestones).
 * Returns parsed notes from Customers/X/opportunities/ or Customers/X/milestones/.
 */
export async function listCustomerEntities(
  vaultPath: string,
  config: OilConfig,
  customer: string,
  entityType: "opportunities" | "milestones",
): Promise<ParsedNote[]> {
  const subdir =
    entityType === "opportunities"
      ? config.schema.opportunitiesSubdir
      : config.schema.milestonesSubdir;
  const folderPath = `${config.schema.customersRoot}${customer}/${subdir}`;

  let files: string[];
  try {
    files = await listFolder(vaultPath, folderPath);
  } catch {
    return [];
  }

  const notes: ParsedNote[] = [];
  for (const file of files) {
    try {
      const parsed = await readNote(vaultPath, file);
      notes.push(parsed);
    } catch {
      // Skip unreadable files
    }
  }
  return notes;
}

/**
 * Read opportunity entity notes from the customer's opportunities/ subdirectory.
 * Falls back to section parsing from the customer file if no sub-notes exist.
 */
export async function readOpportunityNotes(
  vaultPath: string,
  config: OilConfig,
  customer: string,
): Promise<OpportunityRef[]> {
  const entityNotes = await listCustomerEntities(
    vaultPath, config, customer, "opportunities",
  );

  if (entityNotes.length > 0) {
    return entityNotes.map((note) => ({
      name: resolveEntityName(note, config),
      guid: typeof note.frontmatter.opportunityId === "string"
        ? note.frontmatter.opportunityId
        : typeof note.frontmatter.guid === "string"
          ? note.frontmatter.guid
          : typeof note.frontmatter.opportunityid === "string"
            ? note.frontmatter.opportunityid
            : undefined,
      status: typeof note.frontmatter.status === "string"
        ? note.frontmatter.status
        : undefined,
      stage: typeof note.frontmatter.stage === "string"
        ? note.frontmatter.stage
        : undefined,
      owner: typeof note.frontmatter.owner === "string"
        ? note.frontmatter.owner
        : undefined,
      salesplay: typeof note.frontmatter.salesplay === "string"
        ? note.frontmatter.salesplay
        : undefined,
      last_validated: typeof note.frontmatter.last_validated === "string"
        ? note.frontmatter.last_validated
        : undefined,
    }));
  }

  // Fallback: parse from customer file section
  const customerPath = await resolveCustomerPath(vaultPath, config, customer);
  try {
    const parsed = await readNote(vaultPath, customerPath);
    return parseOpportunities(parsed.sections.get("Opportunities") ?? "");
  } catch {
    return [];
  }
}

/**
 * Read milestone entity notes from the customer's milestones/ subdirectory.
 * Falls back to section parsing from the customer file if no sub-notes exist.
 */
export async function readMilestoneNotes(
  vaultPath: string,
  config: OilConfig,
  customer: string,
): Promise<MilestoneRef[]> {
  const entityNotes = await listCustomerEntities(
    vaultPath, config, customer, "milestones",
  );

  if (entityNotes.length > 0) {
    return entityNotes.map((note) => ({
      name: resolveEntityName(note, config),
      id: typeof note.frontmatter.milestoneId === "string"
        ? note.frontmatter.milestoneId
        : typeof note.frontmatter.milestoneid === "string"
          ? note.frontmatter.milestoneid
          : typeof note.frontmatter.id === "string"
            ? note.frontmatter.id
            : undefined,
      number: typeof note.frontmatter.milestoneNumber === "string"
        ? note.frontmatter.milestoneNumber
        : typeof note.frontmatter.number === "string"
          ? note.frontmatter.number
          : typeof note.frontmatter.milestone_number === "string"
            ? note.frontmatter.milestone_number
            : undefined,
      status: typeof note.frontmatter.status === "string"
        ? note.frontmatter.status
        : undefined,
      milestonedate: typeof note.frontmatter.milestoneDate === "string"
        ? note.frontmatter.milestoneDate
        : typeof note.frontmatter.milestonedate === "string"
          ? note.frontmatter.milestonedate
          : undefined,
      owner: typeof note.frontmatter.owner === "string"
        ? note.frontmatter.owner
        : undefined,
      opportunity: typeof note.frontmatter.opportunity === "string"
        ? note.frontmatter.opportunity
        : undefined,
    }));
  }

  // Fallback: parse from customer file section
  const customerPath = await resolveCustomerPath(vaultPath, config, customer);
  try {
    const parsed = await readNote(vaultPath, customerPath);
    return parseMilestones(parsed.sections.get("Milestones") ?? "");
  } catch {
    return [];
  }
}

/**
 * List all customer folders/files in the customers root.
 * Supports both nested (directories) and flat (.md files) layouts.
 * Returns customer names (not paths).
 */
export async function listCustomerNames(
  vaultPath: string,
  config: OilConfig,
): Promise<string[]> {
  const fullPath = securePath(vaultPath, config.schema.customersRoot);
  let entries;
  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: Set<string> = new Set();
  for (const entry of entries) {
    if (entry.isDirectory() && !isExcludedDir(entry.name)) {
      // Nested layout: directory name is customer name
      names.add(entry.name);
    } else if (entry.isFile() && isAllowedFile(entry.name)) {
      // Flat layout: filename minus extension
      names.add(basename(entry.name, extname(entry.name)));
    }
  }
  return [...names];
}

/**
 * Detect customers using flat layout (Customers/X.md) that should use nested
 * layout (Customers/X/X.md). Returns only customers where a flat file exists
 * WITHOUT a corresponding nested directory.
 */
export async function detectFlatCustomers(
  vaultPath: string,
  config: OilConfig,
): Promise<{ customer: string; currentPath: string; expectedPath: string }[]> {
  const fullPath = securePath(vaultPath, config.schema.customersRoot);
  let entries;
  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = new Set<string>();
  const flatFiles: { name: string; ext: string }[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && !isExcludedDir(entry.name)) {
      dirs.add(entry.name);
    } else if (entry.isFile() && isAllowedFile(entry.name)) {
      flatFiles.push({
        name: basename(entry.name, extname(entry.name)),
        ext: extname(entry.name),
      });
    }
  }

  const results: { customer: string; currentPath: string; expectedPath: string }[] = [];
  for (const file of flatFiles) {
    // Only flag if there is NO nested directory for this customer
    if (!dirs.has(file.name)) {
      results.push({
        customer: file.name,
        currentPath: `${config.schema.customersRoot}${file.name}${file.ext}`,
        expectedPath: `${config.schema.customersRoot}${file.name}/${file.name}${file.ext}`,
      });
    }
  }
  return results;
}

// ─── Partitioned Insights ─────────────────────────────────────────────────────

/**
 * Read Agent Insights from per-quarter sub-notes (e.g. insights/2026-Q1.md)
 * instead of a monolithic section. Returns current + previous quarters.
 * Falls back to empty when no partitioned sub-notes exist (caller should
 * parse the monolithic section as before).
 */
export async function readInsightsPartitioned(
  vaultPath: string,
  config: OilConfig,
  customer: string,
  quarters: number = 2,
): Promise<{ partitioned: boolean; entries: string[]; files: string[] }> {
  const insightsDir = `${config.schema.customersRoot}${customer}/${config.schema.insightsSubdir}`;

  let insightFiles: string[];
  try {
    insightFiles = await listFolder(vaultPath, insightsDir);
  } catch {
    insightFiles = [];
  }

  if (insightFiles.length > 0) {
    // Sort descending by filename (YYYY-QN.md sorts correctly)
    insightFiles.sort((a, b) => b.localeCompare(a));
    const recent = insightFiles.slice(0, quarters);

    const entries: string[] = [];
    for (const file of recent) {
      try {
        const parsed = await readNote(vaultPath, file);
        const lines = splitLines(parsed.content)
          .filter((l) => l.trim())
          .map((l) => l.replace(/^[-*]\s+/, "").trim());
        entries.push(...lines);
      } catch {
        continue;
      }
    }

    return { partitioned: true, entries, files: recent };
  }

  // No partitioned sub-notes — caller should fall back to monolithic section
  return { partitioned: false, entries: [], files: [] };
}

// ─── Frontmatter-Indexed Meeting Lookup ───────────────────────────────────────

/**
 * Read recent meetings for a customer using the `recent_meetings` frontmatter
 * field in the customer file. O(1) lookup instead of full graph scan.
 *
 * Returns null if the field doesn't exist (caller should fall back to graph scan).
 *
 * Expected frontmatter format:
 *   recent_meetings:
 *     - path: Meetings/2026-03-15-Contoso-QBR.md
 *       date: "2026-03-15"
 *     - path: Meetings/2026-03-01-Contoso-Review.md
 *       date: "2026-03-01"
 */
export function readMeetingsFromFrontmatter(
  frontmatter: Record<string, unknown>,
  lookbackDays: number,
): NoteRef[] | null {
  const meetingsList = frontmatter.recent_meetings;
  if (!Array.isArray(meetingsList) || meetingsList.length === 0) return null;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const refs: NoteRef[] = [];
  for (const entry of meetingsList) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const path = typeof rec.path === "string" ? rec.path : null;
    if (!path) continue;

    // Filter by date — skip entries without a valid date (avoids immortal entries)
    const dateStr = typeof rec.date === "string" ? rec.date : null;
    if (!dateStr) continue;
    const meetingDate = new Date(dateStr);
    if (isNaN(meetingDate.getTime()) || meetingDate < cutoff) continue;

    const title = typeof rec.title === "string"
      ? rec.title
      : basename(path, extname(path));

    refs.push({ path, title, tags: [] });
  }

  // Return null (not empty array) when no entries survive filtering,
  // so the caller's `?? fallback` graph scan still triggers.
  return refs.length > 0 ? refs : null;
}
