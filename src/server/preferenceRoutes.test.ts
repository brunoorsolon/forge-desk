import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/load.js';
import type { AppConfig } from '../config/schema.js';
import { PlanService } from '../service/planService.js';
import { acquirePreferenceLock, PREFERENCE_LOCK_FILE } from '../service/preferenceLock.js';
import * as preferenceLocks from '../service/preferenceLock.js';
import { openPreferenceRuntime } from '../service/preferenceRuntime.js';
import { PreferenceStore } from '../service/preferenceStore.js';
import { buildApp } from './app.js';
import { startServer } from './index.js';

const PASSWORD = 'never-echo-this-private-password';
const AUTH = `Basic ${Buffer.from(`account:${PASSWORD}`).toString('base64')}`;
const FIRST = { source: 'demo', repo: 'acme/api' };
const SECOND = { source: 'demo', repo: 'acme/web' };
const OUTSIDE = { source: 'retired', repo: 'old/project' };
const DEMO = fileURLToPath(new URL('../../config.demo.yaml', import.meta.url));
const cleanups: Array<() => void | Promise<unknown>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preference-http-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function config(dir: string | null = directory()): AppConfig {
  const value = loadConfig({ path: DEMO, env: {} });
  value.server.basicAuth = { username: 'account', password: PASSWORD };
  value.preferences.dir = dir;
  return value;
}
function seed(dir: string, favorites = [FIRST], revision = 7) {
  const bytes = JSON.stringify({ version: 1, revision, favorites, rememberedProject: SECOND });
  writeFileSync(join(dir, 'preferences.json'), bytes, { mode: 0o600 });
  return bytes;
}
async function setup(value = config()) {
  const runtime = await openPreferenceRuntime(value);
  const app = buildApp(value, new PlanService(value), { preferences: runtime });
  app.addHook('onClose', async () => runtime.close());
  cleanups.push(() => app.close());
  return { app, runtime, config: value, dir: value.preferences.dir! };
}
async function read(app: FastifyInstance) {
  return app.inject({ url: '/api/preferences', headers: { authorization: AUTH } });
}
async function login(app: FastifyInstance) {
  const result = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ username: 'account', password: PASSWORD }).toString(),
  });
  expect(result.statusCode).toBe(303);
  const cookie = String(result.headers['set-cookie']).split(';')[0]!;
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  return {
    cookie,
    origin: 'http://localhost',
    host: 'localhost',
    'x-csrf-token': session.json().csrfToken as string,
  };
}
function mutations(payload = FIRST) {
  return [
    { method: 'POST' as const, url: '/api/preferences/favorites', payload },
    { method: 'PUT' as const, url: '/api/preferences/remembered-project', payload },
    { method: 'DELETE' as const, url: '/api/preferences/favorites/demo/acme/api' },
  ];
}
function noSecretsOrCors(response: Awaited<ReturnType<FastifyInstance['inject']>>) {
  expect(response.body).not.toContain(PASSWORD);
  expect(response.body).not.toContain(AUTH);
  expect(
    Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
  ).toEqual([]);
  expect(response.headers['cache-control']).toBe('no-store');
}

describe('preference HTTP routes', () => {
  it('returns the full authoritative state after each durable operation, preserving order and no-ops', async () => {
    const { app, dir } = await setup();
    expect((await read(app)).json()).toEqual({
      available: true,
      revision: 0,
      favorites: [],
      rememberedProject: null,
    });
    const mutate = async (
      method: 'POST' | 'PUT' | 'DELETE',
      url: string,
      payload?: Record<string, unknown>,
    ) => {
      const result = await app.inject({ method, url, headers: { authorization: AUTH }, payload });
      expect(result.statusCode).toBe(200);
      noSecretsOrCors(result);
      const state = result.json();
      const disk = JSON.parse(readFileSync(join(dir, 'preferences.json'), 'utf8'));
      expect(state.revision).toBe(disk.revision);
      expect(
        state.favorites.map(({ inCatalog: _, ...ref }: Record<string, unknown>) => ref),
      ).toEqual(disk.favorites);
      expect(state.rememberedProject).toEqual(disk.rememberedProject);
      expect(JSON.stringify(disk)).not.toContain(PASSWORD);
      expect(disk).not.toHaveProperty('username');
      return state;
    };
    expect(
      (await mutate('POST', '/api/preferences/favorites', { source: 'demo', repo: 'ACME/API' }))
        .revision,
    ).toBe(1);
    expect((await mutate('POST', '/api/preferences/favorites', FIRST)).revision).toBe(1);
    expect((await mutate('POST', '/api/preferences/favorites', SECOND)).favorites).toEqual([
      { ...FIRST, inCatalog: true },
      { ...SECOND, inCatalog: true },
    ]);
    expect(
      (await mutate('PUT', '/api/preferences/remembered-project', FIRST)).rememberedProject,
    ).toEqual(FIRST);
    expect((await mutate('DELETE', '/api/preferences/favorites/demo/acme/api')).revision).toBe(4);
    expect((await mutate('POST', '/api/preferences/favorites', FIRST)).favorites).toEqual([
      { ...SECOND, inCatalog: true },
      { ...FIRST, inCatalog: true },
    ]);
    expect(statSync(join(dir, 'preferences.json')).mode & 0o777).toBe(0o600);
  });

  it('shares browser sessions and serialized concurrent changes without losing a favorite', async () => {
    const { app } = await setup();
    const a = await login(app),
      b = await login(app);
    const results = await Promise.all(
      [FIRST, SECOND].map((payload, i) =>
        app.inject({
          method: 'POST',
          url: '/api/preferences/favorites',
          headers: i === 0 ? a : b,
          payload,
        }),
      ),
    );
    expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(results.map((res) => res.json().revision).sort()).toEqual([1, 2]);
    expect(
      (await app.inject({ url: '/api/preferences', headers: { cookie: a.cookie } })).json()
        .favorites,
    ).toHaveLength(2);
    expect(
      (await app.inject({ url: '/api/preferences', headers: { cookie: b.cookie } })).json(),
    ).toEqual((await read(app)).json());
  });

  it('keeps removed projects visible and removable, but rejects additions and remembers outside the catalog', async () => {
    const c = config();
    seed(c.preferences.dir!, [FIRST, OUTSIDE]);
    const { app } = await setup(c);
    expect((await read(app)).json().favorites).toEqual([
      { ...FIRST, inCatalog: true },
      { ...OUTSIDE, inCatalog: false },
    ]);
    for (const input of mutations(OUTSIDE).slice(0, 2)) {
      const res = await app.inject({ ...input, headers: { authorization: AUTH } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not-in-catalog');
      noSecretsOrCors(res);
    }
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/preferences/favorites/retired/old/project',
      headers: { authorization: AUTH },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().favorites).toEqual([{ ...FIRST, inCatalog: true }]);
  });

  it('validates against catalog membership, not forge health or source policy usability', async () => {
    const c = config();
    c.catalog.sources[0]!.policy = {
      status: 'conflict',
      conflict: {
        source: 'demo',
        differingSettings: ['ordering.mode'],
        views: ['demo', 'other'],
        explanation: 'Resolve source policy.',
      },
    };
    const { app } = await setup(c);
    const response = await app.inject({
      method: 'POST',
      url: '/api/preferences/favorites',
      headers: { authorization: AUTH },
      payload: FIRST,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().favorites[0].inCatalog).toBe(true);
  });

  it('enforces the 200-favorite cap without rewriting the last committed file', async () => {
    const c = config();
    const before = seed(
      c.preferences.dir!,
      Array.from({ length: 200 }, (_, i) => ({ source: 'removed', repo: `old/project${i}` })),
    );
    const { app, dir } = await setup(c);
    const response = await app.inject({
      method: 'POST',
      url: '/api/preferences/favorites',
      headers: { authorization: AUTH },
      payload: FIRST,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('favorites-limit');
    expect(readFileSync(join(dir, 'preferences.json'), 'utf8')).toBe(before);
    noSecretsOrCors(response);
  });

  it.each([
    null,
    [],
    {},
    { source: 'demo' },
    { repo: 'acme/api' },
    { source: 1, repo: 'acme/api' },
    { source: 'demo', repo: 'a/b/c' },
    { source: '../demo', repo: 'acme/api' },
    { ...FIRST, owner: 'someone' },
    { ...FIRST, profile: 'someone' },
    { ...FIRST, directory: '/tmp' },
    { ...FIRST, password: PASSWORD },
  ])('rejects malformed or extra input %j without exposing it', async (payload) => {
    const { app } = await setup();
    for (const method of ['POST', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url:
          method === 'POST' ? '/api/preferences/favorites' : '/api/preferences/remembered-project',
        headers: { authorization: AUTH, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid-request');
      noSecretsOrCors(response);
    }
  });

  it('rejects malformed JSON, unsupported content types, invalid encoded paths and DELETE bodies safely', async () => {
    const { app } = await setup();
    for (const payload of [`{"password":"${PASSWORD}",}`, PASSWORD]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/preferences/favorites',
        headers: { authorization: AUTH, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(400);
      noSecretsOrCors(response);
    }
    for (const input of [
      {
        method: 'POST' as const,
        url: '/api/preferences/favorites',
        headers: { 'content-type': 'application/xml' },
        payload: PASSWORD,
      },
      { method: 'DELETE' as const, url: '/api/preferences/favorites/demo/%00/api' },
      { method: 'DELETE' as const, url: `/api/preferences/favorites/demo/${PASSWORD}%ZZ/api` },
      {
        method: 'DELETE' as const,
        url: '/api/preferences/favorites/demo/acme/api',
        payload: FIRST,
      },
    ]) {
      const response = await app.inject({
        ...input,
        headers: { authorization: AUTH, ...input.headers },
      });
      expect(response.statusCode).toBe(400);
      noSecretsOrCors(response);
    }
  });

  it('allows exactly 1 KiB and returns 400 above the byte limit on every mutation', async () => {
    const { app } = await setup();
    const json = JSON.stringify(FIRST);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/preferences/favorites',
      headers: { authorization: AUTH, 'content-type': 'application/json' },
      payload: json.padEnd(1024, ' '),
    });
    expect(accepted.statusCode).toBe(200);
    for (const input of mutations()) {
      const response = await app.inject({
        ...input,
        headers: { authorization: AUTH, 'content-type': 'application/json' },
        payload: json.padEnd(1025, ' '),
      });
      expect(response.statusCode).toBe(400);
      noSecretsOrCors(response);
    }
    const multibyte = await app.inject({
      method: 'POST',
      url: '/api/preferences/favorites',
      headers: { authorization: AUTH },
      payload: { source: 'demo', repo: 'é'.repeat(600) },
    });
    expect(multibyte.statusCode).toBe(400);
  });

  it('keeps every operation uncommitted on a real storage failure, then recovers', async () => {
    const c = config();
    const before = seed(c.preferences.dir!);
    const { app, dir } = await setup(c);
    const offline = join(directory(), 'offline');
    renameSync(dir, offline);
    try {
      for (const input of [mutations(SECOND)[0]!, mutations(FIRST)[1]!, mutations()[2]!]) {
        const response = await app.inject({ ...input, headers: { authorization: AUTH } });
        expect(response.statusCode).toBe(500);
        expect(response.json().code).toBe('save-failed');
        noSecretsOrCors(response);
        expect(readFileSync(join(offline, 'preferences.json'), 'utf8')).toBe(before);
        expect((await read(app)).json().revision).toBe(7);
      }
    } finally {
      renameSync(offline, dir);
    }
    expect(
      (await app.inject({ ...mutations(SECOND)[0]!, headers: { authorization: AUTH } })).json()
        .revision,
    ).toBe(8);
  });

  it('does not log credentials in request URLs, headers or malformed JSON errors', () => {
    const script = `
      import { loadConfig } from './src/config/load.ts';
      import { PlanService } from './src/service/planService.ts';
      import { openPreferenceRuntime } from './src/service/preferenceRuntime.ts';
      import { buildApp } from './src/server/app.ts';
      const config = loadConfig({ path: ${JSON.stringify(DEMO)}, env: { FD_BASIC_AUTH: ${JSON.stringify(`account:${PASSWORD}`)}, FD_PREFERENCES_DIR: ${JSON.stringify(directory())} } });
      const runtime = await openPreferenceRuntime(config);
      const app = buildApp(config, new PlanService(config), { logger: true, preferences: runtime });
      for (const url of ['/api/preferences/favorites?password=${PASSWORD}', '/api/preferences/favorites/${PASSWORD}/%ZZ/api']) {
        const response = await app.inject({ method: 'POST', url, headers: { authorization: ${JSON.stringify(AUTH)}, 'content-type': 'application/json' }, payload: '{"password":"${PASSWORD}",}' });
        console.log('checked status ' + response.statusCode);
      }
      await app.close();
      await runtime.close();
    `;
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' },
    );
    expect(output).toContain('incoming request');
    expect(output).toContain('checked status 400');
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(AUTH);
  });

  it('returns save-failed without committing and allows a safe later retry', async () => {
    const c = config();
    const before = seed(c.preferences.dir!);
    const { app, dir } = await setup(c);
    const failing = vi
      .spyOn(PreferenceStore.prototype, 'addFavorite')
      .mockRejectedValueOnce(new Error(`${PASSWORD}: cannot write ${dir}`));
    const response = await app.inject({
      method: 'POST',
      url: '/api/preferences/favorites',
      headers: { authorization: AUTH },
      payload: SECOND,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe('save-failed');
    noSecretsOrCors(response);
    expect(response.body).not.toContain(dir);
    expect(readFileSync(join(dir, 'preferences.json'), 'utf8')).toBe(before);
    expect((await read(app)).json().revision).toBe(7);
    failing.mockRestore();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/preferences/favorites',
          headers: { authorization: AUTH },
          payload: SECOND,
        })
      ).json().revision,
    ).toBe(8);
  });
});

describe('preference authentication and request protection', () => {
  it('requires login for reads and all writes without issuing a browser Basic challenge', async () => {
    const { app } = await setup();
    for (const headers of [
      {},
      { authorization: 'Basic invalid' },
      { cookie: 'ev_session=unknown' },
    ]) {
      for (const input of [{ method: 'GET' as const, url: '/api/preferences' }, ...mutations()]) {
        const response = await app.inject({ ...input, headers });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('unauthenticated');
        expect(response.headers['www-authenticate']).toBeUndefined();
        noSecretsOrCors(response);
      }
    }
  });

  it('enforces Origin, live session CSRF and exclusive credentials on every browser mutation', async () => {
    const { app } = await setup();
    const good = await login(app);
    const cases = [
      [{ cookie: good.cookie, 'x-csrf-token': good['x-csrf-token'] }, 'forbidden-origin'],
      [{ ...good, origin: 'https://evil.example' }, 'forbidden-origin'],
      [{ cookie: good.cookie, origin: good.origin, host: good.host }, 'missing-csrf'],
      [{ ...good, 'x-csrf-token': 'wrong' }, 'invalid-csrf'],
      [{ ...good, authorization: AUTH }, 'mixed-credentials'],
      [{ authorization: AUTH, cookie: 'ev_session=unknown' }, 'mixed-credentials'],
      [{ authorization: AUTH, cookie: 'ev_session=' }, 'mixed-credentials'],
    ] as const;
    for (const [headers, code] of cases)
      for (const input of mutations()) {
        const response = await app.inject({ ...input, headers });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe(code);
        noSecretsOrCors(response);
      }
    for (const input of mutations())
      expect((await app.inject({ ...input, headers: good })).statusCode).toBe(200);
  });

  it('rejects foreign Origins and mixed credentials on reads and Basic scripts too', async () => {
    const { app } = await setup();
    const session = await login(app);
    for (const headers of [
      { authorization: AUTH, origin: 'https://evil.example' },
      { cookie: session.cookie, origin: 'https://evil.example' },
      { cookie: session.cookie, authorization: AUTH },
    ]) {
      const response = await app.inject({ url: '/api/preferences', headers });
      expect(response.statusCode).toBe(403);
      noSecretsOrCors(response);
    }
    for (const input of mutations()) {
      const denied = await app.inject({
        ...input,
        headers: { authorization: AUTH, origin: 'https://evil.example' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('forbidden-origin');
      expect(
        (await app.inject({ ...input, headers: { authorization: AUTH, cookie: 'unrelated=ok' } }))
          .statusCode,
      ).toBe(200);
    }
  });

  it('uses configured publicOrigin instead of rewritten Host and ignores forwarding headers', async () => {
    const c = config();
    c.server.publicOrigin = 'https://desk.example:8443';
    const { app } = await setup(c);
    const session = await login(app);
    const good = await app.inject({
      method: 'POST',
      url: '/api/preferences/favorites',
      payload: FIRST,
      headers: { ...session, origin: 'https://desk.example:8443', host: 'internal:3000' },
    });
    expect(good.statusCode).toBe(200);
    for (const origin of ['http://internal:3000', 'https://desk.example', 'https://evil.example']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/preferences/favorites',
        payload: FIRST,
        headers: {
          ...session,
          origin,
          host: 'internal:3000',
          'x-forwarded-host': 'desk.example:8443',
        },
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('matches request Host and port without publicOrigin and rejects CSRF from another session or expired login', async () => {
    const { app } = await setup();
    const a = await login(app),
      b = await login(app);
    const input = mutations()[0]!;
    const wrongToken = await app.inject({
      ...input,
      headers: { ...a, 'x-csrf-token': b['x-csrf-token'] },
    });
    expect(wrongToken.json().code).toBe('invalid-csrf');
    expect(
      (
        await app.inject({
          ...input,
          headers: { ...a, host: 'desk.example:3000', origin: 'https://desk.example:3000' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          ...input,
          headers: { ...a, host: 'desk.example:3000', origin: 'https://desk.example' },
        })
      ).json().code,
    ).toBe('forbidden-origin');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect((await app.inject({ ...input, headers: a })).statusCode).toBe(401);
    expect(
      (await app.inject({ ...input, headers: { ...a, authorization: AUTH } })).json().code,
    ).toBe('mixed-credentials');
  });

  it('logout revokes browser access without erasing the stored profile', async () => {
    const { app } = await setup();
    const session = await login(app);
    await app.inject({ ...mutations()[0]!, headers: session });
    await app.inject({ method: 'POST', url: '/logout', headers: { cookie: session.cookie } });
    expect(
      (await app.inject({ url: '/api/preferences', headers: { cookie: session.cookie } }))
        .statusCode,
    ).toBe(401);
    expect((await read(app)).json().favorites).toEqual([{ ...FIRST, inCatalog: true }]);
  });
});

describe('preference availability and lifetime', () => {
  it('does not lock, read or expose stored data with login disabled, then restores it when enabled', async () => {
    const c = config();
    const dir = c.preferences.dir!;
    const before = seed(dir);
    c.server.basicAuth = null;
    const { app } = await setup(c);
    expect((await app.inject('/api/preferences')).json()).toMatchObject({
      available: false,
      reason: 'login-disabled',
    });
    expect(existsSync(join(dir, PREFERENCE_LOCK_FILE))).toBe(false);
    for (const input of mutations()) {
      const response = await app.inject(input);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: 'preferences-unavailable',
        reason: 'login-disabled',
      });
      expect(response.body).not.toContain('acme');
      noSecretsOrCors(response);
    }
    expect((await app.inject('/api/views')).statusCode).toBe(200);
    expect(readFileSync(join(dir, 'preferences.json'), 'utf8')).toBe(before);
    c.server.basicAuth = { username: 'account', password: PASSWORD };
    const restored = await setup(c);
    expect((await read(restored.app)).json().revision).toBe(7);
  });

  it('reports storage-not-configured and does not enable releases', async () => {
    const { app } = await setup(config(null));
    expect((await read(app)).json()).toMatchObject({
      available: false,
      reason: 'storage-not-configured',
    });
    for (const input of mutations()) {
      const response = await app.inject({ ...input, headers: { authorization: AUTH } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: 'preferences-unavailable',
        reason: 'storage-not-configured',
      });
    }
    expect(
      (await app.inject({ url: '/api/releases/repositories', headers: { authorization: AUTH } }))
        .statusCode,
    ).toBe(404);
  });

  it('keeps planning public with storage and publicOrigin configured but no login', async () => {
    const c = config();
    c.server.basicAuth = null;
    c.server.publicOrigin = 'https://desk.example';
    const { app } = await setup(c);
    expect((await app.inject('/api/views/demo/snapshot')).statusCode).toBe(200);
    expect((await app.inject('/api/releases/repositories')).statusCode).toBe(404);
    expect(readdirSync(c.preferences.dir!)).toEqual([]);
  });

  it.each(['storage-missing', 'unreadable', 'corrupt', 'unsupported-version'] as const)(
    'reports %s without blocking planning or modifying the original file',
    async (reason) => {
      const c = config();
      const original = c.preferences.dir!;
      let before: string | null = null;
      if (reason === 'storage-missing') c.preferences.dir = join(original, 'missing');
      else if (reason === 'unreadable') {
        const target = join(original, 'target');
        writeFileSync(target, 'preserve');
        symlinkSync(target, join(original, 'preferences.json'));
      } else {
        before = reason === 'corrupt' ? `{"${PASSWORD}": broken` : '{"version":2}';
        writeFileSync(join(original, 'preferences.json'), before);
      }
      const { app } = await setup(c);
      const response = await read(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ available: false, reason });
      noSecretsOrCors(response);
      for (const input of mutations()) {
        const response = await app.inject({ ...input, headers: { authorization: AUTH } });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'preferences-unavailable', reason });
        noSecretsOrCors(response);
      }
      expect(
        (await app.inject({ url: '/api/views/demo/snapshot', headers: { authorization: AUTH } }))
          .statusCode,
      ).toBe(200);
      if (before !== null)
        expect(readFileSync(join(original, 'preferences.json'), 'utf8')).toBe(before);
      if (reason === 'storage-missing') expect(existsSync(c.preferences.dir!)).toBe(false);
    },
  );

  it.each([
    'unsupported-filesystem',
    'unsupported-platform',
    'helper-missing',
    'lock-failed',
  ] as const)('maps %s to unreadable without opening the store', async (reason) => {
    const c = config();
    vi.spyOn(preferenceLocks, 'acquirePreferenceLock').mockResolvedValueOnce({
      available: false,
      reason,
      message: `${PASSWORD}: private diagnostic`,
    });
    const { app } = await setup(c);
    const response = await read(app);
    expect(response.json()).toMatchObject({ available: false, reason: 'unreadable' });
    noSecretsOrCors(response);
    expect(readdirSync(c.preferences.dir!)).toEqual([]);
  });

  it('revokes reads and queued writes when ownership is lost', async () => {
    const c = config();
    const before = seed(c.preferences.dir!);
    const ownership = await acquirePreferenceLock({ directory: c.preferences.dir! });
    if (!ownership.available) throw new Error('Expected ownership');
    vi.spyOn(preferenceLocks, 'acquirePreferenceLock').mockResolvedValueOnce(ownership);
    const { app } = await setup(c);
    await ownership.lock.release();
    expect((await read(app)).json()).toMatchObject({ available: false, reason: 'store-locked' });
    for (const input of mutations()) {
      const response = await app.inject({ ...input, headers: { authorization: AUTH } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: 'preferences-unavailable',
        reason: 'store-locked',
      });
    }
    expect(readFileSync(join(c.preferences.dir!, 'preferences.json'), 'utf8')).toBe(before);
  });

  it('refuses unsafe storage and a second instance while the first continues serving', async () => {
    const c = config();
    chmodSync(c.preferences.dir!, 0o777);
    const unsafe = await setup(c);
    expect((await read(unsafe.app)).json().reason).toBe('unreadable');
    chmodSync(c.preferences.dir!, 0o700);
    const first = await setup(c),
      second = await setup(c);
    expect((await read(first.app)).json().available).toBe(true);
    expect((await read(second.app)).json().reason).toBe('store-locked');
    expect(
      (await second.app.inject({ ...mutations()[0]!, headers: { authorization: AUTH } })).json(),
    ).toMatchObject({ code: 'preferences-unavailable', reason: 'store-locked' });
    expect(
      (await second.app.inject({ url: '/api/views', headers: { authorization: AUTH } })).statusCode,
    ).toBe(200);
    await first.app.close();
    const next = await setup(c);
    expect((await read(next.app)).json().available).toBe(true);
  });

  it('drains accepted writes before unlocking, rejects new writes and persists across credential changes', async () => {
    const c = config();
    const { runtime } = await setup(c);
    const admitted = runtime.mutate('addFavorite', FIRST);
    const closing = runtime.close();
    await expect(runtime.mutate('addFavorite', SECOND)).rejects.toMatchObject({
      code: 'preferences-unavailable',
      reason: 'store-locked',
    });
    await expect(admitted).resolves.toMatchObject({ revision: 1 });
    await closing;
    expect(runtime.read()).toMatchObject({ available: false, reason: 'store-locked' });
    c.server.basicAuth = { username: 'changed', password: 'changed-password' };
    const { app } = await setup(c);
    const response = await app.inject({
      url: '/api/preferences',
      headers: {
        authorization: `Basic ${Buffer.from('changed:changed-password').toString('base64')}`,
      },
    });
    expect(response.json().favorites).toEqual([{ ...FIRST, inCatalog: true }]);
  });

  it('startup owns the store and closing the real server releases it', async () => {
    const dir = directory(),
      port = await freePort();
    const app = await startServer({
      configPath: DEMO,
      env: {
        FD_PORT: String(port),
        FD_HOST: '127.0.0.1',
        FD_BASIC_AUTH: `account:${PASSWORD}`,
        FD_PREFERENCES_DIR: dir,
      },
    });
    cleanups.push(() => app.close());
    expect((await read(app)).json().available).toBe(true);
    expect(await acquirePreferenceLock({ directory: dir })).toMatchObject({
      available: false,
      reason: 'store-locked',
    });
    await app.close();
    const lock = await acquirePreferenceLock({ directory: dir });
    expect(lock.available).toBe(true);
    if (lock.available) await lock.lock.release();
  });

  it('listen failure releases preference ownership for the next startup', async () => {
    const dir = directory(),
      listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('No port');
    await expect(
      startServer({
        configPath: DEMO,
        env: {
          FD_HOST: '127.0.0.1',
          FD_PORT: String(address.port),
          FD_BASIC_AUTH: `account:${PASSWORD}`,
          FD_PREFERENCES_DIR: dir,
        },
      }),
    ).rejects.toThrow();
    const lock = await acquirePreferenceLock({ directory: dir });
    expect(lock.available).toBe(true);
    if (lock.available) await lock.lock.release();
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
