import { randomUUID } from 'node:crypto';
import type { ResolvedSource } from '../config/schema.js';
import { parseKey } from '../core/keys.js';
import type {
  CatalogSource,
  OutsideIssueObservation,
  RefreshTrigger,
  Scope,
  ScopeRefreshJobStatus,
  ScopeRefreshUnitStatus,
} from '../core/scope.js';
import type { Issue, IssueKey, IssueProvider, RelationCoverage } from '../core/types.js';
import { createLimiter, HttpError } from '../providers/http.js';
import { AdmissionQueue, type AdmissionPriority } from './admissionQueue.js';
import { ObservationStore, type StoredObservation } from './observationStore.js';
import { LOOKUP_CONCURRENCY } from './resolve.js';
import {
  MAX_EXTERNAL_FETCHES,
  pendingOutsideIssueKeys,
  type OutsideIssueLookup,
} from './resolution.js';

export interface ScopeRefreshSource {
  source: Pick<ResolvedSource, 'id' | 'webUrl' | 'planning'>;
  catalog: CatalogSource;
  provider: IssueProvider;
  /** The provider's fetch must already be wrapped by this source's queue. */
  queue: Pick<AdmissionQueue, keyof AdmissionQueue>;
}

export class ScopeRefreshError extends Error {
  constructor(
    readonly code: 'unknown-source' | 'unknown-project' | 'policy-conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ScopeRefreshError';
  }
}

export interface ScopeRefreshJob {
  /** Detached, current status, including live source cooldown information. */
  readonly status: ScopeRefreshJobStatus;
  /** Unit failures are reported in the status, not as a rejected completion. */
  readonly completion: Promise<ScopeRefreshJobStatus>;
  /**
   * Settles once the latest repository listing has, before outside-issue lookups:
   * the first wave a person waiting on an explicit refresh can already see.
   */
  readonly repositories?: Promise<void>;
}

export interface CompletedScopeRefresh {
  finishedAt: string;
  /** Source-local unit keys attempted by this job, including joined work. */
  unitKeys: string[];
}

interface Job {
  status: ScopeRefreshJobStatus;
  units: Set<Unit>;
  handle: ScopeRefreshJob;
  repositories: Promise<void>;
}

interface Unit {
  key: string;
  status: ScopeRefreshUnitStatus;
  priority: AdmissionPriority;
  jobs: Set<Job>;
  completion: Promise<void>;
}

interface SourceState extends ScopeRefreshSource {
  units: Map<string, Unit>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const scopeKey = (scope: Scope): string =>
  JSON.stringify([scope.source, scope.kind, scope.kind === 'project' ? scope.repo : null]);
const isPartial = (coverage: RelationCoverage | undefined): boolean =>
  coverage !== undefined &&
  Object.values(coverage).some((v) => v === 'failed' || v === 'unsupported');

/** A closed result can be trusted without submitting a new lookup unit. */
function reusableClosedIssue(
  record: StoredObservation<OutsideIssueObservation> | undefined,
  ttlSeconds: number,
  now: number,
): OutsideIssueLookup | undefined {
  if (!record || ttlSeconds <= 0) return undefined;
  const { observation } = record;
  if (
    observation.result?.status === 'found' &&
    observation.result.issue.state === 'closed' &&
    !record.invalidated &&
    observation.lastAttempt?.outcome !== 'failed' &&
    observation.lastCheckedAt !== null &&
    now - Date.parse(observation.lastCheckedAt) <= ttlSeconds * 1000
  )
    return observation.result;
  return undefined;
}

/**
 * Runs source-local refresh work only. Serving cached plans, sweeps and HTTP lifetimes
 * belong to callers. Queues/providers are shared with the server, never recreated here.
 */
export class ScopeRefreshJobs {
  private readonly sources = new Map<string, SourceState>();
  private readonly jobs = new Map<string, Job>();
  private readonly completed = new Map<string, CompletedScopeRefresh>();
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      sources: ScopeRefreshSource[];
      store: ObservationStore;
      cache: { ttlSeconds: number };
      now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    for (const source of options.sources) {
      if (source.source.id !== source.catalog.id || this.sources.has(source.source.id)) {
        throw new Error('Each refresh source must have its own unique matching catalog');
      }
      this.sources.set(source.source.id, { ...source, units: new Map() });
    }
  }

  active(scope: Scope): ScopeRefreshJob | null {
    return this.jobs.get(scopeKey(this.canonicalScope(scope)))?.handle ?? null;
  }

  /** Retained for passive retry pacing, including jobs launched by a sweep. */
  lastCompleted(scope: Scope): CompletedScopeRefresh | null {
    const result = this.completed.get(scopeKey(this.canonicalScope(scope)));
    return result ? { ...result, unitKeys: [...result.unitKeys] } : null;
  }

  /** Repeated opens/checks/refreshes join the same queued or running scope job. */
  refresh(
    requested: Scope,
    options: { priority?: AdmissionPriority; trigger?: RefreshTrigger; explicit?: boolean } = {},
  ): ScopeRefreshJob {
    const scope = this.canonicalScope(requested);
    const source = this.sources.get(scope.source);
    if (!source) throw new ScopeRefreshError('unknown-source', `Unknown source: ${scope.source}`);
    if (source.catalog.policy.status === 'conflict') {
      throw new ScopeRefreshError('policy-conflict', source.catalog.policy.conflict.explanation);
    }
    if (source.source.planning === null) {
      throw new ScopeRefreshError(
        'policy-conflict',
        `Source ${scope.source} has no planning policy`,
      );
    }
    if (
      scope.kind === 'project' &&
      !source.catalog.projects.some((project) => project.repo.toLowerCase() === scope.repo)
    ) {
      throw new ScopeRefreshError(
        'unknown-project',
        `Unknown project: ${scope.source}/${scope.repo}`,
      );
    }
    const key = scopeKey(scope);
    const priority = options.priority ?? 'interactive';
    const existing = this.jobs.get(key);
    if (existing) {
      if (priority === 'interactive') {
        existing.status.priority = priority;
        for (const unit of existing.units) this.promote(source, unit);
      }
      const repositories = [...existing.units].filter((unit) => unit.status.kind === 'repository');
      if (
        options.explicit &&
        (existing.status.state === 'queued' || existing.status.state === 'running') &&
        repositories.length > 0 &&
        repositories.every((unit) => ['checked', 'failed'].includes(unit.status.state))
      ) {
        // Queue immediately, rather than waiting behind the current lookup batch.
        // Pending repository units also coalesce repeated explicit refreshes.
        existing.repositories = this.listRepositories(source, existing);
      }
      return existing.handle;
    }
    const status: ScopeRefreshJobStatus = {
      id: randomUUID(),
      scope,
      trigger: options.trigger ?? (priority === 'sweep' ? 'scheduled' : 'interactive'),
      priority,
      state: 'queued',
      queuedAt: this.timestamp(),
      startedAt: null,
      finishedAt: null,
      delayedUntil: null,
      error: null,
      units: [],
    };
    const job: Job = {
      status,
      units: new Set(),
      handle: undefined!,
      repositories: undefined!,
    };
    job.repositories = this.listRepositories(source, job);
    const completion = (async () => {
      try {
        await this.runJob(source, job);
      } catch (error) {
        // A closed queue, like any failed unit, must not leave a job stuck active.
        status.state = 'failed';
        status.error = messageOf(error);
      } finally {
        status.finishedAt = this.timestamp();
        this.completed.set(key, {
          finishedAt: status.finishedAt,
          unitKeys: [...job.units].map((unit) => unit.key),
        });
        this.jobs.delete(key);
        for (const unit of job.units) unit.jobs.delete(job);
      }
      return this.snapshot(source, job);
    })();
    const snapshot = () => this.snapshot(source, job);
    // An explicit recheck may replace the listing; settle on the one still current.
    const listed = async (): Promise<void> => {
      let repositories: Promise<void>;
      do {
        repositories = job.repositories;
        await repositories;
      } while (repositories !== job.repositories);
    };
    job.handle = {
      get status() {
        return snapshot();
      },
      completion,
      get repositories() {
        return listed();
      },
    };
    this.jobs.set(key, job);
    return job.handle;
  }

  private projects(source: SourceState, job: Job) {
    const scope = job.status.scope;
    return source.catalog.projects
      .filter((p) => scope.kind === 'source' || p.repo.toLowerCase() === scope.repo)
      .map((p) => ({ source: scope.source, repo: p.repo.toLowerCase() }));
  }

  private async listRepositories(source: SourceState, job: Job): Promise<void> {
    for (const unit of job.units) {
      if (unit.status.kind === 'repository') {
        job.units.delete(unit);
        unit.jobs.delete(job);
      }
    }
    await Promise.all(
      this.projects(source, job).map((project) =>
        this.unit(source, job, `repository:${project.repo}`, {
          kind: 'repository',
          project,
        }),
      ),
    );
  }

  private async runJob(source: SourceState, job: Job): Promise<void> {
    const scope = job.status.scope;
    const settings = {
      dependencies: source.source.planning!.dependencies,
      webHosts:
        source.source.webUrl === '' ? [] : [new URL(source.source.webUrl).host.toLowerCase()],
    };
    const limit = createLimiter(LOOKUP_CONCURRENCY);
    const attempted = new Set<IssueKey>();
    let fetches = 0;
    let capped = false;
    while (true) {
      const repositories = job.repositories;
      await repositories;
      if (repositories !== job.repositories) continue;
      // Rebuild from the latest listing after an explicit recheck. Do not traverse
      // dependencies removed by that listing or fetch the same outside issue twice.
      const nodes = new Map<IssueKey, Issue>();
      for (const project of this.projects(source, job)) {
        for (const issue of this.options.store.readRepository(project)?.observation.issues ?? []) {
          if (issue.state === 'open') nodes.set(issue.key, issue);
        }
      }
      const lookups = new Map<IssueKey, OutsideIssueLookup>();
      capped = false;
      while (repositories === job.repositories) {
        // Recheck newly discovered references against the shared store each level:
        // another job may have verified a closed prerequisite during the last batch.
        const pending = pendingOutsideIssueKeys([...nodes.values()], lookups, settings);
        if (pending.length === 0) break;
        const uncached = pending.filter((key) => {
          const record = this.options.store.readOutsideIssue({ source: scope.source, key });
          const reused = attempted.has(key)
            ? (record?.observation.result ?? {
                status: 'unresolved' as const,
                error: 'Issue lookup failed',
              })
            : reusableClosedIssue(record, this.options.cache.ttlSeconds, this.now().getTime());
          if (reused) {
            lookups.set(key, reused);
            if (reused.status === 'found' && reused.issue.state === 'open')
              nodes.set(key, reused.issue);
            return false;
          }
          return true;
        });
        if (uncached.length === 0) continue;
        const keys = uncached.slice(0, MAX_EXTERNAL_FETCHES - fetches);
        capped ||= keys.length < uncached.length;
        if (keys.length === 0) break;
        fetches += keys.length;
        await Promise.all(
          keys.map((key) =>
            limit(() =>
              this.unit(source, job, `outside-issue:${key}`, {
                kind: 'outside-issue',
                source: scope.source,
                key,
              }),
            ),
          ),
        );
        for (const key of keys) {
          attempted.add(key);
          const result = this.options.store.readOutsideIssue({ source: scope.source, key })
            ?.observation.result;
          lookups.set(key, result ?? { status: 'unresolved', error: 'Issue lookup failed' });
          if (result?.status === 'found' && result.issue.state === 'open')
            nodes.set(key, result.issue);
        }
      }
      if (repositories === job.repositories) break;
    }
    const units = [...job.units];
    const failures = units.filter((unit) => unit.status.state === 'failed');
    const partial = capped || units.some((unit) => unit.status.partial);
    job.status.state =
      failures.length === units.length && units.length > 0
        ? 'failed'
        : failures.length > 0 || partial
          ? 'partial'
          : 'completed';
    job.status.error =
      failures[0]?.status.error ??
      (capped ? `Stopped after ${MAX_EXTERNAL_FETCHES} outside-issue lookups` : null);
  }

  private unit(
    source: SourceState,
    job: Job,
    key: string,
    ref:
      | { kind: 'repository'; project: { source: string; repo: string } }
      | { kind: 'outside-issue'; source: string; key: IssueKey },
  ): Promise<void> {
    let unit = source.units.get(key);
    if (unit && (unit.status.state === 'checked' || unit.status.state === 'failed'))
      unit = undefined;
    if (!unit) {
      unit = {
        key,
        priority: job.status.priority,
        status: {
          ...ref,
          state: 'queued',
          startedAt: null,
          finishedAt: null,
          lastCheckedAt:
            (ref.kind === 'repository'
              ? this.options.store.readRepository(ref.project)
              : this.options.store.readOutsideIssue({ source: ref.source, key: ref.key })
            )?.observation.lastCheckedAt ?? null,
          partial: false,
          error: null,
        },
        jobs: new Set(),
        completion: undefined!,
      };
      source.units.set(key, unit);
      const created = unit;
      unit.completion = Promise.resolve()
        .then(() => this.runUnit(source, created))
        .finally(() => {
          if (source.units.get(key) === created) source.units.delete(key);
        });
    }
    job.units.add(unit);
    unit.jobs.add(job);
    if (unit.status.startedAt !== null) this.started(job);
    if (job.status.priority === 'interactive') this.promote(source, unit);
    return unit.completion;
  }

  private async runUnit(source: SourceState, unit: Unit): Promise<void> {
    const store = this.options.store;
    const options = {
      native: source.source.planning!.dependencies.native,
      subIssues: source.source.planning!.dependencies.subIssues,
    };
    while (true) {
      try {
        await source.queue.submit(unit.key, unit.priority, async () => {
          const status = unit.status;
          status.state = 'checking';
          status.startedAt ??= this.timestamp();
          for (const job of unit.jobs) this.started(job);
          // Capture only after admission, including on every cooldown retry.
          const read =
            status.kind === 'repository'
              ? store.beginRepositoryRead(status.project)
              : store.beginOutsideIssueRead({ source: status.source, key: status.key });
          let coverage: RelationCoverage | undefined;
          let missing = false;
          try {
            if (read.kind === 'repository') {
              const result = await source.provider.listOpenIssues(
                parseKey(`${read.project.repo}#1`).repo,
                options,
              );
              coverage = result.relationCoverage;
              store.writeRepository(read, result);
            } else {
              const { repo, number } = parseKey(read.key);
              const issue = await source.provider.getIssue(repo, number, options);
              coverage = issue?.relationCoverage;
              store.writeOutsideIssue(read, {
                result:
                  issue === null
                    ? { status: 'missing' }
                    : { status: 'found', issue: { ...issue, key: read.key } },
              });
              missing = issue === null;
            }
          } catch (error) {
            // A source cooldown is a delay, not a failed observation. In particular,
            // unpaced exports fail locally instead of joining the admission queue;
            // recording that rejection would suppress later browsing until the TTL.
            // Read the provider directly: the export lane deliberately does not wait.
            const cooldown = source.provider.cooldownUntil?.() ?? null;
            if (
              !(error instanceof HttpError) ||
              (error.status !== 429 && error.status !== 403) ||
              cooldown === null ||
              cooldown <= this.now().getTime()
            )
              store.fail(read, messageOf(error));
            throw error;
          }
          // The missing observation already records its failure and preserves data.
          if (missing) throw new Error('Issue was not found or is not accessible');
          status.partial = isPartial(coverage);
          // Providers return partial relation data when a relation endpoint is
          // throttled. Re-admit that unit as well as explicitly rejected reads.
          if (
            coverage &&
            Object.values(coverage).includes('failed') &&
            source.queue.status.delayed
          ) {
            throw new HttpError('Relation reads delayed by source cooldown', 429, '');
          }
        });
        unit.status.state = 'checked';
        break;
      } catch (error) {
        if (
          error instanceof HttpError &&
          (error.status === 429 || error.status === 403) &&
          source.queue.status.delayed
        ) {
          unit.status.state = 'queued';
          source.queue.cooldownChanged();
          continue;
        }
        unit.status.state = 'failed';
        unit.status.error = messageOf(error);
        break;
      }
    }
    const status = unit.status;
    status.lastCheckedAt =
      (status.kind === 'repository'
        ? store.readRepository(status.project)
        : store.readOutsideIssue({ source: status.source, key: status.key })
      )?.observation.lastCheckedAt ?? null;
    status.finishedAt = this.timestamp();
  }

  private promote(source: SourceState, unit: Unit): void {
    unit.priority = 'interactive';
    source.queue.promote(unit.key);
  }

  private started(job: Job): void {
    job.status.startedAt ??= this.timestamp();
    job.status.state = 'running';
  }

  private snapshot(source: SourceState, job: Job): ScopeRefreshJobStatus {
    const until = job.status.finishedAt === null ? source.queue.status.delayedUntil : null;
    return structuredClone({
      ...job.status,
      delayedUntil: until === null ? null : new Date(until).toISOString(),
      units: [...job.units].map((unit) => unit.status),
    });
  }

  private canonicalScope(scope: Scope): Scope {
    return scope.kind === 'project' ? { ...scope, repo: scope.repo.toLowerCase() } : { ...scope };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
