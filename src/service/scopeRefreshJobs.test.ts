import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYWORDS, type ResolvedPlanningPolicy } from '../config/schema.js';
import { parseKey } from '../core/keys.js';
import type { Scope } from '../core/scope.js';
import type { FetchResult, Issue, IssueProvider, RelationCoverage } from '../core/types.js';
import { createHttpClient } from '../providers/http.js';
import { AdmissionQueue } from './admissionQueue.js';
import { ObservationStore } from './observationStore.js';
import {
  ScopeRefreshError,
  ScopeRefreshJobs,
  type ScopeRefreshSource,
} from './scopeRefreshJobs.js';

const complete: RelationCoverage = { native: 'complete', subIssues: 'complete' };
const policy: ResolvedPlanningPolicy = {
  dependencies: { native: true, body: true, subIssues: true, keywords: DEFAULT_KEYWORDS },
  ordering: { priorityLabels: [], mode: 'priority' },
};
const project = (repo = 'owner/a', source = 'gh'): Scope => ({ kind: 'project', source, repo });
const sourceScope = (source = 'gh'): Scope => ({ kind: 'source', source });
const listing = (issues: Issue[] = [], relationCoverage = complete): FetchResult => ({
  issues,
  warnings: [],
  relationCoverage,
});
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const issue = (key: string, body = '', state: 'open' | 'closed' = 'open'): Issue => ({
  ...parseKey(key),
  key,
  title: key,
  body,
  state,
  url: `https://forge.test/${key.replace('#', '/issues/')}`,
  labels: [],
  assignees: [],
  milestone: null,
  updatedAt: null,
  nativeRelations: [],
  relationCoverage: complete,
});
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

interface Call {
  path: string;
  options: { native: string | null; subIssues: string | null };
  at: number;
}
const queues: AdmissionQueue[] = [];
function fixture(
  handle: (path: string, call: number) => Promise<Response> | Response,
  options: {
    id?: string;
    repos?: string[];
    concurrency?: number;
    requestsPerMinute?: number;
    cooldownUntil?: () => number | null;
  } = {},
) {
  const calls: Call[] = [];
  let active = 0;
  let maxActive = 0;
  const queue = new AdmissionQueue({
    concurrency: options.concurrency ?? 4,
    requestsPerMinute: options.requestsPerMinute ?? 1000,
    cooldownUntil: () => options.cooldownUntil?.() ?? client.cooldownUntil(),
  });
  queues.push(queue);
  const client = createHttpClient({
    baseUrl: 'https://forge.test',
    headers: {},
    maxRetries: 0,
    fetch: queue.wrapFetch(async (input) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        at: Date.now(),
        options: {
          native: url.searchParams.get('native'),
          subIssues: url.searchParams.get('subIssues'),
        },
      });
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await handle(url.pathname, calls.length);
      } finally {
        active--;
      }
    }),
  });
  const provider: IssueProvider = {
    kind: 'github',
    cooldownUntil: () => client.cooldownUntil(),
    listOpenIssues: async (repo, opts) =>
      (
        await client.getJson<FetchResult>(
          `/repos/${repo.owner}/${repo.repo}?native=${opts.native}&subIssues=${opts.subIssues}`,
        )
      ).data,
    getIssue: async (repo, number, opts) =>
      (
        await client.getJson<Issue | null>(
          `/repos/${repo.owner}/${repo.repo}/issues/${number}?native=${opts?.native}&subIssues=${opts?.subIssues}`,
        )
      ).data,
  };
  const id = options.id ?? 'gh';
  const input: ScopeRefreshSource = {
    source: { id, webUrl: 'https://forge.test', planning: structuredClone(policy) },
    catalog: {
      id,
      kind: 'github',
      policy: { status: 'usable' },
      projects: (options.repos ?? ['owner/a', 'owner/b']).map((repo) => ({ source: id, repo })),
    },
    provider,
    queue,
  };
  return { input, calls, maxActive: () => maxActive };
}
function service(...sources: ScopeRefreshSource[]) {
  const store = new ObservationStore();
  const jobs = new ScopeRefreshJobs({ sources, store, cache: { ttlSeconds: 60 } });
  return { jobs, store };
}

describe('scope refresh jobs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-01-01T00:00:00Z');
  });
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((queue) => queue.close()));
    vi.useRealTimers();
  });

  it('retains a detached set of completed unit keys, including failed lookups', async () => {
    const f = fixture((path) =>
      path === '/repos/owner/a'
        ? json(listing([issue('owner/a#1', 'Depends on other/lib#1')]))
        : path === '/repos/owner/b'
          ? json(listing())
          : json(null),
    );
    const { jobs } = service(f.input);
    expect(jobs.lastCompleted(project())).toBeNull();
    await jobs.refresh(project()).completion;
    const completed = jobs.lastCompleted(project())!;
    expect(completed.unitKeys).toEqual(['repository:owner/a', 'outside-issue:other/lib#1']);
    completed.unitKeys.length = 0;
    expect(jobs.lastCompleted(project())?.unitKeys).toEqual([
      'repository:owner/a',
      'outside-issue:other/lib#1',
    ]);
    await jobs.refresh(project('owner/b')).completion;
    expect(jobs.lastCompleted(project('owner/b'))?.unitKeys).toEqual(['repository:owner/b']);
    expect(jobs.lastCompleted(project())?.unitKeys).toHaveLength(2);
  });

  it('lists only the project and resolves outside dependencies breadth-first with policy options', async () => {
    const first = issue('other/lib#1', 'Blocked by: other/lib#3');
    first.nativeRelations = [
      { kind: 'blocked-by', source: 'sub-issue', ref: { owner: 'other', repo: 'lib', number: 4 } },
    ];
    const firstWave = gate();
    const f = fixture(async (path) => {
      if (path === '/repos/other/lib/issues/2') await firstWave.promise;
      if (path === '/repos/owner/a')
        return json(
          listing([
            issue('owner/a#1', 'Blocked by: other/lib#1, other/lib#2\nParent: other/lib#99'),
          ]),
        );
      const number = Number(path.split('/').at(-1));
      return json(
        number === 1
          ? first
          : number === 2
            ? issue('other/lib#2', 'Blocked by: other/lib#5', 'closed')
            : issue(`other/lib#${number}`),
      );
    });
    const { jobs, store } = service(f.input);
    const job = jobs.refresh(project());
    expect(job.status.units).toMatchObject([{ kind: 'repository', state: 'queued' }]);
    await tick();
    expect(f.calls.map((c) => c.path).sort()).toEqual([
      '/repos/other/lib/issues/1',
      '/repos/other/lib/issues/2',
      '/repos/owner/a',
    ]);
    firstWave.resolve();
    const result = await job.completion;
    expect(f.calls.map((c) => c.path).sort()).toEqual([
      '/repos/other/lib/issues/1',
      '/repos/other/lib/issues/2',
      '/repos/other/lib/issues/3',
      '/repos/other/lib/issues/4',
      '/repos/owner/a',
    ]);
    expect(
      f.calls.every((c) => c.options.native === 'true' && c.options.subIssues === 'true'),
    ).toBe(true);
    expect(store.readOutsideIssue({ source: 'gh', key: 'other/lib#1' })?.observation).toMatchObject(
      { result: { status: 'found', issue: first }, relationCoverage: complete },
    );
    expect(result).toMatchObject({
      scope: project(),
      priority: 'interactive',
      trigger: 'interactive',
      state: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.units).toHaveLength(5);
    expect(
      result.units.every((unit) => unit.state === 'checked' && unit.lastCheckedAt !== null),
    ).toBe(true);
    expect(jobs.active(project())).toBeNull();
    expect(job.status).toEqual(result);
  });

  it('lists the complete source catalog, including empty projects, before resolving outside issues', async () => {
    const f = fixture(
      (path) => {
        if (path === '/repos/owner/a')
          return json(listing([issue('owner/a#1', 'Blocked by: owner/b#1, other/lib#1')]));
        if (path === '/repos/owner/b')
          return json(listing([issue('owner/b#1', 'Blocked by: other/lib#1')]));
        if (path === '/repos/owner/empty') return json(listing());
        return json(issue('other/lib#1'));
      },
      { repos: ['owner/a', 'owner/b', 'owner/empty'] },
    );
    const { jobs, store } = service(f.input);
    expect((await jobs.refresh(sourceScope()).completion).state).toBe('completed');
    expect(f.calls.map((c) => c.path).sort()).toEqual([
      '/repos/other/lib/issues/1',
      '/repos/owner/a',
      '/repos/owner/b',
      '/repos/owner/empty',
    ]);
    expect(store.readRepository({ source: 'gh', repo: 'owner/empty' })?.observation).toMatchObject({
      issues: [],
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it.each([0, 59_999, 60_000])(
    'reuses a stored closed prerequisite aged %i ms without changing its observation',
    async (age) => {
      const f = fixture(() => json(listing([issue('owner/a#1', 'Depends on other/lib#1')])));
      const { jobs, store } = service(f.input);
      const ref = { source: 'gh', key: 'other/lib#1' };
      store.writeOutsideIssue(store.beginOutsideIssueRead(ref), {
        result: {
          status: 'found',
          issue: issue(ref.key, 'Depends on other/lib#2', 'closed'),
        },
      });
      const before = store.readOutsideIssue(ref);
      vi.setSystemTime(Date.now() + age);
      const result = await jobs.refresh(project()).completion;
      expect(result.state).toBe('completed');
      expect(result.units).toMatchObject([{ kind: 'repository', state: 'checked' }]);
      expect(result.units).toHaveLength(1);
      expect(f.calls.map((call) => call.path)).toEqual(['/repos/owner/a']);
      expect(jobs.lastCompleted(project())?.unitKeys).toEqual(['repository:owner/a']);
      expect(store.readOutsideIssue(ref)).toEqual(before);
    },
  );

  it.each([
    'unknown',
    'unattempted',
    'open',
    'missing',
    'failed',
    'invalidated',
    'expired',
    'other-source',
  ])('fetches a %s outside prerequisite rather than reusing it', async (condition) => {
    const ref = { source: 'gh', key: 'other/lib#1' };
    const f = fixture((path) =>
      json(
        path === '/repos/owner/a'
          ? listing([issue('owner/a#1', `Depends on ${ref.key}`)])
          : issue(ref.key),
      ),
    );
    const { jobs, store } = service(f.input);
    if (condition === 'unattempted') store.beginOutsideIssueRead(ref);
    else if (condition !== 'unknown') {
      const storedRef = condition === 'other-source' ? { ...ref, source: 'elsewhere' } : ref;
      store.writeOutsideIssue(store.beginOutsideIssueRead(storedRef), {
        result:
          condition === 'missing'
            ? { status: 'missing' }
            : {
                status: 'found',
                issue: issue(ref.key, '', condition === 'open' ? 'open' : 'closed'),
              },
      });
    }
    if (condition === 'failed') store.fail(store.beginOutsideIssueRead(ref), 'Latest read failed');
    if (condition === 'invalidated')
      store.invalidateRepository({ source: ref.source, repo: 'other/lib' });
    if (condition === 'expired') vi.setSystemTime(Date.now() + 60_001);
    const result = await jobs.refresh(project()).completion;
    expect(result.state).toBe('completed');
    expect(result.units).toMatchObject([
      { kind: 'repository', state: 'checked' },
      { kind: 'outside-issue', key: ref.key, state: 'checked' },
    ]);
    expect(f.calls.map((call) => call.path)).toEqual([
      '/repos/owner/a',
      '/repos/other/lib/issues/1',
    ]);
    expect(store.readOutsideIssue(ref)?.observation.result).toMatchObject({
      status: 'found',
      issue: { state: 'open' },
    });
  });

  it('does not expire trusted closed observations when the TTL is zero', async () => {
    const f = fixture(() => json(listing([issue('owner/a#1', 'Depends on other/lib#1')])));
    const store = new ObservationStore();
    const jobs = new ScopeRefreshJobs({ sources: [f.input], store, cache: { ttlSeconds: 0 } });
    const ref = { source: 'gh', key: 'other/lib#1' };
    store.writeOutsideIssue(store.beginOutsideIssueRead(ref), {
      result: { status: 'found', issue: issue(ref.key, '', 'closed') },
    });
    vi.setSystemTime(Date.now() + 86_400_000);
    expect((await jobs.refresh(project()).completion).state).toBe('completed');
    expect(f.calls.map((call) => call.path)).toEqual(['/repos/owner/a']);
  });

  it.each(['verified', 'expired', 'invalidated', 'failed'])(
    'checks the shared observation again for a later breadth-first level after it is %s',
    async (change) => {
      const firstLevel = gate();
      const f = fixture(async (path) => {
        if (path === '/repos/owner/a')
          return json(listing([issue('owner/a#1', 'Depends on other/lib#1')]));
        if (path === '/repos/other/lib/issues/1') {
          await firstLevel.promise;
          return json(issue('other/lib#1', 'Depends on other/lib#2'));
        }
        return json(issue('other/lib#2'));
      });
      const { jobs, store } = service(f.input);
      const ref = { source: 'gh', key: 'other/lib#2' };
      const seed = () =>
        store.writeOutsideIssue(store.beginOutsideIssueRead(ref), {
          result: { status: 'found', issue: issue(ref.key, '', 'closed') },
        });
      if (change !== 'verified') seed();
      const job = jobs.refresh(project());
      await tick();
      if (change === 'verified') seed();
      if (change === 'expired') vi.setSystemTime(Date.now() + 60_001);
      if (change === 'invalidated') store.invalidateRepository({ source: 'gh', repo: 'other/lib' });
      if (change === 'failed') store.fail(store.beginOutsideIssueRead(ref), 'Concurrent failure');
      firstLevel.resolve();
      expect((await job.completion).state).toBe('completed');
      expect(f.calls.map((call) => call.path)).toEqual([
        '/repos/owner/a',
        '/repos/other/lib/issues/1',
        ...(change === 'verified' ? [] : ['/repos/other/lib/issues/2']),
      ]);
    },
  );

  it('does not charge reused closed observations to the 200-lookup budget', async () => {
    const cachedKeys = Array.from({ length: 205 }, (_, index) => `other/lib#${index + 1}`);
    const f = fixture((path) =>
      json(
        path === '/repos/owner/a'
          ? listing([
              issue('owner/a#1', `Depends on ${[...cachedKeys, 'other/lib#206'].join(', ')}`),
            ])
          : issue('other/lib#206'),
      ),
    );
    const { jobs, store } = service(f.input);
    for (const key of cachedKeys) {
      store.writeOutsideIssue(store.beginOutsideIssueRead({ source: 'gh', key }), {
        result: { status: 'found', issue: issue(key, '', 'closed') },
      });
    }
    const result = await jobs.refresh(project()).completion;
    expect(result).toMatchObject({ state: 'completed', error: null });
    expect(result.units).toHaveLength(2);
    expect(f.calls.map((call) => call.path)).toEqual([
      '/repos/owner/a',
      '/repos/other/lib/issues/206',
    ]);
  });

  it('joins identical jobs and shares listing and outside-issue units across scopes', async () => {
    const listings = gate();
    const lookups = gate();
    const f = fixture(async (path) => {
      if (!path.includes('/issues/')) {
        await listings.promise;
        return json(listing([issue(`${path.slice(7)}#1`, 'Blocked by: other/lib#1')]));
      }
      await lookups.promise;
      return json(issue('other/lib#1'));
    });
    const { jobs } = service(f.input);
    const all = jobs.refresh(sourceScope(), { priority: 'sweep' });
    const one = jobs.refresh(project());
    expect(jobs.refresh(project('OWNER/A'))).toBe(one);
    expect(jobs.refresh(sourceScope())).toBe(all);
    expect(all.status.priority).toBe('interactive');
    expect(all.status.trigger).toBe('scheduled');
    await tick();
    expect(f.calls).toHaveLength(2);
    expect(all.status.state).toBe('running');
    listings.resolve();
    await tick();
    expect(f.calls).toHaveLength(3);
    lookups.resolve();
    const results = await Promise.all([all.completion, one.completion]);
    expect(results.every((s) => s.state === 'completed')).toBe(true);
    expect(results[0]!.units).toHaveLength(3);
    expect(results[1]!.units).toHaveLength(2);
    const copy = one.status;
    copy.units.splice(0);
    copy.scope.source = 'mutated';
    expect(one.status.units).toHaveLength(2);
    expect(one.status.scope.source).toBe('gh');
    expect(jobs.refresh(project())).not.toBe(one);
    await jobs.active(project())!.completion;
    expect(f.calls).toHaveLength(5);
  });

  it('promotes an already queued sweep job and shared units ahead of queued sweep work', async () => {
    const blocker = gate();
    const f = fixture(
      async (path) => {
        if (path.endsWith('/a')) await blocker.promise;
        return json(listing());
      },
      { repos: ['owner/a', 'owner/b', 'owner/c'], concurrency: 1 },
    );
    const { jobs } = service(f.input);
    const first = jobs.refresh(project());
    const sweep = jobs.refresh(project('owner/b'), { priority: 'sweep' });
    const promoted = jobs.refresh(project('owner/c'), { priority: 'sweep' });
    await tick();
    expect(f.calls.map((c) => c.path)).toEqual(['/repos/owner/a']);
    expect(jobs.refresh(project('owner/c'))).toBe(promoted);
    blocker.resolve();
    await Promise.all([first.completion, sweep.completion, promoted.completion]);
    expect(f.calls.map((c) => c.path)).toEqual([
      '/repos/owner/a',
      '/repos/owner/c',
      '/repos/owner/b',
    ]);
    // Promoting a completed key must not resurrect its queue unit.
    f.input.queue.promote('repository:owner/c');
    await tick();
    expect(f.calls).toHaveLength(3);
  });

  it('retains last-good failures, finishes other units, and follows retained outside relations', async () => {
    const f = fixture((path) => {
      if (path === '/repos/owner/a' || path.endsWith('/issues/1'))
        return new Response('', { status: 500 });
      if (path === '/repos/owner/b')
        return json(listing([issue('owner/b#1', 'Blocked by: other/lib#3')]));
      if (path.endsWith('/issues/3')) return json(null);
      return json(issue('other/lib#2'));
    });
    const { jobs, store } = service(f.input);
    const root = { source: 'gh', repo: 'owner/a' };
    const outside = { source: 'gh', key: 'other/lib#1' };
    store.writeRepository(
      store.beginRepositoryRead(root),
      listing([issue('owner/a#1', 'Blocked by: other/lib#1')]),
    );
    store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
      result: { status: 'found', issue: issue(outside.key, 'Blocked by: other/lib#2') },
    });
    vi.advanceTimersByTime(1000);
    const result = await jobs.refresh(sourceScope()).completion;
    expect(result.state).toBe('partial');
    expect(result.units.filter((u) => u.state === 'failed')).toHaveLength(3);
    expect(store.readRepository(root)?.observation).toMatchObject({
      issues: [issue('owner/a#1', 'Blocked by: other/lib#1')],
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
      lastAttempt: { outcome: 'failed' },
    });
    expect(store.readOutsideIssue(outside)?.observation).toMatchObject({
      result: { status: 'found', issue: issue(outside.key, 'Blocked by: other/lib#2') },
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
      lastAttempt: { outcome: 'failed' },
    });
    expect(
      store.readOutsideIssue({ source: 'gh', key: 'other/lib#2' })?.observation.lastCheckedAt,
    ).toBe('2026-01-01T00:00:01.000Z');
    expect(store.readOutsideIssue({ source: 'gh', key: 'other/lib#3' })?.observation).toMatchObject(
      { result: { status: 'missing' }, lastAttempt: { outcome: 'failed' } },
    );
  });

  it('reports a fully failed job without inventing a successful observation', async () => {
    const f = fixture(() => new Response('', { status: 500 }));
    const { jobs, store } = service(f.input);
    const result = await jobs.refresh(project()).completion;
    expect(result.state).toBe('failed');
    expect(result.error).toContain('status 500');
    expect(store.readRepository({ source: 'gh', repo: 'owner/a' })?.observation).toMatchObject({
      issues: null,
      lastCheckedAt: null,
      lastAttempt: { outcome: 'failed' },
    });
  });

  it('retains repository and outside check times while units are queued and checking', async () => {
    const list = gate();
    const lookup = gate();
    let cooldown: number | null = null;
    const f = fixture(
      async (path) => {
        if (!path.includes('/issues/')) {
          await list.promise;
          cooldown = Date.now() + 1000;
          return json(listing([issue('owner/a#1', 'Blocked by: other/lib#1')]));
        }
        await lookup.promise;
        return json(issue('other/lib#1'));
      },
      { cooldownUntil: () => cooldown },
    );
    const { jobs, store } = service(f.input);
    const root = { source: 'gh', repo: 'owner/a' };
    const outside = { source: 'gh', key: 'other/lib#1' };
    store.writeRepository(store.beginRepositoryRead(root), listing());
    store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
      result: { status: 'found', issue: issue(outside.key) },
    });
    const checkedAt = '2026-01-01T00:00:00.000Z';
    vi.setSystemTime(Date.now() + 10);
    const job = jobs.refresh(project());
    try {
      expect(job.status.units[0]).toMatchObject({ state: 'queued', lastCheckedAt: checkedAt });
      await tick();
      expect(job.status.units[0]).toMatchObject({ state: 'checking', lastCheckedAt: checkedAt });
      list.resolve();
      await tick();
      expect(job.status.units[1]).toMatchObject({
        kind: 'outside-issue',
        state: 'queued',
        lastCheckedAt: checkedAt,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(job.status.units[1]).toMatchObject({ state: 'checking', lastCheckedAt: checkedAt });
    } finally {
      cooldown = null;
      list.resolve();
      lookup.resolve();
      f.input.queue.cooldownChanged();
    }
    expect((await job.completion).state).toBe('completed');
    expect(job.status.units.map((unit) => unit.lastCheckedAt)).toEqual([
      '2026-01-01T00:00:00.010Z',
      '2026-01-01T00:00:01.010Z',
    ]);
  });

  it('captures reads at admission and never freshens observations invalidated during requests', async () => {
    const list = gate();
    const lookup = gate();
    const f = fixture(async (path) => {
      if (!path.includes('/issues/')) {
        await list.promise;
        return json(listing([issue('owner/a#1', 'Blocked by: other/lib#1')]));
      }
      await lookup.promise;
      return json(issue('other/lib#1'));
    });
    const { jobs, store } = service(f.input);
    const root = { source: 'gh', repo: 'owner/a' };
    const outside = { source: 'gh', key: 'other/lib#1' };
    const job = jobs.refresh(project());
    await tick();
    store.invalidateRepository(root);
    list.resolve();
    await tick();
    store.invalidateRepository({ source: 'gh', repo: 'other/lib' });
    lookup.resolve();
    await job.completion;
    expect(store.readRepository(root)?.invalidated).toBe(true);
    expect(store.readOutsideIssue(outside)?.invalidated).toBe(true);
    await jobs.refresh(project()).completion;
    expect(store.readRepository(root)?.invalidated).toBe(false);
    expect(store.readOutsideIssue(outside)?.invalidated).toBe(false);
  });

  it('does not overwrite a newer repository or outside observation on a late completion', async () => {
    const list = gate();
    const lookup = gate();
    const f = fixture(async (path) => {
      if (!path.includes('/issues/')) {
        await list.promise;
        return json(listing([issue('owner/a#1', 'Blocked by: obsolete/lib#1')]));
      }
      await lookup.promise;
      return json(issue('other/lib#1', 'Blocked by: obsolete/lib#2'));
    });
    const { jobs, store } = service(f.input);
    const root = { source: 'gh', repo: 'owner/a' };
    const outside = { source: 'gh', key: 'other/lib#1' };
    const job = jobs.refresh(project());
    await tick();
    store.writeRepository(
      store.beginRepositoryRead(root),
      listing([issue('owner/a#1', 'Blocked by: other/lib#1')]),
    );
    list.resolve();
    await tick();
    store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
      result: { status: 'found', issue: issue(outside.key, '', 'closed') },
    });
    lookup.resolve();
    await job.completion;
    expect(f.calls.map((c) => c.path)).toEqual(['/repos/owner/a', '/repos/other/lib/issues/1']);
    expect(store.readRepository(root)?.observation.issues?.[0]?.body).toBe(
      'Blocked by: other/lib#1',
    );
    expect(store.readOutsideIssue(outside)?.observation.result).toMatchObject({
      status: 'found',
      issue: { state: 'closed' },
    });
  });

  it.each(['listing', 'lookup'] as const)(
    're-admits a throttled %s after cooldown while another source completes',
    async (target) => {
      let throttled = false;
      const f = fixture((path) => {
        if (path.includes('/issues/') === (target === 'lookup') && !throttled) {
          throttled = true;
          return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
        }
        return json(
          path.includes('/issues/')
            ? issue('other/lib#1')
            : listing([issue('owner/a#1', 'Blocked by: other/lib#1')]),
        );
      });
      const healthy = fixture(() => json(listing()), { id: 'healthy' });
      const { jobs, store } = service(f.input, healthy.input);
      const delayed = jobs.refresh(project(), { priority: 'sweep' });
      await tick();
      expect(delayed.status).toMatchObject({
        state: 'running',
        delayedUntil: '2026-01-01T00:01:00.000Z',
        finishedAt: null,
      });
      expect(delayed.status.units.at(-1)?.state).toBe('queued');
      expect((await jobs.refresh(project('owner/a', 'healthy')).completion).state).toBe(
        'completed',
      );
      const calls = f.calls.length;
      const copy = delayed.status;
      copy.priority = 'interactive';
      expect(delayed.status.priority).toBe('sweep');
      if (target === 'listing') store.invalidateRepository({ source: 'gh', repo: 'owner/a' });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.calls).toHaveLength(calls);
      await vi.advanceTimersByTimeAsync(1);
      const final = await delayed.completion;
      expect(final).toMatchObject({ state: 'completed', delayedUntil: null, error: null });
      expect(f.calls).toHaveLength(3);
      expect(f.calls.at(-1)?.at).toBe(Date.parse('2026-01-01T00:01:00Z'));
      expect(store.readRepository({ source: 'gh', repo: 'owner/a' })?.invalidated).toBe(false);
    },
  );

  it('keeps initial cooldown jobs queued and captures invalidation only when work starts', async () => {
    const cooldown = Date.now() + 1000;
    const f = fixture(() => json(listing()), { cooldownUntil: () => cooldown });
    const { jobs, store } = service(f.input);
    const job = jobs.refresh(project());
    await tick();
    expect(job.status).toMatchObject({
      state: 'queued',
      startedAt: null,
      delayedUntil: '2026-01-01T00:00:01.000Z',
    });
    expect(f.calls).toHaveLength(0);
    store.invalidateRepository({ source: 'gh', repo: 'owner/a' });
    await vi.advanceTimersByTimeAsync(1000);
    await job.completion;
    expect(store.readRepository({ source: 'gh', repo: 'owner/a' })?.invalidated).toBe(false);
    expect(job.status.startedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('retries partial relation reads during cooldown without losing their last-good edges', async () => {
    const root = issue('owner/a#1');
    root.nativeRelations = [
      { kind: 'blocked-by', source: 'native', ref: { owner: 'other', repo: 'lib', number: 1 } },
    ];
    const f = fixture((path, call) => {
      if (path.includes('/issues/')) return json(issue('other/lib#1'));
      return json(
        listing(
          call === 1 ? [issue(root.key)] : [root],
          call === 1 ? { native: 'failed', subIssues: 'complete' } : complete,
        ),
        call === 1
          ? {
              headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Date.now() / 1000 + 1),
              },
            }
          : undefined,
      );
    });
    const { jobs, store } = service(f.input);
    const ref = { source: 'gh', repo: 'owner/a' };
    store.writeRepository(store.beginRepositoryRead(ref), listing([root]));
    const job = jobs.refresh(project());
    await tick();
    expect(job.status.finishedAt).toBeNull();
    expect(job.status.delayedUntil).toBe('2026-01-01T00:00:02.000Z');
    expect(store.readRepository(ref)?.observation.issues?.[0]?.nativeRelations).toEqual(
      root.nativeRelations,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect((await job.completion).state).toBe('completed');
    expect(f.calls).toHaveLength(3);
    expect(
      store.readOutsideIssue({ source: 'gh', key: 'other/lib#1' })?.observation.result?.status,
    ).toBe('found');
  });

  it('honors disabled native/sub-issue policy in listings and targeted reads', async () => {
    const root = issue('owner/a#1', 'Blocked by: other/lib#1');
    root.nativeRelations = [
      { kind: 'blocked-by', source: 'native', ref: { owner: 'other', repo: 'lib', number: 2 } },
    ];
    const dependency = issue('other/lib#1');
    dependency.nativeRelations = [
      { kind: 'blocked-by', source: 'sub-issue', ref: { owner: 'other', repo: 'lib', number: 3 } },
    ];
    const f = fixture((path) => json(path.includes('/issues/') ? dependency : listing([root])));
    f.input.source.planning!.dependencies.native = false;
    f.input.source.planning!.dependencies.subIssues = false;
    const { jobs } = service(f.input);
    expect((await jobs.refresh(project()).completion).state).toBe('completed');
    expect(f.calls).toHaveLength(2);
    expect(
      f.calls.every((c) => c.options.native === 'false' && c.options.subIssues === 'false'),
    ).toBe(true);
  });

  it('reports permanent partial coverage without retrying unsupported relations', async () => {
    const f = fixture(() => json(listing([], { native: 'unsupported', subIssues: 'complete' })));
    const { jobs, store } = service(f.input);
    const result = await jobs.refresh(project()).completion;
    expect(result.state).toBe('partial');
    expect(result.units[0]).toMatchObject({ state: 'checked', partial: true });
    expect(
      store.readRepository({ source: 'gh', repo: 'owner/a' })?.observation.lastAttempt?.outcome,
    ).toBe('partial');
    expect(f.calls).toHaveLength(1);
  });

  it('retains the 200-lookup budget and four-lookup concurrency even with wider source admission', async () => {
    const f = fixture(
      async (path) => {
        if (!path.includes('/issues/'))
          return json(
            listing([
              issue(
                'owner/a#1',
                `Blocked by: ${Array.from({ length: 205 }, (_, n) => `other/lib#${n + 1}`).join(', ')}`,
              ),
            ]),
          );
        await new Promise((done) => setTimeout(done, 1));
        return json(issue(`other/lib#${path.split('/').at(-1)}`));
      },
      { concurrency: 20 },
    );
    const { jobs } = service(f.input);
    const job = jobs.refresh(project());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await job.completion;
    expect(result.state).toBe('partial');
    expect(result.error).toContain('200');
    expect(f.calls).toHaveLength(201);
    expect(f.maxActive()).toBe(4);
    expect(f.calls.at(-1)?.path).toBe('/repos/other/lib/issues/200');
  });

  it('paces refresh fetches through the supplied queue, including the first listing', async () => {
    const f = fixture(
      (path) =>
        json(
          path.includes('/issues/')
            ? issue('other/lib#1')
            : listing([issue('owner/a#1', 'Blocked by: other/lib#1')]),
        ),
      { requestsPerMinute: 1 },
    );
    const { jobs } = service(f.input);
    const job = jobs.refresh(project());
    await tick();
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await job.completion;
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.at - f.calls[0]!.at).toBe(60_000);
  });

  it('refuses policy conflicts with their explanation before any upstream work', async () => {
    const f = fixture(() => json(listing()));
    f.input.catalog.policy = {
      status: 'conflict',
      conflict: {
        source: 'gh',
        differingSettings: ['dependencies.native'],
        views: ['a', 'b'],
        explanation: 'Set sources.gh.planning to resolve differing native settings',
      },
    };
    f.input.source.planning = null;
    const { jobs } = service(f.input);
    expect(() => jobs.refresh(sourceScope())).toThrow(f.input.catalog.policy.conflict.explanation);
    expect(() => jobs.refresh(project())).toThrow(ScopeRefreshError);
    expect(jobs.active(project())).toBeNull();
    await tick();
    expect(f.calls).toHaveLength(0);
  });

  it('rejects unknown sources/projects and reports queue shutdown instead of hanging', async () => {
    const f = fixture(() => json(listing()));
    const { jobs } = service(f.input);
    expect(() => jobs.refresh(sourceScope('unknown'))).toThrow('Unknown source');
    expect(() => jobs.refresh(project('other/unknown'))).toThrow('Unknown project');
    const job = jobs.refresh(project());
    await f.input.queue.close();
    expect((await job.completion).state).toBe('failed');
    expect(jobs.active(project())).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
