import type { CatalogResponse, Scope, ScopeResponse } from '../../src/core/scope.js';
import { ApiError, errorMessage, fetchScopeSnapshot } from './api.js';
import type { Route } from './route.js';
import { nextScopeRequestAt, scopeId, type AppState, type Store } from './state.js';
import type { ScopePanelState } from './views/states.js';

export function scopeFromRoute(route: Route): Scope | null {
  const scope = route.scope;
  return scope === undefined
    ? null
    : scope.kind === 'source'
      ? scope
      : {
          kind: 'project',
          source: scope.source,
          repo: `${scope.owner}/${scope.repo}`,
        };
}

export function routeForScope(scope: Scope, route: Route): Route {
  const [owner, repo] = scope.kind === 'project' ? scope.repo.split('/') : [];
  return {
    ...route,
    viewId: null,
    q: '',
    scope:
      scope.kind === 'source'
        ? scope
        : {
            kind: 'project',
            source: scope.source,
            owner: owner!,
            repo: repo!,
          },
  };
}

/** Translate loading outcomes without inventing an empty project or hiding last-good data. */
export function scopePanel(state: AppState, catalog: CatalogResponse | null): ScopePanelState {
  const scope = scopeFromRoute(state.route);
  if (scope === null || state.snapshot !== null) return { kind: 'ready' };
  if (state.status === 'not-in-catalog')
    return {
      kind: 'not-in-catalog',
      source: scope.source,
      ...(scope.kind === 'project' ? { repo: scope.repo } : {}),
    };
  const policy = catalog?.sources.find((source) => source.id === scope.source)?.policy;
  if (state.status === 'conflict' && policy?.status === 'conflict')
    return { kind: 'policy-conflict', conflict: policy.conflict };
  const delayed = state.freshness?.repositories.find(
    (repository) => repository.delayedUntil !== null,
  );
  if (delayed?.delayedUntil)
    return {
      kind: 'delayed',
      message: delayed.error ?? 'Waiting for the provider cooldown.',
      expectedEnd: delayed.delayedUntil,
    };
  if (state.status === 'unavailable' || state.status === 'conflict')
    return { kind: 'unavailable', message: state.error ?? 'Scope data is unavailable.' };
  return { kind: 'loading' };
}

/** One visible/open-scope lane. Navigation invalidates old requests, including A → B → A. */
export function createScopeNavigation(
  store: Store,
  read: (scope: Scope) => Promise<ScopeResponse> = fetchScopeSnapshot,
) {
  let scope: Scope | null = null;
  let visible = true;
  let generation = 0;
  let pending = false;
  let respondedAt: number | null = null;
  let visibleSince: number | null = null;
  let interval = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancelTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }
  function schedule(): void {
    cancelTimer();
    if (!visible || scope === null || pending) return;
    const followup = nextScopeRequestAt({
      job: store.get().job,
      respondedAt,
      visible,
      visibleSince,
    });
    const periodic = interval > 0 && respondedAt !== null ? respondedAt + interval : null;
    const due =
      followup === null ? periodic : periodic === null ? followup : Math.min(followup, periodic);
    if (due !== null) timer = setTimeout(() => void check(), Math.max(0, due - Date.now()));
  }
  async function check(): Promise<void> {
    if (!visible || scope === null || pending) return;
    cancelTimer();
    const target = scope;
    const token = generation;
    pending = true;
    store.dispatch({ type: 'scope-load-start', scope: target });
    try {
      const response = await read(target);
      if (token === generation) store.dispatch({ type: 'scope-response', response });
    } catch (error) {
      if (token === generation)
        store.dispatch({
          type: 'scope-failed',
          scope: target,
          status: error instanceof ApiError ? error.status : 0,
          error: errorMessage(error),
        });
    } finally {
      if (token === generation) {
        pending = false;
        respondedAt = Date.now();
        schedule();
      }
    }
  }
  return {
    open(next: Scope | null): void {
      if ((scope === null ? null : scopeId(scope)) === (next === null ? null : scopeId(next)))
        return;
      cancelTimer();
      generation++;
      pending = false;
      respondedAt = null;
      visibleSince = null;
      scope = next;
      void check();
    },
    setVisible(value: boolean): void {
      if (value === visible) return;
      visible = value;
      cancelTimer();
      if (visible) {
        visibleSince = Date.now();
        void check();
      }
    },
    setRefreshMinutes(minutes: number): void {
      interval = Math.max(0, minutes) * 60_000;
      schedule();
    },
    check,
  };
}
