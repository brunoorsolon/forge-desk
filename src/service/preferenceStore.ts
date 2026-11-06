import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  PreferenceErrorCode,
  PreferenceProfile,
  UnavailablePreferences,
} from '../core/preferences.js';
import type { ProjectRef } from '../core/scope.js';

export interface PreferenceStoreOptions {
  directory: string;
  /** Failure-injection seams. The caller must hold the lifetime single-writer lock. */
  fsync?: (fd: number) => void;
  rename?: (from: string, to: string) => void;
}
export class PreferenceStoreError extends Error {
  constructor(
    readonly code: PreferenceErrorCode,
    message: string,
    readonly reason?: UnavailablePreferences['reason'],
  ) {
    super(message);
    this.name = 'PreferenceStoreError';
  }
}
type Status = { available: true; profile: PreferenceProfile } | UnavailablePreferences;
const empty = (): PreferenceProfile => ({
  version: 1,
  revision: 0,
  favorites: [],
  rememberedProject: null,
});
const same = (a: ProjectRef, b: ProjectRef): boolean => a.source === b.source && a.repo === b.repo;
function project(value: unknown): value is ProjectRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 2 &&
    typeof v.source === 'string' &&
    v.source.length > 0 &&
    typeof v.repo === 'string' &&
    /^[^/\s]+\/[^/\s]+$/.test(v.repo)
  );
}
function profile(value: unknown): value is PreferenceProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 4 &&
    v.version === 1 &&
    Number.isSafeInteger(v.revision) &&
    (v.revision as number) >= 0 &&
    Array.isArray(v.favorites) &&
    v.favorites.length <= 200 &&
    v.favorites.every(project) &&
    v.favorites.every((p, i, all) => all.findIndex((q) => same(p, q)) === i) &&
    (v.rememberedProject === null || project(v.rememberedProject))
  );
}
function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** One startup read; callers supply a locked directory. No configuration, catalog or HTTP policy. */
export class PreferenceStore {
  private state: Status;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly sync: (fd: number) => void;
  private readonly rename: (from: string, to: string) => void;
  constructor(private readonly options: PreferenceStoreOptions) {
    this.path = join(options.directory, 'preferences.json');
    this.sync = options.fsync ?? fsyncSync;
    this.rename = options.rename ?? renameSync;
    this.state = this.load();
  }
  read(): Status {
    return structuredClone(this.state);
  }
  addFavorite(ref: ProjectRef): Promise<PreferenceProfile> {
    const input = structuredClone(ref);
    return this.mutate((p) => {
      this.assertProject(input);
      if (p.favorites.some((f) => same(f, input))) return false;
      if (p.favorites.length === 200)
        throw new PreferenceStoreError('favorites-limit', 'At most 200 favorites are allowed.');
      p.favorites.push(input);
      return true;
    });
  }
  removeFavorite(ref: ProjectRef): Promise<PreferenceProfile> {
    const input = structuredClone(ref);
    return this.mutate((p) => {
      this.assertProject(input);
      const index = p.favorites.findIndex((f) => same(f, input));
      if (index < 0) return false;
      p.favorites.splice(index, 1);
      return true;
    });
  }
  rememberProject(ref: ProjectRef): Promise<PreferenceProfile> {
    const input = structuredClone(ref);
    return this.mutate((p) => {
      this.assertProject(input);
      if (p.rememberedProject && same(p.rememberedProject, input)) return false;
      p.rememberedProject = input;
      return true;
    });
  }
  private assertProject(ref: unknown): asserts ref is ProjectRef {
    if (!project(ref)) throw new PreferenceStoreError('save-failed', 'Invalid project reference.');
  }
  private mutate(change: (p: PreferenceProfile) => boolean): Promise<PreferenceProfile> {
    const operation = this.tail.then(() => {
      if (!this.state.available)
        throw new PreferenceStoreError(
          'preferences-unavailable',
          this.state.message,
          this.state.reason,
        );
      const next = structuredClone(this.state.profile);
      if (!change(next)) return next;
      if (next.revision === Number.MAX_SAFE_INTEGER)
        throw new PreferenceStoreError('save-failed', 'Preference revision exhausted.');
      next.revision++;
      this.persist(next);
      this.state = { available: true, profile: next };
      return structuredClone(next);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  private load(): Status {
    const unavailable = (reason: UnavailablePreferences['reason'], message: string): Status => ({
      available: false,
      reason,
      message,
    });
    try {
      if (!lstatSync(this.options.directory).isDirectory())
        return unavailable('unreadable', 'Preference storage is not a directory.');
    } catch (error) {
      return unavailable(
        code(error) === 'ENOENT' ? 'storage-missing' : 'unreadable',
        'Preference directory is unavailable.',
      );
    }
    let fd: number | undefined;
    let raw: Buffer;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile())
        return unavailable('unreadable', 'Preference storage is not a regular file.');
      raw = readFileSync(fd);
    } catch (error) {
      return code(error) === 'ENOENT'
        ? { available: true, profile: empty() }
        : unavailable('unreadable', 'Preference file cannot be read.');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
    } catch {
      return unavailable('corrupt', 'Preference file is not valid JSON.');
    }
    if (value && typeof value === 'object' && 'version' in value && value.version !== 1)
      return unavailable('unsupported-version', 'Preference file version is unsupported.');
    return profile(value)
      ? { available: true, profile: value }
      : unavailable('corrupt', 'Preference file has an invalid shape.');
  }
  private persist(next: PreferenceProfile): void {
    const temporary = join(this.options.directory, `.preferences-${randomUUID()}.tmp`);
    const backup = join(this.options.directory, `.preferences-${randomUUID()}.backup`);
    let fd: number | undefined;
    let directory: number | undefined;
    let backedUp = false;
    let replaced = false;
    try {
      directory = openSync(
        this.options.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, JSON.stringify(next) + '\n');
      this.sync(fd);
      closeSync(fd);
      fd = undefined;
      // Keep the original inode and bytes until the replacement is durably committed.
      try {
        linkSync(this.path, backup);
        backedUp = true;
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
      this.rename(temporary, this.path);
      replaced = true;
      this.sync(directory);
    } catch {
      if (replaced) {
        try {
          if (backedUp) {
            this.rename(backup, this.path);
            backedUp = false;
          } else unlinkSync(this.path);
          if (directory !== undefined) this.sync(directory);
        } catch {
          // Do not permit another mutation if rollback durability is uncertain.
          this.state = {
            available: false,
            reason: 'unreadable',
            message: 'Preference rollback failed; repair storage and restart.',
          };
        }
      }
      throw new PreferenceStoreError('save-failed', 'Preferences could not be saved.');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (directory !== undefined) closeSync(directory);
      try {
        unlinkSync(temporary);
      } catch {
        /* Already renamed or creation failed. */
      }
      // Preserve a recovery copy if rollback itself failed.
      if (backedUp && this.state.available) {
        try {
          unlinkSync(backup);
        } catch {
          /* Harmless recovery copy. */
        }
      }
    }
  }
}
