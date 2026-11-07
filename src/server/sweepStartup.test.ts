import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, parseConfig } from '../config/load.js';
import { startServer } from './index.js';

vi.mock('../config/load.js', async (original) => ({
  ...(await original<typeof import('../config/load.js')>()),
  loadConfig: vi.fn(),
}));
const HOUR = 3_600_000;
const START = '2026-01-01T00:00:00.000Z';
let server: FastifyInstance | undefined;
let oldTerm = process.listeners('SIGTERM');
let oldInt = process.listeners('SIGINT');
async function settledSweep(app: FastifyInstance) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await app.inject('/api/refresh');
    if (response.json()?.finishedAt !== null) return response;
    await delay(5);
  }
  throw new Error('Sweep did not finish');
}
async function tick() {
  await immediate();
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  oldTerm = process.listeners('SIGTERM');
  oldInt = process.listeners('SIGINT');
});
afterEach(async () => {
  try {
    await server?.close();
  } finally {
    server = undefined;
    for (const listener of process.listeners('SIGTERM'))
      if (!oldTerm.includes(listener)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT'))
      if (!oldInt.includes(listener)) process.removeListener('SIGINT', listener);
    vi.useRealTimers();
  }
});

it.each([0, 1])(
  'starts the actual server with sweepHours %i and stops its scheduler on close',
  async (sweepHours) => {
    // Only config loading is substituted so the real listener can bind an ephemeral port.
    // Provider, observations, admission, scheduler and the app lifecycle all run normally.
    const config = parseConfig(
      JSON.stringify({
        sources: [{ id: 'demo', kind: 'fixture', path: './test/fixtures/demo.json' }],
        views: [
          {
            id: 'demo',
            source: 'demo',
            repos: ['acme/api', 'acme/web'],
            dependencies: { body: false, native: false, subIssues: false },
          },
        ],
        refresh: { sweepHours },
      }),
      {},
    );
    config.server.host = '127.0.0.1';
    config.server.port = 0;
    vi.mocked(loadConfig).mockReturnValue(config);
    server = await startServer({ env: {}, webDir: '/tmp/forge-desk-sweep-no-web' });
    await tick();
    const response = await settledSweep(server);
    expect(response.statusCode).toBe(200);
    if (sweepHours === 0) {
      expect(response.json()).toBeNull();
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect((await server.inject('/api/refresh')).json()).toBeNull();
    } else {
      expect(response.json()).toMatchObject({
        state: 'completed',
        trigger: 'scheduled',
        startedAt: START,
        finishedAt: START,
        sources: [
          {
            source: 'demo',
            state: 'completed',
            projects: [
              {
                project: { source: 'demo', repo: 'acme/api' },
                state: 'checked',
                lastCheckedAt: START,
              },
              {
                project: { source: 'demo', repo: 'acme/web' },
                state: 'checked',
                lastCheckedAt: START,
              },
            ],
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(HOUR - 1);
      expect((await server.inject('/api/refresh')).json().id).toBe(response.json().id);
      await vi.advanceTimersByTimeAsync(1);
      await tick();
      const next = await settledSweep(server);
      expect(next.json().id).not.toBe(response.json().id);
      expect(next.json()).toMatchObject({
        state: 'completed',
        startedAt: '2026-01-01T01:00:00.000Z',
      });
    }
    await server.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(vi.getTimerCount()).toBe(0);
  },
);
