import { describe, expect, it } from 'vitest';
import type {
  AvailablePreferences,
  PreferencesUnavailableReason,
} from '../../src/core/preferences.js';
import {
  canChangeFavorites,
  initialPreferenceState,
  reducePreferences,
  type PreferenceEffect,
  type PreferenceEvent,
} from './preferenceState.js';

const a = { source: 's', repo: 'o/a' };
const b = { source: 's', repo: 'o/b' };
function response(revision = 1, repos: string[] = []): AvailablePreferences {
  return {
    available: true,
    revision,
    favorites: repos.map((repo) => ({ source: 's', repo, inCatalog: true })),
    rememberedProject: null,
  };
}
function harness() {
  let state = initialPreferenceState();
  let effects: PreferenceEffect[] = [];
  return {
    get state() {
      return state;
    },
    get effects() {
      return effects;
    },
    send(event: PreferenceEvent) {
      ({ state, effects } = reducePreferences(state, event));
      return effects;
    },
    ready(value = response()) {
      const [effect] = this.send({ type: 'open' });
      this.send({ type: 'read-success', id: effect!.id, response: value });
    },
  };
}

describe('preference state', () => {
  it('starts unloaded and requests a read on open, tab return and reload', () => {
    const h = harness();
    expect(h.state.view.status).toBe('not-loaded');
    expect(canChangeFavorites(h.state)).toBe(false);
    for (const type of ['open', 'tab-return', 'reload'] as const) {
      expect(h.send({ type })).toEqual([{ kind: 'read', id: h.state.nextId - 1 }]);
    }
  });

  it('discards out-of-order older reads and does not navigate after a remembered-project reload', () => {
    const h = harness();
    h.ready(response(4));
    const [old] = h.send({ type: 'reload' });
    const [fresh] = h.send({ type: 'tab-return' });
    const value = { ...response(6), rememberedProject: b };
    h.send({ type: 'read-success', id: fresh!.id, response: value });
    expect(h.effects).toEqual([]);
    h.send({ type: 'read-success', id: old!.id, response: response(5) });
    expect(h.state.confirmed).toEqual(value);
    const [again] = h.send({ type: 'reload' });
    h.send({ type: 'read-success', id: again!.id, response: response(3) });
    expect(h.state.confirmed).toEqual(value);
  });

  it('serializes three quick mutations in order, showing optimistic favorites immediately', () => {
    const h = harness();
    h.ready();
    const add = { kind: 'add-favorite', project: a } as const;
    const remove = { kind: 'remove-favorite', project: a } as const;
    const remember = { kind: 'remember-project', project: b } as const;
    const [first] = h.send({ type: 'mutate', mutation: add });
    expect(h.state.view).toMatchObject({ preferences: { favorites: [{ ...a, inCatalog: true }] } });
    expect(h.send({ type: 'mutate', mutation: remove })).toEqual([]);
    expect(h.state.view).toMatchObject({ preferences: { favorites: [] } });
    expect(h.send({ type: 'mutate', mutation: remember })).toEqual([]);
    expect(h.state.queue).toEqual([remove, remember]);
    const [second] = h.send({
      type: 'save-success',
      id: first!.id,
      response: response(2, [a.repo]),
    });
    expect(second).toMatchObject({ kind: 'save', mutation: remove });
    const [third] = h.send({ type: 'save-success', id: second!.id, response: response(3) });
    expect(third).toMatchObject({ kind: 'save', mutation: remember });
    expect(
      h.send({
        type: 'save-success',
        id: third!.id,
        response: { ...response(4), rememberedProject: b },
      }),
    ).toEqual([]);
    expect(h.state.active).toBeNull();
    expect(h.state.confirmed?.rememberedProject).toEqual(b);
  });

  it.each(['add-favorite', 'remove-favorite'] as const)(
    'reverts failed %s and gates actions until a reread succeeds',
    (kind) => {
      const h = harness();
      const original = response(1, kind === 'remove-favorite' ? [a.repo] : []);
      h.ready(original);
      const [oldRead] = h.send({ type: 'reload' });
      const [save] = h.send({ type: 'mutate', mutation: { kind, project: a } });
      const [reread] = h.send({ type: 'save-failure', id: save!.id, message: 'Lost response' });
      expect(h.state.view).toEqual({ status: 'available', preferences: original });
      expect(h.state.error).toBe('Lost response');
      expect(canChangeFavorites(h.state)).toBe(false);
      expect(h.send({ type: 'mutate', mutation: { kind, project: a } })).toEqual([]);
      h.send({ type: 'read-success', id: oldRead!.id, response: original });
      expect(canChangeFavorites(h.state)).toBe(false);
      h.send({ type: 'read-success', id: reread!.id, response: response(2) });
      expect(canChangeFavorites(h.state)).toBe(true);
      expect(h.effects).toEqual([]); // no retry of the failed mutation
    },
  );

  it.each(['add-favorite', 'remember-project'] as const)(
    'retains queued cancellation feedback when the active %s later fails',
    (kind) => {
      const h = harness();
      h.ready();
      const [save] = h.send({ type: 'mutate', mutation: { kind, project: a } });
      h.send({ type: 'mutate', mutation: { kind, project: b } });
      const [read] = h.send({ type: 'reload' });
      h.send({ type: 'read-failure', id: read!.id, message: 'Offline' });
      const canceled = kind === 'remember-project' ? h.state.notice : h.state.error;
      h.send({ type: 'save-failure', id: save!.id, message: 'Active save failed' });
      const feedback = kind === 'remember-project' ? h.state.notice : h.state.error;
      expect(feedback).toContain(canceled!);
      expect(feedback).toContain('Active save failed');
    },
  );

  describe.each(['save-failure', 'read-failure', 'unavailable'] as const)(
    'queue cancellation on %s',
    (failure) => {
      it.each(['add-favorite', 'remove-favorite', 'remember-project'] as const)(
        'reports discarded %s and never replays it after immediate recovery',
        (kind) => {
          const h = harness();
          h.ready(response(1, [b.repo]));
          const [save] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } });
          h.send({ type: 'mutate', mutation: { kind, project: b } });
          let read: PreferenceEffect;
          if (failure === 'save-failure') {
            [read] = h.send({ type: 'save-failure', id: save!.id, message: 'Star failed' }) as [
              PreferenceEffect,
            ];
          } else {
            const [background] = h.send({ type: 'reload' });
            h.send(
              failure === 'read-failure'
                ? { type: 'read-failure', id: background!.id, message: 'Offline' }
                : {
                    type: 'read-success',
                    id: background!.id,
                    response: { available: false, reason: 'store-locked', message: 'Locked' },
                  },
            );
            expect(h.state.active?.id).toBe(save!.id);
            expect(
              h.send({
                type: 'save-success',
                id: save!.id,
                response: response(2, [a.repo, b.repo]),
              }),
            ).toEqual([]);
            [read] = h.send({ type: 'reload' }) as [PreferenceEffect];
          }
          expect(h.state.queue).toEqual([]);
          if (kind === 'remember-project') {
            expect(h.state.notice).toContain('queued project selection was not remembered');
            expect(h.state.error).toBe(failure === 'save-failure' ? 'Star failed' : null);
          } else {
            expect(h.state.error).toContain('Queued favorite changes were not saved');
            expect(h.state.notice).toBeNull();
          }
          const feedback = { error: h.state.error, notice: h.state.notice };
          expect(
            h.send({ type: 'read-success', id: read.id, response: response(3, [a.repo, b.repo]) }),
          ).toEqual([]);
          expect(h.state).toMatchObject(feedback);
          expect(h.state.active).toBeNull();
          expect(h.state.confirmed?.rememberedProject).toBeNull();
        },
      );

      it('preserves earlier unrelated feedback while reporting both kinds of cancellation', () => {
        const h = harness();
        h.ready();
        const [save] = h.send({
          type: 'mutate',
          mutation: { kind: 'remember-project', project: a },
        });
        h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: b } });
        h.send({ type: 'mutate', mutation: { kind: 'remember-project', project: b } });
        const [read] = h.send({ type: 'reload' });
        const event: PreferenceEvent =
          failure === 'save-failure'
            ? { type: 'save-failure', id: save!.id, message: 'Remember failed' }
            : failure === 'read-failure'
              ? { type: 'read-failure', id: read!.id, message: 'Offline' }
              : {
                  type: 'read-success',
                  id: read!.id,
                  response: { available: false, reason: 'store-locked', message: 'Locked' },
                };
        const result = reducePreferences(
          { ...h.state, error: 'Earlier star failed', notice: 'Earlier notice' },
          event,
        );
        expect(result.state.error).toContain('Earlier star failed');
        expect(result.state.error).toContain('Queued favorite changes were not saved');
        expect(result.state.notice).toContain(
          failure === 'save-failure' ? 'Remember failed' : 'Earlier notice',
        );
        expect(result.state.notice).toContain('queued project selection was not remembered');
        expect(result.state.queue).toEqual([]);
      });
    },
  );

  it.each(['add-favorite', 'remember-project'] as const)(
    'discards queued %s through failed save and reread without offline replay',
    (kind) => {
      const h = harness();
      h.ready();
      const [save] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } });
      h.send({ type: 'mutate', mutation: { kind, project: b } });
      const [read] = h.send({ type: 'save-failure', id: save!.id, message: 'Lost response' });
      h.send({ type: 'read-failure', id: read!.id, message: 'Offline' });
      expect(h.effects).toEqual([]);
      expect(h.state.view.status).toBe('unverified');
      expect(canChangeFavorites(h.state)).toBe(false);
      const [retry] = h.send({ type: 'tab-return' });
      const effects = h.send({
        type: 'read-success',
        id: retry!.id,
        response: response(2, [a.repo]),
      });
      expect(effects).toEqual([]);
      expect(h.state.queue).toEqual([]);
      expect(h.state.active).toBeNull();
      expect(h.state.confirmed?.rememberedProject).toBeNull();
    },
  );

  it.each(['add-favorite', 'remember-project'] as const)(
    'preserves independent feedback after %s fails and the other action fails',
    (kind) => {
      const h = harness();
      h.ready();
      const other = kind === 'add-favorite' ? 'remember-project' : 'add-favorite';
      const [first] = h.send({ type: 'mutate', mutation: { kind, project: a } });
      const [read] = h.send({ type: 'save-failure', id: first!.id, message: kind });
      h.send({ type: 'read-success', id: read!.id, response: response(2) });
      const [second] = h.send({ type: 'mutate', mutation: { kind: other, project: b } });
      h.send({ type: 'save-failure', id: second!.id, message: other });
      expect(h.state.error).toBe('add-favorite');
      expect(h.state.notice).toBe('remember-project');
    },
  );

  it.each(['not-loaded', 'unverified'] as const)(
    'explicitly refuses remember-project while %s without retaining or replaying it',
    (status) => {
      const h = harness();
      if (status === 'unverified') {
        h.ready();
        const [read] = h.send({ type: 'reload' });
        h.send({ type: 'read-failure', id: read!.id, message: 'Offline' });
      }
      expect(h.state.view.status).toBe(status);
      expect(
        h.send({ type: 'mutate', mutation: { kind: 'remember-project', project: a } }),
      ).toEqual([]);
      expect(h.state.notice).toBe(
        'Project was not remembered because preferences are not writable.',
      );
      expect(h.state.queue).toEqual([]);
      const [read] = h.send({ type: 'open' });
      expect(h.send({ type: 'read-success', id: read!.id, response: response(2) })).toEqual([]);
      expect(h.state.confirmed?.rememberedProject).toBeNull();
      // Wiring must dispatch the latest explicit selection after the initial read.
      expect(
        h.send({ type: 'mutate', mutation: { kind: 'remember-project', project: b } }),
      ).toMatchObject([{ kind: 'save', mutation: { kind: 'remember-project', project: b } }]);
    },
  );

  it('failed remembered-project save yields only a notice and read, never a navigation effect', () => {
    const h = harness();
    h.ready();
    const [save] = h.send({ type: 'mutate', mutation: { kind: 'remember-project', project: a } });
    expect(h.send({ type: 'save-failure', id: save!.id, message: 'Not saved' })).toMatchObject([
      { kind: 'read' },
    ]);
    expect(h.state.notice).toBe('Not saved');
    expect(h.state.error).toBeNull();
    expect(h.state.confirmed?.rememberedProject).toBeNull();
  });

  it('keeps earlier available preferences read-only after failed reload', () => {
    const h = harness();
    const value = response(8, [a.repo]);
    h.ready(value);
    const [read] = h.send({ type: 'tab-return' });
    h.send({ type: 'read-failure', id: read!.id, message: 'Network failed' });
    expect(h.state.view).toEqual({
      status: 'unverified',
      preferences: value,
      message: 'Network failed',
    });
    expect(canChangeFavorites(h.state)).toBe(false);
  });

  it.each(['logout', 'session-expired'] as const)(
    'clears private state on %s and ignores late old-session reads and writes',
    (type) => {
      const h = harness();
      h.ready(response(1, [a.repo]));
      const [save] = h.send({ type: 'mutate', mutation: { kind: 'remove-favorite', project: a } });
      const [read] = h.send({ type: 'reload' });
      expect(h.send({ type })).toEqual([]);
      expect(h.state.confirmed).toBeNull();
      expect(h.state.view.status).toBe('not-loaded');
      h.send({ type: 'read-success', id: read!.id, response: response(9, [a.repo]) });
      h.send({ type: 'save-success', id: save!.id, response: response(10, [a.repo]) });
      expect(h.state.confirmed).toBeNull();
      const [newRead] = h.send({ type: 'open' });
      expect(newRead!.id).toBeGreaterThan(read!.id);
    },
  );

  it.each<PreferencesUnavailableReason>([
    'login-disabled',
    'storage-not-configured',
    'storage-missing',
    'store-locked',
    'unreadable',
    'corrupt',
    'unsupported-version',
  ])('represents unavailable %s without a working star', (reason) => {
    const h = harness();
    const [read] = h.send({ type: 'open' });
    h.send({
      type: 'read-success',
      id: read!.id,
      response: { available: false, reason, message: 'Unavailable' },
    });
    expect(h.state.view).toEqual({ status: 'unavailable', reason, message: 'Unavailable' });
    expect(canChangeFavorites(h.state)).toBe(false);
    expect(h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } })).toEqual([]);
  });

  it('does not overlap saves across an unavailable read followed by recovery', () => {
    const h = harness();
    h.ready();
    const [saveA] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } });
    const [read] = h.send({ type: 'reload' });
    h.send({
      type: 'read-success',
      id: read!.id,
      response: { available: false, reason: 'store-locked', message: 'Locked' },
    });
    expect(h.state.active?.id).toBe(saveA!.id);
    expect(canChangeFavorites(h.state)).toBe(false);
    const [recover] = h.send({ type: 'reload' });
    expect(h.send({ type: 'read-success', id: recover!.id, response: response(2) })).toEqual([]);
    expect(h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: b } })).toEqual([]);
    expect(h.state.active?.id).toBe(saveA!.id);
    expect(
      h.send({ type: 'save-success', id: saveA!.id, response: response(3, [a.repo]) }),
    ).toMatchObject([{ kind: 'save', mutation: { kind: 'add-favorite', project: b } }]);
  });

  it.each(['failure', 'unavailable'] as const)(
    'drops unsent intent on background read %s while retaining the active request',
    (outcome) => {
      const h = harness();
      h.ready();
      const [save] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } });
      h.send({ type: 'mutate', mutation: { kind: 'remember-project', project: b } });
      const [read] = h.send({ type: 'reload' });
      h.send(
        outcome === 'failure'
          ? { type: 'read-failure', id: read!.id, message: 'Offline' }
          : {
              type: 'read-success',
              id: read!.id,
              response: { available: false, reason: 'store-locked', message: 'Locked' },
            },
      );
      expect(h.state.queue).toEqual([]);
      expect(h.state.active?.id).toBe(save!.id);
      expect(
        h.send({ type: 'save-success', id: save!.id, response: response(2, [a.repo]) }),
      ).toEqual([]);
      const [retry] = h.send({ type: 'tab-return' });
      expect(
        h.send({ type: 'read-success', id: retry!.id, response: response(2, [a.repo]) }),
      ).toEqual([]);
      expect(h.state.confirmed?.rememberedProject).toBeNull();
    },
  );

  it('retains the revision floor across unavailable responses and clears it on logout', () => {
    const h = harness();
    h.ready(response(10));
    const [save] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } });
    h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: b } });
    const [read] = h.send({ type: 'reload' });
    h.send({
      type: 'read-success',
      id: read!.id,
      response: { available: false, reason: 'store-locked', message: 'Locked' },
    });
    expect(h.state.confirmed).toBeNull();
    expect(h.state.queue).toEqual([]);
    expect(h.send({ type: 'save-success', id: save!.id, response: response(2) })).toEqual([]);
    expect(h.state.view.status).toBe('unavailable');
    const [reload] = h.send({ type: 'reload' });
    h.send({ type: 'read-success', id: reload!.id, response: response(3) });
    expect(h.state.view.status).toBe('unavailable');
    const [recover] = h.send({ type: 'reload' });
    expect(h.send({ type: 'read-success', id: recover!.id, response: response(11) })).toEqual([]);
    expect(h.state.queue).toEqual([]);
    h.send({ type: 'logout' });
    h.ready(response(1));
    expect(h.state.confirmed?.revision).toBe(1);
  });

  it('retains an unavailable favorite and permits removing it', () => {
    const h = harness();
    const value = { ...response(), favorites: [{ ...a, inCatalog: false }] };
    h.ready(value);
    expect(h.state.view).toEqual({ status: 'available', preferences: value });
    const [save] = h.send({ type: 'mutate', mutation: { kind: 'remove-favorite', project: a } });
    expect(save).toMatchObject({ kind: 'save' });
    expect(h.state.view).toMatchObject({ preferences: { favorites: [] } });
    h.send({ type: 'save-success', id: save!.id, response: response(2) });
    expect(h.state.confirmed?.favorites).toEqual([]);
  });

  it('does not let an older save response replace a newer read revision', () => {
    const h = harness();
    h.ready();
    const [save] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } });
    const [read] = h.send({ type: 'reload' });
    h.send({ type: 'read-success', id: read!.id, response: response(10, [b.repo]) });
    h.send({ type: 'save-success', id: save!.id, response: response(2, [a.repo]) });
    expect(h.state.confirmed).toEqual(response(10, [b.repo]));
    expect(h.state.view).toEqual({ status: 'available', preferences: response(10, [b.repo]) });
  });

  it('ignores an older read failure after a successful mutation and clones caller-owned inputs', () => {
    const h = harness();
    const value = response();
    h.ready(value);
    value.revision = 99;
    const [read] = h.send({ type: 'reload' });
    const project = { ...a };
    const [save] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project } });
    project.repo = 'changed';
    expect(h.state.active?.mutation.project).toEqual(a);
    h.send({ type: 'save-success', id: save!.id, response: response(2, [a.repo]) });
    h.send({ type: 'read-failure', id: read!.id, message: 'Old read failed' });
    expect(h.state.view.status).toBe('available');
    expect(h.state.confirmed?.revision).toBe(2);
  });
});
