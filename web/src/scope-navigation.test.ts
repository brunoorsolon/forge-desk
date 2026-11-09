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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  read = vi.fn(async (scope: Scope) => response(scope)),
  refresh?: (scope: Scope) => Promise<ScopeResponse>,
) {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const store = new Store({ ...INITIAL_STATE, route: routeForScope(project, DEFAULT_ROUTE) });
  return { store, read, navigation: createScopeNavigation(store, read, refresh) };
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

describe('source refresh route preservation', () => {
  const projectSource: Scope = { kind: 'source', source: project.source };

  it('posts the source, then reads the project without changing its route or showing source data', async () => {
    const posted = deferred<ScopeResponse>();
    const reread = deferred<ScopeResponse>();
    const read = vi.fn(async (scope: Scope) => response(scope));
    const refresh = vi.fn(() => posted.promise);
    const { store, navigation } = setup(read, refresh);
    const route = { ...store.get().route, tab: 'order' as const, q: 'label:bug' };
    store.dispatch({ type: 'route', route });
    navigation.open(project);
    await vi.advanceTimersByTimeAsync(0);
    const before = store.get().freshness;
    read.mockImplementationOnce(() => reread.promise);

    const pending = navigation.refresh(projectSource);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(projectSource);
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.get().route).toBe(route);
    posted.resolve(response(projectSource));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls).toEqual([[project], [project]]);
    expect(store.get().route).toBe(route);
    expect(store.get().freshness).toBe(before);
    expect(store.get().refreshingScope).toBe('source');

    const refreshed = response(project, true);
    refreshed.freshness.computedAt = '2026-11-08T20:00:00Z';
    reread.resolve(refreshed);
    await pending;
    expect(store.get().route).toBe(route);
    expect(store.get().freshness).toBe(refreshed.freshness);
    expect(store.get().job?.scope).toEqual(project);
  });

  it('uses the source refresh response directly when All projects is already open', async () => {
    const refreshed = response(source, true);
    const refresh = vi.fn(async () => refreshed);
    const { store, read, navigation } = setup(undefined, refresh);
    const route = routeForScope(source, DEFAULT_ROUTE);
    store.dispatch({ type: 'route', route });
    navigation.open(source);
    await vi.advanceTimersByTimeAsync(0);
    const before = store.get().route;
    await navigation.refresh(source);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(source);
    expect(read.mock.calls).toEqual([[source]]);
    expect(store.get().route).toBe(before);
    expect(store.get().route).toEqual(route);
    expect(store.get().freshness).toBe(refreshed.freshness);
    expect(store.get().job?.scope).toEqual(source);
  });

  it('does not start an obsolete project read after navigating away and back during the POST', async () => {
    const posted = deferred<ScopeResponse>();
    const { store, read, navigation } = setup(undefined, () => posted.promise);
    navigation.open(project);
    await vi.advanceTimersByTimeAsync(0);
    const pending = navigation.refresh(projectSource);
    for (const next of [source, project]) {
      store.dispatch({ type: 'route', route: routeForScope(next, store.get().route) });
      navigation.open(next);
    }
    await vi.advanceTimersByTimeAsync(0);
    const before = store.get().freshness;
    posted.resolve(response(projectSource));
    await pending;
    expect(read.mock.calls).toEqual([[project], [source], [project]]);
    expect(store.get().freshness).toBe(before);
    expect(store.get().refreshingScope).toBeNull();
    expect(scopeFromRoute(store.get().route)).toEqual(project);
  });

  it.each(['success', 'failure'])(
    'ignores an obsolete follow-up project read %s after newer navigation',
    async (outcome) => {
      const reread = deferred<ScopeResponse>();
      const { store, read, navigation } = setup(undefined, async () => response(projectSource));
      navigation.open(project);
      await vi.advanceTimersByTimeAsync(0);
      read.mockImplementationOnce(() => reread.promise);
      const pending = navigation.refresh(projectSource);
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
      store.dispatch({ type: 'route', route: routeForScope(source, store.get().route) });
      navigation.open(source);
      await vi.advanceTimersByTimeAsync(0);
      const before = store.get();
      if (outcome === 'success') reread.resolve(response(project));
      else reread.reject(new ApiError('obsolete project error', 404));
      await pending;
      expect(scopeFromRoute(store.get().route)).toEqual(source);
      expect(store.get()).toBe(before);
    },
  );
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

describe('explicit scope request busy state', () => {
  it.each(['project', 'source'] as const)(
    'tracks a pending %s request through its active job and completion',
    async (kind) => {
      const posted = deferred<ScopeResponse>();
      const target: Scope = kind === 'project' ? project : { kind, source: project.source };
      const active = response(project, true);
      active.job!.scope = target;
      const read = vi.fn(async () => response(project));
      const { store, navigation } = setup(read, () => posted.promise);
      navigation.open(project);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get().refreshingScope).toBeNull();
      if (kind === 'source') read.mockResolvedValueOnce(active);
      const pending = navigation.refresh(target);
      expect(store.get().refreshingScope).toBe(kind);
      posted.resolve(kind === 'project' ? active : response(target, true));
      await pending;
      expect(store.get().refreshingScope).toBeNull();
      expect(store.get().job?.scope).toEqual(target);
      read.mockResolvedValue(response(project));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.get().job).toBeNull();
      expect(store.get().refreshingScope).toBeNull();
    },
  );

  it.each(['project', 'source'] as const)(
    'clears a rejected %s request and permits retry',
    async (kind) => {
      const posted = deferred<ScopeResponse>();
      const target: Scope = kind === 'project' ? project : { kind, source: project.source };
      const refresh = vi.fn(() => posted.promise);
      const { store, navigation } = setup(undefined, refresh);
      navigation.open(project);
      await vi.advanceTimersByTimeAsync(0);
      const pending = navigation.refresh(target);
      expect(store.get().refreshingScope).toBe(kind);
      posted.reject(new Error('offline'));
      await pending;
      expect(store.get().refreshingScope).toBeNull();
      refresh.mockResolvedValueOnce(response(target));
      await navigation.refresh(target);
      expect(store.get().refreshingScope).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it('does not let a superseded refresh clear a newer request after navigation away and back', async () => {
    const old = deferred<ScopeResponse>();
    const current = deferred<ScopeResponse>();
    const refresh = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { store, navigation } = setup(undefined, refresh);
    navigation.open(project);
    await vi.advanceTimersByTimeAsync(0);
    const first = navigation.refresh(project);
    expect(store.get().refreshingScope).toBe('project');
    store.dispatch({ type: 'route', route: routeForScope(source, DEFAULT_ROUTE) });
    navigation.open(source);
    expect(store.get().refreshingScope).toBeNull();
    store.dispatch({ type: 'route', route: routeForScope(project, DEFAULT_ROUTE) });
    navigation.open(project);
    const second = navigation.refresh({ kind: 'source', source: project.source });
    old.resolve(response(project));
    await first;
    expect(store.get().refreshingScope).toBe('source');
    current.resolve(response({ kind: 'source', source: project.source }));
    await second;
    expect(store.get().refreshingScope).toBeNull();
  });
});
