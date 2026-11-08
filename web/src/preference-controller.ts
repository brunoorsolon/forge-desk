import type { PreferencesResponse } from '../../src/core/preferences.js';
import type { ProjectRef } from '../../src/core/scope.js';
import { errorMessage, fetchPreferences, onSessionExpired, savePreference } from './api.js';
import {
  initialPreferenceState,
  reducePreferences,
  type PreferenceEffect,
  type PreferenceEvent,
  type PreferenceMutation,
} from './preferenceState.js';
import type { StartupPreferences } from './startup.js';

interface PreferenceIO {
  read(signal: AbortSignal): Promise<PreferencesResponse>;
  save(mutation: PreferenceMutation, signal: AbortSignal): Promise<PreferencesResponse>;
  onExpired(listener: () => void): () => void;
}

/** Execute the reducer's serialized effects, never navigation or offline replay. */
export function createPreferenceController(
  changed: (event: PreferenceEvent) => void,
  io: PreferenceIO = { read: fetchPreferences, save: savePreference, onExpired: onSessionExpired },
) {
  let state = initialPreferenceState();
  let ended = false;
  let firstReadPending = true;
  let pendingSelection: ProjectRef | null = null;
  const requests = new Map<number, AbortController>();

  function dispatch(event: PreferenceEvent): void {
    if (ended) return;
    const result = reducePreferences(state, event);
    state = result.state;
    changed(event);
    for (const effect of result.effects) void run(effect);
  }

  async function run(effect: PreferenceEffect): Promise<void> {
    if (ended) return;
    const request = new AbortController();
    requests.set(effect.id, request);
    try {
      const response = await (effect.kind === 'read'
        ? io.read(request.signal)
        : io.save(effect.mutation, request.signal));
      if (!ended) {
        if (effect.kind === 'read') firstReadPending = false;
        dispatch({
          type: effect.kind === 'read' ? 'read-success' : 'save-success',
          id: effect.id,
          response,
        });
      }
    } catch (error) {
      if (!ended) {
        if (effect.kind === 'read') firstReadPending = false;
        dispatch({
          type: effect.kind === 'read' ? 'read-failure' : 'save-failure',
          id: effect.id,
          message: errorMessage(error),
        });
      }
    } finally {
      requests.delete(effect.id);
    }
    if (!ended && !firstReadPending && pendingSelection !== null) {
      const project = pendingSelection;
      pendingSelection = null;
      dispatch({ type: 'mutate', mutation: { kind: 'remember-project', project } });
    }
  }

  function endSession(type: 'logout' | 'session-expired' = 'logout'): void {
    if (ended) return;
    ended = true;
    pendingSelection = null;
    for (const request of requests.values()) request.abort();
    requests.clear();
    state = reducePreferences(state, { type }).state;
    changed({ type });
  }
  const unsubscribe = io.onExpired(() => endSession('session-expired'));

  return {
    get: () => state,
    startup(): StartupPreferences | null {
      const view = state.view;
      if (view.status === 'not-loaded') return null;
      if (view.status === 'available' || view.status === 'unverified') return view.preferences;
      return { available: false, reason: view.reason, message: view.message };
    },
    load: (type: 'open' | 'tab-return' | 'reload') => dispatch({ type }),
    toggleFavorite(project: ProjectRef, favorite: boolean): void {
      dispatch({
        type: 'mutate',
        mutation: { kind: favorite ? 'add-favorite' : 'remove-favorite', project },
      });
    },
    /** Only explicit destination changes call this. null cancels an initial deferred selection. */
    selectProject(project: ProjectRef | null): void {
      pendingSelection = null;
      if (ended || project === null) return;
      if (firstReadPending) pendingSelection = { ...project };
      else dispatch({ type: 'mutate', mutation: { kind: 'remember-project', project } });
    },
    endSession,
    dispose(): void {
      endSession();
      unsubscribe();
    },
  };
}
