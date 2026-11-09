import type {
  CatalogResponse,
  ProjectRef,
  RepositoryFreshness,
  SweepStatus,
} from '../../../src/core/scope.js';
import { append, clear, h, icon, setText } from '../dom.js';
import { absoluteTime, plural, relativeTime } from '../format.js';
import { canChangeFavorites, type PreferenceState } from '../preferenceState.js';
import { isActiveScopeJob, type AppState } from '../state.js';
import type { SweepRefreshState } from '../sweep-refresh.js';

export interface ScopeHeadingCallbacks {
  /** Rendering never changes preferences, the route, or the displayed issues. */
  toggleFavorite(project: ProjectRef, favorite: boolean): void;
  /** These controls stay hidden until the refresh wiring supplies callbacks. */
  refreshProject?(project: ProjectRef): void;
  refreshSource?(source: string): void;
  refreshAllSources?(): void;
}

type HeadingState = Pick<
  AppState,
  'route' | 'status' | 'snapshot' | 'freshness' | 'refreshError' | 'refreshingScope' | 'job'
>;

export interface ScopeHeading {
  el: HTMLElement;
  update(
    state: HeadingState,
    preferences: PreferenceState,
    sweepState?: SweepRefreshState | null,
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
    iso === null ? 'No successful check' : 'checked ',
    iso === null ? null : time(iso, now),
  );
}

// Failed attempts must never relabel last-good data or its check time as fresh.
function displayState(repository: RepositoryFreshness): RepositoryFreshness['state'] {
  return repository.state === 'failed' && repository.lastCheckedAt !== null
    ? 'stale'
    : repository.state;
}

const SEVERITY: RepositoryFreshness['state'][] = [
  'failed',
  'unavailable',
  'stale',
  'invalidated',
  'delayed',
  'updating',
  'fresh',
];

/** One line for the collapsed details: the scope's state counts, worst first. */
function freshnessSummary(repositories: RepositoryFreshness[]): {
  text: string;
  state: RepositoryFreshness['state'];
} {
  const counts = new Map<RepositoryFreshness['state'], number>();
  for (const repository of repositories) {
    const state = displayState(repository);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const worst = SEVERITY.filter((state) => counts.has(state));
  const parts = worst.map((state) => `${counts.get(state)} ${state}`);
  return {
    text:
      repositories.length === 0
        ? 'No repositories'
        : repositories.length === 1
          ? worst[0]![0]!.toUpperCase() + worst[0]!.slice(1)
          : `${plural(repositories.length, 'repository', 'repositories')}: ${parts.join(', ')}`,
    state: worst[0] ?? 'fresh',
  };
}

function repositoryRow(repository: RepositoryFreshness, now: number): HTMLElement {
  const retainedFailure = repository.state === 'failed' && repository.lastCheckedAt !== null;
  const state = displayState(repository);
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

interface RefreshError {
  key: string;
  message: string;
}

/** Only error identity matters: polling progress and completion do not reopen a banner. */
function sweepErrors(sweep: SweepStatus | null): RefreshError[] {
  if (sweep === null) return [];
  return sweep.sources.flatMap((source) => {
    const conflict = source.policyConflict;
    const failed = source.projects.filter((project) => project.state === 'failed');
    if (
      conflict === null &&
      source.error === null &&
      failed.length === 0 &&
      !['failed', 'partial', 'conflict'].includes(source.state)
    )
      return [];
    const details = conflict
      ? `Policy conflict: ${conflict.explanation} Differing settings: ${conflict.differingSettings.join(', ')}. Views: ${conflict.views.join(', ')}.`
      : failed.length > 0
        ? failed
            .map((project) => `${project.project.repo}: ${project.error ?? 'Refresh failed'}`)
            .join('; ')
        : (source.error ?? 'Refresh failed');
    return [
      {
        key: JSON.stringify(['sweep', sweep.id, source.source, details]),
        message: `All sources refresh (${source.source}): ${details}`,
      },
    ];
  });
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
  let errors: RefreshError[] = [];
  let dismissed = new Set<string>();
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
  const projectLabel = h('span', null, 'Refresh this project');
  const sourceLabel = h('span', null, 'Refresh this source');
  const allLabel = h('span', null, 'Refresh all sources');
  const refreshProject = h(
    'button',
    {
      class: 'menu-item',
      type: 'button',
      hidden: true,
      onclick: () => {
        refreshMenu.open = false;
        if (project !== null && !refreshProject.disabled)
          callbacks.refreshProject?.({ ...project });
      },
    },
    icon('refresh'),
    projectLabel,
  );
  const refreshSource = h(
    'button',
    {
      class: 'menu-item',
      type: 'button',
      hidden: true,
      onclick: () => {
        refreshMenu.open = false;
        if (source !== null && !refreshSource.disabled) callbacks.refreshSource?.(source);
      },
    },
    icon('refresh'),
    sourceLabel,
  );
  const refreshAll = h(
    'button',
    {
      class: 'menu-item',
      type: 'button',
      hidden: true,
      onclick: () => {
        refreshMenu.open = false;
        if (source !== null && !refreshAll.disabled) callbacks.refreshAllSources?.();
      },
    },
    icon('refresh'),
    allLabel,
  );
  // Refresh is occasional, so its three scopes share one menu instead of three buttons.
  const refreshMenuLabel = h('span', null, 'Refresh');
  const refreshTrigger = h(
    'summary',
    { class: 'btn scope-refresh-trigger' },
    icon('refresh'),
    refreshMenuLabel,
    icon('chevron', 12),
  );
  const refreshMenu = h(
    'details',
    { class: 'menu-wrap scope-refresh-menu' },
    refreshTrigger,
    h('div', { class: 'menu scope-refresh-controls' }, refreshProject, refreshSource, refreshAll),
  );
  refreshMenu.addEventListener('focusout', (event) => {
    if (!refreshMenu.contains((event as FocusEvent).relatedTarget as Node | null))
      refreshMenu.open = false;
  });
  refreshMenu.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape' || !refreshMenu.open) return;
    event.stopPropagation();
    refreshMenu.open = false;
    refreshTrigger.focus();
  });
  const freshness = h('div', { class: 'scope-freshness' });
  // Collapsed by default so the plan keeps the screen; errors stay in the banner above.
  const summary = h('summary', { class: 'scope-freshness-summary' });
  const details = h('details', { class: 'scope-details' }, summary, freshness);
  const errorMessage = h('p', { class: 'scope-refresh-error-message' });
  const errorBanner = h(
    'div',
    { class: 'scope-refresh-error', role: 'alert', hidden: true },
    errorMessage,
    h(
      'button',
      {
        class: 'btn btn-ghost scope-refresh-error-close',
        type: 'button',
        'aria-label': 'Dismiss refresh error',
        onclick: () => {
          dismissed = new Set(errors.map((error) => error.key));
          errorBanner.hidden = true;
        },
      },
      '×',
    ),
  );
  const el = h(
    'section',
    { class: 'scope-heading', 'aria-label': 'Scope heading', hidden: true },
    h(
      'div',
      { class: 'scope-heading-top' },
      h('div', { class: 'scope-identity' }, sourceName, title, star),
      refreshMenu,
    ),
    preferenceNotice,
    errorBanner,
    details,
  );

  return {
    el,
    update(state, preferences, sweepState = null, catalog = null) {
      const sweep = sweepState?.sweep ?? null;
      const scope = state.route.scope;
      errors = sweepErrors(sweep);
      if (state.refreshError !== null)
        errors.unshift({
          key: JSON.stringify(['refresh', scope, state.refreshError]),
          message: `Refresh error: ${state.refreshError}`,
        });
      if (state.job?.trigger === 'interactive' && state.job.error !== null)
        errors.push({
          key: JSON.stringify(['job', state.job.id, state.job.error]),
          message: `Refresh error: ${state.job.error}`,
        });
      if (sweepState?.error != null)
        errors.push({
          key: JSON.stringify(['sweep-request', sweepState.error]),
          message: `All sources refresh: ${sweepState.error}`,
        });
      // Retain only currently reported dismissals. Clearing an error for a new
      // request lets a later failure reappear even when its wording is identical.
      dismissed = new Set(
        errors.filter((error) => dismissed.has(error.key)).map((error) => error.key),
      );
      errorBanner.hidden = errors.every((error) => dismissed.has(error.key));
      setText(errorMessage, errors.map((error) => error.message).join(' · '));
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
      const activeJob = isActiveScopeJob(state.job) ? state.job : null;
      refreshProject.disabled =
        state.refreshingScope === 'project' || activeJob?.scope.kind === 'project';
      refreshSource.disabled =
        state.refreshingScope === 'source' || activeJob?.scope.kind === 'source';
      refreshAll.disabled =
        sweepState?.launching === true || sweep?.state === 'queued' || sweep?.state === 'running';
      projectLabel.textContent = refreshProject.disabled
        ? 'Refreshing project…'
        : 'Refresh this project';
      sourceLabel.textContent = refreshSource.disabled
        ? 'Refreshing source…'
        : 'Refresh this source';
      allLabel.textContent = refreshAll.disabled
        ? 'Refreshing all sources…'
        : 'Refresh all sources';
      const busy = [refreshProject, refreshSource, refreshAll].some(
        (button) => !button.hidden && button.disabled,
      );
      refreshMenu.hidden = [refreshProject, refreshSource, refreshAll].every(
        (button) => button.hidden,
      );
      refreshTrigger.classList.toggle('busy', busy);
      refreshMenuLabel.textContent = busy ? 'Refreshing…' : 'Refresh';

      const now = Date.now();
      clear(freshness);
      const info = state.freshness;
      clear(summary);
      if (info === null) {
        summary.setAttribute('data-state', 'unavailable');
        append(summary, ['Freshness is not available yet.']);
      } else {
        const overview = freshnessSummary(info.repositories);
        summary.setAttribute('data-state', overview.state);
        // The snapshot's fetch time is its oldest contributing repository check.
        append(summary, [
          h('span', { class: 'scope-status' }, overview.text),
          ' · ',
          h(
            'span',
            { class: 'scope-fetch-time' },
            state.snapshot === null ? 'no data fetched' : 'checked ',
            state.snapshot === null ? null : time(state.snapshot.fetchedAt, now),
          ),
          icon('chevron', 12),
        ]);
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
              `${plural(info.outsideIssues.count, 'outside issue')}, ${info.outsideIssues.provisionalCount} provisional`,
              info.outsideIssues.oldestObservedAt === null ? null : ', oldest observed ',
              info.outsideIssues.oldestObservedAt === null
                ? null
                : time(info.outsideIssues.oldestObservedAt, now),
            ),
            h(
              'p',
              { class: 'scope-computed-time' },
              info.computedAt === null ? 'Plan not computed' : 'Plan computed ',
              info.computedAt === null ? null : time(info.computedAt, now),
            ),
          ),
        );
      }
    },
  };
}
