import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config/schema.js';
import { contentHash } from '../core/hash.js';
import type { Scope, ScopeResponse } from '../core/scope.js';
import type { PlanWarning, Snapshot } from '../core/types.js';
import { exporters, type ExportFormat } from '../export/index.js';
import { AdmissionShutdownError } from '../service/admissionQueue.js';
import { ScopeCooldownError } from '../service/scopeReadService.js';
import { ScopeRefreshError } from '../service/scopeRefreshJobs.js';
import type { ScopeRuntime } from '../service/scopeRuntime.js';

const formats: Record<string, ExportFormat> = {
  json: 'json',
  md: 'md',
  mmd: 'mermaid',
  dot: 'dot',
};
type Params = { source: string; owner?: string; repo?: string; format?: string };
const scopeOf = (params: Params): Scope =>
  params.owner === undefined
    ? { kind: 'source', source: params.source }
    : { kind: 'project', source: params.source, repo: `${params.owner}/${params.repo}` };

function exportSnapshot(response: ScopeResponse): Snapshot {
  const snapshot = response.snapshot!;
  const warnings: PlanWarning[] = [...snapshot.plan.warnings];
  for (const repo of response.freshness.repositories) {
    if (repo.state !== 'fresh' || repo.partial)
      warnings.push({
        code: repo.partial ? 'dependency-provisional' : 'stale-data',
        issues: [],
        message: `${repo.project.source}/${repo.project.repo}: ${repo.state}${repo.partial ? ', partial relation coverage' : ''}; last checked ${repo.lastCheckedAt ?? 'never'}${repo.delayedUntil ? `; delayed until ${repo.delayedUntil}` : ''}${repo.error ? `; ${repo.error}` : ''}`,
      });
  }
  const plan = { ...snapshot.plan, warnings };
  return { ...snapshot, plan, contentHash: contentHash({ plan, layout: snapshot.layout }) };
}

/** Scope reads inherit the app's existing planning authentication and no-store hook. */
export function registerScopeRoutes(
  app: FastifyInstance,
  config: AppConfig,
  runtime: ScopeRuntime,
): void {
  const secrets = config.sources.map((s) => s.token).filter((s): s is string => !!s);
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
  async function respond(reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> {
    try {
      return await work();
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
  }
  app.get('/api/projects', async () => safe(config.catalog));
  for (const path of ['/api/projects/:source/:owner/:repo', '/api/sources/:source']) {
    app.get<{ Params: Params }>(`${path}/snapshot`, async (request, reply) =>
      respond(reply, async () => safe(await runtime.reads.get(scopeOf(request.params)))),
    );
    app.get<{ Params: Params; Querystring: { refresh?: string } }>(
      `${path}/export.:format`,
      async (request, reply) =>
        respond(reply, async () => {
          const extension = request.params.format!;
          if (!Object.hasOwn(formats, extension))
            return reply.code(404).send({ error: 'Not found' });
          const response = safe(
            await runtime.exportRead(scopeOf(request.params), {
              refresh: request.query.refresh === '1' || request.query.refresh === 'true',
            }),
          );
          if (response.snapshot === null)
            return reply.code(503).send({
              code: 'scope-unavailable',
              error: 'No scope snapshot is available',
              ...response,
            });
          const snapshot = exportSnapshot(response);
          const format = formats[extension]!;
          const exporter = exporters[format];
          let body = exporter.render(snapshot);
          // Graph exporters historically omit warnings. Add comments for scope downloads
          // only, keeping every named-view and CLI export byte-for-byte compatible.
          if (format === 'mermaid' || format === 'dot') {
            const prefix = format === 'mermaid' ? '%%' : '//';
            body = [
              `${prefix} Last checked: ${snapshot.fetchedAt}`,
              ...snapshot.plan.warnings.map(
                (warning) =>
                  `${prefix} ${warning.code}: ${warning.message.replace(/[\r\n\u2028\u2029]/g, ' ')}`,
              ),
              body,
            ].join('\n');
          }
          return reply
            .type(exporter.contentType)
            .header(
              'Content-Disposition',
              `inline; filename="${snapshot.viewId.replace(/[^a-zA-Z0-9_.-]/g, '-')}.${exporter.extension}"`,
            )
            .send(body);
        }),
    );
  }
  // Stop admission and release HTTP waiters before Fastify drains connections, but
  // do not hold preClose open for the scope drain. Startup's release onClose hook
  // must start its own bounded drain immediately, not after another five seconds.
  app.addHook('preClose', async () => {
    void runtime.close();
  });
  // Fastify runs onClose hooks in reverse registration order: startup's later
  // release hook runs first, while the idempotent scope close is already draining.
  app.addHook('onClose', async () => runtime.close());
}
