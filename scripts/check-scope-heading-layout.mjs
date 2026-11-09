/** Real-browser regression for the standalone heading; runtime mounting belongs to #192. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'vite';

const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'forge-heading-layout-'));
const chrome = process.env.CHROME_BIN || 'google-chrome';
const source = (path) => JSON.stringify(new URL(`../web/src/${path}`, import.meta.url).pathname);

try {
  const entry = join(temporary, 'probe.js');
  await writeFile(
    entry,
    `
import { createScopeHeading } from ${source('views/scope-heading.ts')};
import { createHeader } from ${source('views/header.ts')};
import { createSummary } from ${source('views/summary.ts')};
import { initialPreferenceState } from ${source('preferenceState.ts')};
import { INITIAL_STATE, Store } from ${source('state.ts')};
import { h } from ${source('dom.ts')};

void (async () => {
const results = [];
const checked = '2026-11-06T12:00:00Z';
const snapshot = {
  viewId: 'all', title: 'All projects', fetchedAt: checked, contentHash: 'probe', priorityLabels: [], orderingMode: 'priority',
  plan: { viewId: 'all', nodes: [], edges: [], order: [], waves: [], cycles: [], unschedulable: [], criticalPath: [], warnings: [], stats: { total: 0, ready: 0, blocked: 0, unschedulable: 0, external: 0, edges: 0, waves: 0 } },
  layout: { width: 0, height: 0, nodes: [], edges: [] },
};
for (const [width, height] of [[1280, 713], [400, 713], [400, 500]]) {
  const frame = h('iframe', { style: 'width:' + width + 'px;height:' + height + 'px;border:0' });
  document.body.append(frame);
  await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body></body></html>'; });
  for (const count of [3, 22, 40]) {
    for (const sweeping of [false, true]) {
      const app = h('div', { id: 'app', style: 'width:' + width + 'px;height:' + height + 'px' });
      frame.contentDocument.body.append(app);
      const repositories = Array.from({ length: count }, (_, i) => ({
        project: { source: 'work', repo: 'owner/project-' + (i + 1) }, state: 'fresh', lastCheckedAt: checked,
        partial: false, delayedUntil: null, error: null,
      }));
      const state = {
        ...INITIAL_STATE, route: { ...INITIAL_STATE.route, scope: { kind: 'source', source: 'work' } },
        status: 'ready', snapshot, views: [{ id: 'all', title: 'All projects' }],
        freshness: { repositories, computedAt: checked, outsideIssues: { count: 0, oldestObservedAt: null, provisionalCount: 0 } },
      };
      const sweep = {
        state: 'running', startedAt: checked, finishedAt: null,
        sources: [{ source: 'work', state: 'running', error: null, delayedUntil: null, policyConflict: null,
          projects: repositories.map(r => ({ project: r.project, state: 'checked', lastCheckedAt: checked, error: null })) }],
      };
      const heading = createScopeHeading({ toggleFavorite() {} });
      heading.update(state, initialPreferenceState(), sweeping ? { sweep, launching: false, error: null } : null);
      const ctx = { store: new Store(state), actions: { select() {}, showInGraph() {}, setTab() {}, openReleases() {}, setView() {}, setQuery() {}, setSort() {}, refresh() {}, reload() {} } };
      const header = createHeader(ctx);
      const summary = createSummary(ctx);
      header.update(state, state);
      summary.update(state, state);
      summary.el.hidden = false;
      const main = h('main', { class: 'main' }, 'Plan');
      const planning = h('div', { class: 'planning' }, header.el, heading.el, summary.el, main);
      app.append(planning);
      // Repository rows sit behind the freshness details; measure them opened.
      heading.el.querySelector('.scope-details').open = true;
      const headingRect = heading.el.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const rows = heading.el.querySelectorAll('.scope-repository');
      // Reach the repository itself, not the later observation text below the list.
      rows[rows.length - 1].scrollIntoView({ block: 'nearest' });
      const lastRect = rows[rows.length - 1].getBoundingClientRect();
      results.push({
        width, height, count, sweeping,
        headingHeight: headingRect.height, planHeight: mainRect.height,
        planWithinApp: mainRect.bottom <= app.getBoundingClientRect().bottom + 1,
        scrollTop: heading.el.scrollTop,
        lastRowReachable: lastRect.top >= headingRect.top && lastRect.bottom <= headingRect.bottom,
      });
      app.remove();
    }
  }
  frame.remove();
}
const output = h('pre', { id: 'results' }, JSON.stringify(results));
document.body.append(output);
})().catch(error => { document.body.append(h('pre', { id: 'probe-error' }, String(error))); });
`,
  );
  const bundle = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      lib: { entry, name: 'HeadingLayoutProbe', formats: ['iife'] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const javascript = output.find((asset) => asset.type === 'chunk').code;
  await writeFile(join(temporary, 'probe.js'), javascript);
  await writeFile(
    join(temporary, 'styles.css'),
    await readFile(new URL('../web/src/styles.css', import.meta.url)),
  );
  const html = join(temporary, 'probe.html');
  await writeFile(
    html,
    '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><script src="probe.js"></script></body></html>',
  );
  const { stdout } = await run(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--user-data-dir=' + join(temporary, 'profile'),
      '--window-size=1280,900',
      '--virtual-time-budget=3000',
      '--dump-dom',
      'file://' + html,
    ],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  const match = stdout.match(/<pre id="results">(.*?)<\/pre>/s);
  assert.ok(match, 'Browser did not finish the layout probe: ' + stdout.slice(-4000));
  const results = JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  assert.equal(results.length, 18);
  for (const result of results) console.log(JSON.stringify(result));
  for (const result of results) {
    const context = JSON.stringify(result);
    assert.ok(result.planHeight > 0, 'Plan disappeared: ' + context);
    assert.ok(result.planWithinApp, 'Plan extended below the application: ' + context);
    assert.ok(result.lastRowReachable, 'Last repository is unreachable: ' + context);
    if (result.count >= 22) assert.ok(result.scrollTop > 0, 'Heading did not scroll: ' + context);
  }
  console.log('Scope heading layout: 18 browser cases passed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
