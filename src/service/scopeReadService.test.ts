import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYWORDS } from '../config/schema.js';
import { parseKey } from '../core/keys.js';
import type { Scope } from '../core/scope.js';
import type { Issue, IssueProvider, FetchResult } from '../core/types.js';
import { AdmissionQueue } from './admissionQueue.js';
import { ObservationStore } from './observationStore.js';
import { ScopeRefreshJobs, type ScopeRefreshSource } from './scopeRefreshJobs.js';
import { ScopeReadService, ScopeCooldownError } from './scopeReadService.js';

const coverage = { native: 'complete', subIssues: 'complete' } as const;
const project = (repo = 'o/a'): Scope => ({ kind: 'project', source: 'gh', repo });
const all: Scope = { kind: 'source', source: 'gh' };
const issue = (key: string, body = '', state: 'open' | 'closed' = 'open'): Issue => ({
  ...parseKey(key),
  key,
  body,
  state,
  title: key,
  url: '',
  labels: [],
  assignees: [],
  milestone: null,
  updatedAt: null,
  nativeRelations: [],
  relationCoverage: coverage,
});
const listing = (issues: Issue[] = []): FetchResult => ({
  issues,
  warnings: [],
  relationCoverage: coverage,
});
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const queues: AdmissionQueue[] = [];
function fixture(ttlSeconds = 60) {
  let cooldown: number | null = null;
  const queue = new AdmissionQueue({
    concurrency: 4,
    requestsPerMinute: 1000,
    cooldownUntil: () => cooldown,
  });
  queues.push(queue);
  const list = vi.fn<IssueProvider['listOpenIssues']>(async () => listing([issue('o/a#1')]));
  const lookup = vi.fn(async () => issue('external/repo#1', '', 'closed'));
  const provider: IssueProvider = { kind: 'github', listOpenIssues: list, getIssue: lookup };
  const source: ScopeRefreshSource = {
    source: {
      id: 'gh',
      webUrl: '',
      planning: {
        dependencies: { native: true, subIssues: true, body: true, keywords: DEFAULT_KEYWORDS },
        ordering: { mode: 'priority', priorityLabels: [] },
      },
    },
    catalog: {
      id: 'gh',
      kind: 'github',
      policy: { status: 'usable' },
      projects: ['o/a', 'o/b'].map((repo) => ({ source: 'gh', repo })),
    },
    provider,
    queue,
  };
  const store = new ObservationStore();
  const jobs = new ScopeRefreshJobs({ sources: [source], store });
  const service = new ScopeReadService({ sources: [source], store, jobs, cache: { ttlSeconds } });
  const seed = (repo: string, issues: Issue[] = []) =>
    store.writeRepository(store.beginRepositoryRead({ source: 'gh', repo }), listing(issues));
  return {
    service,
    store,
    jobs,
    list,
    lookup,
    seed,
    source,
    cooldown: (until: number) => {
      cooldown = until;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-01-01T00:00:00Z');
});
afterEach(async () => {
  for (const q of queues.splice(0)) await q.close();
  vi.useRealTimers();
});

describe('cache-first scope reads', () => {
  it('serves verified empty and populated fresh data with no upstream work', async () => {
    const f = fixture();
    f.seed('o/a');
    const response = await f.service.get(project('O/A'));
    expect(response.scope).toEqual(project());
    expect(response.snapshot?.plan.nodes).toEqual([]);
    expect(response.freshness.repositories[0]).toMatchObject({
      state: 'fresh',
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
      partial: false,
    });
    expect(response.job).toBeNull();
    expect(f.list).not.toHaveBeenCalled();
  });

  it('serves stale data immediately and joins one background job', async () => {
    const f = fixture();
    f.seed('o/a', [issue('o/a#1')]);
    vi.advanceTimersByTime(61_000);
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing([issue('o/a#2')]);
    });
    const first = await f.service.get(project());
    const second = await f.service.get(project());
    expect(first.snapshot?.plan.nodes[0]?.key).toBe('o/a#1');
    expect(first.snapshot?.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(first.job?.id).toBe(second.job?.id);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(second.freshness.repositories[0]?.state).toBe('updating');
    blocked.resolve();
    await tick();
    expect((await f.service.get(project())).snapshot?.plan.nodes[0]?.key).toBe('o/a#2');
  });

  it('waits for first data, but stops at 15 seconds without inventing an empty plan', async () => {
    const f = fixture();
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing();
    });
    const pending = f.service.get(project());
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.snapshot).toBeNull();
    expect(response.freshness.computedAt).toBeNull();
    expect(response.job).not.toBeNull();
    blocked.resolve();
    await tick();
    expect((await f.service.get(project())).snapshot).not.toBeNull();
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('returns first-load data as soon as its job finishes and cleans the wait timer', async () => {
    const f = fixture();
    const response = await f.service.get(project());
    expect(response.snapshot?.plan.nodes[0]?.key).toBe('o/a#1');
    expect(response.job).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('explicitly rechecks fresh data and joins repeated refreshes', async () => {
    const f = fixture();
    f.seed('o/a');
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing([issue('o/a#2')]);
    });
    const first = f.service.refresh(project());
    const second = f.service.refresh(project());
    await tick();
    expect(f.list).toHaveBeenCalledTimes(1);
    blocked.resolve();
    expect((await first).snapshot?.plan.nodes[0]?.key).toBe('o/a#2');
    expect((await second).job).toBeNull();
  });

  it('revalidates every zero-TTL read, joins concurrent work, and never falls back after failure', async () => {
    const f = fixture(0);
    f.seed('o/a', [issue('o/a#99')]);
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing([issue('o/a#2')]);
    });
    const first = f.service.get(project());
    const second = f.service.get(project());
    await tick();
    expect(f.list).toHaveBeenCalledTimes(1);
    blocked.resolve();
    expect((await first).snapshot?.plan.nodes[0]?.key).toBe('o/a#2');
    await second;
    await f.service.get(project());
    expect(f.list).toHaveBeenCalledTimes(2);
    f.list.mockRejectedValueOnce(new Error('offline'));
    const failed = await f.service.get(project());
    expect(failed.snapshot).toBeNull();
    expect(failed.freshness.repositories[0]).toMatchObject({ state: 'failed', error: 'offline' });
  });

  it('does not serve zero-TTL data on timeout and fails immediately during cooldown', async () => {
    const f = fixture(0);
    f.seed('o/a');
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing();
    });
    const pending = f.service.get(project());
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).snapshot).toBeNull();
    blocked.resolve();
    await tick();
    f.cooldown(Date.now() + 60_000);
    await expect(f.service.get(project())).rejects.toBeInstanceOf(ScopeCooldownError);
    await expect(f.service.get(project())).rejects.toThrow(
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('recomputes All projects from observations after a project refresh, without listing others', async () => {
    const f = fixture();
    f.seed('o/a', [issue('o/a#1')]);
    vi.advanceTimersByTime(1000);
    f.seed('o/b', [issue('o/b#1')]);
    await f.service.get(all);
    vi.advanceTimersByTime(1000);
    f.list.mockResolvedValue(listing([issue('o/a#2')]));
    await f.service.refresh(project());
    const response = await f.service.get(all);
    expect(response.snapshot?.plan.nodes.map((i) => i.key)).toEqual(['o/a#2', 'o/b#1']);
    expect(response.snapshot?.fetchedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(response.freshness.computedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(response.freshness.repositories.map((r) => r.lastCheckedAt)).toEqual([
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:01.000Z',
    ]);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.list.mock.calls[0]?.[0]).toEqual({ owner: 'o', repo: 'a' });
  });

  it('keeps partial-source success and last-good failure data with honest freshness', async () => {
    const f = fixture();
    f.seed('o/a', [issue('o/a#1')]);
    f.list.mockRejectedValue(new Error('offline'));
    const response = await f.service.refresh(all);
    expect(response.snapshot?.plan.nodes.map((i) => i.key)).toEqual(['o/a#1']);
    expect(response.snapshot?.plan.warnings.some((w) => w.code === 'repository-unlisted')).toBe(
      true,
    );
    expect(response.freshness.repositories.map((r) => r.state)).toEqual(['failed', 'unavailable']);
    expect(response.freshness.repositories[0]?.lastCheckedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rechecks invalidated observations and marks cooldown delay without waiting', async () => {
    const f = fixture();
    f.seed('o/a');
    f.store.invalidateRepository({ source: 'gh', repo: 'o/a' });
    f.cooldown(Date.now() + 3600_000);
    const response = await f.service.get(project());
    expect(response.snapshot?.plan.warnings.some((w) => w.code === 'stale-data')).toBe(true);
    expect(response.freshness.repositories[0]).toMatchObject({
      state: 'delayed',
      delayedUntil: '2026-01-01T01:00:00.000Z',
    });
    expect(f.list).not.toHaveBeenCalled();
  });

  it('retains closed external references, reports outside age/provisional count, then prunes removed references', async () => {
    const f = fixture();
    f.seed('o/a', [issue('o/a#1', 'Depends on external/repo#1')]);
    f.seed('o/b');
    const ref = { source: 'gh', key: 'external/repo#1' };
    f.store.writeOutsideIssue(f.store.beginOutsideIssueRead(ref), {
      result: { status: 'found', issue: issue(ref.key, '', 'closed') },
    });
    let response = await f.service.get(project());
    expect(response.freshness.outsideIssues).toEqual({
      count: 1,
      oldestObservedAt: '2026-01-01T00:00:00.000Z',
      provisionalCount: 0,
    });
    expect(f.store.readOutsideIssue(ref)).toBeDefined();
    expect(f.list).not.toHaveBeenCalled();
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing();
    });
    f.store.fail(f.store.beginOutsideIssueRead(ref), 'outside offline');
    response = await f.service.get(project());
    expect(response.freshness.outsideIssues.provisionalCount).toBe(1);
    blocked.resolve();
    await tick();
    await f.service.get(project());
    expect(f.store.readOutsideIssue(ref)).toBeUndefined();
    f.seed('not/catalog');
    await f.service.get(project());
    expect(f.store.readRepository({ source: 'gh', repo: 'not/catalog' })).toBeUndefined();
  });
  it('refreshes a scope when only its outside observation is stale', async () => {
    const f = fixture();
    const ref = { source: 'gh', key: 'external/repo#1' };
    f.store.writeOutsideIssue(f.store.beginOutsideIssueRead(ref), {
      result: { status: 'found', issue: issue(ref.key, '', 'closed') },
    });
    vi.advanceTimersByTime(61_000);
    f.seed('o/a', [issue('o/a#1', 'Depends on external/repo#1')]);
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing([issue('o/a#1', 'Depends on external/repo#1')]);
    });
    const response = await f.service.get(project());
    expect(response.job).not.toBeNull();
    expect(response.snapshot?.fetchedAt).toBe('2026-01-01T00:01:01.000Z');
    expect(response.freshness.outsideIssues.oldestObservedAt).toBe('2026-01-01T00:00:00.000Z');
    blocked.resolve();
    await tick();
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });

  it('recomputes a project using another catalog repository as external context', async () => {
    const f = fixture();
    f.seed('o/a', [issue('o/a#1', 'Depends on o/b#1')]);
    f.seed('o/b', [issue('o/b#1')]);
    expect(
      (await f.service.get(project())).snapshot?.plan.nodes.find((n) => n.key === 'o/b#1')?.title,
    ).toBe('o/b#1');
    f.list.mockResolvedValue(listing([{ ...issue('o/b#1'), title: 'updated context' }]));
    await f.service.refresh(project('o/b'));
    const response = await f.service.get(project());
    expect(response.snapshot?.plan.nodes.find((n) => n.key === 'o/b#1')?.title).toBe(
      'updated context',
    );
    expect(response.freshness.repositories.map((r) => r.project.repo)).toEqual(['o/a', 'o/b']);
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('zero-TTL uses revalidated outside context rather than older catalog listings', async () => {
    const f = fixture(0);
    f.seed('o/b', [issue('o/b#1')]);
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on o/b#1')]));
    f.lookup.mockResolvedValue(issue('o/b#1', '', 'closed'));
    const response = await f.service.get(project());
    expect(response.snapshot?.plan.nodes.map((n) => n.key)).toEqual(['o/a#1']);
    expect(response.freshness.outsideIssues.count).toBe(1);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });
});
