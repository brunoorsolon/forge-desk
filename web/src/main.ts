import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import {
  errorMessage,
  fetchProjects,
  fetchSettings,
  fetchSnapshot,
  fetchViews,
  refreshSnapshot,
} from './api.js';
import type { CatalogResponse } from '../../src/core/scope.js';
import { initialPreferenceState, type PreferenceState } from './preferenceState.js';
import { resolveStartup, type StartupPreferences } from './startup.js';
import {
  createScopeNavigation,
  routeForScope,
  scopeFromRoute,
  scopePanel,
} from './scope-navigation.js';
import { createProjectSidebar } from './views/project-sidebar.js';
import { createScopeHeading } from './views/scope-heading.js';
import { h } from './dom.js';
import { parseHash, serializeHash, type Route, type Tab } from './route.js';
import { parseReleaseHash } from './release-route.js';
import { createReleasesView } from './views/releases.js';
import {
  effectiveViewId,
  getIndex,
  INITIAL_STATE,
  isVisible,
  Store,
  visibleKeys,
} from './state.js';
import { applyTheme, loadTheme } from './theme.js';
import { createGraphView } from './views/graph.js';
import { createHeader } from './views/header.js';
import { createOrderView } from './views/order.js';
import { createProblemsView } from './views/problems.js';
import { type Actions, type View, type ViewCtx } from './views/shared.js';
import { createSidePanel } from './views/side-panel.js';
import { createStates, createScopeStates, type ScopePanelState } from './views/states.js';
import { createSummary } from './views/summary.js';

applyTheme(loadTheme());

const store = new Store({ ...INITIAL_STATE, route: parseHash(location.hash) });

// ------------------------------------------ project-first navigation wiring
// Preference reads/saves and refresh mutations are wired by their own tickets.
const startupPreferences: StartupPreferences = {
  available: false,
  reason: 'storage-not-configured',
  message: 'Personal preferences are not connected yet.',
};
const preferences: PreferenceState = {
  ...initialPreferenceState(),
  view: {
    status: 'unavailable',
    reason: startupPreferences.reason,
    message: startupPreferences.message,
  },
};
let catalog: CatalogResponse | null = null;
let catalogError: string | null = null;
let navigationPanel: ScopePanelState | null = {
  kind: 'loading',
  message: 'Loading the project catalog.',
};
let resolved = false;
const scopeNavigation = createScopeNavigation(store);
scopeNavigation.setVisible(!document.hidden && parseReleaseHash(location.hash) === null);

function resolveLocation(): void {
  if (parseReleaseHash(location.hash) !== null) return;
  const route = parseHash(location.hash);
  // Existing view links do not depend on the catalog being available.
  if (route.scope === undefined && route.viewId !== null) {
    navigationPanel = null;
    resolved = true;
    store.dispatch({ type: 'route', route });
    render();
    return;
  }
  if (catalog === null) {
    resolved = false;
    navigationPanel =
      catalogError === null
        ? { kind: 'loading', message: 'Loading the project catalog.' }
        : { kind: 'unavailable', message: `Couldn’t load the project catalog: ${catalogError}` };
    scopeNavigation.open(null);
    store.dispatch({ type: 'route', route });
    render();
    return;
  }
  const result = resolveStartup({
    hash: location.hash,
    catalog,
    preferences: startupPreferences,
    views: store.get().views ?? [],
  });
  resolved = true;
  navigationPanel = null;
  let next = route;
  if (result.kind === 'scope') next = result.route;
  else if (result.kind === 'policy-conflict') {
    next = routeForScope(result.scope, route);
    navigationPanel = { kind: 'policy-conflict', conflict: result.conflict };
  } else if (result.kind === 'not-in-catalog') {
    navigationPanel = {
      kind: 'not-in-catalog',
      source: result.scope.source,
      ...(result.scope.kind === 'project' ? { repo: result.scope.repo } : {}),
    };
  } else if (result.kind === 'preference-error') {
    navigationPanel = {
      kind: 'preference-error',
      reason: result.error.reason,
      message: result.error.message,
    };
  } else if (result.kind === 'empty-catalog') navigationPanel = { kind: 'empty-catalog' };
  store.dispatch({ type: 'route', route: next });
  // Resolve startup in place; back returns to the user's previous page, not a bare-root detour.
  const hash = serializeHash(store.get().route);
  if (location.hash !== hash) history.replaceState(null, '', hash);
  render();
}

// ---------------------------------------------------------------- navigation

/** Writes the route to the URL hash. `replace` avoids a history entry (typing in the filter). */
function navigate(route: Route, replace = false): void {
  const hash = serializeHash(route);
  if (replace) {
    history.replaceState(null, '', hash);
  } else if (location.hash !== hash) {
    location.hash = hash; // hashchange re-dispatches the same route; the sync dispatch below covers callers that act first
  } else {
    return;
  }
  // Dispatch synchronously so a caller that acts right after navigate, or a
  // microtask that resolves before the hashchange event, sees the new route.
  resolveLocation();
}

function currentRoute(): Route {
  const state = store.get();
  const viewId = effectiveViewId(state);
  return { ...state.route, viewId: viewId ?? state.route.viewId };
}

// ------------------------------------------------------------------- loading

let loadToken = 0;

async function loadSnapshot(viewId: string): Promise<void> {
  const token = ++loadToken;
  store.dispatch({ type: 'load-start', viewId });
  if (store.get().status === 'ready') return; // loaded earlier in this tab
  try {
    const snapshot = await fetchSnapshot(viewId);
    if (token === loadToken) store.dispatch({ type: 'load-done', viewId, snapshot });
  } catch (e) {
    if (token === loadToken)
      store.dispatch({ type: 'load-failed', viewId, error: errorMessage(e) });
  }
}

async function refresh(force = true): Promise<void> {
  const state = store.get();
  const viewId = effectiveViewId(state);
  if (viewId === null || state.refreshing) return;
  const token = ++loadToken;
  store.dispatch({ type: 'refresh-start', viewId });
  try {
    const snapshot = await refreshSnapshot(viewId, force);
    if (token === loadToken) store.dispatch({ type: 'refresh-done', viewId, snapshot });
  } catch (e) {
    if (token === loadToken)
      store.dispatch({ type: 'refresh-failed', viewId, error: errorMessage(e) });
  }
}

// ------------------------------------------------------------------- actions

const actions: Actions = {
  select: (key) => store.dispatch({ type: 'select', key }),
  showInGraph: (key) => {
    store.dispatch({ type: 'select', key });
    navigate({ ...currentRoute(), tab: 'graph' });
  },
  setTab: (tab: Tab) => navigate({ ...currentRoute(), tab }),
  setView: (viewId) => {
    const { scope: _scope, ...route } = currentRoute();
    navigate({ ...route, viewId });
  },
  setQuery: (q) => navigate({ ...currentRoute(), q }, true),
  setSort: (sort) => navigate({ ...currentRoute(), sort }),
  refresh: () => void refresh(),
  reload: () => {
    const viewId = effectiveViewId(store.get());
    if (viewId !== null) void loadSnapshot(viewId);
  },
};

// ------------------------------------------------------------------------ UI

const ctx: ViewCtx = { store, actions };
const header = createHeader(ctx);
const summary = createSummary(ctx);
const states = createStates(ctx);
const graph = createGraphView(ctx);
const order = createOrderView(ctx);
const problems = createProblemsView(ctx);
const panel = createSidePanel(ctx);
const sidebar = createProjectSidebar({
  selectScope: (scope) => navigate(routeForScope(scope, currentRoute())),
  openViews: () => {
    const viewId = store.get().views?.[0]?.id;
    if (viewId !== undefined) actions.setView(viewId);
  },
  toggleFavorite: () => {}, // unavailable until preference wiring supplies persistence
});
const heading = createScopeHeading({ toggleFavorite: () => {} });
const scopeStates = createScopeStates();
const scopeEmpty = h(
  'section',
  { class: 'state-center', hidden: true },
  h(
    'div',
    { class: 'box' },
    h('h2', null, 'No open issues in this scope'),
    h('p', null, 'This scope has no open issues matching its planning policy.'),
  ),
);

const main = h('main', { class: 'main' }, graph.el, order.el, problems.el, panel.el);
const app = document.getElementById('app');
if (!app) throw new Error('missing #app');
const planningContent = h(
  'div',
  { class: 'planning' },
  header.el,
  heading.el,
  summary.el,
  states.el,
  scopeStates.el,
  scopeEmpty,
  main,
);
const planning = h('div', { class: 'planning-shell' }, sidebar.el, planningContent);
const releases = createReleasesView();
const planningLink = h('a', { class: 'tab', href: serializeHash(currentRoute()) }, 'Planning');
const releasesLink = h('a', { class: 'tab', href: '#/releases' }, 'Releases');
const areas = h(
  'nav',
  { class: 'area-nav', 'aria-label': 'Forge Desk areas' },
  planningLink,
  releasesLink,
);
app.append(areas, planning, releases.el);

function syncArea(): void {
  const route = parseReleaseHash(location.hash);
  planning.hidden = route !== null;
  scopeNavigation.setVisible(!document.hidden && route === null);
  planningLink.setAttribute('aria-current', route === null ? 'page' : 'false');
  releasesLink.setAttribute('aria-current', route === null ? 'false' : 'page');
  if (route !== null) {
    document.title = 'Releases · Forge Desk';
    void releases.open(route);
  } else {
    releases.close();
    document.title = titleFor(store.get());
  }
}

const views: View[] = [header, summary, states, graph, order, problems, panel];

function layoutMain(state: ReturnType<Store['get']>): void {
  main.hidden = navigationPanel !== null || !states.showsContent(state);
  main.classList.toggle('panel-open', state.selected !== null && state.route.tab !== 'problems');
}

function render(): void {
  const state = store.get();
  layoutMain(state);
  for (const v of views) v.update(state, state);
  updateNavigation(state);
}

let prevState = store.get();
store.subscribe((state) => {
  // A selected issue that the filter hides is deselected.
  const index = getIndex(state);
  if (state.selected !== null && index !== null) {
    if (!isVisible(visibleKeys(state, index), state.selected)) {
      store.dispatch({ type: 'select', key: null });
      return;
    }
  }
  layoutMain(state);
  for (const v of views) v.update(state, prevState);
  updateNavigation(state);
  prevState = state;
  if (parseReleaseHash(location.hash) === null) document.title = titleFor(state);
  planningLink.href = serializeHash(currentRoute());
  // A snapshot for another view is needed when the effective view changed.
  const viewId = effectiveViewId(state);
  if (
    resolved &&
    navigationPanel === null &&
    parseReleaseHash(location.hash) === null &&
    viewId !== null &&
    viewId !== state.loadedViewId
  ) {
    void loadSnapshot(viewId);
  }
  // Keep the URL in step with the route: the canonical view id, and the filter
  // a reveal changed in the store.
  if (resolved && navigationPanel === null && parseReleaseHash(location.hash) === null) {
    const route = viewId === null ? state.route : { ...state.route, viewId };
    if (location.hash !== serializeHash(route)) navigate(route, true);
  }
});

function updateNavigation(state: ReturnType<Store['get']>): void {
  sidebar.update(state, preferences, catalog);
  heading.update(state, preferences);
  const scoped = state.route.scope !== undefined;
  const blocked = navigationPanel !== null;
  const panelState =
    navigationPanel ?? (scoped ? scopePanel(state, catalog) : { kind: 'ready' as const });
  scopeStates.update(panelState);
  if (scoped || blocked) states.el.hidden = true;
  if (blocked) summary.el.hidden = true;
  header.el.hidden = blocked && !scoped;
  scopeEmpty.hidden =
    blocked || !scoped || state.status !== 'ready' || state.snapshot?.plan.nodes.length !== 0;
  scopeNavigation.open(resolved && !blocked ? scopeFromRoute(state.route) : null);
}

function titleFor(state: ReturnType<Store['get']>): string {
  const scope = state.route.scope;
  if (scope !== undefined)
    return `${scope.kind === 'project' ? `${scope.owner}/${scope.repo}` : 'All projects'} · ${scope.source} · Forge Desk`;
  const view = state.views?.find((v) => v.id === effectiveViewId(state));
  return view ? `${view.title} · Forge Desk` : 'Forge Desk';
}

window.addEventListener('hashchange', () => {
  if (parseReleaseHash(location.hash) === null) resolveLocation();
  syncArea();
});

document.addEventListener('keydown', (e) => {
  if (parseReleaseHash(location.hash) !== null) return;
  const target = e.target as HTMLElement | null;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (typing && target instanceof HTMLInputElement) target.blur();
    if (store.get().selected !== null) actions.select(null);
  } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    document.querySelector<HTMLInputElement>('.filter-input')?.focus();
  } else if (
    (e.key === 'f' || e.key === 'F') &&
    !typing &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    store.get().route.tab === 'graph'
  ) {
    graph.fit();
  }
});

render();
syncArea();
resolveLocation();

fetchProjects().then(
  (result) => {
    catalog = result;
    resolveLocation();
  },
  (error: unknown) => {
    catalogError = errorMessage(error);
    resolveLocation();
  },
);

fetchViews().then(
  (list) => {
    store.dispatch({ type: 'views-loaded', views: list });
    resolveLocation();
  },
  (e: unknown) => store.dispatch({ type: 'views-failed', error: errorMessage(e) }),
);

document.addEventListener('visibilitychange', () => {
  const visible = !document.hidden && parseReleaseHash(location.hash) === null;
  scopeNavigation.setVisible(visible);
  if (visible && resolved && navigationPanel === null && store.get().route.scope === undefined)
    void refresh(false);
});

fetchSettings().then(
  ({ refreshMinutes }) => {
    scopeNavigation.setRefreshMinutes(refreshMinutes);
    if (refreshMinutes > 0)
      setInterval(() => {
        if (
          !document.hidden &&
          parseReleaseHash(location.hash) === null &&
          resolved &&
          navigationPanel === null &&
          store.get().route.scope === undefined
        )
          void refresh(false);
      }, refreshMinutes * 60_000);
  },
  () => {}, // no timer; the Refresh button still works
);
