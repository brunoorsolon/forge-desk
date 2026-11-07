import { append, clear, h, icon } from '../dom.js';
import { absoluteTime } from '../format.js';
import type { AppState } from '../state.js';
import type { View, ViewCtx } from './shared.js';

export interface StatesView extends View {
  /** True when the main tabs should be visible (a snapshot with nodes is loaded). */
  showsContent(state: AppState): boolean;
}

/** Loading skeleton, error banner and the empty-view message. */
export function createStates(ctx: ViewCtx): StatesView {
  const banner = h('div', { class: 'banner', role: 'alert', hidden: true });
  const skeleton = h(
    'div',
    { class: 'skeleton', hidden: true, 'aria-busy': 'true', 'aria-label': 'Loading' },
    h(
      'div',
      { class: 'sk-strip' },
      h('div', { class: 'sk sk-chip' }),
      h('div', { class: 'sk sk-chip' }),
      h('div', { class: 'sk sk-chip' }),
    ),
    h(
      'div',
      { class: 'sk-cols' },
      ...[4, 3, 4, 2].map((n) =>
        h(
          'div',
          { class: 'sk-col' },
          h('div', { class: 'sk sk-head' }),
          ...Array.from({ length: n }, () => h('div', { class: 'sk sk-card' })),
        ),
      ),
    ),
  );
  const empty = h(
    'div',
    { class: 'state-center', hidden: true },
    h(
      'div',
      { class: 'box' },
      h('div', { class: 'glyph' }, icon('checkCircle', 20)),
      h('h2', null, 'No open issues in this view'),
      h(
        'p',
        null,
        'Everything in its repositories is closed, or the view’s scope filters exclude it. New issues appear after the next refresh.',
      ),
      h(
        'button',
        { class: 'btn', type: 'button', onclick: () => ctx.actions.refresh() },
        icon('refresh'),
        'Refresh now',
      ),
    ),
  );
  const el = h('div', { class: 'states' }, banner, skeleton, empty);

  function showBanner(title: string, message: string, retry: (() => void) | null): void {
    clear(banner);
    append(banner, [
      icon('alert', 18),
      h('div', { class: 'msg' }, h('strong', null, title), h('span', null, message)),
      retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, 'Retry') : null,
    ]);
    banner.hidden = false;
  }

  function showsContent(state: AppState): boolean {
    return state.snapshot !== null && state.snapshot.plan.nodes.length > 0;
  }

  return {
    el,
    showsContent,
    update(state) {
      const noViews = state.views !== null && state.views.length === 0;
      let shown = false;
      if (state.viewsError !== null) {
        showBanner('Couldn’t load the views', state.viewsError, () => location.reload());
        shown = true;
      } else if (noViews) {
        showBanner(
          'No views configured',
          'Add a view to the server configuration, then reload.',
          null,
        );
        shown = true;
      } else if (state.status === 'error' && state.error !== null) {
        showBanner('Couldn’t load the snapshot', state.error, () => ctx.actions.reload());
        shown = true;
      }
      if (!shown) banner.hidden = true;

      const loading =
        !shown &&
        state.snapshot === null &&
        (state.views === null || state.status === 'loading' || state.status === 'idle');
      skeleton.hidden = !loading;
      empty.hidden = !(state.status === 'ready' && state.snapshot !== null && !showsContent(state));
      el.hidden = banner.hidden && skeleton.hidden && empty.hidden;
    },
  };
}

/** Rendering-only input: startup and scope loaders can supply these outcomes independently. */
export type ScopePanelState =
  | { kind: 'ready' }
  | { kind: 'loading'; message?: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'delayed'; message: string; expectedEnd: string }
  | { kind: 'policy-conflict'; conflict: import('../../../src/core/scope.js').SourcePolicyConflict }
  | { kind: 'not-in-catalog'; source: string; repo?: string }
  | { kind: 'preference-error'; reason: string; message: string }
  | { kind: 'empty-catalog' };

export interface ScopeStatesView {
  el: HTMLElement;
  update(state: ScopePanelState): void;
}

/** Scope-only panels. This view never hides or disables the separate project sidebar. */
export function createScopeStates(options: { chooseProject?: () => void } = {}): ScopeStatesView {
  const el = h('section', { class: 'state-center scope-state', 'aria-live': 'polite' });
  function update(state: ScopePanelState): void {
    clear(el);
    el.hidden = state.kind === 'ready';
    el.setAttribute('aria-busy', String(state.kind === 'loading'));
    if (state.kind === 'ready') return;
    let title: string;
    let message: string;
    const details: HTMLElement[] = [];
    switch (state.kind) {
      case 'loading':
        title = 'Loading project data';
        message = state.message ?? 'Waiting for scope data. This is not an empty project.';
        break;
      case 'unavailable':
        title = 'Project data unavailable';
        message = state.message;
        break;
      case 'delayed':
        title = 'Refresh delayed';
        message = state.message;
        details.push(
          h(
            'p',
            null,
            'Provider cooldown ends at ',
            h('time', { datetime: state.expectedEnd }, absoluteTime(state.expectedEnd)),
            '.',
          ),
        );
        break;
      case 'policy-conflict':
        title = 'Planning policy conflict';
        message = state.conflict.explanation;
        details.push(
          h('p', null, `Source: ${state.conflict.source}`),
          h('p', null, `Differing settings: ${state.conflict.differingSettings.join(', ')}`),
          h('p', null, `Views involved: ${state.conflict.views.join(', ')}`),
          h(
            'p',
            null,
            'Configure a sources[].planning block for this source to resolve the conflict.',
          ),
        );
        break;
      case 'not-in-catalog':
        title = 'Project not in catalog';
        message = `${state.source}${state.repo === undefined ? '' : ` / ${state.repo}`} is not in the configured catalog. Choose another project from the sidebar.`;
        break;
      case 'preference-error':
        title = 'Couldn’t read preferences';
        message = state.message;
        details.push(
          h('p', null, `Reason: ${state.reason}`),
          h('p', null, 'Choose a project manually from the sidebar to continue.'),
        );
        if (options.chooseProject)
          details.push(
            h(
              'button',
              { class: 'btn', type: 'button', onclick: options.chooseProject },
              'Choose a project',
            ),
          );
        break;
      case 'empty-catalog':
        title = 'No projects configured';
        message = 'Add projects to the server configuration, then reload.';
        break;
    }
    el.append(h('div', { class: 'box' }, h('h2', null, title), h('p', null, message), ...details));
  }
  update({ kind: 'loading' });
  return { el, update };
}
