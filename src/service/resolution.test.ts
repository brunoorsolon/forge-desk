import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYWORDS } from '../core/parser.js';
import { buildPlan } from '../core/plan.js';
import type { Issue, OpenPullRequest } from '../core/types.js';
import {
  pendingOutsideIssueKeys,
  resolvePlanInput,
  type OutsideIssueLookup,
  type ResolutionSettings,
} from './resolution.js';

const settings: ResolutionSettings = {
  id: 'project:s/a/r',
  dependencies: { native: true, subIssues: true, body: true, keywords: DEFAULT_KEYWORDS },
  scope: { labels: [], excludeLabels: [], milestones: [] },
  ordering: { mode: 'priority', priorityLabels: ['P0'] },
  webHosts: ['web.test'],
  webUrl: 'https://web.test',
};

function issue(number: number, body = '', extra: Partial<Issue> = {}): Issue {
  return {
    key: `a/r#${number}`,
    repo: { owner: 'a', repo: 'r' },
    number,
    title: `Issue ${number}`,
    state: 'open',
    url: `https://web.test/a/r/issues/${number}`,
    body,
    labels: [],
    assignees: [],
    milestone: null,
    updatedAt: null,
    nativeRelations: [],
    ...extra,
  };
}

function found(value: Issue): OutsideIssueLookup {
  return { status: 'found', issue: value };
}

describe('pure resolution', () => {
  it('finds sorted unique outside references, excluding known keys, outcomes and parents', () => {
    const root = issue(1, 'Blocked by #10, #2, #10, #3, #4, #5', {
      nativeRelations: [
        { kind: 'parent', ref: { owner: null, repo: null, number: 20 }, source: 'sub-issue' },
      ],
    });
    const lookups = new Map<string, OutsideIssueLookup>([
      ['a/r#3', { status: 'missing' }],
      ['a/r#4', { status: 'unresolved', error: 'failed' }],
      ['a/r#5', found(issue(5, '', { state: 'closed' }))],
    ]);
    expect(pendingOutsideIssueKeys([root, issue(2)], lookups, settings)).toEqual(['a/r#10']);
    expect(
      pendingOutsideIssueKeys([root], new Map(), {
        ...settings,
        dependencies: { ...settings.dependencies, body: false, subIssues: false },
      }),
    ).toEqual([]);
  });

  it('lets a caller drive successive breadth-first levels from in-memory observations', () => {
    const root = issue(1, 'Blocked by #2');
    const second = issue(2, 'Blocked by #3');
    const third = issue(3, 'Blocked by #1');
    const lookups = new Map<string, OutsideIssueLookup>();
    expect(pendingOutsideIssueKeys([root], lookups, settings)).toEqual(['a/r#2']);
    lookups.set(second.key, found(second));
    expect(pendingOutsideIssueKeys([root, second], lookups, settings)).toEqual(['a/r#3']);
    lookups.set(third.key, found(third));
    expect(pendingOutsideIssueKeys([root, second, third], lookups, settings)).toEqual([]);
    const input = resolvePlanInput([root], lookups, settings);
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/r#2', 'a/r#3']);
    expect(input.externalKeys).toEqual(['a/r#2', 'a/r#3']);
    expect(input.edges).toEqual([
      { from: 'a/r#1', to: 'a/r#3', sources: ['body'] },
      { from: 'a/r#2', to: 'a/r#1', sources: ['body'] },
      { from: 'a/r#3', to: 'a/r#2', sources: ['body'] },
    ]);
  });

  it('retains missing, closed, failed and budget-cutoff semantics and warning order', () => {
    const root = issue(1, 'Blocked by #2, #3, #4, #5');
    const lookups = new Map<string, OutsideIssueLookup>([
      ['a/r#2', { status: 'missing' }],
      ['a/r#3', found(issue(3, 'Blocked by #99', { state: 'closed' }))],
      ['a/r#4', { status: 'unresolved', error: 'offline' }],
      ['a/r#5', { status: 'unresolved', error: null }],
    ]);
    const input = resolvePlanInput([root], lookups, settings);
    expect(input.issues.map((i) => [i.key, i.title, i.url])).toEqual([
      ['a/r#1', 'Issue 1', 'https://web.test/a/r/issues/1'],
      ['a/r#4', '(unavailable)', 'https://web.test/a/r/issues/4'],
    ]);
    expect(input.warnings).toEqual([
      { code: 'fetch-error', message: 'Could not fetch a/r#4: offline', issues: ['a/r#4'] },
      {
        code: 'external-unresolved',
        message:
          'Stopped after 200 lookups of issues outside the view; 1 referenced issue(s) were not resolved: a/r#5',
        issues: ['a/r#5'],
      },
      {
        code: 'dangling-reference',
        message: 'a/r#1 references a/r#2, which does not exist or is not accessible',
        issues: ['a/r#1'],
      },
    ]);
    expect(input.edges).toEqual([{ from: 'a/r#4', to: 'a/r#1', sources: ['body'] }]);
  });

  it('preserves settings, hierarchy, merged edge sources and scope prerequisites', () => {
    const root = issue(1, 'Blocked by https://web.test/a/r/issues/2', {
      labels: ['Selected'],
      nativeRelations: [
        { kind: 'blocked-by', ref: { owner: null, repo: null, number: 2 }, source: 'native' },
        { kind: 'parent', ref: { owner: null, repo: null, number: 9 }, source: 'sub-issue' },
      ],
    });
    const ignored = issue(3, 'Blocked by #4');
    const input = resolvePlanInput(
      [ignored, issue(2), root],
      new Map([['a/r#4', { status: 'missing' } as const]]),
      { ...settings, scope: { ...settings.scope, labels: ['selected'] } },
    );
    expect(input.viewId).toBe(settings.id);
    expect(input.priorityLabels).toEqual(['P0']);
    expect(input.orderingMode).toBe('priority');
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/r#2']);
    expect(input.externalKeys).toEqual(['a/r#2']);
    expect(input.edges).toEqual([{ from: 'a/r#2', to: 'a/r#1', sources: ['body', 'native'] }]);
    expect(input.parentLinks).toEqual([{ parent: 'a/r#9', child: 'a/r#1' }]);
    expect(input.warnings).toEqual([]);
  });

  it('is deterministic, does not mutate inputs, and trusts the qualified lookup key', () => {
    const root = issue(1, 'Blocked by #2');
    const other = issue(5);
    const mismatched = issue(99);
    const lookups = new Map([['a/r#2', found(mismatched)]]);
    const before = structuredClone({ root, other, lookups, settings });
    const input = resolvePlanInput([root, other], lookups, settings);
    expect(resolvePlanInput([other, root], lookups, settings)).toEqual(input);
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/r#2', 'a/r#5']);
    expect({ root, other, lookups, settings }).toEqual(before);
    expect(mismatched.key).toBe('a/r#99');
  });

  it('resolves same-repo, cross-repo, and web-host closing pull requests onto included issues only', () => {
    const first = issue(1);
    const second = issue(2, '', { key: 'a/web#2', repo: { owner: 'a', repo: 'web' } });
    const input = resolvePlanInput(
      [first, second],
      new Map(),
      settings,
      [],
      [
        {
          key: 'a/r#10',
          repo: { owner: 'a', repo: 'r' },
          number: 10,
          title: 'Fix issue 1 and web 2',
          url: 'https://web.test/a/r/pull/10',
          body: 'Closes #1\nFixes a/web#2\nResolves #99',
        },
        {
          key: 'a/web#11',
          repo: { owner: 'a', repo: 'web' },
          number: 11,
          title: 'URL close for issue 1',
          url: 'https://web.test/a/web/pull/11',
          body: 'Closes https://web.test/a/r/issues/1',
        },
      ],
    );
    expect(input.closingPullRequests).toEqual([
      {
        issue: 'a/r#1',
        pullRequest: {
          key: 'a/r#10',
          number: 10,
          title: 'Fix issue 1 and web 2',
          url: 'https://web.test/a/r/pull/10',
        },
      },
      {
        issue: 'a/web#2',
        pullRequest: {
          key: 'a/r#10',
          number: 10,
          title: 'Fix issue 1 and web 2',
          url: 'https://web.test/a/r/pull/10',
        },
      },
      {
        issue: 'a/r#1',
        pullRequest: {
          key: 'a/web#11',
          number: 11,
          title: 'URL close for issue 1',
          url: 'https://web.test/a/web/pull/11',
        },
      },
    ]);
  });

  it('resolves conflicting duplicate pull request records deterministically regardless of arrival order', () => {
    const root = issue(1);
    const pr: OpenPullRequest = {
      key: 'a/r#10',
      repo: { owner: 'a', repo: 'r' },
      number: 10,
      title: 'Implement work',
      url: 'https://web.test/a/r/pull/10',
      body: 'Closes #1',
    };
    const other: OpenPullRequest = {
      ...pr,
      title: 'Alternate payload',
      body: 'No closing reference',
    };
    const first = buildPlan(resolvePlanInput([root], new Map(), settings, [], [pr, other]));
    const second = buildPlan(resolvePlanInput([root], new Map(), settings, [], [other, pr]));
    expect(first).toEqual(second);
  });

  it('does not attach a closing pull request from numbered text inside a multiline code span', () => {
    const issues = [issue(1), issue(2)];
    const pullRequest: OpenPullRequest = {
      key: 'a/r#10',
      repo: { owner: 'a', repo: 'r' },
      number: 10,
      title: 'Example PR',
      url: 'https://web.test/a/r/pull/10',
      body: '`example starts\n2. Closes #1\nexample ends`\nFixes #2',
    };
    const baseline = buildPlan(resolvePlanInput(issues, new Map(), settings));
    const plan = buildPlan(resolvePlanInput(issues, new Map(), settings, [], [pullRequest]));

    expect(plan.nodes.find((node) => node.key === 'a/r#1')?.closingPullRequests).toEqual([]);
    expect(plan.nodes.find((node) => node.key === 'a/r#2')?.closingPullRequests).toEqual([
      { key: 'a/r#10', number: 10, title: 'Example PR', url: 'https://web.test/a/r/pull/10' },
    ]);
    expect(plan.nodes.map((node) => [node.key, node.status])).toEqual(
      baseline.nodes.map((node) => [node.key, node.status]),
    );
    expect(plan.edges).toEqual(baseline.edges);
    expect(plan.order).toEqual(baseline.order);
    expect(plan.waves).toEqual(baseline.waves);
    expect(plan.criticalPath).toEqual(baseline.criticalPath);
  });

  it('recognizes closing URLs under a subpath-hosted forge webUrl while rejecting mismatched prefixes', () => {
    const root = issue(1);
    const subpathSettings: ResolutionSettings = {
      ...settings,
      webHosts: ['example.com'],
      webUrl: 'https://example.com/gitea',
    };
    const input = resolvePlanInput(
      [root, issue(2, 'Blocked by: [https://example.com/gitea/a/r/issues/1]')],
      new Map(),
      subpathSettings,
      [],
      [
        {
          key: 'a/r#10',
          repo: { owner: 'a', repo: 'r' },
          number: 10,
          title: 'Subpath close',
          url: 'https://example.com/gitea/a/r/pulls/10',
          body: 'Closes https://example.com/gitea/a/r/issues/1',
        },
        {
          key: 'a/r#11',
          repo: { owner: 'a', repo: 'r' },
          number: 11,
          title: 'Wrong prefix',
          url: 'https://example.com/gitea/a/r/pulls/11',
          body: 'Closes https://example.com/other/a/r/issues/1\nCloses https://example.com/a/r/issues/1',
        },
      ],
    );
    expect(input.closingPullRequests).toEqual([
      {
        issue: 'a/r#1',
        pullRequest: {
          key: 'a/r#10',
          number: 10,
          title: 'Subpath close',
          url: 'https://example.com/gitea/a/r/pulls/10',
        },
      },
    ]);
    expect(input.edges).toEqual([{ from: 'a/r#1', to: 'a/r#2', sources: ['body'] }]);
  });

  it.each(['---', '***', '___', '===', '=', '-'])(
    'retains prerequisite edges after a %s Markdown block boundary',
    (boundary) => {
      const dependent = issue(2, ['Note `a', boundary, 'Blocked by: [#1]', 'b` end'].join('\n'));
      const plan = buildPlan(
        resolvePlanInput([issue(1), dependent], new Map(), {
          ...settings,
          dependencies: { ...settings.dependencies, body: 'strict' },
        }),
      );
      expect(plan.edges).toEqual([{ from: 'a/r#1', to: 'a/r#2', sources: ['body'] }]);
      expect(plan.nodes.find((node) => node.key === 'a/r#2')?.status).toBe('blocked');
    },
  );

  it('rejects extra URL path prefixes for both dependencies and closing PRs on root-hosted sources', () => {
    const invalidUrl = 'https://web.test/x/y/a/r/issues/1';
    const plan = buildPlan(
      resolvePlanInput(
        [issue(1), issue(2, `Blocked by: [${invalidUrl}]`)],
        new Map(),
        settings,
        [],
        [
          {
            key: 'a/r#10',
            repo: { owner: 'a', repo: 'r' },
            number: 10,
            title: 'An unrelated URL',
            url: 'https://web.test/a/r/pull/10',
            body: `Closes ${invalidUrl}`,
          },
        ],
      ),
    );
    expect(plan.edges).toEqual([]);
    expect(plan.nodes.map((node) => [node.key, node.status, node.closingPullRequests])).toEqual([
      ['a/r#1', 'ready', []],
      ['a/r#2', 'ready', []],
    ]);
  });
});
