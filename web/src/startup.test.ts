import { describe, expect, it } from 'vitest';
import type {
  AvailablePreferences,
  PreferencesUnavailableReason,
} from '../../src/core/preferences.js';
import type { CatalogResponse, CatalogSource } from '../../src/core/scope.js';
import { parseReleaseHash } from './release-route.js';
import { parseHash } from './route.js';
import { effectiveViewId } from './state.js';
import { resolveStartup, type StartupInput, type StartupPreferences } from './startup.js';

const source = (id: string, repos: string[]): CatalogSource => ({
  id,
  kind: 'github',
  projects: repos.map((repo) => ({ source: id, repo })),
  policy: { status: 'usable' },
});
const catalog: CatalogResponse = {
  sources: [
    source('empty', []),
    source('z-first', ['acme/api', 'acme/zero']),
    source('a-second', ['acme/api']),
  ],
};
const available: AvailablePreferences = {
  available: true,
  revision: 2,
  favorites: [],
  rememberedProject: null,
};
const views = [
  {
    id: 'legacy',
    title: 'Legacy',
    source: 'z-first',
    kind: 'github' as const,
    repos: ['acme/api'],
  },
];
const input: StartupInput = { hash: '#/', catalog, preferences: available, views };
const conflictCatalog: CatalogResponse = {
  sources: catalog.sources.map((entry) =>
    entry.id !== 'z-first'
      ? entry
      : {
          ...entry,
          policy: {
            status: 'conflict',
            conflict: {
              source: entry.id,
              differingSettings: ['ordering.mode'],
              views: ['a', 'b'],
              explanation: 'Set sources[].planning.',
            },
          },
        },
  ),
};
const favorite = (source: string, repo: string, inCatalog = true) => ({ source, repo, inCatalog });
const unavailable = (reason: PreferencesUnavailableReason): StartupPreferences => ({
  available: false,
  reason,
  message: `Preferences: ${reason}`,
});

interface Case {
  name: string;
  changes: Partial<StartupInput>;
  expected: Record<string, unknown>;
}
const cases: Case[] = [
  {
    name: 'explicit project wins over remembered project',
    changes: {
      hash: '#/project/z-first/ACME/ZERO/order?q=bug&sort=updated',
      preferences: { ...available, rememberedProject: { source: 'a-second', repo: 'acme/api' } },
    },
    expected: {
      kind: 'scope',
      scope: { kind: 'project', source: 'z-first', repo: 'acme/zero' },
      route: { tab: 'order', q: 'bug', sort: 'updated' },
      rememberProject: true,
    },
  },
  {
    name: 'explicit source',
    changes: { hash: '#/source/a-second/problems' },
    expected: {
      kind: 'scope',
      scope: { kind: 'source', source: 'a-second' },
      rememberProject: false,
    },
  },
  {
    name: 'explicit catalog source with no repositories',
    changes: { hash: '#/source/empty' },
    expected: { kind: 'scope', scope: { kind: 'source', source: 'empty' }, rememberProject: false },
  },
  {
    name: 'named view',
    changes: { hash: '#/view/legacy/order?q=foo' },
    expected: {
      kind: 'view',
      viewId: 'legacy',
      route: parseHash('#/view/legacy/order?q=foo'),
      rememberProject: false,
    },
  },
  {
    name: 'unknown named view retains first-view fallback',
    changes: { hash: '#/view/unknown' },
    expected: { kind: 'view', viewId: 'legacy', rememberProject: false },
  },
  {
    name: 'named view without any views',
    changes: { hash: '#/view/legacy', views: [] },
    expected: { kind: 'view', viewId: null, rememberProject: false },
  },
  {
    name: 'releases',
    changes: { hash: '#/releases/acme%2Fapi?job=j&plan=p' },
    expected: {
      kind: 'releases',
      route: { repositoryId: 'acme/api', jobId: 'j', planId: 'p' },
      rememberProject: false,
    },
  },
  {
    name: 'remembered project wins over favorites',
    changes: {
      preferences: {
        ...available,
        rememberedProject: { source: 'a-second', repo: 'acme/api' },
        favorites: [favorite('z-first', 'acme/zero')],
      },
    },
    expected: {
      kind: 'scope',
      scope: { kind: 'project', source: 'a-second', repo: 'acme/api' },
      rememberProject: false,
    },
  },
  {
    name: 'favorite skips out-of-catalog and stale membership entries',
    changes: {
      preferences: {
        ...available,
        rememberedProject: { source: 'gone', repo: 'acme/api' },
        favorites: [
          favorite('gone', 'acme/api', false),
          favorite('gone-too', 'acme/api'),
          favorite('z-first', 'acme/zero'),
          favorite('a-second', 'acme/api'),
        ],
      },
    },
    expected: {
      kind: 'scope',
      scope: { kind: 'project', source: 'z-first', repo: 'acme/zero' },
      rememberProject: false,
    },
  },
  {
    name: 'current catalog restores a favorite marked absent by an older preference read',
    changes: {
      preferences: { ...available, favorites: [favorite('a-second', 'acme/api', false)] },
    },
    expected: {
      kind: 'scope',
      scope: { kind: 'project', source: 'a-second', repo: 'acme/api' },
      rememberProject: false,
    },
  },
  {
    name: 'fallback uses configuration order and skips empty sources',
    changes: {},
    expected: {
      kind: 'scope',
      scope: { kind: 'source', source: 'z-first' },
      rememberProject: false,
    },
  },
  {
    name: 'remembered policy conflict does not skip to favorite',
    changes: {
      catalog: conflictCatalog,
      preferences: {
        ...available,
        rememberedProject: { source: 'z-first', repo: 'acme/api' },
        favorites: [favorite('a-second', 'acme/api')],
      },
    },
    expected: {
      kind: 'policy-conflict',
      conflict: { source: 'z-first', explanation: 'Set sources[].planning.' },
      rememberProject: false,
    },
  },
  {
    name: 'favorite policy conflict does not skip to later favorite',
    changes: {
      catalog: conflictCatalog,
      preferences: {
        ...available,
        favorites: [favorite('z-first', 'acme/api'), favorite('a-second', 'acme/api')],
      },
    },
    expected: {
      kind: 'policy-conflict',
      scope: { kind: 'project', source: 'z-first', repo: 'acme/api' },
      rememberProject: false,
    },
  },
  {
    name: 'source fallback policy conflict does not skip to later source',
    changes: { catalog: conflictCatalog },
    expected: {
      kind: 'policy-conflict',
      scope: { kind: 'source', source: 'z-first' },
      rememberProject: false,
    },
  },
  {
    name: 'explicit project policy conflict',
    changes: { catalog: conflictCatalog, hash: '#/project/z-first/acme/api' },
    expected: { kind: 'policy-conflict', rememberProject: false },
  },
  {
    name: 'explicit source policy conflict',
    changes: { catalog: conflictCatalog, hash: '#/source/z-first' },
    expected: { kind: 'policy-conflict', rememberProject: false },
  },
  {
    name: 'unknown project keeps sidebar',
    changes: { hash: '#/project/z-first/acme/missing' },
    expected: {
      kind: 'not-in-catalog',
      scope: { kind: 'project', source: 'z-first', repo: 'acme/missing' },
      sidebarAvailable: true,
      rememberProject: false,
    },
  },
  {
    name: 'unknown source keeps sidebar',
    changes: { hash: '#/source/missing' },
    expected: { kind: 'not-in-catalog', sidebarAvailable: true, rememberProject: false },
  },
  {
    name: 'source identities are case-sensitive',
    changes: { hash: '#/source/Z-FIRST' },
    expected: { kind: 'not-in-catalog', rememberProject: false },
  },
  {
    name: 'unknown project under conflicting source remains not-in-catalog',
    changes: { hash: '#/project/z-first/acme/missing', catalog: conflictCatalog },
    expected: { kind: 'not-in-catalog', rememberProject: false },
  },
  ...(['login-disabled', 'storage-not-configured'] as const).map((reason): Case => ({
    name: reason,
    changes: { preferences: unavailable(reason) },
    expected: {
      kind: 'scope',
      scope: { kind: 'source', source: 'z-first' },
      preferencesUnavailable: unavailable(reason),
      rememberProject: false,
    },
  })),
  ...(
    ['storage-missing', 'store-locked', 'unreadable', 'corrupt', 'unsupported-version'] as const
  ).map((reason): Case => ({
    name: reason,
    changes: { preferences: unavailable(reason) },
    expected: {
      kind: 'preference-error',
      error: unavailable(reason),
      sidebarAvailable: true,
      rememberProject: false,
    },
  })),
  {
    name: 'failed preference read',
    changes: { preferences: { available: false, reason: 'read-failed', message: 'Offline' } },
    expected: {
      kind: 'preference-error',
      error: { reason: 'read-failed', message: 'Offline' },
      rememberProject: false,
    },
  },
  {
    name: 'explicit project bypasses preference error',
    changes: { hash: '#/project/z-first/acme/api', preferences: unavailable('corrupt') },
    expected: {
      kind: 'scope',
      rememberProject: true,
      preferencesUnavailable: unavailable('corrupt'),
    },
  },
  {
    name: 'explicit source bypasses preference error',
    changes: { hash: '#/source/z-first', preferences: unavailable('corrupt') },
    expected: { kind: 'scope', rememberProject: false },
  },
  {
    name: 'named view bypasses preference error and conflict',
    changes: {
      hash: '#/view/legacy',
      preferences: unavailable('corrupt'),
      catalog: conflictCatalog,
    },
    expected: { kind: 'view', viewId: 'legacy', rememberProject: false },
  },
  {
    name: 'releases bypass preference error',
    changes: { hash: '#/releases', preferences: unavailable('corrupt') },
    expected: { kind: 'releases', rememberProject: false },
  },
  {
    name: 'empty catalog',
    changes: { catalog: { sources: [] } },
    expected: { kind: 'empty-catalog', rememberProject: false },
  },
  {
    name: 'only sources without projects',
    changes: { catalog: { sources: [source('empty', [])] } },
    expected: { kind: 'empty-catalog', rememberProject: false },
  },
];

describe('resolveStartup', () => {
  it.each(cases)('$name', ({ changes, expected }) => {
    const value = { ...input, ...changes };
    const before = structuredClone(value);
    expect(resolveStartup(value)).toMatchObject(expected);
    expect(value).toEqual(before);
    expect(resolveStartup(value)).toEqual(resolveStartup(value));
  });

  it.each([
    '#/view/legacy/order?q=abc&sort=execution',
    '#/view/unknown',
    '#/view/%zz',
    '#/releases',
    '#/releases/%zz?job=1',
  ])('delegates legacy route semantics for %s', (hash) => {
    const result = resolveStartup({ ...input, hash });
    const release = parseReleaseHash(hash);
    if (release !== null) {
      expect(result).toMatchObject({ kind: 'releases', route: release });
    } else {
      const route = parseHash(hash);
      expect(result).toMatchObject({
        kind: 'view',
        route,
        viewId: effectiveViewId({ views, route }),
      });
    }
  });
});
