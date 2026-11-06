import { AsyncLocalStorage } from 'node:async_hooks';
import type { FetchLike } from '../providers/http.js';

export type AdmissionPriority = 'interactive' | 'sweep';

export class AdmissionShutdownError extends Error {
  constructor() {
    super('Source admission queue is closed');
    this.name = 'AdmissionShutdownError';
  }
}

export interface AdmissionQueueOptions {
  concurrency: number;
  requestsPerMinute: number;
  fixture?: boolean;
  /** Source-local provider cooldown, in epoch milliseconds. */
  cooldownUntil?: () => number | null;
  now?: () => number;
  shutdownWaitMs?: number;
}

interface Unit {
  priority: AdmissionPriority;
  running: boolean;
  settled: boolean;
  promise: Promise<unknown>;
  reject: (error: unknown) => void;
}

interface PendingRequest {
  unit: Unit;
  start: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/**
 * One instance per source. Units are coalesced, but limits apply to individual
 * fetch calls (including pages, relation reads and retries), not to whole units.
 * Wrap the shared provider's fetch once; named views outside submit() remain unpaced.
 */
export class AdmissionQueue {
  private readonly context = new AsyncLocalStorage<Unit>();
  private readonly units = new Map<string, Unit>();
  private readonly requests: PendingRequest[] = [];
  private readonly starts: number[] = [];
  private readonly now: () => number;
  private active = 0;
  private interactiveStarts = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closePromise: Promise<void> | undefined;
  private drained: (() => void) | undefined;

  constructor(private readonly options: AdmissionQueueOptions) {
    for (const value of [options.concurrency, options.requestsPerMinute]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error('Admission limits must be positive safe integers');
      }
    }
    if (
      options.shutdownWaitMs !== undefined &&
      (!Number.isFinite(options.shutdownWaitMs) || options.shutdownWaitMs < 0)
    ) {
      throw new Error('Shutdown wait must be finite and nonnegative');
    }
    this.now = options.now ?? Date.now;
  }

  /** Keys must identify the same operation and result type within this source. */
  submit<T>(key: string, priority: AdmissionPriority, work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AdmissionShutdownError());
    const existing = this.units.get(key);
    if (existing) {
      if (priority === 'interactive') existing.priority = priority;
      this.pump();
      return existing.promise as Promise<T>;
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const unit: Unit = { priority, running: false, settled: false, promise, reject };
    this.units.set(key, unit);
    // A microtask permits joins/promotions and shutdown before work is admitted.
    queueMicrotask(() => {
      if (unit.settled) return;
      unit.running = true;
      void this.context.run(unit, async () => {
        try {
          resolve(await work());
        } catch (error) {
          reject(error);
        } finally {
          unit.settled = true;
          this.units.delete(key);
        }
      });
    });
    return promise;
  }

  wrapFetch(fetch: FetchLike): FetchLike {
    return (input, init) => {
      const unit = this.context.getStore();
      if (!unit) return fetch(input, init);
      if (this.closed) return Promise.reject(new AdmissionShutdownError());
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise<Response>((resolve, reject) => {
        const request: PendingRequest = {
          unit,
          reject,
          cleanup: () => signal?.removeEventListener('abort', abort),
          start: () => {
            this.active++;
            // Consume synchronous throws and rejected fetches identically.
            void (async () => {
              try {
                resolve(await fetch(input, init));
              } catch (error) {
                reject(error);
              } finally {
                this.active--;
                if (this.closed && this.active === 0) this.drained?.();
                this.pump();
              }
            })();
          },
        };
        const abort = (): void => {
          const index = this.requests.indexOf(request);
          if (index < 0) return;
          this.requests.splice(index, 1);
          request.cleanup();
          reject(signal?.reason);
          this.pump();
        };
        signal?.addEventListener('abort', abort, { once: true });
        this.requests.push(request);
        this.pump();
      });
    };
  }

  get status(): { delayed: boolean; delayedUntil: number | null; inFlight: number } {
    const until = this.options.fixture ? null : (this.options.cooldownUntil?.() ?? null);
    const delayedUntil = until !== null && until > this.now() ? until : null;
    return { delayed: delayedUntil !== null, delayedUntil, inFlight: this.active };
  }

  /** Call when an external source operation changes/clears its cooldown. */
  cooldownChanged(): void {
    this.pump();
  }

  /** No new paced requests start; already-started fetches are not aborted. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const [key, unit] of this.units) {
      if (!unit.running) {
        unit.settled = true;
        unit.reject(new AdmissionShutdownError());
        this.units.delete(key);
      }
    }
    for (const request of this.requests.splice(0)) {
      request.cleanup();
      request.reject(new AdmissionShutdownError());
    }
    this.closePromise = new Promise<void>((resolve) => {
      if (this.active === 0) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, this.options.shutdownWaitMs ?? 5_000);
      const self = this;
      function finish(): void {
        clearTimeout(timer);
        self.drained = undefined;
        resolve();
      }
      this.drained = finish;
    });
    return this.closePromise;
  }

  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    while (
      this.requests.length > 0 &&
      (this.options.fixture || this.active < this.options.concurrency)
    ) {
      const now = this.now();
      while (this.starts.length && this.starts[0]! <= now - 60_000) this.starts.shift();
      if (!this.options.fixture) {
        const cooldown = this.status.delayedUntil ?? 0;
        const rateEnd =
          this.starts.length >= this.options.requestsPerMinute ? this.starts[0]! + 60_000 : 0;
        const waitUntil = Math.max(cooldown, rateEnd);
        if (waitUntil > now) {
          this.timer = setTimeout(() => this.pump(), Math.min(waitUntil - now, 2_147_483_647));
          return;
        }
      }
      const interactive = this.requests.findIndex((r) => r.unit.priority === 'interactive');
      const sweep = this.requests.findIndex((r) => r.unit.priority === 'sweep');
      const index =
        sweep >= 0 && (interactive < 0 || this.interactiveStarts >= 3) ? sweep : interactive;
      const request = this.requests.splice(index, 1)[0]!;
      this.interactiveStarts = request.unit.priority === 'sweep' ? 0 : this.interactiveStarts + 1;
      if (!this.options.fixture) this.starts.push(now);
      request.cleanup();
      request.start();
    }
  }
}
