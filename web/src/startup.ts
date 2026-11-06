import type { PreferencesResponse, UnavailablePreferences } from '../../src/core/preferences.js';
import type {
  CatalogResponse,
  ProjectRef,
  Scope,
  SourcePolicyConflict,
} from '../../src/core/scope.js';
import type { ViewSummary } from './api.js';
import { parseReleaseHash, type ReleaseRoute } from './release-route.js';
import { parseHash, type Route } from './route.js';
import { effectiveViewId } from './state.js';

/** A failed HTTP read is not an empty preference profile. */
export interface FailedPreferenceRead {
  available: false;
  reason: 'read-failed';
  message: string;
}

export type StartupPreferences = PreferencesResponse | FailedPreferenceRead;

interface StartupStatus {
  /** Retained on every result so a later sidebar can explain unavailable preferences. */
  preferencesUnavailable: UnavailablePreferences | FailedPreferenceRead | null;
  /** Results never prevent choosing another catalog project manually. */
  sidebarAvailable: true;
}

export type StartupResolution = StartupStatus &
  (
    | { kind: 'scope'; scope: Scope; route: Route; rememberProject: boolean }
    | {
        kind: 'policy-conflict';
        scope: Scope;
        conflict: SourcePolicyConflict;
        rememberProject: false;
      }
    | { kind: 'not-in-catalog'; scope: Scope; rememberProject: false }
    | {
        kind: 'preference-error';
        error: UnavailablePreferences | FailedPreferenceRead;
        rememberProject: false;
      }
    | { kind: 'empty-catalog'; rememberProject: false }
    | { kind: 'view'; route: Route; viewId: string | null; rememberProject: false }
    | { kind: 'releases'; route: ReleaseRoute; rememberProject: false }
  );

export interface StartupInput {
  hash: string;
  /** Source ordering is configuration ordering, not alphabetical ordering. */
  catalog: CatalogResponse;
  preferences: StartupPreferences;
  views: ViewSummary[];
}

/**
 * Pure startup decision, with no reads, writes, navigation or issue-count filtering.
 * Rendering and app wiring are deliberately separate. Existing view and release
 * selection retain their original parser/selection semantics.
 */
export function resolveStartup({
  hash,
  catalog,
  preferences,
  views,
}: StartupInput): StartupResolution {
  const status: StartupStatus = {
    preferencesUnavailable: preferences.available ? null : preferences,
    sidebarAvailable: true,
  };
  const release = parseReleaseHash(hash);
  if (release !== null) {
    return { ...status, kind: 'releases', route: release, rememberProject: false };
  }
  const route = parseHash(hash);
  if (route.scope === undefined && route.viewId !== null) {
    return {
      ...status,
      kind: 'view',
      route,
      viewId: effectiveViewId({ views, route }),
      rememberProject: false,
    };
  }

  const inCatalog = (project: ProjectRef): boolean =>
    catalog.sources.some(
      (source) =>
        source.id === project.source &&
        source.projects.some((entry) => entry.repo === project.repo),
    );

  const resolveScope = (scope: Scope, explicit: boolean): StartupResolution => {
    const source = catalog.sources.find((entry) => entry.id === scope.source);
    if (source === undefined || (scope.kind === 'project' && !inCatalog(scope))) {
      return { ...status, kind: 'not-in-catalog', scope, rememberProject: false };
    }
    if (source.policy.status === 'conflict') {
      return {
        ...status,
        kind: 'policy-conflict',
        scope,
        conflict: source.policy.conflict,
        rememberProject: false,
      };
    }
    const routeScope =
      scope.kind === 'source'
        ? scope
        : {
            kind: 'project' as const,
            source: scope.source,
            owner: scope.repo.slice(0, scope.repo.indexOf('/')),
            repo: scope.repo.slice(scope.repo.indexOf('/') + 1),
          };
    return {
      ...status,
      kind: 'scope',
      scope,
      route: { ...route, viewId: null, scope: routeScope },
      rememberProject: explicit && scope.kind === 'project',
    };
  };

  if (route.scope !== undefined) {
    const scope: Scope =
      route.scope.kind === 'source'
        ? route.scope
        : {
            kind: 'project',
            source: route.scope.source,
            repo: `${route.scope.owner}/${route.scope.repo}`,
          };
    return resolveScope(scope, true);
  }

  if (preferences.available) {
    if (preferences.rememberedProject !== null && inCatalog(preferences.rememberedProject)) {
      return resolveScope({ kind: 'project', ...preferences.rememberedProject }, false);
    }
    // Check today's catalog too: a preference read may predate a catalog reload.
    const favorite = preferences.favorites.find(inCatalog);
    if (favorite !== undefined) {
      return resolveScope({ kind: 'project', source: favorite.source, repo: favorite.repo }, false);
    }
  } else if (
    preferences.reason !== 'login-disabled' &&
    preferences.reason !== 'storage-not-configured'
  ) {
    return { ...status, kind: 'preference-error', error: preferences, rememberProject: false };
  }

  const source = catalog.sources.find((entry) => entry.projects.length > 0);
  return source === undefined
    ? { ...status, kind: 'empty-catalog', rememberProject: false }
    : resolveScope({ kind: 'source', source: source.id }, false);
}
