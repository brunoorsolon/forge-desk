import type {
  CatalogResponse,
  ProjectRef,
  RepositoryFreshness,
  SweepStatus,
} from '../../../src/core/scope.js';
import { clear, h, icon } from '../dom.js';
import { absoluteTime, plural, relativeTime } from '../format.js';
import { canChangeFavorites, type PreferenceState } from '../preferenceState.js';
import type { AppState } from '../state.js';

export interface ScopeHeadingCallbacks {
  /** Rendering never changes preferences, the route, or the displayed issues. */
  toggleFavorite(project: ProjectRef, favorite: boolean): void;
  /** These controls stay hidden until the refresh wiring supplies callbacks. */
  refreshProject?(project: ProjectRef): void;
  refreshSource?(source: string): void;
  refreshAllSources?(): void;
}

type HeadingState = Pick<AppState, 'route' | 'status' | 'snapshot' | 'freshness' | 'refreshError'>;

export interface ScopeHeading {
  el: HTMLElement;
  update(
    state: HeadingState,
    preferences: PreferenceState,
    sweep?: SweepStatus | null,
    catalog?: CatalogResponse | null,
  ): void;
}

/** Upstream check times and computation times deliberately have separate labels. */
function time(iso: string, now: number, future = false): HTMLElement {
  return h(
    'time',
    { datetime: iso, title: absoluteTime(iso) },
    future ? absoluteTime(iso) : relativeTime(iso, now),
  );
}

function checkedAt(iso: string | null, now: number): HTMLElement {
  return h(
    'span',
    { class: 'scope-check-time' },
    iso === null ? 'No successful check' : 'Last successful check: ',
    iso === null ? null : time(iso, now),
  );
}

function repositoryRow(repository: RepositoryFreshness, now: number): HTMLElement {
  // Failed attempts must never relabel last-good data or its check time as fresh.
  const retainedFailure = repository.state === 'failed' && repository.lastCheckedAt !== null;
  const state = retainedFailure ? 'stale' : repository.state;
  return h(
    'li',
    { class: 'scope-repository', 'data-state': state },
    h('strong', { class: 'scope-repository-name' }, repository.project.repo),
    h(
      'span',
      { class: 'scope-status' },
      retainedFailure ? 'Stale (refresh failed)' : state[0]!.toUpperCase() + state.slice(1),
    ),
    repository.partial ? h('span', { class: 'scope-status' }, 'Partial coverage') : null,
    checkedAt(repository.lastCheckedAt, now),
    repository.state === 'delayed'
      ? h(
          'span',
          { class: 'scope-delay' },
          'Expected to resume: ',
          repository.delayedUntil === null ? 'unknown' : time(repository.delayedUntil, now, true),
        )
      : null,
    repository.error === null
      ? null
      : h('span', { class: 'scope-error' }, `Refresh error: ${repository.error}`),
  );
}

function sweepProgress(sweep: SweepStatus, now: number): HTMLElement {
  const projects = sweep.sources.flatMap((source) => source.projects);
  const counts = (['checked', 'checking', 'queued', 'failed'] as const)
    .map((state) => `${projects.filter((project) => project.state === state).length} ${state}`)
    .join(' · ');
  return h(
    'section',
    { class: 'scope-sweep', 'aria-label': 'All sources refresh progress' },
    h('h3', null, 'All sources refresh'),
    h(
      'p',
      { class: 'scope-sweep-summary' },
      `${sweep.state[0]!.toUpperCase()}${sweep.state.slice(1)} · Started: `,
      time(sweep.startedAt, now),
      sweep.finishedAt === null
        ? null
        : h('span', null, ' · Finished: ', time(sweep.finishedAt, now)),
      ` · ${counts}`,
    ),
    ...sweep.sources.map((source) =>
      h(
        'section',
        { class: 'scope-sweep-source', 'aria-label': `Source ${source.source}` },
        h('h4', null, source.source, h('span', { class: 'scope-status' }, source.state)),
        source.policyConflict === null
          ? null
          : h(
              'div',
              { class: 'scope-error' },
              h('p', null, `Policy conflict: ${source.policyConflict.explanation}`),
              h(
                'p',
                null,
                `Differing settings: ${source.policyConflict.differingSettings.join(', ')}`,
              ),
              h('p', null, `Views: ${source.policyConflict.views.join(', ')}`),
            ),
        source.error === null ? null : h('p', { class: 'scope-error' }, source.error),
        source.delayedUntil === null
          ? null
          : h('p', null, 'Expected to resume: ', time(source.delayedUntil, now, true)),
        h(
          'ul',
          { class: 'scope-repositories' },
          ...source.projects.map((project) =>
            h(
              'li',
              { class: 'scope-repository', 'data-state': project.state },
              h('strong', { class: 'scope-repository-name' }, project.project.repo),
              h('span', { class: 'scope-status' }, project.state),
              checkedAt(project.lastCheckedAt, now),
              project.error === null ? null : h('span', { class: 'scope-error' }, project.error),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Standalone scope view. Navigation, preference persistence and refresh requests
 * are supplied by their wiring layers; no named-view controls or timers live here.
 */
export function createScopeHeading(callbacks: ScopeHeadingCallbacks): ScopeHeading {
  let project: ProjectRef | null = null;
  let source: string | null = null;
  let favorite = false;
  let canToggle = false;
  const sourceName = h('span', { class: 'scope-source' });
  const title = h('h1', { class: 'scope-title' });
  const starGlyph = h('span', { 'aria-hidden': 'true' }, '☆');
  const star = h(
    'button',
    {
      class: 'btn btn-ghost scope-star',
      type: 'button',
      'aria-label': 'Add project to favorites',
      'aria-pressed': 'false',
      'aria-disabled': 'true',
      onclick: () => {
        if (project !== null && canToggle) callbacks.toggleFavorite({ ...project }, !favorite);
      },
    },
    starGlyph,
  );
  const preferenceNotice = h('span', { class: 'scope-preference-notice' });
  const refreshProject = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      hidden: true,
      onclick: () => {
        if (project !== null) callbacks.refreshProject?.({ ...project });
      },
    },
    icon('refresh'),
    'Refresh this project',
  );
  const refreshSource = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      hidden: true,
      onclick: () => {
        if (source !== null) callbacks.refreshSource?.(source);
      },
    },
    icon('refresh'),
    'Refresh this source',
  );
  const refreshAll = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      hidden: true,
      onclick: () => {
        if (source !== null) callbacks.refreshAllSources?.();
      },
    },
    icon('refresh'),
    'Refresh all sources',
  );
  const freshness = h('div', { class: 'scope-freshness' });
  const progress = h('div', { class: 'scope-progress', hidden: true });
  const el = h(
    'section',
    { class: 'scope-heading', 'aria-label': 'Scope heading', hidden: true },
    h(
      'div',
      { class: 'scope-heading-top' },
      h('div', { class: 'scope-identity' }, sourceName, title, star),
      h('div', { class: 'scope-refresh-controls' }, refreshProject, refreshSource, refreshAll),
    ),
    preferenceNotice,
    freshness,
    progress,
  );

  return {
    el,
    update(state, preferences, sweep = null, catalog = null) {
      const scope = state.route.scope;
      source = scope?.source ?? null;
      project =
        scope?.kind === 'project'
          ? { source: scope.source, repo: `${scope.owner}/${scope.repo}`.toLowerCase() }
          : null;
      el.hidden = scope === undefined;
      if (scope === undefined) return;
      const sourceTitle =
        catalog?.sources.find((entry) => entry.id === scope.source)?.title ?? scope.source;
      sourceName.textContent = `Source: ${sourceTitle}`;
      title.textContent = project?.repo ?? 'All projects';

      const preferenceView = preferences.view;
      favorite =
        project !== null &&
        (preferenceView.status === 'available' || preferenceView.status === 'unverified') &&
        preferenceView.preferences.favorites.some(
          (f) => f.source === project!.source && f.repo === project!.repo,
        );
      canToggle =
        canChangeFavorites(preferences) && (state.status !== 'not-in-catalog' || favorite);
      star.hidden = project === null;
      star.setAttribute('aria-pressed', String(favorite));
      star.setAttribute('aria-disabled', String(!canToggle));
      star.setAttribute(
        'aria-label',
        `${favorite ? 'Remove' : 'Add'} ${scope.source}/${project?.repo ?? ''} ${favorite ? 'from' : 'to'} favorites`,
      );
      starGlyph.textContent = favorite ? '★' : '☆';
      star.classList.toggle('active', favorite);
      let notice = '';
      if (preferenceView.status === 'not-loaded') notice = 'Personal preferences are not loaded.';
      else if (preferenceView.status === 'unavailable')
        notice = `Personal preferences are unavailable: ${preferenceView.message}`;
      else if (preferenceView.status === 'unverified')
        notice = `Favorites are unverified and read-only: ${preferenceView.message}`;
      else if (preferences.rereadRequired)
        notice = 'Favorites are read-only until preferences are rechecked.';
      else if (!canToggle) notice = 'This project is not in the catalog.';
      star.title = notice || (favorite ? 'Remove from favorites' : 'Add to favorites');
      preferenceNotice.textContent = notice;
      preferenceNotice.hidden = project === null || notice === '';

      refreshProject.hidden = project === null || callbacks.refreshProject === undefined;
      refreshSource.hidden = callbacks.refreshSource === undefined;
      refreshAll.hidden = callbacks.refreshAllSources === undefined;

      const now = Date.now();
      clear(freshness);
      if (state.refreshError !== null) {
        freshness.append(
          h('p', { class: 'scope-error', role: 'alert' }, `Refresh error: ${state.refreshError}`),
        );
      }
      const info = state.freshness;
      if (info === null) {
        freshness.append(h('p', { class: 'muted' }, 'Freshness is not available yet.'));
      } else {
        freshness.append(
          h(
            'ul',
            { class: 'scope-repositories', 'aria-label': 'Repository freshness' },
            ...info.repositories.map((repository) => repositoryRow(repository, now)),
          ),
          h(
            'div',
            { class: 'scope-observations' },
            h(
              'p',
              { class: 'scope-outside-issues' },
              `${plural(info.outsideIssues.count, 'outside issue')} · Oldest observation: `,
              info.outsideIssues.oldestObservedAt === null
                ? 'none'
                : time(info.outsideIssues.oldestObservedAt, now),
              ` · ${info.outsideIssues.provisionalCount} provisional`,
            ),
            h(
              'p',
              { class: 'scope-fetch-time' },
              'Data fetched: ',
              state.snapshot === null ? 'unavailable' : time(state.snapshot.fetchedAt, now),
              ' (oldest contributing repository check)',
            ),
            h(
              'p',
              { class: 'scope-computed-time' },
              'Plan computed: ',
              info.computedAt === null ? 'not computed' : time(info.computedAt, now),
            ),
          ),
        );
      }
      clear(progress);
      progress.hidden = sweep === null;
      if (sweep !== null) progress.append(sweepProgress(sweep, now));
    },
  };
}
