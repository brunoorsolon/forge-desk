/**
 * Shared HTTP helpers for the API providers: JSON GET with retries, Link-header
 * pagination and a small concurrency limiter. Error messages never contain the
 * query string of a URL or any credential sent in the request headers.
 */

export type FetchLike = typeof fetch;

/** Non-2xx response, rate limit, or a network failure (status 0). */
export class HttpError extends Error {
  readonly status: number;
  /** Sanitized URL (no query string, no fragment, no credentials). */
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export interface HttpClientOptions {
  /** Absolute base URL. A trailing slash is stripped. */
  baseUrl: string;
  /** Sent with every request. Credential-looking values are redacted from error messages. */
  headers: Record<string, string>;
  fetch?: FetchLike;
  /** Injectable so tests stay fast. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms), only used to compute rate-limit waits. Defaults to Date.now. */
  now?: () => number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Revalidate cached GET responses and share identical in-flight reads. Default false. */
  conditionalRequests?: boolean;
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export interface HttpClient {
  /** `pathOrUrl` is a path starting with "/" (relative to baseUrl) or an absolute URL on the origin of baseUrl. */
  getJson<T>(pathOrUrl: string): Promise<JsonResponse<T>>;
  /** GETs a JSON array endpoint and follows `Link: <...>; rel="next"` until exhausted. */
  getPaginatedLink<T>(path: string): Promise<T[]>;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;
const RATE_LIMIT_MARGIN_MS = 1_000;
const MAX_PAGES = 1000;
const MAX_CACHED_RESPONSES = 1000;

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Parses a Link header into a map rel -> url. A link with several rels ("next last") registers each. */
export function parseLinkHeader(header: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!header) return result;
  const linkRe = /<([^>]*)>((?:\s*;\s*[^;,]*)*)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(header)) !== null) {
    const url = m[1] ?? '';
    const params = m[2] ?? '';
    const relMatch = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
    if (!relMatch) continue;
    const rels = (relMatch[1] ?? relMatch[2] ?? '').split(/\s+/).filter((r) => r !== '');
    for (const rel of rels) {
      const key = rel.toLowerCase();
      if (!result.has(key)) result.set(key, url);
    }
  }
  return result;
}

/** Removes query, fragment and credentials from a URL, for use in messages. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

/** Returns a limiter that runs at most `concurrency` calls at the same time. */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`createLimiter: concurrency must be a positive integer, got ${concurrency}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= concurrency) return;
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        let p: Promise<T>;
        try {
          p = Promise.resolve(fn());
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

function secretsFrom(headers: Record<string, string>): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (n === 'authorization' || n.includes('token') || n.includes('api-key')) {
      if (value.length >= 4) secrets.add(value);
      const last = value.trim().split(/\s+/).pop();
      if (last && last.length >= 4) secrets.add(last);
    }
  }
  return [...secrets];
}

function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const fetchFn: FetchLike = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const maxRetries = opts.maxRetries ?? 3;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const baseOrigin = new URL(baseUrl).origin;
  const secrets = secretsFrom(opts.headers);
  const cache = new Map<string, JsonResponse<unknown>>();
  const inFlight = new Map<string, Promise<JsonResponse<unknown>>>();
  let cooldown: { until: number; status: number } | undefined;

  const redact = (text: string): string => {
    let out = text;
    for (const s of secrets) out = out.split(s).join('***');
    return out;
  };

  const resolveUrl = (pathOrUrl: string): string => {
    if (pathOrUrl.startsWith('/')) return baseUrl + pathOrUrl;
    let parsed: URL;
    try {
      parsed = new URL(pathOrUrl);
    } catch {
      throw new Error(`Invalid request path: ${redact(sanitizeUrl(pathOrUrl))}`);
    }
    if (parsed.origin !== baseOrigin) {
      // Never send credentials to a host other than the configured one.
      throw new Error(
        `Refusing to request ${redact(sanitizeUrl(pathOrUrl))}: origin differs from ${baseOrigin}`,
      );
    }
    return parsed.toString();
  };

  const backoffMs = (retryIndex: number): number =>
    Math.min(BACKOFF_BASE_MS * 2 ** retryIndex, BACKOFF_CAP_MS);

  function remember(url: string, response: JsonResponse<unknown>): void {
    cache.delete(url);
    if (
      opts.conditionalRequests &&
      (response.headers.has('etag') || response.headers.has('last-modified')) &&
      !/\bno-store\b/i.test(response.headers.get('cache-control') ?? '')
    ) {
      cache.set(url, response);
      if (cache.size > MAX_CACHED_RESPONSES) cache.delete(cache.keys().next().value!);
    }
  }

  async function requestJson<T>(url: string): Promise<JsonResponse<T>> {
    const safeUrl = redact(sanitizeUrl(url));
    const describe = `GET ${safeUrl}`;
    const rateLimitError = (): HttpError =>
      new HttpError(
        `${describe} failed: rate limit exceeded (status ${cooldown!.status}), resets at ${new Date(cooldown!.until).toISOString()}`,
        cooldown!.status,
        safeUrl,
      );

    for (let attempt = 0; ; attempt++) {
      // Queued work fails locally; only the request that observed a short cooldown waits.
      if (cooldown !== undefined && now() < cooldown.until) throw rateLimitError();
      const canRetry = attempt < maxRetries;
      const cached = cache.get(url) as JsonResponse<T> | undefined;
      const headers = { ...opts.headers };
      const etag = cached?.headers.get('etag');
      const modified = cached?.headers.get('last-modified');
      if (etag) headers['If-None-Match'] = etag;
      else if (modified) headers['If-Modified-Since'] = modified;
      let res: Response;
      try {
        res = await fetchFn(url, { method: 'GET', headers });
      } catch (err) {
        if (err instanceof TypeError) {
          if (canRetry) {
            await sleep(backoffMs(attempt));
            continue;
          }
          const cause = err.cause instanceof Error ? err.cause.message : err.message;
          throw new HttpError(
            redact(`${describe} failed: network error (${cause}) after ${attempt + 1} attempts`),
            0,
            safeUrl,
          );
        }
        throw err;
      }

      const status = res.status;
      const at = now();
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), at);
      const reset = res.headers.get('x-ratelimit-reset');
      const resetMs = reset !== null && /^\d+$/.test(reset.trim()) ? Number(reset) * 1000 : NaN;
      const exhausted =
        res.headers.get('x-ratelimit-remaining')?.trim() === '0' &&
        Number.isFinite(new Date(resetMs).getTime());
      const rateLimited =
        status === 429 || (status === 403 && (exhausted || retryAfterMs !== null));
      if (exhausted || rateLimited) {
        const until = Math.max(
          exhausted ? Math.max(at, resetMs) + RATE_LIMIT_MARGIN_MS : at,
          rateLimited ? at + (retryAfterMs ?? (exhausted ? 0 : 60_000)) : at,
        );
        if (cooldown === undefined || until > cooldown.until) {
          cooldown = { until, status: status === 429 ? 429 : 403 };
        }
      }

      if (status === 304 && cached !== undefined) {
        const merged = new Headers(cached.headers);
        res.headers.forEach((value, name) => merged.set(name, value));
        const response = { data: cached.data, headers: merged, status };
        remember(url, response);
        return response;
      }
      if (status >= 200 && status < 300) {
        const text = await res.text();
        let data: T;
        try {
          data = (text === '' ? null : JSON.parse(text)) as T;
        } catch {
          cache.delete(url);
          throw new HttpError(
            `${describe} returned invalid JSON (status ${status})`,
            status,
            safeUrl,
          );
        }
        const response = { data, headers: res.headers, status };
        remember(url, response);
        return response;
      }

      await discardBody(res);
      cache.delete(url);
      if (rateLimited) {
        const waitMs = Math.max(0, cooldown!.until - now());
        if (canRetry && waitMs <= RATE_LIMIT_MAX_WAIT_MS + RATE_LIMIT_MARGIN_MS) {
          await sleep(waitMs);
          continue;
        }
        throw rateLimitError();
      }
      const waitMs = RETRY_STATUSES.has(status) ? (retryAfterMs ?? backoffMs(attempt)) : null;
      if (waitMs !== null && canRetry && waitMs <= RATE_LIMIT_MAX_WAIT_MS) {
        await sleep(waitMs);
        continue;
      }
      const attempts = waitMs !== null ? ` after ${attempt + 1} attempts` : '';
      throw new HttpError(`${describe} failed with status ${status}${attempts}`, status, safeUrl);
    }
  }

  async function getJson<T>(pathOrUrl: string): Promise<JsonResponse<T>> {
    const url = resolveUrl(pathOrUrl);
    if (!opts.conditionalRequests) return requestJson<T>(url);
    const running = inFlight.get(url);
    if (running !== undefined) return running as Promise<JsonResponse<T>>;
    const promise = requestJson<T>(url);
    inFlight.set(url, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(url);
    }
  }

  async function getPaginatedLink<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let next: string | undefined = path;
    for (let page = 0; next !== undefined; page++) {
      if (page >= MAX_PAGES || seen.has(next)) {
        const safe = redact(sanitizeUrl(next));
        throw new HttpError(`GET ${safe} failed: pagination did not terminate`, 0, safe);
      }
      seen.add(next);
      const res: JsonResponse<T[]> = await getJson<T[]>(next);
      if (!Array.isArray(res.data)) {
        const safe = redact(sanitizeUrl(next));
        throw new HttpError(`GET ${safe} returned a non-array JSON body`, res.status, safe);
      }
      for (const item of res.data) items.push(item);
      next = parseLinkHeader(res.headers.get('link')).get('next');
    }
    return items;
  }

  return { getJson, getPaginatedLink };
}
