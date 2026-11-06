import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { absoluteTime } from '../format.js';
import { createScopeStates } from './states.js';

class FakeText {
  constructor(private readonly data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly childNodes: (FakeElement | FakeText)[] = [];
  scrollTop = 0;
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly classList = {
    add: (c: string): void => void this.classes.add(c),
    remove: (c: string): void => void this.classes.delete(c),
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string, on?: boolean): boolean => {
      const value = on ?? !this.classes.has(c);
      if (value) this.classes.add(c);
      else this.classes.delete(c);
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
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({});
  }
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new FakeText(n) : n);
  }
  removeChild(node: FakeElement | FakeText): void {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes.length = 0;
    if (v !== '') this.childNodes.push(new FakeText(v));
  }
  querySelector(): null {
    return null;
  }
}

beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
});

afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
});

function descendants(el: FakeElement, pred: (e: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    if (pred(node)) found.push(node);
    for (const child of node.childNodes) if (child instanceof FakeElement) visit(child);
  };
  visit(el);
  return found;
}

describe('scope state panels', () => {
  it('starts loading, never reports an empty project, and clears after data arrives', () => {
    const panel = createScopeStates();
    const el = panel.el as unknown as FakeElement;
    expect(el.textContent).toContain('Loading project data');
    expect(el.getAttribute('aria-busy')).toBe('true');
    panel.update({ kind: 'loading' });
    expect(el.textContent).not.toContain('No open issues');
    panel.update({ kind: 'ready' });
    expect(panel.el.hidden).toBe(true);
    expect(el.textContent).toBe('');
    expect(el.getAttribute('aria-busy')).toBe('false');
  });

  it('shows no-data failures verbatim as text and supports recovery', () => {
    const panel = createScopeStates();
    panel.update({ kind: 'unavailable', message: '<img onerror=alert(1)> denied' });
    expect(panel.el.textContent).toContain('<img onerror=alert(1)> denied');
    expect(
      descendants(panel.el as unknown as FakeElement, (e) => e.tagName === 'img'),
    ).toHaveLength(0);
    expect(panel.el.getAttribute('aria-busy')).toBe('false');
    panel.update({ kind: 'loading', message: 'Trying again' });
    expect(panel.el.textContent).toContain('Trying again');
    expect(panel.el.textContent).not.toContain('denied');
  });

  it('shows cooldown reason and the local expected end, preserving the exact timestamp', () => {
    const panel = createScopeStates();
    panel.update({
      kind: 'delayed',
      message: 'Source quota exhausted',
      expectedEnd: '2026-11-06T23:00:00Z',
    });
    expect(panel.el.textContent).toContain('Refresh delayed');
    expect(panel.el.textContent).toContain('Source quota exhausted');
    const times = descendants(panel.el as unknown as FakeElement, (e) => e.tagName === 'time');
    expect(times[0]?.getAttribute('datetime')).toBe('2026-11-06T23:00:00Z');
    expect(times).toHaveLength(1);
    expect(times[0]?.textContent).toBe(absoluteTime('2026-11-06T23:00:00Z'));
    expect(times[0]?.textContent).not.toBe('2026-11-06T23:00:00Z');
  });

  it('explains every part of a source policy conflict', () => {
    const panel = createScopeStates();
    panel.update({
      kind: 'policy-conflict',
      conflict: {
        source: 'work',
        differingSettings: ['dependencies.native', 'scope'],
        views: ['bugs', 'roadmap'],
        explanation: 'Views disagree on planning.',
      },
    });
    for (const text of [
      'work',
      'dependencies.native',
      'scope',
      'bugs',
      'roadmap',
      'Views disagree on planning.',
      'sources[].planning',
    ])
      expect(panel.el.textContent).toContain(text);
  });

  it('explains explicit links outside the catalog without touching navigation', () => {
    const sidebar = new FakeElement('nav');
    sidebar.append('Available projects');
    const panel = createScopeStates();
    panel.update({ kind: 'not-in-catalog', source: 'work', repo: 'owner/gone' });
    expect(panel.el.textContent).toContain('work / owner/gone');
    expect(panel.el.textContent).toContain('sidebar');
    expect(sidebar.textContent).toBe('Available projects');
    panel.update({ kind: 'not-in-catalog', source: 'missing-source' });
    expect(panel.el.textContent).toContain('missing-source');
    expect(panel.el.textContent).not.toContain('owner/gone');
  });

  it('shows preference read errors and allows manual project choice', () => {
    const chooseProject = vi.fn();
    const panel = createScopeStates({ chooseProject });
    panel.update({ kind: 'preference-error', reason: 'unreadable', message: 'Permission denied' });
    expect(panel.el.textContent).toContain('Permission denied');
    expect(panel.el.textContent).toContain('unreadable');
    expect(panel.el.textContent).toContain('manually');
    descendants(panel.el as unknown as FakeElement, (e) => e.tagName === 'button')[0]?.click();
    expect(chooseProject).toHaveBeenCalledOnce();
    const noCallback = createScopeStates();
    noCallback.update({ kind: 'preference-error', reason: 'corrupt', message: 'Invalid JSON' });
    expect(noCallback.el.textContent).toContain('sidebar');
    expect(
      descendants(noCallback.el as unknown as FakeElement, (e) => e.tagName === 'button'),
    ).toHaveLength(0);
  });
});
