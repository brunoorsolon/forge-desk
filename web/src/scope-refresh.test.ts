import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scope, ScopeResponse } from '../../src/core/scope.js';
import type { Snapshot } from '../../src/core/types.js';
import { ApiError } from './api.js';
import { DEFAULT_ROUTE } from './route.js';
import { createScopeNavigation, routeForScope, scopeFromRoute } from './scope-navigation.js';
import { INITIAL_STATE, Store } from './state.js';

const project: Scope = { kind: 'project', source: 'one', repo: 'owner/repo' };
const source: Scope = { kind: 'source', source: 'one' };
function response(scope = project, active = false): ScopeResponse {
  return {
    scope,
    snapshot: { viewId: 'fixture', plan: { nodes: [] } } as unknown as Snapshot,
    freshness: {
      computedAt: null,
      repositories: [],
      outsideIssues: { count: 0, oldestObservedAt: null, provisionalCount: 0 },
    },
    job: active
      ? {
          id: 'joined',
          scope,
          trigger: 'interactive',
          state: 'running',
          queuedAt: '',
          startedAt: '',
          finishedAt: null,
          delayedUntil: null,
          error: null,
        }
      : null,
  };
}
function setup(
  refresh: (scope: Scope) => Promise<ScopeResponse>,
  read = vi.fn(async (scope: Scope) => response(scope)),
) {
  vi.useFakeTimers();
  const store = new Store({ ...INITIAL_STATE, route: routeForScope(project, DEFAULT_ROUTE) });
  const navigation = createScopeNavigation(store, read, refresh);
  navigation.open(project);
  return { store, navigation, read };
}
afterEach(() => vi.useRealTimers());

describe('scope refresh wiring', () => {
  it('applies a manual response immediately while an active job is awaiting its next poll', async () => {
    let finish!: (result: ScopeResponse) => void;
    const refresh = vi.fn(
      () =>
        new Promise<ScopeResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const read = vi.fn(async (scope: Scope) => response(scope, true));
    const { store, navigation } = setup(refresh, read);
    await vi.advanceTimersByTimeAsync(0);
    const previous = store.get().snapshot;
    const pending = navigation.refresh(project);
    expect(store.get().snapshot).toBe(previous);
    const refreshed = response(project);
    finish(refreshed);
    await pending;
    expect(store.get().snapshot).toBe(refreshed.snapshot);
    expect(store.get().freshness).toBe(refreshed.freshness);
    expect(store.get().job).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('shows the refresh result and follows its active job every 60 seconds', async () => {
    const refresh = vi.fn(async (scope: Scope) => response(scope, true));
    const { store, navigation, read } = setup(refresh);
    await vi.advanceTimersByTimeAsync(0);
    await navigation.refresh(project);
    expect(refresh).toHaveBeenCalledWith(project);
    expect(store.get().job?.id).toBe('joined');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.get().job).toBeNull();
  });
  it('keeps the project and follows its covering source job until it settles, with periodic checks disabled', async () => {
    let finish!: (r: ScopeResponse) => void;
    const { store, navigation, read } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    navigation.setRefreshMinutes(0);
    const before = store.get().snapshot;
    const updating = { ...response(project), job: response(source, true).job };
    read.mockResolvedValueOnce(updating).mockResolvedValueOnce(updating);
    const pending = navigation.refresh(source);
    expect(store.get().snapshot).toBe(before);
    expect(scopeFromRoute(store.get().route)).toEqual(project);
    finish(response(source, true));
    await pending;
    expect(scopeFromRoute(store.get().route)).toEqual(project);
    expect(store.get().job?.scope).toEqual(source);
    expect(read.mock.calls).toEqual([[project], [project]]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(store.get().job?.scope).toEqual(source);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(store.get().job).toBeNull();
    expect(scopeFromRoute(store.get().route)).toEqual(project);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it.each([0, 403, 404, 409, 500])(
    'retains the visible data and route on rejected launches (%i)',
    async (status) => {
      const { store, navigation } = setup(async () => {
        throw new ApiError('refresh rejected', status);
      });
      await vi.advanceTimersByTimeAsync(0);
      const before = store.get().snapshot;
      await navigation.refresh(source);
      expect(store.get()).toMatchObject({
        status: 'ready',
        snapshot: before,
        refreshError: 'refresh rejected',
      });
      expect(scopeFromRoute(store.get().route)).toEqual(project);
    },
  );
  it('does not allow an older passive response to overwrite a manual refresh', async () => {
    let old!: (r: ScopeResponse) => void;
    const read = vi.fn(
      () =>
        new Promise<ScopeResponse>((resolve) => {
          old = resolve;
        }),
    );
    const { store, navigation } = setup(async () => response(project, true), read);
    await navigation.refresh(project);
    old(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().job?.id).toBe('joined');
  });
  it('retains the project data and route when the follow-up read fails', async () => {
    const { store, navigation, read } = setup(async () => response(source));
    await vi.advanceTimersByTimeAsync(0);
    const before = store.get().snapshot;
    read.mockRejectedValueOnce(new ApiError('project read failed', 404));
    await navigation.refresh(source);
    expect(store.get()).toMatchObject({
      status: 'ready',
      snapshot: before,
      refreshError: 'project read failed',
    });
    expect(scopeFromRoute(store.get().route)).toEqual(project);
  });
  it('ignores refresh completions and errors after navigating away and back', async () => {
    let reject!: (e: Error) => void;
    const { store, navigation } = setup(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const pending = navigation.refresh(source);
    for (const scope of [source, project]) {
      store.dispatch({ type: 'route', route: routeForScope(scope, store.get().route) });
      navigation.open(scope);
    }
    reject(new Error('obsolete'));
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(scopeFromRoute(store.get().route)).toEqual(project);
    expect(store.get().refreshError).toBeNull();
  });
  it('pauses refreshed job follow-up while hidden and resumes once', async () => {
    const { navigation, read } = setup(async () => response(project, true));
    await vi.advanceTimersByTimeAsync(0);
    await navigation.refresh(project);
    navigation.setVisible(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    navigation.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
