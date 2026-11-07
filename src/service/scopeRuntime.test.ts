import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/load.js';
import type { Scope } from '../core/scope.js';
import { createProvider } from '../providers/index.js';
import { createScopeRuntime, type ScopeRuntime } from './scopeRuntime.js';

const project = (repo = 'acme/api'): Scope => ({ kind: 'project', source: 'demo', repo });
const tick = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
const runtimes: ScopeRuntime[] = [];
function config(network = true) {
  const c = loadConfig({
    path: fileURLToPath(new URL('../../config.demo.yaml', import.meta.url)),
    env: {},
  });
  c.refresh = { sweepHours: 0, concurrency: 1, requestsPerMinute: 1 };
  c.cache.ttlSeconds = 60;
  c.sources[0]!.planning!.dependencies = {
    ...c.sources[0]!.planning!.dependencies,
    native: false,
    subIssues: false,
    body: false,
  };
  c.views[0]!.dependencies = c.sources[0]!.planning!.dependencies;
  if (network) {
    Object.assign(c.sources[0]!, {
      kind: 'github',
      path: null,
      baseUrl: 'https://api.github.com',
      webUrl: 'https://github.com',
    });
    c.catalog.sources[0]!.kind = 'github';
  }
  return c;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-11-07T00:00:00Z');
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  vi.useRealTimers();
});
function runtime(...args: Parameters<typeof createScopeRuntime>) {
  const r = createScopeRuntime(...args);
  runtimes.push(r);
  return r;
}

describe('shared scope server runtime', () => {
  it('shares one provider and GitHub conditional cache across named views and scope reads', async () => {
    const calls: Headers[] = [];
    const c = config();
    c.views[0]!.repos = [{ owner: 'acme', repo: 'api' }];
    const factory = vi.fn(createProvider);
    const r = runtime(c, {
      providerFor: factory,
      fetch: async (_input, init) => {
        calls.push(new Headers(init?.headers));
        return calls.length === 1
          ? new Response('[]', { headers: { ETag: '"same"' } })
          : new Response(null, { status: 304 });
      },
    });
    await r.plans.getSnapshot('demo');
    const response = await r.reads.get(project());
    expect(response.snapshot?.viewId).toBe('project:demo/acme/api');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.get('if-none-match')).toBe('"same"');
  });

  it('paces scopes by source but leaves named views and forced exports unpaced', async () => {
    const starts: number[] = [];
    const c = config();
    const r = runtime(c, {
      fetch: async () => {
        starts.push(Date.now());
        return new Response('[]');
      },
    });
    await r.reads.get(project());
    const second = r.reads.get(project('acme/web'));
    await tick();
    expect(starts).toHaveLength(1);
    await r.plans.getSnapshot('demo');
    expect(starts).toHaveLength(3);
    await r.exportRead(project(), { refresh: true });
    expect(starts).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    await second;
    expect(starts).toHaveLength(5);
    expect(starts[4]! - starts[0]!).toBe(60_000);
  });

  it('enforces configured fetch concurrency and isolates sources', async () => {
    const c = config();
    c.refresh.requestsPerMinute = 100;
    c.sources.push({ ...c.sources[0]!, id: 'other' });
    c.catalog.sources.push({
      ...c.catalog.sources[0]!,
      id: 'other',
      projects: [{ source: 'other', repo: 'acme/api' }],
    });
    const gates: (() => void)[] = [];
    const r = runtime(c, {
      fetch: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return new Response('[]');
      },
    });
    const first = r.reads.get({ kind: 'source', source: 'demo' });
    const other = r.reads.get({ kind: 'source', source: 'other' });
    await tick();
    expect(gates).toHaveLength(2);
    gates[0]!();
    await tick();
    expect(gates).toHaveLength(3);
    gates[1]!();
    gates[2]!();
    await Promise.all([first, other]);
  });

  it('a named-view cooldown delays scopes before upstream and export fails locally', async () => {
    const c = config();
    c.views[0]!.repos = [{ owner: 'acme', repo: 'api' }];
    let calls = 0;
    const r = runtime(c, {
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '3600' } })
          : new Response('[]');
      },
    });
    await expect(r.plans.getSnapshot('demo')).rejects.toThrow('rate limit');
    const response = await r.reads.get(project());
    expect(response.job?.delayedUntil).toBe('2026-11-07T01:00:00.000Z');
    expect(response.freshness.repositories[0]!.state).toBe('delayed');
    expect((await r.exportRead(project(), { refresh: true })).snapshot).toBeNull();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect((await r.reads.get(project())).snapshot).not.toBeNull();
    expect(calls).toBe(2);
  });

  it.each(
    [403, 429].flatMap((status) =>
      [false, true].flatMap((invalidated) =>
        ['project', 'source'].map((kind) => ({ status, invalidated, kind })),
      ),
    ),
  )(
    'an export before browsing preserves a $kind retry during $status cooldown (invalidated: $invalidated)',
    async ({ status, invalidated, kind }) => {
      const c = config();
      c.cache.ttlSeconds = 300;
      c.refresh.requestsPerMinute = 1000;
      c.views[0]!.repos = [{ owner: 'acme', repo: 'api' }];
      const scope: Scope = kind === 'project' ? project() : { kind: 'source', source: 'demo' };
      let throttled = false;
      const fetch = vi.fn(async () =>
        throttled
          ? new Response('', { status, headers: { 'Retry-After': '120' } })
          : new Response('[]'),
      );
      const r = runtime(c, { fetch });
      if (invalidated) {
        await r.reads.get(scope);
        r.store.invalidateRepository({ source: 'demo', repo: 'acme/api' });
      }
      throttled = true;
      await expect(r.plans.getSnapshot('demo')).rejects.toThrow('rate limit');
      const calls = fetch.mock.calls.length;
      const before = r.store.readRepository({ source: 'demo', repo: 'acme/api' });
      const exported = await r.exportRead(scope, { refresh: invalidated });
      expect(exported.snapshot === null).toBe(!invalidated);
      const after = r.store.readRepository({ source: 'demo', repo: 'acme/api' });
      expect(after?.observation.lastAttempt ?? null).toEqual(
        before?.observation.lastAttempt ?? null,
      );
      expect(after?.failedGeneration).toBeNull();
      expect(after?.invalidated).toBe(invalidated);

      const response = await r.reads.get(scope);
      expect(response.job).toMatchObject({
        state: 'queued',
        delayedUntil: '2026-11-07T00:02:00.000Z',
      });
      expect(response.freshness.repositories.every((repo) => repo.state === 'delayed')).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(calls);
      throttled = false;
      await vi.advanceTimersByTimeAsync(119_999);
      expect(fetch).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      const refreshed = await r.reads.get(scope);
      expect(refreshed.snapshot).not.toBeNull();
      expect(refreshed.job).toBeNull();
      expect(refreshed.freshness.repositories.every((repo) => repo.state === 'fresh')).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(calls + (kind === 'project' ? 1 : 2));
    },
  );

  it.each([403, 429])(
    'a %s first observed by an export does not postpone browsing past cooldown',
    async (status) => {
      const c = config();
      c.cache.ttlSeconds = 300;
      const fetch = vi.fn(async () =>
        fetch.mock.calls.length === 1
          ? new Response('', { status, headers: { 'Retry-After': '120' } })
          : new Response('[]'),
      );
      const r = runtime(c, { fetch });
      expect((await r.exportRead(project())).snapshot).toBeNull();
      expect(
        r.store.readRepository({ source: 'demo', repo: 'acme/api' })?.observation.lastAttempt,
      ).toBeNull();
      const response = await r.reads.get(project());
      expect(response.job?.delayedUntil).toBe('2026-11-07T00:02:00.000Z');
      await vi.advanceTimersByTimeAsync(120_000);
      expect((await r.reads.get(project())).snapshot).not.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('still records a forbidden export without a provider cooldown as a failed attempt', async () => {
    const c = config();
    c.cache.ttlSeconds = 300;
    const fetch = vi.fn(async () => new Response('', { status: 403 }));
    const r = runtime(c, { fetch });
    expect((await r.exportRead(project())).snapshot).toBeNull();
    expect(
      r.store.readRepository({ source: 'demo', repo: 'acme/api' })?.observation.lastAttempt,
    ).toMatchObject({ outcome: 'failed' });
    expect((await r.reads.get(project())).job).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not let an export cooldown suppress a later outside-issue lookup', async () => {
    const c = config();
    c.cache.ttlSeconds = 300;
    c.refresh.requestsPerMinute = 1000;
    c.sources[0]!.planning!.dependencies.body = true;
    const raw = {
      number: 1,
      title: 'Needs an outside issue',
      state: 'open',
      html_url: 'https://github.com/acme/api/issues/1',
      body: 'Blocked by: other/lib#7',
      labels: [],
      assignees: [],
      milestone: null,
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/repos/other/lib/issues/7'))
        return new Response(JSON.stringify({ ...raw, number: 7, state: 'closed', body: '' }));
      return new Response(JSON.stringify([raw]), {
        headers:
          fetch.mock.calls.length === 1
            ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() / 1000 + 120) }
            : {},
      });
    });
    const r = runtime(c, { fetch });
    const exported = await r.exportRead(project());
    expect(exported.snapshot).not.toBeNull();
    expect(exported.freshness.outsideIssues.provisionalCount).toBe(1);
    const outside = { source: 'demo', key: 'other/lib#7' };
    expect(r.store.readOutsideIssue(outside)?.observation.lastAttempt).toBeNull();
    const delayed = await r.reads.get(project());
    expect(delayed.job?.delayedUntil).toBe('2026-11-07T00:02:01.000Z');
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(121_000);
    const refreshed = await r.reads.get(project());
    expect(refreshed.job).toBeNull();
    expect(refreshed.freshness.outsideIssues.provisionalCount).toBe(0);
    expect(r.store.readOutsideIssue(outside)?.observation.result).toMatchObject({
      status: 'found',
      issue: { state: 'closed' },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves a pending browse retry when cooldown starts between export listing pages', async () => {
    const c = config();
    c.cache.ttlSeconds = 300;
    const fetch = vi.fn(
      async () =>
        new Response('[]', {
          headers: {
            link: '<https://api.github.com/repos/acme/api/issues?page=2>; rel="next"',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Date.now() / 1000 + 120),
          },
        }),
    );
    const r = runtime(c, { fetch });
    expect((await r.exportRead(project())).snapshot).toBeNull();
    expect(
      r.store.readRepository({ source: 'demo', repo: 'acme/api' })?.observation.lastAttempt,
    ).toBeNull();
    expect((await r.reads.get(project())).job?.delayedUntil).toBe('2026-11-07T00:02:01.000Z');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => new Response('[]'));
    await vi.advanceTimersByTimeAsync(121_000);
    expect((await r.reads.get(project())).snapshot).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fixture sources bypass the source request budget', async () => {
    const r = runtime(config(false));
    expect((await r.reads.get({ kind: 'source', source: 'demo' })).snapshot).not.toBeNull();
    expect((await r.reads.refresh(project())).snapshot).not.toBeNull();
  });

  it('closing releases HTTP waiters, abandons queued fetches and bounds the in-flight drain', async () => {
    let finish!: () => void;
    let calls = 0;
    const r = runtime(config(), {
      shutdownWaitMs: 20,
      fetch: async () => {
        calls++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return new Response('[]');
      },
    });
    const read = r.reads.get({ kind: 'source', source: 'demo' });
    await tick();
    expect(calls).toBe(1);
    let closed = false;
    const closing = r.close().then(() => {
      closed = true;
    });
    await read;
    await vi.advanceTimersByTimeAsync(19);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    await expect(r.reads.get(project())).rejects.toThrow('closed');
    await expect(r.exportRead(project())).rejects.toThrow('closed');
    finish();
    await tick();
    expect(calls).toBe(1);
  });
});
