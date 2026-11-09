import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYWORDS } from '../core/parser.js';
import type {
  ObservationMetadata,
  OutsideIssueObservation,
  RepositoryObservation,
} from '../core/scope.js';
import type { Issue } from '../core/types.js';
import { ObservationStore } from './observationStore.js';
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
function repository(
  repo: string,
  issues: Issue[] | null,
): DerivationObservation<RepositoryObservation> {
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
  it.each(['closed', 'open', 'failed', 'missing'] as const)(
    'retains dropped listing details provisionally until the lookup returns %s',
    (outcome) => {
      const o = input();
      const store = new ObservationStore({ now: () => o.now });
      const project = { source: 's', repo: 'a/r' };
      const prerequisite = {
        ...issue(2),
        title: 'Last known prerequisite',
        url: 'https://github.com/a/r/issues/2',
        labels: ['P0', 'agent:claimed'],
      };
      const list = (issues: Issue[]) =>
        store.writeRepository(store.beginRepositoryRead(project), {
          issues,
          warnings: [],
          relationCoverage: { native: 'complete', subIssues: 'complete' },
        });
      const derive = () => {
        o.repositories = [store.readRepository(project)!];
        o.outsideIssues = store.listOutsideIssues('s');
        return deriveScopePlan(o);
      };
      list([issue(1, 'Blocked by #2'), prerequisite]);
      expect(derive().snapshot!.plan.nodes.find((n) => n.key === 'a/r#2')!.title).toBe(
        prerequisite.title,
      );
      o.now = new Date('2026-11-06T12:00:01.000Z');
      list([issue(1, 'Blocked by #2')]);
      const dropped = derive();
      expect(dropped.snapshot!.plan.nodes.find((n) => n.key === 'a/r#2')).toMatchObject({
        title: prerequisite.title,
        url: prerequisite.url,
        labels: prerequisite.labels,
      });
      expect(dropped.snapshot!.plan.nodes.find((n) => n.key === 'a/r#1')!.status).toBe('blocked');
      expect(warnings(o, 'fetch-error')).toEqual([]);
      expect(warnings(o, 'dependency-provisional')[0]!.issues).toEqual(['a/r#1', 'a/r#2']);
      expect(dropped.referencedOutsideIssues).toEqual(['a/r#2']);
      expect(store.readOutsideIssue({ source: 's', key: 'a/r#2' })!.observation.result).toEqual({
        status: 'found',
        issue: prerequisite,
      });

      const token = store.beginOutsideIssueRead({ source: 's', key: 'a/r#2' });
      if (outcome === 'failed') store.fail(token, 'upstream unavailable');
      else
        store.writeOutsideIssue(token, {
          result:
            outcome === 'missing'
              ? { status: 'missing' }
              : { status: 'found', issue: { ...prerequisite, state: outcome, title: 'Updated' } },
          relationCoverage: { native: 'complete', subIssues: 'complete' },
        });
      const refreshed = derive();
      expect(
        store.readOutsideIssue({ source: 's', key: 'a/r#2' })!.observation.retainedFromListing,
      ).toBe(outcome === 'failed' || outcome === 'missing' ? true : undefined);
      const node = refreshed.snapshot!.plan.nodes.find((n) => n.key === 'a/r#2');
      expect(warnings(o, 'fetch-error')).toEqual([]);
      if (outcome === 'closed') {
        expect(node).toBeUndefined();
        expect(refreshed.snapshot!.plan.edges).toEqual([]);
        expect(refreshed.snapshot!.plan.nodes[0]!.status).toBe('ready');
        expect(warnings(o, 'dependency-provisional')).toEqual([]);
      } else {
        expect(node!.title).toBe(outcome === 'open' ? 'Updated' : prerequisite.title);
        expect(refreshed.snapshot!.plan.nodes.find((n) => n.key === 'a/r#1')!.status).toBe(
          'blocked',
        );
        expect(warnings(o, 'dependency-provisional')).toHaveLength(outcome === 'open' ? 0 : 1);
      }
    },
  );

  it('still uses an unavailable placeholder and fetch warning for a never-observed issue', () => {
    const o = input();
    o.repositories = [repository('a/r', [issue(1, 'Blocked by #2')])];
    expect(nodes(o).find((n) => n.key === 'a/r#2')!.title).toBe('(unavailable)');
    expect(warnings(o, 'fetch-error')).toHaveLength(1);
  });

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
    expect(warnings(o, 'repository-unlisted')).toEqual([]);
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
    expect(warnings(o, 'repository-unlisted')).toEqual([]);
  });
  it.each(['absent', 'not-attempted', 'failed', 'other-source'] as const)(
    'derives a partial All projects plan when a repository is %s, naming the missing listing',
    (state) => {
      const o = input();
      o.scope = { kind: 'source', source: 's' };
      o.repositories = [repository('a/r', [issue(1)])];
      o.repositories[0]!.observation.lastCheckedAt = '2026-11-06T11:59:00.000Z';
      if (state !== 'absent') {
        const missing = repository('a/other', state === 'other-source' ? [issue(2)] : null);
        missing.observation.lastCheckedAt = null;
        missing.observation.lastAttempt =
          state === 'failed'
            ? { attemptedAt: checked, outcome: 'failed', error: 'Access denied' }
            : null;
        if (state === 'other-source') missing.observation.project.source = 'foreign';
        o.repositories = [...o.repositories, missing];
      }
      const result = deriveScopePlan(o);
      expect(result.snapshot).toMatchObject({
        viewId: 'source:s',
        title: 's / All projects',
        fetchedAt: '2026-11-06T11:59:00.000Z',
        plan: {
          warnings: [
            {
              code: 'repository-unlisted',
              message:
                'All projects plan is partial: s/a/other has no successful repository listing',
              issues: [],
            },
          ],
        },
      });
      expect(result.snapshot!.plan.nodes.map((n) => n.key)).toEqual(['a/r#1']);
      expect(result.pendingOutsideIssues).toEqual([]);
      expect(result.computedAt).toBe(checked);
    },
  );
  it('treats a verified empty listing as data in a partial All projects plan', () => {
    const o = input();
    o.scope = { kind: 'source', source: 's' };
    o.repositories = [repository('a/r', [])];
    o.repositories[0]!.observation.lastCheckedAt = '2026-11-06T11:59:00.000Z';
    const result = deriveScopePlan(o);
    expect(result.snapshot!.plan.nodes).toEqual([]);
    expect(result.snapshot!.fetchedAt).toBe('2026-11-06T11:59:00.000Z');
    expect(warnings(o, 'repository-unlisted')).toHaveLength(1);
    o.repositories = [...o.repositories, repository('a/other', [issue(2, '', 'a/other')])];
    o.catalog.projects.push({ source: 's', repo: 'a/third' });
    expect(nodes(o).map((n) => n.key)).toEqual(['a/other#2']);
    expect(deriveScopePlan(o).snapshot!.fetchedAt).toBe('2026-11-06T11:59:00.000Z');
  });
  it('retains last-good listings and their stale warnings in a partial All projects plan', () => {
    const o = input();
    o.scope = { kind: 'source', source: 's' };
    o.repositories = [repository('a/r', [issue(1)])];
    o.repositories[0]!.observation.lastAttempt = {
      attemptedAt: checked,
      outcome: 'failed',
      error: 'Access denied',
    };
    o.now = new Date('2026-11-06T12:16:00.001Z');
    expect(nodes(o).map((n) => n.key)).toEqual(['a/r#1']);
    expect(warnings(o, 'stale-data')[0]!.message).toBe('Stale observation: s/a/r');
    expect(warnings(o, 'repository-unlisted')[0]!.message).toContain('s/a/other');
    expect(deriveScopePlan(o).snapshot!.fetchedAt).toBe(checked);
  });
  it.each(['absent', 'unlisted', 'empty-catalog'] as const)(
    'keeps All projects unavailable with no scoped listing (%s)',
    (state) => {
      const o = input();
      o.scope = { kind: 'source', source: 's' };
      if (state === 'absent') o.repositories = [];
      if (state === 'unlisted')
        o.repositories = [repository('a/r', null), repository('a/other', null)];
      if (state === 'empty-catalog') o.catalog.projects = [];
      const extra = repository('a/unconfigured', [issue(9, '', 'a/unconfigured')]);
      const foreign = repository('a/r', [issue(1)]);
      foreign.observation.project.source = 'foreign';
      o.repositories = [...o.repositories, extra, foreign];
      o.outsideIssues = [outside('a/r#1', { status: 'found', issue: issue(1) })];
      expect(deriveScopePlan(o)).toEqual({
        snapshot: null,
        computedAt: checked,
        pendingOutsideIssues: [],
        contributingRepositories: state === 'empty-catalog' ? [] : ['a/other', 'a/r'],
        referencedOutsideIssues: [],
        contextIssues: [],
      });
    },
  );
  it('keeps dependencies on unlisted repositories blocked and reports outstanding lookups', () => {
    const o = input();
    o.scope = { kind: 'source', source: 's' };
    o.repositories = [repository('a/r', [issue(1, 'Blocked by a/other#2')])];
    const result = deriveScopePlan(o);
    expect(result.snapshot!.plan.nodes.map((n) => [n.key, n.status, n.external])).toEqual([
      ['a/other#2', 'ready', true],
      ['a/r#1', 'blocked', false],
    ]);
    expect(result.pendingOutsideIssues).toEqual(['a/other#2']);
    expect(warnings(o, 'repository-unlisted')).toHaveLength(1);
    expect(warnings(o, 'dependency-provisional')[0]!.issues).toEqual(['a/other#2', 'a/r#1']);
    o.outsideIssues = [outside('a/other#2', { status: 'found', issue: issue(2, '', 'a/other') })];
    expect(deriveScopePlan(o).pendingOutsideIssues).toEqual([]);
    expect(warnings(o, 'dependency-provisional')).toEqual([]);
    expect(warnings(o, 'repository-unlisted')).toHaveLength(1);
  });
  it('removes the partial warning once the unlisted repository has a successful listing', () => {
    const o = input();
    o.scope = { kind: 'source', source: 's' };
    o.repositories = [repository('a/r', [issue(1)])];
    const partial = deriveScopePlan(o);
    o.repositories = [...o.repositories, repository('a/other', [])];
    const complete = deriveScopePlan(o);
    expect(warnings(o, 'repository-unlisted')).toEqual([]);
    expect(complete.snapshot!.contentHash).not.toBe(partial.snapshot!.contentHash);
    expect(complete.snapshot!.plan.nodes).toEqual(partial.snapshot!.plan.nodes);
    o.repositories[1]!.observation.issues = [issue(2, '', 'a/other')];
    expect(nodes(o).map((n) => [n.key, n.external])).toEqual([
      ['a/other#2', false],
      ['a/r#1', false],
    ]);
  });
  it('names every unlisted catalog repository deterministically without mutating observations', () => {
    const o = input();
    o.scope = { kind: 'source', source: 's' };
    o.catalog.projects.push({ source: 's', repo: 'A/Third' });
    o.repositories = [repository('a/r', [issue(1)]), repository('a/not-in-catalog', [])];
    const before = structuredClone(o);
    const result = deriveScopePlan(o);
    expect(warnings(o, 'repository-unlisted').map((w) => w.message)).toEqual([
      'All projects plan is partial: s/a/other has no successful repository listing',
      'All projects plan is partial: s/a/third has no successful repository listing',
    ]);
    expect(o).toEqual(before);
    expect(
      deriveScopePlan({
        ...o,
        catalog: { ...o.catalog, projects: [...o.catalog.projects].reverse() },
        repositories: [...o.repositories].reverse(),
      }),
    ).toEqual(result);
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
  it('uses newer targeted sibling observations and returns to a later catalog listing', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by a/other#2')];
    const targeted = outside('a/other#2', {
      status: 'found',
      issue: { ...issue(2, '', 'a/other'), state: 'closed' },
    });
    targeted.observation.lastCheckedAt = '2026-11-06T12:00:01.000Z';
    targeted.observation.lastAttempt!.attemptedAt = targeted.observation.lastCheckedAt;
    o.outsideIssues = [targeted];
    const result = deriveScopePlan(o);
    expect(result.snapshot!.plan.nodes.map((n) => [n.key, n.status])).toEqual([['a/r#1', 'ready']]);
    expect(result.contributingRepositories).toEqual(['a/r']);
    expect(result.referencedOutsideIssues).toEqual(['a/other#2']);
    expect(result.contextIssues).toEqual(['a/other#2']);

    // A later listing can observe reopening and supersede the targeted closure.
    o.repositories[1]!.observation.lastCheckedAt = '2026-11-06T12:00:02.000Z';
    const reopened = deriveScopePlan(o);
    expect(reopened.snapshot!.plan.nodes.find((n) => n.key === 'a/r#1')!.status).toBe('blocked');
    expect(reopened.contributingRepositories).toEqual(['a/other', 'a/r']);
    expect(reopened.referencedOutsideIssues).toEqual([]);
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
  describe.each(['repository', 'outside-open', 'outside-closed'] as const)(
    'stale-data threshold for %s',
    (kind) => {
      function observed() {
        const o = input();
        o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
        const target = outside('a/r#2', {
          status: 'found',
          issue: { ...issue(2), state: kind === 'outside-closed' ? 'closed' : 'open' },
        });
        o.outsideIssues = [target];
        return { o, record: kind === 'repository' ? o.repositories[0]! : target };
      }

      it.each(['expired', 'invalidated', 'relations', 'partial', 'recent-failure'] as const)(
        'does not warn for %s',
        (reason) => {
          const { o, record } = observed();
          const before = deriveScopePlan(o).snapshot!;
          o.now = new Date('2026-11-06T12:01:00.001Z');
          if (reason === 'invalidated') record.invalidated = true;
          if (reason === 'relations')
            record.observation.relationsCheckedAt.native = '2026-11-06T11:00:00.000Z';
          if (reason === 'partial') record.observation.lastAttempt!.outcome = 'partial';
          if (reason === 'recent-failure') record.observation.lastAttempt!.outcome = 'failed';
          const after = deriveScopePlan(o).snapshot!;
          expect(warnings(o, 'stale-data')).toEqual([]);
          expect(after.fetchedAt).toBe(before.fetchedAt);
          // A failed outside lookup still marks its dependencies provisional.
          if (reason !== 'recent-failure' || kind === 'repository')
            expect(after.contentHash).toBe(before.contentHash);
          const afterTTL = after.contentHash;
          o.now = new Date('2026-11-06T12:16:00.000Z');
          expect(deriveScopePlan(o).snapshot!.contentHash).toBe(afterTTL);
        },
      );

      it('warns only strictly beyond TTL plus grace after a failed attempt', () => {
        const { o, record } = observed();
        record.observation.lastAttempt!.outcome = 'failed';
        o.now = new Date('2026-11-06T12:16:00.000Z');
        const withinGrace = deriveScopePlan(o).snapshot!;
        expect(warnings(o, 'stale-data')).toEqual([]);
        o.now = new Date('2026-11-06T12:16:00.001Z');
        expect(warnings(o, 'stale-data')).toEqual([
          {
            code: 'stale-data',
            message: `Stale observation: ${kind === 'repository' ? 's/a/r' : 'a/r#2'}`,
            issues: kind === 'repository' ? ['a/r#1'] : kind === 'outside-open' ? ['a/r#2'] : [],
          },
        ]);
        expect(deriveScopePlan(o).snapshot!.contentHash).not.toBe(withinGrace.contentHash);
        o.cache.ttlSeconds = 0;
        expect(warnings(o, 'stale-data')).toEqual([]);
      });
    },
  );

  it.each([0, 60])('warns on a never-succeeded outside failure with TTL %s', (ttlSeconds) => {
    const o = input();
    o.cache.ttlSeconds = ttlSeconds;
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
    const target = outside('a/r#2', null);
    target.observation.lastCheckedAt = null;
    target.observation.lastAttempt = null;
    o.outsideIssues = [target];
    expect(warnings(o, 'stale-data')).toEqual([]);
    target.observation.lastAttempt = { attemptedAt: checked, outcome: 'failed', error: 'offline' };
    expect(warnings(o, 'stale-data')[0]!.message).toBe('Stale observation: a/r#2');
    expect(warnings(o, 'dependency-provisional')[0]!.issues).toEqual(['a/r#1', 'a/r#2']);
  });

  it('excludes unrelated failed listings and lookups from stale warnings', () => {
    const o = input();
    const unrelated = outside('a/r#99', { status: 'found', issue: issue(99) });
    unrelated.observation.lastAttempt!.outcome = 'failed';
    o.outsideIssues = [unrelated];
    o.repositories[1]!.observation.lastAttempt!.outcome = 'failed';
    o.now = new Date('2026-11-06T13:00:00.000Z');
    expect(warnings(o, 'stale-data')).toEqual([]);
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
  it('dates project plans by every contributing catalog listing, but not unused listings', () => {
    const o = input();
    o.repositories[1]!.observation.lastCheckedAt = '2026-11-06T03:00:00.000Z';
    o.cache.ttlSeconds = 86400;
    expect(deriveScopePlan(o).snapshot!.fetchedAt).toBe(checked);
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by a/other#2')];
    expect(deriveScopePlan(o).snapshot!.fetchedAt).toBe('2026-11-06T03:00:00.000Z');
    expect(warnings(o, 'stale-data')).toEqual([]);
  });
  it('rekeys outside issues before coverage inspection without mutating the stored result', () => {
    const o = input();
    o.repositories[0]!.observation.issues = [issue(1, 'Blocked by #2')];
    const returned = {
      ...issue(5),
      relationCoverage: { native: 'failed', subIssues: 'complete' },
    } as Issue;
    o.outsideIssues = [outside('a/r#2', { status: 'found', issue: returned })];
    const before = structuredClone(o);
    expect(nodes(o).map((n) => n.key)).toEqual(['a/r#1', 'a/r#2']);
    expect(warnings(o, 'dependency-provisional')[0]!.issues).toEqual(['a/r#1', 'a/r#2']);
    expect(o).toEqual(before);
  });
  it('does not invent a project snapshot without its listing or accept foreign/conflicted scopes', () => {
    const o = input();
    o.repositories[0]!.observation.issues = null;
    expect(deriveScopePlan(o).snapshot).toBeNull();
    o.scope = { kind: 'project', source: 's', repo: 'a/absent' };
    expect(() => deriveScopePlan(o)).toThrow('catalog');
    o.scope = { kind: 'source', source: 'foreign' };
    expect(() => deriveScopePlan(o)).toThrow('source');
  });

  it('attaches open closing pull requests in project and source scopes, including cross-repository pull requests', () => {
    const o = input();
    o.repositories[0]!.observation.pullRequests = [
      {
        key: 'a/r#10',
        repo: { owner: 'a', repo: 'r' },
        number: 10,
        title: 'Implement work',
        url: 'https://github.com/a/r/pull/10',
        body: 'Closes #1',
      },
    ];
    o.repositories[1]!.observation.pullRequests = [
      {
        key: 'a/other#11',
        repo: { owner: 'a', repo: 'other' },
        number: 11,
        title: 'Cross-repo fix for issue 1',
        url: 'https://github.com/a/other/pull/11',
        body: 'Fixes a/r#1',
      },
    ];
    const projectNode = nodes(o).find((n) => n.key === 'a/r#1')!;
    expect(projectNode.closingPullRequests).toEqual([
      {
        key: 'a/r#10',
        number: 10,
        title: 'Implement work',
        url: 'https://github.com/a/r/pull/10',
      },
    ]);
    o.scope = { kind: 'source', source: 's' };
    const sourceNode = nodes(o).find((n) => n.key === 'a/r#1')!;
    expect(sourceNode.closingPullRequests).toEqual([
      {
        key: 'a/other#11',
        number: 11,
        title: 'Cross-repo fix for issue 1',
        url: 'https://github.com/a/other/pull/11',
      },
      {
        key: 'a/r#10',
        number: 10,
        title: 'Implement work',
        url: 'https://github.com/a/r/pull/10',
      },
    ]);
  });
});
