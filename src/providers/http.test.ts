import { describe, expect, it } from 'vitest';
import {
  HttpError,
  createHttpClient,
  createLimiter,
  parseLinkHeader,
  sanitizeUrl,
  type FetchLike,
} from './http.js';

const BASE = 'https://api.example.test';
const TOKEN = 'ghp_SUPERSECRET123';

type Handler = (url: string, call: number) => Response | Error;

function fakeFetch(handler: Handler): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const r = handler(url, urls.length);
    if (r instanceof Error) throw r;
    return r;
  }) as FetchLike;
  return { fetch: fetchFn, urls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function setup(handler: Handler, extra: { now?: () => number; maxRetries?: number } = {}) {
  const sleeps: number[] = [];
  let time = extra.now?.() ?? Date.now();
  const { fetch, urls } = fakeFetch(handler);
  const client = createHttpClient({
    baseUrl: BASE + '/',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    fetch,
    ...extra,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  });
  return { client, sleeps, urls };
}

describe('parseLinkHeader', () => {
  it('parses next and last', () => {
    const m = parseLinkHeader(
      '<https://x.test/a?page=2&per_page=100>; rel="next", <https://x.test/a?page=5>; rel="last"',
    );
    expect(m.get('next')).toBe('https://x.test/a?page=2&per_page=100');
    expect(m.get('last')).toBe('https://x.test/a?page=5');
  });

  it('handles null, empty, unquoted rel and multi-rel', () => {
    expect(parseLinkHeader(null).size).toBe(0);
    expect(parseLinkHeader('').size).toBe(0);
    expect(parseLinkHeader('<https://x.test/n>; rel=next').get('next')).toBe('https://x.test/n');
    const m = parseLinkHeader('<https://x.test/n>; rel="next last"');
    expect(m.get('next')).toBe('https://x.test/n');
    expect(m.get('last')).toBe('https://x.test/n');
  });

  it('ignores links without rel and keeps commas inside URLs', () => {
    const m = parseLinkHeader('<https://x.test/skip>; title="t", <https://x.test/a,b>; rel="next"');
    expect(m.get('next')).toBe('https://x.test/a,b');
    expect(m.size).toBe(1);
  });
});

describe('sanitizeUrl', () => {
  it('drops query, fragment and credentials', () => {
    expect(sanitizeUrl('https://u:p@h.test/a/b?access_token=zzz#f')).toBe('https://h.test/a/b');
    expect(sanitizeUrl('/a/b?token=zzz')).toBe('/a/b');
  });
});

describe('createHttpClient.getJson', () => {
  it('returns data, headers and status, sending configured headers', async () => {
    let seenHeaders: unknown;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      seenHeaders = init?.headers;
      return json({ ok: true }, { headers: { 'x-a': '1' } });
    }) as unknown as FetchLike;
    const client = createHttpClient({
      baseUrl: BASE,
      headers: { Accept: 'application/json' },
      fetch: fetchFn,
    });
    const res = await client.getJson<{ ok: boolean }>('/x');
    expect(res.data).toEqual({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-a')).toBe('1');
    expect(seenHeaders).toEqual({ Accept: 'application/json' });
  });

  it('honours Retry-After on 429 and then succeeds', async () => {
    const { client, sleeps, urls } = setup((_u, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : json([1]),
    );
    const res = await client.getJson<number[]>('/x');
    expect(res.data).toEqual([1]);
    expect(urls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it('fails locally instead of shortening a long Retry-After cooldown', async () => {
    const { client, sleeps, urls } = setup(
      () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
    );
    await expect(client.getJson('/x')).rejects.toThrow(/rate limit exceeded/);
    await expect(client.getJson('/y')).rejects.toThrow(/rate limit exceeded/);
    expect(urls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('uses exponential backoff 500, 1000, 2000 and throws after 3 retries on 5xx', async () => {
    const { client, sleeps, urls } = setup(() => new Response('boom', { status: 503 }));
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect(urls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect((err as HttpError).message).toContain('GET https://api.example.test/x');
    expect((err as HttpError).message).toContain('503');
  });

  it('caps backoff at 10 seconds', async () => {
    const { client, sleeps } = setup(() => new Response('', { status: 502 }), { maxRetries: 8 });
    await client.getJson('/x').catch(() => undefined);
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it('retries network errors (TypeError) and recovers', async () => {
    const { client, sleeps } = setup((_u, n) =>
      n < 3 ? new TypeError('fetch failed') : json([2]),
    );
    const res = await client.getJson<number[]>('/x');
    expect(res.data).toEqual([2]);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('throws HttpError with status 0 when network errors persist, without the token', async () => {
    const { client } = setup(
      () => new TypeError(`fetch failed for Bearer ${TOKEN}`, { cause: new Error(TOKEN) }),
    );
    const err = await client.getJson('/x?access_token=abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect((err as HttpError).message).not.toContain(TOKEN);
    expect((err as HttpError).message).not.toContain('access_token');
  });

  it('does not retry other errors (404) and never leaks token or query in the message', async () => {
    const { client, urls } = setup(() => new Response('nope', { status: 404 }));
    const err = await client.getJson('/repos/a/b?token=querysecret').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    expect(e.status).toBe(404);
    expect(urls).toHaveLength(1);
    expect(e.message).toBe('GET https://api.example.test/repos/a/b failed with status 404');
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain('querysecret');
    expect(e.url).toBe('https://api.example.test/repos/a/b');
    expect(String(e.stack)).not.toContain(TOKEN);
  });

  it('waits for the rate-limit reset on 403 when it is close', async () => {
    const nowMs = 1_700_000_000_000;
    const reset = String(nowMs / 1000 + 30);
    const { client, sleeps } = setup(
      (_u, n) =>
        n === 1
          ? new Response('', {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
            })
          : json({ ok: 1 }),
      { now: () => nowMs },
    );
    await client.getJson('/x');
    expect(sleeps).toEqual([31_000]);
  });

  it('throws a clear rate-limit error when the reset is too far away', async () => {
    const nowMs = 1_700_000_000_000;
    const reset = String(nowMs / 1000 + 3600);
    const { client, sleeps, urls } = setup(
      () =>
        new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        }),
      { now: () => nowMs },
    );
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toMatch(/rate limit exceeded/);
    expect(sleeps).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('does not retry a plain 403', async () => {
    const { client, sleeps, urls } = setup(() => new Response('', { status: 403 }));
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
    expect(urls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('refuses absolute URLs on another origin (no credential leak)', async () => {
    const { client, urls } = setup(() => json([]));
    await expect(client.getJson('https://evil.test/steal?x=1')).rejects.toThrow(/origin differs/);
    expect(urls).toHaveLength(0);
  });

  it('throws HttpError on invalid JSON', async () => {
    const { client } = setup(() => new Response('<html>', { status: 200 }));
    await expect(client.getJson('/x')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('createHttpClient.getPaginatedLink', () => {
  it('follows Link rel="next" across pages', async () => {
    const { client, urls } = setup((url) => {
      if (url.endsWith('/list?per_page=2')) {
        return json([1, 2], { headers: { link: `<${BASE}/list?per_page=2&page=2>; rel="next"` } });
      }
      if (url.endsWith('page=2')) {
        return json([3, 4], { headers: { link: `<${BASE}/list?per_page=2&page=3>; rel="next"` } });
      }
      return json([5]);
    });
    expect(await client.getPaginatedLink<number>('/list?per_page=2')).toEqual([1, 2, 3, 4, 5]);
    expect(urls).toHaveLength(3);
  });

  it('rejects a non-array body and a pagination loop', async () => {
    const a = setup(() => json({ nope: true }));
    await expect(a.client.getPaginatedLink('/x')).rejects.toBeInstanceOf(HttpError);
    const b = setup(() => json([1], { headers: { link: `<${BASE}/x>; rel="next"` } }));
    await expect(b.client.getPaginatedLink('/x')).rejects.toThrow(/did not terminate/);
  });
});

describe('conditional GETs', () => {
  it('revalidates paginated responses, retains Link on 304, and replaces changed pages', async () => {
    let changed = false;
    let paidReads = 0;
    const requests: Array<{ url: string; validator: string | null }> = [];
    const client = createHttpClient({
      baseUrl: BASE,
      headers: { Authorization: `Bearer ${TOKEN}` },
      conditionalRequests: true,
      fetch: async (input, init) => {
        const url = String(input);
        const page2 = url.includes('page=2');
        const etag = page2 && changed ? '"changed"' : page2 ? '"second"' : '"first"';
        const validator = new Headers(init?.headers).get('if-none-match');
        requests.push({ url, validator });
        if (validator === etag) return new Response(null, { status: 304 });
        paidReads++;
        return json(page2 ? [changed ? 3 : 2] : [1], {
          headers: page2 ? { etag } : { etag, link: `<${BASE}/list?page=2>; rel="next"` },
        });
      },
    });
    expect(await client.getPaginatedLink('/list')).toEqual([1, 2]);
    expect(await client.getPaginatedLink('/list')).toEqual([1, 2]);
    expect(paidReads).toBe(2);
    changed = true;
    expect(await client.getPaginatedLink('/list')).toEqual([1, 3]);
    expect(paidReads).toBe(3);
    expect(await client.getPaginatedLink('/list')).toEqual([1, 3]);
    expect(requests.at(-1)?.validator).toBe('"changed"');
    expect(paidReads).toBe(3);
  });

  it('uses Last-Modified without an ETag and never reuses no-store or unvalidated payloads', async () => {
    const modified = 'Wed, 28 Oct 2026 12:00:00 GMT';
    const sent: Headers[] = [];
    let call = 0;
    const client = createHttpClient({
      baseUrl: BASE,
      headers: {},
      conditionalRequests: true,
      fetch: async (_input, init) => {
        sent.push(new Headers(init?.headers));
        call++;
        if (call === 1) return json('first', { headers: { 'last-modified': modified } });
        if (call === 2) return new Response(null, { status: 304 });
        if (call === 3)
          return json('private', { headers: { etag: '"private"', 'cache-control': 'no-store' } });
        return json('fresh');
      },
    });
    expect((await client.getJson('/x')).data).toBe('first');
    expect((await client.getJson('/x')).data).toBe('first');
    expect(sent[1]!.get('if-modified-since')).toBe(modified);
    expect((await client.getJson('/x')).data).toBe('private');
    expect((await client.getJson('/x')).data).toBe('fresh');
    expect(sent[3]!.has('if-none-match')).toBe(false);
    expect(sent[3]!.has('if-modified-since')).toBe(false);
    expect((await client.getJson('/x')).data).toBe('fresh');
    expect(sent[4]!.has('if-modified-since')).toBe(false);
  });

  it('shares concurrent reads, isolates clients, and does not keep failed work', async () => {
    let calls = 0;
    const validators: Array<string | null> = [];
    const fetch: FetchLike = async (_input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      validators.push(headers.get('if-none-match'));
      if (calls === 1) return new Response(null, { status: 404 });
      return json(headers.get('authorization'), { headers: { etag: '"v1"' } });
    };
    const first = createHttpClient({
      baseUrl: BASE,
      headers: { Authorization: 'first' },
      fetch,
      conditionalRequests: true,
    });
    const failed = await Promise.allSettled([first.getJson('/x'), first.getJson('/x')]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
    const responses = await Promise.all([first.getJson('/x'), first.getJson('/x')]);
    expect(responses.map((r) => r.data)).toEqual(['first', 'first']);
    expect(calls).toBe(2);
    const second = createHttpClient({
      baseUrl: BASE,
      headers: { Authorization: 'second' },
      fetch,
      conditionalRequests: true,
    });
    expect((await second.getJson('/x')).data).toBe('second');
    expect(validators).toEqual([null, null, null]);
  });
});

describe('shared rate-limit cooldown', () => {
  it.each<{ status: number; headers: Record<string, string>; until: number }>([
    {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' },
      until: 3_601_000,
    },
    { status: 429, headers: { 'retry-after': '3600' }, until: 3_600_000 },
    { status: 403, headers: { 'retry-after': 'Thu, 01 Jan 1970 01:00:00 GMT' }, until: 3_600_000 },
    {
      status: 429,
      headers: { 'retry-after': '2', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' },
      until: 3_601_000,
    },
  ])(
    'stops queued requests and resumes after $status cooldown ($headers)',
    async ({ status, headers, until }) => {
      let time = 0;
      let calls = 0;
      const client = createHttpClient({
        baseUrl: BASE,
        headers: { Authorization: `Bearer ${TOKEN}` },
        now: () => time,
        fetch: async () => {
          calls++;
          return calls === 1 ? new Response(null, { status, headers }) : json('recovered');
        },
      });
      const limit = createLimiter(1);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          limit(() => client.getJson(`/issues/${i}?token=private`)),
        ),
      );
      expect(outcomes.every((r) => r.status === 'rejected')).toBe(true);
      expect(calls).toBe(1);
      time = until - 1;
      await expect(client.getJson('/still-paused')).rejects.toThrow(/rate limit exceeded/);
      expect(calls).toBe(1);
      time = until;
      expect((await client.getJson('/recovery')).data).toBe('recovered');
      expect(calls).toBe(2);
      const first = outcomes[0] as PromiseRejectedResult;
      expect(first.reason.message).not.toContain('private');
      expect(first.reason.message).not.toContain(TOKEN);
    },
  );

  it('pauses other reads while a short retry waits, including after the final successful allowance', async () => {
    let time = 0;
    let calls = 0;
    let resume!: () => void;
    const client = createHttpClient({
      baseUrl: BASE,
      headers: {},
      now: () => time,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          resume = () => {
            time += ms;
            resolve();
          };
        }),
      fetch: async () => {
        calls++;
        if (calls === 1)
          return new Response(null, { status: 429, headers: { 'retry-after': '7' } });
        return json('last allowance', {
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' },
        });
      },
    });
    const waiting = client.getJson('/first');
    // Let the observed response install its cooldown and enter sleep.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(client.getJson('/queued')).rejects.toThrow(/rate limit exceeded/);
    expect(calls).toBe(1);
    resume();
    expect((await waiting).data).toBe('last allowance');
    await expect(client.getJson('/after-last')).rejects.toThrow(/rate limit exceeded/);
    expect(calls).toBe(2);
  });
});

describe('createLimiter', () => {
  it('never runs more than N calls at once and preserves results', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('keeps going after a rejection and rejects invalid concurrency', async () => {
    const limit = createLimiter(1);
    const bad = limit(() => Promise.reject(new Error('x')));
    const good = limit(async () => 'ok');
    await expect(bad).rejects.toThrow('x');
    await expect(good).resolves.toBe('ok');
    await expect(
      limit(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(() => createLimiter(0)).toThrow();
  });
});
