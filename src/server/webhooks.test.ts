import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/load.js';
import { parseKey } from '../core/keys.js';
import type { Scope, ScopeResponse } from '../core/scope.js';
import type { FetchResult, Issue, IssueProvider, Snapshot } from '../core/types.js';
import { createScopeRuntime } from '../service/scopeRuntime.js';
import { buildApp } from './app.js';

const SECRET = 'scope-webhook-test-secret';
const coverage = { native: 'complete', subIssues: 'complete' } as const;
const sources = [
  { id: 'gh-one', kind: 'github' },
  { id: 'gh-two', kind: 'github' },
  { id: 'gt-one', kind: 'gitea', baseUrl: 'https://forge.example/api/v1' },
  { id: 'gt-two', kind: 'gitea', baseUrl: 'https://other.example/api/v1' },
  { id: 'fixture', kind: 'fixture', path: './fixtures/demo' },
] as const;
const project = (source = 'gh-one'): Scope => ({ kind: 'project', source, repo: 'o/a' });
const projectPath = (source = 'gh-one') => `/api/projects/${source}/o/a`;

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

const listing = (issues: Issue[]): FetchResult => ({
  issues,
  warnings: [],
  relationCoverage: coverage,
});

function fakeProvider(kind: IssueProvider['kind']) {
  return {
    kind,
    listOpenIssues: vi.fn<IssueProvider['listOpenIssues']>(async (repo) =>
      listing([issue(`${repo.owner}/${repo.repo}#1`)]),
    ),
    getIssue: vi.fn<IssueProvider['getIssue']>(async (repo, number) =>
      issue(`${repo.owner}/${repo.repo}#${number}`),
    ),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function setup() {
  const config = parseConfig(
    JSON.stringify({
      cache: { ttlSeconds: 3600 },
      refresh: { requestsPerMinute: 1000 },
      webhooks: { secret: SECRET },
      sources,
      views: sources.map((source) => ({
        id: source.id,
        source: source.id,
        repos: ['o/a', 'o/b'],
      })),
    }),
    {},
  );
  const providers = new Map<string, ReturnType<typeof fakeProvider>>();
  const runtime = createScopeRuntime(config, {
    shutdownWaitMs: 0,
    providerFor: (source) => {
      const provider = fakeProvider(source.kind);
      providers.set(source.id, provider);
      return provider;
    },
  });
  const app = buildApp(config, runtime.plans, {
    scopes: runtime,
    webDir: '/tmp/forge-desk-webhook-tests-no-web',
  });
  cleanups.push(() => app.close());
  const callCounts = () =>
    [...providers].map(([id, provider]) => [
      id,
      provider.listOpenIssues.mock.calls.length,
      provider.getIssue.mock.calls.length,
    ]);
  return { app, runtime, providers, callCounts };
}

function deliver(
  app: FastifyInstance,
  kind: 'github' | 'gitea',
  repo: string,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify({ repository: { full_name: repo } });
  return post(app, kind, body, headers);
}

function post(
  app: FastifyInstance,
  kind: 'github' | 'gitea',
  body: string,
  headers: Record<string, string> = {},
) {
  const signature = createHmac('sha256', SECRET).update(body).digest('hex');
  return app.inject({
    method: 'POST',
    url: `/api/webhooks/${kind}`,
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...(kind === 'github'
        ? { 'x-hub-signature-256': `sha256=${signature}` }
        : { 'x-gitea-signature': signature }),
      ...headers,
    },
  });
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { resolve, promise };
}

describe('webhook invalidation of scopes', () => {
  it.each(['github', 'gitea'] as const)(
    '%s invalidates every candidate source and All projects, without fetching or changing named views',
    async (kind) => {
      const f = setup();
      for (const { id } of sources) {
        const scope = await f.app.inject(`/api/sources/${id}/snapshot`);
        expect(scope.json().freshness.repositories.map((r: { state: string }) => r.state)).toEqual([
          'fresh',
          'fresh',
        ]);
        await f.app.inject(`/api/views/${id}/snapshot`);
      }
      const calls = f.callCounts();
      // Provider kind is determined by the route, not an event header from another forge.
      const response = await deliver(f.app, kind, ' O/A ', { 'x-forgejo-event': 'issues' });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ invalidated: sources.map((s) => s.id).sort() });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(f.callCounts()).toEqual(calls);

      for (const source of sources) {
        const cached = f.runtime.reads.cached({ kind: 'source', source: source.id });
        expect(cached.freshness.repositories.map((r) => r.state)).toEqual([
          source.kind === kind ? 'invalidated' : 'fresh',
          'fresh',
        ]);
        expect(cached.snapshot?.plan.warnings.some((w) => w.code === 'stale-data')).toBe(
          source.kind === kind,
        );
        // Cached exports see the invalidation too, without starting a source refresh.
        const exported = await f.app.inject(`/api/sources/${source.id}/export.json`);
        expect(exported.statusCode).toBe(200);
        expect(exported.json<Snapshot>().plan.warnings.some((w) => w.code === 'stale-data')).toBe(
          source.kind === kind,
        );
      }
      expect(f.callCounts()).toEqual(calls);

      const affected = sources.find((s) => s.kind === kind)!;
      const provider = f.providers.get(affected.id)!;
      provider.listOpenIssues.mockClear();
      provider.listOpenIssues.mockResolvedValue(listing([issue('o/a#2')]));
      await f.app.inject(`${projectPath(affected.id)}/snapshot`);
      await f.runtime.jobs.active(project(affected.id))?.completion;
      expect(
        provider.listOpenIssues.mock.calls.map(([repo]) => `${repo.owner}/${repo.repo}`),
      ).toEqual(['o/a']);
      const updated = await f.app.inject(`/api/sources/${affected.id}/snapshot`);
      expect(updated.json().snapshot.plan.nodes.map((node: Issue) => node.key)).toEqual([
        'o/a#2',
        'o/b#1',
      ]);
      expect(provider.listOpenIssues).toHaveBeenCalledTimes(1);

      // Legacy named-view invalidation still crosses provider kinds, as before.
      const other = sources.find((s) => s.kind !== kind)!;
      const otherProvider = f.providers.get(other.id)!;
      const before = otherProvider.listOpenIssues.mock.calls.length;
      await f.app.inject(`/api/views/${other.id}/snapshot`);
      expect(otherProvider.listOpenIssues.mock.calls.length).toBe(before + 2);
    },
  );

  it('invalidates external context in every candidate, even with no named view or project for it', async () => {
    const f = setup();
    for (const { id } of sources) {
      f.providers
        .get(id)!
        .listOpenIssues.mockImplementation(async (repo) =>
          listing([issue(`${repo.owner}/${repo.repo}#1`, 'Blocked by: outside/context#9')]),
        );
      await f.app.inject(`${projectPath(id)}/snapshot`);
      await f.app.inject(`/api/sources/${id}/snapshot`);
    }
    const before = f.callCounts();
    const response = await deliver(f.app, 'github', 'OUTSIDE/Context');
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ invalidated: [] });
    for (const { id, kind } of sources) {
      const observation = f.runtime.store.readOutsideIssue({
        source: id,
        key: 'outside/context#9',
      });
      expect(observation?.invalidated).toBe(kind === 'github');
      for (const scope of [project(id), { kind: 'source', source: id } as Scope]) {
        const cached = f.runtime.reads.cached(scope);
        expect(cached.snapshot?.plan.warnings.some((w) => w.code === 'stale-data')).toBe(
          kind === 'github',
        );
      }
    }
    expect(f.callCounts()).toEqual(before);
    const provider = f.providers.get('gh-one')!;
    provider.listOpenIssues.mockClear();
    provider.getIssue.mockClear();
    await f.app.inject(`${projectPath()}/snapshot`);
    await f.runtime.jobs.active(project())?.completion;
    expect(provider.listOpenIssues.mock.calls.map(([repo]) => repo.repo)).toEqual(['a']);
    expect(provider.getIssue).toHaveBeenCalledTimes(1);
    expect(
      f.runtime.store.readOutsideIssue({ source: 'gh-one', key: 'outside/context#9' })?.invalidated,
    ).toBe(false);
  });

  it('invalidates plans using a catalog sibling as external context without relisting that sibling', async () => {
    const f = setup();
    const provider = f.providers.get('gh-one')!;
    provider.listOpenIssues.mockImplementation(async (repo) =>
      listing([issue(`o/${repo.repo}#1`, repo.repo === 'a' ? 'Blocked by: o/b#1' : '')]),
    );
    await f.app.inject('/api/sources/gh-one/snapshot');
    await f.app.inject(`${projectPath()}/snapshot`);
    const before = f.callCounts();
    await deliver(f.app, 'github', 'o/b');
    const affected = f.runtime.reads.cached(project());
    expect(affected.snapshot?.plan.warnings).toContainEqual(
      expect.objectContaining({ code: 'stale-data', issues: ['o/b#1'] }),
    );
    expect(f.callCounts()).toEqual(before);
    provider.listOpenIssues.mockClear();
    provider.getIssue.mockClear();
    await f.app.inject(`${projectPath()}/snapshot`);
    await f.runtime.jobs.active(project())?.completion;
    expect(provider.listOpenIssues.mock.calls.map(([repo]) => repo.repo)).toEqual(['a']);
    expect(
      provider.getIssue.mock.calls.map(([repo, number]) => `${repo.owner}/${repo.repo}#${number}`),
    ).toEqual(['o/b#1']);
  });

  it.each(['repository', 'outside-issue'] as const)(
    'a %s fetch started before delivery stays stale until a post-delivery read succeeds',
    async (unit) => {
      const f = setup();
      const provider = f.providers.get('gh-one')!;
      const started = gate();
      const release = gate();
      if (unit === 'repository') {
        provider.listOpenIssues.mockImplementationOnce(async () => {
          started.resolve();
          await release.promise;
          return listing([issue('o/a#1')]);
        });
      } else {
        provider.listOpenIssues.mockResolvedValue(
          listing([issue('o/a#1', 'Blocked by: outside/context#9')]),
        );
        provider.getIssue.mockImplementationOnce(async () => {
          started.resolve();
          await release.promise;
          return issue('outside/context#9');
        });
      }
      const read = f.app.inject(`${projectPath()}/snapshot`).then((response) => response);
      await started.promise;
      const before = f.callCounts();
      await deliver(f.app, 'github', unit === 'repository' ? 'o/a' : 'outside/context');
      expect(f.callCounts()).toEqual(before);
      release.resolve();
      const raced = (await read).json<ScopeResponse>();
      expect(raced.snapshot?.plan.warnings.some((w) => w.code === 'stale-data')).toBe(true);
      const observation = () =>
        unit === 'repository'
          ? f.runtime.store.readRepository({ source: 'gh-one', repo: 'o/a' })
          : f.runtime.store.readOutsideIssue({ source: 'gh-one', key: 'outside/context#9' });
      expect(observation()?.invalidated).toBe(true);
      expect(f.runtime.jobs.active(project())).toBeNull();
      // No automatic retry on completion; another read initiates revalidation.
      expect(f.callCounts()).toEqual(before);
      await f.app.inject(`${projectPath()}/snapshot`);
      await f.runtime.jobs.active(project())?.completion;
      expect(observation()?.invalidated).toBe(false);
      const fresh = await f.app.inject(`${projectPath()}/snapshot`);
      expect(
        fresh.json<ScopeResponse>().snapshot?.plan.warnings.some((w) => w.code === 'stale-data'),
      ).toBe(false);
      expect(provider.listOpenIssues).toHaveBeenCalledTimes(2);
      expect(provider.getIssue).toHaveBeenCalledTimes(unit === 'outside-issue' ? 2 : 0);
    },
  );

  it.each([
    [
      'invalid signature',
      JSON.stringify({ repository: { full_name: 'o/a' } }),
      { 'x-hub-signature-256': 'sha256=bad' },
      401,
    ],
    [
      'ping',
      JSON.stringify({ repository: { full_name: 'o/a' } }),
      { 'x-github-event': 'ping' },
      200,
    ],
    ['invalid JSON', 'not JSON', {}, 400],
    ['no repository', '{}', {}, 202],
    ['unknown repository', JSON.stringify({ repository: { full_name: 'unseen/repo' } }), {}, 202],
  ] as const)(
    '%s does not invalidate scope data or start work',
    async (_name, body, headers, status) => {
      const f = setup();
      await f.app.inject(`${projectPath()}/snapshot`);
      const before = f.runtime.store.readRepository({ source: 'gh-one', repo: 'o/a' });
      const calls = f.callCounts();
      expect((await post(f.app, 'github', body, headers)).statusCode).toBe(status);
      expect(f.runtime.store.readRepository({ source: 'gh-one', repo: 'o/a' })).toEqual(before);
      expect(f.callCounts()).toEqual(calls);
      for (const { id } of sources) {
        expect(f.runtime.store.readRepository({ source: id, repo: 'unseen/repo' })).toBeUndefined();
      }
    },
  );
});
