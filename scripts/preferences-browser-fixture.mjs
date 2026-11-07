/** Real app, session routes and disk store; only upstream data and deliberate faults are fixtures. */
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { parseConfig } from '../dist/config/load.js';
import { parseKey } from '../dist/core/keys.js';
import { createScopeRuntime } from '../dist/service/scopeRuntime.js';
import { openPreferenceRuntime } from '../dist/service/preferenceRuntime.js';
import { buildApp } from '../dist/server/app.js';

export async function preferencesFixture(
  directory,
  { login = true, storage = true, unreadable = false, listen = true } = {},
) {
  await mkdir(directory, { recursive: true });
  const config = parseConfig(
    JSON.stringify({
      server: login ? { basicAuth: { username: 'browser', passwordEnv: 'BROWSER_PASSWORD' } } : {},
      ...(storage ? { preferences: { dir: directory } } : {}),
      sources: [
        { id: 'alpha', kind: 'github' },
        { id: 'beta', kind: 'github' },
      ],
      views: [
        { id: 'alpha-view', source: 'alpha', repos: ['demo/one', 'demo/two'] },
        { id: 'beta-view', source: 'beta', repos: ['demo/three'] },
      ],
    }),
    { BROWSER_PASSWORD: 'disposable-browser-password' },
  );
  const coverage = { native: 'complete', subIssues: 'complete' };
  const listing = (repo) => ({
    issues: [
      {
        ...parseKey(`${repo}#1`),
        key: `${repo}#1`,
        title: `Browser ${repo}`,
        body: '',
        state: 'open',
        url: `https://example.test/${repo}/issues/1`,
        labels: [],
        assignees: [],
        milestone: null,
        updatedAt: null,
        nativeRelations: [],
        relationCoverage: coverage,
      },
    ],
    warnings: [],
    relationCoverage: coverage,
  });
  const scopes = createScopeRuntime(config, {
    shutdownWaitMs: 0,
    providerFor: () => ({
      kind: 'github',
      cooldownUntil: () => null,
      async listOpenIssues(repo) {
        return listing(`${repo.owner}/${repo.repo}`);
      },
      async getIssue() {
        return null;
      },
    }),
  });
  for (const source of config.catalog.sources)
    for (const project of source.projects)
      scopes.store.writeRepository(
        scopes.store.beginRepositoryRead(project),
        listing(project.repo),
      );
  // Omitting an explicitly configured runtime models unreadable startup storage.
  const preferences = unreadable ? undefined : await openPreferenceRuntime(config);
  const requests = [];
  let fault = null;
  const app = buildApp(config, scopes.plans, {
    scopes,
    preferences,
    webDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
  });
  app.addHook('onRequest', async (request, reply) => {
    requests.push({ method: request.method, url: request.url });
    if (fault === 'read' && request.url === '/api/preferences' && request.method === 'GET') {
      fault = null;
      return reply.code(500).send({ error: 'Preferences temporarily could not be read.' });
    }
    if (
      fault === 'reject' &&
      request.url.startsWith('/api/preferences/') &&
      request.method !== 'GET'
    ) {
      fault = null;
      return reply
        .code(500)
        .send({ code: 'save-failed', error: 'Preferences could not be saved.' });
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      fault === 'truncated' &&
      request.url.startsWith('/api/preferences/') &&
      request.method !== 'GET' &&
      reply.statusCode === 200
    ) {
      // The real route committed the durable write. Lose the authoritative JSON payload,
      // not the connection before headers: Chromium transparently retries idempotent DELETE
      // after a socket reset, which would turn this case into a successful second response.
      fault = null;
      return String(payload).slice(0, -1);
    }
    return payload;
  });
  const origin = listen ? await app.listen({ host: '127.0.0.1', port: 0 }) : '';
  if (!listen) await app.ready();
  return {
    origin,
    app,
    requests,
    preferences,
    login,
    failNext(mode) {
      fault = mode;
    },
    async close() {
      await app.close();
      await preferences?.close();
    },
  };
}
