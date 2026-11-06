import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, statfsSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';

/** Independent of release state and configuration. Never unlink this file while in use. */
export const PREFERENCE_LOCK_FILE = 'preferences.lock';
export type PreferenceLockReason =
  | 'storage-missing'
  | 'store-locked'
  | 'unsupported-filesystem'
  | 'unsupported-platform'
  | 'unsafe-storage'
  | 'helper-missing'
  | 'lock-failed';
export type PreferenceLockResult =
  | { available: true; lock: PreferenceLock }
  | { available: false; reason: PreferenceLockReason; message: string };
export interface PreferenceLockOptions {
  directory: string;
  /** Test seams; production uses Linux statfs and util-linux flock. */
  filesystemType?: (directory: string) => number;
  platform?: NodeJS.Platform;
  flockPath?: string;
  /** Stop preference writes when supervision reports lost ownership. */
  onLost?: () => void;
}
// The same conservative local-inode-lock allowlist as release ownership. Unknown types fail closed.
const LOCAL_FILESYSTEMS = new Set([
  0x0000ef53, 0x58465342, 0x9123683e, 0x01021994, 0x2fc12fc1, 0xf2f52010, 0x3153464a, 0x794c7630,
  0x0000f15f,
]);
const CONFLICT_EXIT_CODE = 73;
function refused(reason: PreferenceLockReason, message: string): PreferenceLockResult {
  return { available: false, reason, message };
}

/**
 * Supervised lifetime ownership. Consumers check held before writing and stop on onLost.
 * Drain preference operations before release(). Never unlink/replace the lock file: another
 * inode could admit two owners. This primitive does not read or write the preference store.
 */
export class PreferenceLock {
  private releasing = false;
  private lost = false;
  private releasePromise?: Promise<void>;
  constructor(
    private readonly child: ChildProcess,
    private readonly exited: Promise<void>,
    onLost?: () => void,
  ) {
    void exited.then(() => {
      this.lost = true;
      if (!this.releasing) onLost?.();
    });
  }
  get held(): boolean {
    return (
      !this.releasing &&
      !this.lost &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }
  /** Idempotent shutdown, bounded even if the helper stops responding. */
  release(): Promise<void> {
    this.releasePromise ??= this.close();
    return this.releasePromise;
  }
  private async close(): Promise<void> {
    this.releasing = true;
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Claim without touching preferences.json or creating its directory. flock owns a validated
 * descriptor, not a path that could follow a symlink. --no-fork makes the supervised process
 * the actual holder; EOF on stdin releases it on parent exit or crash.
 */
export async function acquirePreferenceLock(
  options: PreferenceLockOptions,
): Promise<PreferenceLockResult> {
  if ((options.platform ?? process.platform) !== 'linux') {
    return refused('unsupported-platform', 'Preference locking requires Linux flock.');
  }
  let fd: number | undefined;
  try {
    const info = lstatSync(options.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    ) {
      return refused(
        'unsafe-storage',
        'Preference directory must be owned by the runtime user and not writable by others.',
      );
    }
    const type = (options.filesystemType ?? ((path) => statfsSync(path).type))(options.directory);
    if (!LOCAL_FILESYSTEMS.has(type)) {
      return refused(
        'unsupported-filesystem',
        'Preference directory requires a trusted local filesystem.',
      );
    }
    fd = openSync(
      join(options.directory, PREFERENCE_LOCK_FILE),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== info.uid || (file.mode & 0o077) !== 0) {
      return refused(
        'unsafe-storage',
        'Preference lock must be a private, owned regular file with one link.',
      );
    }
    return await hold(fd, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refused(
      code === 'ENOENT' ? 'storage-missing' : 'lock-failed',
      code === 'ENOENT'
        ? 'Preference directory does not exist.'
        : 'Preference directory could not be locked.',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function hold(fd: number, options: PreferenceLockOptions): Promise<PreferenceLockResult> {
  return new Promise((resolve) => {
    const child = spawn(
      options.flockPath ?? 'flock',
      [
        '--nonblock',
        '--no-fork',
        '--conflict-exit-code',
        String(CONFLICT_EXIT_CODE),
        // With a command flock treats its operand as a filename, not a descriptor number.
        // Reopen the pinned descriptor through procfs rather than a replaceable directory path.
        '/proc/self/fd/3',
        'sh',
        '-c',
        'printf "locked\\n"; exec cat >/dev/null',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', fd],
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      },
    );
    const exited = new Promise<void>((done) => child.once('close', () => done()));
    let settled = false;
    let output = '';
    const finish = (result: PreferenceLockResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(refused('lock-failed', 'Preference lock helper timed out.'));
    }, 5_000);
    child.stdin?.on('error', () => {
      // EPIPE during helper failure is handled by close/error supervision.
    });
    child.stderr?.resume();
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(
        refused(
          error.code === 'ENOENT' ? 'helper-missing' : 'lock-failed',
          'Preference lock helper could not start.',
        ),
      );
    });
    child.once('close', (code) => {
      finish(
        refused(
          code === CONFLICT_EXIT_CODE ? 'store-locked' : 'lock-failed',
          code === CONFLICT_EXIT_CODE
            ? 'Another owner holds the preference directory.'
            : 'Preference lock helper exited.',
        ),
      );
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      output = (output + chunk.toString('utf8')).slice(0, 64);
      if (output !== 'locked\n') return;
      // Ownership alone must not keep an otherwise finished server process alive.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        (stream as Socket | null)?.unref();
      }
      finish({ available: true, lock: new PreferenceLock(child, exited, options.onLost) });
    });
  });
}
