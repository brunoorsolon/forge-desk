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
        const name = `${project.source} / ${project.repo}`;
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
                'aria-current': current === scopeId(scope) ? 'page' : null,
                'aria-disabled': !available ? 'true' : null,
                title: available ? name : `${name} is no longer in the catalog`,
                onclick: () => {
                  if (available) choose(scope);
                },
              },
              h('span', { class: 'project-sidebar-repo' }, project.repo),
              h('span', { class: 'project-sidebar-source' }, project.source),
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
                  if (writable) actions.toggleFavorite({ ...project }, !favorite);
                },
              },
              h('span', { 'aria-hidden': 'true' }, favorite ? '★' : '☆'),
            ),
            key('catalog', 'star'),
          ),
        );
      }

      const favoriteSection = h(
        'section',
        { class: 'project-sidebar-section', 'aria-label': 'Favorites' },
        h('h2', null, 'Favorites'),
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
      for (const source of catalog?.sources ?? []) {
        const scope: Scope = { kind: 'source', source: source.id };
        nav.append(
          h(
            'section',
            { class: 'project-sidebar-section', 'aria-label': `Source ${source.id}` },
            h('h2', null, source.id),
            h(
              'ul',
              { class: 'project-sidebar-list' },
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
                      'aria-label': `All projects from ${source.id}`,
                      'aria-current': current === scopeId(scope) ? 'page' : null,
                      onclick: () => choose(scope),
                    },
                    h('span', { class: 'project-sidebar-repo' }, 'All projects'),
                    h('span', { class: 'project-sidebar-source' }, source.id),
                  ),
                ),
              ),
              ...source.projects.map((project) => projectRow(project, 'catalog')),
            ),
          ),
        );
      }
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
