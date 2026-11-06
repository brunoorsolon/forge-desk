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

  it('leaves unsent actions waiting through failed save and reread, without replaying the failed action', () => {
    const h = harness();
    h.ready();
    const [save] = h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: a } });
    h.send({ type: 'mutate', mutation: { kind: 'add-favorite', project: b } });
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
    expect(effects).toMatchObject([
      { kind: 'save', mutation: { kind: 'add-favorite', project: b } },
    ]);
  });

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
    expect(h.state.queue).toHaveLength(1);
    expect(h.send({ type: 'save-success', id: save!.id, response: response(2) })).toEqual([]);
    expect(h.state.view.status).toBe('unavailable');
    const [reload] = h.send({ type: 'reload' });
    h.send({ type: 'read-success', id: reload!.id, response: response(3) });
    expect(h.state.view.status).toBe('unavailable');
    const [recover] = h.send({ type: 'reload' });
    expect(h.send({ type: 'read-success', id: recover!.id, response: response(11) })).toMatchObject(
      [{ kind: 'save', mutation: { kind: 'add-favorite', project: b } }],
    );
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
