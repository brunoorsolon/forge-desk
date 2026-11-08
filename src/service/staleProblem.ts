import type { ObservationMetadata } from '../core/scope.js';

/** Warning tolerance only; refresh scheduling and live freshness still use the cache TTL. */
export const STALE_PROBLEM_GRACE_SECONDS = 900;

export function hasStaleProblem(
  observation: Pick<ObservationMetadata, 'lastAttempt' | 'lastCheckedAt'> | undefined,
  ttlSeconds: number,
  now: Date,
): boolean {
  return (
    observation?.lastAttempt?.outcome === 'failed' &&
    (observation.lastCheckedAt === null ||
      (ttlSeconds > 0 &&
        now.getTime() - Date.parse(observation.lastCheckedAt) >
          (ttlSeconds + STALE_PROBLEM_GRACE_SECONDS) * 1000))
  );
}
