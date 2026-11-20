import type { CatalogResponse, ProjectRef, Scope } from '../../../src/core/scope.js';
import { clear, h, icon } from '../dom.js';
import { canChangeFavorites, type PreferenceState } from '../preferenceState.js';
import {
  effectiveViewId,
  homeView as findHomeView,
  routeScopeId,
  scopeId,
  type AppState,
} from '../state.js';

export interface ProjectSidebarActions {
  selectScope(scope: Scope): void;
  openView(viewId: string): void;
  toggleFavorite(project: ProjectRef, favorite: boolean): void;
}

export interface ProjectSidebar {
  el: HTMLElement;
  update(
    state: Pick<AppState, 'route' | 'views'>,
    preferences: PreferenceState,
    catalog: CatalogResponse | null,
  ): void;
}

let nextSidebarId = 0;

/**
 * A callback-only view: routing, fetching and saving belong to the caller.
 * Its disclosure uses the existing 640px compact breakpoint in styles.css.
 */
export function createProjectSidebar(actions: ProjectSidebarActions): ProjectSidebar {
  const id = `project-sidebar-${++nextSidebarId}`;
  const brand = h(
    'div',
    { class: 'brand project-sidebar-brand' },
    h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('graph', 15)),
    h('span', { class: 'brand-name' }, 'Forge Desk'),
  );
  const nav = h('nav', { id, class: 'project-sidebar-nav', 'aria-label': 'Projects and views' });
  const toggle = h(
    'button',
    {
      class: 'btn project-sidebar-toggle',
      type: 'button',
      'aria-controls': id,
      'aria-expanded': 'false',
      onclick: () => setOpen(!open),
    },
    'Projects',
    icon('chevron', 14),
  );
  const el = h(
    'aside',
    { class: 'project-sidebar', 'aria-label': 'Project navigation' },
    brand,
    toggle,
    nav,
  );
  let open = false;
  let previous: {
    current: string | null;
    viewCurrent: string | null;
    views: AppState['views'];
    preferences: PreferenceState['view'];
    writable: boolean;
    catalog: CatalogResponse | null;
  } | null = null;
  let controls = new Map<string, { button: HTMLButtonElement; fallback?: string }>();
  // Views start collapsed; this session-only set of view ids survives re-renders.
  const expanded = new Set<string>();
  let groups: { view: string; button: HTMLButtonElement; list: HTMLElement }[] = [];
  let expandAll: HTMLButtonElement | null = null;

  function showGroup(group: (typeof groups)[number], value: boolean): void {
    if (value) expanded.add(group.view);
    else expanded.delete(group.view);
    group.button.setAttribute('aria-expanded', String(value));
    if (value) group.list.removeAttribute('hidden');
    else group.list.setAttribute('hidden', '');
  }

  function syncExpandAll(): void {
    const label = groups.every((group) => expanded.has(group.view)) ? 'Collapse all' : 'Expand all';
    if (!expandAll) return;
    clear(expandAll);
    expandAll.append(label);
  }

  function setOpen(value: boolean): void {
    open = value;
    el.classList.toggle('is-open', value);
    toggle.setAttribute('aria-expanded', String(value));
  }

  function close(): void {
    if (!open) return;
    setOpen(false);
    // Returning focus to the disclosure avoids leaving it in the hidden list.
    // On desktop the disclosure is hidden, so keep focus in the visible sidebar.
    if (toggle.getClientRects().length > 0) toggle.focus();
  }

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  function control(key: string, button: HTMLButtonElement, fallback?: string): HTMLButtonElement {
    controls.set(key, { button, fallback });
    return button;
  }

  return {
    el,
    update(state, preferences, catalog) {
      const current = routeScopeId(state.route);
      const viewCurrent =
        current === null && state.route.viewId !== null ? effectiveViewId(state) : null;
      const writable = canChangeFavorites(preferences);
      if (
        previous?.current === current &&
        previous.viewCurrent === viewCurrent &&
        previous.views === state.views &&
        previous.preferences === preferences.view &&
        previous.writable === writable &&
        previous.catalog === catalog
      )
        return;
      // Views can load after the route, so reveal again when they arrive.
      const reveal = previous?.current !== current || previous.views !== state.views;
      previous = {
        current,
        viewCurrent,
        views: state.views,
        preferences: preferences.view,
        writable,
        catalog,
      };

      const focused = [...controls.entries()].find(
        ([, value]) => value.button === document.activeElement,
      );
      controls = new Map();
      clear(nav);
      const view = preferences.view;
      const favorites =
        view.status === 'available' || view.status === 'unverified'
          ? view.preferences.favorites
          : [];
      const isFavorite = (project: ProjectRef): boolean =>
        favorites.some(
          (favorite) => favorite.source === project.source && favorite.repo === project.repo,
        );
      const views = state.views ?? [];
      const homeView = (project: ProjectRef) => findHomeView(views, project);
      const projectTitle = (project: ProjectRef): string =>
        homeView(project)?.title ??
        catalog?.sources.find((source) => source.id === project.source)?.title ??
        project.source;
      // Reveal the current page's view unless Favorites already shows it.
      const route = state.route.scope;
      if (reveal && viewCurrent !== null) expanded.add(viewCurrent);
      if (reveal && route?.kind === 'source')
        for (const v of views) if (v.source === route.source) expanded.add(v.id);
      if (
        reveal &&
        route?.kind === 'project' &&
        !favorites.some((favorite) => scopeId({ kind: 'project', ...favorite }) === current)
      ) {
        const home = homeView({
          source: route.source,
          repo: `${route.owner}/${route.repo}`.toLowerCase(),
        });
        if (home) expanded.add(home.id);
      }

      function choose(scope: Scope): void {
        close();
        if (scopeId(scope) !== current) actions.selectScope(scope);
      }

      function projectRow(
        project: ProjectRef,
        section: 'favorites' | 'catalog',
        available = true,
        viewId = homeView(project)?.id ?? '',
      ): HTMLElement {
        const scope: Scope = { kind: 'project', ...project };
        const favorite = isFavorite(project);
        // A repo listed by several views is the same project: only its home view row is current.
        const home = section === 'favorites' || homeView(project)?.id === viewId;
        const key = (area: string, action: string, group = viewId): string =>
          JSON.stringify([area, action, group, project.source, project.repo]);
        const displayTitle = projectTitle(project);
        const name = `${displayTitle} / ${project.repo}`;
        return h(
          'li',
          { class: 'project-sidebar-row' },
          control(
            key(section, 'open'),
            h(
              'button',
              {
                class: 'project-sidebar-entry',
                type: 'button',
                'aria-label': `${available ? 'Open' : 'Unavailable project:'} ${name}`,
                // A starred project is marked once, in Favorites, not again under its source.
                'aria-current':
                  current === scopeId(scope) && home && (section === 'favorites' || !favorite)
                    ? 'page'
                    : null,
                'aria-disabled': !available ? 'true' : null,
                title: available ? name : `${name} is no longer in the catalog`,
                onclick: () => {
                  if (available) choose(scope);
                },
              },
              h('span', { class: 'project-sidebar-repo' }, project.repo),
              section === 'favorites'
                ? h('span', { class: 'project-sidebar-source' }, displayTitle)
                : null,
              !available
                ? h('span', { class: 'project-sidebar-unavailable' }, 'Unavailable')
                : null,
            ),
            key('catalog', 'open'),
          ),
          control(
            key(section, 'star'),
            h(
              'button',
              {
                class: 'project-sidebar-star',
                type: 'button',
                'aria-label': `${favorite ? 'Remove' : 'Add'} ${name} ${favorite ? 'from' : 'to'} favorites`,
                'aria-pressed': String(favorite),
                'aria-disabled': !writable ? 'true' : null,
                'aria-describedby': !writable ? `${id}-preferences` : null,
                title: writable
                  ? `${favorite ? 'Unstar' : 'Star'} ${name}`
                  : 'Favorites are read-only',
                onclick: () => {
                  if (!writable) return;
                  // Unstarring moves focus to the catalog row, so keep that row visible.
                  if (favorite) expanded.add(homeView(project)?.id ?? '');
                  actions.toggleFavorite({ ...project }, !favorite);
                },
              },
              icon(favorite ? 'starFill' : 'star', 14),
            ),
            key('catalog', 'star'),
          ),
        );
      }

      const favoriteSection = h(
        'section',
        { class: 'project-sidebar-section', 'aria-label': 'Favorites' },
        h('h2', { class: 'project-sidebar-heading' }, icon('starFill', 12), 'Favorites'),
      );
      const preferenceMessage =
        view.status === 'unavailable'
          ? `Personal preferences are unavailable. ${view.message}`
          : view.status === 'unverified'
            ? `Personal preferences could not be verified. Favorites are read-only. ${view.message}`
            : view.status === 'not-loaded'
              ? 'Personal preferences have not loaded. Favorites are read-only.'
              : !writable
                ? 'Personal preferences are being checked. Favorites are read-only.'
                : null;
      if (preferenceMessage)
        favoriteSection.append(
          h(
            'p',
            { id: `${id}-preferences`, class: 'project-sidebar-note', role: 'status' },
            preferenceMessage,
          ),
        );
      if (favorites.length > 0) {
        favoriteSection.append(
          h(
            'ul',
            { class: 'project-sidebar-list' },
            ...favorites.map((favorite) => {
              const inCatalog =
                favorite.inCatalog &&
                (catalog === null ||
                  catalog.sources.some(
                    (source) =>
                      source.id === favorite.source &&
                      source.projects.some((project) => project.repo === favorite.repo),
                  ));
              return projectRow(
                { source: favorite.source, repo: favorite.repo },
                'favorites',
                inCatalog,
              );
            }),
          ),
        );
      } else if (view.status === 'available') {
        favoriteSection.append(
          h('p', { class: 'project-sidebar-note' }, 'No favorites yet. Star a project below.'),
        );
      }
      nav.append(favoriteSection);

      if (state.views === null)
        nav.append(h('p', { class: 'project-sidebar-note' }, 'Projects have not loaded.'));
      groups = [];
      expandAll = null;
      if (views.length > 0) {
        expandAll = control(
          'expand-all',
          h('button', {
            class: 'link-btn project-sidebar-expand-all',
            type: 'button',
            onclick: () => {
              const value = !groups.every((group) => expanded.has(group.view));
              for (const group of groups) showGroup(group, value);
              syncExpandAll();
            },
          }),
        );
        nav.append(
          h('div', { class: 'project-sidebar-sources-bar' }, h('span', null, 'Views'), expandAll),
        );
      }
      for (const [index, v] of views.entries()) {
        const listId = `${id}-view-${index}`;
        const isOpen = expanded.has(v.id);
        const projects = [...new Set(v.repos.map((repo) => repo.toLowerCase()))].map(
          (repo): ProjectRef => ({ source: v.source, repo }),
        );
        const group = {
          view: v.id,
          button: control(
            JSON.stringify(['group', v.id]),
            h(
              'button',
              {
                class: 'project-sidebar-group',
                type: 'button',
                'aria-expanded': String(isOpen),
                'aria-controls': listId,
                onclick: () => {
                  showGroup(group, !expanded.has(v.id));
                  syncExpandAll();
                },
              },
              icon('chevron', 12),
              h('span', { class: 'project-sidebar-group-title' }, v.title),
              h('span', { class: 'project-sidebar-count' }, String(projects.length)),
            ),
          ),
          list: h(
            'ul',
            { id: listId, class: 'project-sidebar-list', hidden: !isOpen },
            h(
              'li',
              { class: 'project-sidebar-row' },
              control(
                JSON.stringify(['view', v.id]),
                h(
                  'button',
                  {
                    class: 'project-sidebar-entry',
                    type: 'button',
                    'aria-label': `All projects in ${v.title}`,
                    'aria-current': viewCurrent === v.id ? 'page' : null,
                    onclick: () => {
                      close();
                      if (viewCurrent !== v.id) actions.openView(v.id);
                    },
                  },
                  h('span', { class: 'project-sidebar-repo' }, 'All projects'),
                ),
              ),
            ),
            ...projects.map((project) => projectRow(project, 'catalog', true, v.id)),
          ),
        };
        groups.push(group);
        nav.append(
          h(
            'section',
            { class: 'project-sidebar-section', 'aria-label': `View ${v.title}` },
            h('h2', { class: 'project-sidebar-heading' }, group.button),
            group.list,
          ),
        );
      }
      syncExpandAll();

      if (focused) {
        const target =
          controls.get(focused[0]) ??
          controls.get(focused[1].fallback ?? '') ??
          controls.values().next().value;
        target?.button.focus();
      }
    },
  };
}
