import { describe, expect, it } from 'vitest';
import { checkBasicAuth, sessionToken } from './auth.js';
import { checkReleaseAccess } from './releaseAccess.js';
import {
  checkRequestProtection,
  CSRF_HEADER,
  LAUNCH_HEADER,
  type RequestAuthentication,
  type RequestHeaders,
  type RequestProtectionDeps,
} from './requestProtection.js';

const trustedOrigin = 'https://desk.example:8443';
const credentials = { username: 'operator', password: 'test-password' };
const authorization = `Basic ${Buffer.from('operator:test-password').toString('base64')}`;
const authentication: RequestAuthentication = {
  sessionCsrf: (cookie) => (sessionToken(cookie) === 'live' ? 'session-csrf' : null),
  hasSessionCookie: (cookie) => sessionToken(cookie) !== null,
  headerAuthenticated: (header) => checkBasicAuth(header, credentials),
};
const policies: { name: string; deps: RequestProtectionDeps }[] = [
  { name: 'release', deps: { ...authentication, mode: 'release', trustedOrigin } },
  { name: 'preference configured', deps: { ...authentication, mode: 'preference', trustedOrigin } },
  { name: 'preference Host fallback', deps: { ...authentication, mode: 'preference' } },
  {
    name: 'refresh login configured',
    deps: { ...authentication, mode: 'refresh-launch', trustedOrigin, loginConfigured: true },
  },
  {
    name: 'refresh login Host fallback',
    deps: { ...authentication, mode: 'refresh-launch', loginConfigured: true },
  },
  {
    name: 'refresh no login configured',
    deps: { ...authentication, mode: 'refresh-launch', trustedOrigin, loginConfigured: false },
  },
  {
    name: 'refresh no login Host fallback',
    deps: { ...authentication, mode: 'refresh-launch', loginConfigured: false },
  },
];
const callers: {
  name: string;
  headers: RequestHeaders;
  kind: 'browser' | 'cli' | 'mixed' | 'none';
}[] = [
  { name: 'live session', headers: { cookie: 'ev_session=live' }, kind: 'browser' },
  { name: 'valid Basic', headers: { authorization }, kind: 'cli' },
  {
    name: 'Basic and unrelated cookie',
    headers: { authorization, cookie: 'theme=dark' },
    kind: 'cli',
  },
  {
    name: 'mixed live session',
    headers: { authorization, cookie: 'ev_session=live' },
    kind: 'mixed',
  },
  {
    name: 'mixed expired session',
    headers: { authorization, cookie: 'ev_session=expired' },
    kind: 'mixed',
  },
  {
    name: 'mixed invalid Basic',
    headers: { authorization: 'Bearer invalid', cookie: 'ev_session=live' },
    kind: 'mixed',
  },
  { name: 'expired session', headers: { cookie: 'ev_session=expired' }, kind: 'none' },
  { name: 'invalid Basic', headers: { authorization: 'Basic invalid' }, kind: 'none' },
  { name: 'none', headers: {}, kind: 'none' },
];

function outcome(result: ReturnType<typeof checkRequestProtection>): string {
  return result.ok ? result.mode : `${result.status}:${result.code}`;
}

// Full cross-product: policy × identity × method × Origin × CSRF × launch proof.
// Expected results describe the public contract, not implementation call order.
for (const { name, deps } of policies) {
  describe(name, () => {
    for (const caller of callers) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'patch']) {
        it(`${caller.name}, ${method}: origin and proof matrix`, () => {
          for (const origin of [undefined, trustedOrigin, 'https://foreign.example']) {
            for (const csrf of [undefined, '', 'wrong-session', 'session-csrf']) {
              for (const launch of [undefined, '', '0', '1']) {
                const headers: RequestHeaders = {
                  host: 'desk.example:8443',
                  ...caller.headers,
                  origin,
                  [CSRF_HEADER]: csrf,
                  [LAUNCH_HEADER]: launch,
                };
                const refresh = deps.mode === 'refresh-launch';
                const anonymous = refresh && !deps.loginConfigured;
                const requiresCsrf = refresh || !['GET', 'HEAD', 'OPTIONS'].includes(method);
                let expected: string;
                if (origin === 'https://foreign.example') expected = '403:forbidden-origin';
                else if (caller.kind === 'mixed') expected = '403:mixed-credentials';
                else if (refresh && launch !== '1') expected = '403:missing-launch-header';
                else if (anonymous) expected = 'anonymous';
                else if (caller.kind === 'none') expected = '401:unauthenticated';
                else if (caller.kind === 'cli') expected = 'cli';
                else if (requiresCsrf && origin === undefined) expected = '403:forbidden-origin';
                else if (requiresCsrf && (csrf === undefined || csrf === ''))
                  expected = '403:missing-csrf';
                else if (requiresCsrf && csrf !== 'session-csrf') expected = '403:invalid-csrf';
                else expected = 'browser';
                expect(
                  outcome(checkRequestProtection(method, headers, deps)),
                  JSON.stringify(headers),
                ).toBe(expected);
              }
            }
          }
        });
      }
    }

    it.each([
      'null',
      '',
      'not a URL',
      `${trustedOrigin}/`,
      `${trustedOrigin}/path`,
      `${trustedOrigin}?q=1`,
      `${trustedOrigin}#fragment`,
      'https://user@desk.example:8443',
      'https://desk.example:8444',
      'https://desk.example',
      'https://desk.example.evil:8443',
      'https://desk.example:8443 https://evil.example',
    ])('rejects invalid or foreign Origin %s for every identity', (origin) => {
      for (const caller of callers) {
        expect(
          outcome(
            checkRequestProtection(
              'POST',
              {
                host: 'desk.example:8443',
                ...caller.headers,
                origin,
                [CSRF_HEADER]: 'session-csrf',
                [LAUNCH_HEADER]: '1',
              },
              deps,
            ),
          ),
        ).toBe('403:forbidden-origin');
      }
    });

    it('uses configured origin or Host, never forwarded headers', () => {
      const headers = {
        host: 'internal:3000',
        origin: trustedOrigin,
        authorization,
        'x-forwarded-host': 'desk.example:8443',
        'x-forwarded-proto': 'https',
        [LAUNCH_HEADER]: '1',
      };
      const result = checkRequestProtection('POST', headers, deps);
      expect(result.ok).toBe(deps.trustedOrigin !== undefined);
      // Configured planning origin permits a reverse proxy to rewrite Host, even for sessions.
      if (deps.mode !== 'release' && deps.trustedOrigin !== undefined) {
        expect(
          checkRequestProtection(
            'POST',
            {
              ...headers,
              authorization: undefined,
              cookie: 'ev_session=live',
              [CSRF_HEADER]: 'session-csrf',
            },
            deps,
          ).ok,
        ).toBe(true);
      }
    });

    it.each(['http://desk.example:8443', 'https://DESK.EXAMPLE:8443'])(
      'compares planning origins by host and port while releases remain strict: %s',
      (origin) => {
        const result = checkRequestProtection(
          'POST',
          {
            host: 'desk.example:8443',
            authorization,
            origin,
            [LAUNCH_HEADER]: '1',
          },
          deps,
        );
        expect(result.ok).toBe(deps.mode !== 'release');
      },
    );
  });
}

describe('release compatibility adapter', () => {
  it('keeps browser public Host enforcement and case-insensitive Host comparison', () => {
    for (const host of [undefined, 'internal:3000', 'DESK.EXAMPLE:8443']) {
      const result = checkReleaseAccess(
        'GET',
        { host, cookie: 'ev_session=live' },
        {
          ...authentication,
          publicOrigin: trustedOrigin,
        },
      );
      expect(outcome(result)).toBe(
        host === 'DESK.EXAMPLE:8443' ? 'browser' : '403:forbidden-origin',
      );
    }
  });
});

it('requires one exact launch-header value, including without login', () => {
  for (const policy of policies.filter(({ deps }) => deps.mode === 'refresh-launch')) {
    for (const value of [['1'], ['1', '1'], '1, 1', ' 1', 'true']) {
      expect(
        outcome(
          checkRequestProtection(
            'POST',
            {
              host: 'desk.example:8443',
              authorization,
              [LAUNCH_HEADER]: value,
            },
            policy.deps,
          ),
        ),
      ).toBe('403:missing-launch-header');
    }
  }
});

it('does not call authentication validators for a no-login refresh', () => {
  const unexpected = (): never => {
    throw new Error('authentication is disabled');
  };
  expect(
    checkRequestProtection(
      'POST',
      { [LAUNCH_HEADER]: '1', host: 'desk.example:8443' },
      {
        mode: 'refresh-launch',
        loginConfigured: false,
        sessionCsrf: unexpected,
        headerAuthenticated: unexpected,
        hasSessionCookie: authentication.hasSessionCookie,
      },
    ),
  ).toEqual({ ok: true, mode: 'anonymous' });
});
