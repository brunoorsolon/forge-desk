import { describe, expect, it } from 'vitest';
import type { CatalogResponse, ProjectRef } from '../core/scope.js';
import type {
  Issue,
  RawRelation,
  RelationCoverage,
  RelationCoverageStatus,
} from '../core/types.js';
import { ObservationStore } from './observationStore.js';

const project: ProjectRef = { source: 'Primary', repo: 'acme/app' };
const outside = { source: project.source, key: 'acme/app#1' };
const complete: RelationCoverage = { native: 'complete', subIssues: 'complete' };
const t1 = '2026-11-06T10:00:00.000Z';
const t2 = '2026-11-06T10:01:00.000Z';
const t3 = '2026-11-06T10:02:00.000Z';

function relation(source: RawRelation['source'], number: number): RawRelation {
  return { kind: 'blocked-by', source, ref: { owner: null, repo: null, number } };
}

function issue(extra: Partial<Issue> = {}): Issue {
  return {
    key: outside.key,
    repo: { owner: 'acme', repo: 'app' },
    number: 1,
    title: 'First',
    body: 'Blocked by #10',
    state: 'open',
    url: 'https://example.test/acme/app/issues/1',
    labels: [],
    assignees: [],
    milestone: null,
    updatedAt: null,
    nativeRelations: [],
    ...extra,
  };
}

function setup() {
  let at = t1;
  const store = new ObservationStore({ now: () => new Date(at) });
  return { store, clock: (value: string) => (at = value) };
}

function catalog(...projects: ProjectRef[]): CatalogResponse {
  return {
    sources: [...new Set(projects.map((p) => p.source))].map((id) => ({
      id,
      kind: 'github',
      policy: { status: 'usable' },
      projects: projects.filter((p) => p.source === id),
    })),
  };
}

/** Exercise the same concurrency and retention rules for both observation shapes. */
function access(store: ObservationStore, kind: 'repository' | 'outside') {
  const begin = () => {
    if (kind === 'repository') {
      const token = store.beginRepositoryRead(project);
      return {
        token,
        write: (value: Issue, relationCoverage = complete) =>
          store.writeRepository(token, { issues: [value], warnings: [], relationCoverage }),
        fail: (error: string) => store.fail(token, error),
      };
    }
    const token = store.beginOutsideIssueRead(outside);
    return {
      token,
      write: (value: Issue, relationCoverage = complete) =>
        store.writeOutsideIssue(token, {
          result: { status: 'found', issue: value },
          relationCoverage,
        }),
      fail: (error: string) => store.fail(token, error),
    };
  };
  const read = () =>
    kind === 'repository' ? store.readRepository(project)! : store.readOutsideIssue(outside)!;
  const data = () => {
    const observation = read().observation;
    return 'issues' in observation
      ? observation.issues?.[0]
      : observation.result?.status === 'found'
        ? observation.result.issue
        : undefined;
  };
  return { begin, read, data };
}

describe.each(['repository', 'outside'] as const)('%s observation store', (kind) => {
  it('starts empty, captures state, and accepts sequential and in-order concurrent writes', () => {
    const { store, clock } = setup();
    const api = access(store, kind);
    expect(api.read()).toBeUndefined();
    const first = api.begin();
    expect(first.token).toMatchObject({ invalidationGeneration: 0, startedAt: t1 });
    expect(api.data()).toBeUndefined();
    const initialVersion = api.read().version;
    const second = api.begin();
    expect(api.read().version).toBe(initialVersion);
    clock(t2);
    expect(first.write(issue())).toBe(true);
    const firstVersion = api.read().version;
    expect(firstVersion).not.toBe(initialVersion);
    clock(t3);
    expect(second.write(issue({ title: 'Second' }))).toBe(true);
    expect(api.data()?.title).toBe('Second');
    expect(api.read().version).not.toBe(firstVersion);
    expect(api.read().observation).toMatchObject({
      lastCheckedAt: t3,
      lastAttempt: { attemptedAt: t3, outcome: 'success', error: null },
      relationsCheckedAt: { native: t3, subIssues: t3 },
    });
    expect(api.begin().write(issue({ title: 'Third' }))).toBe(true);
    expect(api.data()?.title).toBe('Third');
  });

  it('rejects out-of-order success and failure, even with equal or backwards clock times', () => {
    const { store, clock } = setup();
    const api = access(store, kind);
    const older = api.begin();
    clock('2026-11-06T09:00:00.000Z');
    const newer = api.begin();
    newer.write(issue({ title: 'Newer' }));
    const accepted = api.read();
    expect(older.write(issue({ title: 'Older' }))).toBe(false);
    expect(api.read()).toEqual(accepted);
    const earlyFailure = api.begin();
    api.begin().write(issue({ title: 'Newest' }));
    const newest = api.read();
    expect(earlyFailure.fail('late error')).toBe(false);
    expect(api.read()).toEqual(newest);
  });

  it('does not let an older success overwrite a newer failed attempt', () => {
    const { store } = setup();
    const api = access(store, kind);
    api.begin().write(issue());
    const old = api.begin();
    api.begin().fail('newer failure');
    const failed = api.read();
    expect(old.write(issue({ title: 'Obsolete' }))).toBe(false);
    expect(api.read()).toEqual(failed);
    expect(api.data()?.title).toBe('First');
  });

  it('keeps pre-invalidation results invalidated until a new-generation read succeeds', () => {
    const { store, clock } = setup();
    const api = access(store, kind);
    api.begin().write(issue());
    const started = api.begin();
    const before = api.read();
    store.invalidateRepository(project);
    expect(api.read()).toMatchObject({
      invalidated: true,
      observation: { invalidationGeneration: 1, lastCheckedAt: t1 },
    });
    expect(api.read().version).not.toBe(before.version);
    clock(t2);
    expect(started.write(issue({ title: 'Data from before webhook' }))).toBe(true);
    expect(api.read().invalidated).toBe(true);
    expect(api.read().observation.lastCheckedAt).toBe(t2);
    const invalidatedVersion = api.read().version;
    store.invalidateRepository(project);
    expect(api.read().version).not.toBe(invalidatedVersion);
    expect(api.read().observation.invalidationGeneration).toBe(2);
    const fresh = api.begin();
    expect(fresh.token.invalidationGeneration).toBe(2);
    expect(fresh.write(issue({ title: 'Revalidated' }))).toBe(true);
    expect(api.read().invalidated).toBe(false);
  });

  it('rejects a pre-invalidation response after a current-generation response arrived', () => {
    const { store } = setup();
    const api = access(store, kind);
    const old = api.begin();
    store.invalidateRepository(project);
    api.begin().write(issue({ title: 'After webhook' }));
    const current = api.read();
    expect(old.write(issue())).toBe(false);
    expect(api.read()).toEqual(current);
    expect(current.invalidated).toBe(false);
  });

  it('keeps last-good data and its times on failure; a first failure holds no data', () => {
    const { store, clock } = setup();
    const api = access(store, kind);
    const request = api.begin();
    const version = api.read().version;
    expect(request.fail('first failure')).toBe(true);
    expect(api.data()).toBeUndefined();
    expect(api.read().version).not.toBe(version);
    expect(api.read().observation).toMatchObject({
      lastCheckedAt: null,
      lastAttempt: { attemptedAt: t1, outcome: 'failed', error: 'first failure' },
    });
    api.begin().write(issue({ nativeRelations: [relation('native', 2)] }));
    const good = api.read().observation;
    store.invalidateRepository(project);
    clock(t2);
    api.begin().fail('upstream unavailable');
    expect(api.read().observation).toMatchObject({
      lastCheckedAt: good.lastCheckedAt,
      relationCoverage: good.relationCoverage,
      relationsCheckedAt: good.relationsCheckedAt,
      lastAttempt: { attemptedAt: t2, outcome: 'failed', error: 'upstream unavailable' },
    });
    expect(api.data()?.nativeRelations).toEqual([relation('native', 2)]);
    expect(api.read().invalidated).toBe(true);
    clock(t3);
    api.begin().write(issue());
    expect(api.read().invalidated).toBe(false);
    expect(api.read().observation.lastAttempt?.error).toBeNull();
  });

  it.each(['failed', 'unsupported', 'not-requested'] as RelationCoverageStatus[])(
    'retains complete native relations and their age across repeated %s reads',
    (status) => {
      const { store, clock } = setup();
      const api = access(store, kind);
      api.begin().write(issue({ nativeRelations: [relation('native', 2)] }));
      clock(t2);
      api.begin().write(issue({ body: 'New body', nativeRelations: [relation('native', 99)] }), {
        native: status,
        subIssues: 'complete',
      });
      clock(t3);
      api.begin().write(issue({ body: 'Newest body' }), { native: status, subIssues: 'complete' });
      expect(api.data()?.nativeRelations).toEqual([relation('native', 2)]);
      expect(api.data()?.body).toBe('Newest body');
      expect(api.read().observation).toMatchObject({
        relationCoverage: { native: status, subIssues: 'complete' },
        relationsCheckedAt: { native: t1, subIssues: t3 },
        lastCheckedAt: t3,
      });
    },
  );

  it('retains each relation kind independently and a complete empty read clears it', () => {
    const { store, clock } = setup();
    const api = access(store, kind);
    api
      .begin()
      .write(issue({ nativeRelations: [relation('native', 2), relation('sub-issue', 3)] }));
    clock(t2);
    api.begin().write(issue({ nativeRelations: [relation('sub-issue', 4)] }), {
      native: 'failed',
      subIssues: 'complete',
    });
    expect(api.data()?.nativeRelations).toEqual(
      expect.arrayContaining([relation('native', 2), relation('sub-issue', 4)]),
    );
    expect(api.read().observation.relationsCheckedAt).toEqual({ native: t1, subIssues: t2 });
    clock(t3);
    api.begin().write(issue(), { native: 'complete', subIssues: 'unsupported' });
    expect(api.data()?.nativeRelations).toEqual([relation('sub-issue', 4)]);
    expect(api.read().observation.relationsCheckedAt).toEqual({ native: t3, subIssues: t2 });
    api.begin().write(issue({ nativeRelations: [relation('native', 99)] }), {
      native: 'failed',
      subIssues: 'complete',
    });
    expect(api.data()?.nativeRelations).toEqual([]);
  });

  it('allows partial relations with no complete baseline but never assigns them a complete age', () => {
    const { store } = setup();
    const api = access(store, kind);
    api.begin().write(issue({ nativeRelations: [relation('native', 2)] }), {
      native: 'failed',
      subIssues: 'not-requested',
    });
    expect(api.data()?.nativeRelations).toEqual([relation('native', 2)]);
    expect(api.read().observation).toMatchObject({
      relationsCheckedAt: { native: null, subIssues: null },
      lastAttempt: { outcome: 'partial' },
    });
  });

  it('consumes tokens once and rejects tokens from another store', () => {
    const { store } = setup();
    const api = access(store, kind);
    const request = api.begin();
    expect(new ObservationStore().fail(request.token, 'wrong store')).toBe(false);
    expect(request.write(issue())).toBe(true);
    const state = api.read();
    expect(request.write(issue({ title: 'Duplicate' }))).toBe(false);
    expect(request.fail('duplicate failure')).toBe(false);
    expect(api.read()).toEqual(state);
  });

  it('copies input data, retained relations and snapshots to prevent unversioned mutation', () => {
    const { store } = setup();
    const api = access(store, kind);
    const input = issue({ nativeRelations: [relation('native', 2)] });
    api.begin().write(input);
    input.nativeRelations[0]!.ref.number = 999;
    input.labels.push('mutated');
    api.data()!.nativeRelations[0]!.ref.number = 888;
    const state = api.read();
    state.observation.relationsCheckedAt.native = null;
    expect(api.data()?.nativeRelations).toEqual([relation('native', 2)]);
    expect(api.data()?.labels).toEqual([]);
    expect(api.read().observation.relationsCheckedAt.native).toBe(t1);
    api.begin().write(issue(), { native: 'failed', subIssues: 'failed' });
    expect(api.data()?.nativeRelations).toEqual([relation('native', 2)]);
  });
});

describe('observation identities and lifecycle', () => {
  it('canonicalizes repository and issue keys while keeping source IDs distinct', () => {
    const { store } = setup();
    const first = store.beginRepositoryRead({ source: 'Primary', repo: 'ACME/App' });
    store.writeRepository(first, { issues: [], warnings: [] });
    expect(store.readRepository(project)?.observation.project).toEqual(project);
    expect(store.readRepository({ ...project, source: 'primary' })).toBeUndefined();
    const second = store.beginOutsideIssueRead({ source: 'Primary', key: 'ACME/App#01' });
    store.writeOutsideIssue(second, { result: { status: 'found', issue: issue() } });
    expect(store.readOutsideIssue(outside)?.observation.key).toBe('acme/app#1');
    expect(store.readOutsideIssue({ ...outside, source: 'primary' })).toBeUndefined();
  });

  it('invalidates every matching outside issue, including without a prior listing, but no other keys', () => {
    const { store } = setup();
    const matching = [outside, { ...outside, key: 'acme/app#2' }];
    const others = [
      { ...outside, key: 'acme/other#1' },
      { ...outside, key: 'acme/application#1' },
      { ...outside, source: 'primary' },
    ];
    for (const ref of [...matching, ...others]) store.beginOutsideIssueRead(ref);
    const before = others.map((ref) => store.readOutsideIssue(ref));
    store.invalidateRepository({ ...project, repo: 'ACME/APP' });
    expect(store.readRepository(project)?.observation).toMatchObject({
      issues: null,
      invalidationGeneration: 1,
    });
    for (const ref of matching) {
      expect(store.readOutsideIssue(ref)).toMatchObject({
        invalidated: true,
        observation: { invalidationGeneration: 1 },
      });
    }
    expect(others.map((ref) => store.readOutsideIssue(ref))).toEqual(before);
  });

  it('distinguishes a successful empty listing from no data and stores partial warnings and error', () => {
    const { store } = setup();
    const warnings = [
      { code: 'fetch-error' as const, message: 'relation read failed', issues: [] },
    ];
    store.writeRepository(store.beginRepositoryRead(project), {
      issues: [],
      warnings,
      relationCoverage: { native: 'failed', subIssues: 'not-requested' },
      outcome: 'partial',
      error: 'relation read failed',
    });
    warnings[0]!.message = 'caller edit';
    expect(store.readRepository(project)?.observation).toMatchObject({
      issues: [],
      warnings: [{ message: 'relation read failed' }],
      lastCheckedAt: t1,
      lastAttempt: { outcome: 'partial', error: 'relation read failed' },
    });
    const previous = store.readRepository(project);
    store.fail(store.beginRepositoryRead(project), 'listing failed');
    expect(store.readRepository(project)?.observation.warnings).toEqual(
      previous?.observation.warnings,
    );
    expect(store.readRepository(project)?.observation.issues).toEqual([]);
  });

  it('keeps listing membership current while retaining relations only for matching issues', () => {
    const { store } = setup();
    const read = (issues: Issue[], coverage: RelationCoverage) =>
      store.writeRepository(store.beginRepositoryRead(project), {
        issues,
        warnings: [],
        relationCoverage: coverage,
      });
    read([issue({ nativeRelations: [relation('native', 2)] })], complete);
    read([issue({ key: 'acme/app#3', number: 3 })], { native: 'failed', subIssues: 'failed' });
    expect(store.readRepository(project)?.observation.issues?.map((i) => i.key)).toEqual([
      'acme/app#3',
    ]);
    read([issue()], { native: 'failed', subIssues: 'failed' });
    expect(store.readRepository(project)?.observation.issues?.[0]?.nativeRelations).toEqual([
      relation('native', 2),
    ]);
    read([], complete);
    read([issue()], { native: 'failed', subIssues: 'failed' });
    expect(store.readRepository(project)?.observation.issues?.[0]?.nativeRelations).toEqual([]);
  });

  it('promotes dropped open issues with their original data and relation ages, then prunes unused copies', () => {
    const { store, clock } = setup();
    const original = issue({ nativeRelations: [relation('native', 2)], labels: ['P0'] });
    store.writeRepository(store.beginRepositoryRead(project), {
      issues: [original, issue({ key: 'acme/app#2', number: 2, state: 'closed' })],
      warnings: [],
      relationCoverage: complete,
    });
    const listing = store.readRepository(project)!;
    clock(t2);
    store.writeRepository(store.beginRepositoryRead(project), {
      issues: [],
      warnings: [],
      relationCoverage: complete,
    });
    expect(store.readOutsideIssue(outside)).toMatchObject({
      invalidated: true,
      observation: {
        result: { status: 'found', issue: original },
        retainedFromListing: true,
        relationCoverage: complete,
        relationsCheckedAt: listing.observation.relationsCheckedAt,
        lastCheckedAt: t1,
        lastAttempt: null,
      },
    });
    expect(store.readOutsideIssue({ ...outside, key: 'acme/app#2' })).toBeUndefined();
    expect(store.readOutsideIssue({ ...outside, source: 'other' })).toBeUndefined();
    // Partial lookup coverage must not clear the native edge inherited from the listing.
    store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
      result: { status: 'found', issue: issue({ body: 'Updated' }) },
      relationCoverage: { native: 'failed', subIssues: 'complete' },
    });
    expect(store.readOutsideIssue(outside)?.observation).toMatchObject({
      result: { status: 'found', issue: { nativeRelations: original.nativeRelations } },
      relationsCheckedAt: { native: t1, subIssues: t2 },
    });
    store.prune(catalog(project), []);
    expect(store.readOutsideIssue(outside)).toBeUndefined();
  });

  it.each(['open', 'closed'] as const)(
    'preserves a newer targeted %s result over the dropped listing even with a backwards clock',
    (state) => {
      const { store, clock } = setup();
      store.writeRepository(store.beginRepositoryRead(project), {
        issues: [issue()],
        warnings: [],
        relationCoverage: complete,
      });
      clock('2026-11-06T09:00:00.000Z');
      store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
        result: { status: 'found', issue: issue({ state, title: 'Newer targeted data' }) },
        relationCoverage: complete,
      });
      const targeted = store.readOutsideIssue(outside)!;
      clock(t2);
      store.writeRepository(store.beginRepositoryRead(project), { issues: [], warnings: [] });
      expect(store.readOutsideIssue(outside)?.observation).toEqual({
        ...targeted.observation,
        ...(state === 'open' ? { retainedFromListing: true } : {}),
      });
      expect(store.readOutsideIssue(outside)?.invalidated).toBe(state === 'open');
    },
  );

  it('prefers a newer listing payload over an older targeted result without resetting failed reads', () => {
    const { store } = setup();
    store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
      result: { status: 'found', issue: issue({ title: 'Older targeted data', state: 'closed' }) },
      relationCoverage: complete,
    });
    store.writeRepository(store.beginRepositoryRead(project), {
      issues: [issue({ title: 'Newer listing data' })],
      warnings: [],
      relationCoverage: complete,
    });
    store.fail(store.beginOutsideIssueRead(outside), 'offline');
    const failed = store.readOutsideIssue(outside)!;
    store.writeRepository(store.beginRepositoryRead(project), { issues: [], warnings: [] });
    expect(store.readOutsideIssue(outside)).toMatchObject({
      invalidated: true,
      failedGeneration: failed.failedGeneration,
      observation: {
        lastAttempt: failed.observation.lastAttempt,
        result: { status: 'found', issue: { title: 'Newer listing data', state: 'open' } },
      },
    });
  });

  it('keeps pending lookups usable after promotion while rejecting those older than the retained listing', () => {
    const { store } = setup();
    const obsolete = store.beginOutsideIssueRead(outside);
    store.writeRepository(store.beginRepositoryRead(project), {
      issues: [issue()],
      warnings: [],
      relationCoverage: complete,
    });
    const pending = store.beginOutsideIssueRead(outside);
    store.writeRepository(store.beginRepositoryRead(project), { issues: [], warnings: [] });
    expect(store.writeOutsideIssue(obsolete, { result: { status: 'missing' } })).toBe(false);
    expect(
      store.writeOutsideIssue(pending, {
        result: { status: 'found', issue: issue({ state: 'closed' }) },
        relationCoverage: complete,
      }),
    ).toBe(true);
    expect(store.readOutsideIssue(outside)).toMatchObject({
      invalidated: false,
      observation: { result: { status: 'found', issue: { state: 'closed' } } },
    });
  });

  it('does not promote data on a failed or superseded repository read', () => {
    const { store } = setup();
    const older = store.beginRepositoryRead(project);
    store.writeRepository(store.beginRepositoryRead(project), {
      issues: [issue()],
      warnings: [],
    });
    expect(store.writeRepository(older, { issues: [], warnings: [] })).toBe(false);
    store.fail(store.beginRepositoryRead(project), 'offline');
    expect(store.readOutsideIssue(outside)).toBeUndefined();
  });

  it('reports an initially missing outside issue without claiming successful data or relation removal', () => {
    const { store } = setup();
    store.invalidateRepository(project);
    const token = store.beginOutsideIssueRead(outside);
    store.invalidateRepository(project);
    const before = store.readOutsideIssue(outside)!;
    expect(
      store.writeOutsideIssue(token, {
        result: { status: 'missing' },
        relationCoverage: complete,
      }),
    ).toBe(true);
    expect(store.readOutsideIssue(outside)).toMatchObject({
      invalidated: true,
      observation: {
        result: { status: 'missing' },
        lastCheckedAt: null,
        relationCoverage: { native: 'not-requested', subIssues: 'not-requested' },
        relationsCheckedAt: { native: null, subIssues: null },
        lastAttempt: {
          attemptedAt: t1,
          outcome: 'failed',
          error: 'Issue was not found or is not accessible',
        },
        invalidationGeneration: 1,
      },
    });
    expect(store.readOutsideIssue(outside)!.version).not.toBe(before.version);
  });

  it.each(['closed', 'complete-empty'] as const)(
    'retains public last-good data immediately after an inaccessible lookup until a %s read',
    (recovery) => {
      const { store, clock } = setup();
      store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
        result: { status: 'unresolved', error: 'offline' },
      });
      expect(store.readOutsideIssue(outside)?.observation).toMatchObject({
        result: null,
        lastAttempt: { outcome: 'failed', error: 'offline' },
      });
      const original = issue({
        body: 'Blocked by #10',
        nativeRelations: [relation('native', 2), relation('sub-issue', 3)],
      });
      store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
        result: { status: 'found', issue: original },
        relationCoverage: complete,
      });
      const missing = store.beginOutsideIssueRead(outside);
      store.invalidateRepository(project);
      const before = store.readOutsideIssue(outside)!;
      clock(t2);
      expect(
        store.writeOutsideIssue(missing, {
          result: { status: 'missing' },
          relationCoverage: complete,
          error: 'Lookup returned an inaccessible 404/410',
        }),
      ).toBe(true);
      const retained = store.readOutsideIssue(outside)!;
      expect(retained).toMatchObject({
        invalidated: true,
        observation: {
          result: { status: 'found', issue: original },
          lastCheckedAt: t1,
          relationCoverage: complete,
          relationsCheckedAt: { native: t1, subIssues: t1 },
          lastAttempt: {
            attemptedAt: t2,
            outcome: 'failed',
            error: 'Lookup returned an inaccessible 404/410',
          },
          invalidationGeneration: 1,
        },
      });
      expect(retained.version).not.toBe(before.version);
      // Repeated missing reads must not refresh the retained body or relation ages either.
      store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
        result: { status: 'missing' },
      });
      expect(store.readOutsideIssue(outside)?.observation.result).toEqual(
        retained.observation.result,
      );
      expect(store.readOutsideIssue(outside)?.observation.lastCheckedAt).toBe(t1);
      expect(store.readOutsideIssue(outside)?.invalidated).toBe(true);
      clock(t3);
      store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
        result: {
          status: 'found',
          issue: issue({
            body: '',
            state: recovery === 'closed' ? 'closed' : 'open',
          }),
        },
        ...(recovery === 'complete-empty' ? { relationCoverage: complete } : {}),
      });
      const recovered = store.readOutsideIssue(outside)!;
      expect(recovered.invalidated).toBe(false);
      expect(recovered.observation).toMatchObject({
        result: {
          status: 'found',
          issue: {
            body: '',
            state: recovery === 'closed' ? 'closed' : 'open',
            nativeRelations: recovery === 'closed' ? original.nativeRelations : [],
          },
        },
        lastCheckedAt: t3,
        relationsCheckedAt: {
          native: recovery === 'closed' ? t1 : t3,
          subIssues: recovery === 'closed' ? t1 : t3,
        },
        lastAttempt: { outcome: 'success', error: null },
      });
    },
  );

  it('rejects an obsolete missing result after a newer successful outside lookup', () => {
    const { store } = setup();
    const old = store.beginOutsideIssueRead(outside);
    store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
      result: { status: 'found', issue: issue() },
      relationCoverage: complete,
    });
    const current = store.readOutsideIssue(outside);
    expect(store.writeOutsideIssue(old, { result: { status: 'missing' } })).toBe(false);
    expect(store.readOutsideIssue(outside)).toEqual(current);
  });

  it('uses outside issue coverage when supplied on the issue and defaults missing coverage conservatively', () => {
    const { store } = setup();
    store.writeRepository(store.beginRepositoryRead(project), { issues: [], warnings: [] });
    expect(store.readRepository(project)?.observation).toMatchObject({
      relationCoverage: { native: 'not-requested', subIssues: 'not-requested' },
      relationsCheckedAt: { native: null, subIssues: null },
    });
    store.writeOutsideIssue(store.beginOutsideIssueRead(outside), {
      result: { status: 'found', issue: issue({ relationCoverage: complete }) },
    });
    expect(store.readOutsideIssue(outside)?.observation.relationsCheckedAt).toEqual({
      native: t1,
      subIssues: t1,
    });
  });

  it('prunes noncatalog listings and unreferenced outside keys without merging source identities', () => {
    const { store } = setup();
    const removedSource = { ...project, source: 'removed' };
    const noncatalog = { ...project, repo: 'acme/dependency' };
    for (const p of [project, removedSource, noncatalog]) store.beginRepositoryRead(p);
    const retained = { ...outside, key: 'external/repo#9' };
    const removed = { ...outside, source: 'removed' };
    const otherSource = { ...retained, source: 'other' };
    for (const ref of [outside, retained, removed, otherSource]) store.beginOutsideIssueRead(ref);
    const before = store.readOutsideIssue(retained);
    store.prune(catalog(project, { ...project, source: 'other' }), [retained, removed]);
    expect(store.readRepository(project)).toBeDefined();
    expect(store.readRepository(removedSource)).toBeUndefined();
    expect(store.readRepository(noncatalog)).toBeUndefined();
    expect(store.readOutsideIssue(outside)).toBeUndefined();
    expect(store.readOutsideIssue(removed)).toBeUndefined();
    expect(store.readOutsideIssue(otherSource)).toBeUndefined();
    expect(store.readOutsideIssue(retained)).toEqual(before);
  });

  it('does not resurrect pruned entries via in-flight writes and never reuses a recreated version', () => {
    const { store } = setup();
    const listing = store.beginRepositoryRead(project);
    const lookup = store.beginOutsideIssueRead(outside);
    const oldRepositoryVersion = store.readRepository(project)?.version;
    const oldOutsideVersion = store.readOutsideIssue(outside)?.version;
    store.prune(catalog(), []);
    expect(store.writeRepository(listing, { issues: [], warnings: [] })).toBe(false);
    store.beginOutsideIssueRead(outside);
    store.beginRepositoryRead(project);
    expect(store.writeOutsideIssue(lookup, { result: { status: 'missing' } })).toBe(false);
    expect(store.readRepository(project)?.version).not.toBe(oldRepositoryVersion);
    expect(store.readOutsideIssue(outside)?.version).not.toBe(oldOutsideVersion);
    expect(store.readOutsideIssue(outside)?.observation.result).toBeNull();
    store.prune(catalog(), []);
    expect(store.readRepository(project)).toBeUndefined();
    expect(store.readOutsideIssue(outside)).toBeUndefined();
  });
});
