/**
 * Access gate for release routes (source specification section 12).
 *
 * Release routes are stricter than the planning API because they can act with a dedicated write
 * credential. Two caller kinds are accepted:
 *
 * - A browser caller proves a live login session, the configured public Host, and a same-origin
 *   Origin, and a mutating request also carries the CSRF token bound to that session.
 * - A CLI caller proves an explicit Authorization header and sends no session cookie. It needs no
 *   Origin or CSRF proof because another site cannot make a browser attach that header, and a
 *   cookie-less request has no ambient authority to forge.
 *
 * Forwarded headers never decide who may publish: only the request's own Host and Origin count.
 */

import {
  checkRequestProtection,
  type AuthenticatedRequestAccess,
  type RequestAuthentication,
  type RequestHeaders,
} from './requestProtection.js';

export { CSRF_HEADER } from './requestProtection.js';

export interface ReleaseAccessDeps extends RequestAuthentication {
  /** Operator-approved external origin, e.g. `https://forge-desk.example.com`. */
  publicOrigin: string;
}

export type ReleaseAccess = AuthenticatedRequestAccess;

/** Compatibility adapter: release routes retain their exact origin, Host and login policy. */
export function checkReleaseAccess(
  method: string,
  headers: RequestHeaders,
  deps: ReleaseAccessDeps,
): ReleaseAccess {
  return checkRequestProtection(method, headers, {
    ...deps,
    mode: 'release',
    trustedOrigin: deps.publicOrigin,
  });
}
