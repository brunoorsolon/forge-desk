import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import { loadConfig, parseConfig } from '../config/load.js';
import { loadReleaseRuntime } from '../config/releaseRuntime.js';
import { AdmissionShutdownError } from '../service/admissionQueue.js';
import { acquireReleaseOwnership } from '../service/releaseOwnership.js';
import { createScopeRuntime } from '../service/scopeRuntime.js';
import { startServer } from './index.js';

vi.mock('../config/load.js', async (original) => ({
  ...(await original<typeof import('../config/load.js')>()),
  loadConfig: vi.fn(),
}));
vi.mock('../config/releaseRuntime.js', () => ({ loadReleaseRuntime: vi.fn() }));
vi.mock('../service/releaseOwnership.js', async (original) => ({
  ...(await original<typeof import('../service/releaseOwnership.js')>()),
  acquireReleaseOwnership: vi.fn(),
}));
vi.mock('../service/scopeRuntime.js', { spy: true });

async function tick() {
  await immediate();
  for (let n = 0; n < 50; n++) await Promise.resolve();
}

it('starts the actual startup release drain before a stalled scope drain finishes', async () => {
  // Exercise startServer/buildApp and real provider/queue/read shutdown. Only the
  // release owner is controlled here; ownership/lock semantics have their own tests.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-desk-shutdown-'));
  const config = parseConfig(
    JSON.stringify({
      sources: [{ id: 'gh', kind: 'github' }],
      views: [{ id: 'roadmap', source: 'gh', repos: ['o/a'] }],
    }),
    {},
  );
  config.server.host = '127.0.0.1';
  config.server.port = 0;
  config.sources[0]!.planning!.dependencies.native = false;
  config.sources[0]!.planning!.dependencies.subIssues = false;
  vi.mocked(loadConfig).mockReturnValue(config);
  vi.mocked(loadReleaseRuntime).mockReturnValue({
    stateDir,
    publicOrigin: 'http://localhost',
    repositories: [],
  });
  const shutdown = vi.fn(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    return { drained: false, pending: ['controlled-release'], lockReleased: false };
  });
  vi.mocked(acquireReleaseOwnership).mockResolvedValue({
    stateDir,
    accepting: true,
    shutdown,
  } as unknown as Awaited<ReturnType<typeof acquireReleaseOwnership>>);
  let releaseFetch!: () => void;
  const upstream = new Promise<void>((resolve) => (releaseFetch = resolve));
  const fetch = vi.fn(async () => {
    await upstream;
    return new Response('[]');
  });
  vi.stubGlobal('fetch', fetch);
  const oldTerm = process.listeners('SIGTERM');
  const oldInt = process.listeners('SIGINT');
  let server: FastifyInstance | undefined;
  try {
    server = await startServer({ env: {}, webDir: '/tmp/forge-desk-shutdown-no-web' });
    const runtime = vi.mocked(createScopeRuntime).mock.results.at(-1)!.value as ReturnType<
      typeof createScopeRuntime
    >;
    const pending = server.inject('/api/projects/gh/o/a/snapshot').then((response) => response);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    let closed = false;
    const startedAt = Date.now();
    const closing = server.close().then(() => (closed = true));
    await tick();
    // No clock advancement: release shutdown must start with the scope fetch
    // still blocked, and first-load HTTP waiters must already have been released.
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.sources[0]!.queue.status.inFlight).toBe(1);
    expect((await pending).statusCode).toBe(200);
    await expect(
      runtime.sources[0]!.queue.submit('after-close', 'interactive', async () => undefined),
    ).rejects.toBeInstanceOf(AdmissionShutdownError);
    await vi.advanceTimersByTimeAsync(4999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(closed).toBe(true);
    await closing;
    expect(Date.now() - startedAt).toBe(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    releaseFetch();
    await tick();
    await vi.advanceTimersByTimeAsync(10_000);
    await server?.close();
    for (const listener of process.listeners('SIGTERM'))
      if (!oldTerm.includes(listener)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT'))
      if (!oldInt.includes(listener)) process.removeListener('SIGINT', listener);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
