import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scope, ScopeResponse, SweepStatus } from '../../src/core/scope.js';
import type { Snapshot } from '../../src/core/types.js';
import { DEFAULT_ROUTE } from './route.js';
import { createScopeNavigation, routeForScope } from './scope-navigation.js';
import { INITIAL_STATE, Store } from './state.js';
import { createSweepRefresh } from './sweep-refresh.js';

const project: Scope = { kind: 'project', source: 'one', repo: 'owner/repo' };
const source: Scope = { kind: 'source', source: 'one' };
const running: SweepStatus = {
  id: 'sweep',
  trigger: 'interactive',
  state: 'running',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: null,
  sources: [],
};
const complete: SweepStatus = {
  ...running,
  state: 'completed',
  finishedAt: '2026-01-01T00:00:02Z',
};
function response(scope: Scope, fetchedAt: string): ScopeResponse {
  return {
    scope,
    snapshot: { viewId: 'fixture', fetchedAt, plan: { nodes: [] } } as unknown as Snapshot,
    freshness: {
      computedAt: null,
      repositories: [],
      outsideIssues: { count: 0, oldestObservedAt: null, provisionalCount: 0 },
    },
    job: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  vi.useFakeTimers();
  const old = deferred<ScopeResponse>();
  const read = vi.fn(async (scope: Scope) => response(scope, 'fresh'));
  read.mockImplementationOnce(() => old.promise);
  const refresh = vi.fn(async (scope: Scope) => response(scope, 'manual'));
  const store = new Store({ ...INITIAL_STATE, route: routeForScope(project, DEFAULT_ROUTE) });
  const navigation = createScopeNavigation(store, read, refresh);
  navigation.setRefreshMinutes(0);
  const sweep = createSweepRefresh(
    () => {},
    () => navigation.recheck(),
    async () => running,
    async () => complete,
  );
  navigation.open(project);
  const open = (scope: Scope | null) => {
    store.dispatch({
      type: 'route',
      route: scope ? routeForScope(scope, DEFAULT_ROUTE) : DEFAULT_ROUTE,
    });
    navigation.open(scope);
  };
  return { old, read, refresh, store, navigation, sweep, open };
}
afterEach(() => vi.useRealTimers());

describe('sweep completion and the visible scope lane', () => {
  it('rechecks after a delayed pre-sweep read, even with periodic checks disabled', async () => {
    const { old, read, store, sweep } = setup();
    await sweep.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    old.resolve(response(project, 'old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.get().snapshot?.fetchedAt).toBe('fresh');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('performs the completion recheck even if the earlier read fails', async () => {
    const { old, read, store, sweep } = setup();
    await sweep.refresh();
    old.reject(new Error('old request failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.get().snapshot?.fetchedAt).toBe('fresh');
    expect(store.get().error).toBeNull();
  });
  it('coalesces multiple completions behind one pending scope request', async () => {
    const { old, read, sweep } = setup();
    await sweep.refresh();
    await sweep.refresh();
    await sweep.refresh();
    old.resolve(response(project, 'old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not drain the queued check while hidden and checks once on return', async () => {
    const { old, read, store, navigation, sweep } = setup();
    await sweep.refresh();
    navigation.setVisible(false);
    sweep.setVisible(false);
    old.resolve(response(project, 'old'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    navigation.setVisible(true);
    sweep.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.get().snapshot?.fetchedAt).toBe('fresh');
  });
  it('retains a completion received while hidden if tab return still joins the old read', async () => {
    const { old, read, store, navigation, sweep } = setup();
    navigation.setVisible(false);
    await sweep.refresh();
    navigation.setVisible(true);
    expect(read).toHaveBeenCalledTimes(1);
    old.resolve(response(project, 'old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.get().snapshot?.fetchedAt).toBe('fresh');
  });
  it('discards the old queued check on A → B → A navigation', async () => {
    const { old, read, store, sweep, open } = setup();
    await sweep.refresh();
    open(source);
    await vi.advanceTimersByTimeAsync(0);
    open(project);
    await vi.advanceTimersByTimeAsync(0);
    old.resolve(response(project, 'old'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(store.get().snapshot?.fetchedAt).toBe('fresh');
  });
  it('never follows the old scope after leaving scope browsing', async () => {
    const { old, read, sweep, open } = setup();
    await sweep.refresh();
    open(null);
    old.resolve(response(project, 'old'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('keeps sweep rechecks on the open project during a source refresh', async () => {
    const { old, read, refresh, store, navigation, sweep } = setup();
    old.resolve(response(project, 'old'));
    await vi.advanceTimersByTimeAsync(0);
    const manual = deferred<ScopeResponse>();
    refresh.mockImplementationOnce(() => manual.promise);
    const pending = navigation.refresh(source);
    await sweep.refresh();
    manual.resolve(response(source, 'manual'));
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls).toEqual([[project], [project], [project]]);
    expect(store.get().snapshot?.fetchedAt).toBe('fresh');
  });
  it.each(['queued', 'in-flight'])(
    'retains a %s sweep recheck when an explicit refresh is rejected',
    async (stage) => {
      const { old, read, refresh, store, navigation, sweep } = setup();
      old.resolve(response(project, 'last-good'));
      await vi.advanceTimersByTimeAsync(0);
      const delayed = deferred<ScopeResponse>();
      read.mockImplementationOnce(() => delayed.promise);
      if (stage === 'queued') void navigation.check();
      await sweep.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
      refresh.mockRejectedValueOnce(new Error('rejected'));
      await navigation.refresh(project);
      delayed.resolve(response(project, 'old'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(read).toHaveBeenCalledTimes(3);
      expect(store.get().snapshot?.fetchedAt).toBe('fresh');
    },
  );
  it('shows a failed post-sweep read without retrying indefinitely', async () => {
    const { old, read, store, sweep } = setup();
    old.resolve(response(project, 'last-good'));
    await vi.advanceTimersByTimeAsync(0);
    read.mockRejectedValueOnce(new Error('offline'));
    await sweep.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.get().snapshot?.fetchedAt).toBe('last-good');
    expect(store.get().refreshError).toBe('offline');
  });
});
