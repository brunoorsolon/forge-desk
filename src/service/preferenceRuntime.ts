import type { AppConfig } from '../config/schema.js';
import type { PreferenceProfile, UnavailablePreferences } from '../core/preferences.js';
import type { ProjectRef } from '../core/scope.js';
import { acquirePreferenceLock, type PreferenceLock } from './preferenceLock.js';
import { PreferenceStore, PreferenceStoreError } from './preferenceStore.js';

export function unavailablePreferences(
  reason: UnavailablePreferences['reason'],
): UnavailablePreferences {
  const messages: Record<UnavailablePreferences['reason'], string> = {
    'login-disabled': 'Personal preferences require the application login.',
    'storage-not-configured': 'Preference storage is not configured.',
    'storage-missing': 'The preference directory does not exist.',
    'store-locked': 'Preference storage is owned by another process or ownership was lost.',
    unreadable: 'Preference storage cannot be safely read or written. Repair storage and restart.',
    corrupt: 'The preference file is corrupt. Repair storage and restart.',
    'unsupported-version': 'The preference file version is unsupported.',
  };
  return { available: false, reason, message: messages[reason] };
}

type Status = ReturnType<PreferenceStore['read']>;
export type PreferenceOperation = 'addFavorite' | 'removeFavorite' | 'rememberProject';

/** Own the store and its lock together, including admission, queued writes and shutdown. */
export class PreferenceRuntime {
  private accepting = true;
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(
    private readonly storage:
      { store: PreferenceStore; lock: PreferenceLock } | UnavailablePreferences,
  ) {}

  read(): Status {
    if ('available' in this.storage) return { ...this.storage };
    if (!this.accepting || !this.storage.lock.held) return unavailablePreferences('store-locked');
    const state = this.storage.store.read();
    return state.available ? state : unavailablePreferences(state.reason);
  }

  mutate(operation: PreferenceOperation, ref: ProjectRef): Promise<PreferenceProfile> {
    const input = structuredClone(ref);
    // Admission stops immediately on shutdown; already admitted operations drain before unlock.
    if (!this.accepting) return Promise.reject(this.unavailable('store-locked'));
    const pending = this.tail.then(async () => {
      if ('available' in this.storage) throw this.unavailable(this.storage.reason);
      if (!this.storage.lock.held) throw this.unavailable('store-locked');
      return this.storage.store[operation](input);
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  close(): Promise<void> {
    this.accepting = false;
    this.closing ??= this.tail.then(async () => {
      if (!('available' in this.storage)) await this.storage.lock.release();
    });
    return this.closing;
  }

  private unavailable(reason: UnavailablePreferences['reason']): PreferenceStoreError {
    return new PreferenceStoreError(
      'preferences-unavailable',
      unavailablePreferences(reason).message,
      reason,
    );
  }
}

/** No directory creation, lock claim, or stored-data read without both explicit opt-ins. */
export async function openPreferenceRuntime(config: AppConfig): Promise<PreferenceRuntime> {
  if (config.server.basicAuth === null)
    return new PreferenceRuntime(unavailablePreferences('login-disabled'));
  if (config.preferences.dir === null)
    return new PreferenceRuntime(unavailablePreferences('storage-not-configured'));
  const ownership = await acquirePreferenceLock({ directory: config.preferences.dir });
  if (!ownership.available) {
    const reason =
      ownership.reason === 'store-locked' || ownership.reason === 'storage-missing'
        ? ownership.reason
        : 'unreadable';
    return new PreferenceRuntime(unavailablePreferences(reason));
  }
  try {
    const store = new PreferenceStore({ directory: config.preferences.dir });
    return new PreferenceRuntime({ store, lock: ownership.lock });
  } catch {
    await ownership.lock.release();
    return new PreferenceRuntime(unavailablePreferences('unreadable'));
  }
}
