import { afterEach, describe, expect, it } from 'vitest';
import {
  fsyncSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreferenceStore } from './preferenceStore.js';

const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'preferences-'));
  dirs.push(dir);
  return dir;
}
const ref = (name: string) => ({ source: 'github', repo: `owner/${name}` });
const saved = (revision = 4) => ({
  version: 1,
  revision,
  favorites: [ref('a')],
  rememberedProject: ref('b'),
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PreferenceStore', () => {
  it('opens missing files empty without creating anything; first commit is private and survives reopen', async () => {
    const dir = directory();
    const store = new PreferenceStore({ directory: dir });
    expect(store.read()).toEqual({
      available: true,
      profile: { version: 1, revision: 0, favorites: [], rememberedProject: null },
    });
    expect(readdirSync(dir)).toEqual([]);
    const result = await store.addFavorite(ref('a'));
    expect(statSync(join(dir, 'preferences.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'preferences.json'), 'utf8'))).toEqual(result);
    expect(new PreferenceStore({ directory: dir }).read()).toEqual({
      available: true,
      profile: result,
    });
    expect(readdirSync(dir)).toEqual(['preferences.json']);
  });
  it('does not create missing directories and refuses all mutations', async () => {
    const dir = join(directory(), 'missing');
    const store = new PreferenceStore({ directory: dir });
    expect(store.read()).toMatchObject({ available: false, reason: 'storage-missing' });
    await expect(store.addFavorite(ref('a'))).rejects.toMatchObject({
      code: 'preferences-unavailable',
    });
    await expect(store.removeFavorite(ref('a'))).rejects.toMatchObject({
      code: 'preferences-unavailable',
    });
    await expect(store.rememberProject(ref('a'))).rejects.toMatchObject({
      code: 'preferences-unavailable',
    });
  });
  it.each([
    ['{broken', 'corrupt'],
    [JSON.stringify({ ...saved(), version: 2 }), 'unsupported-version'],
    [JSON.stringify({ ...saved(), revision: -1 }), 'corrupt'],
    [JSON.stringify({ ...saved(), revision: 0.5 }), 'corrupt'],
    [JSON.stringify({ ...saved(), favorites: [ref('a'), ref('a')] }), 'corrupt'],
    [JSON.stringify({ ...saved(), password: 'never-store' }), 'corrupt'],
    [JSON.stringify({ ...saved(), rememberedProject: { source: '', repo: 'owner/a' } }), 'corrupt'],
    [
      JSON.stringify({ ...saved(), favorites: Array.from({ length: 201 }, (_, i) => ref(`${i}`)) }),
      'corrupt',
    ],
    ['null', 'corrupt'],
    ['{}', 'corrupt'],
  ])('preserves refused file bytes %s', async (raw, reason) => {
    const dir = directory();
    const path = join(dir, 'preferences.json');
    writeFileSync(path, raw);
    const store = new PreferenceStore({ directory: dir });
    expect(store.read()).toMatchObject({ available: false, reason });
    await expect(store.addFavorite(ref('a'))).rejects.toMatchObject({
      code: 'preferences-unavailable',
    });
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
  it('refuses unreadable/non-regular storage and never follows a symlink', async () => {
    const dir = directory();
    const target = join(dir, 'target');
    writeFileSync(target, JSON.stringify(saved()));
    symlinkSync(target, join(dir, 'preferences.json'));
    const store = new PreferenceStore({ directory: dir });
    expect(store.read()).toMatchObject({ available: false, reason: 'unreadable' });
    await expect(store.removeFavorite(ref('a'))).rejects.toMatchObject({
      code: 'preferences-unavailable',
    });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(saved());
  });
  it('reads once and returns detached snapshots', async () => {
    const dir = directory();
    const path = join(dir, 'preferences.json');
    writeFileSync(path, JSON.stringify(saved()));
    const store = new PreferenceStore({ directory: dir });
    writeFileSync(path, 'externally-changed');
    const state = store.read();
    if (state.available) state.profile.favorites.length = 0;
    expect(store.read()).toEqual({ available: true, profile: saved() });
  });
  it('serializes concurrent calls, preserves order, does not commit duplicate adds, and appends re-adds', async () => {
    const dir = directory();
    let syncs = 0;
    const store = new PreferenceStore({
      directory: dir,
      fsync: (fd) => {
        syncs++;
        fsyncSync(fd);
      },
    });
    const results = await Promise.all([
      store.addFavorite(ref('a')),
      store.addFavorite(ref('b')),
      store.addFavorite(ref('a')),
      store.removeFavorite(ref('a')),
      store.addFavorite(ref('a')),
      store.rememberProject(ref('b')),
      store.rememberProject(ref('a')),
    ]);
    expect(results.map((r) => r.revision)).toEqual([1, 2, 2, 3, 4, 5, 6]);
    expect(results[6]).toMatchObject({
      favorites: [ref('b'), ref('a')],
      rememberedProject: ref('a'),
    });
    expect(syncs).toBe(12);
    expect(readdirSync(dir)).toEqual(['preferences.json']);
  });
  it('caps favorites at 200 without changing bytes or revision; duplicate at cap is a no-op', async () => {
    const dir = directory();
    const path = join(dir, 'preferences.json');
    const initial = { ...saved(), favorites: Array.from({ length: 200 }, (_, i) => ref(`${i}`)) };
    const raw = JSON.stringify(initial);
    writeFileSync(path, raw);
    const store = new PreferenceStore({ directory: dir });
    await expect(store.addFavorite(ref('overflow'))).rejects.toMatchObject({
      code: 'favorites-limit',
    });
    expect(await store.addFavorite(ref('1'))).toEqual(initial);
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
  for (const existing of [true, false]) {
    it.each(['file-sync', 'rename', 'directory-sync'] as const)(
      'rolls back %s with existing file=' + existing,
      async (stage) => {
        const dir = directory();
        const path = join(dir, 'preferences.json');
        const raw = '  ' + JSON.stringify(saved()) + '\n';
        if (existing) writeFileSync(path, raw, { mode: 0o600 });
        let syncs = 0;
        let renames = 0;
        const store = new PreferenceStore({
          directory: dir,
          fsync: (fd) => {
            syncs++;
            if (
              (stage === 'file-sync' && syncs === 1) ||
              (stage === 'directory-sync' && syncs === 2)
            )
              throw Error('injected');
            fsyncSync(fd);
          },
          rename: (from, to) => {
            if (++renames === 1 && stage === 'rename') throw Error('injected');
            renameSync(from, to);
          },
        });
        const before = store.read();
        await expect(store.addFavorite(ref('new'))).rejects.toMatchObject({ code: 'save-failed' });
        expect(store.read()).toEqual(before);
        expect(readdirSync(dir)).toEqual(existing ? ['preferences.json'] : []);
        if (existing) expect(readFileSync(path, 'utf8')).toBe(raw);
        // A failed operation never poisons normal queue ordering or the next valid save.
        expect((await store.addFavorite(ref('next'))).favorites.at(-1)).toEqual(ref('next'));
      },
    );
  }
  it('copies mutation inputs and outputs', async () => {
    const store = new PreferenceStore({ directory: directory() });
    const input = ref('a');
    const pending = store.addFavorite(input);
    input.repo = 'owner/changed';
    const result = await pending;
    result.favorites[0]!.repo = 'owner/changed';
    expect(store.read()).toMatchObject({ profile: { favorites: [ref('a')] } });
  });
  it('fails closed and preserves recovery copy if rollback itself fails', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'preferences.json'), JSON.stringify(saved()));
    let syncs = 0,
      renames = 0;
    const store = new PreferenceStore({
      directory: dir,
      fsync: (fd) => {
        if (++syncs === 2) throw Error('disk error');
        fsyncSync(fd);
      },
      rename: (from, to) => {
        if (++renames === 2) throw Error('disk failure during rollback');
        renameSync(from, to);
      },
    });
    await expect(store.addFavorite(ref('a-new'))).rejects.toMatchObject({ code: 'save-failed' });
    expect(store.read()).toMatchObject({ available: false });
    await expect(store.addFavorite(ref('another'))).rejects.toMatchObject({
      code: 'preferences-unavailable',
    });
    const backup = readdirSync(dir).find((p) => p.endsWith('.backup'))!;
    expect(JSON.parse(readFileSync(join(dir, backup), 'utf8'))).toEqual(saved());
  });
});
