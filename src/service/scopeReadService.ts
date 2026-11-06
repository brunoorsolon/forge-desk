import type {
  ObservationMetadata,
  Scope,
  ScopeResponse,
  RepositoryFreshness,
} from '../core/scope.js';
import type { ObservationStore, StoredObservation, OutsideIssueRef } from './observationStore.js';
import { deriveScopePlan, type ScopePlanResult } from './scopePlan.js';
import {
  ScopeRefreshError,
  type ScopeRefreshJob,
  type ScopeRefreshJobs,
  type ScopeRefreshSource,
} from './scopeRefreshJobs.js';

export const SCOPE_READ_WAIT_MS = 15_000;

export class ScopeCooldownError extends Error {
  readonly code = 'source-cooldown';
  constructor(readonly delayedUntil: string) {
    super(`Source is in cooldown until ${delayedUntil}`);
    this.name = 'ScopeCooldownError';
  }
}

/** Cache-first scope reads. HTTP lifetime and named-view caching stay separate. */
export class ScopeReadService {
  private readonly now: () => Date;
  constructor(
    private readonly options: {
      sources: ScopeRefreshSource[];
      store: ObservationStore;
      jobs: ScopeRefreshJobs;
      cache: { ttlSeconds: number };
      now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async get(requested: Scope, options: { refresh?: boolean } = {}): Promise<ScopeResponse> {
    const scope =
      requested.kind === 'project'
        ? { ...requested, repo: requested.repo.toLowerCase() }
        : { ...requested };
    const source = this.source(scope);
    const uncached = this.options.cache.ttlSeconds === 0;
    if (uncached && source.queue.status.delayedUntil !== null) {
      throw new ScopeCooldownError(new Date(source.queue.status.delayedUntil!).toISOString());
    }
    let response = this.response(scope, source);
    if (!uncached && !options.refresh && !this.needsRefresh(response, source)) return response;
    const job = this.options.jobs.refresh(scope, { priority: 'interactive' });
    if (uncached || options.refresh || response.snapshot === null) {
      await this.wait(job);
      if (uncached && source.queue.status.delayedUntil !== null) {
        throw new ScopeCooldownError(new Date(source.queue.status.delayedUntil!).toISOString());
      }
      response = this.response(scope, source, uncached ? job : undefined);
    } else {
      // Capture live job/freshness after launch without waiting on upstream work.
      response = this.response(scope, source);
    }
    return response;
  }

  refresh(scope: Scope): Promise<ScopeResponse> {
    return this.get(scope, { refresh: true });
  }

  private source(scope: Scope): ScopeRefreshSource {
    const source = this.options.sources.find((s) => s.source.id === scope.source);
    if (!source) throw new ScopeRefreshError('unknown-source', `Unknown source: ${scope.source}`);
    if (source.catalog.policy.status === 'conflict')
      throw new ScopeRefreshError('policy-conflict', source.catalog.policy.conflict.explanation);
    if (!source.source.planning)
      throw new ScopeRefreshError(
        'policy-conflict',
        `Source ${scope.source} has no planning policy`,
      );
    if (
      scope.kind === 'project' &&
      !source.catalog.projects.some((p) => p.repo.toLowerCase() === scope.repo)
    )
      throw new ScopeRefreshError(
        'unknown-project',
        `Unknown project: ${scope.source}/${scope.repo}`,
      );
    return source;
  }

  private derive(scope: Scope, source: ScopeRefreshSource, job?: ScopeRefreshJob): ScopePlanResult {
    const units = job?.status.units;
    return deriveScopePlan({
      scope,
      catalog: source.catalog,
      policy: source.source.planning!,
      webUrl: source.source.webUrl,
      cache: this.options.cache,
      now: this.now(),
      repositories: source.catalog.projects.flatMap((p) => {
        if (
          units &&
          !units.some(
            (u) => u.kind === 'repository' && u.project.repo === p.repo && u.state === 'checked',
          )
        )
          return [];
        const record = this.options.store.readRepository(p);
        return record ? [record] : [];
      }),
      outsideIssues: this.options.store
        .listOutsideIssues(scope.source)
        .filter(
          (r) =>
            !units ||
            units.some(
              (u) =>
                u.kind === 'outside-issue' && u.key === r.observation.key && u.state === 'checked',
            ),
        ),
    });
  }

  private response(
    scope: Scope,
    source: ScopeRefreshSource,
    revalidation?: ScopeRefreshJob,
  ): ScopeResponse {
    // Recompute from observations, including all catalog scopes before pruning. This
    // also catches cross-scope dependencies and relation removals without any fetch.
    const references: OutsideIssueRef[] = [];
    let result!: ScopePlanResult;
    let active = false;
    for (const input of this.options.sources) {
      if (input.catalog.policy.status !== 'usable' || !input.source.planning) continue;
      const scopes: Scope[] = [
        { kind: 'source', source: input.source.id },
        ...input.catalog.projects.map((p): Scope => ({ kind: 'project', ...p })),
      ];
      for (const current of scopes) {
        const plan = this.derive(current, input);
        references.push(
          ...plan.referencedOutsideIssues.map((key) => ({ source: current.source, key })),
        );
        active ||= this.options.jobs.active(current) !== null;
        if (
          current.kind === scope.kind &&
          current.source === scope.source &&
          (current.kind !== 'project' || (scope.kind === 'project' && current.repo === scope.repo))
        )
          result = plan;
      }
    }
    if (revalidation) {
      result = this.derive(scope, source, revalidation);
      references.push(
        ...result.referencedOutsideIssues.map((key) => ({ source: scope.source, key })),
      );
    }
    // A running job may have captured an observation token not referenced yet.
    // Prune on the first settled read instead of retiring that token mid-flight.
    if (!active)
      this.options.store.prune({ sources: this.options.sources.map((s) => s.catalog) }, references);
    const job = this.options.jobs.active(scope)?.status ?? null;
    const status = revalidation?.status;
    const hideCached =
      status && (status.finishedAt === null || status.units.some((u) => u.state === 'failed'));
    const outside = result.referencedOutsideIssues.map((key) =>
      this.options.store.readOutsideIssue({ source: scope.source, key }),
    );
    const checks = outside.map((r) => r?.observation.lastCheckedAt ?? null);
    return {
      scope,
      snapshot: hideCached ? null : result.snapshot,
      freshness: {
        computedAt: hideCached || result.snapshot === null ? null : result.computedAt,
        repositories: result.contributingRepositories.map((repo) =>
          this.repositoryFreshness(scope.source, repo, source),
        ),
        outsideIssues: {
          count: outside.length,
          oldestObservedAt: checks.includes(null) ? null : (checks.sort()[0] ?? null),
          provisionalCount: outside.filter(
            (r) =>
              !r ||
              r.observation.result?.status !== 'found' ||
              r.observation.lastAttempt?.outcome === 'failed' ||
              this.partial(r.observation, source),
          ).length,
        },
      },
      job,
    };
  }

  private partial(record: ObservationMetadata, source: ScopeRefreshSource): boolean {
    return (
      record.lastAttempt?.outcome === 'partial' ||
      (['native', 'subIssues'] as const).some(
        (kind) =>
          source.source.planning!.dependencies[kind] &&
          record.relationCoverage[kind] !== 'complete',
      )
    );
  }

  private stale(
    record: StoredObservation<ObservationMetadata> | undefined,
    source: ScopeRefreshSource,
  ): boolean {
    if (
      !record ||
      record.invalidated ||
      record.observation.lastCheckedAt === null ||
      record.observation.lastAttempt?.outcome === 'failed'
    )
      return true;
    const m = record.observation;
    const checks = [
      m.lastCheckedAt!,
      ...(['native', 'subIssues'] as const).flatMap((kind) =>
        source.source.planning!.dependencies[kind] && m.relationsCheckedAt[kind]
          ? [m.relationsCheckedAt[kind]!]
          : [],
      ),
    ];
    return checks.some(
      (check) => this.now().getTime() - Date.parse(check) > this.options.cache.ttlSeconds * 1000,
    );
  }

  private needsRefresh(response: ScopeResponse, source: ScopeRefreshSource): boolean {
    if (
      !response.snapshot ||
      response.freshness.repositories.some((r) =>
        this.stale(this.options.store.readRepository(r.project), source),
      )
    )
      return true;
    const plan = this.derive(response.scope, source);
    return plan.referencedOutsideIssues.some((key) =>
      this.stale(
        this.options.store.readOutsideIssue({ source: response.scope.source, key }),
        source,
      ),
    );
  }

  private repositoryFreshness(
    sourceId: string,
    repo: string,
    source: ScopeRefreshSource,
  ): RepositoryFreshness {
    const project = { source: sourceId, repo };
    const record = this.options.store.readRepository(project);
    const m = record?.observation;
    const scopes: Scope[] = [
      { kind: 'project', ...project },
      { kind: 'source', source: sourceId },
    ];
    const updating = scopes.some((s) =>
      this.options.jobs
        .active(s)
        ?.status.units.some(
          (u) =>
            u.kind === 'repository' &&
            u.project.repo === repo &&
            (u.state === 'queued' || u.state === 'checking'),
        ),
    );
    const until = updating ? source.queue.status.delayedUntil : null;
    return {
      project,
      lastCheckedAt: m?.lastCheckedAt ?? null,
      state:
        until !== null
          ? 'delayed'
          : updating
            ? 'updating'
            : m?.issues == null
              ? 'unavailable'
              : m.lastAttempt?.outcome === 'failed'
                ? 'failed'
                : record?.invalidated
                  ? 'invalidated'
                  : this.stale(record, source)
                    ? 'stale'
                    : 'fresh',
      partial: m ? this.partial(m, source) : false,
      error: m?.lastAttempt?.error ?? null,
      delayedUntil: until === null ? null : new Date(until).toISOString(),
    };
  }

  private async wait(job: ScopeRefreshJob): Promise<void> {
    // A cooldown is visible immediately; no request waits for its whole duration.
    if (job.status.delayedUntil !== null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        job.completion,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SCOPE_READ_WAIT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
