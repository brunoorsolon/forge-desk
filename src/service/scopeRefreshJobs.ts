import { randomUUID } from 'node:crypto';
import type { ResolvedSource } from '../config/schema.js';
import { parseKey } from '../core/keys.js';
import type {
  CatalogSource,
  RefreshTrigger,
  Scope,
  ScopeRefreshJobStatus,
  ScopeRefreshUnitStatus,
} from '../core/scope.js';
import type { Issue, IssueKey, IssueProvider, RelationCoverage } from '../core/types.js';
import { createLimiter, HttpError } from '../providers/http.js';
import { AdmissionQueue, type AdmissionPriority } from './admissionQueue.js';
import { ObservationStore } from './observationStore.js';
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
  queue: AdmissionQueue;
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
}

interface Job {
  status: ScopeRefreshJobStatus;
  units: Set<Unit>;
  handle: ScopeRefreshJob;
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

/**
 * Runs source-local refresh work only. Serving cached plans, sweeps and HTTP lifetimes
 * belong to callers. Queues/providers are shared with the server, never recreated here.
 */
export class ScopeRefreshJobs {
  private readonly sources = new Map<string, SourceState>();
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      sources: ScopeRefreshSource[];
      store: ObservationStore;
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

  /** Repeated opens/checks/refreshes join the same queued or running scope job. */
  refresh(
    requested: Scope,
    options: { priority?: AdmissionPriority; trigger?: RefreshTrigger } = {},
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
    const job: Job = { status, units: new Set(), handle: undefined! };
    const completion = (async () => {
      try {
        await this.runJob(source, job);
      } catch (error) {
        // A closed queue, like any failed unit, must not leave a job stuck active.
        status.state = 'failed';
        status.error = messageOf(error);
      } finally {
        status.finishedAt = this.timestamp();
        this.jobs.delete(key);
        for (const unit of job.units) unit.jobs.delete(job);
      }
      return this.snapshot(source, job);
    })();
    const snapshot = () => this.snapshot(source, job);
    job.handle = {
      get status() {
        return snapshot();
      },
      completion,
    };
    this.jobs.set(key, job);
    return job.handle;
  }

  private async runJob(source: SourceState, job: Job): Promise<void> {
    const scope = job.status.scope;
    const projects = source.catalog.projects
      .filter((p) => scope.kind === 'source' || p.repo.toLowerCase() === scope.repo)
      .map((p) => ({ source: scope.source, repo: p.repo.toLowerCase() }));
    await Promise.all(
      projects.map((project) =>
        this.unit(source, job, `repository:${project.repo}`, {
          kind: 'repository',
          project,
        }),
      ),
    );
    // Read the store, not the raw response: failed/weaker reads retain last-good
    // relationships, and a newer observation may have superseded this job's read.
    const nodes = new Map<IssueKey, Issue>();
    for (const project of projects) {
      for (const issue of this.options.store.readRepository(project)?.observation.issues ?? []) {
        if (issue.state === 'open') nodes.set(issue.key, issue);
      }
    }
    const lookups = new Map<IssueKey, OutsideIssueLookup>();
    const settings = {
      dependencies: source.source.planning!.dependencies,
      webHosts:
        source.source.webUrl === '' ? [] : [new URL(source.source.webUrl).host.toLowerCase()],
    };
    const limit = createLimiter(LOOKUP_CONCURRENCY);
    let fetches = 0;
    let capped = false;
    while (true) {
      const pending = pendingOutsideIssueKeys([...nodes.values()], lookups, settings);
      if (pending.length === 0) break;
      const keys = pending.slice(0, MAX_EXTERNAL_FETCHES - fetches);
      capped ||= keys.length < pending.length;
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
        const result = this.options.store.readOutsideIssue({ source: scope.source, key })
          ?.observation.result;
        lookups.set(key, result ?? { status: 'unresolved', error: 'Issue lookup failed' });
        if (result?.status === 'found' && result.issue.state === 'open')
          nodes.set(key, result.issue);
      }
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
    if (!unit) {
      unit = {
        key,
        priority: job.status.priority,
        status: {
          ...ref,
          state: 'queued',
          startedAt: null,
          finishedAt: null,
          lastCheckedAt: null,
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
        .finally(() => source.units.delete(key));
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
