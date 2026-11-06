import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYWORDS } from '../core/parser.js';
import type { Issue } from '../core/types.js';
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
});
