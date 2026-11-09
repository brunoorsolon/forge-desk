import type { RefreshTrigger } from '../../src/core/scope.js';

/** Fixed visible-tab follow-up cadence for active scheduled jobs and sweeps. */
export const ACTIVE_POLL_MS = 60_000;
/** A person who started the work is waiting on screen, so follow it closely. */
export const INTERACTIVE_POLL_MS = 2_000;

export function activePollMs(trigger: RefreshTrigger): number {
  return trigger === 'interactive' ? INTERACTIVE_POLL_MS : ACTIVE_POLL_MS;
}
