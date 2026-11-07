import type {
  Issue,
  IssueKey,
  PlanWarning,
  ProviderKind,
  RelationCoverage,
  Snapshot,
} from './types.js';

/** One configured repository of one source. The source ID is case-sensitive. */
export interface ProjectRef {
  source: string;
  /** Canonical lowercase owner/repo. Dependency-only and release repositories are not projects. */
  repo: string;
}

export type Scope = ({ kind: 'project' } & ProjectRef) | { kind: 'source'; source: string };

/**
 * Canonical plan IDs: project:<source>/<owner>/<repo> and source:<source>.
 * Source IDs use the configuration ID grammar; owner/repo are lowercase. Colons are
 * forbidden in configured view IDs, so these namespaces cannot collide with views.
 * These are plan IDs, not URL paths: URI encoding belongs to the HTTP/hash router.
 */
export type ScopeId = `project:${string}/${string}/${string}` | `source:${string}`;

export interface SourcePolicyConflict {
  source: string;
  /** Resolved setting paths that disagree, such as dependencies.native. */
  differingSettings: string[];
  /** IDs of the named views involved. */
  views: string[];
  explanation: string;
}

export type SourcePolicyStatus =
  { status: 'usable' } | { status: 'conflict'; conflict: SourcePolicyConflict };

export interface CatalogSource {
  id: string;
  kind: ProviderKind;
  /** Distinct projects, sorted by canonical owner/repo, including empty repositories. */
  projects: ProjectRef[];
  policy: SourcePolicyStatus;
}

export interface CatalogResponse {
  /** In configuration order; separate source IDs retain separate project identities. */
  sources: CatalogSource[];
}

/** Timestamps in these contracts are ISO 8601 UTC strings, never computation ages. */
export interface ObservationAttempt {
  attemptedAt: string;
  outcome: 'success' | 'partial' | 'failed';
  error: string | null;
}

export interface ObservationMetadata {
  relationCoverage: RelationCoverage;
  /** Last successful observation of each relation kind; weaker reads retain its age. */
  relationsCheckedAt: { native: string | null; subIssues: string | null };
  /** Last successful upstream check, unchanged by failures or plan recomputation. */
  lastCheckedAt: string | null;
  /** Null until the first attempt. A failed attempt may coexist with last-good data. */
  lastAttempt: ObservationAttempt | null;
  /** Incremented by invalidation; a fetch from an older generation cannot restore freshness. */
  invalidationGeneration: number;
}

export interface RepositoryObservation extends ObservationMetadata {
  project: ProjectRef;
  /** Last-good open listing, or null before any successful listing. [] means verified empty. */
  issues: Issue[] | null;
  warnings: PlanWarning[];
}

export type OutsideIssueResult =
  | { status: 'found'; issue: Issue }
  | { status: 'missing' }
  | { status: 'unresolved'; error: string };

export interface OutsideIssueObservation extends ObservationMetadata {
  source: string;
  key: IssueKey;
  /** Last-good issue includes state, body and observed relations; null means no result yet. */
  result: OutsideIssueResult | null;
}

export type FreshnessState =
  'fresh' | 'stale' | 'updating' | 'invalidated' | 'delayed' | 'failed' | 'unavailable';

export interface RepositoryFreshness {
  project: ProjectRef;
  lastCheckedAt: string | null;
  state: FreshnessState;
  /** Partial coverage is distinct from the check's freshness state. */
  partial: boolean;
  error: string | null;
  delayedUntil: string | null;
}

export interface ScopeFreshness {
  /** Plan computation time; never substitutes for an upstream lastCheckedAt. */
  computedAt: string | null;
  repositories: RepositoryFreshness[];
  outsideIssues: {
    count: number;
    oldestObservedAt: string | null;
    provisionalCount: number;
  };
}

export type RefreshTrigger = 'interactive' | 'scheduled';
export type RefreshJobState = 'queued' | 'running' | 'completed' | 'partial' | 'failed';

export interface RefreshJobStatus {
  id: string;
  scope: Scope | { kind: 'all-sources' };
  trigger: RefreshTrigger;
  state: RefreshJobState;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  delayedUntil: string | null;
  error: string | null;
}

/** A scope refresh exposes both repository listings and targeted dependency reads. */
export type ScopeRefreshUnitStatus = (
  | { kind: 'repository'; project: ProjectRef }
  | { kind: 'outside-issue'; source: string; key: IssueKey }
) & {
  state: 'queued' | 'checking' | 'checked' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  /** The retained successful observation time, including when this attempt failed. */
  lastCheckedAt: string | null;
  partial: boolean;
  error: string | null;
};

/** Additive scope-job detail; generic consumers may keep using RefreshJobStatus. */
export interface ScopeRefreshJobStatus extends RefreshJobStatus {
  scope: Scope;
  priority: 'interactive' | 'sweep';
  units: ScopeRefreshUnitStatus[];
}

export interface ScopeResponse {
  scope: Scope;
  /** Same Snapshot contract. fetchedAt is the oldest contributing repository check. */
  snapshot: Snapshot | null;
  freshness: ScopeFreshness;
  job: RefreshJobStatus | null;
}

export interface SweepProjectStatus {
  project: ProjectRef;
  state: 'queued' | 'checking' | 'checked' | 'failed';
  lastCheckedAt: string | null;
  error: string | null;
}

export interface SweepSourceStatus {
  source: string;
  state: RefreshJobState | 'conflict' | 'delayed';
  delayedUntil: string | null;
  error: string | null;
  policyConflict: SourcePolicyConflict | null;
  projects: SweepProjectStatus[];
}

export interface SweepStatus {
  /** Present only when no upstream work can be served from cache. */
  skipReason?: 'caching-disabled';
  id: string;
  trigger: RefreshTrigger;
  state: RefreshJobState | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  sources: SweepSourceStatus[];
}
