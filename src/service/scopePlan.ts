import type { ResolvedView } from '../config/schema.js';
import { contentHash } from '../core/hash.js';
import { compareKeys } from '../core/keys.js';
import { computeLayout } from '../core/layout.js';
import { buildPlan } from '../core/plan.js';
import type {
  CatalogSource,
  ObservationMetadata,
  OutsideIssueObservation,
  RepositoryObservation,
  Scope,
} from '../core/scope.js';
import type { Issue, IssueKey, PlanWarning, Snapshot } from '../core/types.js';
import {
  MAX_EXTERNAL_FETCHES,
  pendingOutsideIssueKeys,
  resolvePlanInput,
  webHostsOf,
  type OutsideIssueLookup,
  type ResolutionSettings,
} from './resolution.js';
import { hasStaleProblem } from './staleProblem.js';

/** Structurally compatible with the observation store; no store or provider dependency. */
export interface DerivationObservation<T extends ObservationMetadata> {
  observation: T;
  invalidated: boolean;
}

export interface ScopePlanInput {
  scope: Scope;
  catalog: CatalogSource;
  policy: Pick<ResolvedView, 'dependencies' | 'ordering'>;
  repositories: readonly DerivationObservation<RepositoryObservation>[];
  outsideIssues: readonly DerivationObservation<OutsideIssueObservation>[];
  webUrl: string;
  cache: { ttlSeconds: number };
  now: Date;
}

export interface ScopePlanResult {
  /** Null before any scoped repository has a listing; missing listings are warned otherwise. */
  snapshot: Snapshot | null;
  computedAt: string;
  /** Sorted outstanding lookups, bounded by the legacy per-resolution budget. */
  pendingOutsideIssues: IssueKey[];
  /** Observations used by this derivation, including closed dependency targets. */
  contributingRepositories: string[];
  referencedOutsideIssues: IssueKey[];
  /** Targeted dependencies, including context supplied by another catalog listing. */
  contextIssues: IssueKey[];
}

/** Derive from current observations, never from previously derived snapshots. No I/O. */
export function deriveScopePlan(options: ScopePlanInput): ScopePlanResult {
  const { scope, catalog, policy } = options;
  if (scope.source !== catalog.id || catalog.policy.status !== 'usable') {
    throw new Error('Scope requires its own usable source catalog');
  }
  const projects = new Set(catalog.projects.map((p) => p.repo.toLowerCase()));
  if (scope.kind === 'project' && !projects.has(scope.repo.toLowerCase())) {
    throw new Error('Project is not in the source catalog');
  }
  const computedAt = options.now.toISOString();
  const records = new Map(
    options.repositories
      .filter((r) => r.observation.project.source === scope.source)
      .map((r) => [r.observation.project.repo.toLowerCase(), r] as const),
  );
  const scopeRepos = [...projects]
    .filter((repo) => scope.kind === 'source' || repo === scope.repo.toLowerCase())
    .sort();
  const listedRepos = scopeRepos.filter((repo) => records.get(repo)?.observation.issues != null);
  const unlistedRepos = scopeRepos.filter((repo) => records.get(repo)?.observation.issues == null);
  if (listedRepos.length === 0) {
    return {
      snapshot: null,
      computedAt,
      pendingOutsideIssues: [],
      contributingRepositories: scopeRepos,
      referencedOutsideIssues: [],
      contextIssues: [],
    };
  }
  const id =
    scope.kind === 'project'
      ? `project:${scope.source}/${scope.repo.toLowerCase()}`
      : `source:${scope.source}`;
  const settings: ResolutionSettings = {
    ...policy,
    id,
    scope: { labels: [], excludeLabels: [], milestones: [] },
    webUrl: options.webUrl,
    webHosts: webHostsOf(options.webUrl),
  };
  const knownCatalog = new Map<
    IssueKey,
    { issue: Issue; record: DerivationObservation<RepositoryObservation> }
  >();
  for (const repo of [...projects].sort()) {
    const record = records.get(repo);
    for (const issue of record?.observation.issues ?? []) {
      if (issue.state === 'open') knownCatalog.set(issue.key, { issue, record: record! });
    }
  }
  const roots = listedRepos
    .flatMap((r) => records.get(r)!.observation.issues!)
    .filter((i) => i.state === 'open');
  const openPullRequests = listedRepos.flatMap(
    (r) => records.get(r)!.observation.pullRequests ?? [],
  );
  const known = new Map(roots.map((i) => [i.key, i]));
  const outside = new Map(
    options.outsideIssues
      .filter((r) => r.observation.source === scope.source)
      .map((r) => [r.observation.key, r]),
  );
  const usedRepositories = new Set(listedRepos);
  const usedOutside = new Map<IssueKey, DerivationObservation<OutsideIssueObservation>>();
  const lookups = new Map<IssueKey, OutsideIssueLookup>();
  const provisional = new Set<IssueKey>();
  const pendingOutsideIssues: IssueKey[] = [];
  let budget = MAX_EXTERNAL_FETCHES;
  while (true) {
    const pending = pendingOutsideIssueKeys([...known.values()], lookups, settings);
    if (pending.length === 0) break;
    for (const key of pending) {
      const cached = knownCatalog.get(key);
      const record = outside.get(key);
      const result = record?.observation.result;
      // A project refresh lists only its own repository. Its targeted reads must
      // therefore supersede older sibling listings, including observed closure.
      const useTargeted =
        result?.status === 'found' &&
        (!cached ||
          (record!.observation.lastCheckedAt ?? '') >=
            (cached.record.observation.lastCheckedAt ?? ''));
      // Keep failed targeted checks for retry pacing/provisional reporting even
      // when the sibling listing remains the best available issue payload.
      if (
        record &&
        (!cached ||
          useTargeted ||
          (record.observation.lastAttempt?.attemptedAt ?? '') >=
            (cached.record.observation.lastCheckedAt ?? ''))
      )
        usedOutside.set(key, record);
      if (cached && !useTargeted) {
        known.set(key, cached.issue);
        lookups.set(key, { status: 'found', issue: cached.issue });
        usedRepositories.add(cached.record.observation.project.repo.toLowerCase());
        continue;
      }
      // Stored results require no lookup and must not starve new dependencies.
      if (result?.status === 'found') {
        const issue = result.issue.key === key ? result.issue : { ...result.issue, key };
        lookups.set(key, { ...result, issue });
        if (issue.state === 'open') known.set(key, issue);
        continue;
      }
      if (budget > 0) {
        budget--;
        pendingOutsideIssues.push(key);
      }
      // Missing/inaccessible is not evidence of closure. Even beyond the cap,
      // supply an unavailable prerequisite rather than dropping the declaring edge.
      lookups.set(key, {
        status: 'unresolved',
        error: 'Dependency has not been successfully observed',
      });
      provisional.add(key);
    }
  }
  const warnings: PlanWarning[] = [
    ...listedRepos.flatMap((r) => records.get(r)!.observation.warnings),
    ...unlistedRepos.map((repo): PlanWarning => ({
      code: 'repository-unlisted',
      message: `All projects plan is partial: ${scope.source}/${repo} has no successful repository listing`,
      issues: [],
    })),
  ];
  const resolved = resolvePlanInput(roots, lookups, settings, warnings, openPullRequests);
  const included = new Set(resolved.issues.map((i) => i.key));
  const inspect = (
    record: DerivationObservation<ObservationMetadata>,
    issues: Issue[],
    name: string,
  ): void => {
    const contributing = issues.filter((i) => included.has(i.key));
    for (const issue of contributing) {
      if (
        (['native', 'subIssues'] as const).some(
          (kind) =>
            policy.dependencies[kind] &&
            (record.observation.relationCoverage[kind] !== 'complete' ||
              (issue.relationCoverage !== undefined &&
                issue.relationCoverage[kind] !== 'complete')),
        )
      )
        provisional.add(issue.key);
    }
    if (hasStaleProblem(record.observation, options.cache.ttlSeconds, options.now))
      resolved.warnings.push({
        code: 'stale-data',
        message: `Stale observation: ${name}`,
        issues: contributing.map((i) => i.key).sort(compareKeys),
      });
  };
  const contributingChecks: (string | null)[] = [];
  for (const repo of [...usedRepositories].sort()) {
    const record = records.get(repo)!;
    const issues = record.observation.issues ?? [];
    if (scopeRepos.includes(repo) || issues.some((i) => included.has(i.key))) {
      inspect(record, issues, `${scope.source}/${repo}`);
      contributingChecks.push(record.observation.lastCheckedAt);
    }
  }
  for (const [key, record] of [...usedOutside].sort(([a], [b]) => compareKeys(a, b))) {
    const result = record.observation.result;
    // A closed lookup contributes by satisfying a relation even though it is not a node.
    if (!included.has(key) && !(result?.status === 'found' && result.issue.state === 'closed'))
      continue;
    inspect(record, result?.status === 'found' ? [{ ...result.issue, key }] : [], key);
    if (record.observation.lastAttempt?.outcome === 'failed') provisional.add(key);
  }
  // A provisional prerequisite also makes its dependents provisional.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of resolved.edges)
      if (provisional.has(edge.from) && !provisional.has(edge.to)) {
        provisional.add(edge.to);
        changed = true;
      }
  }
  const affected = [...provisional].filter((k) => included.has(k)).sort(compareKeys);
  if (affected.length)
    resolved.warnings.push({
      code: 'dependency-provisional',
      message:
        'Dependency observations are incomplete; blockers are retained until closure or relation removal is observed',
      issues: affected,
    });
  const plan = buildPlan(resolved);
  const layout = computeLayout(plan);
  const checks = contributingChecks;
  if (checks.some((check) => check === null))
    return {
      snapshot: null,
      computedAt,
      pendingOutsideIssues: pendingOutsideIssues.sort(compareKeys),
      contributingRepositories: [...new Set([...scopeRepos, ...usedRepositories])].sort(),
      referencedOutsideIssues: [...lookups.keys()]
        .filter((key) => !knownCatalog.has(key) || usedOutside.has(key))
        .sort(compareKeys),
      contextIssues: [...lookups.keys()].sort(compareKeys),
    };
  const snapshot: Snapshot = {
    viewId: id,
    title:
      scope.kind === 'project'
        ? `${scope.source} / ${scope.repo.toLowerCase()}`
        : `${scope.source} / All projects`,
    fetchedAt: checks.sort()[0]!,
    contentHash: contentHash({ plan, layout }),
    priorityLabels: [...policy.ordering.priorityLabels],
    orderingMode: policy.ordering.mode,
    plan,
    layout,
  };
  return {
    snapshot,
    computedAt,
    pendingOutsideIssues: pendingOutsideIssues.sort(compareKeys),
    contributingRepositories: [...new Set([...scopeRepos, ...usedRepositories])].sort(),
    referencedOutsideIssues: [...lookups.keys()]
      .filter((key) => !knownCatalog.has(key) || usedOutside.has(key))
      .sort(compareKeys),
    contextIssues: [...lookups.keys()].sort(compareKeys),
  };
}
