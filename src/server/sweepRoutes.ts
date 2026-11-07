import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/schema.js';
import type { SweepScheduler } from '../service/sweepScheduler.js';
import { checkRequestProtection, type RequestAuthentication } from './requestProtection.js';

/** Launches use the shared gate, rather than the weaker planning-read authentication. */
export function isSweepLaunchRequest(method: string, url: string): boolean {
  return method === 'POST' && url.split('?')[0] === '/api/refresh';
}

export function registerSweepRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authentication: RequestAuthentication | null,
  scheduler: SweepScheduler,
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

  // The read inherits planning authentication and the app's no-store policy.
  app.get('/api/refresh', async () => safe(scheduler.status));
  app.post(
    '/api/refresh',
    {
      onRequest: async (request, reply) => {
        const access = checkRequestProtection(request.method, request.headers, {
          ...(authentication ?? {
            sessionCsrf: () => null,
            hasSessionCookie: (cookie) => /(?:^|;\s*)ev_session=/.test(cookie ?? ''),
            headerAuthenticated: () => false,
          }),
          mode: 'refresh-launch',
          loginConfigured: config.server.basicAuth !== null,
          trustedOrigin: config.server.publicOrigin,
        });
        if (!access.ok)
          return reply.code(access.status).send({ code: access.code, error: access.message });
      },
    },
    async () => safe(scheduler.sweep().status),
  );
  // Stop before scope queues close or an active sweep can schedule another interval.
  app.addHook('preClose', async () => scheduler.stop());
}
