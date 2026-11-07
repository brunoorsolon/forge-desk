import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchViews,
  fetchProjects,
  fetchScopeSnapshot,
  refreshSnapshot,
  fetchReleaseRepositories,
  fetchReleaseJobs,
  fetchReleaseJob,
  fetchReleasePlan,
  fetchReleaseReceipt,
  prepareRelease,
  publishRelease,
  reconcileRelease,
  fetchPreferences,
  savePreference,
  onSessionExpired,
} from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preference caller boundary', () => {
  const profile = { available: true, revision: 1, favorites: [], rememberedProject: null };
  it('uses a passive relative read and fresh session CSRF for each mutation', async () => {
    let proof = 0;
    const fetch = vi.fn(async (path: string, _init: RequestInit) =>
      Response.json(
        path === 'api/session' ? { username: 'operator', csrfToken: `proof-${++proof}` } : profile,
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(fetchPreferences()).resolves.toEqual(profile);
    const project = { source: 'source /', repo: 'owner/repo name' };
    for (const kind of ['add-favorite', 'remove-favorite', 'remember-project'] as const)
      await expect(savePreference({ kind, project })).resolves.toEqual(profile);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/preferences',
      'api/session',
      'api/preferences/favorites',
      'api/session',
      'api/preferences/favorites/source%20%2F/owner/repo%20name',
      'api/session',
      'api/preferences/remembered-project',
    ]);
    const writes = [fetch.mock.calls[2]![1], fetch.mock.calls[4]![1], fetch.mock.calls[6]![1]];
    expect(writes.map((init) => init.method)).toEqual(['POST', 'DELETE', 'PUT']);
    expect(writes.map((init) => (init.headers as Record<string, string>)['x-csrf-token'])).toEqual([
      'proof-1',
      'proof-2',
      'proof-3',
    ]);
    expect(writes.map((init) => init.body)).toEqual([
      JSON.stringify(project),
      undefined,
      JSON.stringify(project),
    ]);
  });

  it('never sends a preference mutation without live browser proof', async () => {
    const fetch = vi.fn(async () => Response.json({ username: 'operator', csrfToken: null }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      savePreference({ kind: 'add-favorite', project: { source: 'one', repo: 'o/r' } }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not send a mutation if logout aborts the pending session read', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return Response.json({ username: 'operator', csrfToken: 'old-session' });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      savePreference(
        { kind: 'add-favorite', project: { source: 'one', repo: 'o/r' } },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('signals expiry synchronously before redirecting, for any API request', async () => {
    const events: string[] = [];
    const unsubscribe = onSessionExpired(() => events.push('clear'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'Sign in again' }, { status: 401 })),
    );
    vi.stubGlobal('location', {
      hash: '#/project/one/o/r',
      assign: (path: string) => events.push(path),
    });
    try {
      await expect(fetchViews()).rejects.toMatchObject({ status: 401 });
      expect(events).toEqual(['clear', 'login#/project/one/o/r']);
      unsubscribe();
      events.length = 0;
      await expect(fetchPreferences()).rejects.toMatchObject({ status: 401 });
      expect(events).toEqual(['login#/project/one/o/r']);
    } finally {
      unsubscribe();
    }
  });
});

describe('snapshot refresh', () => {
  it('uses the shared cache for automatic polls but forces an explicit manual refresh', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ viewId: 'a/b' })));
    vi.stubGlobal('fetch', fetch);
    await expect(refreshSnapshot('a/b', false)).resolves.toEqual({ viewId: 'a/b' });
    await expect(refreshSnapshot('a/b')).resolves.toEqual({ viewId: 'a/b' });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/views/a%2Fb/snapshot',
      'api/views/a%2Fb/refresh',
    ]);
    expect(fetch.mock.calls[0]?.[1].method).toBeUndefined();
    expect(fetch.mock.calls[1]?.[1].method).toBe('POST');
  });
});

describe('release caller boundary', () => {
  it('uses only configured IDs and a fresh session CSRF proof for preparation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ username: 'operator', csrfToken: 'session-proof' }))
      .mockResolvedValueOnce(Response.json({ jobId: 'tracked-job' }));
    vi.stubGlobal('fetch', fetch);
    await expect(prepareRelease('repo / ?')).resolves.toEqual({ jobId: 'tracked-job' });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/session',
      'api/releases/repositories/repo%20%2F%20%3F/prepare',
    ]);
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ accept: 'application/json', 'x-csrf-token': 'session-proof' });
    expect(init.body).toBeUndefined();
  });

  it('does not submit preparation without browser session proof', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ username: 'operator', csrfToken: null }));
    vi.stubGlobal('fetch', fetch);
    await expect(prepareRelease('app')).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads repositories, bounded history, job and plan without issuing a write', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal('fetch', fetch);
    await fetchReleaseRepositories();
    await fetchReleaseJobs('repo/1');
    await fetchReleaseJob('job/1');
    await fetchReleasePlan('plan/1');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/releases/repositories',
      'api/releases/repositories/repo%2F1/jobs?limit=25',
      'api/releases/jobs/job%2F1',
      'api/releases/plans/plan%2F1',
    ]);
    expect(fetch.mock.calls.every(([, init]) => init.method === undefined)).toBe(true);
  });
});

describe('approval and recovery boundary', () => {
  it('submits only the reviewed plan digest with a fresh session CSRF proof', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ username: 'operator', csrfToken: 'session-proof' }))
      .mockResolvedValueOnce(Response.json({ jobId: 'publish-1' }, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const digest = 'a'.repeat(64);
    await expect(publishRelease('plan/1', digest)).resolves.toEqual({ jobId: 'publish-1' });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/session',
      'api/releases/plans/plan%2F1/publish',
    ]);
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ digest }));
    expect(init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': 'session-proof',
    });
  });

  it('does not submit an approval without browser session proof', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ username: 'operator', csrfToken: null }));
    vi.stubGlobal('fetch', fetch);
    await expect(publishRelease('plan-1', 'a'.repeat(64))).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the stable error code of a refused approval', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ username: 'operator', csrfToken: 'session-proof' }))
      .mockResolvedValueOnce(
        Response.json(
          { code: 'attempt-unresolved', error: 'a prior publication needs inspection' },
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const error: unknown = await publishRelease('plan-1', 'a'.repeat(64)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe('attempt-unresolved');
    expect((error as ApiError).message).toBe('a prior publication needs inspection');
  });

  it('requests one read-only reconciliation and reads receipts as text', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ username: 'operator', csrfToken: 'session-proof' }))
      .mockResolvedValueOnce(Response.json({ jobId: 'reconcile-1' }, { status: 202 }))
      .mockResolvedValueOnce(new Response('Receipt body', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await reconcileRelease('job/1');
    await expect(fetchReleaseReceipt('job/1')).resolves.toBe('Receipt body');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/session',
      'api/releases/jobs/job%2F1/reconcile',
      'api/releases/jobs/job%2F1/receipt',
    ]);
    const reconcile = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(reconcile.method).toBe('POST');
    expect(reconcile.body).toBeUndefined();
    expect(reconcile.headers).toEqual({
      accept: 'application/json',
      'x-csrf-token': 'session-proof',
    });
    expect((fetch.mock.calls[2]?.[1] as RequestInit | undefined)?.method).toBeUndefined();
  });
});

describe('network failures', () => {
  it('names Forge Desk when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const error: unknown = await fetchViews().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(
      'Network error: could not reach the Forge Desk server.',
    );
  });
});

describe('scope reads', () => {
  it('uses relative catalog and encoded scope snapshot URLs without refresh mutations', async () => {
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json({}));
    vi.stubGlobal('fetch', fetch);
    await fetchProjects();
    await fetchScopeSnapshot({ kind: 'project', source: 'source /', repo: 'owner/repo name' });
    await fetchScopeSnapshot({ kind: 'source', source: 'source /' });
    expect(fetch.mock.calls.map((args) => args[0])).toEqual([
      'api/projects',
      'api/projects/source%20%2F/owner/repo%20name/snapshot',
      'api/sources/source%20%2F/snapshot',
    ]);
    expect(fetch.mock.calls.every((args) => (args[1] as RequestInit).method === undefined)).toBe(
      true,
    );
  });
});
