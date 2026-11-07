/** Controlled upstream only: catalog, scope reads, jobs and HTTP routes are production code. */
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../dist/config/load.js';
import { parseKey } from '../dist/core/keys.js';
import { createScopeRuntime } from '../dist/service/scopeRuntime.js';
import { buildApp } from '../dist/server/app.js';

export async function navigationFixture({ conflicts = [], refreshMinutes = 0, seed = true } = {}) {
  const coverage = { native: 'complete', subIssues: 'complete' };
  const listing = (repo) => ({
    issues: [
      {
        ...parseKey(`${repo}#1`),
        key: `${repo}#1`,
        title: `Browser fixture ${repo}`,
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
  const config = parseConfig(
    JSON.stringify({
      ui: { refreshMinutes },
      cache: { ttlSeconds: 3600 },
      sources: [
        { id: 'alpha', kind: 'github' },
        { id: 'beta', kind: 'github' },
      ],
      views: [
        { id: 'alpha-view', source: 'alpha', repos: ['demo/one', 'demo/two'] },
        { id: 'beta-view', source: 'beta', repos: ['demo/three'] },
        ...conflicts.map((source) => ({
          id: `${source}-conflict`,
          source,
          repos: ['demo/conflict'],
          dependencies: { native: false },
        })),
      ],
    }),
    {},
  );
  const gates = new Map();
  const upstream = [];
  const errors = new Map();
  const cooldowns = new Map();
  const runtime = createScopeRuntime(config, {
    shutdownWaitMs: 0,
    providerFor: (source) => ({
      kind: 'github',
      cooldownUntil: () => cooldowns.get(source.id) ?? null,
      async listOpenIssues(repo) {
        const name = `${repo.owner}/${repo.repo}`;
        upstream.push({ source: source.id, repo: name });
        await gates.get(`${source.id}/${name}`)?.promise;
        const error = errors.get(`${source.id}/${name}`);
        if (error) throw new Error(error);
        return listing(name);
      },
      async getIssue() {
        return null;
      },
    }),
  });
  if (seed)
    for (const source of config.catalog.sources)
      for (const project of source.projects) {
        runtime.store.writeRepository(
          runtime.store.beginRepositoryRead(project),
          listing(project.repo),
        );
      }
  const requests = [];
  const app = buildApp(config, runtime.plans, {
    scopes: runtime,
    webDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
  });
  app.addHook('onRequest', async (request) => {
    requests.push({ url: request.url, at: Date.now() });
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    origin,
    requests,
    upstream,
    fail(project, message = 'Fixture upstream unavailable') {
      errors.set(`${project.source}/${project.repo}`, message);
      runtime.store.invalidateRepository(project);
    },
    cooldown(project) {
      cooldowns.set(project.source, Date.now() + 60000);
      runtime.sources.find((source) => source.source.id === project.source).queue.cooldownChanged();
      runtime.store.invalidateRepository(project);
    },
    hold(project) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      gates.set(`${project.source}/${project.repo}`, { promise, resolve });
      runtime.store.invalidateRepository(project);
      return () => {
        resolve();
        gates.delete(`${project.source}/${project.repo}`);
      };
    },
    async close() {
      for (const gate of gates.values()) gate.resolve();
      await app.close();
    },
  };
}
