import type { CatalogResponse, ProjectRef, Scope } from '../../../src/core/scope.js';
import { clear, h, icon } from '../dom.js';
import { canChangeFavorites, type PreferenceState } from '../preferenceState.js';
import { routeScopeId, scopeId, type AppState } from '../state.js';

export interface ProjectSidebarActions {
  selectScope(scope: Scope): void;
  openViews(): void;
  toggleFavorite(project: ProjectRef, favorite: boolean): void;
}

export interface ProjectSidebar {
  el: HTMLElement;
  update(
    state: Pick<AppState, 'route'>,
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
    viewsCurrent: boolean;
    preferences: PreferenceState['view'];
    writable: boolean;
    catalog: CatalogResponse | null;
  } | null = null;
  let controls = new Map<string, { button: HTMLButtonElement; fallback?: string }>();
  // Sources start collapsed; this session-only set survives re-renders.
  const expanded = new Set<string>();
  let groups: { source: string; button: HTMLButtonElement; list: HTMLElement }[] = [];
  let expandAll: HTMLButtonElement | null = null;

  function showGroup(group: (typeof groups)[number], value: boolean): void {
    if (value) expanded.add(group.source);
    else expanded.delete(group.source);
    group.button.setAttribute('aria-expanded', String(value));
    if (value) group.list.removeAttribute('hidden');
    else group.list.setAttribute('hidden', '');
  }

  function syncExpandAll(): void {
    const label = groups.every((group) => expanded.has(group.source))
      ? 'Collapse all'
      : 'Expand all';
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
      const viewsCurrent = current === null && state.route.viewId !== null;
      const writable = canChangeFavorites(preferences);
      if (
        previous?.current === current &&
        previous.viewsCurrent === viewsCurrent &&
        previous.preferences === preferences.view &&
        previous.writable === writable &&
        previous.catalog === catalog
      )
        return;
      const routeChanged = previous?.current !== current;
      previous = { current, viewsCurrent, preferences: preferences.view, writable, catalog };

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
      // Reveal the current page's source unless Favorites already shows it.
      const route = state.route.scope;
      if (
        routeChanged &&
        route !== undefined &&
        !favorites.some((favorite) => scopeId({ kind: 'project', ...favorite }) === current)
      )
        expanded.add(route.source);
      const sourceTitle = (sourceId: string): string =>
        catalog?.sources.find((source) => source.id === sourceId)?.title ?? sourceId;

      function choose(scope: Scope): void {
        close();
        if (scopeId(scope) !== current) actions.selectScope(scope);
      }

      function projectRow(
        project: ProjectRef,
        section: 'favorites' | 'catalog',
        available = true,
      ): HTMLElement {
        const scope: Scope = { kind: 'project', ...project };
        const favorite = isFavorite(project);
        const key = (area: string, action: string): string =>
          JSON.stringify([area, action, project.source, project.repo]);
        const displaySource = sourceTitle(project.source);
        const name = `${displaySource} / ${project.repo}`;
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
                  current === scopeId(scope) && (section === 'favorites' || !favorite)
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
                ? h('span', { class: 'project-sidebar-source' }, displaySource)
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
                  if (favorite) expanded.add(project.source);
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

      if (catalog === null)
        nav.append(h('p', { class: 'project-sidebar-note' }, 'Projects have not loaded.'));
      groups = [];
      expandAll = null;
      if (catalog !== null && catalog.sources.length > 0) {
        expandAll = control(
          'expand-all',
          h('button', {
            class: 'link-btn project-sidebar-expand-all',
            type: 'button',
            onclick: () => {
              const value = !groups.every((group) => expanded.has(group.source));
              for (const group of groups) showGroup(group, value);
              syncExpandAll();
            },
          }),
        );
        nav.append(
          h('div', { class: 'project-sidebar-sources-bar' }, h('span', null, 'Sources'), expandAll),
        );
      }
      for (const [index, source] of (catalog?.sources ?? []).entries()) {
        const scope: Scope = { kind: 'source', source: source.id };
        const displaySource = source.title ?? source.id;
        const listId = `${id}-source-${index}`;
        const isOpen = expanded.has(source.id);
        const group = {
          source: source.id,
          button: control(
            JSON.stringify(['group', source.id]),
            h(
              'button',
              {
                class: 'project-sidebar-group',
                type: 'button',
                'aria-expanded': String(isOpen),
                'aria-controls': listId,
                onclick: () => {
                  showGroup(group, !expanded.has(source.id));
                  syncExpandAll();
                },
              },
              icon('chevron', 12),
              h('span', { class: 'project-sidebar-group-title' }, displaySource),
              h('span', { class: 'project-sidebar-count' }, String(source.projects.length)),
            ),
          ),
          list: h(
            'ul',
            { id: listId, class: 'project-sidebar-list', hidden: !isOpen },
            h(
              'li',
              { class: 'project-sidebar-row' },
              control(
                JSON.stringify(['source', source.id]),
                h(
                  'button',
                  {
                    class: 'project-sidebar-entry',
                    type: 'button',
                    'aria-label': `All projects from ${displaySource}`,
                    'aria-current': current === scopeId(scope) ? 'page' : null,
                    onclick: () => choose(scope),
                  },
                  h('span', { class: 'project-sidebar-repo' }, 'All projects'),
                ),
              ),
            ),
            ...source.projects.map((project) => projectRow(project, 'catalog')),
          ),
        };
        groups.push(group);
        nav.append(
          h(
            'section',
            { class: 'project-sidebar-section', 'aria-label': `Source ${displaySource}` },
            h('h2', { class: 'project-sidebar-heading' }, group.button),
            group.list,
          ),
        );
      }
      syncExpandAll();
      nav.append(
        control(
          'views',
          h(
            'button',
            {
              class: 'project-sidebar-entry project-sidebar-views',
              type: 'button',
              'aria-label': 'Views',
              'aria-current': viewsCurrent ? 'page' : null,
              onclick: () => {
                close();
                actions.openViews();
              },
            },
            icon('graph', 16),
            'Views',
          ),
        ),
      );

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
