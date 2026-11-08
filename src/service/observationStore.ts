import { makeKey, parseKey } from '../core/keys.js';
import type {
  CatalogResponse,
  ObservationMetadata,
  OutsideIssueObservation,
  OutsideIssueResult,
  ProjectRef,
  RepositoryObservation,
} from '../core/scope.js';
import type { FetchResult, Issue, IssueKey, RawRelation, RelationCoverage } from '../core/types.js';

export interface OutsideIssueRef {
  source: string;
  key: IssueKey;
}

/** A detached snapshot: callers cannot mutate the store without changing its version. */
export interface StoredObservation<T extends ObservationMetadata> {
  observation: T;
  /** Opaque change marker. Compare for equality, not for consecutive increments. */
  version: number;
  /** Only a successful read started in the current generation clears invalidation. */
  invalidated: boolean;
  /** Generation captured by the latest failed attempt; newer invalidation bypasses retry pacing. */
  failedGeneration: number | null;
}

interface ReadState {
  readonly version: number;
  readonly invalidationGeneration: number;
  readonly startedAt: string;
}

export interface RepositoryRead extends ReadState {
  readonly kind: 'repository';
  readonly project: Readonly<ProjectRef>;
}

export interface OutsideIssueRead extends ReadState {
  readonly kind: 'outside-issue';
  readonly source: string;
  readonly key: IssueKey;
}

export interface RepositoryReadResult extends FetchResult {
  /** Allows a caller to report other partial results, such as a capped read. */
  outcome?: 'success' | 'partial';
  error?: string | null;
}

export interface OutsideIssueReadResult {
  result: OutsideIssueResult;
  relationCoverage?: RelationCoverage;
  outcome?: 'success' | 'partial';
  error?: string | null;
}

type Read = RepositoryRead | OutsideIssueRead;
type Observation = RepositoryObservation | OutsideIssueObservation;
type RelationKind = keyof RelationCoverage;
type CompleteRelations = Record<RelationKind, Map<IssueKey, RawRelation[]> | null>;

interface Entry<T extends Observation> extends StoredObservation<T> {
  lastAcceptedRead: number;
  lastSuccessfulRead: number;
  completeRelations: CompleteRelations;
}

interface PendingRead {
  entry: Entry<Observation>;
  sequence: number;
  generation: number;
}

const relationKinds: RelationKind[] = ['native', 'subIssues'];
const relationSources = { native: 'native', subIssues: 'sub-issue' } as const;

function noCoverage(): RelationCoverage {
  return { native: 'not-requested', subIssues: 'not-requested' };
}

function metadata(): ObservationMetadata {
  return {
    relationCoverage: noCoverage(),
    relationsCheckedAt: { native: null, subIssues: null },
    lastCheckedAt: null,
    lastAttempt: null,
    invalidationGeneration: 0,
  };
}

function projectRef(project: ProjectRef): ProjectRef {
  return { source: project.source, repo: project.repo.toLowerCase() };
}

function outsideRef(ref: OutsideIssueRef): OutsideIssueRef {
  const { repo, number } = parseKey(ref.key);
  return { source: ref.source, key: makeKey(repo, number) };
}

function repositoryId(project: ProjectRef): string {
  return JSON.stringify([project.source, project.repo.toLowerCase()]);
}

function outsideId(ref: OutsideIssueRef): string {
  return JSON.stringify([ref.source, outsideRef(ref).key]);
}

function snapshot<T extends Observation>(
  entry: Entry<T> | undefined,
): StoredObservation<T> | undefined {
  if (!entry) return undefined;
  return {
    observation: structuredClone(entry.observation),
    version: entry.version,
    invalidated: entry.invalidated,
    failedGeneration: entry.failedGeneration,
  };
}

/**
 * Shared, in-memory observations for project/source scopes; named-view caching is separate.
 * Start a read before issuing upstream work, then submit exactly one result or failure with
 * that token. Start order, rather than wall-clock time or completion order, decides which
 * concurrent read wins. Pruning also retires outstanding tokens for removed entries.
 */
export class ObservationStore {
  private readonly repositories = new Map<string, Entry<RepositoryObservation>>();
  private readonly outsideIssues = new Map<string, Entry<OutsideIssueObservation>>();
  private readonly pending = new WeakMap<Read, PendingRead>();
  private nextVersion = 0;
  private nextRead = 0;
  private readonly now: () => Date;

  constructor(deps: { now?: () => Date } = {}) {
    this.now = deps.now ?? (() => new Date());
  }

  readRepository(project: ProjectRef): StoredObservation<RepositoryObservation> | undefined {
    return snapshot(this.repositories.get(repositoryId(project)));
  }

  readOutsideIssue(ref: OutsideIssueRef): StoredObservation<OutsideIssueObservation> | undefined {
    return snapshot(this.outsideIssues.get(outsideId(ref)));
  }

  /** Detached source-local inputs for derivation, including closed outside issues. */
  listOutsideIssues(source: string): StoredObservation<OutsideIssueObservation>[] {
    return [...this.outsideIssues.values()]
      .filter((entry) => entry.observation.source === source)
      .map((entry) => snapshot(entry)!);
  }

  beginRepositoryRead(project: ProjectRef): RepositoryRead {
    const canonical = projectRef(project);
    const entry = this.repository(canonical);
    const token: RepositoryRead = Object.freeze({
      kind: 'repository',
      project: Object.freeze(canonical),
      ...this.readState(entry),
    });
    this.capture(token, entry);
    return token;
  }

  beginOutsideIssueRead(ref: OutsideIssueRef): OutsideIssueRead {
    const canonical = outsideRef(ref);
    const id = outsideId(canonical);
    let entry = this.outsideIssues.get(id);
    if (!entry) {
      entry = this.entry({ ...metadata(), ...canonical, result: null });
      this.outsideIssues.set(id, entry);
    }
    const token: OutsideIssueRead = Object.freeze({
      kind: 'outside-issue',
      ...canonical,
      ...this.readState(entry),
    });
    this.capture(token, entry);
    return token;
  }

  /** False means the token was already consumed, superseded, pruned, or belongs to another store. */
  writeRepository(token: RepositoryRead, result: RepositoryReadResult): boolean {
    const entry = this.repositories.get(repositoryId(token.project));
    const request = this.accept(token, entry);
    if (!request || !entry) return false;
    const copy = structuredClone(result);
    const coverage = copy.relationCoverage ?? noCoverage();
    const checkedAt = this.now().toISOString();
    this.retainDroppedIssues(entry, copy.issues);
    entry.observation.issues = this.relations(entry, copy.issues, coverage, checkedAt);
    if (copy.pullRequests !== undefined) {
      entry.observation.pullRequests = copy.pullRequests;
    } else {
      delete entry.observation.pullRequests;
    }
    entry.observation.warnings = copy.warnings;
    this.succeeded(entry, request, coverage, checkedAt, copy);
    return true;
  }

  writeOutsideIssue(token: OutsideIssueRead, result: OutsideIssueReadResult): boolean {
    if (result.result.status === 'unresolved') return this.fail(token, result.result.error);
    const entry = this.outsideIssues.get(outsideId(token));
    const request = this.accept(token, entry);
    if (!request || !entry) return false;
    const copy = structuredClone(result);
    if (copy.result.status === 'missing') {
      // Providers use this for inaccessible 404/410s too. Keep the public last-good
      // issue, including body and relations, so derivation can retain every edge.
      entry.observation.result ??= { status: 'missing' };
      this.failed(entry, request, copy.error ?? 'Issue was not found or is not accessible');
      return true;
    }
    const coverage =
      copy.relationCoverage ??
      (copy.result.status === 'found' ? copy.result.issue.relationCoverage : undefined) ??
      noCoverage();
    const checkedAt = this.now().toISOString();
    if (copy.result.status === 'found') {
      const [issue] = this.relations(entry, [copy.result.issue], coverage, checkedAt);
      entry.observation.result = { status: 'found', issue: issue! };
    }
    this.succeeded(entry, request, coverage, checkedAt, copy);
    return true;
  }

  /** Records the failed attempt without changing last-good data, coverage or check times. */
  fail(token: Read, error: string): boolean {
    const entry =
      token.kind === 'repository'
        ? this.repositories.get(repositoryId(token.project))
        : this.outsideIssues.get(outsideId(token));
    const request = this.accept(token, entry);
    if (!request || !entry) return false;
    this.failed(entry, request, error);
    return true;
  }

  /** Retains data and invalidates the listing plus outside lookups in this source/repository. */
  invalidateRepository(project: ProjectRef): void {
    const canonical = projectRef(project);
    this.invalidate(this.repository(canonical));
    for (const entry of this.outsideIssues.values()) {
      const { source, key } = entry.observation;
      if (source === canonical.source && key.slice(0, key.lastIndexOf('#')) === canonical.repo) {
        this.invalidate(entry);
      }
    }
  }

  /** Only catalog listings and source-qualified outside references survive. No durable cache. */
  prune(catalog: CatalogResponse, referencedOutsideIssues: Iterable<OutsideIssueRef>): void {
    const sources = new Set(catalog.sources.map((source) => source.id));
    const projects = new Set(
      catalog.sources.flatMap((source) => source.projects.map(repositoryId)),
    );
    const outside = new Set(Array.from(referencedOutsideIssues, outsideId));
    for (const id of this.repositories.keys()) {
      if (!projects.has(id)) this.repositories.delete(id);
    }
    for (const [id, entry] of this.outsideIssues) {
      if (!sources.has(entry.observation.source) || !outside.has(id)) this.outsideIssues.delete(id);
    }
  }

  private entry<T extends Observation>(observation: T): Entry<T> {
    return {
      observation,
      version: ++this.nextVersion,
      invalidated: false,
      failedGeneration: null,
      lastAcceptedRead: 0,
      lastSuccessfulRead: 0,
      completeRelations: { native: null, subIssues: null },
    };
  }

  private repository(project: ProjectRef): Entry<RepositoryObservation> {
    const id = repositoryId(project);
    let entry = this.repositories.get(id);
    if (!entry) {
      entry = this.entry({ ...metadata(), project, issues: null, warnings: [] });
      this.repositories.set(id, entry);
    }
    return entry;
  }

  /** A missing listing member is unverified, not closed. Preserve its last-good payload. */
  private retainDroppedIssues(repository: Entry<RepositoryObservation>, issues: Issue[]): void {
    const listed = new Set(issues.map((issue) => issue.key));
    for (const issue of repository.observation.issues ?? []) {
      if (issue.state !== 'open' || listed.has(issue.key)) continue;
      const ref = outsideRef({ source: repository.observation.project.source, key: issue.key });
      const id = outsideId(ref);
      let entry = this.outsideIssues.get(id);
      // A targeted read can already have observed closure or updated details. Use
      // read order, not timestamps, so equal/backwards clocks cannot revive stale data.
      if (
        entry?.observation.result?.status === 'found' &&
        entry.lastSuccessfulRead >= repository.lastSuccessfulRead
      ) {
        if (
          entry.observation.result.issue.state === 'open' &&
          entry.lastSuccessfulRead < repository.lastAcceptedRead
        ) {
          entry.invalidated = true;
          entry.version = ++this.nextVersion;
        }
        continue;
      }
      if (!entry) {
        entry = this.entry({ ...metadata(), ...ref, result: null });
        this.outsideIssues.set(id, entry);
      }
      entry.observation.result = { status: 'found', issue: structuredClone(issue) };
      entry.observation.lastCheckedAt = repository.observation.lastCheckedAt;
      entry.observation.relationCoverage = structuredClone(repository.observation.relationCoverage);
      entry.observation.relationsCheckedAt = structuredClone(
        repository.observation.relationsCheckedAt,
      );
      for (const kind of relationKinds) {
        const retained = repository.completeRelations[kind]?.get(issue.key);
        entry.completeRelations[kind] = retained
          ? new Map([[issue.key, structuredClone(retained)]])
          : null;
      }
      // Keep any pending token and failure history. A lookup begun after the last
      // listing can still replace this fallback; older reads cannot overwrite it.
      entry.lastSuccessfulRead = repository.lastSuccessfulRead;
      entry.lastAcceptedRead = Math.max(entry.lastAcceptedRead, repository.lastSuccessfulRead);
      entry.invalidated = true;
      entry.version = ++this.nextVersion;
    }
  }

  private readState(entry: Entry<Observation>): ReadState {
    return {
      version: entry.version,
      invalidationGeneration: entry.observation.invalidationGeneration,
      startedAt: this.now().toISOString(),
    };
  }

  private capture(token: Read, entry: Entry<Observation>): void {
    this.pending.set(token, {
      entry,
      sequence: ++this.nextRead,
      generation: entry.observation.invalidationGeneration,
    });
  }

  private accept(token: Read, entry: Entry<Observation> | undefined): PendingRead | undefined {
    const request = this.pending.get(token);
    this.pending.delete(token);
    if (!request || request.entry !== entry || request.sequence <= entry.lastAcceptedRead) {
      return undefined;
    }
    entry.lastAcceptedRead = request.sequence;
    return request;
  }

  private failed(entry: Entry<Observation>, request: PendingRead, error: string): void {
    entry.observation.lastAttempt = {
      attemptedAt: this.now().toISOString(),
      outcome: 'failed',
      error,
    };
    entry.failedGeneration = request.generation;
    entry.version = ++this.nextVersion;
  }

  private succeeded(
    entry: Entry<Observation>,
    request: PendingRead,
    coverage: RelationCoverage,
    checkedAt: string,
    result: { outcome?: 'success' | 'partial'; error?: string | null },
  ): void {
    const partial =
      result.outcome === 'partial' ||
      relationKinds.some((kind) => coverage[kind] === 'failed' || coverage[kind] === 'unsupported');
    entry.observation.relationCoverage = coverage;
    entry.observation.lastCheckedAt = checkedAt;
    entry.observation.lastAttempt = {
      attemptedAt: checkedAt,
      outcome: partial ? 'partial' : 'success',
      error: result.error ?? null,
    };
    entry.invalidated = request.generation !== entry.observation.invalidationGeneration;
    entry.failedGeneration = null;
    entry.lastSuccessfulRead = request.sequence;
    entry.version = ++this.nextVersion;
  }

  private invalidate(entry: Entry<Observation>): void {
    entry.observation.invalidationGeneration++;
    entry.invalidated = true;
    entry.version = ++this.nextVersion;
  }

  private relations(
    entry: Entry<Observation>,
    issues: Issue[],
    coverage: RelationCoverage,
    checkedAt: string,
  ): Issue[] {
    for (const kind of relationKinds) {
      const source = relationSources[kind];
      if (coverage[kind] === 'complete') {
        entry.completeRelations[kind] = new Map(
          issues.map((issue) => [
            issue.key,
            structuredClone(issue.nativeRelations.filter((relation) => relation.source === source)),
          ]),
        );
        entry.observation.relationsCheckedAt[kind] = checkedAt;
      } else {
        for (const issue of issues) {
          const retained = entry.completeRelations[kind]?.get(issue.key);
          if (retained) {
            issue.nativeRelations = [
              ...issue.nativeRelations.filter((relation) => relation.source !== source),
              ...structuredClone(retained),
            ];
          }
        }
      }
    }
    return issues;
  }
}
