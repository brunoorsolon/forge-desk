import type { FastifyInstance, FastifyReply } from 'fastify';
import { ID_PATTERN, REPO_PATTERN, type AppConfig } from '../config/schema.js';
import type { AvailablePreferences, PreferenceProfile } from '../core/preferences.js';
import type { ProjectRef } from '../core/scope.js';
import {
  type PreferenceOperation,
  type PreferenceRuntime,
  unavailablePreferences,
} from '../service/preferenceRuntime.js';
import { PreferenceStoreError } from '../service/preferenceStore.js';
import { checkRequestProtection, type RequestAuthentication } from './requestProtection.js';

export function isPreferencePath(url: string): boolean {
  const pathname = url.split('?')[0];
  return pathname === '/api/preferences' || pathname?.startsWith('/api/preferences/') === true;
}

export const INVALID_PREFERENCE_REQUEST = {
  code: 'invalid-request',
  error: 'Invalid preference request. Use only source and owner/repo, within 1 KiB.',
};

function project(input: unknown): ProjectRef | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    typeof value.source !== 'string' ||
    !ID_PATTERN.test(value.source) ||
    typeof value.repo !== 'string' ||
    !REPO_PATTERN.test(value.repo)
  )
    return null;
  return { source: value.source, repo: value.repo.toLowerCase() };
}

/** Register in a private scope so strict parsing and safe errors never change other APIs. */
export function registerPreferenceRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authentication: RequestAuthentication | null,
  runtime?: PreferenceRuntime,
): void {
  const inCatalog = (ref: ProjectRef): boolean =>
    config.catalog.sources.some(
      (source) => source.id === ref.source && source.projects.some((p) => p.repo === ref.repo),
    );
  const present = (profile: PreferenceProfile): AvailablePreferences => ({
    available: true,
    revision: profile.revision,
    favorites: profile.favorites.map((ref) => ({ ...ref, inCatalog: inCatalog(ref) })),
    rememberedProject: profile.rememberedProject,
  });
  const read = () => {
    // Configuration wins even if a caller accidentally supplies a previously opened runtime.
    if (config.server.basicAuth === null) return unavailablePreferences('login-disabled');
    if (config.preferences.dir === null) return unavailablePreferences('storage-not-configured');
    return runtime?.read() ?? unavailablePreferences('unreadable');
  };

  void app.register((scope, _opts, done) => {
    scope.addHook('onRequest', async (request, reply) => {
      if (config.server.basicAuth === null) {
        if (request.method === 'GET' || request.method === 'HEAD') return;
        const status = unavailablePreferences('login-disabled');
        return reply.code(503).send({
          code: 'preferences-unavailable',
          reason: status.reason,
          error: status.message,
        });
      }
      const access =
        authentication === null
          ? null
          : checkRequestProtection(request.method, request.headers, {
              ...authentication,
              mode: 'preference',
              trustedOrigin: config.server.publicOrigin,
            });
      if (access === null)
        return reply.code(401).send({ code: 'unauthenticated', error: 'Login required.' });
      if (!access.ok)
        return reply.code(access.status).send({ code: access.code, error: access.message });
    });

    scope.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      // Never echo JSON parser excerpts, request values, filesystem paths or underlying errors.
      if (error instanceof PreferenceStoreError) {
        if (error.code === 'favorites-limit')
          return reply
            .code(409)
            .send({ code: error.code, error: 'At most 200 favorites are allowed.' });
        if (error.code === 'preferences-unavailable') {
          const status = unavailablePreferences(error.reason ?? 'unreadable');
          return reply.code(503).send({
            code: error.code,
            reason: status.reason,
            error: status.message,
          });
        }
      }
      if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500)
        return reply.code(400).send(INVALID_PREFERENCE_REQUEST);
      return reply
        .code(500)
        .send({ code: 'save-failed', error: 'Preferences could not be saved.' });
    });

    scope.get('/api/preferences', async () => {
      const state = read();
      return state.available ? present(state.profile) : state;
    });

    async function mutate(operation: PreferenceOperation, input: unknown, reply: FastifyReply) {
      const state = read();
      if (!state.available)
        return reply.code(503).send({
          code: 'preferences-unavailable',
          reason: state.reason,
          error: state.message,
        });
      const ref = project(input);
      if (ref === null) return reply.code(400).send(INVALID_PREFERENCE_REQUEST);
      if (operation !== 'removeFavorite' && !inCatalog(ref))
        return reply.code(409).send({
          code: 'not-in-catalog',
          error: 'This project is not in the configured catalog.',
        });
      return present(await runtime!.mutate(operation, ref));
    }

    const options = { bodyLimit: 1024 };
    scope.post('/api/preferences/favorites', options, async (request, reply) =>
      mutate('addFavorite', request.body, reply),
    );
    scope.put('/api/preferences/remembered-project', options, async (request, reply) =>
      mutate('rememberProject', request.body, reply),
    );
    scope.delete<{ Params: { source: string; owner: string; repo: string } }>(
      '/api/preferences/favorites/:source/:owner/:repo',
      options,
      async (request, reply) => {
        if (request.body !== undefined) return reply.code(400).send(INVALID_PREFERENCE_REQUEST);
        const { source, owner, repo } = request.params;
        return mutate('removeFavorite', { source, repo: `${owner}/${repo}` }, reply);
      },
    );
    done();
  });
}
