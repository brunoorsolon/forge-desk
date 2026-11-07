import { setImmediate as immediate } from 'node:timers/promises';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/load.js';
import type { AppConfig } from '../config/schema.js';
import type { SweepStatus } from '../core/scope.js';
import type { FetchResult, IssueProvider } from '../core/types.js';
import { createScopeRuntime } from '../service/scopeRuntime.js';
import { SweepScheduler } from '../service/sweepScheduler.js';
import { buildApp } from './app.js';

const START = '2026-01-01T00:00:00.000Z';
const TOKEN = 'sweep-provider-secret';
const AUTH = `Basic ${Buffer.from('operator:password').toString('base64')}`;
const LAUNCH = { 'x-forge-desk-request': '1' };
const listing: FetchResult = {
  issues: [],
  warnings: [],
  relationCoverage: { native: 'complete', subIssues: 'complete' },
};
const cleanups: Array<() => Promise<void>> = [];
function config(login = false): AppConfig {
  return parseConfig(
    JSON.stringify({
      server: login ? { basicAuth: { username: 'operator', password: 'password' } } : {},
      cache: { ttlSeconds: 60 },
      refresh: { requestsPerMinute: 1000, concurrency: 4 },
      sources: [{ id: 'gh', kind: 'github', token: TOKEN }],
      views: [{ id: 'roadmap', source: 'gh', repos: ['o/a', 'o/b'] }],
    }),
    {},
  );
}
async function tick() {
  await immediate();
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function setup(c = config()) {
  let cooldown: number | null = null;
  const list = vi.fn<IssueProvider['listOpenIssues']>(async () => listing);
  const runtime = createScopeRuntime(c, {
    shutdownWaitMs: 0,
    providerFor: () => ({
      kind: 'github',
      listOpenIssues: list,
      getIssue: async () => null,
      cooldownUntil: () => cooldown,
    }),
  });
  const scheduler = new SweepScheduler({
    sources: c.catalog.sources,
    jobs: runtime.jobs,
    store: runtime.store,
    sweepHours: c.refresh.sweepHours,
    ttlSeconds: c.cache.ttlSeconds,
  });
  const app = buildApp(c, runtime.plans, {
    scopes: runtime,
    sweeps: scheduler,
    webDir: '/tmp/forge-desk-sweep-no-web',
  });
  cleanups.push(() => app.close());
  return { app, scheduler, runtime, list, cooldown: (until: number) => (cooldown = until) };
}
function safe(response: LightMyRequestResponse) {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(Object.keys(response.headers).filter((key) => key.startsWith('access-control-'))).toEqual(
    [],
  );
  expect(response.body).not.toContain(TOKEN);
}
async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'username=operator&password=password',
  });
  const cookie = String(response.headers['set-cookie']).split(';')[0]!;
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  return { cookie, 'x-csrf-token': session.json().csrfToken as string };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
});
afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()!();
  } finally {
    vi.useRealTimers();
  }
});

describe('all-source sweep HTTP contract', () => {
  it('returns null before any sweep without starting upstream work', async () => {
    const f = setup();
    const response = await f.app.inject('/api/refresh');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
    expect(f.list).not.toHaveBeenCalled();
    safe(response);
  });

  it('starts, joins and reads progress with original times and retained check/error details', async () => {
    const f = setup();
    const a = gate(),
      b = gate();
    f.list.mockImplementation(async (repo) => {
      await (repo.repo === 'a' ? a.promise : b.promise);
      if (repo.repo === 'b') throw new Error(`cannot read project with ${TOKEN}`);
      return listing;
    });
    f.runtime.store.writeRepository(
      f.runtime.store.beginRepositoryRead({ source: 'gh', repo: 'o/b' }),
      listing,
    );
    vi.setSystemTime(Date.parse(START) + 1000);
    const first = await f.app.inject({ method: 'POST', url: '/api/refresh', headers: LAUNCH });
    safe(first);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      trigger: 'interactive',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: null,
    });
    await tick();
    const checking = await f.app.inject('/api/refresh');
    expect(checking.json().sources[0].projects.map((p: { state: string }) => p.state)).toEqual([
      'checking',
      'checking',
    ]);
    vi.setSystemTime(Date.parse(START) + 2000);
    a.resolve();
    await tick();
    const joined = await f.app.inject({
      method: 'POST',
      url: '/api/refresh?join=1',
      headers: LAUNCH,
    });
    expect(joined.json()).toMatchObject({
      id: first.json().id,
      startedAt: first.json().startedAt,
      finishedAt: null,
      sources: [
        {
          projects: [
            { state: 'checked', lastCheckedAt: '2026-01-01T00:00:02.000Z', error: null },
            { state: 'checking', lastCheckedAt: START },
          ],
        },
      ],
    });
    expect(f.list).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.parse(START) + 3000);
    b.resolve();
    await tick();
    const done = await f.app.inject('/api/refresh');
    safe(done);
    expect(done.json()).toMatchObject({
      id: first.json().id,
      state: 'partial',
      trigger: 'interactive',
      startedAt: first.json().startedAt,
      finishedAt: '2026-01-01T00:00:03.000Z',
      sources: [
        {
          source: 'gh',
          state: 'partial',
          projects: [
            { state: 'checked', lastCheckedAt: '2026-01-01T00:00:02.000Z', error: null },
            { state: 'failed', lastCheckedAt: START, error: 'cannot read project with ***' },
          ],
        },
      ],
    });
    expect((await f.app.inject('/api/refresh')).json()).toEqual(done.json());
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('joins a queued scheduled sweep during cooldown without resetting its trigger or start', async () => {
    const c = config();
    c.refresh.sweepHours = 1;
    const f = setup(c);
    f.cooldown(Date.parse(START) + 60_000);
    const original = f.scheduler.start()!;
    await tick();
    vi.setSystemTime(Date.parse(START) + 1000);
    const joined = await f.app.inject({ method: 'POST', url: '/api/refresh', headers: LAUNCH });
    expect(joined.json()).toMatchObject({
      id: original.status.id,
      startedAt: START,
      trigger: 'scheduled',
      finishedAt: null,
      sources: [
        {
          state: 'delayed',
          delayedUntil: '2026-01-01T00:01:00.000Z',
          projects: [{ state: 'queued' }, { state: 'queued' }],
        },
      ],
    });
    expect(f.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await original.completion;
    const response = await f.app.inject('/api/refresh');
    expect(response.json().state).toBe('completed');
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('reports a source policy conflict while another source completes', async () => {
    const c = parseConfig(
      JSON.stringify({
        sources: [
          { id: 'conflict', kind: 'github' },
          { id: 'healthy', kind: 'github' },
        ],
        views: [
          { id: 'a', source: 'conflict', repos: ['o/a'], dependencies: { native: true } },
          { id: 'b', source: 'conflict', repos: ['o/b'], dependencies: { native: false } },
          { id: 'c', source: 'healthy', repos: ['o/a'] },
        ],
      }),
      {},
    );
    const f = setup(c);
    await f.app.inject({ method: 'POST', url: '/api/refresh', headers: LAUNCH });
    await tick();
    const response = await f.app.inject('/api/refresh');
    const state: SweepStatus = response.json();
    expect(state.state).toBe('partial');
    expect(state.sources[0]).toMatchObject({
      state: 'conflict',
      policyConflict: { source: 'conflict' },
    });
    expect(state.sources[1]).toMatchObject({
      state: 'completed',
      projects: [{ state: 'checked' }],
    });
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('reports a skipped manual sweep with zero TTL and performs no upstream call', async () => {
    const c = config();
    c.cache.ttlSeconds = 0;
    const f = setup(c);
    await f.app.inject({ method: 'POST', url: '/api/refresh', headers: LAUNCH });
    await tick();
    expect((await f.app.inject('/api/refresh')).json()).toMatchObject({
      state: 'skipped',
      skipReason: 'caching-disabled',
      sources: [],
      finishedAt: START,
    });
    expect(f.list).not.toHaveBeenCalled();
  });
});

describe('sweep authentication and launch protection', () => {
  it('uses unchanged planning authentication for reads', async () => {
    const f = setup(config(true));
    for (const headers of [
      {},
      { authorization: 'Basic wrong' },
      { cookie: 'ev_session=unknown' },
    ]) {
      const response = await f.app.inject({ url: '/api/refresh', headers });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBeUndefined();
      safe(response);
    }
    const session = await login(f.app);
    for (const headers of [{ cookie: session.cookie }, { authorization: AUTH }]) {
      expect((await f.app.inject({ url: '/api/refresh', headers })).statusCode).toBe(200);
    }
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each([
    ['missing header', { authorization: AUTH }, 403, 'missing-launch-header'],
    [
      'wrong header',
      { authorization: AUTH, 'x-forge-desk-request': '0' },
      403,
      'missing-launch-header',
    ],
    ['no credentials', { ...LAUNCH }, 401, 'unauthenticated'],
    ['bad credentials', { ...LAUNCH, authorization: 'Basic wrong' }, 401, 'unauthenticated'],
    ['expired session', { ...LAUNCH, cookie: 'ev_session=unknown' }, 401, 'unauthenticated'],
    [
      'foreign origin',
      { ...LAUNCH, authorization: AUTH, origin: 'https://evil.example' },
      403,
      'forbidden-origin',
    ],
    [
      'mixed credentials',
      { ...LAUNCH, authorization: AUTH, cookie: 'ev_session=unknown' },
      403,
      'mixed-credentials',
    ],
  ])('rejects %s before launching any work', async (_name, headers, status, code) => {
    const f = setup(config(true));
    const response = await f.app.inject({ method: 'POST', url: '/api/refresh', headers });
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
    safe(response);
    expect(f.scheduler.status).toBeNull();
    expect(f.list).not.toHaveBeenCalled();
  });

  it('requires a browser Origin and its own session CSRF, then accepts the protected launch', async () => {
    const f = setup(config(true));
    const session = await login(f.app),
      other = await login(f.app);
    for (const [headers, code] of [
      [{ ...LAUNCH, ...session }, 'forbidden-origin'],
      [
        {
          ...LAUNCH,
          cookie: session.cookie,
          host: 'desk.example:8080',
          origin: 'http://desk.example:8080',
        },
        'missing-csrf',
      ],
      [
        {
          ...LAUNCH,
          ...session,
          host: 'desk.example:8080',
          origin: 'http://desk.example:8080',
          'x-csrf-token': other['x-csrf-token'],
        },
        'invalid-csrf',
      ],
    ] as const) {
      const response = await f.app.inject({ method: 'POST', url: '/api/refresh', headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe(code);
      safe(response);
      expect(f.scheduler.status).toBeNull();
    }
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/refresh',
      headers: {
        ...LAUNCH,
        ...session,
        host: 'desk.example:8080',
        origin: 'http://desk.example:8080',
      },
    });
    expect(response.statusCode).toBe(200);
    safe(response);
  });

  it('accepts Basic scripts with no Origin or session cookie', async () => {
    const f = setup(config(true));
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/refresh',
      headers: { ...LAUNCH, authorization: AUTH, cookie: 'unrelated=ok' },
    });
    expect(response.statusCode).toBe(200);
    safe(response);
    await tick();
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('honors configured origin behind a rewritten Host and rejects forwarded-origin spoofing', async () => {
    const c = config(true);
    c.server.publicOrigin = 'https://desk.example:8443';
    const f = setup(c);
    const session = await login(f.app);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/refresh',
      headers: {
        ...LAUNCH,
        ...session,
        host: 'internal:3000',
        origin: 'https://desk.example:8443',
      },
    });
    expect(response.statusCode).toBe(200);
    const rejected = await f.app.inject({
      method: 'POST',
      url: '/api/refresh',
      headers: {
        ...LAUNCH,
        authorization: AUTH,
        host: 'internal:3000',
        origin: 'https://evil.example',
        'x-forwarded-host': 'evil.example',
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().code).toBe('forbidden-origin');
    safe(rejected);
  });

  it.each([
    [{}, 'missing-launch-header'],
    [{ ...LAUNCH, origin: 'https://evil.example' }, 'forbidden-origin'],
    [{ ...LAUNCH, cookie: 'ev_session=unknown', authorization: AUTH }, 'mixed-credentials'],
  ])('enforces protection without login for %j', async (headers, code) => {
    const f = setup();
    const response = await f.app.inject({ method: 'POST', url: '/api/refresh', headers });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe(code);
    expect(f.list).not.toHaveBeenCalled();
    safe(response);
  });

  it('allows a no-login same-origin launch with the required non-simple header', async () => {
    const f = setup();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/refresh',
      headers: { ...LAUNCH, host: 'desk.example:8080', origin: 'http://desk.example:8080' },
    });
    expect(response.statusCode).toBe(200);
    safe(response);
    const preflight = await f.app.inject({
      method: 'OPTIONS',
      url: '/api/refresh',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    safe(preflight);
    expect(preflight.statusCode).toBe(404);
  });
});
