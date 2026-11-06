import type {
  AvailablePreferences,
  PreferencesResponse,
  PreferencesUnavailableReason,
} from '../../src/core/preferences.js';
import type { ProjectRef } from '../../src/core/scope.js';

/** Network and DOM wiring consume effects; this module never performs IO or navigation. */
export type PreferenceMutation =
  | { kind: 'add-favorite'; project: ProjectRef }
  | { kind: 'remove-favorite'; project: ProjectRef }
  | { kind: 'remember-project'; project: ProjectRef };

export type PreferenceView =
  | { status: 'not-loaded' }
  | { status: 'available'; preferences: AvailablePreferences }
  | { status: 'unavailable'; reason: PreferencesUnavailableReason | 'read-failed'; message: string }
  | { status: 'unverified'; preferences: AvailablePreferences; message: string };

export interface PreferenceState {
  view: PreferenceView;
  /** Last authoritative response, never the optimistic display. */
  confirmed: AvailablePreferences | null;
  /** High-water mark survives unavailable responses, but not session clearing. */
  revisionFloor: number;
  active: { id: number; mutation: PreferenceMutation } | null;
  queue: PreferenceMutation[];
  reads: number[];
  nextId: number;
  rereadRequired: boolean;
  error: string | null;
  notice: string | null;
}

export type PreferenceEffect =
  { kind: 'read'; id: number } | { kind: 'save'; id: number; mutation: PreferenceMutation };

export type PreferenceEvent =
  | { type: 'open' | 'tab-return' | 'reload' }
  | { type: 'read-success'; id: number; response: PreferencesResponse }
  | { type: 'read-failure'; id: number; message: string }
  | { type: 'mutate'; mutation: PreferenceMutation }
  | { type: 'save-success'; id: number; response: PreferencesResponse }
  | { type: 'save-failure'; id: number; message: string }
  | { type: 'logout' | 'session-expired' };

export interface PreferenceTransition {
  state: PreferenceState;
  effects: PreferenceEffect[];
}

export function initialPreferenceState(): PreferenceState {
  return {
    view: { status: 'not-loaded' },
    confirmed: null,
    revisionFloor: -1,
    active: null,
    queue: [],
    reads: [],
    nextId: 1,
    rereadRequired: false,
    error: null,
    notice: null,
  };
}

function sameProject(a: ProjectRef, b: ProjectRef): boolean {
  return a.source === b.source && a.repo === b.repo;
}

/** An absent-catalog favorite is still removable. Adding requires catalog membership upstream. */
export function canChangeFavorites(state: PreferenceState): boolean {
  return state.view.status === 'available' && !state.rereadRequired;
}

function display(state: PreferenceState): PreferenceState {
  if (state.view.status !== 'available' || state.confirmed === null) return state;
  const preferences = structuredClone(state.confirmed);
  const mutations = state.rereadRequired
    ? []
    : [...(state.active ? [state.active.mutation] : []), ...state.queue];
  for (const mutation of mutations) {
    if (mutation.kind === 'add-favorite') {
      if (!preferences.favorites.some((f) => sameProject(f, mutation.project))) {
        preferences.favorites.push({ ...mutation.project, inCatalog: true });
      }
    } else if (mutation.kind === 'remove-favorite') {
      preferences.favorites = preferences.favorites.filter(
        (f) => !sameProject(f, mutation.project),
      );
    }
  }
  return { ...state, view: { status: 'available', preferences } };
}

function read(state: PreferenceState): PreferenceTransition {
  const id = state.nextId;
  return {
    state: { ...state, nextId: id + 1, reads: [...state.reads, id] },
    effects: [{ kind: 'read', id }],
  };
}

function startNext(state: PreferenceState): PreferenceTransition {
  if (state.active || !canChangeFavorites(state) || state.queue.length === 0) {
    return { state: display(state), effects: [] };
  }
  const mutation = state.queue[0]!;
  const id = state.nextId;
  return {
    state: display({
      ...state,
      nextId: id + 1,
      active: { id, mutation },
      queue: state.queue.slice(1),
    }),
    effects: [{ kind: 'save', id, mutation: structuredClone(mutation) }],
  };
}

function appendFeedback(previous: string | null, message: string): string {
  return previous ? previous + ' ' + message : message;
}

function discardQueued(state: PreferenceState): PreferenceState {
  const canceledFavorite = state.queue.some((mutation) => mutation.kind !== 'remember-project');
  const canceledRemember = state.queue.some((mutation) => mutation.kind === 'remember-project');
  return {
    ...state,
    queue: [],
    error: canceledFavorite
      ? appendFeedback(
          state.error,
          'Queued favorite changes were not saved because preferences became unavailable.',
        )
      : state.error,
    notice: canceledRemember
      ? appendFeedback(
          state.notice,
          'The queued project selection was not remembered because preferences became unavailable.',
        )
      : state.notice,
  };
}

function saveFailed(state: PreferenceState, message: string): PreferenceTransition {
  const remember = state.active?.mutation.kind === 'remember-project';
  // Drop unsent mutations too: a later recovery must never replay offline intent.
  return read(
    display(
      discardQueued({
        ...state,
        active: null,
        reads: [],
        rereadRequired: true,
        error: remember ? state.error : appendFeedback(state.error, message),
        notice: remember ? appendFeedback(state.notice, message) : state.notice,
      }),
    ),
  );
}

/** Pure state machine. Effect IDs survive logout so old-session results cannot restore private data. */
export function reducePreferences(
  state: PreferenceState,
  event: PreferenceEvent,
): PreferenceTransition {
  switch (event.type) {
    case 'logout':
    case 'session-expired':
      return { state: { ...initialPreferenceState(), nextId: state.nextId }, effects: [] };
    case 'open':
    case 'tab-return':
    case 'reload':
      return read(state);
    case 'mutate':
      if (!canChangeFavorites(state)) {
        return {
          state:
            event.mutation.kind === 'remember-project'
              ? {
                  ...state,
                  notice: 'Project was not remembered because preferences are not writable.',
                }
              : state,
          effects: [],
        };
      }
      return startNext({
        ...state,
        queue: [...state.queue, structuredClone(event.mutation)],
        error: event.mutation.kind === 'remember-project' ? state.error : null,
        notice: event.mutation.kind === 'remember-project' ? null : state.notice,
      });
    case 'save-failure':
      return state.active?.id === event.id
        ? saveFailed(state, event.message)
        : { state, effects: [] };
    case 'save-success': {
      if (state.active?.id !== event.id) return { state, effects: [] };
      if (!event.response.available) return saveFailed(state, event.response.message);
      if (event.response.revision < state.revisionFloor) {
        return startNext({ ...state, active: null });
      }
      const confirmed = structuredClone(event.response);
      return startNext({
        ...state,
        active: null,
        reads: [],
        rereadRequired: false,
        confirmed,
        revisionFloor: confirmed.revision,
        view: { status: 'available', preferences: confirmed },
      });
    }
    case 'read-failure': {
      if (!state.reads.includes(event.id)) return { state, effects: [] };
      // A newer completed read supersedes this one (its id will have removed older reads).
      const next = {
        ...discardQueued(state),
        reads: state.reads.filter((id) => id !== event.id),
        rereadRequired: true,
      };
      return {
        state: {
          ...next,
          view: state.confirmed
            ? {
                status: 'unverified',
                preferences: structuredClone(state.confirmed),
                message: event.message,
              }
            : { status: 'unavailable', reason: 'read-failed', message: event.message },
        },
        effects: [],
      };
    }
    case 'read-success': {
      if (!state.reads.includes(event.id)) return { state, effects: [] };
      const response = event.response;
      if (response.available && response.revision < state.revisionFloor) {
        return {
          state: { ...state, reads: state.reads.filter((id) => id !== event.id) },
          effects: [],
        };
      }
      const next = { ...state, reads: state.reads.filter((id) => id > event.id) };
      if (!response.available)
        return {
          state: {
            ...discardQueued(next),
            view: { status: 'unavailable', reason: response.reason, message: response.message },
            confirmed: null,
            rereadRequired: true,
          },
          effects: [],
        };
      const confirmed = structuredClone(response);
      return startNext({
        ...next,
        confirmed,
        revisionFloor: confirmed.revision,
        view: { status: 'available', preferences: confirmed },
        rereadRequired: false,
      });
    }
  }
}
