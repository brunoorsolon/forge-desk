import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/schema.js';
import type { Scope } from '../core/scope.js';
import { AdmissionShutdownError } from '../service/admissionQueue.js';
import { ScopeCooldownError } from '../service/scopeReadService.js';
import { ScopeRefreshError } from '../service/scopeRefreshJobs.js';
import type { ScopeRuntime } from '../service/scopeRuntime.js';
import { checkRequestProtection, type RequestAuthentication } from './requestProtection.js';

/** Only these POSTs delegate planning authentication to the shared launch check. */
export function isScopeRefreshPath(method: string, url: string): boolean {
  return (
    method === 'POST' &&
    /^\/api\/(?:projects\/[^/]+\/[^/]+\/[^/]+|sources\/[^/]+)\/refresh$/.test(url.split('?')[0]!)
  );
}

export function registerScopeRefreshRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authentication: RequestAuthentication | null,
  runtime: ScopeRuntime,
): void {
  const secrets = config.sources.map((source) => source.token).filter((s): s is string => !!s);
  const safe = <T>(value: T): T => {
    if (typeof value === 'string') {
      let result: string = value;
      for (const secret of secrets) result = result.split(secret).join('***');
      return result as T;
    }
    if (Array.isArray(value)) return value.map((item) => safe(item)) as T;
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)])) as T;
    return value;
  };
  void app.register((routes, _options, done) => {
    routes.addHook('onRequest', async (request, reply) => {
      const access = checkRequestProtection(request.method, request.headers, {
        mode: 'refresh-launch',
        trustedOrigin: config.server.publicOrigin,
        loginConfigured: config.server.basicAuth !== null,
        sessionCsrf: authentication?.sessionCsrf ?? (() => null),
        hasSessionCookie:
          authentication?.hasSessionCookie ??
          ((cookie) => /(?:^|;\s*)ev_session=/.test(cookie ?? '')),
        headerAuthenticated: authentication?.headerAuthenticated ?? (() => false),
      });
      if (!access.ok)
        return reply.code(access.status).send({ code: access.code, error: access.message });
    });

    for (const path of ['/api/projects/:source/:owner/:repo', '/api/sources/:source']) {
      routes.post<{ Params: { source: string; owner?: string; repo?: string } }>(
        `${path}/refresh`,
        async (request, reply) => {
          const { source, owner, repo } = request.params;
          const scope: Scope =
            owner === undefined
              ? { kind: 'source', source }
              : { kind: 'project', source, repo: `${owner}/${repo}` };
          try {
            // The read service owns the same 15-second bound, job joins and fresh-data
            // rechecks as snapshot reads. Never fall back to the unpaced export lane.
            return safe(await runtime.reads.refresh(scope));
          } catch (error) {
            if (error instanceof ScopeRefreshError)
              return reply
                .code(error.code === 'policy-conflict' ? 409 : 404)
                .send(safe({ code: error.code, error: error.message }));
            if (error instanceof ScopeCooldownError)
              return reply
                .code(503)
                .send({ code: error.code, error: error.message, delayedUntil: error.delayedUntil });
            if (error instanceof AdmissionShutdownError)
              return reply
                .code(503)
                .send({ code: 'server-closing', error: 'Scope reads are shutting down' });
            throw error;
          }
        },
      );
    }
    done();
  });
}
