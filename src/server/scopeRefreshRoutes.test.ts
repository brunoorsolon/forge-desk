import { setImmediate as immediate } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/load.js';
import type { AppConfig } from '../config/schema.js';
import { parseKey } from '../core/keys.js';
import type { Scope, ScopeResponse } from '../core/scope.js';
import type { FetchResult, Issue, IssueProvider } from '../core/types.js';
import { SCOPE_READ_WAIT_MS } from '../service/scopeReadService.js';
import { createScopeRuntime } from '../service/scopeRuntime.js';
import { buildApp } from './app.js';

const START = '2026-01-01T00:00:00.000Z';
const TOKEN = 'ghp_refresh_test_secret';
const PASSWORD = 'refresh-test-password';
const AUTH = `Basic ${Buffer.from(`account:${PASSWORD}`).toString('base64')}`;
const LAUNCH = { 'x-forge-desk-request': '1' };
const PROJECT = '/api/projects/gh/o/a';
const SOURCE = '/api/sources/gh';
const project: Scope = { kind: 'project', source: 'gh', repo: 'o/a' };
const source: Scope = { kind: 'source', source: 'gh' };
const coverage = { native: 'complete', subIssues: 'complete' } as const;

function issue(key: string, body = ''): Issue {
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
function config(login = false): AppConfig {
  return parseConfig(
    JSON.stringify({
      cache: { ttlSeconds: 60 },
      refresh: { requestsPerMinute: 1000, concurrency: 4 },
      server: login ? { basicAuth: { username: 'account', password: PASSWORD } } : {},
      sources: [{ id: 'gh', kind: 'github', token: TOKEN }],
      views: [{ id: 'roadmap', source: 'gh', repos: ['o/a', 'o/b', 'o/empty'] }],
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
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
});
afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()?.();
  } finally {
    vi.useRealTimers();
  }
});
function setup(appConfig = config()) {
  let cooldownUntil: number | null = null;
  const list = vi.fn<IssueProvider['listOpenIssues']>(async (repo) =>
    listing([issue(`${repo.owner}/${repo.repo}#2`)]),
  );
  const lookup = vi.fn<IssueProvider['getIssue']>(async (repo, number) =>
    issue(`${repo.owner}/${repo.repo}#${number}`),
  );
  const provider: IssueProvider = {
    kind: 'github',
    listOpenIssues: list,
    getIssue: lookup,
    cooldownUntil: () => cooldownUntil,
  };
  const runtime = createScopeRuntime(appConfig, {
    providerFor: () => provider,
    now: () => new Date(),
    shutdownWaitMs: 0,
  });
  const app = buildApp(appConfig, runtime.plans, {
    scopes: runtime,
    webDir: '/tmp/forge-desk-refresh-tests-no-web',
  });
  cleanups.push(() => app.close());
  const seed = () => {
    for (const repo of ['o/a', 'o/b', 'o/empty'])
      runtime.store.writeRepository(
        runtime.store.beginRepositoryRead({ source: 'gh', repo }),
        listing([issue(`${repo}#1`)]),
      );
  };
  return {
    app,
    runtime,
    list,
    lookup,
    seed,
    cooldown: (until: number | null) => {
      cooldownUntil = until;
      runtime.sources[0]!.queue.cooldownChanged();
    },
  };
}
async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ username: 'account', password: PASSWORD }).toString(),
  });
  expect(response.statusCode).toBe(303);
  const cookie = String(response.headers['set-cookie']).split(';')[0]!;
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  return {
    ...LAUNCH,
    cookie,
    origin: 'http://localhost',
    host: 'localhost',
    'x-csrf-token': session.json().csrfToken as string,
  };
}
function protectedResponse(response: Awaited<ReturnType<FastifyInstance['inject']>>) {
  expect(
    Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
  ).toEqual([]);
  expect(response.headers['cache-control']).toBe('no-store');
  for (const secret of [TOKEN, PASSWORD, AUTH]) expect(response.body).not.toContain(secret);
}
function listed(f: ReturnType<typeof setup>) {
  return f.list.mock.calls.map(([repo]) => `${repo.owner}/${repo.repo}`).sort();
}

describe.each([
  ['project', PROJECT, project, ['o/a']],
  ['source', SOURCE, source, ['o/a', 'o/b', 'o/empty']],
] as const)('%s refresh', (_kind, base, scope, repos) => {
  it('rechecks fresh data and returns the snapshot envelope over its whole scope', async () => {
    const f = setup();
    f.seed();
    expect((await f.app.inject(`${base}/snapshot`)).statusCode).toBe(200);
    expect(f.list).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1000);
    const response = await f.app.inject({
      method: 'POST',
      url: `${base}/refresh`,
      headers: LAUNCH,
    });
    expect(response.statusCode).toBe(200);
    protectedResponse(response);
    expect(response.json<ScopeResponse>()).toMatchObject({
      scope,
      snapshot: { fetchedAt: '2026-01-01T00:00:01.000Z' },
      job: null,
    });
    expect(
      response
        .json()
        .snapshot.plan.nodes.map((node: Issue) => node.key)
        .sort(),
    ).toEqual(repos.map((repo) => `${repo}#2`));
    expect(listed(f)).toEqual(repos);
    const snapshot = await f.app.inject(`${base}/snapshot`);
    expect(response.json()).toEqual(snapshot.json());
    expect(listed(f)).toEqual(repos);
  });

  it.each([false, true])(
    'joins running rechecks and waits at most 15 seconds (cached=%s)',
    async (cached) => {
      const f = setup();
      if (cached) f.seed();
      const blocked = gate();
      cleanups.push(blocked.resolve);
      f.list.mockImplementation(async () => {
        await blocked.promise;
        return listing();
      });
      await f.app.ready();
      let settled = 0;
      const requests = Array.from({ length: 2 }, () =>
        f.app
          .inject({ method: 'POST', url: `${base}/refresh`, headers: LAUNCH })
          .then((response) => {
            settled++;
            return response;
          }),
      );
      await tick();
      expect(listed(f)).toEqual(repos);
      await vi.advanceTimersByTimeAsync(SCOPE_READ_WAIT_MS - 1);
      expect(settled).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      const [first, second] = await Promise.all(requests);
      expect(first!.statusCode).toBe(200);
      expect(first!.json().job.id).toBe(second!.json().job.id);
      expect(first!.json().job).toMatchObject({ scope, state: 'running' });
      expect(first!.json().snapshot === null).toBe(!cached);
      expect(listed(f)).toEqual(repos);
      protectedResponse(first!);
      blocked.resolve();
      await f.runtime.jobs.active(scope)?.completion;
      const completed = await f.app.inject(`${base}/snapshot`);
      expect(completed.json().job).toBeNull();
      expect(completed.json().snapshot.plan.nodes).toEqual([]);
      expect(listed(f)).toEqual(repos);
    },
  );

  it('joins queued rechecks during cooldown without extra upstream work', async () => {
    const f = setup();
    f.cooldown(Date.now() + 60_000);
    const first = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers: LAUNCH });
    const second = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers: LAUNCH });
    expect(first.statusCode).toBe(200);
    expect(first.json().job.id).toBe(second.json().job.id);
    expect(first.json().job.delayedUntil).toBe('2026-01-01T00:01:00.000Z');
    expect(f.list).not.toHaveBeenCalled();
    f.cooldown(null);
    await f.runtime.jobs.active(scope)?.completion;
    expect(listed(f)).toEqual(repos);
  });

  it('fails zero-TTL cooldown immediately and refuses new work after runtime shutdown', async () => {
    const appConfig = config();
    appConfig.cache.ttlSeconds = 0;
    const f = setup(appConfig);
    f.cooldown(Date.now() + 60_000);
    const delayed = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers: LAUNCH });
    expect(delayed.statusCode).toBe(503);
    expect(delayed.json()).toMatchObject({
      code: 'source-cooldown',
      delayedUntil: '2026-01-01T00:01:00.000Z',
    });
    protectedResponse(delayed);
    await f.runtime.close();
    const closed = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers: LAUNCH });
    expect(closed.statusCode).toBe(503);
    expect(closed.json().code).toBe('server-closing');
    expect(f.list).not.toHaveBeenCalled();
  });

  it('retains last-good data and redacts upstream failures', async () => {
    const f = setup();
    f.seed();
    f.list.mockRejectedValue(new Error(`provider failed: ${TOKEN}`));
    const response = await f.app.inject({
      method: 'POST',
      url: `${base}/refresh`,
      headers: LAUNCH,
    });
    expect(response.statusCode).toBe(200);
    protectedResponse(response);
    expect(response.json().snapshot.fetchedAt).toBe(START);
    expect(
      response.json().freshness.repositories.every((r: { state: string }) => r.state === 'failed'),
    ).toBe(true);
    expect(response.body).toContain('provider failed: ***');
  });
});

describe('scope refresh boundaries', () => {
  it('lists only the project and fetches exactly its needed outside issues', async () => {
    const f = setup();
    f.list.mockResolvedValue(listing([issue('o/a#1', 'Blocked by o/b#2 and outside/repo#9')]));
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/projects/gh/O/A/refresh',
      headers: LAUNCH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().scope).toEqual(project);
    expect(listed(f)).toEqual(['o/a']);
    expect(
      f.lookup.mock.calls.map(([repo, number]) => `${repo.owner}/${repo.repo}#${number}`).sort(),
    ).toEqual(['o/b#2', 'outside/repo#9']);
    expect(
      response
        .json()
        .snapshot.plan.nodes.map((node: Issue) => node.key)
        .sort(),
    ).toEqual(['o/a#1', 'o/b#2', 'outside/repo#9']);
  });

  it.each([
    ['/api/sources/missing/refresh', 'unknown-source'],
    ['/api/projects/missing/o/a/refresh', 'unknown-source'],
    ['/api/projects/gh/o/missing/refresh', 'unknown-project'],
  ])('returns 404 for %s without upstream work', async (url, code) => {
    const f = setup();
    const response = await f.app.inject({ method: 'POST', url, headers: LAUNCH });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code, error: expect.any(String) });
    protectedResponse(response);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
  });

  it.each([PROJECT, SOURCE])('returns the policy conflict explanation for %s', async (base) => {
    const appConfig = parseConfig(
      JSON.stringify({
        sources: [{ id: 'gh', kind: 'github' }],
        views: [
          { id: 'one', source: 'gh', repos: ['o/a'] },
          { id: 'two', source: 'gh', repos: ['o/b'], dependencies: { native: false } },
        ],
      }),
      {},
    );
    const f = setup(appConfig);
    const response = await f.app.inject({
      method: 'POST',
      url: `${base}/refresh`,
      headers: LAUNCH,
    });
    expect(response.statusCode).toBe(409);
    const policy = appConfig.catalog.sources[0]!.policy;
    expect(policy.status).toBe('conflict');
    expect(response.json()).toEqual({
      code: 'policy-conflict',
      error: policy.status === 'conflict' ? policy.conflict.explanation : '',
    });
    protectedResponse(response);
    expect(f.list).not.toHaveBeenCalled();
  });

  it('does not register refresh routes without the scope runtime', async () => {
    const f = setup();
    const app = buildApp(config(), f.runtime.plans, { webDir: '/tmp/forge-desk-refresh-no-web' });
    cleanups.push(() => app.close());
    for (const base of [PROJECT, SOURCE])
      expect(
        (await app.inject({ method: 'POST', url: `${base}/refresh`, headers: LAUNCH })).statusCode,
      ).toBe(404);
    expect(f.list).not.toHaveBeenCalled();
  });
});

describe.each([PROJECT, SOURCE])('launch protection on %s', (base) => {
  it('accepts header-authenticated scripts and same-origin browser sessions', async () => {
    const f = setup(config(true));
    for (const headers of [{ ...LAUNCH, authorization: AUTH }, await login(f.app)]) {
      const response = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers });
      expect(response.statusCode).toBe(200);
      protectedResponse(response);
    }
  });

  it.each([
    ['missing launch', 'x-forge-desk-request', undefined, 403, 'missing-launch-header'],
    ['wrong launch', 'x-forge-desk-request', 'true', 403, 'missing-launch-header'],
    ['foreign Origin', 'origin', 'http://evil.test', 403, 'forbidden-origin'],
    ['missing Origin', 'origin', undefined, 403, 'forbidden-origin'],
    ['missing CSRF', 'x-csrf-token', undefined, 403, 'missing-csrf'],
    ['wrong CSRF', 'x-csrf-token', 'wrong', 403, 'invalid-csrf'],
    ['mixed credentials', 'authorization', AUTH, 403, 'mixed-credentials'],
    ['expired session', 'cookie', 'ev_session=unknown', 401, 'unauthenticated'],
  ] as const)(
    'rejects browser %s before starting or joining work',
    async (_name, header, value, status, code) => {
      const f = setup(config(true));
      const headers: Record<string, string> = await login(f.app);
      if (value === undefined) delete headers[header];
      else headers[header] = value;
      const response = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers });
      expect(response.statusCode).toBe(status);
      expect(response.json().code).toBe(code);
      protectedResponse(response);
      expect(f.list).not.toHaveBeenCalled();
      expect(f.lookup).not.toHaveBeenCalled();
      expect(f.runtime.jobs.active(project)).toBeNull();
      expect(f.runtime.jobs.active(source)).toBeNull();
    },
  );

  it.each([
    ['missing login', LAUNCH, 401, 'unauthenticated'],
    ['wrong login', { ...LAUNCH, authorization: 'Basic d3Jvbmc6d3Jvbmc=' }, 401, 'unauthenticated'],
    ['script missing launch', { authorization: AUTH }, 403, 'missing-launch-header'],
    [
      'script foreign origin',
      { ...LAUNCH, authorization: AUTH, origin: 'http://evil.test' },
      403,
      'forbidden-origin',
    ],
  ] as const)('rejects %s', async (_name, headers, status, code) => {
    const f = setup(config(true));
    const response = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers });
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
    protectedResponse(response);
    expect(f.list).not.toHaveBeenCalled();
  });

  it('keeps header and Host/Origin checks without a login and never enables CORS', async () => {
    const f = setup();
    for (const [headers, code] of [
      [{}, 'missing-launch-header'],
      [{ ...LAUNCH, origin: 'http://evil.test' }, 'forbidden-origin'],
      [{ ...LAUNCH, origin: 'http://localhost:9999' }, 'forbidden-origin'],
    ] as const) {
      const response = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe(code);
      protectedResponse(response);
    }
    expect(f.list).not.toHaveBeenCalled();
    for (const headers of [
      LAUNCH,
      { ...LAUNCH, host: 'desk.test:8080', origin: 'http://desk.test:8080' },
    ]) {
      const response = await f.app.inject({ method: 'POST', url: `${base}/refresh`, headers });
      expect(response.statusCode).toBe(200);
      protectedResponse(response);
    }
    const preflight = await f.app.inject({
      method: 'OPTIONS',
      url: `${base}/refresh`,
      headers: {
        origin: 'http://evil.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-forge-desk-request',
      },
    });
    expect(preflight.statusCode).toBe(404);
    protectedResponse(preflight);
  });

  it.each([false, true])(
    'trusts the configured origin behind a rewritten Host (login=%s)',
    async (withLogin) => {
      const appConfig = config(withLogin);
      appConfig.server.publicOrigin = 'https://desk.example:8443';
      const f = setup(appConfig);
      const auth = withLogin ? await login(f.app) : LAUNCH;
      for (const [origin, status] of [
        ['https://desk.example:8443', 200],
        ['http://proxy:8080', 403],
      ] as const) {
        const response = await f.app.inject({
          method: 'POST',
          url: `${base}/refresh`,
          headers: { ...auth, host: 'proxy:8080', origin, 'x-forwarded-host': 'evil.test' },
        });
        expect(response.statusCode).toBe(status);
        protectedResponse(response);
      }
    },
  );
});
