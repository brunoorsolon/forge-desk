import type { ProjectRef } from './scope.js';

/** Unknown versions are refused, never silently migrated or replaced. */
export const PREFERENCES_SCHEMA_VERSION = 1;

/** The one application account's durable profile. Contains no credentials or account name. */
export interface PreferenceProfile {
  version: typeof PREFERENCES_SCHEMA_VERSION;
  /** Non-negative integer, increased only after a durable committed change. */
  revision: number;
  /** Unique project references in the order added. */
  favorites: ProjectRef[];
  rememberedProject: ProjectRef | null;
}

export interface Favorite extends ProjectRef {
  /** Catalog membership, not provider availability. Unavailable favorites remain removable. */
  inCatalog: boolean;
}

export interface AvailablePreferences {
  available: true;
  revision: number;
  favorites: Favorite[];
  rememberedProject: ProjectRef | null;
}

export type PreferencesUnavailableReason =
  | 'login-disabled'
  | 'storage-not-configured'
  | 'storage-missing'
  | 'store-locked'
  | 'unreadable'
  | 'corrupt'
  | 'unsupported-version';

export interface UnavailablePreferences {
  available: false;
  reason: PreferencesUnavailableReason;
  message: string;
}

export type PreferencesResponse = AvailablePreferences | UnavailablePreferences;

export type PreferenceErrorCode =
  'not-in-catalog' | 'favorites-limit' | 'preferences-unavailable' | 'save-failed';
