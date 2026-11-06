import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdmissionQueue, AdmissionShutdownError } from './admissionQueue.js';
import type { FetchLike } from '../providers/http.js';

const tick = async (): Promise<void> => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const ok: FetchLike = async () => new Response('ok');
function queue(options: Partial<ConstructorParameters<typeof AdmissionQueue>[0]> = {}) {
  return new AdmissionQueue({ concurrency: 1, requestsPerMinute: 100, ...options });
}

describe('per-source request admission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps each page/relation/retry request, not just its unit, in any sliding minute', async () => {
    const q = queue({ concurrency: 2, requestsPerMinute: 3 });
    const starts: number[] = [];
    let active = 0;
    let max = 0;
    const f = q.wrapFetch(async () => {
      starts.push(Date.now());
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
      return new Response();
    });
    const done = q.submit('listing', 'interactive', async () => {
      await Promise.all([
        f('https://test/page1'),
        f('https://test/relation'),
        f('https://test/retry'),
      ]);
      await f('https://test/page2');
      await f('https://test/page3');
    });
    await tick();
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(59_899);
    expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(301);
    await done;
    expect(max).toBe(2);
    expect(starts).toEqual([100_000, 100_000, 100_100, 160_000, 160_100]);
    for (const t of starts)
      expect(starts.filter((s) => s > t - 60_000 && s <= t).length).toBeLessThanOrEqual(3);
    await q.close();
  });

  it('prioritizes interactive requests while reserving at least every fourth start for sweep', async () => {
    const q = queue();
    const gate = deferred<Response>();
    const order: string[] = [];
    const f = q.wrapFetch(async (url) => {
      order.push(String(url));
      return url === 'held' ? gate.promise : new Response();
    });
    const first = q.submit('held', 'interactive', () => f('held'));
    await tick();
    const sweeps = Array.from({ length: 4 }, (_, i) =>
      q.submit(`s${i}`, 'sweep', () => f(`s${i}`)),
    );
    const interactive = Array.from({ length: 12 }, (_, i) =>
      q.submit(`i${i}`, 'interactive', () => f(`i${i}`)),
    );
    await tick();
    gate.resolve(new Response());
    await Promise.all([first, ...sweeps, ...interactive]);
    expect(order.slice(1, 3)).toEqual(['i0', 'i1']);
    expect(order.filter((x) => x.startsWith('s'))).toEqual(['s0', 's1', 's2', 's3']);
    const sweepPositions = order.map((x, i) => (x.startsWith('s') ? i : -1)).filter((i) => i >= 0);
    expect(sweepPositions).toEqual([3, 7, 11, 15]);
    await q.close();
  });

  it('joins queued and running units and promotes their pending requests', async () => {
    const q = queue({ requestsPerMinute: 1 });
    const calls: string[] = [];
    const f = q.wrapFetch(async (url) => {
      calls.push(String(url));
      return new Response();
    });
    const work = vi.fn(async () => {
      await f('first');
      await f('second');
      return 42;
    });
    const a = q.submit('same', 'sweep', work);
    const b = q.submit('same', 'sweep', async () => 0);
    expect(a).toBe(b);
    await tick();
    const other = q.submit('other', 'sweep', () => f('other'));
    const c = q.submit('same', 'interactive', async () => 0);
    expect(c).toBe(a);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['first', 'second']);
    expect(await c).toBe(42);
    await vi.advanceTimersByTimeAsync(60_000);
    await other;
    expect(work).toHaveBeenCalledTimes(1);
    await q.close();
  });

  it('promotes a queued unit before its work starts, and shares errors with joiners', async () => {
    const q = queue();
    const failure = new Error('failed');
    const work = vi.fn(async () => {
      throw failure;
    });
    const a = q.submit('key', 'sweep', work);
    const b = q.submit('key', 'interactive', async () => 5);
    await expect(a).rejects.toBe(failure);
    await expect(b).rejects.toBe(failure);
    expect(work).toHaveBeenCalledTimes(1);
    expect(await q.submit('key', 'interactive', async () => 6)).toBe(6);
    await q.close();
  });

  it('waits for source cooldown, observes extensions, and leaves another source independent', async () => {
    let until: number | null = 101_000;
    const q = queue({ cooldownUntil: () => until });
    const other = queue();
    const fetch = vi.fn(ok);
    const f = q.wrapFetch(fetch);
    const done = q.submit('key', 'interactive', () => f('url'));
    await tick();
    expect(q.status).toEqual({ delayed: true, delayedUntil: 101_000, inFlight: 0 });
    await other.submit('key', 'interactive', () => other.wrapFetch(fetch)('other'));
    expect(fetch).toHaveBeenCalledTimes(1);
    until = 102_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(q.status.delayed).toBe(false);
    await q.close();
    await other.close();
  });

  it('can wake promptly when the provider clears its cooldown', async () => {
    let until: number | null = 200_000;
    const q = queue({ cooldownUntil: () => until });
    const fetch = vi.fn(ok);
    const done = q.submit('key', 'interactive', () => q.wrapFetch(fetch)('url'));
    await tick();
    until = null;
    q.cooldownChanged();
    await done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await q.close();
  });

  it('keeps named views outside units unpaced, even while a unit is waiting or queue is closed', async () => {
    const q = queue({ cooldownUntil: () => 200_000 });
    const fetch = vi.fn(ok);
    const f = q.wrapFetch(fetch);
    const inside = q.submit('key', 'interactive', () => f('inside'));
    const failed = expect(inside).rejects.toBeInstanceOf(AdmissionShutdownError);
    await tick();
    await f('outside');
    expect(fetch).toHaveBeenCalledTimes(1);
    await q.close();
    await failed;
    await f('outside-after-close');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fixture sources skip both caps and cooldowns', async () => {
    const q = queue({ fixture: true, requestsPerMinute: 1, cooldownUntil: () => 999_999 });
    const gate = deferred<Response>();
    const fetch = vi.fn(() => gate.promise);
    const f = q.wrapFetch(fetch);
    const done = q.submit('fixture', 'sweep', () => Promise.all([f('a'), f('b'), f('c')]));
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(q.status.delayed).toBe(false);
    gate.resolve(new Response());
    await done;
    await q.close();
  });

  it('shutdown rejects queued units without invoking them and rejects new admission', async () => {
    const q = queue();
    const work = vi.fn(async () => 1);
    const unit = q.submit('key', 'sweep', work);
    const failed = expect(unit).rejects.toBeInstanceOf(AdmissionShutdownError);
    const close = q.close();
    expect(q.close()).toBe(close);
    await close;
    await failed;
    expect(work).not.toHaveBeenCalled();
    await expect(q.submit('new', 'interactive', work)).rejects.toBeInstanceOf(
      AdmissionShutdownError,
    );
  });

  it('shutdown rejects pending fetches and drains started requests without starting subsequent pages', async () => {
    const q = queue();
    const gate = deferred<Response>();
    const fetch = vi.fn(() => gate.promise);
    const f = q.wrapFetch(fetch);
    const running = q.submit('running', 'interactive', async () => {
      await f('a');
      return f('page2');
    });
    const pending = q.submit('pending', 'sweep', () => f('b'));
    const fails = [
      expect(running).rejects.toBeInstanceOf(AdmissionShutdownError),
      expect(pending).rejects.toBeInstanceOf(AdmissionShutdownError),
    ];
    await tick();
    let drained = false;
    const close = q.close().then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    gate.resolve(new Response());
    await close;
    await Promise.all(fails);
    expect(drained).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shutdown is bounded when a request never settles', async () => {
    const q = queue({ shutdownWaitMs: 250 });
    const gate = deferred<Response>();
    const done = q.submit('key', 'interactive', () => q.wrapFetch(() => gate.promise)('url'));
    await tick();
    let drained = false;
    const close = q.close().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await close;
    expect(drained).toBe(true);
    gate.resolve(new Response());
    await done;
  });

  it('releases capacity on synchronous throws and removes aborted queued requests', async () => {
    const q = queue({ requestsPerMinute: 1 });
    const f = q.wrapFetch(() => {
      throw new Error('sync');
    });
    await expect(q.submit('bad', 'interactive', () => f('a'))).rejects.toThrow('sync');
    const controller = new AbortController();
    const fetch = vi.fn(ok);
    const aborted = q.submit('abort', 'sweep', () =>
      q.wrapFetch(fetch)('b', { signal: controller.signal }),
    );
    const failed = expect(aborted).rejects.toThrow('cancelled');
    await tick();
    controller.abort(new Error('cancelled'));
    await failed;
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await q.close();
  });

  it('validates limits and shutdown wait', () => {
    for (const concurrency of [0, -1, 1.2, Infinity])
      expect(() => queue({ concurrency })).toThrow();
    for (const requestsPerMinute of [0, -1, 1.2, Infinity])
      expect(() => queue({ requestsPerMinute })).toThrow();
    expect(() => queue({ shutdownWaitMs: -1 })).toThrow();
  });
  it('close cancels units selected by pump but not yet dispatched', async () => {
    const q = queue();
    const work = vi.fn(async () => 1);
    const result = q.submit('scheduled', 'interactive', work);
    const rejected = expect(result).rejects.toBeInstanceOf(AdmissionShutdownError);
    // The submit pump runs first, then close, then the selected unit callback.
    const closing = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        void q.close().then(resolve);
      });
    });
    await closing;
    await rejected;
    expect(work).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks cooldown between selecting a unit and invoking its provider', async () => {
    let until: number | null = null;
    const q = queue({ cooldownUntil: () => until });
    const work = vi.fn(async () => 1);
    const result = q.submit('scheduled', 'interactive', work);
    queueMicrotask(() => {
      until = Date.now() + 200;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(1);
    expect(work).toHaveBeenCalledTimes(1);
    await q.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
