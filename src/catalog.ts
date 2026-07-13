import { createHash } from "node:crypto";
import { basename, dirname, extname, posix } from "node:path";
import matter from "gray-matter";
import { parseDocument } from "yaml";
import type {
  CatalogWarning,
  ContentChunk,
  FrontmatterIndexEntry,
  FrontmatterValueKind,
  GraphNode,
  OilConfig,
  ReadinessFacet,
  RelationshipEdge,
} from "./types.js";

export const CATALOG_FORMAT_VERSION = 3;
export const EXTRACTOR_VERSION = "knc-1";
export const BODY_PREVIEW_CHARS = 10_000;

export interface ParsedCatalogNode {
  node: GraphNode;
  rawLinks: RelationshipEdge[];
}

export interface SourceFingerprint {
  mtimeMs: number;
  size: number;
}

/** Parse one source note into the compatibility-first canonical catalog shape. */
export function parseCatalogNode(
  notePath: string,
  raw: string,
  fingerprint: SourceFingerprint,
  config: OilConfig,
): ParsedCatalogNode {
  const normalizedPath = normalizeVaultPath(notePath);
  let frontmatter: Record<string, unknown> = {};
  let content = raw;
  let frontmatterParsed = true;
  const warningDetails: CatalogWarning[] = [];

  try {
    const frontmatterSource = extractFrontmatterSource(raw);
    if (frontmatterSource !== null) {
      const document = parseDocument(frontmatterSource, { prettyErrors: true });
      if (document.errors.length > 0) throw document.errors[0];
      const parsedData = document.toJS();
      if (parsedData && typeof parsedData === "object" && !Array.isArray(parsedData)) {
        frontmatter = parsedData as Record<string, unknown>;
      }
    }
    const parsed = matter(raw);
    if (frontmatterSource === null) frontmatter = parsed.data as Record<string, unknown>;
    content = parsed.content;
  } catch (error) {
    frontmatterParsed = false;
    content = recoverBodyAfterMalformedFrontmatter(raw);
    warningDetails.push({
      code: "FRONTMATTER_PARSE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const titleValue = getFrontmatterValue(frontmatter, [
    config.frontmatterSchema.titleField,
    "title",
  ]);
  const headingTitle = firstHeading(content, 1);
  const title = scalarString(titleValue) ?? headingTitle ?? basename(normalizedPath, extname(normalizedPath));
  const titleSource = scalarString(titleValue)
    ? "frontmatter" as const
    : headingTitle
      ? "heading" as const
      : "filename" as const;

  const descriptionValue = getFrontmatterValue(frontmatter, [
    config.frontmatterSchema.descriptionField,
    "description",
    "summary",
  ]);
  const authoredDescription = scalarString(descriptionValue);
  const derivedDescription = firstMeaningfulParagraph(content);
  const description = authoredDescription ?? derivedDescription ?? "";
  const descriptionSource = authoredDescription
    ? "frontmatter" as const
    : derivedDescription
      ? "derived" as const
      : "empty" as const;
  if (!authoredDescription && derivedDescription) {
    warningDetails.push({
      code: "DERIVED_DESCRIPTION",
      message: "Description was derived from the first meaningful paragraph.",
    });
  }

  const typeValue = getFrontmatterValue(frontmatter, [
    config.frontmatterSchema.typeField,
    "type",
    "kind",
  ]);
  const authoredType = scalarString(typeValue);
  const inferredType = inferTypeFromFolder(normalizedPath, config);
  const type = authoredType ?? inferredType ?? "note";
  const typeSource = authoredType
    ? "frontmatter" as const
    : inferredType
      ? "inferred_folder" as const
      : "default" as const;
  if (!authoredType) {
    warningDetails.push({
      code: "DERIVED_TYPE",
      message: inferredType
        ? `Type was inferred from the ${normalizedPath.split("/")[0]} folder.`
        : "Type defaulted to note.",
    });
  }

  const aliases = normalizeStringList(getFrontmatterValue(frontmatter, ["aliases", "alias"]));
  const explicitId = scalarString(getFrontmatterValue(frontmatter, [
    config.frontmatterSchema.idField,
    "id",
    "uid",
    "uuid",
  ]));
  const tags = extractTags(frontmatter, content, config.frontmatterSchema.tagsField);
  const headings = extractHeadings(content);
  const chunks = chunkMarkdown(content);
  const rawLinks = extractInternalLinks(normalizedPath, content);
  const readiness: ReadinessFacet[] = ["indexed"];
  if (frontmatterParsed) readiness.push("structured");
  if (description) readiness.push("described");
  if (inferredType) readiness.push("profiled");

  const node: GraphNode = {
    path: normalizedPath,
    nodeId: normalizedPath.replace(/\.(?:md|markdown|txt)$/i, ""),
    title,
    titleSource,
    description,
    descriptionSource,
    type,
    typeSource,
    aliases,
    ...(explicitId ? { explicitId } : {}),
    tags,
    headings,
    bodySnippet: content.slice(0, BODY_PREVIEW_CHARS),
    bodyText: content,
    chunks,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    frontmatter,
    outLinks: new Set<string>(),
    inLinks: new Set<string>(),
    links: [],
    warnings: warningDetails.map((warning) => warning.code),
    warningDetails,
    readiness,
    sourceMtimeMs: fingerprint.mtimeMs,
    sourceSize: fingerprint.size,
    contentHash: `sha256:${sha256(raw)}`,
    frontmatterParsed,
  };

  return { node, rawLinks };
}

/** Canonicalizes field names for lookup while preserving source keys elsewhere. */
export function normalizeFieldKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Flatten arbitrary frontmatter into queryable dotted paths. */
export function flattenFrontmatter(
  path: string,
  frontmatter: Record<string, unknown>,
  maxDepth = 4,
): FrontmatterIndexEntry[] {
  const entries: FrontmatterIndexEntry[] = [];

  const visit = (rawKey: string, value: unknown, depth: number): void => {
    entries.push({
      path,
      rawKey,
      key: rawKey.split(".").map(normalizeFieldKey).join("."),
      value,
      kind: frontmatterValueKind(value),
    });

    if (depth >= maxDepth || !value || Array.isArray(value) || typeof value !== "object") {
      return;
    }
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      visit(`${rawKey}.${childKey}`, childValue, depth + 1);
    }
  };

  for (const [key, value] of Object.entries(frontmatter)) {
    visit(key, value, 1);
  }
  return entries;
}

export function frontmatterValueKind(value: unknown): FrontmatterValueKind {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return "date";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return looksLikeIsoDate(value) ? "date" : "string";
  if (typeof value === "object") return "object";
  return "string";
}

export function searchableFrontmatterText(frontmatter: Record<string, unknown>): string {
  return flattenFrontmatter("", frontmatter)
    .flatMap((entry) => [entry.rawKey, ...scalarSearchValues(entry.value)])
    .join(" ");
}

export function scalarSearchValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(scalarSearchValues);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return [value.toISOString()];
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => [key, ...scalarSearchValues(child)]);
  }
  return [String(value)];
}

export function configFingerprint(config: OilConfig): string {
  const relevant = {
    schema: config.schema,
    frontmatterSchema: config.frontmatterSchema,
  };
  return `sha256:${sha256(stableStringify(relevant))}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function folderOf(path: string): string {
  const folder = posix.dirname(normalizeVaultPath(path));
  return folder === "." ? "/" : `${folder}/`;
}

function recoverBodyAfterMalformedFrontmatter(raw: string): string {
  if (!/^---\s*\r?\n/.test(raw)) return raw;
  const delimiter = /^---\s*$/gm;
  delimiter.exec(raw);
  const closing = delimiter.exec(raw);
  if (!closing) return raw;
  return raw.slice(closing.index + closing[0].length).replace(/^\r?\n/, "");
}

function extractFrontmatterSource(raw: string): string | null {
  if (!/^---\s*\r?\n/.test(raw)) return null;
  const delimiter = /^---\s*$/gm;
  const opening = delimiter.exec(raw);
  const closing = delimiter.exec(raw);
  if (!opening || !closing) return null;
  return raw.slice(opening.index + opening[0].length, closing.index).replace(/^\r?\n/, "");
}

function getFrontmatterValue(
  frontmatter: Record<string, unknown>,
  candidateKeys: string[],
): unknown {
  const byNormalized = new Map(
    Object.entries(frontmatter).map(([key, value]) => [normalizeFieldKey(key), value]),
  );
  for (const candidate of candidateKeys) {
    const value = byNormalized.get(normalizeFieldKey(candidate));
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(values.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function firstHeading(content: string, depth: number): string | undefined {
  const match = content.match(new RegExp(`^#{${depth}}\\s+(.+)$`, "m"));
  return match?.[1].trim();
}

function firstMeaningfulParagraph(content: string): string | undefined {
  const paragraphs = content.split(/\r?\n\s*\r?\n/);
  for (const paragraph of paragraphs) {
    const compact = paragraph.replace(/\s+/g, " ").trim();
    if (!compact) continue;
    if (/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|```|~~~|\|)/.test(compact)) continue;
    return compact.slice(0, 500);
  }
  return undefined;
}

function inferTypeFromFolder(path: string, config: OilConfig): string | undefined {
  const mappings: Array<[string, string]> = [
    [config.schema.customersRoot, "customer"],
    [config.schema.peopleRoot, "person"],
    [config.schema.meetingsRoot, "meeting"],
    [config.schema.projectsRoot, "project"],
    [config.schema.weeklyRoot, "weekly"],
  ];
  return mappings.find(([prefix]) => path.startsWith(prefix))?.[1];
}

function extractTags(
  frontmatter: Record<string, unknown>,
  content: string,
  configuredTagsField: string,
): string[] {
  const tags = new Set<string>();
  const value = getFrontmatterValue(frontmatter, [configuredTagsField, "tags"]);
  for (const tag of normalizeStringList(value)) tags.add(tag.replace(/^#/, ""));

  const inlineTagRegex = /(?:^|\s)#([a-zA-Z][\w-/]*)/g;
  let match: RegExpExecArray | null;
  while ((match = inlineTagRegex.exec(content)) !== null) tags.add(match[1]);
  return [...tags];
}

function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  const regex = /^#{2,6}\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) headings.push(match[1].trim());
  return headings;
}

/** Heading-aware full-body chunks. Response tools still expose only bounded snippets. */
export function chunkMarkdown(
  content: string,
  targetChars = 1_200,
  maxChars = 1_500,
  overlapChars = 120,
): ContentChunk[] {
  if (!content) return [];
  const boundaries: Array<{ start: number; heading?: string }> = [{ start: 0 }];
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingRegex.exec(content)) !== null) {
    if (headingMatch.index === 0) boundaries[0].heading = headingMatch[1].trim();
    else boundaries.push({ start: headingMatch.index, heading: headingMatch[1].trim() });
  }

  const chunks: ContentChunk[] = [];
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length; boundaryIndex++) {
    const boundary = boundaries[boundaryIndex];
    const sectionEnd = boundaries[boundaryIndex + 1]?.start ?? content.length;
    let start = boundary.start;

    while (start < sectionEnd) {
      const desiredEnd = Math.min(sectionEnd, start + targetChars);
      let end = desiredEnd;
      if (desiredEnd < sectionEnd) {
        const newline = content.lastIndexOf("\n", Math.min(sectionEnd, start + maxChars));
        if (newline > start + Math.floor(targetChars * 0.65)) end = newline + 1;
      }
      if (end <= start) end = Math.min(sectionEnd, start + maxChars);
      const text = content.slice(start, end);
      chunks.push({
        id: `chunk_${chunks.length}`,
        ...(boundary.heading ? { heading: boundary.heading } : {}),
        start,
        end,
        text,
      });
      if (end >= sectionEnd) break;
      start = Math.max(start + 1, end - overlapChars);
    }
  }
  return chunks;
}

function extractInternalLinks(sourcePath: string, content: string): RelationshipEdge[] {
  const links: RelationshipEdge[] = [];
  const wikiRegex = /\[\[([^\]]+)]]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiRegex.exec(content)) !== null) {
    const [targetPart, labelPart] = match[1].split("|", 2);
    const [target, heading] = targetPart.split("#", 2);
    links.push({
      source: sourcePath,
      target: target.trim(),
      syntax: "wikilink",
      ...(labelPart?.trim() ? { label: labelPart.trim() } : {}),
      ...(heading?.trim() ? { heading: heading.trim() } : {}),
      status: "broken",
      context: linkContext(content, match.index, match[0].length),
    });
  }

  const markdownRegex = /(!?)\[([^\]]*)]\(([^)]+)\)/g;
  while ((match = markdownRegex.exec(content)) !== null) {
    if (match[1] === "!") continue;
    const rawDestination = match[3].trim().replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(rawDestination)) continue;
    let decoded = rawDestination;
    try { decoded = decodeURIComponent(rawDestination); } catch {}
    const hashIndex = decoded.indexOf("#");
    const target = hashIndex >= 0 ? decoded.slice(0, hashIndex) : decoded;
    const heading = hashIndex >= 0 ? decoded.slice(hashIndex + 1) : undefined;
    links.push({
      source: sourcePath,
      target: target || sourcePath,
      syntax: "markdown",
      ...(match[2].trim() ? { label: match[2].trim() } : {}),
      ...(heading?.trim() ? { heading: heading.trim() } : {}),
      status: "broken",
      context: linkContext(content, match.index, match[0].length),
    });
  }

  return links;
}

function linkContext(content: string, start: number, length: number): string {
  return content
    .slice(Math.max(0, start - 60), Math.min(content.length, start + length + 60))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?$/.test(value.trim())
    && !Number.isNaN(Date.parse(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Returns possible exact/relative paths for a raw internal link target. */
export function linkPathCandidates(sourcePath: string, target: string): string[] {
  const normalizedTarget = normalizeVaultPath(target);
  const candidates = new Set<string>();
  const addWithExtensions = (candidate: string): void => {
    const clean = normalizeVaultPath(posix.normalize(candidate));
    if (!clean || clean.startsWith("../")) return;
    if (/\.(?:md|markdown|txt)$/i.test(clean)) candidates.add(clean);
    else {
      candidates.add(clean);
      candidates.add(`${clean}.md`);
      candidates.add(`${clean}.markdown`);
      candidates.add(`${clean}.txt`);
    }
  };

  addWithExtensions(normalizedTarget);
  addWithExtensions(posix.join(dirname(sourcePath).replace(/\\/g, "/"), normalizedTarget));
  return [...candidates];
}
