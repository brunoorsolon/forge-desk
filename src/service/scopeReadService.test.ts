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
  const lookup = vi.fn<IssueProvider['getIssue']>(async () =>
    issue('external/repo#1', '', 'closed'),
  );
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
  const jobs = new ScopeRefreshJobs({ sources: [source], store, cache: { ttlSeconds } });
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
  it.each(['project', 'source'] as const)(
    'keeps same-repository closed prerequisites satisfied after a %s listing refresh',
    async (scopeKind) => {
      const f = fixture();
      f.list.mockImplementation(async ({ repo }) =>
        listing(repo === 'a' ? [issue('o/a#1', 'Depends on #2')] : []),
      );
      f.lookup.mockResolvedValue(issue('o/a#2', '', 'closed'));
      const scope = scopeKind === 'project' ? project() : all;
      await f.service.refresh(scope);
      expect(f.lookup).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 60_001);
      f.store.invalidateRepository({ source: 'gh', repo: 'o/a' });
      f.store.fail(f.store.beginOutsideIssueRead({ source: 'gh', key: 'o/a#2' }), 'Prior failure');
      const refreshed = await f.service.refresh(scope);
      expect(f.lookup).toHaveBeenCalledTimes(1);
      expect(refreshed.snapshot?.plan.nodes).toMatchObject([{ key: 'o/a#1', status: 'ready' }]);
      expect(refreshed.snapshot?.plan.warnings).toEqual([]);
      expect(refreshed.freshness.outsideIssues).toMatchObject({ count: 1, provisionalCount: 0 });
      expect(
        f.store.readOutsideIssue({ source: 'gh', key: 'o/a#2' })?.observation.lastCheckedAt,
      ).toBe(new Date().toISOString());
    },
  );

  it('detects a previously closed prerequisite reopened in the new open listing', async () => {
    const f = fixture();
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on #2')]));
    f.lookup.mockResolvedValue(issue('o/a#2', '', 'closed'));
    await f.service.refresh(project());
    vi.setSystemTime(Date.now() + 60_001);
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on #2'), issue('o/a#2')]));
    const refreshed = await f.service.refresh(project());
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(refreshed.snapshot?.plan.nodes.find((node) => node.key === 'o/a#1')?.status).toBe(
      'blocked',
    );
    expect(refreshed.snapshot?.plan.nodes.find((node) => node.key === 'o/a#2')?.status).toBe(
      'ready',
    );
  });

  it('preserves zero-TTL targeted revalidation after the same-repository listing succeeds', async () => {
    const f = fixture(0);
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on #2')]));
    f.lookup.mockResolvedValue(issue('o/a#2', '', 'closed'));
    await f.service.refresh(project());
    await f.service.refresh(project());
    expect(f.lookup).toHaveBeenCalledTimes(2);
  });

  it.each(['closed', 'open', 'missing', 'failed', 'partial'] as const)(
    'rechecks sibling context after a newer listing replaces its lookup, then paces the %s result',
    async (outcome) => {
      const f = fixture();
      f.list.mockImplementation(async ({ repo }) =>
        listing([issue(`o/${repo}#1`, repo === 'a' ? 'Depends on o/b#1' : '')]),
      );
      f.lookup.mockResolvedValue(issue('o/b#1'));
      await f.service.refresh(project());
      expect(f.jobs.lastCompleted(project())?.unitKeys).toEqual([
        'repository:o/a',
        'outside-issue:o/b#1',
      ]);
      vi.advanceTimersByTime(2000);
      await f.service.refresh(project('o/b'));
      // The sibling listing is newer, so derivation prunes the targeted record.
      expect(f.store.readOutsideIssue({ source: 'gh', key: 'o/b#1' })).toBeUndefined();
      expect((await f.service.get(project())).job).toBeNull();
      expect(f.list).toHaveBeenCalledTimes(2);
      expect(f.lookup).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      f.store.invalidateRepository({ source: 'gh', repo: 'o/b' });
      f.lookup.mockImplementation(async () => {
        if (outcome === 'failed') throw new Error('offline');
        if (outcome === 'missing') return null;
        return {
          ...issue('o/b#1', '', outcome === 'closed' ? 'closed' : 'open'),
          relationCoverage:
            outcome === 'partial' ? { native: 'failed', subIssues: 'complete' } : coverage,
        };
      });
      expect((await f.service.get(project())).job).not.toBeNull();
      await f.jobs.active(project())?.completion;
      for (let n = 0; n < 5; n++) {
        vi.advanceTimersByTime(2000);
        const read = await f.service.get(project());
        expect(read.job).toBeNull();
        expect(read.snapshot?.plan.nodes.find((node) => node.key === 'o/a#1')?.status).toBe(
          outcome === 'closed' ? 'ready' : 'blocked',
        );
      }
      expect(f.list).toHaveBeenCalledTimes(3);
      expect(f.lookup).toHaveBeenCalledTimes(2);
      expect(f.list.mock.calls.map(([repo]) => repo.repo)).toEqual(['a', 'b', 'a']);

      // A subsequent webhook must bypass pacing again, including after failure.
      f.store.invalidateRepository({ source: 'gh', repo: 'o/b' });
      f.lookup.mockResolvedValue(issue('o/b#1', '', 'closed'));
      expect((await f.service.get(project())).job).not.toBeNull();
      await f.jobs.active(project())?.completion;
      const settled = await f.service.get(project());
      expect(settled.job).toBeNull();
      expect(settled.snapshot?.plan.nodes.find((node) => node.key === 'o/a#1')?.status).toBe(
        'ready',
      );
      expect(f.list.mock.calls.map(([repo]) => repo.repo)).toEqual(['a', 'b', 'a', 'a']);
      expect(f.lookup).toHaveBeenCalledTimes(3);
    },
  );

  it('paces an invalidated transitive target unreachable behind a failed lookup', async () => {
    const f = fixture();
    f.list.mockImplementation(async ({ repo }) =>
      listing([issue(`o/${repo}#1`, repo === 'a' ? 'Depends on o/b#1' : 'Depends on ext/r#2')]),
    );
    f.lookup.mockImplementation(async (repo, number) =>
      repo.owner === 'ext' ? issue(`ext/r#${number}`, '', 'closed') : null,
    );
    await f.service.refresh(project('o/b'));
    await f.service.refresh(project());
    expect(f.lookup.mock.calls.map(([r, n]) => `${r.owner}/${r.repo}#${n}`)).toEqual([
      'ext/r#2',
      'o/b#1',
    ]);
    f.store.invalidateRepository({ source: 'gh', repo: 'ext/r' });
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      const read = await f.service.get(project());
      expect(read.job).toBeNull();
      expect(read.snapshot?.plan.nodes.find((node) => node.key === 'o/a#1')?.status).toBe(
        'blocked',
      );
      expect(read.freshness.outsideIssues.provisionalCount).toBeGreaterThan(0);
    }
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.lookup).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(50_001);
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      expect((await f.service.get(project())).job).toBeNull();
    }
    expect(f.list).toHaveBeenCalledTimes(3);
    expect(f.lookup).toHaveBeenCalledTimes(3);
    expect(f.store.readOutsideIssue({ source: 'gh', key: 'ext/r#2' })?.invalidated).toBe(true);
    await f.service.refresh(project());
    expect(f.list).toHaveBeenCalledTimes(4);
    expect(f.lookup).toHaveBeenCalledTimes(4);
    expect((await f.service.get(project())).job).toBeNull();
  });

  it('settles an invalidated dependency beyond the lookup cap until the next TTL', async () => {
    const f = fixture();
    const dependencies = Array.from({ length: 201 }, (_, n) => `ext/r#${n + 1}`).join(', ');
    f.list.mockImplementation(async ({ repo }) =>
      listing([issue(`o/${repo}#1`, `Depends on ${repo === 'a' ? dependencies : 'ext/r#201'}`)]),
    );
    f.lookup.mockImplementation(async (_repo, number) => issue(`ext/r#${number}`, '', 'closed'));
    await f.service.refresh(project('o/b'));
    await f.service.refresh(project());
    expect(f.lookup).toHaveBeenCalledTimes(201);
    f.store.invalidateRepository({ source: 'gh', repo: 'ext/r' });
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      expect((await f.service.get(project())).job).toBeNull();
    }
    expect(f.list).toHaveBeenCalledTimes(3);
    expect(f.lookup).toHaveBeenCalledTimes(401);
    expect(f.store.readOutsideIssue({ source: 'gh', key: 'ext/r#201' })?.invalidated).toBe(true);
    expect(f.store.readOutsideIssue({ source: 'gh', key: 'ext/r#1' })?.invalidated).toBe(false);
    vi.advanceTimersByTime(50_001);
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    expect((await f.service.get(project())).job).toBeNull();
    expect(f.list).toHaveBeenCalledTimes(4);
    expect(f.lookup).toHaveBeenCalledTimes(601);
    // A new webhook on a reachable target still bypasses pacing immediately.
    f.store.invalidateRepository({ source: 'gh', repo: 'ext/r' });
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    expect((await f.service.get(project())).job).toBeNull();
    expect(f.lookup).toHaveBeenCalledTimes(801);
  });

  it.each(['success', 'failed'] as const)(
    'rechecks invalidated listings joined after the webhook, despite an old %s result',
    async (outcome) => {
      const f = fixture();
      const blocked = gate();
      const ref = { source: 'gh', repo: 'o/a' };
      f.seed('o/a', [issue('o/a#1')]);
      f.seed('o/b');
      f.list.mockImplementation(async ({ repo }) => listing(repo === 'a' ? [issue('o/a#2')] : []));
      f.list.mockImplementationOnce(async () => {
        await blocked.promise;
        if (outcome === 'failed') throw new Error('old failure');
        return listing([issue('o/a#1')]);
      });
      const sweep = f.jobs.refresh(all, { priority: 'sweep' });
      await tick();
      f.store.invalidateRepository(ref);
      const joined = await f.service.get(project());
      expect(joined.job).not.toBeNull();
      const projectJob = f.jobs.active(project())!;
      expect(f.list).toHaveBeenCalledTimes(2);
      blocked.resolve();
      await Promise.all([sweep.completion, projectJob.completion]);
      expect(f.store.readRepository(ref)?.invalidated).toBe(true);
      expect((await f.service.get(project())).job).not.toBeNull();
      await f.jobs.active(project())?.completion;
      const settled = await f.service.get(project());
      expect(settled.job).toBeNull();
      expect(settled.freshness.repositories[0]?.state).toBe('fresh');
      expect(settled.snapshot?.plan.nodes.map((n) => n.key)).toEqual(['o/a#2']);
      expect(f.list).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['success', 'failed'] as const)(
    'rechecks invalidated outside context joined after the webhook, despite an old %s result',
    async (outcome) => {
      const f = fixture();
      const blocked = gate();
      const body = 'Depends on ext/r#1';
      f.seed('o/a', [issue('o/a#1', body)]);
      f.seed('o/b', [issue('o/b#1', body)]);
      f.list.mockImplementation(async ({ repo }) => listing([issue(`o/${repo}#1`, body)]));
      f.lookup.mockResolvedValue(issue('ext/r#1', '', 'closed'));
      f.lookup.mockImplementationOnce(async () => {
        await blocked.promise;
        return outcome === 'failed' ? null : issue('ext/r#1');
      });
      const other = f.jobs.refresh(project('o/b'));
      await tick();
      f.store.invalidateRepository({ source: 'gh', repo: 'ext/r' });
      const joined = f.jobs.refresh(project());
      await tick();
      expect(f.lookup).toHaveBeenCalledTimes(1);
      blocked.resolve();
      await Promise.all([other.completion, joined.completion]);
      expect(f.store.readOutsideIssue({ source: 'gh', key: 'ext/r#1' })?.invalidated).toBe(true);
      expect((await f.service.get(project())).job).not.toBeNull();
      await f.jobs.active(project())?.completion;
      const settled = await f.service.get(project());
      expect(settled.job).toBeNull();
      expect(settled.snapshot?.plan.nodes.find((n) => n.key === 'o/a#1')?.status).toBe('ready');
      expect(f.lookup).toHaveBeenCalledTimes(2);
      expect(f.list.mock.calls.map(([r]) => r.repo)).toEqual(['b', 'a', 'a']);
    },
  );

  it('ignores unrelated repository webhooks while capped scope work is paced', async () => {
    const f = fixture();
    f.list.mockResolvedValue(
      listing([
        issue(
          'o/a#1',
          `Depends on ${Array.from({ length: 201 }, (_, n) => `ext/r#${n + 1}`).join(', ')}`,
        ),
      ]),
    );
    f.lookup.mockImplementation(async (_repo, number) => issue(`ext/r#${number}`, '', 'closed'));
    await f.service.get(project());
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      f.store.invalidateRepository({ source: 'gh', repo: 'o/b' });
      const read = await f.service.get(project());
      expect(read.job).toBeNull();
      expect(read.freshness.outsideIssues).toMatchObject({ count: 201, provisionalCount: 1 });
    }
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(200);
  });

  it.each(['open', 'closed', 'failed'] as const)(
    'revalidates a previously closed prerequisite and uses the %s result with zero TTL',
    async (outcome) => {
      const f = fixture(0);
      f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on external/repo#1')]));
      await f.service.refresh(project());
      expect(f.lookup).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 86_400_000);
      if (outcome === 'failed') f.lookup.mockRejectedValueOnce(new Error('offline'));
      else f.lookup.mockResolvedValueOnce(issue('external/repo#1', '', outcome));
      const refreshed = await f.service.refresh(project());
      expect(f.list).toHaveBeenCalledTimes(2);
      expect(f.lookup).toHaveBeenCalledTimes(2);
      expect(refreshed.freshness.outsideIssues).toMatchObject({
        count: 1,
        provisionalCount: outcome === 'failed' ? 1 : 0,
      });
      expect(refreshed.snapshot?.plan.nodes.find((node) => node.key === 'o/a#1')?.status).toBe(
        outcome === 'closed' ? 'ready' : 'blocked',
      );
      expect(
        refreshed.snapshot?.plan.warnings.some(
          (warning) => warning.code === 'dependency-provisional',
        ),
      ).toBe(outcome === 'failed');
    },
  );

  it('settles capped dependency work for one TTL, then retries or honors explicit refresh', async () => {
    const f = fixture();
    f.list.mockResolvedValue(
      listing([
        issue(
          'o/a#1',
          `Depends on ${Array.from({ length: 201 }, (_, n) => `ext/r#${n + 1}`).join(', ')}`,
        ),
      ]),
    );
    f.lookup.mockImplementation(async (_repo, number) => issue(`ext/r#${number}`, '', 'closed'));
    const first = await f.service.get(project());
    expect(first.job).toBeNull();
    expect(first.freshness.outsideIssues).toMatchObject({ count: 201, provisionalCount: 1 });
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      const read = await f.service.get(project());
      expect(read.job).toBeNull();
      expect(read.freshness.outsideIssues.provisionalCount).toBe(1);
      expect(read.snapshot?.plan.warnings.some((w) => w.code === 'dependency-provisional')).toBe(
        true,
      );
    }
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(200);
    vi.advanceTimersByTime(50_001);
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.lookup).toHaveBeenCalledTimes(400);
    const refreshed = await f.service.refresh(project());
    expect(f.list).toHaveBeenCalledTimes(3);
    // The 200 just-checked closed observations leave the budget for the last dependency.
    expect(f.lookup).toHaveBeenCalledTimes(401);
    expect(refreshed.freshness.outsideIssues).toMatchObject({ count: 201, provisionalCount: 0 });
  });

  it('settles unvisited transitive dependencies behind a failed sibling lookup', async () => {
    const f = fixture();
    f.seed('o/b', [issue('o/b#1', 'Depends on ext/r#2')]);
    vi.advanceTimersByTime(61_000);
    f.seed('o/a', [issue('o/a#1', 'Depends on o/b#1')]);
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on o/b#1')]));
    f.lookup.mockResolvedValue(null);
    await f.service.refresh(project());
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      const read = await f.service.get(project());
      expect(read.job).toBeNull();
      expect(read.freshness.outsideIssues).toMatchObject({ count: 2, provisionalCount: 2 });
      expect(read.snapshot?.plan.nodes.find((i) => i.key === 'o/a#1')?.status).toBe('blocked');
    }
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.lookup.mock.calls.map(([r, n]) => `${r.owner}/${r.repo}#${n}`)).toEqual(['o/b#1']);
  });

  it('counts the retry TTL from completion rather than the start of a long partial job', async () => {
    const f = fixture();
    const blocked = gate();
    f.seed('o/a');
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return {
        ...listing([issue('o/a#1')]),
        relationCoverage: { native: 'failed', subIssues: 'complete' },
      };
    });
    const job = f.jobs.refresh(project());
    await tick();
    vi.advanceTimersByTime(70_000);
    blocked.resolve();
    await job.completion;
    vi.advanceTimersByTime(59_000);
    expect((await f.service.get(project('O/A'))).job).toBeNull();
    expect(f.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('does not defer invalidation that arrived during a job, and does not leak pacing across scopes', async () => {
    const f = fixture();
    const blocked = gate();
    const ref = { source: 'gh', repo: 'o/a' };
    f.seed('o/a');
    f.list.mockImplementationOnce(async () => {
      await blocked.promise;
      return listing([issue('o/a#1')]);
    });
    const refresh = f.service.refresh(project());
    await tick();
    f.store.invalidateRepository(ref);
    blocked.resolve();
    await refresh;
    expect(f.store.readRepository(ref)?.invalidated).toBe(true);
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    expect((await f.service.get(project())).job).toBeNull();
    expect(f.list).toHaveBeenCalledTimes(2);
    await f.service.get(project('o/b'));
    expect(f.list).toHaveBeenCalledTimes(3);
    expect(f.list.mock.calls[2]?.[0]).toEqual({ owner: 'o', repo: 'b' });
  });

  it('paces completed partial relation reads from completion, including externally launched jobs', async () => {
    const f = fixture();
    f.seed('o/a', [issue('o/a#1')]);
    vi.advanceTimersByTime(61_000);
    f.list.mockResolvedValue({
      ...listing([issue('o/a#1')]),
      relationCoverage: { native: 'failed', subIssues: 'complete' },
    });
    await f.jobs.refresh(project(), { priority: 'sweep' }).completion;
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      const read = await f.service.get(project());
      expect(read.job).toBeNull();
      expect(read.freshness.repositories[0]).toMatchObject({ state: 'stale', partial: true });
    }
    expect(f.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50_001);
    expect((await f.service.get(project())).job).not.toBeNull();
    await f.jobs.active(project())?.completion;
    expect(f.list).toHaveBeenCalledTimes(2);
  });

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

  it.each(['success', 'failure'] as const)(
    'reports a covering source job after the refresh wait expires, then clears it on %s',
    async (outcome) => {
      const f = fixture(3600);
      f.seed('o/a', [issue('o/a#1')]);
      f.seed('o/b');
      const blocked = gate();
      f.list.mockImplementation(async ({ repo }) => {
        await blocked.promise;
        if (outcome === 'failure') throw new Error('source refresh failed');
        return listing([issue(`o/${repo}#2`)]);
      });
      const pending = f.service.refresh(all);
      await vi.advanceTimersByTimeAsync(15_000);
      const refreshed = await pending;
      expect(refreshed.job).toMatchObject({ scope: all, state: 'running' });
      const active = f.jobs.active(all)!;

      for (let n = 0; n < 3; n++) {
        const response = await f.service.get(project());
        expect(response.scope).toEqual(project());
        expect(response.job).toMatchObject({ id: refreshed.job!.id, scope: all });
        expect(response.snapshot?.plan.nodes[0]?.key).toBe('o/a#1');
        expect(response.freshness.repositories[0]?.state).toBe('updating');
        expect(f.jobs.active(project())).toBeNull();
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(f.service.cached(project()).job?.id).toBe(refreshed.job!.id);
      expect(f.list).toHaveBeenCalledTimes(2);

      blocked.resolve();
      await active.completion;
      const settled = await f.service.get(project());
      expect(settled.job).toBeNull();
      expect(settled.snapshot?.plan.nodes[0]?.key).toBe(outcome === 'success' ? 'o/a#2' : 'o/a#1');
      expect(settled.freshness.repositories[0]?.state).toBe(
        outcome === 'success' ? 'fresh' : 'failed',
      );
      expect(f.list).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps a queued source job visible on its project throughout cooldown', async () => {
    const f = fixture(3600);
    f.seed('o/a', [issue('o/a#1')]);
    f.seed('o/b');
    f.cooldown(Date.now() + 60_000);
    f.list.mockImplementation(async ({ repo }) => listing([issue(`o/${repo}#2`)]));
    const refreshed = await f.service.refresh(all);
    const active = f.jobs.active(all)!;
    expect(refreshed.job).toMatchObject({ scope: all, state: 'queued' });
    const delayed = await f.service.get(project());
    expect(delayed.job?.id).toBe(refreshed.job!.id);
    expect(delayed.freshness.repositories[0]?.state).toBe('delayed');
    expect(f.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await active.completion;
    const settled = await f.service.get(project());
    expect(settled.job).toBeNull();
    expect(settled.snapshot?.plan.nodes[0]?.key).toBe('o/a#2');
    expect(settled.freshness.repositories[0]?.state).toBe('fresh');
  });

  it('reports covering source jobs in related lanes but not unrelated project jobs', async () => {
    const f = fixture(3600);
    f.seed('o/a');
    f.seed('o/b');
    const related = new ScopeRefreshJobs({
      sources: [f.source],
      store: f.store,
      cache: { ttlSeconds: 3600 },
    });
    const service = new ScopeReadService({
      sources: [f.source],
      store: f.store,
      jobs: f.jobs,
      relatedJobs: [related],
      cache: { ttlSeconds: 3600 },
    });
    const blocked = gate();
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing();
    });
    const sibling = related.refresh(project('o/b'));
    expect((await service.get(project())).job).toBeNull();
    const source = related.refresh(all);
    expect((await service.get(project())).job?.id).toBe(source.status.id);
    const own = f.jobs.refresh(project());
    expect((await service.get(project())).job?.id).toBe(own.status.id);
    blocked.resolve();
    await Promise.all([sibling.completion, source.completion, own.completion]);
    expect((await service.get(project())).job).toBeNull();
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
    expect(response.snapshot?.plan.warnings.some((w) => w.code === 'stale-data')).toBe(false);
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
    expect(response.job).toBeNull();
    const refresh = f.service.refresh(project());
    blocked.resolve();
    await refresh;
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

  it.each(['open', 'closed'] as const)(
    'settles a project with fresh targeted %s context instead of a stale sibling listing',
    async (state) => {
      const f = fixture();
      f.seed('o/b', [issue('o/b#1')]);
      vi.advanceTimersByTime(61_000);
      f.seed('o/a', [issue('o/a#1', 'Depends on o/b#1')]);
      f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on o/b#1')]));
      f.lookup.mockResolvedValue({ ...issue('o/b#1', '', state), title: 'targeted context' });
      expect((await f.service.get(project())).job).not.toBeNull();
      await tick();
      for (let n = 0; n < 5; n++) {
        vi.advanceTimersByTime(2000);
        const response = await f.service.get(project());
        expect(response.job).toBeNull();
        expect(response.freshness.repositories.map((r) => r.project.repo)).toEqual(['o/a']);
        expect(response.freshness.outsideIssues).toMatchObject({ count: 1, provisionalCount: 0 });
        const context = response.snapshot?.plan.nodes.find((i) => i.key === 'o/b#1');
        if (state === 'closed') expect(context).toBeUndefined();
        else expect(context?.title).toBe('targeted context');
      }
      expect(f.list).toHaveBeenCalledTimes(1);
      expect(f.list.mock.calls[0]?.[0]).toEqual({ owner: 'o', repo: 'a' });
      expect(f.lookup).toHaveBeenCalledTimes(1);
      expect(f.store.readOutsideIssue({ source: 'gh', key: 'o/b#1' })).toBeDefined();
    },
  );

  it('retains sibling context after a failed targeted lookup without repeatedly relisting', async () => {
    const f = fixture();
    f.seed('o/b', [{ ...issue('o/b#1'), title: 'last-good context' }]);
    vi.advanceTimersByTime(61_000);
    f.seed('o/a', [issue('o/a#1', 'Depends on o/b#1')]);
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on o/b#1')]));
    f.lookup.mockResolvedValue(null);
    await f.service.get(project());
    await tick();
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      const response = await f.service.get(project());
      expect(response.job).toBeNull();
      expect(response.snapshot?.plan.nodes.find((i) => i.key === 'o/b#1')?.title).toBe(
        'last-good context',
      );
      expect(
        response.snapshot?.plan.warnings.some((w) => w.code === 'dependency-provisional'),
      ).toBe(true);
      expect(response.freshness.outsideIssues.provisionalCount).toBe(1);
    }
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });

  it('paces inaccessible dependency retries by the failed attempt TTL', async () => {
    const f = fixture();
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on private/repo#9')]));
    f.lookup.mockResolvedValue(null);
    await f.service.get(project());
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(2000);
      const response = await f.service.get(project());
      expect(response.job).toBeNull();
      expect(
        response.snapshot?.plan.warnings.some((w) => w.code === 'dependency-provisional'),
      ).toBe(true);
    }
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50_001);
    expect((await f.service.get(project())).job).not.toBeNull();
    await tick();
    expect(f.lookup).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'paces failed repository retries with last-good data=%s',
    async (seeded) => {
      const f = fixture();
      if (seeded) f.seed('o/a', [issue('o/a#1')]);
      vi.advanceTimersByTime(61_000);
      f.list.mockRejectedValue(new Error('offline'));
      const failed = await f.service.refresh(project());
      expect(failed.freshness.repositories[0]?.state).toBe(seeded ? 'failed' : 'unavailable');
      for (let n = 0; n < 5; n++) {
        vi.advanceTimersByTime(2000);
        const response = await f.service.get(project());
        expect(response.job).toBeNull();
        expect(response.freshness.repositories[0]?.error).toBe('offline');
        expect(response.snapshot === null).toBe(!seeded);
      }
      expect(f.list).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(50_001);
      await f.service.get(project());
      await tick();
      expect(f.list).toHaveBeenCalledTimes(2);
      // An explicit request bypasses passive retry pacing.
      await f.service.refresh(project());
      expect(f.list).toHaveBeenCalledTimes(3);
    },
  );

  it('paces a failed invalidation recheck while honoring a newer invalidation immediately', async () => {
    const f = fixture();
    const ref = { source: 'gh', repo: 'o/a' };
    f.seed('o/a', [issue('o/a#1')]);
    f.store.invalidateRepository(ref);
    f.list.mockRejectedValue(new Error('offline'));
    expect((await f.service.get(project())).job).not.toBeNull();
    await tick();
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(2000);
      expect((await f.service.get(project())).job).toBeNull();
    }
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.store.readRepository(ref)?.invalidated).toBe(true);
    f.store.invalidateRepository(ref);
    expect((await f.service.get(project())).job).not.toBeNull();
    await tick();
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('does not let a failed read started before invalidation defer the required recheck', async () => {
    const f = fixture();
    const ref = { source: 'gh', repo: 'o/a' };
    f.seed('o/a');
    const oldRead = f.store.beginRepositoryRead(ref);
    f.store.invalidateRepository(ref);
    f.store.fail(oldRead, 'old failure');
    expect((await f.service.get(project())).job).not.toBeNull();
    await tick();
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.store.readRepository(ref)?.invalidated).toBe(false);
  });

  it('keeps zero-TTL successful roots and provisional edges after a dependency fails', async () => {
    const f = fixture(0);
    f.seed('o/a', [issue('o/a#99')]);
    f.store.writeOutsideIssue(
      f.store.beginOutsideIssueRead({ source: 'gh', key: 'private/repo#9' }),
      {
        result: { status: 'found', issue: { ...issue('private/repo#9'), title: 'cached secret' } },
      },
    );
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Depends on private/repo#9')]));
    f.lookup.mockResolvedValue(null);
    const response = await f.service.get(project());
    expect(response.job).toBeNull();
    expect(response.freshness.computedAt).not.toBeNull();
    expect(response.snapshot?.plan.nodes.map((n) => n.key)).toEqual(['o/a#1', 'private/repo#9']);
    expect(response.snapshot?.plan.nodes.find((n) => n.key === 'private/repo#9')?.title).not.toBe(
      'cached secret',
    );
    expect(response.snapshot?.plan.nodes.find((n) => n.key === 'o/a#1')?.status).toBe('blocked');
    expect(response.snapshot?.plan.warnings.some((w) => w.code === 'dependency-provisional')).toBe(
      true,
    );
  });

  it('keeps zero-TTL successful repository updates without failed repositories cached data', async () => {
    const f = fixture(0);
    f.seed('o/b', [issue('o/b#99')]);
    f.list.mockImplementation(async ({ repo }) => {
      if (repo === 'b') throw new Error('offline');
      return listing([issue('o/a#1')]);
    });
    const response = await f.service.get(all);
    expect(response.job).toBeNull();
    expect(response.snapshot?.plan.nodes.map((n) => n.key)).toEqual(['o/a#1']);
    expect(response.snapshot?.plan.warnings.some((w) => w.code === 'repository-unlisted')).toBe(
      true,
    );
    expect(response.freshness.repositories.map((r) => r.state)).toEqual(['fresh', 'failed']);
  });

  it.each(['project', 'source'] as const)(
    'reports successful zero-TTL %s revalidation fresh after elapsed time',
    async (kind) => {
      const f = fixture(0);
      const laterRepository = gate();
      f.list.mockImplementation(async ({ repo }) => {
        if (repo === 'b') {
          await laterRepository.promise;
          vi.setSystemTime(Date.now() + 5);
        }
        return listing([
          issue(`o/${repo}#1`, kind === 'project' ? 'Depends on external/repo#1' : ''),
        ]);
      });
      f.lookup.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 5);
        return issue('external/repo#1', '', 'closed');
      });
      const pending = f.service.get(kind === 'project' ? project() : all);
      await tick();
      laterRepository.resolve();
      const response = await pending;
      expect(response.snapshot).not.toBeNull();
      expect(response.job).toBeNull();
      expect(response.freshness.repositories.every((r) => r.state === 'fresh')).toBe(true);
      if (kind === 'source')
        expect(response.freshness.repositories.map((r) => r.lastCheckedAt)).toEqual([
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.005Z',
        ]);
    },
  );
});
