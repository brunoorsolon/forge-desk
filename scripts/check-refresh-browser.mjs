/** Actual built application + actual HTTP scope runtime, driven through Chromium CDP. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { navigationFixture } from './navigation-browser-fixture.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'forge-refresh-'));
const evidence = resolve(process.env.BROWSER_EVIDENCE_DIR || join(temporary, 'evidence'));
await mkdir(evidence, { recursive: true });
const chrome = spawn(
  process.env.CHROME_BIN || 'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${temporary}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let launchError;
let chromeErrors = '';
chrome.stderr.on('data', (chunk) => {
  chromeErrors = (chromeErrors + chunk).slice(-4000);
});
chrome.on('exit', (code, signal) => {
  launchError = new Error(`Chromium exited (${code ?? signal}): ${chromeErrors}`);
});
chrome.on('error', (error) => {
  launchError = error;
});
const fixtures = [];
const checks = [];
let socket;
let sequence = 0;
const pending = new Map();
async function until(check, description, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}${chromeErrors ? `; Chromium: ${chromeErrors}` : ''}`);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function advanceBrowserClock(budget) {
  const expired = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error('Virtual time budget did not finish'));
    }, 10000);
    function receive(event) {
      if (JSON.parse(event.data).method !== 'Emulation.virtualTimeBudgetExpired') return;
      clearTimeout(timer);
      socket.removeEventListener('message', receive);
      resolve();
    }
    socket.addEventListener('message', receive);
  });
  await cdp('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget });
  await expired;
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function expect(expression, message) {
  assert.ok(await evaluate(expression), message);
  checks.push(message);
}
let visitNumber = 0;
async function visit(fixture, hash = '') {
  const search = '?browser-case=' + ++visitNumber;
  await cdp('Page.navigate', { url: fixture.origin + '/' + search + hash });
  await until(
    () =>
      evaluate(
        `location.origin === ${JSON.stringify(fixture.origin)} && location.search === ${JSON.stringify(search)}`,
      ),
    'new document committed',
  );
  await until(
    () => evaluate(`Boolean(document.querySelector('.project-sidebar-entry'))`),
    'catalog mounted',
  );
}
async function ready() {
  await until(
    () =>
      evaluate(
        `Boolean(document.querySelector('.scope-heading .scope-repository[data-state="fresh"]'))`,
      ),
    'fresh scope heading',
  );
}
async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(evidence, name + '.png'), Buffer.from(data, 'base64'));
}
async function key(key, code, virtual) {
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: virtual,
    ...(key === 'Enter' ? { text: '\r' } : {}),
  });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual });
}
const snapshotRequests = (fixture) =>
  fixture.requests.filter((r) => /\/api\/(projects|sources)\/.+\/snapshot/.test(r.url));
try {
  let port;
  await until(async () => {
    try {
      port = (await readFile(join(temporary, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      return true;
    } catch {
      return false;
    }
  }, 'Chromium debugging port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = targets.find((target) => target.type === 'page');
  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const response = JSON.parse(event.data);
    const call = pending.get(response.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(response.id);
    if (response.error) call.reject(new Error(JSON.stringify(response.error)));
    else call.resolve(response.result);
  });
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const fixture = await navigationFixture({ sweeps: true });
  fixtures.push(fixture);
  await visit(fixture, '#/project/alpha/demo/one/graph');
  await ready();
  const click = (label) =>
    evaluate(
      `Array.from(document.querySelectorAll('.scope-refresh-controls button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`,
    );
  const launches = (f, suffix = '/refresh') =>
    f.requests.filter((r) => r.method === 'POST' && r.url.endsWith(suffix));
  const sweepReads = (f) =>
    f.requests.filter((r) => r.method === 'GET' && r.url === '/api/refresh');
  const times = () =>
    evaluate(
      `Array.from(document.querySelectorAll('.scope-heading .scope-freshness time')).map(t => t.dateTime)`,
    );
  await expect(
    `Array.from(document.querySelectorAll('.scope-refresh-controls button')).every(b => !b.hidden)`,
    'All three controls appear in a project',
  );
  await shot('project-controls');
  const oldTimes = await times();
  await click('Refresh this project');
  await until(
    async () => JSON.stringify(await times()) !== JSON.stringify(oldTimes),
    'project check time updated',
  );
  assert.equal(launches(fixture)[0].url, '/api/projects/alpha/demo/one/refresh');
  assert.deepEqual(
    fixture.upstream.map((p) => p.repo),
    ['demo/one'],
  );
  checks.push('Project refresh calls only its project and displays its returned check time');
  const beforeSourceRefresh = snapshotRequests(fixture).length;
  const projectTimes = await times();
  await click('Refresh this source');
  await until(
    async () =>
      snapshotRequests(fixture).length > beforeSourceRefresh &&
      JSON.stringify(await times()) !== JSON.stringify(projectTimes),
    'source refresh followed by updated project data',
  );
  await ready();
  assert.equal(launches(fixture)[1].url, '/api/sources/alpha/refresh');
  assert.equal(snapshotRequests(fixture).at(-1).url, '/api/projects/alpha/demo/one/snapshot');
  await expect(
    `location.hash === '#/project/alpha/demo/one/graph' && !document.querySelector('.scope-refresh-controls button').hidden`,
    'Source refresh keeps the project route and project-only refresh control',
  );
  assert.deepEqual(
    fixture.upstream
      .slice(1)
      .map((p) => p.repo)
      .sort(),
    ['demo/one', 'demo/two'],
  );
  checks.push('Source refresh lists the full source, then re-reads and displays the open project');
  await shot('project-after-source-refresh');

  await visit(fixture, '#/source/alpha/graph');
  await ready();
  const sourceTimes = await times();
  const sourceReads = snapshotRequests(fixture).length;
  await click('Refresh this source');
  await until(
    async () => JSON.stringify(await times()) !== JSON.stringify(sourceTimes),
    'All projects source refresh displayed',
  );
  assert.equal(snapshotRequests(fixture).length, sourceReads);
  await expect(
    `location.hash === '#/source/alpha/graph' && document.querySelector('.scope-refresh-controls button').hidden`,
    'All projects keeps its source route and displays the source refresh response directly',
  );
  await shot('source-controls');

  // Manual refresh does not invalidate the fresh cache. A project read must
  // follow the covering source job, rather than launching its own project job.
  await visit(fixture, '#/project/alpha/demo/one/graph');
  await ready();
  const beforeSlowTimes = await times();
  const beforeSlowReads = snapshotRequests(fixture).length;
  const releaseProject = fixture.hold({ source: 'alpha', repo: 'demo/one' }, { invalidate: false });
  await click('Refresh this source');
  await until(
    () => fixture.responses.some((r) => r.method === 'POST' && r.body.job?.state === 'running'),
    'active source job response',
    20000,
  );
  await until(
    () => snapshotRequests(fixture).length >= beforeSlowReads + 2,
    'project re-read and two-second source job follow-up',
    5000,
  );
  assert.ok(
    snapshotRequests(fixture)
      .slice(beforeSlowReads)
      .every((request) => request.url === '/api/projects/alpha/demo/one/snapshot'),
  );
  checks.push(
    'A source refresh exceeding the POST wait keeps polling the open project with periodic checks disabled',
  );
  releaseProject();
  await until(
    async () =>
      (await evaluate(
        `Array.from(document.querySelectorAll('.scope-freshness .scope-repository')).every(r => r.dataset.state === 'fresh')`,
      )) && JSON.stringify(await times()) !== JSON.stringify(beforeSlowTimes),
    'source job completed and refreshed observations displayed in the project',
  );
  await expect(
    `location.hash === '#/project/alpha/demo/one/graph'`,
    'A slow source refresh keeps the project route through completion',
  );
  const settledProjectReads = snapshotRequests(fixture).length;
  await sleep(2200);
  assert.equal(snapshotRequests(fixture).length, settledProjectReads);
  checks.push('Project progress polling stops after the covering source job finishes');

  const releaseSweep = fixture.hold({ source: 'beta', repo: 'demo/three' });
  await click('Refresh all sources');
  await until(
    () => fixture.sweep()?.state === 'running' && sweepReads(fixture).length > 0,
    'sweep launched and read',
  );
  await until(
    () => fixture.sweep().sources[0].projects.every((p) => p.state === 'checked'),
    'first source checked',
  );
  const original = fixture.sweep();
  await until(
    () => evaluate(`Boolean(document.querySelector('.scope-sweep [data-state="checked"]'))`),
    'sweep progress rendered',
  );
  const beforeJoin = launches(fixture).length;
  await click('Refresh all sources');
  await until(() => launches(fixture).length === beforeJoin + 1, 'joined sweep launch');
  await until(
    () =>
      fixture.responses.filter((r) => r.method === 'POST' && r.url === '/api/refresh').length === 2,
    'joined sweep result',
  );
  const joined = fixture.responses
    .filter((r) => r.method === 'POST' && r.url === '/api/refresh')
    .at(-1).body;
  assert.equal(joined.id, original.id);
  assert.equal(joined.startedAt, original.startedAt);
  assert.deepEqual(joined.sources[0].projects, original.sources[0].projects);
  await expect(
    `document.querySelector('.scope-sweep-summary time').dateTime === ${JSON.stringify(original.startedAt)}`,
    'Joined sweep displays the original start time',
  );
  for (const project of joined.sources[0].projects) {
    await expect(
      `Array.from(document.querySelectorAll('.scope-sweep time')).some(t => t.dateTime === ${JSON.stringify(project.lastCheckedAt)})`,
      'Joined sweep preserves a project successful check time',
    );
  }
  await shot('sweep-running-joined');
  const activeReads = sweepReads(fixture).length;
  await sleep(2200);
  assert.ok(sweepReads(fixture).length > activeReads, 'Active sweep must be followed');
  const recent = sweepReads(fixture).slice(-2);
  assert.ok(
    recent[1].at - recent[0].at >= 1900,
    'Sweep polling must not run faster than two seconds',
  );
  checks.push('Running sweep is followed every two seconds through GET /api/refresh');

  const other = await cdp('Target.createTarget', { url: 'about:blank' });
  await cdp('Target.activateTarget', { targetId: other.targetId });
  await until(() => evaluate(`document.visibilityState === 'hidden'`), 'real tab hidden');
  await sleep(100);
  const hiddenReads = sweepReads(fixture).length;
  await sleep(2200);
  assert.equal(sweepReads(fixture).length, hiddenReads);
  releaseSweep();
  await until(() => fixture.sweep().state === 'completed', 'sweep completes while tab hidden');
  await cdp('Target.activateTarget', { targetId: pageTarget.id });
  await cdp('Page.bringToFront');
  await until(
    () =>
      evaluate(
        `document.querySelector('.scope-sweep-summary').textContent.startsWith('Completed')`,
      ),
    'completion shown on tab return',
  );
  await cdp('Target.closeTarget', { targetId: other.targetId });
  const completedReads = sweepReads(fixture).length;
  await sleep(2200);
  assert.equal(sweepReads(fixture).length, completedReads);
  checks.push('Real hidden tab stops sweep polling; return shows completion, then polling stops');
  await shot('sweep-completed');

  const retainedTimes = await times();
  const retainedPlan = await evaluate(`document.querySelector('.summary').textContent`);
  fixture.rejectRefresh();
  await click('Refresh this source');
  await until(
    () =>
      evaluate(
        `document.querySelector('.scope-heading').textContent.includes('Fixture refresh rejected')`,
      ),
    'scope rejection shown',
  );
  assert.deepEqual(await times(), retainedTimes);
  assert.equal(await evaluate(`document.querySelector('.summary').textContent`), retainedPlan);
  await shot('scope-rejected');
  await click('Refresh all sources');
  await until(
    () =>
      evaluate(
        `document.querySelector('.scope-heading').textContent.includes('All sources refresh: Fixture refresh rejected')`,
      ),
    'sweep rejection shown',
  );
  await expect(
    `document.querySelector('.scope-sweep-summary').textContent.startsWith('Completed')`,
    'Rejected sweep retains the completed sweep data',
  );
  assert.deepEqual(await times(), retainedTimes);
  checks.push('Rejected scope and sweep refreshes show errors and keep existing data');
  await shot('sweep-rejected');
  assert.ok(launches(fixture).every((r) => r.launchHeader === '1' && !r.hasCsrf));
  checks.push('Anonymous refreshes carry the required request header, without a session token');

  // A policy-conflict panel does not hide the heading or all-source control.
  // The healthy source must still refresh and its sweep progress must be followed.
  const conflicted = await navigationFixture({ sweeps: true, conflicts: ['alpha'] });
  fixtures.push(conflicted);
  const releaseHealthy = conflicted.hold({ source: 'beta', repo: 'demo/three' });
  await visit(conflicted, '#/project/alpha/demo/one/graph');
  await until(
    () => evaluate(`!document.querySelector('.scope-heading').hidden`),
    'conflicted project heading visible',
  );
  await click('Refresh all sources');
  await until(() => sweepReads(conflicted).length > 0, 'conflicted-scope sweep read');
  const conflictReads = sweepReads(conflicted).length;
  await sleep(2200);
  assert.ok(sweepReads(conflicted).length > conflictReads);
  releaseHealthy();
  await until(
    () =>
      evaluate(`document.querySelector('.scope-sweep-summary')?.textContent.startsWith('Partial')`),
    'conflicted-scope sweep completes',
  );
  await expect(
    `document.querySelector('.scope-sweep').textContent.includes('Policy conflict:') &&
      document.querySelector('.scope-sweep [aria-label="Source beta"] [data-state="checked"]') !== null`,
    'A visible policy-conflict scope still follows the sweep and shows the healthy source completing',
  );
  assert.equal(
    snapshotRequests(conflicted).length,
    0,
    'Blocked scopes must not start snapshot polling',
  );
  await shot('sweep-policy-conflict');

  const authenticated = await navigationFixture({ sweeps: true, login: true });
  fixtures.push(authenticated);
  await cdp('Page.navigate', { url: authenticated.origin + '/login' });
  await until(
    () => evaluate(`Boolean(document.querySelector('input[name="username"]'))`),
    'login form',
  );
  await evaluate(
    `document.querySelector('input[name="username"]').value = 'fixture'; document.querySelector('input[name="password"]').value = 'fixture-only'; document.querySelector('form').requestSubmit()`,
  );
  await until(
    () => evaluate(`Boolean(document.querySelector('.project-sidebar-entry'))`),
    'authenticated app',
  );
  await ready();
  await evaluate(`location.hash = '#/project/alpha/demo/one/graph'`);
  await ready();
  await click('Refresh this project');
  await until(() => launches(authenticated).length === 1, 'authenticated project launch');
  await until(
    () => authenticated.responses.some((r) => r.method === 'POST'),
    'authenticated project success',
  );
  const authenticatedReads = snapshotRequests(authenticated).length;
  await click('Refresh this source');
  await until(
    () => snapshotRequests(authenticated).length > authenticatedReads,
    'authenticated project re-read after source refresh',
  );
  await expect(
    `location.hash === '#/project/alpha/demo/one/graph'`,
    'Authenticated source refresh keeps the open project route',
  );
  await click('Refresh all sources');
  await until(
    () =>
      evaluate(
        `document.querySelector('.scope-sweep-summary')?.textContent.startsWith('Completed')`,
      ),
    'authenticated sweep success',
  );
  assert.equal(launches(authenticated).length, 3);
  assert.ok(launches(authenticated).every((r) => r.launchHeader === '1' && r.hasCsrf));
  assert.ok(authenticated.responses.filter((r) => r.method === 'POST').every((r) => !r.body.error));
  checks.push(
    'All three authenticated controls send session CSRF proof and succeed through real protected routes',
  );
  await shot('authenticated-refresh');

  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        checks,
        requests: fixtures.map((f) => f.requests),
        responses: fixtures.map((f) => f.responses),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, evidence }, null, 2));
} catch (error) {
  console.error('Refresh regression failed:', error);
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify(
      {
        error: String(error),
        checks,
        requests: fixtures.map((f) => f.requests),
        responses: fixtures.map((f) => f.responses),
      },
      null,
      2,
    ),
  );
  if (socket?.readyState === WebSocket.OPEN) {
    console.error(
      await evaluate(`({ hash: location.hash, text: document.body.innerText })`).catch(
        () => 'Browser unavailable',
      ),
    );
    await shot('failure').catch(() => {});
  }
  throw error;
} finally {
  for (const call of pending.values()) clearTimeout(call.timer);
  socket?.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  for (const fixture of fixtures) await fixture.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    (error) => console.warn('Temporary browser profile cleanup:', error.message),
  );
}
