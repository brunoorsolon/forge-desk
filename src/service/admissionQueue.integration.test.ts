import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdmissionQueue } from './admissionQueue.js';
import { createGiteaProvider } from '../providers/gitea.js';
import { createGitHubProvider } from '../providers/github.js';
import { createHttpClient } from '../providers/http.js';

const json = (body: unknown) => new Response(JSON.stringify(body));
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

describe('admission with real provider helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());

  it('holds new units and retries before provider cooldown guards execute', async () => {
    let calls = 0;
    const q = new AdmissionQueue({
      concurrency: 4,
      requestsPerMinute: 60,
      cooldownUntil: () => provider.cooldownUntil!(),
    });
    const provider = createGitHubProvider({
      token: null,
      fetch: q.wrapFetch(async () => {
        calls++;
        return calls === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '3600' } })
          : json([]);
      }),
    });
    const work = () =>
      provider.listOpenIssues({ owner: 'a', repo: 'r' }, { native: false, subIssues: false });
    await expect(q.submit('first', 'sweep', work)).rejects.toThrow('rate limit');
    let finished = false;
    const second = q.submit('second', 'sweep', work).then(() => {
      finished = true;
    });
    const retry = q.submit('first', 'interactive', work);
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(calls).toBe(1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([second, retry]);
    expect(finished).toBe(true);
    await q.close();
  });

  it('isolates limiter lanes and preserves admission context under concurrent named views', async () => {
    const starts: string[] = [];
    const q = new AdmissionQueue({ concurrency: 10, requestsPerMinute: 3 });
    const provider = createGitHubProvider({
      token: null,
      concurrency: 2,
      fetch: q.wrapFetch(async (input) => {
        const path = new URL(String(input)).pathname;
        starts.push(path);
        await new Promise((r) => setTimeout(r, 10));
        return path.endsWith('/issues')
          ? json(
              Array.from({ length: 9 }, (_, i) => ({
                number: i + 1,
                title: 'issue',
                state: 'open',
                html_url: 'https://github.com/a/r/issues/1',
              })),
            )
          : json([]);
      }),
    });
    const view = provider.listOpenIssues(
      { owner: 'a', repo: 'view' },
      { native: true, subIssues: false },
    );
    await vi.advanceTimersByTimeAsync(15);
    const unit = q.submit('unit', 'sweep', () =>
      provider.listOpenIssues({ owner: 'a', repo: 'unit' }, { native: true, subIssues: false }),
    );
    const rejected = expect(unit).rejects.toThrow('closed');
    await vi.advanceTimersByTimeAsync(100);
    await view;
    expect(starts.filter((p) => p.includes('/unit/'))).toHaveLength(3);
    // A later view must not wait behind paused relation reads, either.
    const later = provider.listOpenIssues(
      { owner: 'a', repo: 'later' },
      { native: true, subIssues: false },
    );
    await vi.advanceTimersByTimeAsync(100);
    await later;
    expect(starts.filter((p) => p.includes('/unit/'))).toHaveLength(3);
    await q.close();
    await rejected;
  });

  it('does not coalesce unpaced reads with a paced in-flight request for the same URL', async () => {
    const starts: string[] = [];
    const q = new AdmissionQueue({ concurrency: 1, requestsPerMinute: 1 });
    const client = createHttpClient({
      baseUrl: 'https://test',
      headers: {},
      conditionalRequests: true,
      fetch: q.wrapFetch(async (input) => {
        starts.push(String(input));
        return json({ ok: true });
      }),
    });
    const unit = q.submit('unit', 'sweep', async () => {
      await client.getJson('/used');
      await client.getJson('/x');
    });
    const rejected = expect(unit).rejects.toThrow('closed');
    await tick();
    await expect(client.getJson('/x')).resolves.toMatchObject({ data: { ok: true } });
    expect(starts).toEqual(['https://test/used', 'https://test/x']);
    await q.close();
    await rejected;
  });
  it.each([
    ['github', false],
    ['github', true],
    ['gitea', false],
    ['gitea', true],
  ] as const)(
    'completes 5000 real %s provider units without recursive admission (cooldown=%s)',
    async (kind, delayed) => {
      const until = delayed ? Date.now() + 200 : null;
      let calls = 0;
      let active = 0;
      let maxActive = 0;
      const q = new AdmissionQueue({
        concurrency: 4,
        requestsPerMinute: 1_000_000,
        cooldownUntil: () => until,
      });
      const fetch = q.wrapFetch(async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        // Keep the fetch pending for one microtask to observe real concurrency.
        await Promise.resolve();
        active--;
        return json([]);
      });
      const provider =
        kind === 'github'
          ? createGitHubProvider({ token: null, fetch })
          : createGiteaProvider({ baseUrl: 'https://gitea.test', token: null, fetch });
      const work = Array.from({ length: 5_000 }, (_, index) =>
        q.submit(`repository-${index}`, index % 4 === 0 ? 'sweep' : 'interactive', () =>
          provider.listOpenIssues(
            { owner: 'owner', repo: `repo-${index}` },
            { native: false, subIssues: false },
          ),
        ),
      );
      const settled = Promise.allSettled(work);
      if (delayed) {
        await vi.advanceTimersByTimeAsync(199);
        expect(calls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
      }
      const results = await settled;
      expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
      expect(results).toHaveLength(5_000);
      expect(calls).toBe(5_000);
      expect(maxActive).toBeLessThanOrEqual(4);
      await q.close();
      expect(vi.getTimerCount()).toBe(0);
    },
    20_000,
  );
});
