import { setImmediate as immediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/load.js';
import type { AppConfig } from '../config/schema.js';
import { parseKey } from '../core/keys.js';
import type { Scope, ScopeResponse } from '../core/scope.js';
import type { FetchResult, Issue, IssueProvider } from '../core/types.js';
import type { FetchLike } from '../providers/http.js';
import { AdmissionShutdownError } from '../service/admissionQueue.js';
import { createScopeRuntime } from '../service/scopeRuntime.js';
import { SCOPE_READ_WAIT_MS } from '../service/scopeReadService.js';
import { buildApp } from './app.js';

const START = '2026-01-01T00:00:00.000Z';
const TOKEN = 'ghp_scope_route_test_secret';
const PROJECT = '/api/projects/gh/o/a';
const SOURCE = '/api/sources/gh';
const project: Scope = { kind: 'project', source: 'gh', repo: 'o/a' };
const source: Scope = { kind: 'source', source: 'gh' };
const coverage = { native: 'complete', subIssues: 'complete' } as const;

function issue(key = 'o/a#1', body = ''): Issue {
  return {
    ...parseKey(key),
    key,
    title: key,
    body,
    state: 'open',
    url: `https://github.com/${key.replace('#', '/issues/')}`,
    labels: [],
    assignees: [],
    milestone: null,
    updatedAt: null,
    nativeRelations: [],
    relationCoverage: coverage,
  };
}

function listing(issues: Issue[] = []): FetchResult {
  return { issues, warnings: [], relationCoverage: coverage };
}

function config(): AppConfig {
  return parseConfig(
    JSON.stringify({
      cache: { ttlSeconds: 60 },
      refresh: { requestsPerMinute: 1000, concurrency: 4 },
      sources: [{ id: 'gh', kind: 'github', token: TOKEN }],
      views: [
        {
          id: 'roadmap',
          source: 'gh',
          repos: ['o/a', 'o/b'],
          dependencies: { native: true, subIssues: true },
        },
      ],
    }),
    {},
  );
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function tick() {
  await immediate();
  for (let n = 0; n < 50; n++) await Promise.resolve();
}

const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  // Keep Fastify's nextTick/setImmediate lifecycle real while controlling read deadlines.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
});
afterEach(async () => {
  try {
    while (cleanups.length > 0) await cleanups.pop()?.();
  } finally {
    vi.useRealTimers();
  }
});

function setup(options: { config?: AppConfig; fetch?: FetchLike; shutdownWaitMs?: number } = {}) {
  const appConfig = options.config ?? config();
  let cooldownUntil: number | null = null;
  const list = vi.fn<IssueProvider['listOpenIssues']>(async (repo) =>
    listing([issue(`${repo.owner}/${repo.repo}#1`)]),
  );
  const lookup = vi.fn<IssueProvider['getIssue']>(async () => null);
  const provider: IssueProvider = {
    kind: 'github',
    listOpenIssues: list,
    getIssue: lookup,
    cooldownUntil: () => cooldownUntil,
  };
  const providerFor = vi.fn(() => provider);
  const runtime = createScopeRuntime(appConfig, {
    now: () => new Date(),
    shutdownWaitMs: options.shutdownWaitMs ?? 0,
    ...(options.fetch ? { fetch: options.fetch } : { providerFor }),
  });
  const app = buildApp(appConfig, runtime.plans, {
    scopes: runtime,
    webDir: '/tmp/forge-desk-scope-tests-no-web',
  });
  cleanups.push(() => app.close());
  const seed = (repo = 'o/a', issues: Issue[] = [issue(`${repo}#1`)]) =>
    runtime.store.writeRepository(
      runtime.store.beginRepositoryRead({ source: 'gh', repo }),
      listing(issues),
    );
  return {
    app,
    config: appConfig,
    runtime,
    list,
    lookup,
    providerFor,
    seed,
    cooldown: (until: number) => {
      cooldownUntil = until;
      runtime.sources[0]!.queue.cooldownChanged();
    },
  };
}

describe('scope catalog and route contracts', () => {
  it('lists sources in configuration order, sorted distinct projects, and policy conflicts', async () => {
    const appConfig = parseConfig(
      JSON.stringify({
        sources: [
          { id: 'z', kind: 'github', token: TOKEN },
          { id: 'a', kind: 'github' },
        ],
        views: [
          { id: 'one', source: 'z', repos: ['O/B', 'o/a', 'o/b'] },
          { id: 'two', source: 'z', repos: ['o/empty'], dependencies: { native: false } },
          { id: 'other', source: 'a', repos: ['o/a'] },
        ],
      }),
      {},
    );
    const f = setup({ config: appConfig });
    const response = await f.app.inject('/api/projects');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(appConfig.catalog);
    expect(response.json().sources.map((entry: { id: string }) => entry.id)).toEqual(['z', 'a']);
    expect(response.json().sources[0].projects).toEqual([
      { source: 'z', repo: 'o/a' },
      { source: 'z', repo: 'o/b' },
      { source: 'z', repo: 'o/empty' },
    ]);
    expect(response.json().sources[0].policy).toMatchObject({
      status: 'conflict',
      conflict: { differingSettings: ['dependencies.native'], views: ['one', 'two'] },
    });
    expect(response.body).not.toContain(TOKEN);
    expect(f.list).not.toHaveBeenCalled();

    for (const base of ['/api/projects/z/o/a', '/api/sources/z']) {
      for (const suffix of ['snapshot', 'export.json', 'export.md', 'export.mmd', 'export.dot']) {
        const conflict = await f.app.inject(`${base}/${suffix}`);
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toMatchObject({ code: 'policy-conflict' });
        expect(conflict.headers['cache-control']).toBe('no-store');
      }
    }
    // An ambiguous scope policy must not break the independent named-view contract.
    expect((await f.app.inject('/api/views/one/snapshot')).statusCode).toBe(200);
  });

  it.each([
    ['/api/sources/missing', 'unknown-source'],
    ['/api/projects/missing/o/a', 'unknown-source'],
    ['/api/projects/gh/o/missing', 'unknown-project'],
    ['/api/projects/GH/o/a', 'unknown-source'],
  ])('returns a coded 404 for %s on snapshots and every export', async (base, code) => {
    const f = setup();
    for (const suffix of ['snapshot', 'export.json', 'export.md', 'export.mmd', 'export.dot']) {
      const response = await f.app.inject(`${base}/${suffix}`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code });
      expect(response.json().error).toEqual(expect.any(String));
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(f.list).not.toHaveBeenCalled();
  });

  it('keeps the scope routes absent when no runtime is mounted', async () => {
    const f = setup();
    const app = buildApp(f.config, f.runtime.plans, { webDir: '/tmp/forge-desk-no-web' });
    cleanups.push(() => app.close());
    for (const route of ['/api/projects', `${PROJECT}/snapshot`, `${SOURCE}/export.json`]) {
      expect((await app.inject(route)).statusCode).toBe(404);
    }
    expect((await app.inject('/api/views')).statusCode).toBe(200);
  });
});

describe('scope HTTP observations and freshness', () => {
  it('loads a canonical project once and returns the scope envelope even with a matching plan ETag', async () => {
    const f = setup();
    const first = await f.app.inject('/api/projects/gh/O/A/snapshot');
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const body = first.json<ScopeResponse>();
    expect(body.scope).toEqual(project);
    expect(body.snapshot).toMatchObject({ viewId: 'project:gh/o/a', fetchedAt: START });
    expect(body.snapshot?.plan.nodes.map((node) => node.key)).toEqual(['o/a#1']);
    expect(body.freshness).toMatchObject({
      computedAt: START,
      repositories: [{ project: { source: 'gh', repo: 'o/a' }, state: 'fresh', partial: false }],
      outsideIssues: { count: 0, oldestObservedAt: null, provisionalCount: 0 },
    });
    expect(body.job).toBeNull();
    const second = await f.app.inject({
      url: `${PROJECT}/snapshot`,
      headers: { 'if-none-match': `"${body.snapshot?.contentHash}"` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().freshness.repositories[0].lastCheckedAt).toBe(START);
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a verified empty project from unavailable data', async () => {
    const f = setup();
    f.list.mockResolvedValue(listing());
    const response = await f.app.inject(`${PROJECT}/snapshot`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      snapshot: { plan: { nodes: [] } },
      freshness: { repositories: [{ state: 'fresh', lastCheckedAt: START }] },
      job: null,
    });
  });

  it('derives a source from shared project observations without relisting fresh siblings', async () => {
    const f = setup();
    f.seed();
    f.seed('o/b');
    const initial = await f.app.inject(`${SOURCE}/snapshot`);
    expect(initial.json().scope).toEqual(source);
    expect(initial.json().snapshot.viewId).toBe('source:gh');
    expect(f.list).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1000);
    f.list.mockResolvedValue(listing([issue('o/a#2')]));
    f.runtime.store.invalidateRepository({ source: 'gh', repo: 'o/a' });
    await f.app.inject(`${PROJECT}/snapshot`);
    await f.runtime.jobs.active(project)?.completion;
    const updated = await f.app.inject(`${SOURCE}/snapshot`);
    expect(updated.json().snapshot.plan.nodes.map((node: Issue) => node.key)).toEqual([
      'o/a#2',
      'o/b#1',
    ]);
    expect(updated.json().snapshot.fetchedAt).toBe(START);
    expect(updated.json().freshness.computedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('serves stale data immediately and coalesces polling into one background job', async () => {
    const f = setup();
    f.seed();
    vi.setSystemTime(Date.now() + 61_000);
    const blocked = gate();
    cleanups.push(blocked.resolve);
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing([issue('o/a#2')]);
    });
    const first = await f.app.inject(`${PROJECT}/snapshot`);
    const second = await f.app.inject(`${PROJECT}/snapshot`);
    expect(first.json().snapshot.plan.nodes[0].key).toBe('o/a#1');
    expect(first.json().snapshot.fetchedAt).toBe(START);
    expect(first.json().job.id).toBe(second.json().job.id);
    expect(second.json().freshness.repositories[0].state).toBe('updating');
    expect(first.json().snapshot.plan.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'stale-data' })]),
    );
    expect(f.list).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await f.runtime.jobs.active(project)?.completion;
    expect((await f.app.inject(`${PROJECT}/snapshot`)).json().snapshot.plan.nodes[0].key).toBe(
      'o/a#2',
    );
  });

  it('returns a null cold snapshot at the read deadline and retains the live job', async () => {
    const f = setup();
    const blocked = gate();
    cleanups.push(blocked.resolve);
    f.list.mockImplementation(async () => {
      await blocked.promise;
      return listing();
    });
    await f.app.ready();
    let settled = false;
    const pending = f.app.inject(`${PROJECT}/snapshot`).then((response) => {
      settled = true;
      return response;
    });
    await tick();
    await vi.advanceTimersByTimeAsync(SCOPE_READ_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      snapshot: null,
      freshness: { computedAt: null, repositories: [{ state: 'updating', lastCheckedAt: null }] },
      job: { scope: project, state: 'running' },
    });
    blocked.resolve();
    await f.runtime.jobs.active(project)?.completion;
    expect((await f.app.inject(`${PROJECT}/snapshot`)).json().snapshot.plan.nodes).toEqual([]);
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('reports an in-flight invalidation honestly and rechecks it on the next open', async () => {
    const f = setup();
    const blocked = gate();
    cleanups.push(blocked.resolve);
    f.list.mockImplementationOnce(async () => {
      await blocked.promise;
      return listing([issue('o/a#1')]);
    });
    await f.app.ready();
    const pending = f.app.inject(`${PROJECT}/snapshot`).then((response) => response);
    await tick();
    expect(f.list).toHaveBeenCalledTimes(1);
    f.runtime.store.invalidateRepository({ source: 'gh', repo: 'o/a' });
    blocked.resolve();
    const invalidated = await pending;
    expect(invalidated.statusCode).toBe(200);
    expect(invalidated.json()).toMatchObject({
      snapshot: { plan: { nodes: [{ key: 'o/a#1' }] } },
      freshness: { repositories: [{ state: 'invalidated', lastCheckedAt: START }] },
      job: null,
    });
    expect(invalidated.json().snapshot.plan.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'stale-data' })]),
    );
    f.list.mockResolvedValue(listing([issue('o/a#2')]));
    await f.app.inject(`${PROJECT}/snapshot`);
    await f.runtime.jobs.active(project)?.completion;
    const checked = await f.app.inject(`${PROJECT}/snapshot`);
    expect(checked.json().freshness.repositories[0].state).toBe('fresh');
    expect(checked.json().snapshot.plan.nodes[0].key).toBe('o/a#2');
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('reports failed and unavailable repositories, redacts errors, and paces passive retries', async () => {
    const f = setup();
    f.seed();
    f.list.mockRejectedValue(new Error(`upstream failed using ${TOKEN}`));
    await f.runtime.jobs.refresh(source).completion;
    const failed = await f.app.inject(`${SOURCE}/snapshot`);
    expect(failed.statusCode).toBe(200);
    expect(
      failed.json().freshness.repositories.map((entry: { state: string }) => entry.state),
    ).toEqual(['failed', 'unavailable']);
    expect(failed.json().snapshot.plan.nodes.map((node: Issue) => node.key)).toEqual(['o/a#1']);
    expect(failed.json().snapshot.plan.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'repository-unlisted' })]),
    );
    expect(failed.body).not.toContain(TOKEN);
    expect(failed.json().freshness.repositories[0].error).toContain('upstream failed');
    for (let n = 0; n < 3; n++) {
      vi.setSystemTime(Date.now() + 2000);
      const polled = await f.app.inject(`${SOURCE}/snapshot`);
      expect(polled.json().job).toBeNull();
      expect(polled.body).not.toContain(TOKEN);
    }
    expect(f.list).toHaveBeenCalledTimes(2);
    await f.runtime.jobs.refresh(source).completion;
    expect(f.list).toHaveBeenCalledTimes(4);
  });

  it('preserves stale relation age and partial coverage while completed work is paced', async () => {
    const f = setup();
    f.seed();
    vi.setSystemTime(Date.now() + 61_000);
    f.list.mockResolvedValue({
      ...listing([issue()]),
      relationCoverage: { native: 'failed', subIssues: 'complete' },
    });
    await f.runtime.jobs.refresh(project).completion;
    const response = await f.app.inject(`${PROJECT}/snapshot`);
    expect(response.statusCode).toBe(200);
    expect(response.json().freshness.repositories[0]).toMatchObject({
      state: 'stale',
      partial: true,
    });
    expect(response.json().job).toBeNull();
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('reports a delayed invalidated scope without waiting or bypassing provider cooldown', async () => {
    const f = setup();
    f.seed();
    f.runtime.store.invalidateRepository({ source: 'gh', repo: 'o/a' });
    f.cooldown(Date.now() + 3600_000);
    const response = await f.app.inject(`${PROJECT}/snapshot`);
    expect(response.statusCode).toBe(200);
    expect(response.json().freshness.repositories[0]).toMatchObject({
      state: 'delayed',
      delayedUntil: '2026-01-01T01:00:00.000Z',
      lastCheckedAt: START,
    });
    expect(response.json().job.delayedUntil).toBe('2026-01-01T01:00:00.000Z');
    expect(response.json().snapshot.plan.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'stale-data' })]),
    );
    expect(f.list).not.toHaveBeenCalled();
  });

  it('revalidates zero-TTL snapshots and never returns old data after a failure', async () => {
    const appConfig = config();
    appConfig.cache.ttlSeconds = 0;
    const f = setup({ config: appConfig });
    await f.app.inject(`${PROJECT}/snapshot`);
    await f.app.inject(`${PROJECT}/snapshot`);
    expect(f.list).toHaveBeenCalledTimes(2);
    f.list.mockRejectedValueOnce(new Error('offline'));
    const failure = await f.app.inject(`${PROJECT}/snapshot`);
    expect(failure.statusCode).toBe(200);
    expect(failure.json()).toMatchObject({
      snapshot: null,
      freshness: { repositories: [{ state: 'failed', error: 'offline' }] },
    });
  });

  it('fails zero-TTL browsing immediately during cooldown with an explicit retry time', async () => {
    const appConfig = config();
    appConfig.cache.ttlSeconds = 0;
    const f = setup({ config: appConfig });
    f.seed();
    f.cooldown(Date.now() + 3600_000);
    for (const base of [PROJECT, SOURCE]) {
      const response = await f.app.inject(`${base}/snapshot`);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: 'source-cooldown',
        delayedUntil: '2026-01-01T01:00:00.000Z',
      });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(f.list).not.toHaveBeenCalled();
  });
});

describe.each([
  ['project', PROJECT],
  ['source', SOURCE],
])('%s scope exports', (_kind, base) => {
  const formats = [
    ['json', 'application/json', '"viewId"'],
    ['md', 'text/markdown', '# '],
    ['mmd', 'text/plain', 'flowchart LR'],
    ['dot', 'text/vnd.graphviz', 'digraph'],
  ];

  it.each(formats)('exports %s with warnings and refresh=1', async (ext, contentType, marker) => {
    const f = setup();
    f.list.mockImplementation(async (repo) =>
      listing([issue(`${repo.owner}/${repo.repo}#1`, 'Depends on private/repo#9')]),
    );
    const first = await f.app.inject(`${base}/export.${ext}`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain(contentType);
    expect(first.headers['content-type']).toContain('charset=utf-8');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['content-disposition']).toMatch(
      new RegExp(`^inline; filename="[^"/]+\\.${ext}"$`),
    );
    expect(first.body).toContain(marker);
    expect(first.body).toContain('dependency-provisional');
    if (ext === 'json') {
      expect(first.json().plan).toBeDefined();
      expect(first.json().snapshot).toBeUndefined();
    }
    const count = f.list.mock.calls.length;
    vi.setSystemTime(Date.now() + 61_000);
    const cached = await f.app.inject(`${base}/export.${ext}`);
    expect(cached.statusCode).toBe(200);
    expect(cached.body).toContain('stale-data');
    expect(cached.body).toContain('dependency-provisional');
    expect(f.list).toHaveBeenCalledTimes(count);
    await f.app.inject(`${base}/export.${ext}?refresh=1`);
    expect(f.list).toHaveBeenCalledTimes(count * 2);
  });

  it('exports existing stale and invalidated observations without automatic upstream work', async () => {
    const f = setup();
    f.seed();
    f.seed('o/b');
    vi.setSystemTime(Date.now() + 61_000);
    f.runtime.store.invalidateRepository({ source: 'gh', repo: 'o/a' });
    const response = await f.app.inject(`${base}/export.json`);
    expect(response.statusCode).toBe(200);
    expect(response.json().fetchedAt).toBe(START);
    expect(response.json().plan.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'stale-data' })]),
    );
    expect(f.list).not.toHaveBeenCalled();
    expect(f.runtime.jobs.active(base === PROJECT ? project : source)).toBeNull();
  });

  it('rejects unknown formats before fetching', async () => {
    const f = setup();
    for (const extension of ['txt', 'mermaid', 'xml', 'toString', '']) {
      const response = await f.app.inject(`${base}/export.${extension}`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Not found' });
    }
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each(formats)('returns unavailable instead of fabricating an empty %s export', async (ext) => {
    const f = setup();
    f.list.mockRejectedValue(new Error(`offline ${TOKEN}`));
    const response = await f.app.inject(`${base}/export.${ext}`);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'scope-unavailable', snapshot: null });
    expect(
      response
        .json()
        .freshness.repositories.every((entry: { state: string }) => entry.state === 'unavailable'),
    ).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(TOKEN);
  });

  it('revalidates every zero-TTL export rather than serving retained observations', async () => {
    const appConfig = config();
    appConfig.cache.ttlSeconds = 0;
    const f = setup({ config: appConfig });
    f.seed('o/a', [issue('o/a#99')]);
    f.seed('o/b', [issue('o/b#99')]);
    const first = await f.app.inject(`${base}/export.json`);
    expect(first.statusCode).toBe(200);
    expect(first.body).not.toContain('#99');
    const count = f.list.mock.calls.length;
    const second = await f.app.inject(`${base}/export.json`);
    expect(second.statusCode).toBe(200);
    expect(f.list).toHaveBeenCalledTimes(count * 2);
    f.list.mockRejectedValue(new Error('offline'));
    const failed = await f.app.inject(`${base}/export.json`);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().snapshot).toBeNull();
  });
});

describe('scope route authentication and runtime ownership', () => {
  const routes = [
    '/api/projects',
    `${PROJECT}/snapshot`,
    `${SOURCE}/snapshot`,
    ...[PROJECT, SOURCE].flatMap((base) =>
      ['json', 'md', 'mmd', 'dot'].map((format) => `${base}/export.${format}`),
    ),
  ];

  it.each(['open', 'basic', 'session'])(
    'uses the existing %s authentication contract',
    async (mode) => {
      const appConfig = config();
      if (mode !== 'open') appConfig.server.basicAuth = { username: 'reader', password: 'secret' };
      const f = setup({ config: appConfig });
      const headers: Record<string, string> = {};
      if (mode !== 'open') {
        for (const url of routes) {
          const denied = await f.app.inject(url);
          expect(denied.statusCode).toBe(401);
          expect(denied.json()).toEqual({ error: 'Unauthorized' });
        }
        expect(f.list).not.toHaveBeenCalled();
      }
      if (mode === 'basic') {
        headers.authorization = `Basic ${Buffer.from('reader:secret').toString('base64')}`;
      } else if (mode === 'session') {
        const login = await f.app.inject({
          method: 'POST',
          url: '/login',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'username=reader&password=secret',
        });
        expect(login.statusCode).toBe(303);
        headers.cookie = String(login.headers['set-cookie']).split(';')[0]!;
      }
      for (const url of routes) {
        const response = await f.app.inject({ url, headers });
        expect(response.statusCode, url).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    },
  );

  it('shares one provider between named views and scopes without changing named-view envelopes', async () => {
    const f = setup();
    const named = await f.app.inject('/api/views/roadmap/snapshot');
    expect(named.statusCode).toBe(200);
    expect(named.json().viewId).toBe('roadmap');
    expect(named.json().snapshot).toBeUndefined();
    expect(named.headers.etag).toBe(`"${named.json().contentHash}"`);
    await f.app.inject(`${PROJECT}/snapshot`);
    expect(f.providerFor).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(3);
    await f.app.inject('/api/views/roadmap/snapshot');
    expect(f.list).toHaveBeenCalledTimes(3);
  });

  it('paces scope requests while leaving forced exports and named-view reads unpaced', async () => {
    const appConfig = config();
    appConfig.refresh.requestsPerMinute = 1;
    appConfig.sources[0]!.planning!.dependencies.native = false;
    appConfig.sources[0]!.planning!.dependencies.subIssues = false;
    appConfig.views[0]!.dependencies.native = false;
    appConfig.views[0]!.dependencies.subIssues = false;
    const fetch = vi.fn<FetchLike>(async () => new Response('[]'));
    const f = setup({ config: appConfig, fetch });
    const first = await f.app.inject(`${PROJECT}/snapshot`);
    expect(first.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const queued = f.app.inject('/api/projects/gh/o/b/snapshot').then((response) => response);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    const exported = await f.app.inject(`${PROJECT}/export.json?refresh=1`);
    expect(exported.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await f.app.inject('/api/views/roadmap/snapshot')).statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    await queued;
    await f.runtime.jobs.active({ kind: 'project', source: 'gh', repo: 'o/b' })?.completion;
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([false, true])(
    'keeps browsing delayed after every export format during cooldown (invalidated: %s)',
    async (invalidated) => {
      const appConfig = config();
      appConfig.cache.ttlSeconds = 300;
      appConfig.views[0]!.repos = [{ owner: 'o', repo: 'a' }];
      appConfig.sources[0]!.planning!.dependencies.native = false;
      appConfig.sources[0]!.planning!.dependencies.subIssues = false;
      let throttled = false;
      const fetch = vi.fn<FetchLike>(async () =>
        throttled
          ? new Response('', { status: 429, headers: { 'Retry-After': '120' } })
          : new Response('[]'),
      );
      const f = setup({ config: appConfig, fetch });
      if (invalidated) {
        expect((await f.app.inject(`${PROJECT}/snapshot`)).statusCode).toBe(200);
        f.runtime.store.invalidateRepository({ source: 'gh', repo: 'o/a' });
      }
      throttled = true;
      await expect(f.runtime.plans.getSnapshot('roadmap')).rejects.toThrow('rate limit');
      const calls = fetch.mock.calls.length;
      for (const format of ['json', 'md', 'mmd', 'dot']) {
        const downloaded = await f.app.inject(
          `${PROJECT}/export.${format}${invalidated ? '?refresh=1' : ''}`,
        );
        expect(downloaded.statusCode).toBe(invalidated ? 200 : 503);
        if (invalidated) expect(downloaded.body).toContain('stale-data');
        else expect(downloaded.json()).toMatchObject({ code: 'scope-unavailable', snapshot: null });
      }
      const browsing = await f.app.inject(`${PROJECT}/snapshot`);
      expect(browsing.statusCode).toBe(200);
      expect(browsing.json()).toMatchObject({
        job: { state: 'queued', delayedUntil: '2026-01-01T00:02:00.000Z' },
        freshness: {
          repositories: [{ state: 'delayed', delayedUntil: '2026-01-01T00:02:00.000Z' }],
        },
      });
      expect(fetch).toHaveBeenCalledTimes(calls);
      throttled = false;
      await vi.advanceTimersByTimeAsync(120_000);
      const refreshed = await f.app.inject(`${PROJECT}/snapshot`);
      expect(refreshed.json()).toMatchObject({
        snapshot: { viewId: 'project:gh/o/a' },
        job: null,
        freshness: { repositories: [{ state: 'fresh' }] },
      });
      expect(fetch).toHaveBeenCalledTimes(calls + 1);
    },
  );

  it('closes admission from app.close before draining a stalled request and bounds shutdown', async () => {
    const appConfig = config();
    appConfig.sources[0]!.planning!.dependencies.native = false;
    appConfig.sources[0]!.planning!.dependencies.subIssues = false;
    const blocked = gate();
    const fetch = vi.fn<FetchLike>(async () => {
      await blocked.promise;
      return new Response('[]');
    });
    const f = setup({ config: appConfig, fetch, shutdownWaitMs: 25 });
    // Release the upstream gate before cleanup if an assertion fails.
    cleanups.push(blocked.resolve);
    await f.app.ready();
    const pending = f.app.inject(`${PROJECT}/snapshot`).then((response) => response);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = f.app.close().then(() => (closed = true));
    await tick();
    await expect(
      f.runtime.sources[0]!.queue.submit('after-close', 'interactive', async () => undefined),
    ).rejects.toBeInstanceOf(AdmissionShutdownError);
    await vi.advanceTimersByTimeAsync(24);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
    expect((await pending).statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await f.runtime.jobs.active(project)?.completion;
  });
});
