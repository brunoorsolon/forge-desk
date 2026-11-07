import type { AppConfig, ResolvedSource } from '../config/schema.js';
import type { Scope, ScopeResponse } from '../core/scope.js';
import type { IssueProvider } from '../core/types.js';
import { createProvider, type CreateProviderDeps } from '../providers/index.js';
import type { FetchLike } from '../providers/http.js';
import { AdmissionQueue, AdmissionShutdownError } from './admissionQueue.js';
import { ObservationStore } from './observationStore.js';
import { PlanService } from './planService.js';
import { ScopeReadService } from './scopeReadService.js';
import { ScopeRefreshJobs, type ScopeRefreshSource } from './scopeRefreshJobs.js';

export interface ScopeRuntimeDeps {
  fetch?: FetchLike;
  now?: () => Date;
  shutdownWaitMs?: number;
  providerFor?: (source: ResolvedSource, deps: CreateProviderDeps) => IssueProvider;
}

/** Startup-owned services. Each source has one provider/client, regardless of read lane. */
export function createScopeRuntime(config: AppConfig, deps: ScopeRuntimeDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const queues: AdmissionQueue[] = [];
  let closed = false;
  const sources: ScopeRefreshSource[] = config.sources.map((source) => {
    let provider: IssueProvider;
    const queue = new AdmissionQueue({
      ...config.refresh,
      fixture: source.kind === 'fixture',
      now: () => now().getTime(),
      cooldownUntil: () => provider?.cooldownUntil?.() ?? null,
      ...(deps.shutdownWaitMs === undefined ? {} : { shutdownWaitMs: deps.shutdownWaitMs }),
    });
    queues.push(queue);
    provider = (deps.providerFor ?? createProvider)(source, {
      fetch: queue.wrapFetch(deps.fetch ?? globalThis.fetch),
    });
    return {
      source,
      catalog: config.catalog.sources.find((s) => s.id === source.id)!,
      provider,
      queue,
    };
  });
  const store = new ObservationStore();
  const jobs = new ScopeRefreshJobs({ sources, store, now });
  // Exports share observations and providers, but never enter an admission context.
  // Their jobs still coalesce with other exports, and the provider's ordinary
  // cooldown guard still applies, just as it does for named views and the CLI.
  const exportSources = sources.map((source): ScopeRefreshSource => ({
    ...source,
    queue: {
      submit: (_key, _priority, work) =>
        Promise.resolve().then(() => {
          if (closed) throw new AdmissionShutdownError();
          return work();
        }),
      promote: () => undefined,
      cooldownChanged: () => source.queue.cooldownChanged(),
      close: async () => undefined,
      wrapFetch: (fetch) => fetch,
      status: { delayed: false, delayedUntil: null, inFlight: 0 },
    },
  }));
  const exportJobs = new ScopeRefreshJobs({ sources: exportSources, store, now });
  const reads = new ScopeReadService({
    sources,
    store,
    jobs,
    relatedJobs: [exportJobs],
    cache: config.cache,
    now,
  });
  const exportReads = new ScopeReadService({
    sources: exportSources,
    store,
    jobs: exportJobs,
    relatedJobs: [jobs],
    cache: config.cache,
    now,
  });
  const plans = new PlanService(config, {
    providerFor: (source) => sources.find((s) => s.source.id === source.id)!.provider,
    now,
  });
  let closing: Promise<void> | undefined;
  return {
    plans,
    reads,
    jobs,
    store,
    sources,
    async exportRead(scope: Scope, options: { refresh?: boolean } = {}): Promise<ScopeResponse> {
      const cached = reads.cached(scope);
      if (!options.refresh && config.cache.ttlSeconds > 0 && cached.snapshot !== null)
        return cached;
      return exportReads.refresh(scope);
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      reads.close();
      exportReads.close();
      closing = Promise.all(queues.map((queue) => queue.close())).then(() => undefined);
      return closing;
    },
  };
}

export type ScopeRuntime = ReturnType<typeof createScopeRuntime>;
