import type { ResolvedSource, ResolvedView } from '../config/schema.js';
import { parseKey } from '../core/keys.js';
import type { PlanInput } from '../core/plan.js';
import type { Issue, IssueKey, IssueProvider, PlanWarning } from '../core/types.js';
import { createLimiter } from '../providers/http.js';
import {
  MAX_EXTERNAL_FETCHES,
  pendingOutsideIssueKeys,
  resolvePlanInput,
  type OutsideIssueLookup,
} from './resolution.js';

/** Maximum number of `getIssue` calls made for issues that are not in the open set. */
export { MAX_EXTERNAL_FETCHES } from './resolution.js';
/** Maximum number of `getIssue` lookups in flight at the same time. */
export const LOOKUP_CONCURRENCY = 4;
export interface ResolveResult {
  input: PlanInput;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function webHostsOf(webUrl: string): string[] {
  if (webUrl === '') return [];
  try {
    return [new URL(webUrl).host.toLowerCase()];
  } catch {
    return [];
  }
}

/** Fetch named-view observations, then resolve them without further I/O. */
export async function resolveView(
  view: ResolvedView,
  source: ResolvedSource,
  provider: IssueProvider,
): Promise<ResolveResult> {
  const warnings: PlanWarning[] = [];
  const settings = { ...view, webHosts: webHostsOf(source.webUrl), webUrl: source.webUrl };
  const repos = [...view.repos].sort((a, b) => {
    const left = `${a.owner}/${a.repo}`;
    const right = `${b.owner}/${b.repo}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const nodes = new Map<IssueKey, Issue>();
  for (const repo of repos) {
    const result = await provider.listOpenIssues(repo, {
      native: view.dependencies.native,
      subIssues: view.dependencies.subIssues,
    });
    warnings.push(...result.warnings);
    for (const issue of result.issues) {
      if (issue.state === 'open' && !nodes.has(issue.key)) nodes.set(issue.key, issue);
    }
  }
  const openIssues = [...nodes.values()];
  const lookups = new Map<IssueKey, OutsideIssueLookup>();
  const limit = createLimiter(LOOKUP_CONCURRENCY);
  let fetches = 0;
  while (true) {
    const keys = pendingOutsideIssueKeys([...nodes.values()], lookups, settings);
    if (keys.length === 0) break;
    const allowed = Math.max(0, MAX_EXTERNAL_FETCHES - fetches);
    const toFetch = keys.slice(0, allowed);
    for (const key of keys.slice(allowed)) lookups.set(key, { status: 'unresolved', error: null });
    fetches += toFetch.length;
    const outcomes = await Promise.all(
      toFetch.map((key) =>
        limit(async () => {
          const { repo, number } = parseKey(key);
          let lookup: OutsideIssueLookup;
          try {
            const issue = await provider.getIssue(repo, number);
            lookup = issue === null ? { status: 'missing' } : { status: 'found', issue };
          } catch (err) {
            lookup = { status: 'unresolved', error: errorMessage(err) };
          }
          return { key, lookup };
        }),
      ),
    );
    for (const { key, lookup } of outcomes) {
      lookups.set(key, lookup);
      if (lookup.status === 'found' && lookup.issue.state === 'open') {
        const issue = lookup.issue;
        nodes.set(key, issue.key === key ? issue : { ...issue, key });
      }
    }
  }
  return { input: resolvePlanInput(openIssues, lookups, settings, warnings) };
}
