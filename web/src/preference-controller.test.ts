import { describe, expect, it, vi } from 'vitest';
import type { AvailablePreferences, PreferencesResponse } from '../../src/core/preferences.js';
import type { PreferenceMutation } from './preferenceState.js';
import { createPreferenceController } from './preference-controller.js';

const a = { source: 'one', repo: 'owner/a' };
const b = { source: 'two', repo: 'owner/b' };
const profile = (revision = 0, favorites = [a]): AvailablePreferences => ({
  available: true,
  revision,
  favorites: favorites.map((project) => ({ ...project, inCatalog: true })),
  rememberedProject: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let n = 0; n < 8; n++) await Promise.resolve();
}
function setup() {
  const reads: (ReturnType<typeof deferred<PreferencesResponse>> & { signal: AbortSignal })[] = [];
  const saves: (ReturnType<typeof deferred<PreferencesResponse>> & {
    signal: AbortSignal;
    mutation: PreferenceMutation;
  })[] = [];
  let expired!: () => void;
  const changed = vi.fn();
  const unsubscribe = vi.fn();
  const controller = createPreferenceController(changed, {
    read: (signal) => {
      const call = { ...deferred<PreferencesResponse>(), signal };
      reads.push(call);
      return call.promise;
    },
    save: (mutation, signal) => {
      const call = { ...deferred<PreferencesResponse>(), signal, mutation };
      saves.push(call);
      return call.promise;
    },
    onExpired: (listener) => {
      expired = listener;
      return unsubscribe;
    },
  });
  return { controller, reads, saves, expired: () => expired(), changed, unsubscribe };
}
async function loaded() {
  const h = setup();
  h.controller.load('open');
  h.reads[0]!.resolve(profile());
  await flush();
  return h;
}

describe('preference IO wiring', () => {
  it('reads on open, tab return and retry, and exposes startup results without writing', async () => {
    const h = setup();
    expect(h.controller.startup()).toBeNull();
    h.controller.load('open');
    h.reads[0]!.resolve(profile());
    await flush();
    expect(h.controller.startup()).toEqual(profile());
    h.controller.load('tab-return');
    h.reads[1]!.resolve({ ...profile(2), rememberedProject: b });
    await flush();
    h.controller.load('reload');
    expect(h.reads).toHaveLength(3);
    expect(h.saves).toHaveLength(0);
    expect(h.controller.get().confirmed?.rememberedProject).toEqual(b);
  });

  it('serializes optimistic add, remove and re-add, applying authoritative revisions', async () => {
    const h = await loaded();
    h.controller.toggleFavorite(b, true);
    h.controller.toggleFavorite(a, false);
    h.controller.toggleFavorite(a, true);
    expect(h.saves.map((call) => call.mutation.kind)).toEqual(['add-favorite']);
    expect(h.controller.get().view).toMatchObject({
      preferences: {
        favorites: [
          { ...b, inCatalog: true },
          { ...a, inCatalog: true },
        ],
      },
    });
    h.saves[0]!.resolve(profile(1, [a, b]));
    await flush();
    h.saves[1]!.resolve(profile(2, [b]));
    await flush();
    h.saves[2]!.resolve(profile(3, [b, a]));
    await flush();
    expect(h.saves.map((call) => call.mutation.kind)).toEqual([
      'add-favorite',
      'remove-favorite',
      'add-favorite',
    ]);
    expect(h.controller.get().confirmed).toEqual(profile(3, [b, a]));
  });

  it('reverts a failed save, rereads, discards queued work and preserves the error', async () => {
    const h = await loaded();
    h.controller.toggleFavorite(b, true);
    h.controller.selectProject(b);
    h.saves[0]!.reject(new Error('Save failed'));
    await flush();
    expect(h.controller.get().view).toEqual({ status: 'available', preferences: profile() });
    expect(h.controller.get()).toMatchObject({ rereadRequired: true, error: 'Save failed' });
    expect(h.controller.get().notice).toContain('not remembered');
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.resolve(profile());
    await flush();
    expect(h.saves).toHaveLength(1);
    expect(h.controller.get().error).toBe('Save failed');
  });

  it('reconciles a lost response from a committed mutation without replaying it', async () => {
    const h = await loaded();
    h.controller.toggleFavorite(b, true);
    h.saves[0]!.reject(new Error('Connection lost'));
    await flush();
    h.reads[1]!.resolve(profile(1, [a, b]));
    await flush();
    expect(h.controller.get().confirmed).toEqual(profile(1, [a, b]));
    expect(h.controller.get().error).toBe('Connection lost');
    expect(h.saves).toHaveLength(1);
  });

  it('defers only the latest initial explicit selection until the read settles', async () => {
    const h = setup();
    h.controller.load('open');
    h.controller.selectProject(a);
    h.controller.selectProject(b);
    expect(h.saves).toHaveLength(0);
    h.reads[0]!.resolve(profile());
    await flush();
    expect(h.saves.map((call) => call.mutation)).toEqual([
      { kind: 'remember-project', project: b },
    ]);
  });

  it('cancels a deferred explicit project when navigating to a non-project destination', async () => {
    const h = setup();
    h.controller.load('open');
    h.controller.selectProject(a);
    h.controller.selectProject(null);
    h.reads[0]!.resolve(profile());
    await flush();
    expect(h.saves).toHaveLength(0);
  });

  it('shows failed-remember feedback without changing routing or retrying the selection', async () => {
    const h = await loaded();
    h.controller.selectProject(b);
    h.saves[0]!.reject(new Error('Cannot remember'));
    await flush();
    expect(h.controller.get()).toMatchObject({ error: null, notice: 'Cannot remember' });
    h.reads[1]!.resolve(profile());
    await flush();
    expect(h.saves).toHaveLength(1);
  });

  it('reports a failed initial read and refused selection without replay on recovery', async () => {
    const h = setup();
    h.controller.load('open');
    h.controller.selectProject(a);
    h.reads[0]!.reject(new Error('Read failed'));
    await flush();
    expect(h.controller.startup()).toEqual({
      available: false,
      reason: 'read-failed',
      message: 'Read failed',
    });
    expect(h.controller.get().notice).toContain('not remembered');
    h.controller.load('tab-return');
    h.reads[1]!.resolve(profile());
    await flush();
    expect(h.saves).toHaveLength(0);
  });

  it.each(['login-disabled', 'storage-not-configured', 'unreadable'] as const)(
    'keeps %s unavailable and never sends stars',
    async (reason) => {
      const h = setup();
      h.controller.load('open');
      const response = { available: false as const, reason, message: reason };
      h.reads[0]!.resolve(response);
      await flush();
      expect(h.controller.startup()).toEqual(response);
      h.controller.toggleFavorite(a, true);
      expect(h.saves).toHaveLength(0);
    },
  );

  it.each(['logout', 'expiry'] as const)(
    'clears synchronously on %s, aborts work and refuses retries until a new page session',
    async (kind) => {
      const h = await loaded();
      h.controller.toggleFavorite(b, true);
      h.controller.selectProject(b);
      h.controller.load('tab-return');
      if (kind === 'logout') h.controller.endSession();
      else h.expired();
      expect(h.controller.get()).toMatchObject({
        view: { status: 'not-loaded' },
        confirmed: null,
        active: null,
        queue: [],
        error: null,
        notice: null,
      });
      expect(h.saves[0]!.signal.aborted).toBe(true);
      expect(h.reads[1]!.signal.aborted).toBe(true);
      h.saves[0]!.resolve(profile(10, [a, b]));
      h.reads[1]!.resolve(profile(11, [b]));
      await flush();
      h.controller.load('reload');
      h.controller.selectProject(a);
      h.controller.toggleFavorite(a, true);
      expect(h.controller.startup()).toBeNull();
      expect(h.reads).toHaveLength(2);
      expect(h.saves).toHaveLength(1);
    },
  );

  it('removes the global session listener when disposed', () => {
    const h = setup();
    h.controller.dispose();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
