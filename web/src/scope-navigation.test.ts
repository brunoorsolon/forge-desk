import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogResponse, Scope, ScopeResponse } from '../../src/core/scope.js';
import { ApiError } from './api.js';
import { DEFAULT_ROUTE } from './route.js';
import {
  createScopeNavigation,
  routeForScope,
  scopeFromRoute,
  scopePanel,
} from './scope-navigation.js';
import { INITIAL_STATE, Store } from './state.js';

const project: Scope = { kind: 'project', source: 'one', repo: 'owner/repo' };
const source: Scope = { kind: 'source', source: 'two' };
function response(scope = project, active = false): ScopeResponse {
  return {
    scope,
    snapshot: null,
    freshness: {
      computedAt: null,
      repositories: [],
      outsideIssues: { count: 0, oldestObservedAt: null, provisionalCount: 0 },
    },
    job: active
      ? ({ id: 'job', state: 'running', scope, error: null } as ScopeResponse['job'])
      : null,
  };
}
function setup(read = vi.fn(async (scope: Scope) => response(scope))) {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const store = new Store({ ...INITIAL_STATE, route: routeForScope(project, DEFAULT_ROUTE) });
  return { store, read, navigation: createScopeNavigation(store, read) };
}
afterEach(() => vi.useRealTimers());

describe('visible scope requests', () => {
  it('reads only the selected scope, ignores repeat selections and has no timer at zero', async () => {
    const { read, navigation } = setup();
    navigation.open(project);
    await vi.advanceTimersByTimeAsync(0);
    navigation.open({ ...project });
    navigation.setRefreshMinutes(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read.mock.calls).toEqual([[project]]);
  });
  it.each(['queued', 'running'] as const)(
    'follows %s jobs every 60 seconds and stops after completion',
    async (state) => {
      const read = vi.fn(async (scope: Scope) => {
        const result = response(scope, read.mock.calls.length < 3);
        if (result.job) result.job.state = state;
        return result;
      });
      const { navigation } = setup(read);
      navigation.open(project);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(read).toHaveBeenCalledTimes(3);
    },
  );
  it('pauses job and periodic checks while hidden and reads once on return', async () => {
    const { navigation, read } = setup(vi.fn(async (scope: Scope) => response(scope, true)));
    navigation.setRefreshMinutes(1);
    navigation.setVisible(false);
    navigation.open(project);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).not.toHaveBeenCalled();
    navigation.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    navigation.setVisible(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    navigation.setVisible(true);
    navigation.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('rechecks the open scope periodically without polling other projects', async () => {
    const { navigation, store, read } = setup();
    navigation.setRefreshMinutes(1);
    navigation.open(project);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    store.dispatch({ type: 'route', route: routeForScope(source, store.get().route) });
    navigation.open(source);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read.mock.calls).toEqual([[project], [project], [source], [source]]);
    navigation.open(null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('coalesces checks while a request is pending', async () => {
    let finish!: (result: ScopeResponse) => void;
    const read = vi.fn(
      () =>
        new Promise<ScopeResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const { navigation } = setup(read);
    navigation.setRefreshMinutes(0.01);
    navigation.open(project);
    await navigation.check();
    navigation.setVisible(false);
    navigation.setVisible(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    finish(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('discards old A results after A → B → A, including stale failures', async () => {
    const calls: { resolve: (result: ScopeResponse) => void; reject: (error: Error) => void }[] =
      [];
    const read = vi.fn(
      () => new Promise<ScopeResponse>((resolve, reject) => calls.push({ resolve, reject })),
    );
    const { navigation, store } = setup(read);
    navigation.open(project);
    store.dispatch({ type: 'route', route: routeForScope(source, store.get().route) });
    navigation.open(source);
    store.dispatch({ type: 'route', route: routeForScope(project, store.get().route) });
    navigation.open(project);
    calls[2]!.resolve(response(project, true));
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!.reject(new ApiError('Old error', 404));
    calls[1]!.resolve(response(source));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().status).toBe('loading');
    expect(store.get().job?.state).toBe('running');
    expect(store.get().error).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('reports API failures and can recover with a visible-tab check', async () => {
    const read = vi
      .fn<(scope: Scope) => Promise<ScopeResponse>>()
      .mockRejectedValueOnce(new ApiError('gone', 404))
      .mockResolvedValue(response(project, true));
    const { navigation, store } = setup(read);
    navigation.open(project);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ status: 'not-in-catalog', error: 'gone' });
    navigation.setVisible(false);
    navigation.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().status).toBe('loading');
  });
});

describe('scope routing and panels', () => {
  it('builds source/project routes, clears query and keeps tab/sort', () => {
    const route = {
      ...DEFAULT_ROUTE,
      viewId: 'legacy',
      tab: 'order' as const,
      sort: 'updated' as const,
      q: 'old',
    };
    expect(routeForScope(project, route)).toMatchObject({
      viewId: null,
      tab: 'order',
      sort: 'updated',
      q: '',
      scope: { kind: 'project', source: 'one', owner: 'owner', repo: 'repo' },
    });
    expect(scopeFromRoute(routeForScope(project, route))).toEqual(project);
    expect(scopeFromRoute(routeForScope(source, route))).toEqual(source);
    expect(scopeFromRoute(DEFAULT_ROUTE)).toBeNull();
  });
  it('keeps missing scope, policy conflict, delayed and unavailable outcomes distinct', () => {
    const state = { ...INITIAL_STATE, route: routeForScope(project, DEFAULT_ROUTE) };
    expect(scopePanel(state, null)).toEqual({ kind: 'loading' });
    expect(scopePanel({ ...state, status: 'not-in-catalog' }, null)).toEqual({
      kind: 'not-in-catalog',
      source: 'one',
      repo: 'owner/repo',
    });
    const conflict = {
      source: 'one',
      explanation: 'Views disagree',
      differingSettings: ['externalMode'],
      views: ['a', 'b'],
    };
    const catalog = {
      sources: [
        { id: 'one', kind: 'fixture', projects: [], policy: { status: 'conflict', conflict } },
      ],
    } as CatalogResponse;
    expect(scopePanel({ ...state, status: 'conflict' }, catalog)).toEqual({
      kind: 'policy-conflict',
      conflict,
    });
    expect(scopePanel({ ...state, status: 'unavailable', error: 'Offline' }, null)).toEqual({
      kind: 'unavailable',
      message: 'Offline',
    });
    const freshness = response().freshness;
    freshness.repositories = [
      {
        project: { source: 'one', repo: 'owner/repo' },
        state: 'delayed',
        lastCheckedAt: null,
        partial: false,
        error: null,
        delayedUntil: '2026-11-08T00:00:00Z',
      },
    ];
    expect(scopePanel({ ...state, freshness }, null)).toMatchObject({
      kind: 'delayed',
      expectedEnd: '2026-11-08T00:00:00Z',
    });
  });
});
