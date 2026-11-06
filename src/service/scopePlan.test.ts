import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYWORDS } from '../core/parser.js';
import type {
  ObservationMetadata,
  OutsideIssueObservation,
  RepositoryObservation,
} from '../core/scope.js';
import type { Issue } from '../core/types.js';
import { deriveScopePlan, type DerivationObservation, type ScopePlanInput } from './scopePlan.js';

const checked = '2026-11-06T12:00:00.000Z';
function issue(number: number, body = '', repo = 'a/r'): Issue {
  const [owner, name] = repo.split('/');
  return {
    key: `${repo}#${number}`,
    repo: { owner: owner!, repo: name! },
    number,
    title: `Issue ${number}`,
    state: 'open',
    url: '',
    body,
    labels: [],
    assignees: [],
    milestone: null,
    updatedAt: null,
    nativeRelations: [],
  };
}
function metadata(): ObservationMetadata {
  return {
    relationCoverage: { native: 'complete', subIssues: 'complete' },
    relationsCheckedAt: { native: checked, subIssues: checked },
    lastCheckedAt: checked,
    lastAttempt: { attemptedAt: checked, outcome: 'success', error: null },
    invalidationGeneration: 0,
  };
}
function repository(repo: string, issues: Issue[]): DerivationObservation<RepositoryObservation> {
  return {
    invalidated: false,
    observation: { ...metadata(), project: { source: 's', repo }, issues, warnings: [] },
  };
}
function outside(
  key: string,
  result: OutsideIssueObservation['result'],
): DerivationObservation<OutsideIssueObservation> {
  return { invalidated: false, observation: { ...metadata(), source: 's', key, result } };
}
function input(): ScopePlanInput {
  return {
    scope: { kind: 'project', source: 's', repo: 'a/r' },
    catalog: {
      id: 's',
      kind: 'github',
      policy: { status: 'usable' },
      projects: [
        { source: 's', repo: 'a/r' },
        { source: 's', repo: 'a/other' },
      ],
    },
    policy: {
      dependencies: { native: true, subIssues: true, body: true, keywords: DEFAULT_KEYWORDS },
      ordering: { mode: 'priority', priorityLabels: ['P0'] },
    },
    repositories: [repository('a/r', [issue(1)]), repository('a/other', [issue(2, '', 'a/other')])],
    outsideIssues: [],
    webUrl: 'https://github.com',
    cache: { ttlSeconds: 60 },
    now: new Date(checked),
  };
}
const nodes = (o: ScopePlanInput) => deriveScopePlan(o).snapshot!.plan.nodes;
const warnings = (o: ScopePlanInput, code: string) =>
  deriveScopePlan(o).snapshot!.plan.warnings.filter((w) => w.code === code);

describe('scope plan derivation', () => {
  it('includes all project issues ignoring view filters and retains existing ordering/layout', () => {
    const o = input();
    o.repositories = [
      repository('a/r', [issue(1), { ...issue(3), labels: ['excluded'], milestone: 'old' }]),
    ];
    Object.assign(o.policy, {
      scope: { labels: ['missing'], excludeLabels: ['excluded'], milestones: ['other'] },
    });
    const result = deriveScopePlan(o);
    expect(result.snapshot!.viewId).toBe('project:s/a/r');
    expect(result.snapshot!.title).toContain('a/r');
    expect(nodes(o).map((n) => n.key)).toEqual(['a/r#1', 'a/r#3']);
    expect(result.snapshot!.priorityLabels).toEqual(['P0']);
    expect(result.snapshot!.orderingMode).toBe('priority');
    expect(result.snapshot!.layout).toBeDefined();
    expect(result.computedAt).toBe(checked);
  });
  it('All projects includes empty repositories and dates by oldest scoped check', () => {
    const o = input();
    o.scope = { kind: 'source', source: 's' };
    o.repositories[1]!.observation.lastCheckedAt = '2026-11-06T11:59:00.000Z';
    expect(nodes(o).map((n) => n.key)).toEqual(['a/other#2', 'a/r#1']);
    expect(deriveScopePlan(o).snapshot!.fetchedAt).toBe('2026-11-06T11:59:00.000Z');
    o.repositories[1]!.observation.issues = [];
    expect(nodes(o)).toHaveLength(1);
    expect(deriveScopePlan(o).snapshot!.fetchedAt).toBe('2026-11-06T11:59:00.000Z');
  });
  it('uses another catalog listing as external context without lookup; ignores other sources and noncatalog repos', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by a/other#2')];
    const extra = repository('a/unlisted', [issue(9, '', 'a/unlisted')]);
    o.repositories = [...o.repositories, extra];
    const result = deriveScopePlan(o);
    expect(result.pendingOutsideIssues).toEqual([]);
    expect(nodes(o).find((n) => n.key === 'a/other#2')!.external).toBe(true);
    expect(nodes(o).find((n) => n.key === 'a/r#1')!.status).toBe('blocked');
    o.repositories[1]!.observation.project.source = 'other';
    expect(deriveScopePlan(o).pendingOutsideIssues).toEqual(['a/other#2']);
  });
  it.each(['missing', 'unresolved', 'null'] as const)(
    'retains %s blockers and warns affected issues',
    (status) => {
      const o = input();
      o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
      o.outsideIssues = [
        outside(
          'a/r#2',
          status === 'null'
            ? null
            : status === 'missing'
              ? { status }
              : { status, error: 'unsupported' },
        ),
      ];
      expect(nodes(o).find((n) => n.key === 'a/r#1')!.status).toBe('blocked');
      expect(warnings(o, 'dependency-provisional')[0]!.issues).toEqual(['a/r#1', 'a/r#2']);
      expect(deriveScopePlan(o).pendingOutsideIssues).toEqual(['a/r#2']);
    },
  );
  it('observed closure or removal clears a blocker; absence in a listing does not', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
    expect(nodes(o).find((n) => n.key === 'a/r#1')!.status).toBe('blocked');
    o.outsideIssues = [
      outside('a/r#2', { status: 'found', issue: { ...issue(2), state: 'closed' } }),
    ];
    expect(nodes(o).map((n) => [n.key, n.status])).toEqual([['a/r#1', 'ready']]);
    o.outsideIssues = [];
    o.repositories[0]!.observation.issues = [issue(1)];
    expect(nodes(o).map((n) => [n.key, n.status])).toEqual([['a/r#1', 'ready']]);
  });
  it('bounds outstanding lookups at 200 while preserving every capped edge', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [
      issue(1, `Blocked by ${Array.from({ length: 205 }, (_, n) => `#${n + 2}`).join(', ')}`),
    ];
    const result = deriveScopePlan(o);
    expect(result.pendingOutsideIssues).toHaveLength(200);
    expect(result.snapshot!.plan.edges).toHaveLength(205);
    expect(warnings(o, 'dependency-provisional')[0]!.issues).toHaveLength(206);
  });
  it.each(['open', 'closed'] as const)(
    'does not charge stored %s outside issues against the lookup budget',
    (state) => {
      const o = input();
      o.repositories[0]!.observation.issues = [
        issue(1, `Blocked by ${Array.from({ length: 201 }, (_, n) => `#${n + 2}`).join(', ')}`),
      ];
      o.outsideIssues = Array.from({ length: 200 }, (_, n) =>
        outside(`a/r#${n + 2}`, { status: 'found', issue: { ...issue(n + 2), state } }),
      );
      const result = deriveScopePlan(o);
      expect(result.pendingOutsideIssues).toEqual(['a/r#202']);
      expect(result.snapshot!.plan.edges).toHaveLength(state === 'open' ? 201 : 1);
      expect(deriveScopePlan({ ...o, outsideIssues: [...o.outsideIssues].reverse() })).toEqual(
        result,
      );
    },
  );
  it('traverses stored outside issues transitively and reports remaining lookups', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
    o.outsideIssues = [outside('a/r#2', { status: 'found', issue: issue(2, 'Blocked by #3') })];
    expect(deriveScopePlan(o).pendingOutsideIssues).toEqual(['a/r#3']);
    expect(nodes(o)).toHaveLength(3);
  });
  it.each(['unsupported', 'failed', 'not-requested'] as const)(
    'warns incomplete %s enabled coverage only',
    (status) => {
      const o = input();
      o.repositories[0]!.observation.relationCoverage.native = status;
      expect(warnings(o, 'dependency-provisional')[0]!.issues).toEqual(['a/r#1']);
      o.policy.dependencies.native = false;
      expect(warnings(o, 'dependency-provisional')).toEqual([]);
    },
  );
  it('warns per-issue and external coverage, propagating to dependents', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
    o.outsideIssues = [
      outside('a/r#2', {
        status: 'found',
        issue: { ...issue(2), relationCoverage: { native: 'failed', subIssues: 'complete' } },
      }),
    ];
    expect(warnings(o, 'dependency-provisional')[0]!.issues).toEqual(['a/r#1', 'a/r#2']);
  });
  it.each(['invalidated', 'failed', 'expired', 'relations'] as const)(
    'warns stale %s contributing observations',
    (reason) => {
      const o = input();
      const record = o.repositories[0]!;
      if (reason === 'invalidated') record.invalidated = true;
      if (reason === 'failed') record.observation.lastAttempt!.outcome = 'failed';
      if (reason === 'expired') record.observation.lastCheckedAt = '2026-11-06T11:00:00.000Z';
      if (reason === 'relations')
        record.observation.relationsCheckedAt.native = '2026-11-06T11:00:00.000Z';
      expect(warnings(o, 'stale-data')[0]!.message).toContain('s/a/r');
      if (reason === 'expired' || reason === 'relations') {
        o.cache.ttlSeconds = 0;
        expect(warnings(o, 'stale-data')).toEqual([]);
      }
    },
  );
  it('warns stale outside observations but excludes unrelated stale listings/lookups', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
    const observed = outside('a/r#2', { status: 'found', issue: issue(2) });
    observed.invalidated = true;
    o.outsideIssues = [
      observed,
      { ...outside('a/r#99', { status: 'found', issue: issue(99) }), invalidated: true },
    ];
    o.repositories[1]!.invalidated = true;
    expect(warnings(o, 'stale-data').map((w) => w.message)).toEqual(['Stale observation: a/r#2']);
  });
  it('reports stale observed closures that satisfy a blocker without adding a closed node', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
    const closed = outside('a/r#2', { status: 'found', issue: { ...issue(2), state: 'closed' } });
    closed.invalidated = true;
    o.outsideIssues = [closed];
    expect(nodes(o)).toHaveLength(1);
    expect(nodes(o)[0]!.status).toBe('ready');
    expect(warnings(o, 'stale-data')[0]!.message).toContain('a/r#2');
  });
  it('is deterministic without mutating inputs, and never uses generation alone as invalidation', () => {
    const o = input();
    o.repositories[0]!.observation.invalidationGeneration = 5;
    const before = structuredClone(o);
    const a = deriveScopePlan(o);
    const b = deriveScopePlan(o);
    expect(a).toEqual(b);
    expect(o).toEqual(before);
    expect(warnings(o, 'stale-data')).toEqual([]);
    expect(
      deriveScopePlan({ ...o, repositories: [...o.repositories].reverse() }).snapshot!.contentHash,
    ).toBe(a.snapshot!.contentHash);
  });
  it('does not invent partial snapshots or accept foreign/conflicted scopes', () => {
    const o = input();
    o.repositories[0]!.observation.issues = null;
    expect(deriveScopePlan(o).snapshot).toBeNull();
    o.scope = { kind: 'project', source: 's', repo: 'a/absent' };
    expect(() => deriveScopePlan(o)).toThrow('catalog');
    o.scope = { kind: 'source', source: 'foreign' };
    expect(() => deriveScopePlan(o)).toThrow('source');
  });
});
