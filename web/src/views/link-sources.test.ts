import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { PlanNode, Snapshot } from '../../../src/core/types.js';
import { INITIAL_STATE, type AppState } from '../state.js';
import { DEFAULT_ROUTE, type Tab } from '../route.js';
import { createProblemsView } from './problems.js';
import { createSidePanel } from './side-panel.js';
import type { ViewCtx } from './shared.js';

// ---------------------------------------------------------------------------
// Minimal DOM, enough for the two views under test. Node's vitest environment
// has no document; these views only need create/append/attribute/classList.
// ---------------------------------------------------------------------------

class FakeText {
  readonly nodeType = 3;
  constructor(private readonly data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  readonly childNodes: (FakeElement | FakeText)[] = [];
  hidden = false;
  scrollTop = 0;
  private readonly classes = new Set<string>();
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
  addEventListener(): void {}
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new FakeText(n) : n);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  removeChild(n: FakeElement | FakeText): void {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
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

function textOfClass(el: FakeElement, className: string): string[] {
  const found: string[] = [];
  const visit = (node: FakeElement): void => {
    if (node.getAttribute('class') === className) found.push(node.textContent);
    for (const child of node.childNodes) if (child instanceof FakeElement) visit(child);
  };
  visit(el);
  return found;
}

// ---------------------------------------------------------------------------
// Fixture: a two-issue cycle. #1 -> #2 is body-only; #2 -> #1 is native+body.
// ---------------------------------------------------------------------------

function node(key: string, extra: Partial<PlanNode> = {}): PlanNode {
  return {
    key,
    repo: { owner: 'o', repo: 'r' },
    number: Number(key.split('#')[1]),
    title: key,
    url: `https://x/${key}`,
    labels: [],
    assignees: [],
    milestone: null,
    external: false,
    status: 'in-cycle',
    wave: null,
    order: null,
    blockedBy: [],
    blocks: [],
    parents: [],
    children: [],
    closingPullRequests: [],
    priority: 0,
    remainingDepth: 0,
    ...extra,
  };
}

const snapshot: Snapshot = {
  viewId: 'v',
  title: 'V',
  fetchedAt: '2026-01-01T00:00:00Z',
  contentHash: 'h'.repeat(64),
  priorityLabels: [],
  orderingMode: 'priority',
  plan: {
    viewId: 'v',
    nodes: [
      node('o/r#1', { blockedBy: ['o/r#2'], blocks: ['o/r#2'] }),
      node('o/r#2', { blockedBy: ['o/r#1'], blocks: ['o/r#1'] }),
    ],
    edges: [
      { from: 'o/r#1', to: 'o/r#2', sources: ['body'] },
      { from: 'o/r#2', to: 'o/r#1', sources: ['native', 'body'] },
    ],
    order: [],
    waves: [],
    cycles: [['o/r#1', 'o/r#2']],
    unschedulable: ['o/r#1', 'o/r#2'],
    criticalPath: [],
    warnings: [{ code: 'cycle', message: 'loop', issues: ['o/r#1', 'o/r#2'] }],
    stats: {
      total: 2,
      ready: 0,
      blocked: 0,
      unschedulable: 2,
      external: 0,
      edges: 2,
      waves: 0,
    },
  },
  layout: { width: 10, height: 10, nodes: [], edges: [] },
};

function stateWith(selected: string | null, tab: Tab): AppState {
  return { ...INITIAL_STATE, snapshot, selected, route: { ...DEFAULT_ROUTE, tab } };
}

const ctx = {
  store: {},
  actions: {
    select() {},
    showInGraph() {},
    setTab() {},
    setView() {},
    setQuery() {},
    refresh() {},
    reload() {},
  },
} as unknown as ViewCtx;

describe('dependency link sources', () => {
  it('shows each direct prerequisite and dependent source in the details panel', () => {
    const panel = createSidePanel(ctx);
    panel.update(stateWith('o/r#1', 'graph'), INITIAL_STATE);
    const tags = textOfClass(panel.el as unknown as FakeElement, 'src-tag');
    expect(tags).toContain('native + body'); // prerequisites: #2 -> #1
    expect(tags).toContain('body'); // dependents: #1 -> #2
  });

  it('shows every link source on the drawn cycle loop', () => {
    const problems = createProblemsView(ctx);
    problems.update(stateWith(null, 'problems'), INITIAL_STATE);
    const tags = textOfClass(problems.el as unknown as FakeElement, 'src-tag');
    expect(tags).toContain('body'); // #1 -> #2
    expect(tags).toContain('native + body'); // #2 -> #1
  });
});

describe('partial All projects warning', () => {
  it('shows the explanation and unlisted repository names without needing issue keys', () => {
    const partial = structuredClone(snapshot);
    partial.plan.warnings = [
      {
        code: 'repository-unlisted',
        message: 'All projects plan is partial: s/a/other has no successful repository listing',
        issues: [],
      },
    ];
    const problems = createProblemsView(ctx);
    problems.update({ ...stateWith(null, 'problems'), snapshot: partial }, INITIAL_STATE);
    const root = problems.el as unknown as FakeElement;
    expect(root.textContent).toContain('All projects plan is partial');
    expect(root.textContent).toContain('These repositories have no successful issue listing yet.');
    expect(textOfClass(root, 'warn-msg')).toEqual([partial.plan.warnings[0]!.message]);
    problems.update(stateWith(null, 'problems'), INITIAL_STATE);
    expect(root.textContent).not.toContain('All projects plan is partial');
    expect(textOfClass(root, 'warn-msg')).toEqual([]);
  });
});

describe('scope freshness and coverage warnings', () => {
  it('explains stale observations and that provisional dependencies are not fully verified', () => {
    const scoped = structuredClone(snapshot);
    scoped.plan.warnings = [
      { code: 'stale-data', message: 'o/r uses its last successful check.', issues: ['o/r#1'] },
      {
        code: 'dependency-provisional',
        message: 'o/r#2 relation coverage could not be checked.',
        issues: ['o/r#2'],
      },
    ];
    const problems = createProblemsView(ctx);
    problems.update({ ...stateWith(null, 'problems'), snapshot: scoped }, INITIAL_STATE);
    const root = problems.el as unknown as FakeElement;
    expect(root.textContent).toContain('Plan uses stale data');
    expect(root.textContent).toContain('a failed refresh does not make that data current');
    expect(root.textContent).toContain('Dependencies are provisional');
    expect(root.textContent).toContain('blockers are kept');
    expect(root.textContent).toContain(
      'A plan with provisional dependencies is not fully verified.',
    );
    expect(textOfClass(root, 'warn-msg')).toEqual(
      scoped.plan.warnings.map((warning) => warning.message),
    );
  });
});
