import type { ScopeFreshness, RefreshJobStatus, ScopeResponse } from '../../src/core/scope.js';
import { scopeId, routeScopeId, nextScopeRequestAt, type Action } from './state.js';
import { describe, expect, it } from 'vitest';
import type { PlanNode, Snapshot } from '../../src/core/types.js';
import type { ViewSummary } from './api.js';
import { DEFAULT_ROUTE, parseHash, serializeHash, type Tab } from './route.js';
import {
  INITIAL_STATE,
  Store,
  effectiveViewId,
  indexSnapshot,
  problemCount,
  reducer,
  warningsByCode,
  withTab,
  type AppState,
} from './state.js';

const views: ViewSummary[] = [
  { id: 'a', title: 'A', source: 's', kind: 'fixture', repos: ['o/r'] },
  { id: 'b', title: 'B', source: 's', kind: 'fixture', repos: ['o/r', 'o/q'] },
];

function node(key: string, extra: Partial<PlanNode> = {}): PlanNode {
  const [ownerRepo = '', num = '0'] = key.split('#');
  const [owner = '', repo = ''] = ownerRepo.split('/');
  return {
    key,
    repo: { owner, repo },
    number: Number(num),
    title: key,
    url: `https://x/${key}`,
    labels: [],
    assignees: [],
    milestone: null,
    external: false,
    status: 'ready',
    wave: 0,
    order: 0,
    blockedBy: [],
    blocks: [],
    priority: 0,
    remainingDepth: 1,
    ...extra,
  };
}

function snapshot(keys: string[]): Snapshot {
  return {
    viewId: 'a',
    title: 'A',
    fetchedAt: '2026-01-01T00:00:00Z',
    contentHash: 'h'.repeat(64),
    priorityLabels: [],
    orderingMode: 'priority',
    plan: {
      viewId: 'a',
      nodes: keys.map((k) => node(k)),
      edges: [{ from: keys[0]!, to: keys[1] ?? keys[0]!, sources: ['body'] }],
      order: keys,
      waves: [keys],
      cycles: [],
      unschedulable: [],
      criticalPath: keys,
      warnings: [
        { code: 'dangling-reference', message: 'm1', issues: [keys[0]!] },
        { code: 'dangling-reference', message: 'm2', issues: [] },
        { code: 'fetch-error', message: 'm3', issues: [] },
      ],
      stats: {
        total: keys.length,
        ready: 1,
        blocked: 0,
        unschedulable: 0,
        external: 0,
        edges: 1,
        waves: 1,
      },
    },
    layout: { width: 10, height: 10, nodes: [], edges: [] },
  };
}

describe('effectiveViewId', () => {
  it('uses the routed view when it exists, else the first', () => {
    const base = { views, route: DEFAULT_ROUTE };
    expect(effectiveViewId(base)).toBe('a');
    expect(effectiveViewId({ ...base, route: { ...DEFAULT_ROUTE, viewId: 'b' } })).toBe('b');
    expect(effectiveViewId({ ...base, route: { ...DEFAULT_ROUTE, viewId: 'zzz' } })).toBe('a');
    expect(effectiveViewId({ views: null, route: DEFAULT_ROUTE })).toBeNull();
    expect(effectiveViewId({ views: [], route: DEFAULT_ROUTE })).toBeNull();
  });
});

describe('reducer', () => {
  const loaded = (): AppState =>
    reducer(reducer({ ...INITIAL_STATE, views }, { type: 'load-start', viewId: 'a' }), {
      type: 'load-done',
      viewId: 'a',
      snapshot: snapshot(['o/r#1', 'o/r#2']),
    });

  it('tracks the load lifecycle', () => {
    const loading = reducer({ ...INITIAL_STATE, views }, { type: 'load-start', viewId: 'a' });
    expect(loading.status).toBe('loading');
    const s = loaded();
    expect(s.status).toBe('ready');
    expect(s.snapshot?.plan.nodes).toHaveLength(2);
    const failed = reducer(loading, { type: 'load-failed', viewId: 'a', error: 'boom' });
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('boom');
  });

  it('ignores results for a view that is no longer loaded', () => {
    const loading = reducer({ ...INITIAL_STATE, views }, { type: 'load-start', viewId: 'b' });
    expect(
      reducer(loading, { type: 'load-done', viewId: 'a', snapshot: snapshot(['o/r#1']) }),
    ).toBe(loading);
    expect(reducer(loading, { type: 'load-failed', viewId: 'a', error: 'x' })).toBe(loading);
  });

  it('keeps the selection across a refresh only while the node exists', () => {
    const selected = reducer(loaded(), { type: 'select', key: 'o/r#2' });
    const kept = reducer(selected, {
      type: 'refresh-done',
      viewId: 'a',
      snapshot: snapshot(['o/r#1', 'o/r#2', 'o/r#3']),
    });
    expect(kept.selected).toBe('o/r#2');
    const dropped = reducer(selected, {
      type: 'refresh-done',
      viewId: 'a',
      snapshot: snapshot(['o/r#1']),
    });
    expect(dropped.selected).toBeNull();
  });

  it('clears the selection when another view is loaded', () => {
    const selected = reducer(loaded(), { type: 'select', key: 'o/r#2' });
    const other = reducer(selected, { type: 'load-start', viewId: 'b' });
    expect(other.selected).toBeNull();
    expect(other.snapshot).toBeNull();
  });

  it('shows a revisited view from its last snapshot, without loading', () => {
    const latest = snapshot(['o/r#1', 'o/r#2', 'o/r#3']);
    const refreshed = reducer(loaded(), { type: 'refresh-done', viewId: 'a', snapshot: latest });
    const other = reducer(refreshed, { type: 'load-start', viewId: 'b' });
    expect(other.status).toBe('loading');
    const back = reducer(other, { type: 'load-start', viewId: 'a' });
    expect(back.status).toBe('ready');
    expect(back.snapshot).toBe(latest);
  });

  it('shows and dismisses refresh errors without dropping the snapshot', () => {
    let s = reducer(loaded(), { type: 'refresh-start', viewId: 'a' });
    expect(s.refreshing).toBe(true);
    s = reducer(s, { type: 'refresh-failed', viewId: 'a', error: 'bad gateway' });
    expect(s.refreshing).toBe(false);
    expect(s.refreshError).toBe('bad gateway');
    expect(s.snapshot).not.toBeNull();
    s = reducer(s, { type: 'dismiss-refresh-error' });
    expect(s.refreshError).toBeNull();
  });
});

describe('Store', () => {
  it('notifies subscribers only on change', () => {
    const store = new Store();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch({ type: 'select', key: 'o/r#1' });
    store.dispatch({ type: 'select', key: 'o/r#1' });
    expect(calls).toBe(1);
    off();
    store.dispatch({ type: 'select', key: null });
    expect(calls).toBe(1);
    expect(store.get().selected).toBeNull();
  });
});

describe('select reveals a hidden issue', () => {
  const loaded = (q: string, tab: Tab = 'graph'): Store => {
    const store = new Store({ ...INITIAL_STATE, views, route: { ...DEFAULT_ROUTE, tab, q } });
    store.dispatch({ type: 'load-start', viewId: 'a' });
    store.dispatch({ type: 'load-done', viewId: 'a', snapshot: snapshot(['o/r#1', 'o/q#1']) });
    return store;
  };

  it('narrows the filter to the repository of a hidden issue', () => {
    const store = loaded('repo:o/r');
    store.dispatch({ type: 'select', key: 'o/q#1' });
    expect(store.get().route.q).toBe('repo:o/q');
    expect(store.get().selected).toBe('o/q#1');
  });

  it('keeps the filter for an issue it already shows', () => {
    const store = loaded('repo:o/r');
    const route = store.get().route;
    store.dispatch({ type: 'select', key: 'o/r#1' });
    expect(store.get().route).toBe(route);
    expect(store.get().selected).toBe('o/r#1');
  });

  it('stays on the current tab', () => {
    const store = loaded('repo:o/r', 'problems');
    store.dispatch({ type: 'select', key: 'o/q#1' });
    expect(store.get().route.tab).toBe('problems');
  });
});

describe('snapshot helpers', () => {
  it('indexes nodes, detects multi-repo views and critical edges', () => {
    const snap = snapshot(['o/r#1', 'o/r#2']);
    const single = indexSnapshot(snap, ['o/r']);
    expect(single.multiRepo).toBe(false);
    expect(single.nodes.get('o/r#2')?.number).toBe(2);
    expect(single.criticalEdges.has('o/r#1->o/r#2')).toBe(true);
    expect(indexSnapshot(snap, ['o/r', 'o/q']).multiRepo).toBe(true);
    expect(indexSnapshot(snapshot(['o/r#1', 'o/q#1']), []).multiRepo).toBe(true);
  });

  it('counts problems and groups warnings by code in order', () => {
    const snap = snapshot(['o/r#1']);
    expect(problemCount(snap)).toBe(3);
    const groups = warningsByCode(snap.plan.warnings);
    expect([...groups.keys()]).toEqual(['dangling-reference', 'fetch-error']);
    expect(groups.get('dangling-reference')).toHaveLength(2);
  });
});

describe('scope route compatibility', () => {
  it.each(['#/project/forge/acme/api', '#/source/forge'])(
    'keeps the scope when changing tabs on %s',
    (path) => {
      const route = parseHash(`${path}/graph?q=bug&sort=updated`);
      expect(serializeHash(withTab(route, 'problems'))).toBe(`${path}/problems?q=bug&sort=updated`);
      expect(route.viewId).toBeNull();
    },
  );
});

describe('project/source scope state', () => {
  const project = { kind: 'project', source: 's', repo: 'o/r' } as const;
  const freshness: ScopeFreshness = {
    computedAt: null,
    repositories: [],
    outsideIssues: { count: 0, oldestObservedAt: null, provisionalCount: 0 },
  };
  const job: RefreshJobStatus = {
    id: 'job',
    scope: project,
    trigger: 'interactive',
    state: 'running',
    queuedAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    delayedUntil: null,
    error: null,
  };
  const route = parseHash('#/project/s/o/r/graph');
  function scoped(): AppState {
    return reducer(INITIAL_STATE, { type: 'route', route });
  }
  function response(overrides: Partial<ScopeResponse> = {}): ScopeResponse {
    return { scope: project, snapshot: snapshot(['o/r#1']), freshness, job: null, ...overrides };
  }

  it('keys scope by canonical shared ID, not a named view', () => {
    const state = scoped();
    expect(state.loadedScopeId).toBe('project:s/o/r');
    expect(routeScopeId(parseHash('#/project/s/O/R'))).toBe('project:s/o/r');
    expect(scopeId({ kind: 'source', source: 'S' })).toBe('source:S');
    expect(effectiveViewId({ ...state, views })).toBeNull();
  });

  it.each(['#/project/s/o/other', '#/source/s', '#/source/other', '#/view/a'])(
    'switches to %s without stale selection/filter or snapshot',
    (hash) => {
      const state: AppState = {
        ...scoped(),
        route: { ...route, q: 'bug', tab: 'order', sort: 'title' },
        selected: 'o/r#1',
        snapshot: snapshot(['o/r#1']),
      };
      const next = reducer(state, { type: 'route', route: parseHash(hash) });
      expect(next.route).toMatchObject({ q: '', tab: 'order', sort: 'title' });
      expect(next.selected).toBeNull();
      expect(next.snapshot).toBeNull();
      const back = reducer(next, { type: 'route', route });
      expect(back.route.q).toBe('');
      expect(back.selected).toBeNull();
    },
  );

  it('enters projects from All projects and from named views, preserving tab and sort', () => {
    for (const hash of ['#/source/s', '#/view/a']) {
      const before = {
        ...INITIAL_STATE,
        route: { ...parseHash(hash), q: 'old', tab: 'problems' as const, sort: 'title' as const },
        selected: 'o/r#1',
      };
      const after = reducer(before, { type: 'route', route });
      expect(after.route).toMatchObject({ q: '', tab: 'problems', sort: 'title' });
      expect(after.selected).toBeNull();
    }
  });

  it('reselecting current route is a no-op and tab/filter updates keep selection', () => {
    const state = { ...scoped(), selected: 'o/r#1' };
    expect(reducer(state, { type: 'route', route: { ...state.route } })).toBe(state);
    expect(
      reducer(state, { type: 'route', route: { ...state.route, tab: 'order', q: 'bug' } }).selected,
    ).toBe('o/r#1');
  });

  it('shows snapshots immediately with freshness, including active refresh', () => {
    const result = reducer(scoped(), { type: 'scope-response', response: response({ job }) });
    expect(result.status).toBe('ready');
    expect(result.freshness).toBe(freshness);
    expect(result.job).toBe(job);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshots).toEqual({});
  });

  it.each(['queued', 'running'] as const)('missing snapshot with %s job stays loading', (state) => {
    const result = reducer(scoped(), {
      type: 'scope-response',
      response: response({ snapshot: null, job: { ...job, state } }),
    });
    expect(result.status).toBe('loading');
    expect(result.snapshot).toBeNull();
    expect(result.error).toBeNull();
  });

  it.each(['completed', 'partial', 'failed'] as const)(
    'missing snapshot with %s job is unavailable, not an empty plan',
    (state) => {
      const result = reducer(scoped(), {
        type: 'scope-response',
        response: response({ snapshot: null, job: { ...job, state, error: 'failed upstream' } }),
      });
      expect(result.status).toBe('unavailable');
      expect(result.snapshot).toBeNull();
      expect(result.error).toBe('failed upstream');
    },
  );

  it('missing snapshot and job is unavailable with repository explanation', () => {
    const f: ScopeFreshness = {
      ...freshness,
      repositories: [
        {
          project: { source: 's', repo: 'o/r' },
          lastCheckedAt: null,
          state: 'unavailable',
          partial: false,
          error: 'no access',
          delayedUntil: null,
        },
      ],
    };
    const result = reducer(scoped(), {
      type: 'scope-response',
      response: response({ snapshot: null, freshness: f }),
    });
    expect(result.status).toBe('unavailable');
    expect(result.error).toBe('no access');
  });

  it.each([
    [404, 'not-in-catalog'],
    [409, 'conflict'],
    [500, 'unavailable'],
  ] as const)('keeps %i explanation in distinct state', (status, expected) => {
    const result = reducer(scoped(), {
      type: 'scope-failed',
      scope: project,
      status,
      error: 'explanation',
    });
    expect(result.status).toBe(expected);
    expect(result.error).toBe('explanation');
    expect(result.snapshot).toBeNull();
  });

  it('ignores old scope results, starts, and errors immediately after navigation', () => {
    const state = reducer(scoped(), { type: 'route', route: parseHash('#/source/s') });
    expect(reducer(state, { type: 'scope-response', response: response() })).toBe(state);
    expect(
      reducer(state, { type: 'scope-failed', scope: project, status: 404, error: 'old' }),
    ).toBe(state);
    expect(reducer(state, { type: 'scope-load-start', scope: project })).toBe(state);
    const ready = reducer(state, {
      type: 'scope-response',
      response: response({ scope: { kind: 'source', source: 's' } }),
    });
    expect(ready.loadedScopeId).toBe('source:s');
    expect(ready.status).toBe('ready');
  });

  it('ignores named-view callbacks while a scope is current', () => {
    const state = reducer({ ...INITIAL_STATE, loadedViewId: 'a' }, { type: 'route', route });
    for (const action of [
      { type: 'load-start', viewId: 'a' },
      { type: 'load-done', viewId: 'a', snapshot: snapshot([]) },
      { type: 'refresh-start', viewId: 'a' },
      { type: 'refresh-done', viewId: 'a', snapshot: snapshot([]) },
      { type: 'refresh-failed', viewId: 'a', error: 'late' },
      { type: 'load-failed', viewId: 'a', error: 'late' },
    ] satisfies Action[])
      expect(reducer(state, action)).toBe(state);
    const legacy = reducer(state, { type: 'route', route: parseHash('#/view/a') });
    expect(reducer(legacy, { type: 'scope-response', response: response() })).toBe(legacy);
    expect(reducer(legacy, { type: 'load-start', viewId: 'a' }).loadedViewId).toBe('a');
  });

  it('plans follow-ups only while visible, and one freshness check after returning', () => {
    const input = { job, respondedAt: 1000, visible: true, visibleSince: null };
    expect(nextScopeRequestAt(input)).toBe(3000);
    expect(nextScopeRequestAt({ ...input, visible: false })).toBeNull();
    expect(nextScopeRequestAt({ ...input, job: null })).toBeNull();
    expect(nextScopeRequestAt({ ...input, job: { ...job, state: 'completed' } })).toBeNull();
    expect(nextScopeRequestAt({ ...input, job: null, visibleSince: 5000 })).toBe(5000);
    expect(
      nextScopeRequestAt({ ...input, job: null, visibleSince: 5000, respondedAt: 5000 }),
    ).toBeNull();
    expect(nextScopeRequestAt({ ...input, visibleSince: 5000, respondedAt: 5001 })).toBe(7001);
    expect(nextScopeRequestAt({ ...input, visibleSince: 5000, respondedAt: null })).toBe(5000);
  });
});
