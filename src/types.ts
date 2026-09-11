/**
 * OIL — Shared type definitions
 * Core types used across the intelligence layer.
 */

// ─── Vault Schema Types ──────────────────────────────────────────────────────

export interface NoteRef {
  path: string;
  title: string;
  tags: string[];
  excerpt?: string;
  ref?: string;
  version?: number;
}

/** A NoteRef reached by graph traversal, carrying distance and link direction. */
export interface RelatedNoteRef extends NoteRef {
  hops: number;
  via: "out" | "in" | "both";
}

export interface NoteFrontmatter {
  [key: string]: unknown;
}

export interface CustomerFrontmatter extends NoteFrontmatter {
  tags?: string[];
  tpid?: string;
  accountid?: string;
}

export interface PersonFrontmatter extends NoteFrontmatter {
  tags?: string[];
  company?: string;
  org?: "internal" | "customer" | "partner";
  customers?: string[];
  email?: string;
  teams_id?: string;
}

export interface MeetingFrontmatter extends NoteFrontmatter {
  tags?: string[];
  date?: string;
  customer?: string;
  project?: string;
  status?: string;
  action_owners?: string[];
}

// ─── Graph Types ──────────────────────────────────────────────────────────────

export interface GraphNode {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
  bodySnippet: string; // first N chars of body (frontmatter-stripped) for search
  frontmatter: NoteFrontmatter;
  outLinks: Set<string>; // paths this note links to
  inLinks: Set<string>; // paths that link to this note
}

export interface GraphStats {
  noteCount: number;
  linkCount: number;
  tagCount: number;
  topTags: TagCount[];
  mostLinkedNotes: NoteRef[];
}

export interface TagCount {
  tag: string;
  count: number;
}

// ─── Entity Types ─────────────────────────────────────────────────────────────

export interface OpportunityRef {
  name: string;
  guid?: string;
  status?: string;
  stage?: string;
  owner?: string;
  salesplay?: string;
  last_validated?: string;
}

export interface MilestoneRef {
  name: string;
  id?: string;
  number?: string;
  status?: string;
  milestonedate?: string;
  owner?: string;
  opportunity?: string;
}

export interface TeamMember {
  name: string;
  role?: string;
}

export interface ActionItem {
  text: string;
  source: string; // note path
  assignee?: string;
  done: boolean;
}

// ─── Customer Context ─────────────────────────────────────────────────────────

export interface CustomerContext {
  frontmatter: CustomerFrontmatter;
  opportunities: OpportunityRef[];
  milestones: MilestoneRef[];
  team: TeamMember[];
  agentInsights: string[];
  connectHooks: string | null;
  linkedPeople: NoteRef[];
  recentMeetings: NoteRef[];
  openItems: ActionItem[];
  similarCustomers: NoteRef[];
}

// ─── Search Types ─────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  /** Query terms this note actually matched. Empty for non-lexical tiers. */
  matchedTerms: string[];
  matchType: "lexical" | "fuzzy" | "semantic";
}

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface OilConfig {
  schema: SchemaConfig;
  frontmatterSchema: FrontmatterSchemaConfig;
  search: SearchConfig;
  semantic: SemanticConfig;
  audit: AuditConfig;
  /** Which layer supplied each overridable value. */
  provenance: ConfigProvenance;
}

/**
 * The configuration layer a value came from.
 *
 * Settings arrive from four places — flags beat environment variables, which
 * beat `oil.config.yaml`, which beats the built-in defaults — and once merged
 * the winner is indistinguishable from the losers. That matters when the server
 * has to explain itself: telling someone the semantic tier was "disabled in
 * oil.config.yaml" when they passed `--no-semantic` points them at a file that
 * may not exist.
 */
export type ConfigSource = "default" | "oil.config.yaml" | "environment" | "flag";

/** Where each overridable semantic setting came from. */
export interface SemanticProvenance {
  enabled: ConfigSource;
  endpoint: ConfigSource;
  model: ConfigSource;
  minScore: ConfigSource;
}

export interface ConfigProvenance {
  semantic: SemanticProvenance;
}

export interface SchemaConfig {
  customersRoot: string;
  peopleRoot: string;
  meetingsRoot: string;
  projectsRoot: string;
  weeklyRoot: string;
  templatesRoot: string;
  agentLog: string;
  connectHooksBackup: string;
  opportunitiesSubdir: string;
  milestonesSubdir: string;
  insightsSubdir: string;
}

export interface FrontmatterSchemaConfig {
  customerField: string;
  tagsField: string;
  dateField: string;
  statusField: string;
  projectField: string;
  tpidField: string;
  accountidField: string;
  titleField: string;
}

export interface SearchConfig {
  graphIndexFile: string;
  backgroundIndexThresholdMs: number;
  /** Folder prefixes kept out of search results, e.g. templates or agent logs. */
  excludeFolders: string[];
}

/** Local-embedding tier. Every field has a working default; none is required. */
export interface SemanticConfig {
  /** Off disables the tier outright; on still degrades quietly without Ollama. */
  enabled: boolean;
  /** Ollama base URL. Loopback by default — nothing leaves the machine. */
  endpoint: string;
  model: string;
  /** Vector sidecar, relative to the vault root. */
  indexFile: string;
  /** Cosine floor below which a note is treated as unrelated. */
  minScore: number;
  batchSize: number;
  /** Per-input request budget; a batch gets this multiplied by its size. */
  timeoutMs: number;
}

export interface AuditConfig {
  logAllWrites: boolean;
}

// ─── Phase 3: Cross-MCP & Hygiene Types ───────────────────────────────────────

/** CRM-ready ID bundle extracted from vault customer files. */
export interface PrefetchIds {
  customer: string;
  tpid?: string;
  accountid?: string;
  opportunityGuids: string[];
  milestoneIds: string[];
  milestoneNumbers: string[];
  teamMembers: TeamMember[];
}

/** Freshness report for a single customer's vault data. */
export interface CustomerFreshness {
  customer: string;
  path: string;
  lastModified: Date | null;
  lastValidated: string | null;
  staleInsights: StaleEntry[];
  opportunityCompleteness: {
    total: number;
    withGuid: number;
    missingGuid: string[];
  };
  milestoneCompleteness: {
    total: number;
    withId: number;
    missingId: string[];
  };
  hasTeam: boolean;
  hasConnectHooks: boolean;
}

/** An Agent Insights entry that exceeds the staleness threshold. */
export interface StaleEntry {
  text: string;
  date: string;
  ageDays: number;
}

/** A structural layout issue detected in the vault. */
export interface StructuralIssue {
  type: "flat-customer" | "misplaced-entity";
  currentPath: string;
  expectedPath: string;
  customer: string;
  detail: string;
}

/** Vault-level health summary. */
export interface VaultHealthReport {
  totalCustomers: number;
  customers: CustomerFreshness[];
  orphanedMeetings: string[];
  rosterGaps: string[];
  structuralIssues: StructuralIssue[];
}
