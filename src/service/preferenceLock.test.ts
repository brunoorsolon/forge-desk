import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquirePreferenceLock,
  PREFERENCE_LOCK_FILE,
  type PreferenceLock,
} from './preferenceLock.js';

const roots: string[] = [];
const locks: PreferenceLock[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const lock of locks.splice(0)) await lock.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'preference-lock-'));
  roots.push(path);
  return path;
}
async function claim(path: string): Promise<PreferenceLock> {
  const result = await acquirePreferenceLock({ directory: path });
  expect(result.available).toBe(true);
  if (!result.available) throw new Error(result.message);
  locks.push(result.lock);
  return result.lock;
}
function owner(
  path: string,
  mode: 'hold' | 'exit' | 'natural',
): { child: ChildProcess; ready: Promise<string>; exited: Promise<void> } {
  const module = fileURLToPath(new URL('./preferenceLock.ts', import.meta.url));
  const script = `
    import { acquirePreferenceLock } from ${JSON.stringify(module)};
    const result = await acquirePreferenceLock({ directory: ${JSON.stringify(path)} });
    console.log(result.available ? 'owned' : result.reason);
    if (${JSON.stringify(mode)} === 'exit') process.exit(0);
    if (${JSON.stringify(mode)} === 'hold' && result.available) setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const ready = new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('\n')) resolve(output.trim());
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output) reject(new Error(`owner exited ${code}`));
    });
  });
  return { child, ready, exited };
}

describe('preference directory ownership (real Linux flock)', () => {
  it('takes a private OS lock and refuses concurrent and subsequent same-process claims promptly', async () => {
    const path = directory();
    const bytes = Buffer.from('do not read or rewrite this invalid preference store');
    writeFileSync(join(path, 'preferences.json'), bytes, { mode: 0o000 });
    const before = statSync(join(path, 'preferences.json'));
    const results = await Promise.all([
      acquirePreferenceLock({ directory: path }),
      acquirePreferenceLock({ directory: path }),
    ]);
    const success = results.find((result) => result.available);
    expect(success?.available).toBe(true);
    if (!success?.available) throw new Error('missing owner');
    locks.push(success.lock);
    expect(results.find((result) => !result.available)).toMatchObject({ reason: 'store-locked' });
    const started = performance.now();
    expect(await acquirePreferenceLock({ directory: path })).toMatchObject({
      reason: 'store-locked',
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(statSync(join(path, PREFERENCE_LOCK_FILE)).mode & 0o777).toBe(0o600);
    const after = statSync(join(path, 'preferences.json'));
    expect(after.atimeMs).toBe(before.atimeMs);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    chmodSync(join(path, 'preferences.json'), 0o600);
    expect(readFileSync(join(path, 'preferences.json'))).toEqual(bytes);
    await success.lock.release();
    expect(success.lock.held).toBe(false);
    await success.lock.release();
    expect((await claim(path)).held).toBe(true);
  });

  it('locks the actual directory inode without blocking unrelated preference directories', async () => {
    const first = directory();
    const second = directory();
    await claim(first);
    await claim(second);
    expect(() =>
      execFileSync('flock', ['--nonblock', join(first, PREFERENCE_LOCK_FILE), 'true']),
    ).toThrow();
    expect(() =>
      execFileSync('flock', ['--nonblock', join(second, PREFERENCE_LOCK_FILE), 'true']),
    ).toThrow();
  });

  it('refuses a second application process without touching the preference file', async () => {
    const path = directory();
    await claim(path);
    const contender = owner(path, 'exit');
    expect(await contender.ready).toBe('store-locked');
    await contender.exited;
    expect(readdirSync(path)).toEqual([PREFERENCE_LOCK_FILE]);
  });

  it.each(['exit', 'natural', 'crash'] as const)(
    'releases after owning process %s, with the stale lock file retained',
    async (mode) => {
      const path = directory();
      const processOwner = owner(path, mode === 'crash' ? 'hold' : mode);
      expect(await processOwner.ready).toBe('owned');
      if (mode === 'crash') {
        expect(await acquirePreferenceLock({ directory: path })).toMatchObject({
          reason: 'store-locked',
        });
        processOwner.child.kill('SIGKILL');
      }
      await processOwner.exited;
      expect(existsSync(join(path, PREFERENCE_LOCK_FILE))).toBe(true);
      // EOF delivery and helper exit are asynchronous after the parent dies.
      await vi.waitFor(async () => {
        const result = await acquirePreferenceLock({ directory: path });
        if (result.available) locks.push(result.lock);
        expect(result.available).toBe(true);
      });
    },
  );

  it.each([0x6969, 0xff534d42, 0x65735546, 0xdeadbeef])(
    'refuses untrusted filesystem %s before creating any file',
    async (type) => {
      const path = directory();
      expect(
        await acquirePreferenceLock({ directory: path, filesystemType: () => type }),
      ).toMatchObject({ reason: 'unsupported-filesystem' });
      expect(readdirSync(path)).toEqual([]);
    },
  );

  it('does not create a missing directory', async () => {
    const path = join(directory(), 'missing');
    expect(await acquirePreferenceLock({ directory: path })).toMatchObject({
      reason: 'storage-missing',
    });
    expect(existsSync(path)).toBe(false);
  });

  it('rejects unsafe paths and lock symlinks without modifying their targets', async () => {
    const root = directory();
    const target = join(root, 'preferences.json');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(root, PREFERENCE_LOCK_FILE));
    expect(await acquirePreferenceLock({ directory: root })).toMatchObject({ available: false });
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    const alias = join(directory(), 'alias');
    symlinkSync(root, alias);
    expect(await acquirePreferenceLock({ directory: alias })).toMatchObject({
      reason: 'unsafe-storage',
    });
  });

  it('fails closed on unavailable helpers, unsupported platforms, and failed filesystem probes', async () => {
    const path = directory();
    expect(
      await acquirePreferenceLock({ directory: path, flockPath: join(path, 'missing-helper') }),
    ).toMatchObject({ reason: 'helper-missing' });
    expect(await acquirePreferenceLock({ directory: path, platform: 'darwin' })).toMatchObject({
      reason: 'unsupported-platform',
    });
    expect(
      await acquirePreferenceLock({
        directory: path,
        filesystemType: () => {
          throw new Error('probe failed');
        },
      }),
    ).toMatchObject({ reason: 'lock-failed' });
    await claim(path);
  });

  it('supervises unexpected holder death and revokes ownership', async () => {
    const path = directory();
    const pidFile = join(path, 'helper.pid');
    const wrapper = join(path, 'flock-wrapper');
    writeFileSync(wrapper, `#!/bin/sh\necho $$ > '${pidFile}'\nexec flock "$@"\n`, { mode: 0o700 });
    const onLost = vi.fn();
    const result = await acquirePreferenceLock({ directory: path, flockPath: wrapper, onLost });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error(result.message);
    locks.push(result.lock);
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
    await vi.waitFor(() => {
      expect(result.lock.held).toBe(false);
      expect(onLost).toHaveBeenCalledTimes(1);
    });
    await claim(path);
  });
});
