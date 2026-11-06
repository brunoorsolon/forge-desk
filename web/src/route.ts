import { DEFAULT_SORT, isSortMode, type SortMode } from './sort.js';

export type Tab = 'graph' | 'order' | 'problems';

export const TABS: readonly Tab[] = ['graph', 'order', 'problems'];

/** Scope identifiers are decoded; project owner and repo are canonical lowercase. */
export type RouteScope =
  | { kind: 'project'; source: string; owner: string; repo: string }
  | { kind: 'source'; source: string };

export interface Route {
  /** Absent for the legacy root/view routes. Takes precedence over viewId. */
  scope?: RouteScope;
  /** Legacy view selection; null on parsed project/source routes. */
  viewId: string | null;
  tab: Tab;
  /** Filter query. */
  q: string;
  /** Order of the issues inside each wave. */
  sort: SortMode;
}

export const DEFAULT_ROUTE: Route = {
  viewId: null,
  tab: 'graph',
  q: '',
  sort: DEFAULT_SORT,
};

function isTab(s: string | undefined): s is Tab {
  return s !== undefined && (TABS as readonly string[]).includes(s);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses root, view, project and source hashes. Unknown input gives defaults. */
export function parseHash(hash: string): Route {
  let s = hash.startsWith('#') ? hash.slice(1) : hash;
  let q = '';
  let sort: SortMode = DEFAULT_SORT;
  const qi = s.indexOf('?');
  if (qi >= 0) {
    const params = new URLSearchParams(s.slice(qi + 1));
    q = params.get('q') ?? '';
    const raw = params.get('sort');
    sort = isSortMode(raw) ? raw : DEFAULT_SORT;
    s = s.slice(0, qi);
  }
  const parts = s.split('/').filter((p) => p !== '');
  if (parts[0] === 'project' || parts[0] === 'source') {
    // Unlike the legacy view parser, do not collapse empty required segments:
    // /project/source//repo must not shift the repository into the owner slot.
    const segments = (s.startsWith('/') ? s.slice(1) : s).split('/');
    const required = parts[0] === 'project' ? 4 : 2;
    if (
      segments.length < required ||
      segments.length > required + 1 ||
      segments.slice(0, required).some((segment) => segment === '')
    ) {
      return { ...DEFAULT_ROUTE, q, sort };
    }
    try {
      const decoded = segments.map((segment) => decodeURIComponent(segment));
      const source = decoded[1]!;
      const scope: RouteScope =
        parts[0] === 'project'
          ? {
              kind: 'project',
              source,
              owner: decoded[2]!.toLowerCase(),
              repo: decoded[3]!.toLowerCase(),
            }
          : { kind: 'source', source };
      const rawTab = decoded[required];
      return { viewId: null, scope, tab: isTab(rawTab) ? rawTab : 'graph', q, sort };
    } catch {
      return { ...DEFAULT_ROUTE, q, sort };
    }
  }
  let viewId: string | null = null;
  let tab: Tab = 'graph';
  if (parts[0] === 'view' && parts[1] !== undefined) {
    viewId = safeDecode(parts[1]);
    if (isTab(parts[2])) tab = parts[2];
  }
  return { viewId, tab, q, sort };
}

export function serializeHash(route: Route): string {
  let query = route.q === '' ? '' : `?q=${encodeURIComponent(route.q)}`;
  if (route.sort !== DEFAULT_SORT) query += `${query === '' ? '?' : '&'}sort=${route.sort}`;
  if (route.scope !== undefined) {
    const scope = route.scope;
    const segments =
      scope.kind === 'project'
        ? ['project', scope.source, scope.owner.toLowerCase(), scope.repo.toLowerCase()]
        : ['source', scope.source];
    return `#/${segments.map((segment) => encodeURIComponent(segment)).join('/')}/${route.tab}${query}`;
  }
  if (route.viewId === null) return `#/${query}`;
  return `#/view/${encodeURIComponent(route.viewId)}/${route.tab}${query}`;
}
