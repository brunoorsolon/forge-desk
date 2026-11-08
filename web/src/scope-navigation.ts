import type { CatalogResponse, Scope, ScopeResponse } from '../../src/core/scope.js';
import { ApiError, errorMessage, fetchScopeSnapshot, refreshScope } from './api.js';
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
  refresh: (scope: Scope) => Promise<ScopeResponse> = refreshScope,
) {
  let scope: Scope | null = null;
  let visible = true;
  let generation = 0;
  let pending = false;
  let requestedRecheck = 0;
  let completedRecheck = 0;
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
  async function load(target: Scope, explicit: boolean): Promise<void> {
    cancelTimer();
    const origin = scope!;
    const token = generation;
    const recheckAtStart = requestedRecheck;
    let succeeded = false;
    pending = true;
    store.dispatch({ type: 'scope-load-start', scope: origin });
    try {
      const response = await (explicit ? refresh : read)(target);
      if (token === generation) {
        // A source refresh from a project displays its returned All projects scope.
        // Do not leave the old scope before success: rejected launches keep its data.
        if (scopeId(response.scope) !== scopeId(origin)) {
          scope = response.scope;
          store.dispatch({ type: 'route', route: routeForScope(scope, store.get().route) });
        }
        store.dispatch({ type: 'scope-response', response });
        succeeded = true;
      }
    } catch (error) {
      if (token === generation)
        store.dispatch({
          type: 'scope-failed',
          scope: origin,
          // Even a rejected explicit refresh must retain the data already on screen.
          status: !explicit && error instanceof ApiError ? error.status : 0,
          error: errorMessage(error),
        });
    } finally {
      if (token === generation) {
        pending = false;
        respondedAt = Date.now();
        // Only a current read attempt or successful refresh satisfies earlier
        // rechecks. A rejected refresh must not consume a sweep's recheck when
        // it supersedes a pending read, and requests received during this load
        // still need a later read. Failed passive reads stop with their error.
        if (!explicit || succeeded) completedRecheck = recheckAtStart;
        if (completedRecheck < requestedRecheck) void check();
        else schedule();
      }
    }
  }
  async function check(): Promise<void> {
    if (!visible || scope === null || pending) return;
    await load(scope, false);
  }
  return {
    open(next: Scope | null): void {
      if ((scope === null ? null : scopeId(scope)) === (next === null ? null : scopeId(next)))
        return;
      cancelTimer();
      generation++;
      pending = false;
      requestedRecheck = 0;
      completedRecheck = 0;
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
    recheck(): void {
      if (scope === null) return;
      requestedRecheck++;
      if (!pending) void check();
    },
    async refresh(target: Scope): Promise<void> {
      if (!visible || scope === null) return;
      // Explicit intent supersedes an in-flight passive read. Repeated launches
      // may join on the server; only the latest response can update this page.
      generation++;
      await load(target, true);
    },
  };
}
