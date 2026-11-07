import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSweep, refreshAllSources, refreshScope } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('protected refresh callers', () => {
  it.each([
    [
      { kind: 'project' as const, source: 'one /', repo: 'owner/a b' },
      'api/projects/one%20%2F/owner/a%20b/refresh',
    ],
    [{ kind: 'source' as const, source: 'one /' }, 'api/sources/one%20%2F/refresh'],
  ])('encodes a scope and obtains a fresh session proof for every launch', async (scope, path) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ username: 'operator', csrfToken: 'proof' }))
      .mockResolvedValueOnce(Response.json({ scope }));
    vi.stubGlobal('fetch', fetch);
    await expect(refreshScope(scope)).resolves.toEqual({ scope });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['api/session', path]);
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      headers: { 'x-forge-desk-request': '1', 'x-csrf-token': 'proof' },
    });
  });
  it.each([404, 200])(
    'supports the no-session mode (%i) without inventing a token',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ csrfToken: null }, { status }))
        .mockResolvedValueOnce(Response.json({ id: 'sweep' }))
        .mockResolvedValueOnce(Response.json({ id: 'sweep' }));
      vi.stubGlobal('fetch', fetch);
      await refreshAllSources();
      await fetchSweep();
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        'api/session',
        'api/refresh',
        'api/refresh',
      ]);
      expect(fetch.mock.calls[1]![1]).toEqual({
        method: 'POST',
        headers: { accept: 'application/json', 'x-forge-desk-request': '1' },
      });
      expect(fetch.mock.calls[2]![1].method).toBeUndefined();
    },
  );
  it('uses the session CSRF token for an all-source launch', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'proof' }))
      .mockResolvedValueOnce(Response.json({ id: 'sweep' }));
    vi.stubGlobal('fetch', fetch);
    await refreshAllSources();
    expect(fetch.mock.calls[1]![1].headers['x-csrf-token']).toBe('proof');
  });
  it.each([401, 403, 500])('does not launch after a session failure (%i)', async (status) => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, hash: '#/source/one/graph' });
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'session failed' }, { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(refreshAllSources()).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
  it('does not launch after network or malformed session responses', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('{'));
    vi.stubGlobal('fetch', fetch);
    await expect(refreshAllSources()).rejects.toMatchObject({ status: 0 });
    await expect(refreshAllSources()).rejects.toThrow('invalid response');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
