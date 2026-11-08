import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_KEYWORDS, configFromEnv, loadConfig, parseConfig } from './load.js';

const MIN = `
sources:
  - id: gh
    kind: github
views:
  - id: v
    source: gh
    repos: [Acme/API]
`;

function withSource(sourceLines: string): string {
  return `
sources:
${sourceLines}
views:
  - id: v
    source: ${/id: (\S+)/.exec(sourceLines)![1]}
    repos: [a/b]
`;
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('parseConfig defaults', () => {
  it('applies every default', () => {
    const cfg = parseConfig(MIN, {});
    expect(cfg.server).toEqual({
      host: '0.0.0.0',
      port: 8080,
      publicOrigin: null,
      basicAuth: null,
    });
    expect(cfg.cache).toEqual({ ttlSeconds: 300 });
    expect(cfg.ui).toEqual({ refreshMinutes: 5 });
    expect(cfg.webhooks).toBeNull();
    expect(cfg.sources).toEqual([
      {
        id: 'gh',
        kind: 'github',
        baseUrl: 'https://api.github.com',
        webUrl: 'https://github.com',
        token: null,
        path: null,
        planning: {
          dependencies: { native: true, body: true, subIssues: false, keywords: DEFAULT_KEYWORDS },
          ordering: { priorityLabels: [], mode: 'priority' },
        },
      },
    ]);
    expect(cfg.views).toEqual([
      {
        id: 'v',
        title: 'v',
        source: 'gh',
        repos: [{ owner: 'acme', repo: 'api' }],
        dependencies: { native: true, body: true, subIssues: false, keywords: DEFAULT_KEYWORDS },
        scope: { labels: [], excludeLabels: [], milestones: [] },
        ordering: { priorityLabels: [], mode: 'priority' },
      },
    ]);
    expect(cfg.warnings).toEqual([]);
  });

  it('does not share the default keyword arrays', () => {
    const cfg = parseConfig(MIN, {});
    cfg.views[0]!.dependencies.keywords.blocks.push('x');
    expect(DEFAULT_KEYWORDS.blocks).toEqual(['blocks', 'blocking', 'required by']);
  });

  it('lowercases, dedupes and sorts repos', () => {
    const cfg = parseConfig(
      MIN.replace('[Acme/API]', '[Zed/Web, acme/api, ACME/API, acme/Web]'),
      {},
    );
    expect(cfg.views[0]!.repos).toEqual([
      { owner: 'acme', repo: 'api' },
      { owner: 'acme', repo: 'web' },
      { owner: 'zed', repo: 'web' },
    ]);
  });

  it('accepts a partial keywords object, filling missing kinds from the defaults', () => {
    const cfg = parseConfig(
      `${MIN}    dependencies:\n      keywords:\n        blockedBy: [needs]\n`,
      {},
    );
    expect(cfg.views[0]!.dependencies.keywords).toEqual({
      blockedBy: ['needs'],
      blocks: DEFAULT_KEYWORDS.blocks,
    });
  });

  it('accepts dependencies.body as a boolean or strict', () => {
    expect(parseConfig(MIN, {}).views[0]!.dependencies.body).toBe(true);
    expect(
      parseConfig(`${MIN}    dependencies:\n      body: false\n`, {}).views[0]!.dependencies.body,
    ).toBe(false);
    expect(
      parseConfig(`${MIN}    dependencies:\n      body: strict\n`, {}).views[0]!.dependencies.body,
    ).toBe('strict');
  });

  it('rejects an invalid dependencies.body', () => {
    const e = errorOf(() => parseConfig(`${MIN}    dependencies:\n      body: yes\n`, {}));
    expect(e.message).toContain('body');
  });

  it('uses an explicit title, scope and priority labels', () => {
    const cfg = parseConfig(
      `${MIN}    title: My view
    scope:
      labels: [a]
      excludeLabels: [b]
      milestones: [m1]
    ordering:
      priorityLabels: [P0, P1]
`,
      {},
    );
    const v = cfg.views[0]!;
    expect(v.title).toBe('My view');
    expect(v.scope).toEqual({ labels: ['a'], excludeLabels: ['b'], milestones: ['m1'] });
    expect(v.ordering.priorityLabels).toEqual(['P0', 'P1']);
  });

  it('defaults ordering.mode to priority and accepts waves', () => {
    expect(parseConfig(MIN, {}).views[0]!.ordering.mode).toBe('priority');
    expect(
      parseConfig(`${MIN}    ordering:\n      mode: priority\n`, {}).views[0]!.ordering.mode,
    ).toBe('priority');
    const cfg = parseConfig(`${MIN}    ordering:\n      mode: waves\n`, {});
    expect(cfg.views[0]!.ordering).toEqual({ priorityLabels: [], mode: 'waves' });
  });

  it('rejects an invalid ordering.mode', () => {
    const e = errorOf(() => parseConfig(`${MIN}    ordering:\n      mode: fastest\n`, {}));
    expect(e.message).toContain('ordering.mode');
  });
});

describe('webUrl derivation', () => {
  it('github.com, with and without trailing slash', () => {
    for (const base of ['https://api.github.com', 'https://api.github.com/']) {
      const cfg = parseConfig(withSource(`  - id: gh\n    kind: github\n    baseUrl: ${base}`), {});
      expect(cfg.sources[0]!.baseUrl).toBe('https://api.github.com');
      expect(cfg.sources[0]!.webUrl).toBe('https://github.com');
    }
  });

  it('GHES strips /api/v3', () => {
    const cfg = parseConfig(
      withSource('  - id: ghe\n    kind: github\n    baseUrl: https://ghe.example.com/api/v3/'),
      {},
    );
    expect(cfg.sources[0]!.baseUrl).toBe('https://ghe.example.com/api/v3');
    expect(cfg.sources[0]!.webUrl).toBe('https://ghe.example.com');
  });

  it('gitea uses baseUrl, trailing slashes stripped', () => {
    const cfg = parseConfig(
      withSource('  - id: gt\n    kind: gitea\n    baseUrl: https://gitea.example.com//'),
      {},
    );
    expect(cfg.sources[0]!.baseUrl).toBe('https://gitea.example.com');
    expect(cfg.sources[0]!.webUrl).toBe('https://gitea.example.com');
  });

  it('an explicit webUrl wins and has trailing slashes stripped', () => {
    const cfg = parseConfig(
      withSource(
        '  - id: gt\n    kind: gitea\n    baseUrl: http://10.0.0.5:3000\n    webUrl: https://git.example.com/',
      ),
      {},
    );
    expect(cfg.sources[0]!.webUrl).toBe('https://git.example.com');
  });

  it('fixture has empty baseUrl and webUrl unless given', () => {
    const plain = parseConfig(withSource('  - id: f\n    kind: fixture\n    path: a.json'), {});
    expect(plain.sources[0]!.baseUrl).toBe('');
    expect(plain.sources[0]!.webUrl).toBe('');
    const given = parseConfig(
      withSource('  - id: f\n    kind: fixture\n    path: a.json\n    webUrl: https://x.test/'),
      {},
    );
    expect(given.sources[0]!.webUrl).toBe('https://x.test');
  });
});

describe('tokens', () => {
  const src = (extra: string) => withSource(`  - id: gh\n    kind: github\n${extra}`);

  it('reads tokenEnv from the environment', () => {
    const cfg = parseConfig(src('    tokenEnv: MY_TOKEN'), { MY_TOKEN: 'abc' });
    expect(cfg.sources[0]!.token).toBe('abc');
    expect(cfg.warnings).toEqual([]);
  });

  it('a missing tokenEnv gives a null token and a warning', () => {
    const cfg = parseConfig(src('    tokenEnv: MY_TOKEN'), {});
    expect(cfg.sources[0]!.token).toBeNull();
    expect(cfg.warnings).toHaveLength(1);
    expect(cfg.warnings![0]).toContain('MY_TOKEN');
    expect(cfg.warnings![0]).toContain('"gh"');
  });

  it('allows an inline token', () => {
    const cfg = parseConfig(src('    token: inline'), {});
    expect(cfg.sources[0]!.token).toBe('inline');
  });

  it('tokenEnv wins over the inline token when set, else the inline token is used', () => {
    const both = src('    tokenEnv: MY_TOKEN\n    token: inline');
    expect(parseConfig(both, { MY_TOKEN: 'fromenv' }).sources[0]!.token).toBe('fromenv');
    const missing = parseConfig(both, {});
    expect(missing.sources[0]!.token).toBe('inline');
  });
});

describe('validation errors', () => {
  it('duplicate source id', () => {
    const e = errorOf(() =>
      parseConfig(
        `
sources:
  - { id: gh, kind: github }
  - { id: gh, kind: github }
views:
  - { id: v, source: gh, repos: [a/b] }
`,
        {},
      ),
    );
    expect(e.message).toContain('sources[1].id: duplicate source id "gh"');
  });

  it('duplicate view id', () => {
    const e = errorOf(() =>
      parseConfig(
        `
sources:
  - { id: gh, kind: github }
views:
  - { id: v, source: gh, repos: [a/b] }
  - { id: v, source: gh, repos: [a/c] }
`,
        {},
      ),
    );
    expect(e.message).toContain('views[1].id: duplicate view id "v"');
  });

  it('unknown source', () => {
    const e = errorOf(() =>
      parseConfig(
        `
sources:
  - { id: gh, kind: github }
  - { id: gt, kind: gitea, baseUrl: 'https://g.test' }
views:
  - { id: v, source: gh2, repos: [a/b] }
`,
        {},
      ),
    );
    expect(e.message).toContain('views[0].source: unknown source "gh2" (known: gh, gt)');
  });

  it('bad repo format', () => {
    const e = errorOf(() => parseConfig(MIN.replace('[Acme/API]', '[acme/api, nonsense]'), {}));
    expect(e.message).toContain('views[0].repos[1]: invalid repo "nonsense" (expected owner/repo)');
  });

  it('requires at least one repo', () => {
    const e = errorOf(() => parseConfig(MIN.replace('[Acme/API]', '[]'), {}));
    expect(e.message).toContain('views[0].repos');
    expect(e.message).toContain('at least one repo');
  });

  it('bad ids', () => {
    const e = errorOf(() => parseConfig(MIN.replace('id: v', 'id: Bad_Id'), {}));
    expect(e.message).toContain('views[0].id: invalid id "Bad_Id"');
    const e2 = errorOf(() => parseConfig(MIN.replace('id: gh', 'id: -x'), {}));
    expect(e2.message).toContain('sources[0].id: invalid id "-x"');
  });

  it('gitea requires baseUrl and fixture requires path', () => {
    const g = errorOf(() => parseConfig(withSource('  - id: gt\n    kind: gitea'), {}));
    expect(g.message).toContain('sources[0].baseUrl: baseUrl is required for gitea sources');
    const f = errorOf(() => parseConfig(withSource('  - id: f\n    kind: fixture'), {}));
    expect(f.message).toContain('sources[0].path: path is required for fixture sources');
  });

  it('aggregates several issues into one message', () => {
    const e = errorOf(() =>
      parseConfig(
        `
server: { port: 70000 }
sources:
  - { id: gh, kind: nope }
views:
  - { id: v, source: gh, repos: [bad] }
`,
        {},
      ),
    );
    expect(e.message).toContain('server.port');
    expect(e.message).toContain('sources[0].kind');
    expect(e.message).toContain('views[0].repos[0]');
  });

  it('rejects unknown keys, invalid YAML and empty documents', () => {
    expect(errorOf(() => parseConfig(MIN + '    bogus: 1\n', {})).message).toContain('bogus');
    expect(errorOf(() => parseConfig('a: [', {})).message).toContain('Invalid YAML');
    expect(errorOf(() => parseConfig('', {})).message).toContain('sources');
  });

  it('accepts any whole cache.ttlSeconds, however large, and rejects a fraction', () => {
    const big = parseConfig(`cache: { ttlSeconds: 10000000000000000 }\n${MIN}`, {});
    expect(big.cache.ttlSeconds).toBe(1e16);
    const e = errorOf(() => parseConfig(`cache: { ttlSeconds: 1.5 }\n${MIN}`, {}));
    expect(e.message).toContain('cache.ttlSeconds');
  });
});

describe('basicAuth', () => {
  const auth = (lines: string) =>
    `${MIN.replace('sources:', `server:\n  basicAuth:\n${lines}\nsources:`)}`;

  it('via passwordEnv', () => {
    const cfg = parseConfig(auth('    username: admin\n    passwordEnv: PW'), { PW: 's3cret' });
    expect(cfg.server.basicAuth).toEqual({ username: 'admin', password: 's3cret' });
  });

  it('via inline password', () => {
    const cfg = parseConfig(auth('    username: admin\n    password: pw'), {});
    expect(cfg.server.basicAuth).toEqual({ username: 'admin', password: 'pw' });
  });

  it('errors when no password is available', () => {
    const e = errorOf(() => parseConfig(auth('    username: admin'), {}));
    expect(e.message).toContain('server.basicAuth');
    const e2 = errorOf(() => parseConfig(auth('    username: admin\n    passwordEnv: PW'), {}));
    expect(e2.message).toContain('PW');
  });

  it('rejects an empty username and an unknown key', () => {
    expect(
      errorOf(() => parseConfig(auth('    username: ""\n    password: pw'), {})).message,
    ).toContain('server.basicAuth.username');
    expect(
      errorOf(() => parseConfig(auth('    username: admin\n    password: pw\n    role: x'), {}))
        .message,
    ).toContain('role');
  });

  it('FD_BASIC_AUTH overrides, splitting on the first colon', () => {
    const cfg = parseConfig(auth('    username: admin\n    password: pw'), {
      FD_BASIC_AUTH: 'bob:pa:ss',
    });
    expect(cfg.server.basicAuth).toEqual({ username: 'bob', password: 'pa:ss' });
    const plain = parseConfig(MIN, { FD_BASIC_AUTH: 'bob:pw' });
    expect(plain.server.basicAuth).toEqual({ username: 'bob', password: 'pw' });
  });

  it('rejects a malformed FD_BASIC_AUTH', () => {
    expect(errorOf(() => parseConfig(MIN, { FD_BASIC_AUTH: 'nocolon' })).message).toContain(
      'FD_BASIC_AUTH',
    );
  });
});

describe('webhooks', () => {
  const hooks = (lines: string) => MIN.replace('sources:', `webhooks:\n${lines}\nsources:`);

  it('is disabled by default', () => {
    const cfg = parseConfig(MIN, {});
    expect(cfg.webhooks).toBeNull();
    expect(cfg.warnings).toEqual([]);
  });

  it('via secretEnv', () => {
    const cfg = parseConfig(hooks('  secretEnv: HOOK'), { HOOK: 'from-env' });
    expect(cfg.webhooks).toEqual({ secret: 'from-env' });
    expect(cfg.warnings).toEqual([]);
  });

  it('via inline secret', () => {
    const cfg = parseConfig(hooks('  secret: inline'), {});
    expect(cfg.webhooks).toEqual({ secret: 'inline' });
  });

  it('secretEnv wins over the inline secret when its variable is set', () => {
    const text = hooks('  secretEnv: HOOK\n  secret: inline');
    expect(parseConfig(text, { HOOK: 'from-env' }).webhooks).toEqual({ secret: 'from-env' });
    const fallback = parseConfig(text, {});
    expect(fallback.webhooks).toEqual({ secret: 'inline' });
    expect(fallback.warnings).toEqual([]);
  });

  it('a missing env var warns and disables webhooks', () => {
    const cfg = parseConfig(hooks('  secretEnv: HOOK'), { HOOK: '  ' });
    expect(cfg.webhooks).toBeNull();
    expect(cfg.warnings).toHaveLength(1);
    expect(cfg.warnings![0]).toContain('HOOK');
    expect(cfg.warnings![0]).toContain('webhooks are disabled');
  });

  it('a block without any secret warns and disables webhooks', () => {
    const cfg = parseConfig(hooks('  secret: ""'), {});
    expect(cfg.webhooks).toBeNull();
    expect(cfg.warnings![0]).toContain('no secret');
  });

  it('FD_WEBHOOK_SECRET overrides the file, and enables webhooks without a block', () => {
    const cfg = parseConfig(hooks('  secret: inline'), { FD_WEBHOOK_SECRET: 'override' });
    expect(cfg.webhooks).toEqual({ secret: 'override' });
    expect(parseConfig(MIN, { FD_WEBHOOK_SECRET: 'only-env' }).webhooks).toEqual({
      secret: 'only-env',
    });
  });

  it('FD_WEBHOOK_SECRET also works in env-only mode', () => {
    const cfg = configFromEnv({
      FD_PROVIDER: 'github',
      FD_REPOS: 'a/b',
      FD_WEBHOOK_SECRET: 's',
    });
    expect(cfg.webhooks).toEqual({ secret: 's' });
    expect(configFromEnv({ FD_PROVIDER: 'github', FD_REPOS: 'a/b' }).webhooks).toBeNull();
  });

  it('rejects unknown keys', () => {
    expect(errorOf(() => parseConfig(hooks('  bogus: 1'), {})).message).toContain('bogus');
  });
});

describe('FD_* overrides', () => {
  it('FD_HOST, FD_PORT, FD_CACHE_TTL and FD_REFRESH_MINUTES override the file', () => {
    const yaml = `server: { host: 1.2.3.4, port: 9000 }\ncache: { ttlSeconds: 10 }\nui: { refreshMinutes: 15 }\n${MIN}`;
    const base = parseConfig(yaml, {});
    expect(base.server).toMatchObject({ host: '1.2.3.4', port: 9000 });
    expect(base.cache.ttlSeconds).toBe(10);
    expect(base.ui.refreshMinutes).toBe(15);
    const cfg = parseConfig(yaml, {
      FD_HOST: 'localhost',
      FD_PORT: '3000',
      FD_CACHE_TTL: '0',
      FD_REFRESH_MINUTES: '0',
    });
    expect(cfg.server).toMatchObject({ host: 'localhost', port: 3000 });
    expect(cfg.cache.ttlSeconds).toBe(0);
    expect(cfg.ui.refreshMinutes).toBe(0);
  });

  it('validates FD_PORT and FD_CACHE_TTL', () => {
    for (const port of ['0', '65536', 'abc', '1.5', '-1']) {
      expect(errorOf(() => parseConfig(MIN, { FD_PORT: port })).message).toContain('FD_PORT');
    }
    expect(parseConfig(MIN, { FD_PORT: '65535' }).server.port).toBe(65535);
    for (const ttl of ['-1', 'x', '2.5']) {
      expect(errorOf(() => parseConfig(MIN, { FD_CACHE_TTL: ttl })).message).toContain(
        'FD_CACHE_TTL',
      );
    }
    for (const minutes of ['-1', 'x', '2.5', '1441']) {
      expect(errorOf(() => parseConfig(MIN, { FD_REFRESH_MINUTES: minutes })).message).toContain(
        'FD_REFRESH_MINUTES',
      );
    }
    expect(parseConfig(MIN, { FD_REFRESH_MINUTES: '1440' }).ui.refreshMinutes).toBe(1440);
    expect(
      errorOf(() => parseConfig(`ui: { refreshMinutes: 1441 }\n${MIN}`, {})).message,
    ).toContain('refreshMinutes');
  });

  it('treats empty values as unset', () => {
    const cfg = parseConfig(MIN, { FD_PORT: '', FD_HOST: '  ' });
    expect(cfg.server).toMatchObject({ host: '0.0.0.0', port: 8080 });
  });
});

describe('EV_* names from before 3.0.1', () => {
  const deprecated = (warnings: string[] | undefined) =>
    (warnings ?? []).filter((w) => w.includes('is deprecated'));

  it('still apply alone, and each one warns with its FD_ name', () => {
    const cfg = parseConfig(MIN, { EV_PORT: '3000', EV_REFRESH_MINUTES: '5' });
    expect(cfg.server.port).toBe(3000);
    expect(cfg.ui.refreshMinutes).toBe(5);
    expect(deprecated(cfg.warnings)).toEqual([
      'EV_PORT is deprecated: rename it to FD_PORT',
      'EV_REFRESH_MINUTES is deprecated: rename it to FD_REFRESH_MINUTES',
    ]);
    expect(deprecated(parseConfig(MIN, { FD_PORT: '3000' }).warnings)).toEqual([]);
  });

  it('win over a conflicting FD_ value, such as the image default FD_PORT', () => {
    const cfg = parseConfig(MIN, {
      FD_HOST: '0.0.0.0',
      FD_PORT: '8080',
      EV_HOST: '127.0.0.1',
      EV_PORT: '9000',
    });
    expect(cfg.server).toMatchObject({ host: '127.0.0.1', port: 9000 });
    expect(deprecated(cfg.warnings)).toContain(
      'EV_PORT is deprecated: rename it to FD_PORT (EV_PORT overrides FD_PORT)',
    );
  });

  it('keep the login: FD_BASIC_AUTH and EV_BASIC_AUTH both enable it', () => {
    const login = { username: 'ops', password: 'pa:ss' };
    expect(parseConfig(MIN, { FD_BASIC_AUTH: 'ops:pa:ss' }).server.basicAuth).toEqual(login);
    expect(parseConfig(MIN, { EV_BASIC_AUTH: 'ops:pa:ss' }).server.basicAuth).toEqual(login);
    // A blank legacy value counts as unset, so a renamed FD_BASIC_AUTH still applies.
    expect(
      parseConfig(MIN, { EV_BASIC_AUTH: '', FD_BASIC_AUTH: 'ops:pa:ss' }).server.basicAuth,
    ).toEqual(login);
  });

  it('reject a malformed login value under the name that was set', () => {
    expect(errorOf(() => parseConfig(MIN, { FD_BASIC_AUTH: 'nocolon' })).message).toBe(
      'FD_BASIC_AUTH: expected "user:password"',
    );
    expect(errorOf(() => parseConfig(MIN, { EV_BASIC_AUTH: 'ops:' })).message).toBe(
      'EV_BASIC_AUTH: expected "user:password"',
    );
  });

  it('still drive env-only mode', () => {
    const cfg = configFromEnv({ EV_PROVIDER: 'github', EV_REPOS: 'a/b, c/d', EV_VIEW_ID: 'old' });
    expect(cfg.views[0]).toMatchObject({
      id: 'old',
      repos: [
        { owner: 'a', repo: 'b' },
        { owner: 'c', repo: 'd' },
      ],
    });
    expect(deprecated(cfg.warnings)).toHaveLength(3);
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ev-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves fixture paths relative to the config file directory', () => {
    const sub = join(dir, 'conf');
    mkdirSync(sub);
    writeFileSync(
      join(sub, 'my.yaml'),
      `
sources:
  - { id: demo, kind: fixture, path: ./data/demo.json }
  - { id: abs, kind: fixture, path: /abs/x.json }
views:
  - { id: v, source: demo, repos: [a/b] }
`,
    );
    const cfg = loadConfig({ path: join(sub, 'my.yaml'), env: {}, cwd: dir });
    expect(cfg.sources[0]!.path).toBe(resolve(sub, 'data/demo.json'));
    expect(cfg.sources[1]!.path).toBe('/abs/x.json');
  });

  it('path precedence: opts.path, then FD_CONFIG, then <cwd>/config.yaml', () => {
    const mk = (name: string, id: string) =>
      writeFileSync(
        join(dir, name),
        `sources: [{ id: gh, kind: github }]\nviews: [{ id: ${id}, source: gh, repos: [a/b] }]\n`,
      );
    mk('config.yaml', 'fromcwd');
    mk('env.yaml', 'fromenv');
    mk('opt.yaml', 'fromopt');
    expect(loadConfig({ env: {}, cwd: dir }).views[0]!.id).toBe('fromcwd');
    expect(loadConfig({ env: { FD_CONFIG: 'env.yaml' }, cwd: dir }).views[0]!.id).toBe('fromenv');
    expect(
      loadConfig({ path: 'opt.yaml', env: { FD_CONFIG: 'env.yaml' }, cwd: dir }).views[0]!.id,
    ).toBe('fromopt');
  });

  it('errors on an explicit path that does not exist', () => {
    const missing = join(dir, 'nope.yaml');
    const e = errorOf(() =>
      loadConfig({ path: missing, env: { FD_PROVIDER: 'github' }, cwd: dir }),
    );
    expect(e.message).toContain('Config file not found');
    expect(e.message).toContain(missing);
    const e2 = errorOf(() => loadConfig({ env: { FD_CONFIG: 'nope.yaml' }, cwd: dir }));
    expect(e2.message).toContain('Config file not found');
  });

  it('prefixes validation errors with the file path', () => {
    writeFileSync(join(dir, 'config.yaml'), 'sources: []\nviews: []\n');
    const e = errorOf(() => loadConfig({ env: {}, cwd: dir }));
    expect(e.message).toContain(join(dir, 'config.yaml'));
    expect(e.message).toContain('at least one source is required');
  });

  it('fails clearly with neither a file nor FD_PROVIDER', () => {
    const e = errorOf(() => loadConfig({ env: {}, cwd: dir }));
    expect(e.message).toBe(
      'No configuration found: create config.yaml (see config.example.yaml), set FD_CONFIG, or set FD_PROVIDER and FD_REPOS for env-only mode',
    );
  });

  describe('env-only mode', () => {
    it('github with the GITHUB_TOKEN fallback', () => {
      const cfg = loadConfig({
        env: { FD_PROVIDER: 'github', FD_REPOS: 'Acme/API, acme/web,', GITHUB_TOKEN: 'ghtok' },
        cwd: dir,
      });
      expect(cfg.sources).toEqual([
        {
          id: 'default',
          kind: 'github',
          baseUrl: 'https://api.github.com',
          webUrl: 'https://github.com',
          token: 'ghtok',
          path: null,
          planning: {
            dependencies: {
              native: true,
              body: true,
              subIssues: false,
              keywords: DEFAULT_KEYWORDS,
            },
            ordering: { priorityLabels: [], mode: 'priority' },
          },
        },
      ]);
      expect(cfg.views).toHaveLength(1);
      expect(cfg.views[0]).toMatchObject({
        id: 'default',
        title: 'default',
        source: 'default',
        repos: [
          { owner: 'acme', repo: 'api' },
          { owner: 'acme', repo: 'web' },
        ],
        dependencies: { native: true, body: true, subIssues: false },
        ordering: { priorityLabels: [], mode: 'priority' },
      });
      expect(cfg.server).toEqual({
        host: '0.0.0.0',
        port: 8080,
        publicOrigin: null,
        basicAuth: null,
      });
    });

    it('FD_TOKEN wins over GITHUB_TOKEN', () => {
      const cfg = loadConfig({
        env: { FD_PROVIDER: 'github', FD_REPOS: 'a/b', FD_TOKEN: 'ev', GITHUB_TOKEN: 'gh' },
        cwd: dir,
      });
      expect(cfg.sources[0]!.token).toBe('ev');
    });

    it('gitea with base URL, token fallback, view options and overrides', () => {
      const cfg = loadConfig({
        env: {
          FD_PROVIDER: 'gitea',
          FD_REPOS: 'team/app',
          FD_BASE_URL: 'https://gitea.example.com/',
          GITEA_TOKEN: 'gttok',
          GITHUB_TOKEN: 'ignored',
          FD_VIEW_ID: 'main',
          FD_VIEW_TITLE: 'Main view',
          FD_PRIORITY_LABELS: 'P0, P1 ,P2',
          FD_SUB_ISSUES: 'true',
          FD_PORT: '9090',
        },
        cwd: dir,
      });
      expect(cfg.sources[0]).toMatchObject({
        id: 'default',
        kind: 'gitea',
        baseUrl: 'https://gitea.example.com',
        webUrl: 'https://gitea.example.com',
        token: 'gttok',
      });
      expect(cfg.views[0]).toMatchObject({
        id: 'main',
        title: 'Main view',
        ordering: { priorityLabels: ['P0', 'P1', 'P2'] },
        dependencies: { subIssues: true },
      });
      expect(cfg.server.port).toBe(9090);
    });

    it('FD_ORDERING_MODE selects the ordering mode (default priority)', () => {
      const base = { FD_PROVIDER: 'github', FD_REPOS: 'a/b' };
      expect(loadConfig({ env: base, cwd: dir }).views[0]!.ordering.mode).toBe('priority');
      const cfg = loadConfig({ env: { ...base, FD_ORDERING_MODE: 'waves' }, cwd: dir });
      expect(cfg.views[0]!.ordering.mode).toBe('waves');
      const upper = loadConfig({ env: { ...base, FD_ORDERING_MODE: 'Priority' }, cwd: dir });
      expect(upper.views[0]!.ordering.mode).toBe('priority');
    });

    it('rejects an invalid FD_ORDERING_MODE with a readable message', () => {
      const e = errorOf(() =>
        loadConfig({
          env: { FD_PROVIDER: 'github', FD_REPOS: 'a/b', FD_ORDERING_MODE: 'fastest' },
          cwd: dir,
        }),
      );
      expect(e.message).toBe('FD_ORDERING_MODE: expected "priority" or "waves" (got "fastest")');
    });

    it('gitea without FD_BASE_URL is an error', () => {
      const e = errorOf(() =>
        loadConfig({ env: { FD_PROVIDER: 'gitea', FD_REPOS: 'a/b' }, cwd: dir }),
      );
      expect(e.message).toContain('baseUrl is required');
    });

    it('a missing FD_REPOS is an error', () => {
      const e = errorOf(() => loadConfig({ env: { FD_PROVIDER: 'github' }, cwd: dir }));
      expect(e.message).toContain('FD_REPOS');
    });

    it('rejects a bad FD_PROVIDER, FD_REPOS entry and FD_SUB_ISSUES', () => {
      expect(
        errorOf(() => loadConfig({ env: { FD_PROVIDER: 'gitlab', FD_REPOS: 'a/b' }, cwd: dir }))
          .message,
      ).toContain('FD_PROVIDER');
      expect(
        errorOf(() => loadConfig({ env: { FD_PROVIDER: 'github', FD_REPOS: 'oops' }, cwd: dir }))
          .message,
      ).toContain('invalid repo "oops"');
      expect(
        errorOf(() =>
          loadConfig({
            env: { FD_PROVIDER: 'github', FD_REPOS: 'a/b', FD_SUB_ISSUES: 'maybe' },
            cwd: dir,
          }),
        ).message,
      ).toContain('FD_SUB_ISSUES');
    });

    it('a config file takes precedence over FD_PROVIDER', () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'sources: [{ id: gh, kind: github }]\nviews: [{ id: filev, source: gh, repos: [a/b] }]\n',
      );
      const cfg = loadConfig({ env: { FD_PROVIDER: 'github', FD_REPOS: 'x/y' }, cwd: dir });
      expect(cfg.views[0]!.id).toBe('filev');
    });
  });
});

describe('config.example.yaml', () => {
  it('parses successfully', () => {
    const text = readFileSync(new URL('../../config.example.yaml', import.meta.url), 'utf8');
    const cfg = parseConfig(
      text,
      { GITHUB_TOKEN: 't', GITEA_TOKEN: 't', FD_BASIC_AUTH_PASSWORD: 'pw' },
      { baseDir: '/repo' },
    );
    expect(cfg.warnings).toEqual([]);
    expect(cfg.sources.map((s) => s.id)).toEqual(['gh', 'gt', 'demo']);
    expect(cfg.views.map((v) => v.id)).toEqual(['platform', 'self-hosted', 'demo']);
    expect(cfg.server.basicAuth).toEqual({ username: 'admin', password: 'pw' });
    expect(cfg.sources[2]!.path).toBe('/repo/test/fixtures/demo.json');
  });
});

describe('release configuration', () => {
  type Json = Record<string, any>;

  function rawConfig(): Json {
    return {
      server: { basicAuth: { username: 'admin', password: 'pw' } },
      sources: [
        {
          id: 'gt',
          kind: 'gitea',
          baseUrl: 'https://gitea.example.com',
          tokenEnv: 'GITEA_READ_TOKEN',
        },
      ],
      views: [{ id: 'v', source: 'gt', repos: ['example/app'] }],
      releases: {
        enabled: true,
        publicOrigin: 'https://forge-desk.example.com/',
        stateDir: '/var/lib/forge-desk',
        repositories: [
          {
            id: 'app',
            source: 'gt',
            repo: 'Example/App',
            origin: 'ssh://git@gitea.example.com/example/app.git',
            apiTokenFile: '/run/secrets/forge_desk_release_token',
            expectedApiUser: 'release-bot',
            ci: { workflowPath: '.gitea/workflows/validate.yaml' },
            ssh: {
              privateKeyFile: '/run/secrets/forge_desk_release_key',
              knownHostsFile: '/run/secrets/forge_desk_known_hosts',
            },
            tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.com' },
          },
        ],
      },
    };
  }

  function withReleases(mutate?: (releases: Json, config: Json) => void): Json {
    const config = rawConfig();
    mutate?.(config['releases'], config);
    return config;
  }

  function releaseError(mutate?: (releases: Json, config: Json) => void): ConfigError {
    return errorOf(() => parseConfig(JSON.stringify(withReleases(mutate)), {}));
  }

  it('is disabled by default and keeps planning-only configs unchanged', () => {
    expect(parseConfig(MIN, {}).releases).toEqual({ enabled: false });
    const withoutLogin = withReleases((r) => {
      r['enabled'] = false;
    });
    delete withoutLogin['server'];
    expect(parseConfig(JSON.stringify(withoutLogin), {}).releases).toEqual({ enabled: false });
    expect(
      parseConfig(
        JSON.stringify({ sources: withoutLogin['sources'], views: withoutLogin['views'] }),
        {},
      ).releases,
    ).toEqual({ enabled: false });
    // A stale, partial release block left behind after disabling must not stop Planning.
    const partial = withReleases((r) => {
      r['enabled'] = false;
      r['repositories'] = [{ id: 'app' }];
    });
    delete partial['server'];
    expect(parseConfig(JSON.stringify(partial), {}).releases).toEqual({ enabled: false });
  });

  it('leaves environment-only deployments without release configuration', () => {
    const cfg = configFromEnv({
      FD_PROVIDER: 'gitea',
      FD_REPOS: 'example/app',
      FD_BASE_URL: 'https://gitea.example.com',
    });
    expect(cfg.releases).toEqual({ enabled: false });
  });

  it('resolves a valid opt-in release repository', () => {
    const cfg = parseConfig(JSON.stringify(withReleases()), {});
    expect(cfg.releases).toEqual({
      enabled: true,
      publicOrigin: 'https://forge-desk.example.com',
      stateDir: '/var/lib/forge-desk',
      repositories: [
        {
          id: 'app',
          source: 'gt',
          repo: { owner: 'example', repo: 'app' },
          origin: 'ssh://git@gitea.example.com/example/app.git',
          token: { kind: 'file', path: '/run/secrets/forge_desk_release_token' },
          expectedApiUser: 'release-bot',
          ci: { workflowPath: '.gitea/workflows/validate.yaml' },
          ssh: {
            privateKeyFile: '/run/secrets/forge_desk_release_key',
            knownHostsFile: '/run/secrets/forge_desk_known_hosts',
          },
          tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.com' },
        },
      ],
    });
  });

  it('accepts either token selector and loopback HTTP only for a test origin', () => {
    const envToken = withReleases((r) => {
      const repo = r['repositories'][0];
      delete repo.apiTokenFile;
      repo.apiTokenEnv = 'RELEASE_TOKEN';
      r['publicOrigin'] = 'http://127.0.0.1:8080';
    });
    const cfg = parseConfig(JSON.stringify(envToken), {});
    expect(cfg.releases).toMatchObject({
      enabled: true,
      publicOrigin: 'http://127.0.0.1:8080',
      repositories: [{ token: { kind: 'env', name: 'RELEASE_TOKEN' } }],
    });
    expect(
      parseConfig(
        JSON.stringify(withReleases((r) => (r['publicOrigin'] = 'http://localhost:3000'))),
        {},
      ).releases,
    ).toMatchObject({ publicOrigin: 'http://localhost:3000' });
    // The stored origin is what a browser serializes, not the raw spelling.
    expect(
      parseConfig(
        JSON.stringify(withReleases((r) => (r['publicOrigin'] = 'HTTPS://DESK.EXAMPLE:443'))),
        {},
      ).releases,
    ).toMatchObject({ publicOrigin: 'https://desk.example' });
  });

  describe('Gitea source release defaults', () => {
    function inheritedConfig(): Json {
      const config = rawConfig();
      const { id, source, repo, origin, ...defaults } = config['releases'].repositories[0];
      config['sources'][0].releases = defaults;
      config['releases'].repositories = [{ id, source, repo, origin }];
      return config;
    }

    function resolve(config: Json) {
      return parseConfig(JSON.stringify(config), {});
    }

    function defaultsError(mutate: (config: Json) => void): string {
      const config = inheritedConfig();
      mutate(config);
      return errorOf(() => resolve(config)).message;
    }

    it('resolves inherited defaults identically to explicit repository values without leaking them', () => {
      const config = inheritedConfig();
      expect(resolve(config)).toEqual(resolve(rawConfig()));
      const before = JSON.stringify(config);
      expect(resolve(config).releases).toEqual(resolve(config).releases);
      expect(JSON.stringify(config)).toBe(before);
      expect(resolve(config).sources[0]).not.toHaveProperty('releases');
      expect(JSON.stringify(resolve(config).catalog)).not.toContain('/run/secrets');
    });

    it('inherits into multiple allowlisted repositories without sharing nested objects', () => {
      const config = inheritedConfig();
      config['releases'].repositories.push({
        id: 'other',
        source: 'gt',
        repo: 'example/other',
        origin: 'ssh://git@gitea.example.com/example/other.git',
      });
      const result = resolve(config);
      if (!result.releases.enabled) throw new Error('expected enabled releases');
      const [first, second] = result.releases.repositories;
      expect(second).toMatchObject({
        id: 'other',
        token: first!.token,
        ssh: first!.ssh,
        tagger: first!.tagger,
        ci: first!.ci,
      });
      first!.ssh.privateKeyFile = '/changed/key';
      first!.tagger.name = 'Changed';
      first!.ci.workflowPath = 'changed.yml';
      expect(second!.ssh.privateKeyFile).toBe('/run/secrets/forge_desk_release_key');
      expect(second!.tagger.name).toBe('Forge Desk Release Bot');
      expect(second!.ci.workflowPath).toBe('.gitea/workflows/validate.yaml');
      // Release defaults/repositories do not add projects or expand the release allowlist.
      expect(result.catalog).toEqual(resolve(rawConfig()).catalog);
      config['releases'].repositories = [];
      expect(errorOf(() => resolve(config)).message).toContain('at least one release repository');
    });

    it('overrides every field and inherits omitted nested fields', () => {
      const config = inheritedConfig();
      Object.assign(config['releases'].repositories[0], {
        apiTokenFile: '/override/token',
        expectedApiUser: 'other-bot',
        ci: { workflowPath: '.gitea/workflows/other.yml' },
        ssh: { privateKeyFile: '/override/key' },
        tagger: { email: 'other@example.com' },
      });
      expect(resolve(config).releases).toMatchObject({
        repositories: [
          {
            token: { kind: 'file', path: '/override/token' },
            expectedApiUser: 'other-bot',
            ci: { workflowPath: '.gitea/workflows/other.yml' },
            ssh: {
              privateKeyFile: '/override/key',
              knownHostsFile: '/run/secrets/forge_desk_known_hosts',
            },
            tagger: { name: 'Forge Desk Release Bot', email: 'other@example.com' },
          },
        ],
      });
      config['releases'].repositories[0].ssh = { knownHostsFile: '/override/hosts' };
      config['releases'].repositories[0].tagger = { name: 'Other Bot' };
      expect(resolve(config).releases).toMatchObject({
        repositories: [
          {
            ssh: {
              privateKeyFile: '/run/secrets/forge_desk_release_key',
              knownHostsFile: '/override/hosts',
            },
            tagger: { name: 'Other Bot', email: 'releases@example.com' },
          },
        ],
      });
    });

    it.each(['file', 'env'] as const)('replaces a source %s token selector as a unit', (kind) => {
      const config = inheritedConfig();
      const defaults = config['sources'][0].releases;
      const repository = config['releases'].repositories[0];
      if (kind === 'file') {
        repository.apiTokenEnv = 'OTHER_TOKEN';
        expect(resolve(config).releases).toMatchObject({
          repositories: [{ token: { kind: 'env', name: 'OTHER_TOKEN' } }],
        });
      } else {
        delete defaults.apiTokenFile;
        defaults.apiTokenEnv = 'SOURCE_TOKEN';
        expect(resolve(config).releases).toMatchObject({
          repositories: [{ token: { kind: 'env', name: 'SOURCE_TOKEN' } }],
        });
        repository.apiTokenFile = '/override/token';
        expect(resolve(config).releases).toMatchObject({
          repositories: [{ token: { kind: 'file', path: '/override/token' } }],
        });
        delete repository.apiTokenFile;
        repository.apiTokenEnv = 'OTHER_TOKEN';
        expect(resolve(config).releases).toMatchObject({
          repositories: [{ token: { kind: 'env', name: 'OTHER_TOKEN' } }],
        });
      }
    });

    it('supports partial defaults and keeps separate source ids isolated on the same forge', () => {
      const config = inheritedConfig();
      const original = rawConfig()['releases'].repositories[0];
      config['sources'][0].releases = {
        ssh: { privateKeyFile: '/shared/key' },
        tagger: { name: 'Shared' },
      };
      config['releases'].repositories[0] = {
        ...original,
        ssh: { knownHostsFile: '/repo/hosts' },
        tagger: { email: 'repo@example.com' },
      };
      config['sources'].push({
        ...config['sources'][0],
        id: 'other',
        releases: { expectedApiUser: 'other-bot' },
      });
      config['releases'].repositories.push({ ...original, id: 'other', source: 'other' });
      delete config['releases'].repositories[1].expectedApiUser;
      expect(resolve(config).releases).toMatchObject({
        repositories: [
          {
            expectedApiUser: 'release-bot',
            ssh: { privateKeyFile: '/shared/key', knownHostsFile: '/repo/hosts' },
            tagger: { name: 'Shared', email: 'repo@example.com' },
          },
          { expectedApiUser: 'other-bot', ssh: original.ssh, tagger: original.tagger },
        ],
      });
    });

    it.each(['apiTokenFile', 'expectedApiUser', 'ci', 'ssh', 'tagger'])(
      'requires %s after merging',
      (key) => {
        expect(
          defaultsError((config) => {
            delete config['sources'][0].releases[key];
          }),
        ).toContain(`releases.repositories[0].${key}`);
      },
    );

    it('never substitutes the planning token for the release token', () => {
      expect(
        defaultsError((config) => {
          delete config['sources'][0].releases.apiTokenFile;
          config['sources'][0].token = 'planning-only-secret';
        }),
      ).toContain('exactly one of apiTokenFile or apiTokenEnv');
    });

    it.each(['id', 'source', 'repo', 'origin', 'token', 'repositories', 'enabled'])(
      'rejects %s in source defaults',
      (key) => {
        const message = defaultsError((config) => {
          config['sources'][0].releases[key] = 'private-value';
        });
        expect(message).toContain('sources[0].releases');
        expect(message).toContain(key);
        expect(message).not.toContain('private-value');
      },
    );

    it('rejects conflicting token selectors at either level', () => {
      expect(
        defaultsError((config) => {
          config['sources'][0].releases.apiTokenEnv = 'SOURCE_TOKEN';
          config['releases'].repositories[0].apiTokenEnv = 'OVERRIDE_TOKEN';
        }),
      ).toContain('sources[0].releases.apiTokenFile: at most one');
      expect(
        defaultsError((config) => {
          Object.assign(config['releases'].repositories[0], {
            apiTokenEnv: 'TOKEN',
            apiTokenFile: '/a/token',
          });
        }),
      ).toContain('releases.repositories[0].apiTokenFile: exactly one');
    });

    it.each([
      ['apiTokenFile', 'private-value'],
      ['apiTokenEnv', 'private-value'],
      ['expectedApiUser', ''],
      ['ci', { workflowPath: '../private-value.yml' }],
      ['ssh', { privateKeyFile: 'private-value' }],
      ['tagger', { email: 'private-value' }],
    ])('validates source %s even when overridden without echoing values', (key, value) => {
      const config = rawConfig();
      config['sources'][0].releases = { [key as string]: value };
      const message = errorOf(() => resolve(config)).message;
      expect(message).toContain(`sources[0].releases.${key as string}`);
      expect(message).not.toContain('private-value');
    });

    it.each([
      ['apiTokenFile', null],
      ['expectedApiUser', ''],
      ['ci', null],
      ['ssh', []],
      ['tagger', { email: null }],
      ['ci', { unexpected: true }],
    ])('does not mask invalid repository %s overrides with defaults', (key, value) => {
      const message = defaultsError((config) => {
        config['releases'].repositories[0][key as string] = value;
      });
      expect(message).toContain(`releases.repositories[0].${key as string}`);
    });

    it.each(['github', 'fixture'])('rejects enabled defaults for a %s source', (kind) => {
      const message = defaultsError((config) => {
        config['sources'].push({ id: 'other', kind, path: 'fixture.json', releases: {} });
      });
      expect(message).toContain('sources[1].releases: release defaults require a gitea source');
    });

    it('still requires explicit repository identity and origin and rejects unknown sources', () => {
      for (const key of ['id', 'source', 'repo', 'origin']) {
        expect(
          defaultsError((config) => {
            delete config['releases'].repositories[0][key];
          }),
        ).toContain(`releases.repositories[0].${key}`);
      }
      const config = rawConfig();
      config['sources'][0].releases = { expectedApiUser: 'default-bot' };
      config['releases'].repositories[0].source = 'unknown';
      expect(errorOf(() => resolve(config)).message).toContain('unknown source');
    });

    it.each([undefined, false])(
      'ignores stale source defaults when releases.enabled is %s',
      (enabled) => {
        const config = inheritedConfig();
        config['sources'][0].releases = { apiTokenFile: 'relative', ssh: null, obsolete: true };
        delete config['server'];
        if (enabled === undefined) delete config['releases'];
        else config['releases'].enabled = enabled;
        expect(resolve(config).releases).toEqual({ enabled: false });
        expect(resolve(config).server.basicAuth).toBeNull();
      },
    );
  });

  it('requires the application login', () => {
    expect(releaseError((_r, c) => delete c['server']).message).toContain('application login');
  });

  it('rejects an unsafe public origin', () => {
    expect(
      releaseError((r) => (r['publicOrigin'] = 'http://forge-desk.example.com')).message,
    ).toContain('loopback');
    expect(
      releaseError((r) => (r['publicOrigin'] = 'https://forge-desk.example.com/app')).message,
    ).toContain('without a path');
    expect(releaseError((r) => (r['publicOrigin'] = 'ftp://example.com')).message).toContain(
      'http://',
    );
    // A dotted prefix is a public name, not loopback.
    expect(releaseError((r) => (r['publicOrigin'] = 'http://127.evil.com')).message).toContain(
      'loopback',
    );
  });

  it('does not echo release values that may hold a credential', () => {
    const secret = 'super-secret-value';
    expect(
      releaseError(
        (r) =>
          (r['repositories'][0].origin = `ssh://git:${secret}@gitea.example.com/example/app.git`),
      ).message,
    ).not.toContain(secret);
    expect(releaseError((r) => (r['repositories'][0].apiTokenFile = secret)).message).not.toContain(
      secret,
    );
    expect(
      releaseError((r) => (r['publicOrigin'] = `https://user:${secret}@example.com`)).message,
    ).not.toContain(secret);
  });

  it('requires private absolute paths for state and secrets', () => {
    expect(releaseError((r) => delete r['stateDir']).message).toContain('stateDir');
    expect(releaseError((r) => (r['stateDir'] = 'relative/state')).message).toContain(
      'absolute path',
    );
    expect(releaseError((r) => (r['stateDir'] = '/var/lib/../lib/forge-desk')).message).toContain(
      'normalized',
    );
    expect(
      releaseError((r) => (r['repositories'][0].ssh.privateKeyFile = 'keys/release')).message,
    ).toContain('absolute path');
    expect(
      releaseError((r) => (r['repositories'][0].ssh.knownHostsFile = '/run/secrets/../x')).message,
    ).toContain('normalized');
  });

  it('requires unique repository ids bound to existing Gitea sources', () => {
    expect(releaseError((r) => (r['repositories'][0].id = 'Bad Id')).message).toContain('id');
    expect(
      releaseError((r) => r['repositories'].push({ ...r['repositories'][0] })).message,
    ).toContain('duplicate release repository id');
    expect(releaseError((r) => (r['repositories'][0].source = 'gh')).message).toContain(
      'unknown source',
    );
    expect(
      releaseError((_r, c) => {
        c['sources'][0].kind = 'github';
      }).message,
    ).toContain('gitea source');
  });

  it('requires at least one repository when enabled', () => {
    expect(releaseError((r) => (r['repositories'] = [])).message).toContain(
      'at least one release repository',
    );
  });

  it('accepts only a safe SSH origin for the configured repository', () => {
    expect(
      releaseError((r) => (r['repositories'][0].origin = 'git@gitea.example.com:example/app.git'))
        .message,
    ).toContain('ssh://');
    expect(
      releaseError(
        (r) => (r['repositories'][0].origin = 'ssh://git:pw@gitea.example.com/example/app.git'),
      ).message,
    ).toContain('password');
    expect(
      releaseError(
        (r) => (r['repositories'][0].origin = 'ssh://git@gitea.example.com/other/app.git'),
      ).message,
    ).toContain('must be /example/app');
    expect(
      releaseError((r) => (r['repositories'][0].origin = 'ssh://git@gitea.example.com/a/b/c.git'))
        .message,
    ).toContain('/owner/repo');
  });

  it('requires exactly one private token selector', () => {
    expect(
      releaseError((r) => (r['repositories'][0].apiTokenEnv = 'RELEASE_TOKEN')).message,
    ).toContain('exactly one of apiTokenFile or apiTokenEnv');
    expect(releaseError((r) => delete r['repositories'][0].apiTokenFile).message).toContain(
      'exactly one of apiTokenFile or apiTokenEnv',
    );
    expect(releaseError((r) => (r['repositories'][0].token = 'inline-secret')).message).toContain(
      'token',
    );
  });

  it('requires a designated repository workflow path', () => {
    expect(
      releaseError((r) => (r['repositories'][0].ci.workflowPath = '/etc/validate.yaml')).message,
    ).toContain('relative path');
    expect(
      releaseError((r) => (r['repositories'][0].ci.workflowPath = '../validate.yaml')).message,
    ).toContain('..');
    expect(
      releaseError((r) => (r['repositories'][0].ci.workflowPath = 'workflows/validate.sh')).message,
    ).toContain('.yml');
  });

  it('requires an explicit expected API user and a valid tagger', () => {
    expect(releaseError((r) => delete r['repositories'][0].expectedApiUser).message).toContain(
      'expectedApiUser',
    );
    expect(
      releaseError((r) => (r['repositories'][0].tagger.email = 'not-an-email')).message,
    ).toContain('email');
    expect(
      releaseError((r) => (r['repositories'][0].tagger.name = 'Bot\nInjected')).message,
    ).toContain('control characters');
    expect(
      releaseError((r) => (r['repositories'][0].tagger.email = 'bot\u0000@example.com')).message,
    ).toContain('control characters');
  });
});

describe('project-browsing configuration through loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fd-browsing-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function file(extra = '', env: Record<string, string> = {}) {
    writeFileSync(join(dir, 'config.yaml'), MIN + extra);
    return loadConfig({ cwd: dir, env });
  }

  it('adds inert defaults without changing the existing configuration', () => {
    const cfg = file();
    expect(cfg.server.publicOrigin).toBeNull();
    expect(cfg.refresh).toEqual({ sweepHours: 0, requestsPerMinute: 60, concurrency: 4 });
    expect(cfg.preferences).toEqual({ dir: null });
    expect(cfg.releases).toEqual({ enabled: false });
    expect(cfg.warnings).toEqual([]);
    expect(file('server: {}\nrefresh: {}\npreferences: {}\n')).toEqual(cfg);
  });

  it.each([
    ['https://EXAMPLE.com:443/', 'https://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.2:8080', 'http://127.0.0.2:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ])('accepts and normalizes origin %s', (input, expected) => {
    expect(file(`server: { publicOrigin: ${JSON.stringify(input)} }\n`).server.publicOrigin).toBe(
      expected,
    );
  });

  const badOrigins = [
    '',
    'not-a-url',
    'ftp://localhost',
    'http://example.com',
    'http://127.evil.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?a=1',
    'https://example.com/#fragment',
    'https://example.com/\n',
    'https://exam ple.com',
  ];
  it.each(badOrigins)('rejects unsafe origin %j in YAML', (value) => {
    expect(() => file(`server: { publicOrigin: ${JSON.stringify(value)} }\n`)).toThrow(
      /server.publicOrigin/,
    );
  });

  const badPaths = [
    '',
    'relative/path',
    '/',
    '/tmp/',
    '/tmp//prefs',
    '/tmp/./prefs',
    '/tmp/../prefs',
    '/tmp/\nprefs',
  ];
  it.each(badPaths)('rejects non-normalized directory %j', (value) => {
    expect(() => file(`preferences: { dir: ${JSON.stringify(value)} }\n`)).toThrow(
      /preferences.dir/,
    );
  });

  it('accepts a nonexistent absolute directory without accessing or creating it', () => {
    const path = join(dir, 'missing', 'preferences');
    expect(file(`preferences: { dir: ${JSON.stringify(path)} }\n`).preferences.dir).toBe(path);
    expect(() => readFileSync(path)).toThrow(/ENOENT/);
  });

  it.each([0, 1, 168])('accepts sweepHours %i', (value) => {
    expect(file(`refresh: { sweepHours: ${value} }\n`).refresh.sweepHours).toBe(value);
  });
  it.each(['sweepHours', 'requestsPerMinute', 'concurrency'] as const)(
    'rejects invalid %s values',
    (key) => {
      const invalid = [-1, 0.5, '1', null, true, ...(key === 'sweepHours' ? [169] : [0])];
      for (const value of invalid) {
        expect(() => file(`refresh: { ${key}: ${JSON.stringify(value)} }\n`)).toThrow(
          `refresh.${key}`,
        );
      }
    },
  );
  it('accepts positive pacing integers and retains unspecified defaults', () => {
    expect(file('refresh: { requestsPerMinute: 1, concurrency: 1 }\n').refresh).toEqual({
      sweepHours: 0,
      requestsPerMinute: 1,
      concurrency: 1,
    });
    expect(file('refresh: { requestsPerMinute: 120, concurrency: 8 }\n').refresh).toEqual({
      sweepHours: 0,
      requestsPerMinute: 120,
      concurrency: 8,
    });
  });

  it.each(['refresh', 'preferences'])('rejects unknown keys under %s', (key) => {
    expect(() => file(`${key}: { typo: 1 }\n`)).toThrow(/Unrecognized key/);
  });

  describe.each(['file', 'env-only'])('%s overrides', (mode) => {
    function load(env: Record<string, string>) {
      if (mode === 'file') {
        return file(
          'server: { publicOrigin: "https://file.example" }\npreferences: { dir: /file/preferences }\nrefresh: { sweepHours: 24 }\n',
          env,
        );
      }
      return loadConfig({ cwd: dir, env: { FD_PROVIDER: 'github', FD_REPOS: 'a/b', ...env } });
    }

    it('applies all three FD overrides and normalizes the origin', () => {
      const cfg = load({
        FD_PUBLIC_ORIGIN: ' https://ENV.example:443/ ',
        FD_PREFERENCES_DIR: ' /env/preferences ',
        FD_SWEEP_HOURS: ' 168 ',
        FD_BASIC_AUTH: 'user:password',
      });
      expect(cfg.server.publicOrigin).toBe('https://env.example');
      expect(cfg.preferences.dir).toBe('/env/preferences');
      expect(cfg.refresh).toEqual({ sweepHours: 168, requestsPerMinute: 60, concurrency: 4 });
      expect(cfg.warnings).toEqual([]);
      expect(load({ FD_SWEEP_HOURS: '0' }).refresh.sweepHours).toBe(0);
    });

    it('ignores blank overrides and does not support EV aliases', () => {
      const base = load({});
      expect(
        load({
          FD_PUBLIC_ORIGIN: ' ',
          FD_PREFERENCES_DIR: '',
          FD_SWEEP_HOURS: ' ',
          EV_PUBLIC_ORIGIN: 'https://legacy.example',
          EV_PREFERENCES_DIR: '/legacy',
          EV_SWEEP_HOURS: '12',
        }),
      ).toEqual(base);
      const fd = {
        FD_PUBLIC_ORIGIN: 'https://new.example',
        FD_PREFERENCES_DIR: '/new',
        FD_SWEEP_HOURS: '4',
      };
      expect(
        load({
          ...fd,
          EV_PUBLIC_ORIGIN: 'invalid',
          EV_PREFERENCES_DIR: 'invalid',
          EV_SWEEP_HOURS: 'invalid',
        }),
      ).toEqual(load(fd));
    });

    it.each(badOrigins.filter((value) => value.trim() !== '' && value.trim() === value))(
      'validates FD_PUBLIC_ORIGIN %j',
      (value) => {
        expect(() => load({ FD_PUBLIC_ORIGIN: value })).toThrow(
          /FD_PUBLIC_ORIGIN: invalid publicOrigin/,
        );
      },
    );
    it.each(badPaths.filter((value) => value !== ''))(
      'validates FD_PREFERENCES_DIR %j',
      (value) => {
        expect(() => load({ FD_PREFERENCES_DIR: value })).toThrow(
          /FD_PREFERENCES_DIR: invalid path/,
        );
      },
    );
    it.each(['-1', '169', '1.5', 'abc', '1e2', 'Infinity'])(
      'validates FD_SWEEP_HOURS %j',
      (value) => {
        expect(() => load({ FD_SWEEP_HOURS: value })).toThrow(/FD_SWEEP_HOURS:.*integer/);
      },
    );

    it('warns without failing when preferences lack login and zero TTL disables a sweep', () => {
      const cfg = load({
        FD_PREFERENCES_DIR: '/preferences',
        FD_CACHE_TTL: '0',
        FD_SWEEP_HOURS: '1',
      });
      expect(cfg.preferences.dir).toBe('/preferences');
      expect(cfg.refresh.sweepHours).toBe(1);
      expect(cfg.warnings).toEqual([
        expect.stringMatching(/preferences.dir:.*login.*unavailable/),
        expect.stringMatching(/refresh.sweepHours:.*cache.ttlSeconds.*0.*sweep will not run/),
      ]);
    });

    it('has no warnings with login and positive TTL, or a disabled sweep', () => {
      expect(load({ FD_BASIC_AUTH: 'user:password' }).warnings).toEqual([]);
      expect(
        load({ FD_BASIC_AUTH: 'user:password', FD_CACHE_TTL: '0', FD_SWEEP_HOURS: '0' }).warnings,
      ).toEqual([]);
    });
  });

  it('evaluates warnings from YAML settings as well as overrides', () => {
    const cfg = file(
      'preferences: { dir: /preferences }\nrefresh: { sweepHours: 1 }\ncache: { ttlSeconds: 0 }\n',
    );
    expect(cfg.warnings).toHaveLength(2);
    expect(
      file(
        'preferences: { dir: /preferences }\nserver: { basicAuth: { username: user, password: pass } }\n',
      ).warnings,
    ).toEqual([]);
  });
});

describe('project catalog and source planning policies', () => {
  const defaultPolicy = {
    dependencies: { native: true, body: true, subIssues: false, keywords: DEFAULT_KEYWORDS },
    ordering: { priorityLabels: [], mode: 'priority' },
  };
  const view = { id: 'first', source: 'gh', repos: ['Acme/API'] };
  function config(views: unknown[], planning?: unknown) {
    return parseConfig(
      JSON.stringify({ sources: [{ id: 'gh', kind: 'github', planning }], views }),
      {},
    );
  }

  it('unions and normalizes repositories in source order, without merging identical forges', () => {
    const cfg = parseConfig(
      JSON.stringify({
        sources: [
          { id: 'second', kind: 'github' },
          { id: 'gh', kind: 'github' },
          { id: 'unused', kind: 'github' },
        ],
        views: [
          { ...view, repos: ['Zed/Web', 'Acme/API', 'ACME/API'] },
          { id: 'other', source: 'gh', repos: ['acme/api', 'acme/Web', 'aaa/zzz'] },
          { id: 'same-forge', source: 'second', repos: ['ACME/API'] },
        ],
      }),
      {},
    );
    expect(cfg.catalog).toEqual({
      sources: [
        {
          id: 'second',
          title: 'second',
          kind: 'github',
          projects: [{ source: 'second', repo: 'acme/api' }],
          policy: { status: 'usable' },
        },
        {
          id: 'gh',
          title: 'gh',
          kind: 'github',
          projects: ['aaa/zzz', 'acme/api', 'acme/web', 'zed/web'].map((repo) => ({
            source: 'gh',
            repo,
          })),
          policy: { status: 'usable' },
        },
        {
          id: 'unused',
          title: 'unused',
          kind: 'github',
          projects: [],
          policy: { status: 'usable' },
        },
      ],
    });
    expect(cfg.sources.map((s) => s.planning)).toEqual([defaultPolicy, defaultPolicy, null]);
    expect(cfg.warnings).toEqual([]);
  });

  it('includes empty projects without reading provider issues or promoting outside dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fd-catalog-'));
    try {
      writeFileSync(
        join(dir, 'issues.json'),
        JSON.stringify({
          issues: [
            {
              owner: 'acme',
              repo: 'api',
              number: 1,
              state: 'open',
              body: 'Blocked by: outside/lib#2',
            },
            { owner: 'acme', repo: 'empty', number: 1, state: 'closed' },
          ],
        }),
      );
      const cfg = parseConfig(
        JSON.stringify({
          sources: [{ id: 'fx', kind: 'fixture', path: './issues.json' }],
          views: [{ ...view, source: 'fx', repos: ['acme/api', 'acme/empty', 'acme/unfetched'] }],
        }),
        {},
        { baseDir: dir },
      );
      expect(cfg.catalog.sources[0]!.projects.map((p) => p.repo)).toEqual([
        'acme/api',
        'acme/empty',
        'acme/unfetched',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not add enabled release-only repositories to the catalog', () => {
    const cfg = parseConfig(
      JSON.stringify({
        server: { basicAuth: { username: 'admin', password: 'pw' } },
        sources: [{ id: 'gt', kind: 'gitea', baseUrl: 'https://gitea.example' }],
        views: [{ ...view, source: 'gt' }],
        releases: {
          enabled: true,
          publicOrigin: 'https://desk.example',
          stateDir: '/var/lib/releases',
          repositories: [
            {
              id: 'release',
              source: 'gt',
              repo: 'release/only',
              origin: 'ssh://git@gitea.example/release/only.git',
              apiTokenEnv: 'RELEASE_TOKEN',
              expectedApiUser: 'bot',
              ci: { workflowPath: '.gitea/workflows/ci.yml' },
              ssh: { privateKeyFile: '/secrets/key', knownHostsFile: '/secrets/hosts' },
              tagger: { name: 'Bot', email: 'bot@example.com' },
            },
          ],
        },
      }),
      {},
    );
    expect(cfg.catalog.sources[0]!.projects).toEqual([{ source: 'gt', repo: 'acme/api' }]);
  });

  it('agrees on omitted and explicitly written defaults and ignores every scope setting', () => {
    const cfg = config([
      view,
      {
        ...view,
        id: 'explicit',
        ...defaultPolicy,
        scope: { labels: ['feature'], excludeLabels: ['hold'], milestones: ['v1'] },
      },
    ]);
    expect(cfg.sources[0]!.planning).toEqual(defaultPolicy);
    expect(cfg.sources[0]!.planning).not.toHaveProperty('scope');
    expect(cfg.catalog.sources[0]!.policy).toEqual({ status: 'usable' });
    expect(cfg.warnings).toEqual([]);
    expect(cfg.views[1]!.scope).toEqual({
      labels: ['feature'],
      excludeLabels: ['hold'],
      milestones: ['v1'],
    });
  });

  it('compares each keyword list as a case-insensitive set without changing view values', () => {
    const first = {
      ...view,
      dependencies: {
        keywords: { blockedBy: ['Needs', 'depends on', 'Needs'], blocks: ['BLOCKS', 'enables'] },
      },
    };
    const second = {
      ...view,
      id: 'second',
      dependencies: {
        keywords: { blockedBy: ['DEPENDS ON', 'needs'], blocks: ['Enables', 'blocks', 'blocks'] },
      },
    };
    const cfg = config([first, second]);
    expect(cfg.catalog.sources[0]!.policy).toEqual({ status: 'usable' });
    expect(cfg.warnings).toEqual([]);
    expect(cfg.views[0]!.dependencies.keywords).toEqual(first.dependencies.keywords);
    expect(cfg.views[1]!.dependencies.keywords).toEqual(second.dependencies.keywords);
    expect(cfg.sources[0]!.planning!.dependencies.keywords).toEqual(first.dependencies.keywords);
  });

  it('compares priority labels in rank order, not as sets', () => {
    const first = { ...view, ordering: { priorityLabels: ['P0', 'P1'] } };
    const same = { ...first, id: 'same' };
    expect(config([first, same]).catalog.sources[0]!.policy).toEqual({ status: 'usable' });
    const cfg = config([first, { ...same, ordering: { priorityLabels: ['P1', 'P0'] } }]);
    expect(cfg.sources[0]!.planning).toBeNull();
    expect(cfg.catalog.sources[0]!.policy).toMatchObject({
      status: 'conflict',
      conflict: { differingSettings: ['ordering.priorityLabels'] },
    });
  });

  it.each([
    ['dependencies.native', { dependencies: { native: false } }],
    ['dependencies.body', { dependencies: { body: 'strict' } }],
    ['dependencies.subIssues', { dependencies: { subIssues: true } }],
    ['dependencies.keywords.blockedBy', { dependencies: { keywords: { blockedBy: [] } } }],
    ['dependencies.keywords.blocks', { dependencies: { keywords: { blocks: [] } } }],
    ['ordering.priorityLabels', { ordering: { priorityLabels: ['P1'] } }],
    ['ordering.mode', { ordering: { mode: 'waves' } }],
  ])('identifies a difference in %s', (setting, changes) => {
    const cfg = config([view, { ...view, id: 'second', ...changes }]);
    expect(cfg.catalog.sources[0]!.policy).toMatchObject({
      status: 'conflict',
      conflict: { source: 'gh', differingSettings: [setting], views: ['first', 'second'] },
    });
    expect(cfg.warnings).toHaveLength(1);
  });

  it('explains all differing settings and view groups while preserving other sources and views', () => {
    const cfg = parseConfig(
      JSON.stringify({
        sources: [
          { id: 'gh', kind: 'github' },
          { id: 'other', kind: 'github' },
        ],
        views: [
          view,
          { ...view, id: 'same' },
          {
            ...view,
            id: 'different',
            dependencies: { native: false, body: 'strict' },
            ordering: { mode: 'waves' },
          },
          { ...view, id: 'unaffected', source: 'other' },
        ],
      }),
      {},
    );
    const policy = cfg.catalog.sources[0]!.policy;
    expect(policy.status).toBe('conflict');
    if (policy.status !== 'conflict') throw new Error('expected conflict');
    expect(policy.conflict.differingSettings).toEqual([
      'dependencies.native',
      'dependencies.body',
      'ordering.mode',
    ]);
    for (const setting of policy.conflict.differingSettings) {
      expect(policy.conflict.explanation).toContain(
        `${setting} differs between views "first", "same" and "different"`,
      );
    }
    expect(policy.conflict.explanation).toContain('source "gh"');
    expect(policy.conflict.explanation).toContain('sources[].planning');
    expect(cfg.warnings).toEqual([policy.conflict.explanation]);
    expect(cfg.sources[0]!.planning).toBeNull();
    expect(cfg.sources[1]!.planning).toEqual(defaultPolicy);
    expect(cfg.catalog.sources[1]!.policy).toEqual({ status: 'usable' });
    for (const v of cfg.views) {
      const standalone = parseConfig(
        JSON.stringify({
          sources: [{ id: v.source, kind: 'github' }],
          views: [
            v.id === 'different'
              ? {
                  ...view,
                  id: v.id,
                  dependencies: { native: false, body: 'strict' },
                  ordering: { mode: 'waves' },
                }
              : { ...view, id: v.id, source: v.source },
          ],
        }),
        {},
      );
      expect(v).toEqual(standalone.views[0]);
    }
  });

  it.each([true, false])('uses explicit source planning when view agreement is %s', (agree) => {
    const views = [view, { ...view, id: 'second', dependencies: { native: agree } }];
    const planning = {
      dependencies: { body: 'strict', keywords: { blocks: [' enables ', 'BLOCKS'] } },
      ordering: { priorityLabels: ['P1', 'P0'], mode: 'waves' },
    };
    const cfg = config(views, planning);
    expect(cfg.sources[0]!.planning).toEqual({
      dependencies: {
        native: true,
        body: 'strict',
        subIssues: false,
        keywords: { blockedBy: DEFAULT_KEYWORDS.blockedBy, blocks: ['enables', 'BLOCKS'] },
      },
      ordering: planning.ordering,
    });
    expect(cfg.views).toEqual(config(views).views);
    expect(cfg.catalog.sources[0]!.policy).toEqual({ status: 'usable' });
    expect(cfg.warnings).toEqual([]);
  });

  it('uses defaults for an explicit empty policy rather than inheriting views', () => {
    const cfg = config(
      [{ ...view, dependencies: { native: false }, ordering: { mode: 'waves' } }],
      {},
    );
    expect(cfg.sources[0]!.planning).toEqual(defaultPolicy);
    expect(cfg.views[0]!.dependencies.native).toBe(false);
  });

  it('does not share arrays between source policies, views, or default keywords', () => {
    const cfg = config([view]);
    cfg.sources[0]!.planning!.dependencies.keywords.blocks.push('new');
    cfg.sources[0]!.planning!.ordering.priorityLabels.push('P0');
    expect(cfg.views[0]!.dependencies.keywords.blocks).toEqual(DEFAULT_KEYWORDS.blocks);
    expect(cfg.views[0]!.ordering.priorityLabels).toEqual([]);
    expect(DEFAULT_KEYWORDS.blocks).toEqual(['blocks', 'blocking', 'required by']);
  });

  it.each([
    { typo: true },
    { scope: {} },
    { dependencies: { typo: true } },
    { dependencies: { keywords: { typo: [] } } },
    { ordering: { typo: true } },
    { dependencies: { native: 'true' } },
    { dependencies: { body: 'yes' } },
    { dependencies: { subIssues: 1 } },
    { dependencies: { keywords: { blocks: [' '] } } },
    { ordering: { priorityLabels: [1] } },
    { ordering: { mode: 'alphabetical' } },
    null,
  ])('rejects an invalid source policy %j just as for views', (planning) => {
    expect(() => config([view], planning)).toThrow(/sources\[0\].planning/);
  });

  it('resolves the env-only view catalog and its overridden planning settings', () => {
    const cfg = configFromEnv({
      FD_PROVIDER: 'github',
      FD_REPOS: 'Zed/Web, ACME/API, acme/api',
      FD_SUB_ISSUES: 'true',
      FD_ORDERING_MODE: 'waves',
      FD_PRIORITY_LABELS: 'P1, P0',
    });
    expect(cfg.catalog).toEqual({
      sources: [
        {
          id: 'default',
          title: 'default',
          kind: 'github',
          projects: ['acme/api', 'zed/web'].map((repo) => ({ source: 'default', repo })),
          policy: { status: 'usable' },
        },
      ],
    });
    expect(cfg.sources[0]!.planning).toEqual({
      dependencies: cfg.views[0]!.dependencies,
      ordering: cfg.views[0]!.ordering,
    });
    expect(cfg.sources[0]!.planning!.ordering).toEqual({
      priorityLabels: ['P1', 'P0'],
      mode: 'waves',
    });
    expect(cfg.sources[0]!.planning!.dependencies.subIssues).toBe(true);
  });

  it('resolves catalog source title from explicit source title, single view title, or source id', () => {
    const cfg = parseConfig(
      JSON.stringify({
        sources: [
          { id: 'explicit', title: 'Explicit Title', kind: 'github' },
          { id: 'single-titled', kind: 'github' },
          { id: 'single-untitled', kind: 'github' },
          { id: 'multi-titled', kind: 'github' },
          { id: 'unused', kind: 'github' },
        ],
        views: [
          { id: 'v1', title: 'View Title Ignored', source: 'explicit', repos: ['acme/api'] },
          { id: 'v2', title: 'PugLab (Gitea)', source: 'single-titled', repos: ['acme/api'] },
          { id: 'v3', source: 'single-untitled', repos: ['acme/api'] },
          { id: 'v4', title: 'First', source: 'multi-titled', repos: ['acme/api'] },
          { id: 'v5', title: 'Second', source: 'multi-titled', repos: ['acme/web'] },
        ],
      }),
      {},
    );
    expect(cfg.catalog.sources.map((s) => ({ id: s.id, title: s.title }))).toEqual([
      { id: 'explicit', title: 'Explicit Title' },
      { id: 'single-titled', title: 'PugLab (Gitea)' },
      { id: 'single-untitled', title: 'single-untitled' },
      { id: 'multi-titled', title: 'multi-titled' },
      { id: 'unused', title: 'unused' },
    ]);
  });
});
