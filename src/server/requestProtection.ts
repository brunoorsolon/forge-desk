/** Pure request protection shared by releases, preferences and refresh launches.
 * Callers supply authentication lookups and the appropriate configured public origin.
 * Forwarded headers never establish trust. No routes are mounted by this module.
 */
import { safeEqual } from './auth.js';

export const CSRF_HEADER = 'x-csrf-token';
export const LAUNCH_HEADER = 'x-forge-desk-request';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export type RequestHeaders = Record<string, string | string[] | undefined>;

export interface RequestAuthentication {
  /** CSRF token for a live session, null for absent, unknown or expired sessions. */
  sessionCsrf(cookie: string | undefined): string | null;
  /** Includes unknown and expired session cookies, not unrelated cookies. */
  hasSessionCookie(cookie: string | undefined): boolean;
  /** Validate explicit Basic credentials against the application login. */
  headerAuthenticated(header: string | undefined): boolean;
}

type AuthenticatedOptions = RequestAuthentication &
  (
    | { mode: 'release'; trustedOrigin: string }
    | { mode: 'preference'; trustedOrigin?: string | null }
  );

export type RequestProtectionDeps =
  | AuthenticatedOptions
  | (RequestAuthentication & {
      mode: 'refresh-launch';
      trustedOrigin?: string | null;
      loginConfigured: boolean;
    });

export type RequestRejection = {
  ok: false;
  status: 401 | 403;
  code:
    | 'unauthenticated'
    | 'forbidden-origin'
    | 'missing-csrf'
    | 'invalid-csrf'
    | 'mixed-credentials'
    | 'missing-launch-header';
  message: string;
};
export type AuthenticatedRequestAccess = { ok: true; mode: 'browser' | 'cli' } | RequestRejection;
export type RequestAccess = AuthenticatedRequestAccess | { ok: true; mode: 'anonymous' };

function header(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reject(
  status: 401 | 403,
  code: RequestRejection['code'],
  message: string,
): RequestRejection {
  return { ok: false, status, code, message };
}

/** Accept only a serialized HTTP origin, never a URL with a path, credentials or fragment. */
function originHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (!/^https?:\/\/[^\\/?#@\s]+$/i.test(origin)) return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** Configured origin wins over Host, including behind a proxy which rewrites Host. */
function matchesPlanningOrigin(
  origin: string,
  headers: RequestHeaders,
  trustedOrigin?: string | null,
): boolean {
  const suppliedHost = originHost(origin);
  const trustedHost =
    trustedOrigin == null ? header(headers, 'host')?.toLowerCase() : originHost(trustedOrigin);
  return suppliedHost !== null && trustedHost != null && suppliedHost === trustedHost;
}

export function checkRequestProtection(
  method: string,
  headers: RequestHeaders,
  deps: AuthenticatedOptions,
): AuthenticatedRequestAccess;
export function checkRequestProtection(
  method: string,
  headers: RequestHeaders,
  deps: RequestProtectionDeps,
): RequestAccess;
export function checkRequestProtection(
  method: string,
  headers: RequestHeaders,
  deps: RequestProtectionDeps,
): RequestAccess {
  const release = deps.mode === 'release';
  const label = release ? 'release' : deps.mode === 'preference' ? 'preference' : 'refresh';
  const authorization = header(headers, 'authorization');
  const cookie = header(headers, 'cookie');
  const origin = header(headers, 'origin');
  // Preserve the exact, scheme-sensitive release policy. Planning compares host and port.
  const publicOrigin = release ? new URL(deps.trustedOrigin) : null;
  if (
    origin !== undefined &&
    (publicOrigin !== null
      ? origin !== publicOrigin.origin
      : !matchesPlanningOrigin(origin, headers, deps.trustedOrigin))
  ) {
    return reject(
      403,
      'forbidden-origin',
      `${label} requests must come from the configured origin`,
    );
  }
  if (authorization !== undefined && deps.hasSessionCookie(cookie)) {
    return reject(
      403,
      'mixed-credentials',
      `${label} requests must not combine a session cookie with an Authorization header`,
    );
  }
  if (deps.mode === 'refresh-launch' && headers[LAUNCH_HEADER] !== '1') {
    return reject(403, 'missing-launch-header', 'refresh launches require x-forge-desk-request: 1');
  }
  if (deps.mode === 'refresh-launch' && !deps.loginConfigured) {
    return { ok: true, mode: 'anonymous' };
  }
  if (authorization !== undefined) {
    if (!deps.headerAuthenticated(authorization)) {
      return reject(401, 'unauthenticated', 'invalid application credentials');
    }
    return { ok: true, mode: 'cli' };
  }
  const sessionCsrf = deps.sessionCsrf(cookie);
  if (sessionCsrf === null) {
    return reject(401, 'unauthenticated', `${label} access requires the application login`);
  }
  const host = header(headers, 'host');
  if (
    publicOrigin !== null &&
    (host === undefined || host.toLowerCase() !== publicOrigin.host.toLowerCase())
  ) {
    return reject(403, 'forbidden-origin', 'release requests must use the configured public host');
  }
  // A launch always needs session CSRF, even if accidentally invoked with a safe method.
  if (deps.mode === 'refresh-launch' || !SAFE_METHODS.has(method.toUpperCase())) {
    if (origin === undefined) {
      return reject(
        403,
        'forbidden-origin',
        `a ${label} request that changes state must state its Origin`,
      );
    }
    const provided = header(headers, CSRF_HEADER);
    if (provided === undefined || provided === '') {
      return reject(
        403,
        'missing-csrf',
        `a ${label} request that changes state needs its CSRF token`,
      );
    }
    if (!safeEqual(provided, sessionCsrf)) {
      return reject(403, 'invalid-csrf', 'the CSRF token does not belong to this session');
    }
  }
  return { ok: true, mode: 'browser' };
}
