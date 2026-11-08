import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailablePreferences } from '../../../src/core/preferences.js';
import type { CatalogResponse } from '../../../src/core/scope.js';
import { initialPreferenceState, type PreferenceState } from '../preferenceState.js';
import { DEFAULT_ROUTE, type Route } from '../route.js';
import { INITIAL_STATE } from '../state.js';
import { createProjectSidebar } from './project-sidebar.js';

// Minimal DOM as in side-panel.test.ts. Real keyboard activation and responsive
// visibility are exercised separately in Chromium, not simulated by this shim.
class FakeText {
  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly childNodes: (FakeElement | FakeText)[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly classList = {
    contains: (value: string): boolean =>
      (this.getAttribute('class') ?? '').split(' ').includes(value),
    toggle: (value: string, enabled: boolean): void => {
      const names = new Set((this.getAttribute('class') ?? '').split(' '));
      if (enabled) names.add(value);
      else names.delete(value);
      this.setAttribute('class', [...names].join(' '));
    },
  };
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(name: string, fn: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(fn);
    this.listeners.set(name, listeners);
  }
  dispatch(name: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
  click(): void {
    this.dispatch('click');
  }
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    this.childNodes.push(
      ...nodes.map((node) => (typeof node === 'string' ? new FakeText(node) : node)),
    );
  }
  removeChild(node: FakeElement | FakeText): void {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }
  getClientRects(): unknown[] {
    return [{}];
  }
  focus(): void {
    dom.activeElement = this;
  }
}

const dom = {
  activeElement: null as FakeElement | null,
  createElement: (tag: string): FakeElement => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string): FakeElement => new FakeElement(tag),
  createTextNode: (value: string): FakeText => new FakeText(value),
};

beforeEach(() => {
  dom.activeElement = null;
  vi.stubGlobal('document', dom);
});
afterEach(() => vi.unstubAllGlobals());

function descendants(root: FakeElement, predicate: (el: FakeElement) => boolean): FakeElement[] {
  return [
    ...(predicate(root) ? [root] : []),
    ...root.childNodes.flatMap((node) =>
      node instanceof FakeElement ? descendants(node, predicate) : [],
    ),
  ];
}
function named(root: FakeElement, name: string): FakeElement[] {
  return descendants(root, (el) => el.getAttribute('aria-label') === name);
}
function byClass(root: FakeElement, name: string): FakeElement[] {
  return descendants(root, (el) => el.classList.contains(name));
}

const catalog: CatalogResponse = {
  sources: [
    {
      id: 'github',
      kind: 'github',
      projects: [
        { source: 'github', repo: 'acme/api' },
        { source: 'github', repo: 'acme/empty' },
      ],
      policy: { status: 'usable' },
    },
    {
      id: 'gitea',
      kind: 'gitea',
      projects: [{ source: 'gitea', repo: 'acme/api' }],
      policy: { status: 'usable' },
    },
  ],
};
function preferences(
  favorites: AvailablePreferences['favorites'] = [
    { source: 'gitea', repo: 'acme/api', inCatalog: true },
    { source: 'github', repo: 'acme/api', inCatalog: true },
  ],
): PreferenceState {
  const value: AvailablePreferences = {
    available: true,
    revision: 1,
    favorites,
    rememberedProject: null,
  };
  return {
    ...initialPreferenceState(),
    view: { status: 'available', preferences: value },
    confirmed: value,
    revisionFloor: 1,
  };
}
function setup(
  route: Route = DEFAULT_ROUTE,
  prefs = preferences(),
  projects: CatalogResponse | null = catalog,
) {
  const actions = { selectScope: vi.fn(), openViews: vi.fn(), toggleFavorite: vi.fn() };
  const view = createProjectSidebar(actions);
  const root = view.el as unknown as FakeElement;
  const state = { ...INITIAL_STATE, route };
  view.update(state, prefs, projects);
  return { view, root, actions, state, toggle: byClass(root, 'project-sidebar-toggle')[0]! };
}

describe('project sidebar', () => {
  it('lists favorites in added order, then each source in catalog order, and Views separately', () => {
    const { root } = setup();
    const sections = byClass(root, 'project-sidebar-section');
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      'Favorites',
      'Source github',
      'Source gitea',
    ]);
    expect(
      byClass(sections[0]!, 'project-sidebar-entry').map((entry) =>
        entry.getAttribute('aria-label'),
      ),
    ).toEqual(['Open gitea / acme/api', 'Open github / acme/api']);
    expect(
      byClass(sections[1]!, 'project-sidebar-entry').map((entry) =>
        entry.getAttribute('aria-label'),
      ),
    ).toEqual(['All projects from github', 'Open github / acme/api', 'Open github / acme/empty']);
    expect(
      byClass(sections[2]!, 'project-sidebar-entry').map((entry) =>
        entry.getAttribute('aria-label'),
      ),
    ).toEqual(['All projects from gitea', 'Open gitea / acme/api']);
    const buttons = descendants(root, (el) => el.tagName === 'button');
    expect(buttons.at(-1)?.getAttribute('aria-label')).toBe('Views');
    expect(byClass(root, 'brand-name')[0]?.textContent).toBe('Forge Desk');
    expect(named(root, 'Open gitea / acme/api')[0]?.textContent).toBe('acme/apigitea');
    expect(named(root, 'Open gitea / acme/api')[1]?.textContent).toBe('acme/api');
    expect(named(root, 'All projects from github')[0]?.textContent).toBe('All projects');
  });

  it('displays friendly source titles and omits repeated source subtitles in source sections', () => {
    const titledCatalog: CatalogResponse = {
      sources: [
        {
          id: 'tea',
          title: 'PugLab (Gitea)',
          kind: 'gitea',
          projects: [{ source: 'tea', repo: 'acme/api' }],
          policy: { status: 'usable' },
        },
      ],
    };
    const { root } = setup(
      DEFAULT_ROUTE,
      preferences([{ source: 'tea', repo: 'acme/api', inCatalog: true }]),
      titledCatalog,
    );
    const sections = byClass(root, 'project-sidebar-section');
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      'Favorites',
      'Source PugLab (Gitea)',
    ]);
    expect(descendants(sections[1]!, (el) => el.tagName === 'h2')[0]?.textContent).toBe(
      'PugLab (Gitea)',
    );
    expect(byClass(sections[0]!, 'project-sidebar-source')[0]?.textContent).toBe('PugLab (Gitea)');
    expect(byClass(sections[1]!, 'project-sidebar-source')).toHaveLength(0);
  });

  it('reports project, source and named-view choices through separate callbacks', () => {
    const { root, actions } = setup();
    named(root, 'Open gitea / acme/api')[0]!.click();
    named(root, 'All projects from github')[0]!.click();
    named(root, 'Views')[0]!.click();
    expect(actions.selectScope.mock.calls).toEqual([
      [{ kind: 'project', source: 'gitea', repo: 'acme/api' }],
      [{ kind: 'source', source: 'github' }],
    ]);
    expect(actions.openViews).toHaveBeenCalledOnce();
    expect(actions.toggleFavorite).not.toHaveBeenCalled();
  });

  it('reports stars without navigation, changing issues, or mutating caller state', () => {
    const prefs = preferences();
    const saved = structuredClone(prefs);
    const { root, actions, state } = setup(DEFAULT_ROUTE, prefs);
    const before = structuredClone(state);
    named(root, 'Add github / acme/empty to favorites')[0]!.click();
    named(root, 'Remove gitea / acme/api from favorites')[0]!.click();
    expect(actions.toggleFavorite.mock.calls).toEqual([
      [{ source: 'github', repo: 'acme/empty' }, true],
      [{ source: 'gitea', repo: 'acme/api' }, false],
    ]);
    expect(actions.selectScope).not.toHaveBeenCalled();
    expect(actions.openViews).not.toHaveBeenCalled();
    expect(state).toEqual(before);
    expect(prefs).toEqual(saved);
  });

  it('retains unavailable favorites, including removed sources, and permits only their removal', () => {
    const { root, actions } = setup(
      DEFAULT_ROUTE,
      preferences([
        { source: 'removed-source', repo: 'acme/gone', inCatalog: false },
        { source: 'github', repo: 'acme/no-longer-listed', inCatalog: true },
      ]),
    );
    for (const name of ['removed-source / acme/gone', 'github / acme/no-longer-listed']) {
      const entry = named(root, `Unavailable project: ${name}`)[0]!;
      expect(entry.textContent).toContain('Unavailable');
      expect(entry.getAttribute('aria-disabled')).toBe('true');
      entry.click();
      named(root, `Remove ${name} from favorites`)[0]!.click();
    }
    expect(actions.selectScope).not.toHaveBeenCalled();
    expect(actions.toggleFavorite.mock.calls).toEqual([
      [{ source: 'removed-source', repo: 'acme/gone' }, false],
      [{ source: 'github', repo: 'acme/no-longer-listed' }, false],
    ]);
  });

  it.each(['unavailable', 'not-loaded', 'unverified', 'checking'] as const)(
    'makes every star read-only when preferences are %s',
    (status) => {
      const prefs = preferences();
      if (status === 'unavailable')
        prefs.view = {
          status,
          reason: 'storage-missing',
          message: 'The storage directory is missing.',
        };
      if (status === 'not-loaded') prefs.view = { status };
      if (status === 'unverified')
        prefs.view = { status, preferences: prefs.confirmed!, message: 'The request failed.' };
      if (status === 'checking') prefs.rereadRequired = true;
      const { root, actions } = setup(DEFAULT_ROUTE, prefs);
      const message = descendants(root, (el) => el.getAttribute('role') === 'status')[0]!;
      expect(message.textContent).toContain(
        status === 'unavailable'
          ? 'Personal preferences are unavailable.'
          : 'Favorites are read-only.',
      );
      const stars = byClass(root, 'project-sidebar-star');
      expect(stars.length).toBeGreaterThan(0);
      for (const star of stars) {
        expect(star.getAttribute('aria-disabled')).toBe('true');
        expect(star.getAttribute('aria-describedby')).toBe(message.getAttribute('id'));
        expect(star.getAttribute('disabled')).toBeNull();
        star.click();
      }
      expect(actions.toggleFavorite).not.toHaveBeenCalled();
      expect(named(root, 'Open gitea / acme/api')).toHaveLength(
        status === 'unverified' || status === 'checking' ? 2 : 1,
      );
    },
  );

  it('marks the exact source-qualified current scope and does not reselect it', () => {
    const prefs = preferences();
    const { root, view, state, actions } = setup(
      { ...DEFAULT_ROUTE, scope: { kind: 'project', source: 'gitea', owner: 'acme', repo: 'api' } },
      prefs,
    );
    expect(
      named(root, 'Open gitea / acme/api').every(
        (entry) => entry.getAttribute('aria-current') === 'page',
      ),
    ).toBe(true);
    expect(
      named(root, 'Open github / acme/api').every(
        (entry) => entry.getAttribute('aria-current') === null,
      ),
    ).toBe(true);
    named(root, 'Open gitea / acme/api')[0]!.click();
    expect(actions.selectScope).not.toHaveBeenCalled();
    view.update(
      { route: { ...state.route, scope: { kind: 'source', source: 'github' } } },
      prefs,
      catalog,
    );
    expect(
      descendants(root, (el) => el.getAttribute('aria-current') === 'page').map((entry) =>
        entry.getAttribute('aria-label'),
      ),
    ).toEqual(['All projects from github']);
    view.update({ route: { ...DEFAULT_ROUTE, viewId: 'roadmap' } }, prefs, catalog);
    expect(named(root, 'Views')[0]!.getAttribute('aria-current')).toBe('page');
  });

  it('toggles Projects repeatedly, leaves it open for stars and closes after a choice or Escape', () => {
    const { root, toggle, actions } = setup();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(
      named(root, 'Projects and views')[0]!.getAttribute('id'),
    );
    toggle.click();
    expect(root.classList.contains('is-open')).toBe(true);
    named(root, 'Remove github / acme/api from favorites')[0]!.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    named(root, 'Open github / acme/api')[0]!.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(dom.activeElement).toBe(toggle);
    toggle.click();
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    root.dispatch('keydown', event);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    toggle.click();
    named(root, 'Views')[0]!.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(actions.openViews).toHaveBeenCalledOnce();
  });

  it('closes the disclosure when choosing the current scope without navigating', () => {
    const { root, toggle, actions } = setup({
      ...DEFAULT_ROUTE,
      scope: { kind: 'source', source: 'github' },
    });
    toggle.click();
    named(root, 'All projects from github')[0]!.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(actions.selectScope).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus on a star across updates and falls back to the catalog after unstar', () => {
    const { root, view, state } = setup();
    named(root, 'Remove gitea / acme/api from favorites')[0]!.focus();
    view.update(state, preferences(), catalog);
    expect(dom.activeElement).toBe(named(root, 'Remove gitea / acme/api from favorites')[0]);
    view.update(
      state,
      preferences([{ source: 'github', repo: 'acme/api', inCatalog: true }]),
      catalog,
    );
    expect(dom.activeElement).toBe(named(root, 'Add gitea / acme/api to favorites')[0]);
  });

  it('does not rebuild controls on unrelated issue, tab, or filter updates', () => {
    const prefs = preferences();
    const { root, view, state } = setup(DEFAULT_ROUTE, prefs);
    const star = named(root, 'Remove gitea / acme/api from favorites')[0]!;
    star.focus();
    view.update({ route: { ...state.route, tab: 'order', q: 'status:ready' } }, prefs, catalog);
    expect(named(root, 'Remove gitea / acme/api from favorites')[0]).toBe(star);
    expect(dom.activeElement).toBe(star);
  });

  it('uses named native buttons for every action, without nested buttons or negative tab indices', () => {
    const { root } = setup();
    for (const button of descendants(root, (el) => el.tagName === 'button')) {
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-label') ?? button.textContent).not.toBe('');
      expect(button.getAttribute('tabindex')).toBeNull();
      expect(descendants(button, (el) => el.tagName === 'button')).toHaveLength(1);
    }
  });

  it('handles a missing catalog and empty favorites without inventing projects', () => {
    const { root } = setup(DEFAULT_ROUTE, preferences([]), null);
    expect(root.textContent).toContain('No favorites yet.');
    expect(root.textContent).toContain('Projects have not loaded.');
    expect(byClass(root, 'project-sidebar-star')).toHaveLength(0);
    expect(named(root, 'Views')).toHaveLength(1);
  });
});
