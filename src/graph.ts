import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type {
  CatalogIndexState,
  CatalogIssue,
  CatalogWarningCode,
  FrontmatterIndexEntry,
  GraphNode,
  GraphStats,
  NoteRef,
  ObservedFieldSchema,
  OilConfig,
  RelationshipEdge,
  TagCount,
} from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import {
  CATALOG_FORMAT_VERSION,
  EXTRACTOR_VERSION,
  chunkMarkdown,
  configFingerprint,
  flattenFrontmatter,
  folderOf,
  linkPathCandidates,
  normalizeFieldKey,
  normalizeVaultPath,
  parseCatalogNode,
  sha256,
} from "./catalog.js";
import { listAllNotes } from "./vault.js";

interface PersistedCatalogNode {
  path: string;
  nodeId: string;
  title: string;
  titleSource: GraphNode["titleSource"];
  description: string;
  descriptionSource: GraphNode["descriptionSource"];
  type: string;
  typeSource: GraphNode["typeSource"];
  aliases: string[];
  explicitId?: string;
  tags: string[];
  headings: string[];
  bodySnippet: string;
  bodyText: string;
  wordCount: number;
  frontmatter: Record<string, unknown>;
  rawLinks: RelationshipEdge[];
  warnings: CatalogWarningCode[];
  warningDetails: GraphNode["warningDetails"];
  readiness: GraphNode["readiness"];
  sourceMtimeMs: number;
  sourceSize: number;
  contentHash: string;
  frontmatterParsed: boolean;
}

interface PersistedCatalog {
  version: 3;
  builtAt: string;
  generation: string;
  extractionProfile: {
    extractorVersion: string;
    configFingerprint: string;
  };
  issues: CatalogIssue[];
  nodes: PersistedCatalogNode[];
}

interface CatalogSnapshot {
  nodes: Map<string, GraphNode>;
  tagIndex: Map<string, Set<string>>;
  titleIndex: Map<string, Set<string>>;
  rawLinks: Map<string, RelationshipEdge[]>;
  fileMtimes: Map<string, number>;
  frontmatterIndex: Map<string, FrontmatterIndexEntry[]>;
  observedSchema: Map<string, ObservedFieldSchema>;
  issues: CatalogIssue[];
  generation: string;
  builtAt: Date;
}

const EMPTY_GENERATION = "gen_empty";

export class GraphIndex {
  private snapshot: CatalogSnapshot = emptySnapshot();
  private readonly vaultPath: string;
  private readonly config: OilConfig;
  private _state: CatalogIndexState = "stale";
  private _building = false;
  private _persistedSnapshotValid = false;
  private _reconciledAt: Date | null = null;
  private generationSequence = 0;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(vaultPath: string, config: OilConfig = DEFAULT_CONFIG) {
    this.vaultPath = vaultPath;
    this.config = config;
  }

  get lastIndexed(): Date {
    return this.snapshot.builtAt;
  }

  get reconciledAt(): Date | null {
    return this._reconciledAt;
  }

  get nodeCount(): number {
    return this.snapshot.nodes.size;
  }

  get building(): boolean {
    return this._building;
  }

  get generation(): string {
    return this.snapshot.generation;
  }

  get indexState(): CatalogIndexState {
    return this._state;
  }

  get persistedSnapshotValid(): boolean {
    return this._persistedSnapshotValid;
  }

  get extractionProfile(): { extractorVersion: string; configFingerprint: string } {
    return {
      extractorVersion: EXTRACTOR_VERSION,
      configFingerprint: configFingerprint(this.config),
    };
  }

  async build(): Promise<void> {
    this._building = true;
    this._state = "reconciling";
    try {
      const notePaths = (await listAllNotes(this.vaultPath)).sort();
      const nodes = new Map<string, GraphNode>();
      const rawLinks = new Map<string, RelationshipEdge[]>();
      const issues: CatalogIssue[] = [];

      for (const notePath of notePaths) {
        await this.readSourceNode(notePath, nodes, rawLinks, issues);
      }

      this.publish(nodes, rawLinks, issues);
      this._persistedSnapshotValid = false;
      this._reconciledAt = new Date();
      this._state = "current";
    } catch (error) {
      this._state = "failed";
      throw error;
    } finally {
      this._building = false;
    }
  }

  async updateNote(notePath: string): Promise<void> {
    return this.withMutation(() => this.updateNoteUnlocked(notePath));
  }

  private async updateNoteUnlocked(notePath: string): Promise<void> {
    const normalizedPath = normalizeVaultPath(notePath);
    if (await this.isNoteCurrent(normalizedPath)) return;
    const previousState = this._state;
    this._building = true;
    this._state = "reconciling";
    try {
      const nodes = new Map(this.snapshot.nodes);
      const rawLinks = cloneRawLinks(this.snapshot.rawLinks);
      const issues = this.snapshot.issues.filter((issue) => issue.path !== normalizedPath);
      nodes.delete(normalizedPath);
      rawLinks.delete(normalizedPath);
      await this.readSourceNode(normalizedPath, nodes, rawLinks, issues);
      this.publish(nodes, rawLinks, issues);
      this._reconciledAt = new Date();
      this._state = previousState === "stale" ? "stale" : "current";
    } catch (error) {
      this._state = this.snapshot.nodes.size > 0 ? "stale" : "failed";
      throw error;
    } finally {
      this._building = false;
    }
  }

  /** Queue a deletion alongside note updates from writes and the watcher. */
  async deleteNote(notePath: string): Promise<void> {
    await this.withMutation(async () => {
      this.removeNote(notePath);
    });
  }

  /** True when the on-disk source already matches the published catalog node. */
  async isNoteCurrent(notePath: string): Promise<boolean> {
    const normalizedPath = normalizeVaultPath(notePath);
    const existing = this.snapshot.nodes.get(normalizedPath);
    if (!existing) return false;
    try {
      const fullPath = join(this.vaultPath, normalizedPath);
      const fileStats = await stat(fullPath);
      if (
        Math.abs(existing.sourceMtimeMs - fileStats.mtimeMs) > 1
        || existing.sourceSize !== fileStats.size
      ) return false;
      const raw = await readFile(fullPath, "utf-8");
      return existing.contentHash === `sha256:${sha256(raw)}`;
    } catch {
      return false;
    }
  }

  removeNote(notePath: string): void {
    const normalizedPath = normalizeVaultPath(notePath);
    if (!this.snapshot.nodes.has(normalizedPath)) return;
    const nodes = new Map(this.snapshot.nodes);
    const rawLinks = cloneRawLinks(this.snapshot.rawLinks);
    nodes.delete(normalizedPath);
    rawLinks.delete(normalizedPath);
    const issues = this.snapshot.issues.filter((issue) => issue.path !== normalizedPath);
    this.publish(nodes, rawLinks, issues);
    this._reconciledAt = new Date();
    if (this._state !== "stale") this._state = "current";
  }

  async saveToDisk(graphIndexFile: string): Promise<void> {
    const nodes: PersistedCatalogNode[] = [...this.snapshot.nodes.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node) => ({
        path: node.path,
        nodeId: node.nodeId,
        title: node.title,
        titleSource: node.titleSource,
        description: node.description,
        descriptionSource: node.descriptionSource,
        type: node.type,
        typeSource: node.typeSource,
        aliases: node.aliases,
        ...(node.explicitId ? { explicitId: node.explicitId } : {}),
        tags: node.tags,
        headings: node.headings,
        bodySnippet: node.bodySnippet,
        bodyText: node.bodyText,
        wordCount: node.wordCount,
        frontmatter: node.frontmatter,
        rawLinks: this.snapshot.rawLinks.get(node.path) ?? [],
        warnings: node.warnings,
        warningDetails: node.warningDetails,
        readiness: node.readiness,
        sourceMtimeMs: node.sourceMtimeMs,
        sourceSize: node.sourceSize,
        contentHash: node.contentHash,
        frontmatterParsed: node.frontmatterParsed,
      }));

    const data: PersistedCatalog = {
      version: CATALOG_FORMAT_VERSION,
      builtAt: this.snapshot.builtAt.toISOString(),
      generation: this.snapshot.generation,
      extractionProfile: this.extractionProfile,
      issues: this.snapshot.issues,
      nodes,
    };

    const fullPath = join(this.vaultPath, graphIndexFile);
    const tempPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, JSON.stringify(data), "utf-8");
    await rename(tempPath, fullPath);
    this._persistedSnapshotValid = true;
    console.error(`[OIL] Catalog snapshot saved: ${nodes.length} nodes.`);
  }

  async loadFromDisk(graphIndexFile: string): Promise<boolean> {
    try {
      const fullPath = join(this.vaultPath, graphIndexFile);
      const data = JSON.parse(await readFile(fullPath, "utf-8")) as Partial<PersistedCatalog>;
      const profile = this.extractionProfile;
      if (
        data.version !== CATALOG_FORMAT_VERSION
        || !data.extractionProfile
        || data.extractionProfile.extractorVersion !== profile.extractorVersion
        || data.extractionProfile.configFingerprint !== profile.configFingerprint
        || !Array.isArray(data.nodes)
      ) {
        this._persistedSnapshotValid = false;
        return false;
      }

      const nodes = new Map<string, GraphNode>();
      const rawLinks = new Map<string, RelationshipEdge[]>();
      for (const persisted of data.nodes) {
        if (!isPersistedNode(persisted)) {
          this._persistedSnapshotValid = false;
          return false;
        }
        const node: GraphNode = {
          path: persisted.path,
          nodeId: persisted.nodeId,
          title: persisted.title,
          titleSource: persisted.titleSource,
          description: persisted.description,
          descriptionSource: persisted.descriptionSource,
          type: persisted.type,
          typeSource: persisted.typeSource,
          aliases: persisted.aliases ?? [],
          ...(persisted.explicitId ? { explicitId: persisted.explicitId } : {}),
          tags: persisted.tags,
          headings: persisted.headings ?? [],
          bodySnippet: persisted.bodySnippet ?? persisted.bodyText.slice(0, 10_000),
          bodyText: persisted.bodyText,
          chunks: chunkMarkdown(persisted.bodyText),
          wordCount: persisted.wordCount,
          frontmatter: persisted.frontmatter,
          outLinks: new Set<string>(),
          inLinks: new Set<string>(),
          links: [],
          warnings: persisted.warnings ?? [],
          warningDetails: persisted.warningDetails ?? [],
          readiness: persisted.readiness ?? ["indexed"],
          sourceMtimeMs: persisted.sourceMtimeMs,
          sourceSize: persisted.sourceSize,
          contentHash: persisted.contentHash,
          frontmatterParsed: persisted.frontmatterParsed,
        };
        nodes.set(node.path, node);
        rawLinks.set(node.path, persisted.rawLinks ?? []);
      }

      this.publish(
        nodes,
        rawLinks,
        data.issues ?? [],
        data.generation ?? this.nextGeneration(),
        data.builtAt ? new Date(data.builtAt) : new Date(),
      );
      this._persistedSnapshotValid = true;
      this._state = "reconciling";
      console.error(`[OIL] Catalog snapshot loaded: ${nodes.size} nodes; reconciliation required.`);
      return true;
    } catch {
      this._persistedSnapshotValid = false;
      return false;
    }
  }

  async buildIncremental(graphIndexFile: string): Promise<number> {
    this._building = true;
    this._state = "reconciling";
    try {
      if (this.snapshot.nodes.size === 0) {
        const loaded = await this.loadFromDisk(graphIndexFile);
        if (!loaded) {
          await this.build();
          await this.saveToDisk(graphIndexFile);
          return this.nodeCount;
        }
      }

      const vaultNotes = new Set((await listAllNotes(this.vaultPath)).map(normalizeVaultPath));
      const nodes = new Map(this.snapshot.nodes);
      const rawLinks = cloneRawLinks(this.snapshot.rawLinks);
      const issues = [...this.snapshot.issues];
      let reindexed = 0;

      for (const path of [...nodes.keys()]) {
        if (!vaultNotes.has(path)) {
          nodes.delete(path);
          rawLinks.delete(path);
          reindexed++;
        }
      }

      for (const notePath of [...vaultNotes].sort()) {
        const fullPath = join(this.vaultPath, notePath);
        let fileStats;
        try {
          fileStats = await stat(fullPath);
        } catch {
          continue;
        }
        const existing = nodes.get(notePath);
        if (
          !existing
          || Math.abs(existing.sourceMtimeMs - fileStats.mtimeMs) > 1
          || existing.sourceSize !== fileStats.size
        ) {
          nodes.delete(notePath);
          rawLinks.delete(notePath);
          removeIssuesForPath(issues, notePath);
          await this.readSourceNode(notePath, nodes, rawLinks, issues, fileStats);
          reindexed++;
        }
      }

      if (reindexed > 0) {
        this.publish(nodes, rawLinks, issues);
        await this.saveToDisk(graphIndexFile);
      }
      this._reconciledAt = new Date();
      this._state = "current";
      console.error(`[OIL] Catalog reconciliation complete: ${reindexed} note(s) changed.`);
      return reindexed;
    } catch (error) {
      this._state = this.snapshot.nodes.size > 0 ? "stale" : "failed";
      throw error;
    } finally {
      this._building = false;
    }
  }

  getBacklinks(notePath: string): NoteRef[] {
    const node = this.snapshot.nodes.get(normalizeVaultPath(notePath));
    if (!node) return [];
    return [...node.inLinks].sort().map((path) => this.toNoteRef(path)).filter(isNoteRef);
  }

  getForwardLinks(notePath: string): NoteRef[] {
    const node = this.snapshot.nodes.get(normalizeVaultPath(notePath));
    if (!node) return [];
    return [...node.outLinks].sort().map((path) => this.toNoteRef(path)).filter(isNoteRef);
  }

  getRelatedNotes(
    notePath: string,
    hops = 2,
    filter?: { tags?: string[]; folder?: string; frontmatter?: Record<string, unknown> },
  ): NoteRef[] {
    const origin = normalizeVaultPath(notePath);
    const visited = new Set<string>([origin]);
    let frontier = new Set<string>([origin]);

    for (let hop = 0; hop < Math.max(0, hops); hop++) {
      const next = new Set<string>();
      for (const current of frontier) {
        const node = this.snapshot.nodes.get(current);
        if (!node) continue;
        for (const linked of [...node.outLinks, ...node.inLinks]) {
          if (!visited.has(linked)) {
            visited.add(linked);
            next.add(linked);
          }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }
    visited.delete(origin);

    let nodes = [...visited]
      .map((path) => this.snapshot.nodes.get(path))
      .filter((node): node is GraphNode => Boolean(node));
    if (filter?.tags?.length) {
      nodes = nodes.filter((node) => filter.tags!.some((tag) => node.tags.includes(tag)));
    }
    if (filter?.folder) nodes = nodes.filter((node) => node.path.startsWith(filter.folder!));
    if (filter?.frontmatter) {
      nodes = nodes.filter((node) => Object.entries(filter.frontmatter!).every(
        ([key, value]) => frontmatterEquals(node.frontmatter[key], value),
      ));
    }
    return nodes.sort((a, b) => a.path.localeCompare(b.path)).map((node) => this.toNoteRef(node.path)!);
  }

  getNotesByTag(tag: string): NoteRef[] {
    const paths = this.snapshot.tagIndex.get(tag);
    if (!paths) return [];
    return [...paths].sort().map((path) => this.toNoteRef(path)).filter(isNoteRef);
  }

  getNotesByFolder(folder: string): NoteRef[] {
    return [...this.snapshot.nodes.values()]
      .filter((node) => node.path.startsWith(folder))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node) => this.toNoteRef(node.path)!);
  }

  getNode(notePath: string): GraphNode | undefined {
    return this.snapshot.nodes.get(normalizeVaultPath(notePath));
  }

  resolveTitle(title: string): string | undefined {
    const candidates = this.resolveTitleCandidates(title);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  resolveTitleCandidates(title: string): string[] {
    return [...(this.snapshot.titleIndex.get(normalizeLookup(title)) ?? [])].sort();
  }

  getObservedSchema(): ObservedFieldSchema[] {
    return [...this.snapshot.observedSchema.values()]
      .map((entry) => ({ ...entry, variants: [...entry.variants], examples: [...entry.examples] }))
      .sort((a, b) => b.nodeCount - a.nodeCount || a.key.localeCompare(b.key));
  }

  resolveFrontmatterField(
    requestedKey: string,
    mode: "logical" | "raw" = "logical",
  ): { known: boolean; key: string; variants: string[]; aliases: string[] } {
    const requested = requestedKey.split(".").map(normalizeFieldKey).join(".");
    const logicalAliases = this.configuredFieldAliases();
    const resolved = mode === "logical" ? logicalAliases.get(requested) ?? requested : requested;
    const schema = this.snapshot.observedSchema.get(resolved);
    const configured = [...logicalAliases.values()].includes(resolved);
    return {
      known: Boolean(schema || configured),
      key: resolved,
      variants: schema?.variants ?? [],
      aliases: schema?.aliases ?? [],
    };
  }

  getFrontmatterEntries(key: string): FrontmatterIndexEntry[] {
    return [...(this.snapshot.frontmatterIndex.get(key) ?? [])];
  }

  suggestFrontmatterFields(requestedKey: string, limit = 5): ObservedFieldSchema[] {
    const requested = requestedKey.split(".").map(normalizeFieldKey).join(".");
    return this.getObservedSchema()
      .map((schema) => ({ schema, distance: levenshtein(requested, schema.key) }))
      .sort((a, b) => a.distance - b.distance || b.schema.nodeCount - a.schema.nodeCount)
      .slice(0, limit)
      .map(({ schema }) => schema);
  }

  getCatalogIssues(): CatalogIssue[] {
    return this.snapshot.issues.slice(0, 100);
  }

  getWarningCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const node of this.snapshot.nodes.values()) {
      for (const warning of new Set(node.warnings)) counts[warning] = (counts[warning] ?? 0) + 1;
    }
    for (const issue of this.snapshot.issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    return counts;
  }

  getUnresolvedLinks(notePath: string): RelationshipEdge[] {
    return (this.getNode(notePath)?.links ?? []).filter((edge) => edge.status !== "resolved");
  }

  getStats(): GraphStats {
    let linkCount = 0;
    for (const node of this.snapshot.nodes.values()) linkCount += node.outLinks.size;
    return {
      noteCount: this.snapshot.nodes.size,
      linkCount,
      tagCount: this.snapshot.tagIndex.size,
      topTags: this.getTopTags(20),
      mostLinkedNotes: this.getMostLinkedNotes(10),
    };
  }

  getTopTags(limit: number): TagCount[] {
    return [...this.snapshot.tagIndex.entries()]
      .map(([tag, paths]) => ({ tag, count: paths.size }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, limit);
  }

  getMostLinkedNotes(limit: number): NoteRef[] {
    return [...this.snapshot.nodes.values()]
      .sort((a, b) => b.inLinks.size - a.inLinks.size || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((node) => this.toNoteRef(node.path)!);
  }

  private async readSourceNode(
    notePath: string,
    nodes: Map<string, GraphNode>,
    rawLinks: Map<string, RelationshipEdge[]>,
    issues: CatalogIssue[],
    knownStats?: { mtimeMs: number; size: number },
  ): Promise<void> {
    const normalizedPath = normalizeVaultPath(notePath);
    try {
      const fullPath = join(this.vaultPath, normalizedPath);
      const [raw, fileStats] = await Promise.all([
        readFile(fullPath, "utf-8"),
        knownStats ? Promise.resolve(knownStats) : stat(fullPath),
      ]);
      const parsed = parseCatalogNode(normalizedPath, raw, {
        mtimeMs: fileStats.mtimeMs,
        size: fileStats.size,
      }, this.config);
      nodes.set(normalizedPath, parsed.node);
      rawLinks.set(normalizedPath, parsed.rawLinks);
      if (!parsed.node.frontmatterParsed) {
        issues.push({
          path: normalizedPath,
          code: "FRONTMATTER_PARSE_ERROR",
          message: parsed.node.warningDetails.find((warning) => warning.code === "FRONTMATTER_PARSE_ERROR")?.message
            ?? "Frontmatter could not be parsed.",
        });
      }
    } catch (error) {
      issues.push({
        path: normalizedPath,
        code: "UNREADABLE_FILE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publish(
    sourceNodes: Map<string, GraphNode>,
    rawLinks: Map<string, RelationshipEdge[]>,
    issues: CatalogIssue[],
    generation = this.nextGeneration(),
    builtAt = new Date(),
  ): void {
    const nodes = new Map<string, GraphNode>();
    for (const [path, source] of sourceNodes) nodes.set(path, cloneForDerivation(source));

    const titleIndex = buildTitleIndex(nodes);
    applyDuplicateIdWarnings(nodes);
    resolveRelationships(nodes, rawLinks, titleIndex);

    const tagIndex = new Map<string, Set<string>>();
    const frontmatterIndex = new Map<string, FrontmatterIndexEntry[]>();
    const observedSchema = buildObservedSchema(nodes, this.configuredFieldAliases());
    for (const node of nodes.values()) {
      for (const tag of node.tags) addToSetMap(tagIndex, tag, node.path);
      for (const entry of flattenFrontmatter(node.path, node.frontmatter)) {
        const bucket = frontmatterIndex.get(entry.key) ?? [];
        bucket.push(entry);
        frontmatterIndex.set(entry.key, bucket);
      }
    }
    for (const entries of frontmatterIndex.values()) entries.sort((a, b) => a.path.localeCompare(b.path));

    this.snapshot = {
      nodes,
      tagIndex,
      titleIndex,
      rawLinks: cloneRawLinks(rawLinks),
      fileMtimes: new Map([...nodes].map(([path, node]) => [path, node.sourceMtimeMs])),
      frontmatterIndex,
      observedSchema,
      issues: dedupeIssues(issues),
      generation,
      builtAt,
    };
  }

  private configuredFieldAliases(): Map<string, string> {
    const schema = this.config.frontmatterSchema;
    return new Map<string, string>([
      ["customer", normalizeFieldKey(schema.customerField)],
      ["tags", normalizeFieldKey(schema.tagsField)],
      ["date", normalizeFieldKey(schema.dateField)],
      ["status", normalizeFieldKey(schema.statusField)],
      ["project", normalizeFieldKey(schema.projectField)],
      ["tpid", normalizeFieldKey(schema.tpidField)],
      ["accountid", normalizeFieldKey(schema.accountidField)],
      ["title", normalizeFieldKey(schema.titleField)],
      ["description", normalizeFieldKey(schema.descriptionField)],
      ["type", normalizeFieldKey(schema.typeField)],
      ["timestamp", normalizeFieldKey(schema.timestampField)],
      ["id", normalizeFieldKey(schema.idField)],
    ]);
  }

  private nextGeneration(): string {
    this.generationSequence++;
    return `gen_${Date.now().toString(36)}_${this.generationSequence.toString(36)}`;
  }

  private async withMutation<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  private toNoteRef(path: string): NoteRef | null {
    const node = this.snapshot.nodes.get(path);
    if (!node) return null;
    return { path: node.path, title: node.title, tags: node.tags, ref: node.path };
  }
}

function emptySnapshot(): CatalogSnapshot {
  return {
    nodes: new Map(),
    tagIndex: new Map(),
    titleIndex: new Map(),
    rawLinks: new Map(),
    fileMtimes: new Map(),
    frontmatterIndex: new Map(),
    observedSchema: new Map(),
    issues: [],
    generation: EMPTY_GENERATION,
    builtAt: new Date(0),
  };
}

function cloneForDerivation(node: GraphNode): GraphNode {
  const warningDetails = node.warningDetails.filter(
    (warning) => !["AMBIGUOUS_LINK", "BROKEN_LINK", "DUPLICATE_ID"].includes(warning.code),
  );
  const warnings = warningDetails.map((warning) => warning.code);
  return {
    ...node,
    aliases: [...node.aliases],
    tags: [...node.tags],
    headings: [...node.headings],
    chunks: node.chunks.map((chunk) => ({ ...chunk })),
    frontmatter: { ...node.frontmatter },
    outLinks: new Set<string>(),
    inLinks: new Set<string>(),
    links: [],
    warnings,
    warningDetails,
    readiness: node.readiness.filter((facet) => facet !== "connected"),
  };
}

function cloneRawLinks(source: Map<string, RelationshipEdge[]>): Map<string, RelationshipEdge[]> {
  return new Map([...source].map(([path, edges]) => [
    path,
    edges.map((edge) => ({ ...edge, ...(edge.candidates ? { candidates: [...edge.candidates] } : {}) })),
  ]));
}

function buildTitleIndex(nodes: Map<string, GraphNode>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    const values = [
      node.title,
      basename(node.path, extname(node.path)),
      node.nodeId,
      ...node.aliases,
      ...(node.explicitId ? [node.explicitId] : []),
    ];
    for (const value of values) addToSetMap(index, normalizeLookup(value), node.path);
  }
  return index;
}

function applyDuplicateIdWarnings(nodes: Map<string, GraphNode>): void {
  const ids = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    if (!node.explicitId) continue;
    const bucket = ids.get(node.explicitId.toLowerCase()) ?? [];
    bucket.push(node);
    ids.set(node.explicitId.toLowerCase(), bucket);
  }
  for (const [id, bucket] of ids) {
    if (bucket.length < 2) continue;
    const candidates = bucket.map((node) => node.path).sort();
    for (const node of bucket) addWarning(node, {
      code: "DUPLICATE_ID",
      message: `Explicit ID ${id} is used by multiple notes.`,
      candidates,
    });
  }
}

function resolveRelationships(
  nodes: Map<string, GraphNode>,
  rawLinks: Map<string, RelationshipEdge[]>,
  titleIndex: Map<string, Set<string>>,
): void {
  for (const [sourcePath, node] of nodes) {
    const resolvedEdges: RelationshipEdge[] = [];
    for (const rawEdge of rawLinks.get(sourcePath) ?? []) {
      const edge = { ...rawEdge };
      const direct = linkPathCandidates(sourcePath, edge.target).find((candidate) => nodes.has(candidate));
      let candidates: string[] = [];
      if (direct) {
        candidates = [direct];
      } else {
        const targetLookup = normalizeLookup(basename(edge.target, extname(edge.target)));
        const global = [...(titleIndex.get(targetLookup) ?? [])].sort();
        const local = global.filter((candidate) => dirname(candidate) === dirname(sourcePath));
        candidates = local.length === 1 ? local : global;
      }

      if (candidates.length === 1) {
        edge.status = "resolved";
        edge.resolvedPath = candidates[0];
        node.outLinks.add(candidates[0]);
        nodes.get(candidates[0])?.inLinks.add(sourcePath);
      } else if (candidates.length > 1) {
        edge.status = "ambiguous";
        edge.candidates = candidates;
        addWarning(node, {
          code: "AMBIGUOUS_LINK",
          message: `Link target ${edge.target} resolves to multiple notes.`,
          target: edge.target,
          candidates,
        });
      } else {
        edge.status = "broken";
        addWarning(node, {
          code: "BROKEN_LINK",
          message: `Link target ${edge.target} could not be resolved.`,
          target: edge.target,
        });
      }
      resolvedEdges.push(edge);
    }
    node.links = resolvedEdges;
  }

  for (const node of nodes.values()) {
    if ((node.outLinks.size > 0 || node.inLinks.size > 0) && !node.readiness.includes("connected")) {
      node.readiness.push("connected");
    }
  }
}

function buildObservedSchema(
  nodes: Map<string, GraphNode>,
  configuredAliases: Map<string, string>,
): Map<string, ObservedFieldSchema> {
  interface Builder {
    variants: Set<string>;
    aliases: Set<string>;
    nodes: Set<string>;
    types: ObservedFieldSchema["types"];
    folders: Record<string, number>;
    examples: unknown[];
  }
  const builders = new Map<string, Builder>();
  for (const node of nodes.values()) {
    for (const entry of flattenFrontmatter(node.path, node.frontmatter)) {
      const builder = builders.get(entry.key) ?? {
        variants: new Set<string>(),
        aliases: new Set<string>(),
        nodes: new Set<string>(),
        types: {},
        folders: {},
        examples: [],
      };
      builder.variants.add(entry.rawKey);
      builder.nodes.add(node.path);
      builder.types[entry.kind] = (builder.types[entry.kind] ?? 0) + 1;
      const folder = folderOf(node.path);
      builder.folders[folder] = (builder.folders[folder] ?? 0) + 1;
      const example = boundedExample(entry.value);
      if (builder.examples.length < 5 && !builder.examples.some((value) => JSON.stringify(value) === JSON.stringify(example))) {
        builder.examples.push(example);
      }
      builders.set(entry.key, builder);
    }
  }

  for (const [alias, actual] of configuredAliases) {
    const builder = builders.get(actual);
    if (builder) builder.aliases.add(alias);
  }

  const schema = new Map<string, ObservedFieldSchema>();
  for (const [key, builder] of builders) {
    const warnings: CatalogWarningCode[] = [];
    if (builder.variants.size > 1) warnings.push("KEY_VARIANTS");
    if (Object.keys(builder.types).length > 1) warnings.push("MIXED_VALUE_TYPES");
    schema.set(key, {
      key,
      variants: [...builder.variants].sort(),
      aliases: [...builder.aliases].sort(),
      nodeCount: builder.nodes.size,
      coverage: nodes.size === 0 ? 0 : builder.nodes.size / nodes.size,
      types: builder.types,
      folders: Object.fromEntries(Object.entries(builder.folders).sort(([a], [b]) => a.localeCompare(b))),
      examples: builder.examples,
      warnings,
    });
  }
  return schema;
}

function addWarning(node: GraphNode, warning: GraphNode["warningDetails"][number]): void {
  node.warningDetails.push(warning);
  if (!node.warnings.includes(warning.code)) node.warnings.push(warning.code);
}

function boundedExample(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 120);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  const serialized = JSON.stringify(value);
  return serialized.length <= 120 ? value : `${serialized.slice(0, 117)}...`;
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = map.get(key) ?? new Set<string>();
  bucket.add(value);
  map.set(key, bucket);
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/");
}

function frontmatterEquals(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((value) => frontmatterEquals(value, expected));
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return actual === expected;
}

function isNoteRef(value: NoteRef | null): value is NoteRef {
  return value !== null;
}

function removeIssuesForPath(issues: CatalogIssue[], path: string): void {
  for (let index = issues.length - 1; index >= 0; index--) {
    if (issues[index].path === path) issues.splice(index, 1);
  }
}

function dedupeIssues(issues: CatalogIssue[]): CatalogIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function isPersistedNode(value: unknown): value is PersistedCatalogNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<PersistedCatalogNode>;
  return typeof node.path === "string"
    && typeof node.nodeId === "string"
    && typeof node.title === "string"
    && typeof node.bodyText === "string"
    && Array.isArray(node.tags)
    && Boolean(node.frontmatter && typeof node.frontmatter === "object")
    && Array.isArray(node.rawLinks)
    && typeof node.sourceMtimeMs === "number"
    && typeof node.sourceSize === "number";
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}
