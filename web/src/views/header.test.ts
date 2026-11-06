import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewSummary } from '../api.js';
import { DEFAULT_ROUTE, type RouteScope } from '../route.js';
import { INITIAL_STATE, Store, type AppState } from '../state.js';
import type { Actions } from './shared.js';

// Minimal DOM for the real header/menu interaction, without a browser dependency.
class FakeText {
  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly childNodes: (FakeElement | FakeText)[] = [];
  value = '';
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly classList = {
    toggle: (name: string, on?: boolean): boolean => {
      const classes = new Set((this.getAttribute('class') ?? '').split(' '));
      const value = on ?? !classes.has(name);
      if (value) classes.add(name);
      else classes.delete(name);
      this.setAttribute('class', [...classes].join(' '));
      return value;
    },
  };

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  get hidden(): boolean {
    return this.attributes.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.setAttribute('hidden', '');
    else this.attributes.delete('hidden');
  }
  get disabled(): boolean {
    return this.attributes.has('disabled');
  }
  set disabled(value: boolean) {
    if (value) this.setAttribute('disabled', '');
    else this.attributes.delete('disabled');
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ stopPropagation() {} });
  }
  click(): void {
    if (!this.disabled) this.emit('click');
  }
  focus(): void {}
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new FakeText(n) : n);
  }
  removeChild(node: FakeElement | FakeText): void {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  get firstElementChild(): FakeElement | null {
    return this.childNodes.find((node) => node instanceof FakeElement) ?? null;
  }
  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes.length = 0;
    if (value !== '') this.childNodes.push(new FakeText(value));
  }
  querySelector(): FakeElement | null {
    return (
      descendants(this, (el) => el.getAttribute('role')?.startsWith('menuitem') ?? false)[0] ?? null
    );
  }
}

function descendants(el: FakeElement, pred: (el: FakeElement) => boolean): FakeElement[] {
  return [
    ...(pred(el) ? [el] : []),
    ...el.childNodes.flatMap((node) =>
      node instanceof FakeElement ? descendants(node, pred) : [],
    ),
  ];
}

const documentEvents = new FakeElement('document');
let createHeader: typeof import('./header.js').createHeader;

beforeAll(async () => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    activeElement: null,
  });
  ({ createHeader } = await import('./header.js'));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ username: 'operator', version: '3.1.0' })),
  );
});

afterEach(() => {
  documentEvents.emit('click');
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(() => vi.unstubAllGlobals());

const views: ViewSummary[] = [
  { id: 'view /?#', title: 'First view', source: 'gh', kind: 'github', repos: ['owner/repo'] },
  { id: 'second', title: 'Second view', source: 'gh', kind: 'github', repos: ['owner/other'] },
];

const project: RouteScope = { kind: 'project', source: 'gh /?#', owner: 'own er', repo: 're#po' };
const source: RouteScope = { kind: 'source', source: 'forge /?#' };
const formats = ['json', 'md', 'mmd', 'dot'];

function headerWith(extra: Partial<AppState> = {}) {
  const state: AppState = {
    ...INITIAL_STATE,
    views,
    route: { ...DEFAULT_ROUTE, viewId: views[0]!.id },
    loadedViewId: views[0]!.id,
    ...extra,
  };
  const store = new Store(state);
  const actions: Actions = {
    select: vi.fn(),
    showInGraph: vi.fn(),
    setTab: vi.fn(),
    setView: vi.fn(),
    setQuery: vi.fn(),
    setSort: vi.fn(),
    refresh: vi.fn(),
    reload: vi.fn(),
  };
  const header = createHeader({ store, actions });
  store.subscribe(header.update);
  header.update(state, INITIAL_STATE);
  const el = header.el as unknown as FakeElement;
  const find = (pred: (el: FakeElement) => boolean): FakeElement => {
    const element = descendants(el, pred)[0];
    if (element === undefined) throw new Error('Header element not found');
    return element;
  };
  return {
    store,
    actions,
    select: find((e) => e.getAttribute('id') === 'view-select'),
    viewSwitch: find((e) => e.getAttribute('class') === 'view-switch'),
    crumb: find((e) => e.getAttribute('class') === 'crumb-sep'),
    refresh: find((e) => e.tagName === 'button' && e.textContent === 'Refresh'),
    exportButton: find((e) => e.tagName === 'button' && e.textContent === 'Export'),
    exportLinks: () =>
      descendants(el, (e) => e.tagName === 'a' && e.getAttribute('role') === 'menuitem'),
  };
}

function expectExports(header: ReturnType<typeof headerWith>, prefix: string): void {
  const links = header.exportLinks();
  expect(links.map((link) => link.getAttribute('href'))).toEqual(
    formats.map((format) => `${prefix}/export.${format}`),
  );
  for (const link of links) {
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).not.toContain('refresh=1');
  }
}

describe('header export destination and named-view controls', () => {
  it.each([
    ['project', project, 'api/projects/gh%20%2F%3F%23/own%20er/re%23po'],
    ['source', source, 'api/sources/forge%20%2F%3F%23'],
  ] as const)('exports cached %s data and hides view-only controls', (_name, scope, prefix) => {
    const header = headerWith({ route: { ...DEFAULT_ROUTE, scope, viewId: views[0]!.id } });
    expect(header.viewSwitch.hidden).toBe(true);
    expect(header.crumb.hidden).toBe(true);
    expect(header.refresh.hidden).toBe(true);
    expect(header.refresh.disabled).toBe(true);
    expect(header.exportButton.disabled).toBe(false);
    header.exportButton.click();
    expectExports(header, prefix);
  });

  it('keeps named-view exports, selection, and refresh behavior unchanged', () => {
    const header = headerWith();
    expect(header.viewSwitch.hidden).toBe(false);
    expect(header.crumb.hidden).toBe(false);
    expect(header.refresh.hidden).toBe(false);
    expect(header.refresh.disabled).toBe(false);
    expect(header.select.disabled).toBe(false);
    expect(header.select.value).toBe(views[0]!.id);
    expect(
      descendants(header.select, (e) => e.tagName === 'option').map((e) => e.textContent),
    ).toEqual(['First view', 'Second view']);
    header.exportButton.click();
    expectExports(header, 'api/views/view%20%2F%3F%23');
    header.select.value = 'second';
    header.select.emit('change');
    expect(header.actions.setView).toHaveBeenCalledWith('second');
    header.refresh.click();
    expect(header.actions.refresh).toHaveBeenCalledOnce();
    header.store.dispatch({ type: 'refresh-start', viewId: views[0]!.id });
    expect(header.refresh.disabled).toBe(true);
    expect(header.refresh.textContent).toBe('Refreshing');
    header.store.dispatch({ type: 'refresh-failed', viewId: views[0]!.id, error: 'Unavailable' });
    expect(header.refresh.disabled).toBe(false);
    expect(header.refresh.textContent).toBe('Refresh');
  });

  it('updates an open export menu across scopes and restores controls on return to a view', () => {
    const header = headerWith();
    header.exportButton.click();
    expectExports(header, 'api/views/view%20%2F%3F%23');
    for (const [scope, prefix] of [
      [project, 'api/projects/gh%20%2F%3F%23/own%20er/re%23po'],
      [source, 'api/sources/forge%20%2F%3F%23'],
      [
        { kind: 'project', source: 'other', owner: 'owner', repo: 'repo' },
        'api/projects/other/owner/repo',
      ],
    ] as const) {
      header.store.dispatch({ type: 'route', route: { ...DEFAULT_ROUTE, scope } });
      expectExports(header, prefix);
      expect(header.viewSwitch.hidden).toBe(true);
      expect(header.refresh.hidden).toBe(true);
    }
    header.store.dispatch({ type: 'route', route: { ...DEFAULT_ROUTE, viewId: 'second' } });
    expectExports(header, 'api/views/second');
    expect(header.viewSwitch.hidden).toBe(false);
    expect(header.crumb.hidden).toBe(false);
    expect(header.refresh.hidden).toBe(false);
    expect(header.refresh.disabled).toBe(false);
    expect(header.select.value).toBe('second');
    header.exportButton.click();
    header.exportButton.click();
    expectExports(header, 'api/views/second');
  });

  it('offers scope exports without waiting for the named-view catalog', () => {
    const header = headerWith({ views: null, route: { ...DEFAULT_ROUTE, scope: source } });
    expect(header.exportButton.disabled).toBe(false);
    header.exportButton.click();
    expectExports(header, 'api/sources/forge%20%2F%3F%23');
  });

  it('keeps the named-view fallback and unavailable catalog behavior', () => {
    const header = headerWith({ views: [views[0]!], route: DEFAULT_ROUTE });
    expect(header.select.disabled).toBe(true);
    header.exportButton.click();
    expectExports(header, 'api/views/view%20%2F%3F%23');
    header.store.dispatch({ type: 'views-loaded', views: [] });
    expect(header.refresh.disabled).toBe(true);
    expect(header.exportButton.disabled).toBe(true);
    expect(header.exportLinks()).toEqual([]);
  });
});
