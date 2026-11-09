import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryFreshness, ScopeFreshness, SweepStatus } from '../../../src/core/scope.js';
import type { Snapshot } from '../../../src/core/types.js';
import { absoluteTime } from '../format.js';
import { initialPreferenceState, type PreferenceState } from '../preferenceState.js';
import { INITIAL_STATE, reducer, type AppState } from '../state.js';
import { createScopeHeading } from './scope-heading.js';

// Minimal DOM: assertions exercise rendered labels, timestamps, visibility and
// real event callbacks without depending on markup snapshots or browser layout.
class Text {
  constructor(readonly textContent: string) {}
}
class Element {
  readonly attributes = new Map<string, string>();
  readonly childNodes: (Element | Text)[] = [];
  private readonly listeners = new Map<string, (() => void)[]>();
  hidden = false;
  disabled = false;
  title = '';
  readonly classList = {
    toggle: (name: string, on: boolean): void => {
      const classes = new Set((this.getAttribute('class') ?? '').split(' '));
      if (on) classes.add(name);
      else classes.delete(name);
      this.setAttribute('class', [...classes].join(' '));
    },
  };
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener();
  }
  append(...children: (Element | Text)[]): void {
    this.childNodes.push(...children);
  }
  get firstChild(): Element | Text | null {
    return this.childNodes[0] ?? null;
  }
  removeChild(child: Element | Text): void {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.childNodes.length = 0;
    if (text) this.childNodes.push(new Text(text));
  }
}
function all(root: Element, predicate: (el: Element) => boolean): Element[] {
  return [
    ...(predicate(root) ? [root] : []),
    ...root.childNodes.flatMap((child) => (child instanceof Element ? all(child, predicate) : [])),
  ];
}
function cls(root: Element, name: string): Element[] {
  return all(root, (el) => (el.getAttribute('class') ?? '').split(' ').includes(name));
}
function dates(root: Element): string[] {
  return all(root, (el) => el.tagName === 'time').map((el) => el.getAttribute('datetime')!);
}
const checked = '2026-01-01T10:00:00Z';
const recent = '2026-01-01T11:59:00Z';
const computed = '2026-01-01T11:59:58Z';
const delayed = '2026-01-01T12:30:00Z';
const snapshot: Snapshot = {
  viewId: 'project:gh/o/r',
  title: 'o/r',
  fetchedAt: checked,
  contentHash: 'hash',
  priorityLabels: [],
  orderingMode: 'priority',
  plan: {
    viewId: 'project:gh/o/r',
    nodes: [],
    edges: [],
    order: [],
    waves: [],
    cycles: [],
    unschedulable: [],
    criticalPath: [],
    warnings: [],
    stats: { total: 0, ready: 0, blocked: 0, unschedulable: 0, external: 0, edges: 0, waves: 0 },
  },
  layout: { width: 0, height: 0, nodes: [], edges: [] },
};
function repository(overrides: Partial<RepositoryFreshness> = {}): RepositoryFreshness {
  return {
    project: { source: 'gh', repo: 'o/r' },
    lastCheckedAt: checked,
    state: 'fresh',
    partial: false,
    error: null,
    delayedUntil: null,
    ...overrides,
  };
}
function freshness(repositories = [repository()]): ScopeFreshness {
  return {
    repositories,
    computedAt: computed,
    outsideIssues: { count: 3, oldestObservedAt: checked, provisionalCount: 2 },
  };
}
function state(overrides: Partial<AppState> = {}): AppState {
  return {
    ...INITIAL_STATE,
    route: {
      ...INITIAL_STATE.route,
      scope: { kind: 'project', source: 'gh', owner: 'o', repo: 'r' },
      q: 'status:ready',
      tab: 'order',
    },
    status: 'ready',
    snapshot,
    freshness: freshness(),
    ...overrides,
  };
}
function preferences(favorite = false): PreferenceState {
  return {
    ...initialPreferenceState(),
    view: {
      status: 'available',
      preferences: {
        available: true,
        revision: 1,
        rememberedProject: null,
        favorites: favorite ? [{ source: 'gh', repo: 'o/r', inCatalog: true }] : [],
      },
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_namespace: string, tag: string) => new Element(tag),
    createTextNode: (text: string) => new Text(text),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function heading() {
  const toggleFavorite = vi.fn();
  const view = createScopeHeading({ toggleFavorite });
  return { view, root: view.el as unknown as Element, toggleFavorite };
}

describe('scope heading identity and controls', () => {
  it('shows the source and project and reports star changes without mutating state', () => {
    const { view, root, toggleFavorite } = heading();
    const app = state();
    const original = structuredClone(app);
    const prefs = preferences();
    view.update(app, prefs);
    expect(root.hidden).toBe(false);
    expect(cls(root, 'scope-source')[0]!.textContent).toBe('Source: gh');
    expect(cls(root, 'scope-title')[0]!.textContent).toBe('o/r');
    const star = cls(root, 'scope-star')[0]!;
    expect(star.hidden).toBe(false);
    expect(star.getAttribute('type')).toBe('button');
    expect(star.getAttribute('aria-label')).toBe('Add gh/o/r to favorites');
    expect(star.getAttribute('aria-pressed')).toBe('false');
    star.click();
    expect(toggleFavorite).toHaveBeenLastCalledWith({ source: 'gh', repo: 'o/r' }, true);
    expect(app).toEqual(original);
    expect(app.snapshot).toBe(snapshot);
    expect(star.getAttribute('aria-pressed')).toBe('false');
    expect(prefs.view).toEqual(preferences().view);
    view.update(app, preferences(true));
    expect(cls(root, 'scope-star')[0]).toBe(star); // Updates preserve keyboard focus.
    expect(star.getAttribute('aria-pressed')).toBe('true');
    star.click();
    expect(toggleFavorite).toHaveBeenLastCalledWith({ source: 'gh', repo: 'o/r' }, false);
  });

  it('shows All projects without a star and hides the whole heading for named views', () => {
    const { view, root, toggleFavorite } = heading();
    view.update(
      state({ route: { ...INITIAL_STATE.route, scope: { kind: 'source', source: 'git' } } }),
      preferences(),
    );
    expect(cls(root, 'scope-source')[0]!.textContent).toBe('Source: git');
    expect(cls(root, 'scope-title')[0]!.textContent).toBe('All projects');
    expect(cls(root, 'scope-star')[0]!.hidden).toBe(true);
    cls(root, 'scope-star')[0]!.click();
    expect(toggleFavorite).not.toHaveBeenCalled();
    view.update(state({ route: { ...INITIAL_STATE.route, viewId: 'named' } }), preferences());
    expect(root.hidden).toBe(true);
    cls(root, 'scope-star')[0]!.click();
    expect(toggleFavorite).not.toHaveBeenCalled();
  });

  it('displays the friendly source title from the catalog when available', () => {
    const { view, root } = heading();
    view.update(state(), preferences(), null, {
      sources: [
        {
          id: 'gh',
          title: 'GitHub',
          kind: 'github',
          projects: [{ source: 'gh', repo: 'o/r' }],
          policy: { status: 'usable' },
        },
      ],
    });
    expect(cls(root, 'scope-source')[0]!.textContent).toBe('Source: GitHub');
  });

  it.each(['not-loaded', 'unavailable', 'unverified', 'reread'] as const)(
    'keeps %s favorites read-only with an explanation',
    (mode) => {
      const { view, root, toggleFavorite } = heading();
      const prefs = preferences(true);
      if (mode === 'not-loaded') prefs.view = { status: 'not-loaded' };
      if (mode === 'unavailable')
        prefs.view = { status: 'unavailable', reason: 'login-disabled', message: 'Login disabled' };
      if (mode === 'unverified' && prefs.view.status === 'available')
        prefs.view = { ...prefs.view, status: 'unverified', message: 'Read failed' };
      if (mode === 'reread') prefs.rereadRequired = true;
      view.update(state(), prefs);
      const star = cls(root, 'scope-star')[0]!;
      expect(star.getAttribute('aria-disabled')).toBe('true');
      expect(star.getAttribute('disabled')).toBeNull(); // Remains keyboard reachable.
      expect(star.title).not.toBe('');
      expect(cls(root, 'scope-preference-notice')[0]!.hidden).toBe(false);
      star.click();
      expect(toggleFavorite).not.toHaveBeenCalled();
    },
  );

  it('contains all three refresh controls but hides each until its own callback is wired', () => {
    const { view, root } = heading();
    view.update(state(), preferences());
    const buttons = cls(root, 'scope-refresh-controls')[0]!.childNodes as Element[];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Refresh this project',
      'Refresh this source',
      'Refresh all sources',
    ]);
    expect(buttons.every((button) => button.hidden)).toBe(true);

    const refreshProject = vi.fn();
    const wired = createScopeHeading({ toggleFavorite() {}, refreshProject });
    wired.update(state(), preferences());
    const wiredButtons = cls(wired.el as unknown as Element, 'scope-refresh-controls')[0]!
      .childNodes as Element[];
    expect(wiredButtons.map((button) => button.hidden)).toEqual([false, true, true]);
    wiredButtons[0]!.click();
    expect(refreshProject).toHaveBeenCalledWith({ source: 'gh', repo: 'o/r' });
  });

  it('refresh callbacks use the latest scope and project refresh disappears for All projects', () => {
    const refreshProject = vi.fn(),
      refreshSource = vi.fn(),
      refreshAllSources = vi.fn();
    const view = createScopeHeading({
      toggleFavorite() {},
      refreshProject,
      refreshSource,
      refreshAllSources,
    });
    view.update(state(), preferences());
    view.update(
      state({ route: { ...INITIAL_STATE.route, scope: { kind: 'source', source: 'second' } } }),
      preferences(),
    );
    const buttons = cls(view.el as unknown as Element, 'scope-refresh-controls')[0]!
      .childNodes as Element[];
    expect(buttons.map((button) => button.hidden)).toEqual([true, false, false]);
    buttons.forEach((button) => button.click());
    expect(refreshProject).not.toHaveBeenCalled();
    expect(refreshSource).toHaveBeenCalledWith('second');
    expect(refreshAllSources).toHaveBeenCalledOnce();
  });
});

describe('scope freshness', () => {
  it('shows sub-minute ages as just now while keeping exact local timestamp tooltips', () => {
    const { view, root } = heading();
    const justChecked = '2026-01-01T11:59:30Z';
    view.update(
      state({
        snapshot: { ...snapshot, fetchedAt: justChecked },
        freshness: freshness([repository({ lastCheckedAt: justChecked })]),
      }),
      preferences(),
    );
    expect(cls(root, 'scope-check-time')[0]!.textContent).toBe('Last successful check: just now');
    expect(cls(root, 'scope-fetch-time')[0]!.textContent).toBe(
      'Data fetched: just now (oldest contributing repository check)',
    );
    for (const label of ['scope-check-time', 'scope-fetch-time']) {
      const timestamp = all(cls(root, label)[0]!, (el) => el.tagName === 'time')[0]!;
      expect(timestamp.getAttribute('datetime')).toBe(justChecked);
      expect(timestamp.getAttribute('title')).toBe(absoluteTime(justChecked));
    }
  });

  it('shows mixed repository ages, every state, outside coverage, and separate fetch and computation times', () => {
    const { view, root } = heading();
    const states = [
      'fresh',
      'stale',
      'updating',
      'invalidated',
      'delayed',
      'failed',
      'unavailable',
    ] as const;
    const repositories = states.map((status, i) =>
      repository({
        project: { source: 'gh', repo: `o/${status}` },
        state: status,
        lastCheckedAt: i > 4 ? null : i === 0 ? recent : checked,
        delayedUntil: status === 'delayed' ? delayed : null,
        partial: status === 'stale',
        error: status === 'failed' ? 'Provider refused access' : null,
      }),
    );
    view.update(state({ freshness: freshness(repositories) }), preferences());
    const rows = cls(root, 'scope-repository');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(states);
    expect(rows[0]!.textContent).toContain('Last successful check: 1 min ago');
    expect(rows[1]!.textContent).toContain('Last successful check: 2 h ago');
    expect(rows[1]!.textContent).toContain('Partial coverage');
    expect(rows[4]!.textContent).toContain(`Expected to resume: ${absoluteTime(delayed)}`);
    expect(dates(rows[4]!)).toEqual([checked, delayed]);
    expect(rows[5]!.textContent).toContain('No successful check');
    expect(rows[5]!.textContent).toContain('Provider refused access');
    expect(rows[6]!.textContent).toContain('Unavailable');
    expect(dates(rows[6]!)).toEqual([]);
    expect(cls(root, 'scope-outside-issues')[0]!.textContent).toBe(
      '3 outside issues · Oldest observation: 2 h ago · 2 provisional',
    );
    expect(dates(cls(root, 'scope-outside-issues')[0]!)).toEqual([checked]);
    expect(dates(cls(root, 'scope-fetch-time')[0]!)).toEqual([checked]);
    expect(dates(cls(root, 'scope-computed-time')[0]!)).toEqual([computed]);
  });

  it.each(['failed', 'stale'] as const)(
    'marks last-good data stale after a %s refresh and preserves its time and error',
    (status) => {
      const { view, root } = heading();
      const app = state({
        freshness: freshness([repository({ state: status, error: 'Upstream 503' })]),
      });
      view.update(app, preferences());
      const row = cls(root, 'scope-repository')[0]!;
      expect(row.getAttribute('data-state')).toBe('stale');
      expect(row.textContent).toContain('Stale');
      expect(row.textContent).toContain('Upstream 503');
      expect(dates(row)).toEqual([checked]);
      expect(dates(cls(root, 'scope-fetch-time')[0]!)).toEqual([checked]);
      expect(app.freshness!.repositories[0]!.state).toBe(status);
    },
  );

  it('shows transport failure details from scope state alongside retained data', () => {
    const { view, root } = heading();
    const failed = reducer(state(), {
      type: 'scope-failed',
      scope: { kind: 'project', source: 'gh', repo: 'o/r' },
      status: 503,
      error: 'Connection lost',
    });
    view.update(failed, preferences());
    expect(root.textContent).toContain('Refresh error: Connection lost');
    expect(cls(root, 'scope-repository')[0]!.getAttribute('data-state')).toBe('stale');
    expect(dates(cls(root, 'scope-repository')[0]!)).toEqual([checked]);
  });

  it('does not invent check, observation or computation times for missing data', () => {
    const { view, root } = heading();
    view.update(
      state({
        snapshot: null,
        freshness: {
          repositories: [repository({ state: 'unavailable', lastCheckedAt: null })],
          computedAt: null,
          outsideIssues: { count: 0, oldestObservedAt: null, provisionalCount: 0 },
        },
      }),
      preferences(),
    );
    expect(dates(root)).toEqual([]);
    expect(root.textContent).toContain('No successful check');
    expect(root.textContent).toContain(
      '0 outside issues · Oldest observation: none · 0 provisional',
    );
    expect(root.textContent).toContain('Plan computed: not computed');
    expect(root.textContent).toContain('Data fetched: unavailable');
    view.update(state({ snapshot: null, freshness: null }), preferences());
    expect(root.textContent).toContain('Freshness is not available yet.');
    expect(cls(root, 'scope-repository')).toEqual([]);
  });
});

describe('scope sweep progress', () => {
  it('shows start, per-project progress and check times, and conflicted or delayed sources', () => {
    const { view, root } = heading();
    const sweep: SweepStatus = {
      id: 'sweep-1',
      trigger: 'interactive',
      state: 'running',
      startedAt: checked,
      finishedAt: null,
      sources: [
        {
          source: 'gh',
          state: 'running',
          delayedUntil: null,
          error: null,
          policyConflict: null,
          projects: (['checked', 'queued', 'checking', 'failed'] as const).map((status, i) => ({
            project: { source: 'gh', repo: `o/${status}` },
            state: status,
            lastCheckedAt: i === 0 ? recent : i === 1 ? null : checked,
            error: status === 'failed' ? 'Rate check failed' : null,
          })),
        },
        {
          source: 'conflicted',
          state: 'conflict',
          delayedUntil: null,
          error: null,
          projects: [],
          policyConflict: {
            source: 'conflicted',
            explanation: 'Views disagree on planning policy.',
            differingSettings: ['dependencies.native'],
            views: ['old', 'new'],
          },
        },
        {
          source: 'later',
          state: 'delayed',
          delayedUntil: delayed,
          error: null,
          policyConflict: null,
          projects: [],
        },
      ],
    };
    view.update(state(), preferences(), { sweep, launching: false, error: null });
    const progress = cls(root, 'scope-progress')[0]!;
    expect(progress.hidden).toBe(false);
    expect(cls(progress, 'scope-sweep-summary')[0]!.textContent).toContain('Started: 2 h ago');
    expect(cls(progress, 'scope-sweep-summary')[0]!.textContent).toContain(
      '1 checked · 1 checking · 1 queued · 1 failed',
    );
    const rows = cls(progress, 'scope-repository');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual([
      'checked',
      'queued',
      'checking',
      'failed',
    ]);
    expect(rows.map(dates)).toEqual([[recent], [], [checked], [checked]]);
    expect(rows[3]!.textContent).toContain('Rate check failed');
    expect(progress.textContent).toContain('conflicted');
    expect(progress.textContent).toContain('Policy conflict: Views disagree on planning policy.');
    expect(progress.textContent).toContain('Differing settings: dependencies.native');
    expect(progress.textContent).toContain('Views: old, new');
    expect(progress.textContent).toContain(`Expected to resume: ${absoluteTime(delayed)}`);
    view.update(state(), preferences(), {
      sweep: { ...sweep, state: 'partial', finishedAt: computed },
      launching: false,
      error: null,
    });
    expect(dates(cls(progress, 'scope-sweep-summary')[0]!)).toEqual([checked, computed]);
    view.update(state(), preferences());
    expect(progress.hidden).toBe(true);
    expect(progress.textContent).toBe('');
  });
});

describe('refresh control busy states', () => {
  function controls() {
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];
    const view = createScopeHeading({
      toggleFavorite() {},
      refreshProject: callbacks[0],
      refreshSource: callbacks[1],
      refreshAllSources: callbacks[2],
    });
    const buttons = cls(view.el as unknown as Element, 'scope-refresh-controls')[0]!
      .childNodes as Element[];
    return { view, buttons, callbacks };
  }
  const idle = ['Refresh this project', 'Refresh this source', 'Refresh all sources'];
  const busy = ['Refreshing project…', 'Refreshing source…', 'Refreshing all sources…'];
  const sweep: SweepStatus = {
    id: 'sweep',
    trigger: 'interactive',
    state: 'running',
    startedAt: checked,
    finishedAt: null,
    sources: [],
  };

  it.each(['project', 'source'] as const)(
    'disables only the %s button immediately, then keeps it busy for queued/running jobs',
    (kind) => {
      const { view, buttons, callbacks } = controls();
      const index = kind === 'project' ? 0 : 1;
      const scope =
        kind === 'project' ? { kind, source: 'gh', repo: 'o/r' } : { kind, source: 'gh' };
      const job = {
        id: 'job',
        scope,
        trigger: 'interactive' as const,
        state: 'queued' as const,
        queuedAt: checked,
        startedAt: null,
        finishedAt: null,
        delayedUntil: null,
        error: null,
      };
      for (const app of [
        state({ refreshingScope: kind }),
        state({ job }),
        state({ job: { ...job, state: 'running' } }),
      ]) {
        view.update(app, preferences());
        expect(buttons.map((button) => button.disabled)).toEqual([index === 0, index === 1, false]);
        expect(buttons.map((button, i) => button.textContent)).toEqual(
          idle.map((label, i) => (i === index ? busy[i] : label)),
        );
        buttons[index]!.click();
        expect(callbacks[index]).not.toHaveBeenCalled();
        expect((buttons[index]!.childNodes[0] as Element).tagName).toBe('svg');
      }
      for (const result of ['completed', 'partial', 'failed'] as const) {
        view.update(state({ job: { ...job, state: result } }), preferences());
        expect(buttons.map((button) => button.disabled)).toEqual([false, false, false]);
        expect(buttons.map((button) => button.textContent)).toEqual(idle);
      }
      view.update(state(), preferences());
      buttons[index]!.click();
      expect(callbacks[index]).toHaveBeenCalledOnce();
    },
  );

  it('keeps a covering source job busy on All projects and across another project request', () => {
    const { view, buttons } = controls();
    const job = {
      id: 'source',
      scope: { kind: 'source' as const, source: 'gh' },
      trigger: 'interactive' as const,
      state: 'running' as const,
      queuedAt: checked,
      startedAt: checked,
      finishedAt: null,
      delayedUntil: null,
      error: null,
    };
    view.update(state({ job, refreshingScope: 'project' }), preferences());
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, false]);
    view.update(state({ job, route: { ...INITIAL_STATE.route, scope: job.scope } }), preferences());
    expect(buttons[0]!.hidden).toBe(true);
    expect(buttons[1]!.textContent).toBe(busy[1]);
    expect(buttons[1]!.disabled).toBe(true);
  });

  it('keeps all sources busy during launch and active sweep states and releases every terminal state', () => {
    const { view, buttons, callbacks } = controls();
    for (const sweepState of [
      { sweep: null, launching: true, error: null },
      { sweep: { ...sweep, state: 'completed' as const }, launching: true, error: null },
      { sweep: { ...sweep, state: 'queued' as const }, launching: false, error: null },
      { sweep, launching: false, error: 'Status read failed' },
    ]) {
      view.update(state(), preferences(), sweepState);
      expect(buttons.map((button) => button.disabled)).toEqual([false, false, true]);
      expect(buttons.map((button) => button.textContent)).toEqual([idle[0], idle[1], busy[2]]);
      buttons[2]!.click();
      expect(callbacks[2]).not.toHaveBeenCalled();
    }
    for (const result of ['completed', 'partial', 'failed', 'skipped'] as const) {
      view.update(state(), preferences(), {
        sweep: { ...sweep, state: result },
        launching: false,
        error: null,
      });
      expect(buttons.map((button) => button.disabled)).toEqual([false, false, false]);
      expect(buttons.map((button) => button.textContent)).toEqual(idle);
    }
    view.update(state(), preferences(), { sweep: null, launching: false, error: 'Launch failed' });
    expect(buttons[2]!.disabled).toBe(false);
    buttons[2]!.click();
    expect(callbacks[2]).toHaveBeenCalledOnce();
  });
});
