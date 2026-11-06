import type { ResolvedView } from '../config/schema.js';
import { compareKeys, makeKey, parseKey } from '../core/keys.js';
import { parseBodyRelations, parseClosingIssues } from '../core/parser.js';
import type { ClosingPullRequestLink, ParentLink, PlanInput } from '../core/plan.js';
import type {
  DependencyEdge,
  DependencySource,
  Issue,
  IssueKey,
  IssueRef,
  OpenPullRequest,
  PlanWarning,
  RawRelation,
} from '../core/types.js';

/** Legacy named-view lookup budget, also used in its cutoff warning. */
export const MAX_EXTERNAL_FETCHES = 200;

/** Lookup observations are data: resolution never performs provider reads. */
export type OutsideIssueLookup =
  | { status: 'found'; issue: Issue }
  | { status: 'missing' }
  | { status: 'unresolved'; error: string | null };

export interface RelationSettings {
  dependencies: ResolvedView['dependencies'];
  webHosts: string[];
}

export interface ResolutionSettings extends RelationSettings {
  id: string;
  scope: ResolvedView['scope'];
  ordering: ResolvedView['ordering'];
  webUrl: string;
}

/** A relation with its declaring issue and the fully qualified key it points to. */
interface PendingRelation {
  declaring: IssueKey;
  refKey: IssueKey;
  kind: 'blocked-by' | 'blocks';
  source: DependencySource;
}

type Lookup = 'closed' | 'missing' | 'unresolved';

function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map((v) => v.toLowerCase()));
}

function inScope(issue: Issue, scope: ResolvedView['scope']): boolean {
  const labels = new Set(issue.labels.map((l) => l.toLowerCase()));
  const include = lowerSet(scope.labels);
  if (include.size > 0 && ![...include].some((l) => labels.has(l))) return false;
  const exclude = lowerSet(scope.excludeLabels);
  if ([...exclude].some((l) => labels.has(l))) return false;
  const milestones = lowerSet(scope.milestones);
  if (milestones.size > 0) {
    if (issue.milestone === null || !milestones.has(issue.milestone.toLowerCase())) return false;
  }
  return true;
}

function placeholderIssue(key: IssueKey, webUrl: string): Issue {
  const { repo, number } = parseKey(key);
  const base = webUrl.replace(/\/+$/, '');
  return {
    key,
    repo,
    number,
    title: '(unavailable)',
    state: 'open',
    url: base === '' ? '' : `${base}/${repo.owner}/${repo.repo}/issues/${number}`,
    body: '',
    labels: [],
    assignees: [],
    milestone: null,
    updatedAt: null,
    nativeRelations: [],
  };
}

function relationsOf(issue: Issue, settings: RelationSettings): RawRelation[] {
  const out: RawRelation[] = [];
  for (const rel of issue.nativeRelations) {
    if (
      rel.source === 'sub-issue' ? settings.dependencies.subIssues : settings.dependencies.native
    ) {
      out.push(rel);
    }
  }
  if (settings.dependencies.body) {
    out.push(
      ...parseBodyRelations(issue.body, {
        keywords: settings.dependencies.keywords,
        webHosts: settings.webHosts,
        strict: settings.dependencies.body === 'strict',
      }),
    );
  }
  return out;
}
const qualify = (ref: IssueRef, declaring: Issue): IssueKey =>
  makeKey(
    { owner: ref.owner ?? declaring.repo.owner, repo: ref.repo ?? declaring.repo.repo },
    ref.number,
  );

/** Sorted, deduplicated references still needing a lookup. Parents are hierarchy only.
 * Pass all known open issues, including open lookup results, to discover the next level.
 */
export function pendingOutsideIssueKeys(
  issues: readonly Issue[],
  lookups: ReadonlyMap<IssueKey, OutsideIssueLookup>,
  settings: RelationSettings,
): IssueKey[] {
  const known = new Set(issues.map((issue) => issue.key));
  const unknown = new Set<IssueKey>();
  for (const issue of issues) {
    for (const rel of relationsOf(issue, settings)) {
      const key = qualify(rel.ref, issue);
      if (rel.kind !== 'parent' && !known.has(key) && !lookups.has(key)) unknown.add(key);
    }
  }
  return [...unknown].sort(compareKeys);
}

/** Build a plan from observations without I/O or mutating the supplied collections.
 * Omitted lookup results are unresolved; an unresolved error creates an unavailable
 * prerequisite, while a null error represents the legacy lookup-budget cutoff.
 */
export function resolvePlanInput(
  openIssues: readonly Issue[],
  outsideIssues: ReadonlyMap<IssueKey, OutsideIssueLookup>,
  settings: ResolutionSettings,
  listingWarnings: readonly PlanWarning[] = [],
  openPullRequests: readonly OpenPullRequest[] = [],
): PlanInput {
  const warnings = [...listingWarnings];
  const nodes = new Map<IssueKey, Issue>();
  for (const issue of openIssues) {
    if (issue.state === 'open' && !nodes.has(issue.key)) nodes.set(issue.key, issue);
  }
  const inViewOpen = new Set(nodes.keys());
  // Step 3: breadth-first resolution of references that are not in the open set.
  const pending: PendingRelation[] = [];
  const parentLinks: ParentLink[] = [];
  const lookups = new Map<IssueKey, Lookup>();
  const unresolved: IssueKey[] = [];

  let level: Issue[] = [...nodes.values()].sort((a, b) => compareKeys(a.key, b.key));
  while (level.length > 0) {
    const unknown = new Set<IssueKey>();
    for (const issue of level) {
      for (const rel of relationsOf(issue, settings)) {
        const refKey = qualify(rel.ref, issue);
        // A parent is hierarchy only: it is never fetched and never becomes an edge.
        if (rel.kind === 'parent') {
          parentLinks.push({ parent: refKey, child: issue.key });
          continue;
        }
        pending.push({ declaring: issue.key, refKey, kind: rel.kind, source: rel.source });
        if (!nodes.has(refKey) && !lookups.has(refKey)) unknown.add(refKey);
      }
    }
    const keys = [...unknown].sort(compareKeys);
    const outcomes = keys.map((key) => ({ key, lookup: outsideIssues.get(key) }));

    const next: Issue[] = [];
    for (const { key, lookup } of outcomes) {
      if (lookup === undefined || (lookup.status === 'unresolved' && lookup.error === null)) {
        lookups.set(key, 'unresolved');
        unresolved.push(key);
      } else if (lookup.status === 'unresolved') {
        warnings.push({
          code: 'fetch-error',
          message: `Could not fetch ${key}: ${lookup.error}`,
          issues: [key],
        });
        nodes.set(key, placeholderIssue(key, settings.webUrl));
      } else if (lookup.status === 'missing') {
        lookups.set(key, 'missing');
      } else if (lookup.issue.state === 'closed') {
        lookups.set(key, 'closed');
      } else {
        // Trust our own qualified key: the provider's issue must be the one we asked for.
        const issue = lookup.issue;
        nodes.set(key, issue.key === key ? issue : { ...issue, key });
        next.push(nodes.get(key)!);
      }
    }
    level = next.sort((a, b) => compareKeys(a.key, b.key));
  }

  if (unresolved.length > 0) {
    unresolved.sort(compareKeys);
    warnings.push({
      code: 'external-unresolved',
      message: `Stopped after ${MAX_EXTERNAL_FETCHES} lookups of issues outside the view; ${unresolved.length} referenced issue(s) were not resolved: ${unresolved.join(', ')}`,
      issues: unresolved,
    });
  }

  // Step 4: edges, dangling references.
  const edgeSources = new Map<
    string,
    { from: IssueKey; to: IssueKey; sources: Set<DependencySource> }
  >();
  const dangling = new Set<string>();
  const sortedPending = pending.sort(
    (a, b) =>
      compareKeys(a.declaring, b.declaring) ||
      compareKeys(a.refKey, b.refKey) ||
      cmp(a.kind, b.kind) ||
      cmp(a.source, b.source),
  );
  for (const rel of sortedPending) {
    if (nodes.has(rel.refKey)) {
      const from = rel.kind === 'blocked-by' ? rel.refKey : rel.declaring;
      const to = rel.kind === 'blocked-by' ? rel.declaring : rel.refKey;
      const id = `${from}\u0000${to}`;
      let entry = edgeSources.get(id);
      if (entry === undefined) {
        entry = { from, to, sources: new Set() };
        edgeSources.set(id, entry);
      }
      entry.sources.add(rel.source);
    } else if (lookups.get(rel.refKey) === 'missing') {
      const id = `${rel.declaring}\u0000${rel.refKey}`;
      if (dangling.has(id)) continue;
      dangling.add(id);
      warnings.push({
        code: 'dangling-reference',
        message: `${rel.declaring} references ${rel.refKey}, which does not exist or is not accessible`,
        issues: [rel.declaring],
      });
    }
    // closed (satisfied) and unresolved (already warned about) relations are dropped.
  }
  const allEdges: DependencyEdge[] = [...edgeSources.values()]
    .map((e) => ({ from: e.from, to: e.to, sources: [...e.sources].sort() }))
    .sort((a, b) => compareKeys(a.from, b.from) || compareKeys(a.to, b.to));

  // Step 5: scope. Plan nodes = in-scope issues plus their transitive open prerequisites.
  const predecessors = new Map<IssueKey, IssueKey[]>();
  for (const e of allEdges) {
    const list = predecessors.get(e.to);
    if (list === undefined) predecessors.set(e.to, [e.from]);
    else list.push(e.from);
  }
  const scoped = new Set<IssueKey>();
  for (const key of [...inViewOpen].sort(compareKeys)) {
    if (inScope(nodes.get(key)!, settings.scope)) scoped.add(key);
  }
  const included = new Set<IssueKey>(scoped);
  const stack = [...scoped];
  while (stack.length > 0) {
    const key = stack.pop()!;
    for (const pred of predecessors.get(key) ?? []) {
      if (!included.has(pred)) {
        included.add(pred);
        stack.push(pred);
      }
    }
  }

  const pullRequests = new Map<IssueKey, OpenPullRequest>();
  for (const pr of openPullRequests) {
    if (!pullRequests.has(pr.key)) pullRequests.set(pr.key, pr);
  }
  const closingPullRequests: ClosingPullRequestLink[] = [];
  for (const pr of [...pullRequests.values()].sort((a, b) => compareKeys(a.key, b.key))) {
    for (const ref of parseClosingIssues(pr.body, { webHosts: settings.webHosts })) {
      const issueKey = makeKey(
        { owner: ref.owner ?? pr.repo.owner, repo: ref.repo ?? pr.repo.repo },
        ref.number,
      );
      if (!included.has(issueKey)) continue;
      closingPullRequests.push({
        issue: issueKey,
        pullRequest: {
          key: pr.key,
          number: pr.number,
          title: pr.title,
          url: pr.url,
        },
      });
    }
  }

  const keys = [...included].sort(compareKeys);
  const input: PlanInput = {
    viewId: settings.id,
    issues: keys.map((k) => nodes.get(k)!),
    externalKeys: keys.filter((k) => !scoped.has(k)),
    edges: allEdges.filter((e) => included.has(e.from) && included.has(e.to)),
    parentLinks,
    closingPullRequests,
    // Drop problems that concern issues which are not part of the plan.
    warnings: warnings.filter(
      (w) =>
        (w.code !== 'dangling-reference' && w.code !== 'fetch-error') ||
        w.issues.every((k) => included.has(k)),
    ),
    priorityLabels: [...settings.ordering.priorityLabels],
    orderingMode: settings.ordering.mode,
  };
  return input;
}
