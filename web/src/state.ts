import type {
  Scope,
  ScopeId,
  ScopeResponse,
  ScopeFreshness,
  RefreshJobStatus,
} from '../../src/core/scope.js';
import type {
  DependencySource,
  IssueKey,
  LayoutNode,
  PlanNode,
  PlanWarning,
  Snapshot,
} from '../../src/core/types.js';
import type { ViewSummary } from './api.js';
import { compileFilter, type FilterTarget } from './filter.js';
import { buildAdjacency, criticalPathEdges, edgeId, type Adjacency } from './graph-model.js';
import { priorityName } from './priority.js';
import { DEFAULT_ROUTE, type Route, type Tab } from './route.js';

// ---------------------------------------------------------------------------
// Derived, read-only data for one snapshot
// ---------------------------------------------------------------------------

export interface SnapshotIndex {
  nodes: Map<IssueKey, PlanNode>;
  layout: Map<IssueKey, LayoutNode>;
  adjacency: Adjacency;
  /** Declared source(s) per direct edge, keyed by `edgeId(from, to)`. */
  edgeSources: Map<string, DependencySource[]>;
  /** More than one repository is involved: show `owner/repo#N` instead of `#N`. */
  multiRepo: boolean;
  criticalNodes: Set<IssueKey>;
  criticalEdges: Set<string>;
  unschedulable: Set<IssueKey>;
}

export function indexSnapshot(
  snapshot: Snapshot,
  viewRepos: readonly string[] = [],
): SnapshotIndex {
  const { plan, layout } = snapshot;
  const nodes = new Map(plan.nodes.map((n) => [n.key, n] as const));
  const repos = new Set(plan.nodes.map((n) => `${n.repo.owner}/${n.repo.repo}`));
  return {
    nodes,
    layout: new Map(layout.nodes.map((n) => [n.key, n] as const)),
    adjacency: buildAdjacency(plan.edges),
    edgeSources: new Map(plan.edges.map((e) => [edgeId(e.from, e.to), e.sources])),
    multiRepo: repos.size > 1 || viewRepos.length > 1,
    criticalNodes: new Set(plan.criticalPath),
    criticalEdges: criticalPathEdges(plan.criticalPath),
    unschedulable: new Set(plan.unschedulable),
  };
}

/** Number shown on the Problems tab: every warning of the plan (cycles are warnings too). */
export function problemCount(snapshot: Snapshot): number {
  return snapshot.plan.warnings.length;
}

export function warningsByCode(warnings: readonly PlanWarning[]): Map<string, PlanWarning[]> {
  const map = new Map<string, PlanWarning[]>();
  for (const w of warnings) {
    const list = map.get(w.code);
    if (list) list.push(w);
    else map.set(w.code, [w]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// App state + reducer
// ---------------------------------------------------------------------------

export type LoadStatus =
  'idle' | 'loading' | 'ready' | 'error' | 'unavailable' | 'not-in-catalog' | 'conflict';

export interface AppState {
  views: ViewSummary[] | null;
  viewsError: string | null;
  route: Route;
  status: LoadStatus;
  /** View the snapshot / status / error belong to. */
  loadedViewId: string | null;
  /** Scope loading is never cached as a named view. */
  loadedScopeId: ScopeId | null;
  freshness: ScopeFreshness | null;
  job: RefreshJobStatus | null;
  snapshot: Snapshot | null;
  /** Last snapshot of every view loaded in this tab, so a revisit skips the fetch. */
  snapshots: Record<string, Snapshot>;
  error: string | null;
  refreshing: boolean;
  refreshError: string | null;
  selected: IssueKey | null;
}

export const INITIAL_STATE: AppState = {
  views: null,
  viewsError: null,
  route: DEFAULT_ROUTE,
  status: 'idle',
  loadedViewId: null,
  loadedScopeId: null,
  freshness: null,
  job: null,
  snapshot: null,
  snapshots: {},
  error: null,
  refreshing: false,
  refreshError: null,
  selected: null,
};

export type Action =
  | { type: 'views-loaded'; views: ViewSummary[] }
  | { type: 'views-failed'; error: string }
  | { type: 'route'; route: Route }
  | { type: 'scope-load-start'; scope: Scope }
  | { type: 'scope-response'; response: ScopeResponse }
  | { type: 'scope-failed'; scope: Scope; status: number; error: string }
  | { type: 'load-start'; viewId: string }
  | { type: 'load-done'; viewId: string; snapshot: Snapshot }
  | { type: 'load-failed'; viewId: string; error: string }
  | { type: 'refresh-start'; viewId: string }
  | { type: 'refresh-done'; viewId: string; snapshot: Snapshot }
  | { type: 'refresh-failed'; viewId: string; error: string }
  | { type: 'dismiss-refresh-error' }
  | { type: 'select'; key: IssueKey | null };

/** The view shown: the routed one when it exists, else the first one. */
export function effectiveViewId(state: Pick<AppState, 'views' | 'route'>): string | null {
  const { views, route } = state;
  if (route.scope !== undefined) return null;
  if (views === null || views.length === 0) return null;
  if (route.viewId !== null && views.some((v) => v.id === route.viewId)) return route.viewId;
  return views[0]!.id;
}

/** Stable IDs shared with scope snapshots, not URL-encoded route strings. */
export function scopeId(scope: Scope): ScopeId {
  return scope.kind === 'source'
    ? `source:${scope.source}`
    : (`project:${scope.source}/${scope.repo.toLowerCase()}` as ScopeId);
}

export function routeScopeId(route: Route): ScopeId | null {
  const scope = route.scope;
  if (scope === undefined) return null;
  return scopeId(
    scope.kind === 'source'
      ? scope
      : { kind: 'project', source: scope.source, repo: `${scope.owner}/${scope.repo}` },
  );
}

export function isActiveScopeJob(job: RefreshJobStatus | null): boolean {
  return job?.state === 'queued' || job?.state === 'running';
}

/**
 * Absolute due time, for the caller to schedule (no requests/timers here).
 * `visibleSince` is the most recent hidden-to-visible transition, or null before
 * one occurs. A response at/after that transition consumes its freshness check.
 * Callers reset these timestamps when changing scope, and coalesce pending requests.
 */
export function nextScopeRequestAt(input: {
  job: RefreshJobStatus | null;
  respondedAt: number | null;
  visible: boolean;
  visibleSince: number | null;
}): number | null {
  if (!input.visible) return null;
  if (
    input.visibleSince !== null &&
    (input.respondedAt === null || input.respondedAt < input.visibleSince)
  )
    return input.visibleSince;
  return isActiveScopeJob(input.job) && input.respondedAt !== null
    ? input.respondedAt + 2000
    : null;
}

function keepSelection(selected: IssueKey | null, snapshot: Snapshot): IssueKey | null {
  return selected !== null && snapshot.plan.nodes.some((n) => n.key === selected) ? selected : null;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'views-loaded':
      return { ...state, views: action.views, viewsError: null };
    case 'views-failed':
      return { ...state, viewsError: action.error };
    case 'route': {
      const currentScope = routeScopeId(state.route);
      const nextScope = routeScopeId(action.route);
      if (currentScope !== nextScope) {
        return {
          ...state,
          route:
            nextScope === null
              ? action.route
              : { ...action.route, q: '', tab: state.route.tab, sort: state.route.sort },
          selected: null,
          loadedScopeId: nextScope,
          loadedViewId: null,
          snapshot: null,
          freshness: null,
          job: null,
          status: nextScope === null ? 'idle' : 'loading',
          error: null,
          refreshing: false,
          refreshError: null,
        };
      }
      if (JSON.stringify(action.route) === JSON.stringify(state.route)) return state;
      const viewChanged = action.route.viewId !== state.route.viewId;
      return { ...state, route: action.route, selected: viewChanged ? null : state.selected };
    }
    case 'scope-load-start':
      if (scopeId(action.scope) !== routeScopeId(state.route)) return state;
      return {
        ...state,
        loadedScopeId: scopeId(action.scope),
        loadedViewId: null,
        status: state.snapshot === null ? 'loading' : 'ready',
        error: null,
      };
    case 'scope-response': {
      const response = action.response;
      const id = scopeId(response.scope);
      if (id !== routeScopeId(state.route)) return state;
      const active = isActiveScopeJob(response.job);
      return {
        ...state,
        loadedScopeId: id,
        loadedViewId: null,
        snapshot: response.snapshot,
        freshness: response.freshness,
        job: response.job,
        refreshError: null,
        refreshing: false,
        status: response.snapshot !== null ? 'ready' : active ? 'loading' : 'unavailable',
        error:
          response.snapshot !== null || active
            ? null
            : (response.job?.error ??
              response.freshness.repositories.find((r) => r.error !== null)?.error ??
              'Scope data is unavailable'),
        selected:
          response.snapshot === null ? null : keepSelection(state.selected, response.snapshot),
      };
    }
    case 'scope-failed':
      if (scopeId(action.scope) !== routeScopeId(state.route)) return state;
      // A transport/refresh failure does not invalidate last-good data or the
      // active job. Only authoritative catalog/policy responses replace it.
      if (state.snapshot !== null && action.status !== 404 && action.status !== 409) {
        return {
          ...state,
          status: 'ready',
          refreshing: false,
          refreshError: action.error,
          freshness:
            state.freshness === null
              ? null
              : {
                  ...state.freshness,
                  repositories: state.freshness.repositories.map((repository) =>
                    repository.lastCheckedAt === null
                      ? repository
                      : { ...repository, state: 'stale' },
                  ),
                },
        };
      }
      return {
        ...state,
        loadedScopeId: scopeId(action.scope),
        loadedViewId: null,
        snapshot: null,
        freshness: null,
        job: null,
        selected: null,
        status:
          action.status === 404
            ? 'not-in-catalog'
            : action.status === 409
              ? 'conflict'
              : 'unavailable',
        error: action.error,
        refreshError: null,
        refreshing: false,
      };
    case 'load-start': {
      if (state.route.scope !== undefined) return state;
      // A view loaded earlier is shown as it was; the refresh timer updates it.
      const cached = state.snapshots[action.viewId] ?? null;
      return {
        ...state,
        status: cached === null ? 'loading' : 'ready',
        loadedViewId: action.viewId,
        loadedScopeId: null,
        freshness: null,
        job: null,
        snapshot: cached,
        error: null,
        refreshing: false,
        refreshError: null,
        selected: state.loadedViewId === action.viewId ? state.selected : null,
      };
    }
    case 'load-done':
      if (action.viewId !== state.loadedViewId) return state;
      return {
        ...state,
        status: 'ready',
        snapshot: action.snapshot,
        snapshots: { ...state.snapshots, [action.viewId]: action.snapshot },
        error: null,
        selected: keepSelection(state.selected, action.snapshot),
      };
    case 'load-failed':
      if (action.viewId !== state.loadedViewId) return state;
      return { ...state, status: 'error', snapshot: null, error: action.error };
    case 'refresh-start':
      if (state.route.scope !== undefined) return state;
      return { ...state, refreshing: true, refreshError: null };
    case 'refresh-done':
      if (action.viewId !== state.loadedViewId) return state;
      return {
        ...state,
        refreshing: false,
        refreshError: null,
        status: 'ready',
        snapshot: action.snapshot,
        snapshots: { ...state.snapshots, [action.viewId]: action.snapshot },
        error: null,
        selected: keepSelection(state.selected, action.snapshot),
      };
    case 'refresh-failed':
      if (action.viewId !== state.loadedViewId) return state;
      return { ...state, refreshing: false, refreshError: action.error };
    case 'dismiss-refresh-error':
      return { ...state, refreshError: null };
    case 'select': {
      if (state.selected === action.key) return state;
      const q = action.key === null ? null : revealQuery(state, action.key);
      return {
        ...state,
        selected: action.key,
        route: q === null ? state.route : { ...state.route, q },
      };
    }
  }
}

export function withTab(route: Route, tab: Tab): Route {
  return { ...route, tab };
}

// ---------------------------------------------------------------------------
// Filter visibility
// ---------------------------------------------------------------------------

const indexCache = new WeakMap<Snapshot, SnapshotIndex>();

/** Index of the snapshot of `state`, computed once per snapshot object. */
export function getIndex(state: AppState): SnapshotIndex | null {
  const snapshot = state.snapshot;
  if (snapshot === null) return null;
  let index = indexCache.get(snapshot);
  if (index === undefined) {
    const viewId = effectiveViewId(state);
    const repos = state.views?.find((v) => v.id === viewId)?.repos ?? [];
    index = indexSnapshot(snapshot, repos);
    indexCache.set(snapshot, index);
  }
  return index;
}

export function nodeTarget(n: PlanNode, snapshot: Snapshot, index: SnapshotIndex): FilterTarget {
  return {
    key: n.key,
    number: n.number,
    title: n.title,
    labels: n.labels,
    assignees: n.assignees,
    milestone: n.milestone,
    repo: `${n.repo.owner}/${n.repo.repo}`,
    status: n.status,
    external: n.external,
    priority: priorityName(snapshot, n),
    critical: index.criticalNodes.has(n.key),
    parents: n.parents,
  };
}

let visibleFor: { snapshot: Snapshot; q: string; keys: Set<IssueKey> | null } | null = null;

/**
 * Keys of the issues that match the filter, or null when nothing is filtered.
 * Memoized per (snapshot, query): the same Set object is returned until either
 * changes, so views can compare it by identity.
 */
export function visibleKeys(state: AppState, index: SnapshotIndex): Set<IssueKey> | null {
  const snapshot = state.snapshot;
  if (snapshot === null) return null;
  if (visibleFor?.snapshot === snapshot && visibleFor.q === state.route.q) return visibleFor.keys;
  const f = compileFilter(state.route.q);
  let keys: Set<IssueKey> | null = null;
  if (f !== null) {
    keys = new Set();
    for (const n of snapshot.plan.nodes) if (f(nodeTarget(n, snapshot, index))) keys.add(n.key);
  }
  visibleFor = { snapshot, q: state.route.q, keys };
  return keys;
}

export function isVisible(keys: Set<IssueKey> | null, key: IssueKey): boolean {
  return keys === null || keys.has(key);
}

/**
 * The query that reveals `key` under the current filter, or null when the key
 * is already visible. A hidden issue is revealed by narrowing to its repository.
 */
function revealQuery(state: AppState, key: IssueKey): string | null {
  const index = getIndex(state);
  if (index === null || isVisible(visibleKeys(state, index), key)) return null;
  const node = index.nodes.get(key);
  return node === undefined ? null : `repo:${node.repo.owner}/${node.repo.repo}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type Listener = (state: AppState, prev: AppState) => void;

export class Store {
  private state: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppState = INITIAL_STATE) {
    this.state = initial;
  }

  get(): AppState {
    return this.state;
  }

  dispatch(action: Action): void {
    const prev = this.state;
    const next = reducer(prev, action);
    if (next === prev) return;
    this.state = next;
    for (const l of [...this.listeners]) l(next, prev);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
