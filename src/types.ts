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

// ─── Person Context ───────────────────────────────────────────────────────────

export interface PersonContext {
  frontmatter: PersonFrontmatter;
  email?: string;
  teamsId?: string;
  linkedCustomers: string[];
  recentMeetings: NoteRef[];
  backlinks: NoteRef[];
}

// ─── People Resolution ────────────────────────────────────────────────────────

export interface PersonResolution {
  customers: string[];
  company: string;
  org: "internal" | "customer" | "partner";
  confidence: "exact" | "fuzzy" | "unresolved";
}

export interface PeopleResolutionResult {
  resolved: Record<string, PersonResolution>;
  unresolved: string[];
}

// ─── Vault Context ────────────────────────────────────────────────────────────

export interface FolderTree {
  name: string;
  children: FolderTree[];
  noteCount: number;
}

export interface VaultContext {
  folderStructure: FolderTree;
  noteCount: number;
  topTags: TagCount[];
  mostLinkedNotes: NoteRef[];
  schemaVersion: string;
  lastIndexed: Date;
}

// ─── Session Cache Types ──────────────────────────────────────────────────────

export interface PendingWrite {
  id: string;
  operation: string;
  path: string;
  diff: string;
  createdAt: Date;
}

// ─── Search Types ─────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  matchType: "lexical" | "fuzzy" | "semantic";
}

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface OilConfig {
  schema: SchemaConfig;
  frontmatterSchema: FrontmatterSchemaConfig;
  search: SearchConfig;
  writeGate: WriteGateConfig;
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
}

export interface SearchConfig {
  defaultTier: "lexical" | "fuzzy" | "semantic";
  semanticModel: "local" | "openai" | "azure-openai";
  semanticIndexFile: string;
  graphIndexFile: string;
  backgroundIndexThresholdMs: number;
}

export interface WriteGateConfig {
  diffFormat: "markdown" | "json";
  logAllWrites: boolean;
  batchDiffMaxNotes: number;
  autoConfirmedSections: string[];
  autoConfirmedOperations: string[];
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

/** Entity reference from an external system (CRM, M365, WorkIQ). */
export interface ExternalEntity {
  name: string;
  type: "person" | "customer" | "meeting" | "opportunity" | "other";
  date?: string;
}

/** Result of correlating an external entity with vault notes. */
export interface CorrelationMatch {
  entity: ExternalEntity;
  matchedNotes: NoteRef[];
  customerAssociations: string[];
  confidence: "exact" | "fuzzy" | "unresolved";
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

/** Vault-side data for drift comparison against live CRM state. */
export interface DriftSnapshot {
  customer: string;
  opportunities: OpportunityRef[];
  milestones: MilestoneRef[];
  team: TeamMember[];
  lastAgentInsightDate: string | null;
  frontmatter: NoteFrontmatter;
}
