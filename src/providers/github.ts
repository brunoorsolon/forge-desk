import { compareRefs, makeKey } from '../core/keys.js';
import type {
  FetchResult,
  Issue,
  IssueProvider,
  IssueRef,
  ListOptions,
  PlanWarning,
  RawRelation,
  RelationCoverage,
  RepoRef,
} from '../core/types.js';
import { HttpError, createHttpClient, createLimiter, type FetchLike } from './http.js';

export interface GitHubProviderOptions {
  /** API root. Default https://api.github.com. GHES: https://ghe.example.com/api/v3 */
  baseUrl?: string;
  /** Browser root. Accepted for config symmetry; issue URLs come from `html_url`. */
  webUrl?: string;
  /** null = anonymous access. */
  token: string | null;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for rate-limit waits. */
  now?: () => number;
  /** Max concurrent per-issue relation requests. Default 4. */
  concurrency?: number;
}

interface GhLabel {
  name?: unknown;
}
interface GhUser {
  login?: unknown;
}
interface GhIssue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  html_url?: unknown;
  body?: unknown;
  labels?: unknown;
  assignees?: unknown;
  assignee?: unknown;
  milestone?: { title?: unknown } | null;
  updated_at?: unknown;
  pull_request?: unknown;
  repository_url?: unknown;
  issue_dependencies_summary?: { total_blocked_by?: unknown } | null;
  sub_issues_summary?: { total?: unknown } | null;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const REPOSITORY_URL_RE = /\/repos\/([^/]+)\/([^/]+)\/?$/;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(cmp);
}

function lowerRepo(repo: RepoRef): RepoRef {
  return { owner: repo.owner.toLowerCase(), repo: repo.repo.toLowerCase() };
}

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mapIssue(raw: GhIssue, repo: RepoRef): Issue {
  if (
    typeof raw.number !== 'number' ||
    !Number.isSafeInteger(raw.number) ||
    typeof raw.title !== 'string'
  ) {
    throw new Error(`Unexpected GitHub issue payload in ${repo.owner}/${repo.repo}`);
  }
  const labels: string[] = [];
  if (Array.isArray(raw.labels)) {
    for (const l of raw.labels as Array<string | GhLabel | null>) {
      const name = typeof l === 'string' ? l : l && typeof l.name === 'string' ? l.name : '';
      if (name !== '') labels.push(name);
    }
  }
  const assignees: string[] = [];
  if (Array.isArray(raw.assignees)) {
    for (const a of raw.assignees as Array<GhUser | null>) {
      if (a && typeof a.login === 'string' && a.login !== '') assignees.push(a.login);
    }
  }
  if (assignees.length === 0 && isPlainObject(raw.assignee)) {
    const login = (raw.assignee as GhUser).login;
    if (typeof login === 'string' && login !== '') assignees.push(login);
  }
  const milestone =
    raw.milestone && typeof raw.milestone.title === 'string' ? raw.milestone.title : null;
  const updatedAt =
    typeof raw.updated_at === 'string' && raw.updated_at !== '' ? raw.updated_at : null;
  return {
    key: makeKey(repo, raw.number),
    repo,
    number: raw.number,
    title: raw.title,
    state: raw.state === 'closed' ? 'closed' : 'open',
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    labels: sortedUnique(labels),
    assignees: sortedUnique(assignees),
    milestone,
    updatedAt,
    nativeRelations: [],
  };
}

/** Owner/repo from `.../repos/{owner}/{repo}`, lowercased; falls back to `fallback`. */
function refFromItem(item: GhIssue, fallback: RepoRef): IssueRef | null {
  if (typeof item.number !== 'number' || !Number.isSafeInteger(item.number)) return null;
  let owner = fallback.owner;
  let repo = fallback.repo;
  if (typeof item.repository_url === 'string') {
    const m = REPOSITORY_URL_RE.exec(item.repository_url);
    if (m) {
      try {
        owner = decodeURIComponent(m[1]!).toLowerCase();
        repo = decodeURIComponent(m[2]!).toLowerCase();
      } catch {
        // keep the fallback
      }
    }
  }
  return { owner, repo, number: item.number };
}

function sourceRank(s: RawRelation['source']): number {
  return s === 'native' ? 0 : s === 'body' ? 1 : 2;
}

function compareRelations(a: RawRelation, b: RawRelation): number {
  return (
    cmp(a.kind, b.kind) || compareRefs(a.ref, b.ref) || sourceRank(a.source) - sourceRank(b.source)
  );
}

function normalizeRelations(relations: RawRelation[]): RawRelation[] {
  const sorted = [...relations].sort(compareRelations);
  return sorted.filter((r, i) => i === 0 || compareRelations(sorted[i - 1]!, r) !== 0);
}

function mapRelations(
  items: GhIssue[],
  repo: RepoRef,
  source: RawRelation['source'],
): RawRelation[] {
  const relations: RawRelation[] = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const ref = refFromItem(item, repo);
    if (ref) relations.push({ kind: 'blocked-by', ref, source });
  }
  return relations;
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

/** Skip only when the summary explicitly says zero; a missing or odd summary means "ask". */
function summaryAllowsSkip(total: unknown): boolean {
  return typeof total === 'number' && total <= 0;
}

export function createGitHubProvider(opts: GitHubProviderOptions): IssueProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'forge-desk',
  };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token}`;

  const client = createHttpClient({
    baseUrl,
    headers,
    conditionalRequests: true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const limit = createLimiter(opts.concurrency ?? 4);

  /**
   * Fetches related issues of each candidate. The first candidate goes alone: a 404 there
   * means the endpoint is unsupported, and nothing else is requested. Later 404s (an issue
   * transferred or deleted meanwhile) only skip that issue.
   * Returns null when unsupported.
   */
  async function fetchRelated(
    repo: RepoRef,
    candidates: Issue[],
    endpoint: string,
  ): Promise<Map<number, GhIssue[]> | null> {
    const results = new Map<number, GhIssue[]>();
    const fetchOne = (issue: Issue): Promise<GhIssue[]> =>
      limit(() =>
        client.getPaginatedLink<GhIssue>(
          `${repoPath(repo)}/issues/${issue.number}/${endpoint}?per_page=100`,
        ),
      );
    const [first, ...rest] = candidates;
    if (!first) return results;
    try {
      results.set(first.number, await fetchOne(first));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    await Promise.all(
      rest.map(async (issue) => {
        try {
          results.set(issue.number, await fetchOne(issue));
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }),
    );
    return results;
  }

  async function listOpenIssues(repoIn: RepoRef, options: ListOptions): Promise<FetchResult> {
    const repo = lowerRepo(repoIn);
    const rawItems = await client.getPaginatedLink<GhIssue>(
      `${repoPath(repo)}/issues?state=open&per_page=100`,
    );

    const issues: Issue[] = [];
    const summaries = new Map<number, GhIssue>();
    for (const raw of rawItems) {
      if (!isPlainObject(raw) || raw.pull_request) continue;
      const issue = mapIssue(raw, repo);
      issues.push(issue);
      summaries.set(issue.number, raw);
    }
    issues.sort((a, b) => a.number - b.number);

    const warnings: PlanWarning[] = [];
    const relationCoverage: RelationCoverage = {
      native: 'not-requested',
      subIssues: 'not-requested',
    };
    const relations = new Map<number, RawRelation[]>();
    const addRelations = (parent: Issue, items: GhIssue[], source: RawRelation['source']): void => {
      const list = relations.get(parent.number) ?? [];
      list.push(...mapRelations(items, repo, source));
      relations.set(parent.number, list);
    };

    if (options.native) {
      const candidates = issues.filter(
        (i) =>
          !summaryAllowsSkip(summaries.get(i.number)?.issue_dependencies_summary?.total_blocked_by),
      );
      const found = await fetchRelated(repo, candidates, 'dependencies/blocked_by');
      // Later 404s skip individual issues without a warning, but leave coverage incomplete.
      relationCoverage.native =
        found !== null && found.size === new Set(candidates.map((issue) => issue.number)).size
          ? 'complete'
          : 'unsupported';
      if (found === null) {
        warnings.push({
          code: 'native-unsupported',
          message: `Native issue dependencies are not available for ${repo.owner}/${repo.repo} (the dependencies endpoint returned 404); GitHub Enterprise Server versions without issue dependencies do not support them. Native dependencies are skipped.`,
          issues: [],
        });
      } else {
        for (const issue of candidates)
          addRelations(issue, found.get(issue.number) ?? [], 'native');
      }
    }

    if (options.subIssues) {
      const candidates = issues.filter(
        (i) => !summaryAllowsSkip(summaries.get(i.number)?.sub_issues_summary?.total),
      );
      const found = await fetchRelated(repo, candidates, 'sub_issues');
      relationCoverage.subIssues =
        found !== null && found.size === new Set(candidates.map((issue) => issue.number)).size
          ? 'complete'
          : 'unsupported';
      if (found === null) {
        warnings.push({
          code: 'native-unsupported',
          message: `Sub-issues are not available for ${repo.owner}/${repo.repo} (the sub_issues endpoint returned 404); GitHub Enterprise Server versions without sub-issues do not support them. Sub-issue relations are skipped.`,
          issues: [],
        });
      } else {
        for (const issue of candidates)
          addRelations(issue, found.get(issue.number) ?? [], 'sub-issue');
      }
    }

    for (const issue of issues) {
      issue.nativeRelations = normalizeRelations(relations.get(issue.number) ?? []);
    }
    return { issues, warnings, relationCoverage };
  }

  async function getIssue(
    repoIn: RepoRef,
    number: number,
    options?: ListOptions,
  ): Promise<Issue | null> {
    const repo = lowerRepo(repoIn);
    let raw: GhIssue;
    try {
      const { data } = await client.getJson<GhIssue>(`${repoPath(repo)}/issues/${number}`);
      if (!isPlainObject(data) || data.pull_request) return null;
      raw = data;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
    const issue = mapIssue(raw, repo);
    if (options === undefined) return issue;

    const relationCoverage: RelationCoverage = {
      native: 'not-requested',
      subIssues: 'not-requested',
    };
    const relations: RawRelation[] = [];
    const readRelations = async (
      kind: keyof RelationCoverage,
      endpoint: string,
      total: unknown,
      source: RawRelation['source'],
    ): Promise<void> => {
      if (!options[kind]) return;
      try {
        const candidates = summaryAllowsSkip(total) ? [] : [issue];
        const found = await fetchRelated(repo, candidates, endpoint);
        relationCoverage[kind] = found === null ? 'unsupported' : 'complete';
        if (found !== null)
          relations.push(...mapRelations(found.get(issue.number) ?? [], repo, source));
      } catch {
        // Keep the successfully read issue; incomplete relations must not clear blockers.
        relationCoverage[kind] = 'failed';
      }
    };
    await readRelations(
      'native',
      'dependencies/blocked_by',
      raw.issue_dependencies_summary?.total_blocked_by,
      'native',
    );
    await readRelations('subIssues', 'sub_issues', raw.sub_issues_summary?.total, 'sub-issue');
    issue.nativeRelations = normalizeRelations(relations);
    issue.relationCoverage = relationCoverage;
    return issue;
  }

  return { kind: 'github', listOpenIssues, getIssue };
}
