import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYWORDS } from '../config/schema.js';
import type { CatalogSource } from '../core/scope.js';
import type { FetchResult, IssueProvider } from '../core/types.js';
import { AdmissionQueue } from './admissionQueue.js';
import { ObservationStore } from './observationStore.js';
import { ScopeRefreshJobs, type ScopeRefreshSource } from './scopeRefreshJobs.js';
import { SweepScheduler } from './sweepScheduler.js';

const HOUR = 3_600_000;
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const queues: AdmissionQueue[] = [];
const schedulers: SweepScheduler[] = [];
function source(
  id = 'gh',
  repos = ['owner/a', 'owner/b'],
  work: (repo: string) => Promise<void> = async () => {},
) {
  const catalog: CatalogSource = {
    id,
    kind: 'github',
    policy: { status: 'usable' },
    projects: repos.map((repo) => ({ source: id, repo })),
  };
  const queue = new AdmissionQueue({ requestsPerMinute: 1000, concurrency: 1 });
  queues.push(queue);
  const calls: string[] = [];
  const fetch = queue.wrapFetch(async (input) => {
    const repo = String(input);
    calls.push(repo);
    await work(repo);
    return new Response(
      JSON.stringify({
        issues: [],
        warnings: [],
        relationCoverage: { native: 'complete', subIssues: 'complete' },
      }),
    );
  });
  const provider: IssueProvider = {
    kind: 'github',
    listOpenIssues: async (repo) =>
      (await (await fetch(`${repo.owner}/${repo.repo}`)).json()) as FetchResult,
    getIssue: async () => null,
  };
  const config: ScopeRefreshSource = {
    catalog,
    queue,
    provider,
    source: {
      id,
      webUrl: '',
      planning: {
        dependencies: { native: true, body: true, subIssues: true, keywords: DEFAULT_KEYWORDS },
        ordering: { priorityLabels: [], mode: 'priority' },
      },
    },
  };
  return { config, catalog, calls };
}
function fixture(sources = [source()], options: { sweepHours?: number; ttlSeconds?: number } = {}) {
  const store = new ObservationStore();
  const jobs = new ScopeRefreshJobs({
    sources: sources.map((s) => s.config),
    store,
    cache: { ttlSeconds: options.ttlSeconds ?? 300 },
  });
  const scheduler = new SweepScheduler({
    sources: sources.map((s) => s.catalog),
    jobs,
    store,
    sweepHours: 1,
    ttlSeconds: 300,
    ...options,
  });
  schedulers.push(scheduler);
  return { scheduler, jobs, store };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
});
afterEach(async () => {
  schedulers.splice(0).forEach((s) => s.stop());
  await Promise.all(queues.splice(0).map((q) => q.close()));
  vi.useRealTimers();
});

describe('SweepScheduler', () => {
  it('sweeps every source and complete catalog at startup, retaining detached recent status', async () => {
    const a = source(),
      b = source('other', ['owner/a', 'owner/c']);
    const { scheduler, jobs } = fixture([a, b]);
    const refresh = vi.spyOn(jobs, 'refresh');
    expect(scheduler.status).toBeNull();
    const run = scheduler.start()!;
    expect(scheduler.start()).toBe(run);
    expect(run.status.sources.flatMap((s) => s.projects).map((p) => p.state)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
    const result = await run.completion;
    expect(a.calls).toEqual(['owner/a', 'owner/b']);
    expect(b.calls).toEqual(['owner/a', 'owner/c']);
    expect(refresh).toHaveBeenCalledTimes(2);
    for (const call of refresh.mock.calls)
      expect(call[1]).toEqual({ priority: 'sweep', trigger: 'scheduled' });
    expect(result).toMatchObject({
      state: 'completed',
      trigger: 'scheduled',
      startedAt: '2026-11-06T00:00:00.000Z',
      finishedAt: '2026-11-06T00:00:00.000Z',
    });
    expect(
      result.sources
        .flatMap((s) => s.projects)
        .every((p) => p.state === 'checked' && p.lastCheckedAt === result.finishedAt),
    ).toBe(true);
    result.sources.length = 0;
    expect(scheduler.status!.sources).toHaveLength(2);
    expect(run.status.sources).toHaveLength(2);
  });

  it('waits a whole interval after completion and joins manual requests without overlap', async () => {
    const hold = gate();
    const a = source('gh', ['owner/a'], () => hold.promise);
    const { scheduler } = fixture([a]);
    const run = scheduler.start()!;
    await tick();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(a.calls).toHaveLength(1);
    expect(scheduler.sweep()).toBe(run);
    expect(run.status.startedAt).toBe('2026-11-06T00:00:00.000Z');
    expect(run.status.trigger).toBe('scheduled');
    hold.resolve();
    await run.completion;
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(a.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.calls).toHaveLength(2);
  });

  it('manual sweeps reset the next scheduled deadline from their own finish', async () => {
    const a = source();
    const { scheduler } = fixture([a]);
    await scheduler.start()!.completion;
    await vi.advanceTimersByTimeAsync(HOUR / 2);
    const manual = scheduler.sweep();
    await manual.completion;
    expect(manual.status.trigger).toBe('interactive');
    await vi.advanceTimersByTimeAsync(HOUR / 2);
    expect(a.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(HOUR / 2);
    expect(a.calls).toHaveLength(6);
  });

  it('reports live queued/checking/checked/failed states and retained successful check times', async () => {
    const hold = gate();
    let fail = false;
    const a = source('gh', ['owner/a', 'owner/b'], async (repo) => {
      if (fail && repo === 'owner/b') throw new Error('provider unavailable');
      if (fail) await hold.promise;
    });
    const { scheduler, jobs } = fixture([a]);
    await scheduler.start()!.completion;
    const checkedAt = scheduler.status!.finishedAt;
    fail = true;
    await vi.advanceTimersByTimeAsync(10);
    const refresh = vi.spyOn(jobs, 'refresh');
    const run = scheduler.sweep();
    try {
      // Route callers can read status synchronously, before source jobs exist.
      expect(refresh).not.toHaveBeenCalled();
      expect(run.status.sources[0]!.projects).toMatchObject([
        { state: 'queued', lastCheckedAt: checkedAt, error: null },
        { state: 'queued', lastCheckedAt: checkedAt, error: null },
      ]);
      expect(scheduler.status).toEqual(run.status);
      await tick();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(run.status.sources[0]!.projects).toMatchObject([
        { state: 'checking', lastCheckedAt: checkedAt, error: null },
        { state: 'checking', lastCheckedAt: checkedAt, error: null },
      ]);
    } finally {
      hold.resolve();
    }
    const result = await run.completion;
    expect(result.state).toBe('partial');
    expect(result.sources[0]!.projects[0]).toMatchObject({
      state: 'checked',
      lastCheckedAt: '2026-11-06T00:00:00.010Z',
      error: null,
    });
    expect(result.sources[0]!.projects[1]).toMatchObject({
      state: 'failed',
      lastCheckedAt: checkedAt,
      error: 'provider unavailable',
    });
  });

  it('isolates source policy conflicts and failures while healthy sources continue', async () => {
    const bad = source('conflict');
    bad.catalog.policy = {
      status: 'conflict',
      conflict: {
        source: 'conflict',
        differingSettings: ['dependencies.native'],
        views: ['a', 'b'],
        explanation: 'Set sources[].planning',
      },
    };
    const failing = source('failed', ['owner/a'], async () => {
      throw new Error('offline');
    });
    const good = source('good');
    const { scheduler } = fixture([bad, failing, good]);
    const result = await scheduler.start()!.completion;
    expect(result.state).toBe('partial');
    expect(bad.calls).toEqual([]);
    expect(good.calls).toHaveLength(2);
    expect(result.sources.map((s) => s.state)).toEqual(['conflict', 'failed', 'completed']);
    expect(result.sources[0]!.policyConflict).toEqual(bad.catalog.policy.conflict);
    expect(
      result.sources[0]!.projects.every(
        (p) => p.state === 'failed' && p.error === 'Set sources[].planning',
      ),
    ).toBe(true);
  });

  it('joins source work already running instead of duplicating provider reads', async () => {
    const hold = gate(),
      a = source('gh', ['owner/a'], () => hold.promise);
    const { scheduler, jobs } = fixture([a]);
    const interactive = jobs.refresh({ kind: 'source', source: 'gh' });
    await tick();
    const sweep = scheduler.sweep();
    await tick();
    expect(a.calls).toHaveLength(1);
    hold.resolve();
    await Promise.all([interactive.completion, sweep.completion]);
    expect(a.calls).toHaveLength(1);
    expect(sweep.status.state).toBe('completed');
  });

  it('reports cooldowns without blocking a healthy source', async () => {
    const slow = source('slow');
    const good = source('good');
    // Hold the source before any fetch through the same admission queue used by jobs.
    const until = Date.now() + 60_000;
    const queue = new AdmissionQueue({
      concurrency: 1,
      requestsPerMinute: 1000,
      cooldownUntil: () => (Date.now() < until ? until : null),
    });
    queues.push(queue);
    slow.config.queue = queue;
    const { scheduler, store } = fixture([slow, good]);
    const project = { source: 'slow', repo: 'owner/a' };
    store.writeRepository(store.beginRepositoryRead(project), { issues: [], warnings: [] });
    const checkedAt = store.readRepository(project)!.observation.lastCheckedAt;
    vi.setSystemTime(Date.now() + 10);
    const run = scheduler.start()!;
    await tick();
    expect(run.status.sources[0]).toMatchObject({
      state: 'delayed',
      delayedUntil: new Date(until).toISOString(),
    });
    expect(run.status.sources[0]!.projects).toMatchObject([
      { state: 'queued', lastCheckedAt: checkedAt },
      { state: 'queued', lastCheckedAt: null },
    ]);
    expect(good.calls).toHaveLength(2);
    expect(slow.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await run.completion;
    expect(run.status.state).toBe('completed');
  });

  it.each([0, 1])(
    'skips manual and scheduled sweeps with zero TTL (interval %i)',
    async (sweepHours) => {
      const a = source();
      const { scheduler, jobs } = fixture([a], { ttlSeconds: 0, sweepHours });
      const refresh = vi.spyOn(jobs, 'refresh');
      const startup = scheduler.start();
      if (startup) await startup.completion;
      const result = await scheduler.sweep().completion;
      expect(result).toMatchObject({
        state: 'skipped',
        skipReason: 'caching-disabled',
        sources: [],
      });
      expect(result.finishedAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(5 * HOUR);
      expect(refresh).not.toHaveBeenCalled();
      expect(a.calls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('allows manual sweeps with scheduling disabled', async () => {
    const a = source();
    const { scheduler } = fixture([a], { sweepHours: 0 });
    expect(scheduler.start()).toBeNull();
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(a.calls).toEqual([]);
    await scheduler.sweep().completion;
    expect(a.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a pending timer and cannot restart or launch manual work', async () => {
    const a = source();
    const { scheduler } = fixture([a]);
    await scheduler.start()!.completion;
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.start()).toBeNull();
    expect(() => scheduler.sweep()).toThrow('stopped');
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(a.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops before queued startup work', async () => {
    const a = source();
    const first = fixture([a]).scheduler;
    const cancelled = first.start()!;
    first.stop();
    expect((await cancelled.completion).state).toBe('failed');
    expect(a.calls).toEqual([]);
  });

  it('lets launched source jobs and joined interactive work finish queued reads after stop', async () => {
    const hold = gate(),
      a = source('gh', ['owner/a', 'owner/b', 'owner/c', 'owner/d'], () => hold.promise);
    const { scheduler, jobs } = fixture([a]);
    const close = vi.spyOn(a.config.queue, 'close');
    const running = scheduler.start()!;
    await tick();
    expect(a.calls).toEqual(['owner/a']);
    const interactive = jobs.refresh({ kind: 'project', source: 'gh', repo: 'owner/b' });
    scheduler.stop();
    expect(close).not.toHaveBeenCalled();
    expect(() => scheduler.sweep()).toThrow('stopped');
    hold.resolve();
    const results = await Promise.all([running.completion, interactive.completion]);
    expect(results.every((result) => result.state === 'completed')).toBe(true);
    expect(a.calls).toEqual(['owner/a', 'owner/b', 'owner/c', 'owner/d']);
    // Stopping the scheduler does not take ownership of the shared queue.
    await jobs.refresh({ kind: 'project', source: 'gh', repo: 'owner/a' }).completion;
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(a.calls).toEqual(['owner/a', 'owner/b', 'owner/c', 'owner/d', 'owner/a']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes empty catalogs without leaving an active sweep', async () => {
    const { scheduler } = fixture([]);
    const first = scheduler.sweep();
    expect((await first.completion).state).toBe('completed');
    const second = scheduler.sweep();
    expect(second).not.toBe(first);
    await second.completion;
  });
});
