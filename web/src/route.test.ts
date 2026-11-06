import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, parseHash, serializeHash, type Route } from './route.js';

describe('parseHash', () => {
  it('parses view, tab and query', () => {
    expect(parseHash('#/view/demo/order?q=label%3AP1%20login')).toEqual({
      viewId: 'demo',
      tab: 'order',
      q: 'label:P1 login',
      sort: 'number',
    });
  });

  it('parses the sort mode, including the server order, and ignores an unknown one', () => {
    expect(parseHash('#/view/demo/graph?sort=dependents').sort).toBe('dependents');
    expect(parseHash('#/view/demo/graph?sort=execution').sort).toBe('execution');
    expect(parseHash('#/view/demo/graph?sort=nonsense').sort).toBe('number');
    expect(parseHash('#/view/demo/graph?sort=').sort).toBe('number');
  });

  it('defaults to the issue-number order', () => {
    expect(DEFAULT_ROUTE.sort).toBe('number');
    expect(parseHash('#/view/demo/graph').sort).toBe('number');
  });

  it('defaults the tab to graph and tolerates a missing "#"', () => {
    expect(parseHash('/view/demo')).toEqual({
      viewId: 'demo',
      tab: 'graph',
      q: '',
      sort: 'number',
    });
    expect(parseHash('#/view/demo/nonsense')).toEqual({
      viewId: 'demo',
      tab: 'graph',
      q: '',
      sort: 'number',
    });
  });

  it('gives the default route for empty or unknown hashes', () => {
    const empty = { viewId: null, tab: 'graph', q: '', sort: 'number' };
    expect(parseHash('')).toEqual(empty);
    expect(parseHash('#')).toEqual(empty);
    expect(parseHash('#/')).toEqual(empty);
    expect(parseHash('#/something/else')).toEqual(empty);
  });

  it('keeps the query even when no view is given', () => {
    expect(parseHash('#/?q=abc')).toEqual({ viewId: null, tab: 'graph', q: 'abc', sort: 'number' });
  });

  it('decodes ids and survives malformed escapes', () => {
    expect(parseHash('#/view/my%20view/problems').viewId).toBe('my view');
    expect(parseHash('#/view/%E0%A4%A/problems').viewId).toBe('%E0%A4%A');
  });
});

describe('serializeHash', () => {
  it('serializes view, tab and query', () => {
    expect(serializeHash({ viewId: 'demo', tab: 'problems', q: '', sort: 'number' })).toBe(
      '#/view/demo/problems',
    );
    expect(serializeHash({ viewId: 'demo', tab: 'graph', q: 'label:P1 #3', sort: 'number' })).toBe(
      '#/view/demo/graph?q=label%3AP1%20%233',
    );
    expect(serializeHash({ viewId: null, tab: 'graph', q: '', sort: 'number' })).toBe('#/');
  });

  it('appends a non-default sort mode to the query string', () => {
    expect(serializeHash({ viewId: 'demo', tab: 'order', q: '', sort: 'updated' })).toBe(
      '#/view/demo/order?sort=updated',
    );
    expect(serializeHash({ viewId: 'demo', tab: 'order', q: 'label:P1', sort: 'prereq' })).toBe(
      '#/view/demo/order?q=label%3AP1&sort=prereq',
    );
    expect(serializeHash({ viewId: 'demo', tab: 'order', q: '', sort: 'execution' })).toBe(
      '#/view/demo/order?sort=execution',
    );
  });

  it('round-trips with parseHash', () => {
    const routes: Route[] = [
      { viewId: 'demo', tab: 'order', q: 'acme/api#4', sort: 'number' },
      { viewId: 'a b/c', tab: 'graph', q: 'c++ "quoted" & more', sort: 'updated' },
      { viewId: 'x', tab: 'problems', q: '', sort: 'execution' },
      { viewId: null, tab: 'graph', q: 'only-query', sort: 'dependents' },
      { viewId: 'demo', tab: 'graph', q: 'parent:#71 label:P0', sort: 'number' },
    ];
    for (const r of routes) expect(parseHash(serializeHash(r))).toEqual(r);
  });
});

describe('project and source routes', () => {
  it('decodes project segments and normalizes only the owner and repository', () => {
    expect(
      parseHash('#/project/My%20Forge/Acme/API%20V2/order?q=label%3AP1+login&sort=updated'),
    ).toEqual({
      viewId: null,
      scope: { kind: 'project', source: 'My Forge', owner: 'acme', repo: 'api v2' },
      tab: 'order',
      q: 'label:P1 login',
      sort: 'updated',
    });
    expect(parseHash('#/source/My%20Forge/problems')).toEqual({
      ...DEFAULT_ROUTE,
      scope: { kind: 'source', source: 'My Forge' },
      tab: 'problems',
    });
  });

  it.each(['#/project/forge/owner/repo', '#/source/forge'])(
    'defaults missing and unknown tabs for %s and decodes recognized tabs',
    (path) => {
      for (const suffix of ['', '/', '/unknown']) {
        expect(parseHash(`${path}${suffix}`).tab).toBe('graph');
      }
      expect(parseHash(`${path}/%6Frder`).tab).toBe('order');
      expect(parseHash(path.slice(1))).toEqual(parseHash(path));
    },
  );

  it.each(['#/project/forge/owner/repo', '#/source/forge'])(
    'uses the existing query and sort contract for %s',
    (path) => {
      for (const query of [
        '',
        '?q=',
        '?q=c%2B%2B+%26+more&sort=updated',
        '?q=first&q=second&sort=execution',
        '?q=%E0%A4%A&sort=unknown',
        '?sort=',
        '?sort=dependents',
        '?sort=prereq',
      ]) {
        const expected = parseHash(`#/view/demo/graph${query}`);
        const actual = parseHash(`${path}/graph${query}`);
        expect({ q: actual.q, sort: actual.sort }).toEqual({ q: expected.q, sort: expected.sort });
        expect(serializeHash(actual).split('?')[1]).toBe(serializeHash(expected).split('?')[1]);
      }
    },
  );

  it.each([
    '#/project',
    '#/project/forge',
    '#/project/forge/owner',
    '#/project//owner/repo',
    '#/project/forge//repo',
    '#/project/forge/owner/',
    '#/project/forge/owner/repo/order/extra',
    '#/source',
    '#/source/',
    '#/source//order',
    '#/source/forge/order/extra',
    '#//source/forge',
    '#//project/forge/owner/repo',
    '#/source/%E0%A4%A',
    '#/project/%ZZ/owner/repo',
    '#/project/forge/%ZZ/repo',
    '#/project/forge/owner/%ZZ',
    '#/project/forge/owner/repo/%ZZ',
    '#/source/forge/%ZZ',
  ])('falls back safely for malformed hash %s, retaining query defaults', (hash) => {
    expect(parseHash(hash)).toEqual(DEFAULT_ROUTE);
    expect(parseHash(`${hash}?q=keep&sort=updated`)).toEqual({
      ...DEFAULT_ROUTE,
      q: 'keep',
      sort: 'updated',
    });
  });

  it('serializes the new paths with encoded segments', () => {
    expect(
      serializeHash({
        ...DEFAULT_ROUTE,
        scope: { kind: 'project', source: 'My Forge', owner: 'Acme', repo: 'API #1' },
        tab: 'order',
        q: 'label:P1',
        sort: 'execution',
      }),
    ).toBe('#/project/My%20Forge/acme/api%20%231/order?q=label%3AP1&sort=execution');
    expect(
      serializeHash({
        ...DEFAULT_ROUTE,
        scope: { kind: 'source', source: 'a/b' },
      }),
    ).toBe('#/source/a%2Fb/graph');
  });

  it('round-trips canonical project, source, view and root routes', () => {
    const routes: Route[] = [
      { ...DEFAULT_ROUTE },
      { ...DEFAULT_ROUTE, q: 'only query #1', sort: 'execution' },
      { ...DEFAULT_ROUTE, viewId: 'View / % ? # café', tab: 'order' },
      {
        ...DEFAULT_ROUTE,
        scope: {
          kind: 'project',
          source: 'Forge / % ? # 東京',
          owner: 'ä owner/%',
          repo: 'api?#/v2',
        },
        tab: 'problems',
        q: 'c++ "quoted" & more',
        sort: 'prereq',
      },
      {
        ...DEFAULT_ROUTE,
        scope: { kind: 'source', source: 'Forge / % ? # 東京' },
        tab: 'order',
        sort: 'dependents',
      },
    ];
    for (const route of routes) expect(parseHash(serializeHash(route))).toEqual(route);
  });
});
