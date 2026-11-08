/** Actual built application + actual HTTP scope runtime, driven through Chromium CDP. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { navigationFixture } from './navigation-browser-fixture.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'forge-navigation-'));
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
let clockControlled = false;
async function advanceBrowserClock(budget) {
  clockControlled = true;
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
  // A spent virtual-time budget pauses navigation tasks too, not only app timers.
  if (clockControlled) await advanceBrowserClock(1000);
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
  const fixture = await navigationFixture();
  fixtures.push(fixture);
  await visit(fixture);
  await ready();
  await expect(
    `location.hash === '#/source/alpha/graph'`,
    'Bare startup selects first nonempty source',
  );
  await expect(
    `document.querySelectorAll('.project-sidebar-section[aria-label^="Source"]').length === 2`,
    'Two source catalog mounted',
  );
  assert.ok(fixture.requests.some((r) => r.url === '/api/projects'));
  assert.ok(snapshotRequests(fixture).every((r) => r.url === '/api/sources/alpha/snapshot'));
  await shot('desktop-source');
  await expect(
    `document.querySelector('[aria-label="View"]').getClientRects().length === 0 && [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === 'Refresh').every(button => button.getClientRects().length === 0)`,
    'Named-view selector and Refresh are hidden in scope mode',
  );
  await evaluate(
    `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Export').click()`,
  );
  await expect(
    `Boolean(document.querySelector('a[href="api/sources/alpha/export.json"]'))`,
    'Source export menu uses scope route',
  );
  await key('Escape', 'Escape', 27);

  await visit(fixture, '#/project/alpha/demo/one/order?q=Browser&sort=updated');
  await ready();
  await until(() => evaluate(`Boolean(document.querySelector('.order .row'))`), 'order row');
  await evaluate(`document.querySelector('.order .row').click()`);
  await expect(
    `Boolean(document.querySelector('.panel.open')?.textContent.includes('demo/one#1'))`,
    'Issue detail opens',
  );
  const beforeCurrent = snapshotRequests(fixture).length;
  await evaluate(`document.querySelector('[aria-label="Open alpha / demo/one"]').click()`);
  await sleep(200);
  assert.equal(snapshotRequests(fixture).length, beforeCurrent, 'Current scope must not reload');
  await expect(
    `location.hash.includes('q=Browser') && Boolean(document.querySelector('.panel.open')?.textContent.includes('demo/one#1'))`,
    'Current scope preserves filter and details',
  );
  await evaluate(`document.querySelector('[aria-label="Open beta / demo/three"]').focus()`);
  await key('Enter', 'Enter', 13);
  await until(
    () => evaluate(`location.hash === '#/project/beta/demo/three/order?sort=updated'`),
    'keyboard scope selection',
  );
  await ready();
  await expect(
    `document.querySelector('.filter-input').value === '' && !document.querySelector('.panel.open')`,
    'Switch preserves tab/sort and clears filter/details',
  );
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 400,
    height: 713,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`document.querySelector('.project-sidebar-toggle').focus()`);
  await key('Enter', 'Enter', 13);
  await expect(
    `document.querySelector('.project-sidebar-toggle').getAttribute('aria-expanded') === 'true'`,
    'Narrow disclosure opens with keyboard',
  );
  await shot('narrow-sidebar');
  await key('Escape', 'Escape', 27);
  await expect(
    `document.querySelector('.project-sidebar-toggle').getAttribute('aria-expanded') === 'false' && document.activeElement.matches('.project-sidebar-toggle')`,
    'Escape closes disclosure and restores focus',
  );
  await shot('narrow-project');
  await key('Enter', 'Enter', 13);
  await evaluate(`document.querySelector('[aria-label="Open alpha / demo/two"]').focus()`);
  await key('Enter', 'Enter', 13);
  await until(
    () => evaluate(`location.hash.includes('/project/alpha/demo/two/order')`),
    'narrow project choice',
  );
  await ready();
  await expect(
    `document.querySelector('.project-sidebar-toggle').getAttribute('aria-expanded') === 'false' && document.activeElement.matches('.project-sidebar-toggle')`,
    'Narrow selection closes sidebar and restores disclosure focus',
  );
  await key('Enter', 'Enter', 13);
  await expect(
    `document.querySelector('.project-sidebar-toggle').getAttribute('aria-expanded') === 'true'`,
    'Narrow sidebar can be reopened after navigation',
  );
  await key('Escape', 'Escape', 27);
  await evaluate('history.back()');
  await until(
    () => evaluate(`location.hash.includes('/project/beta/demo/three/order')`),
    'history back',
  );
  await ready();
  await evaluate('history.forward()');
  await until(
    () => evaluate(`location.hash.includes('/project/alpha/demo/two/order')`),
    'history forward',
  );
  await ready();
  checks.push('Back and Forward restore scope and tab');
  await evaluate(
    `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Export').click()`,
  );
  await expect(
    `Boolean(document.querySelector('a[href="api/projects/alpha/demo/two/export.json"]'))`,
    'Project export menu uses scope route',
  );
  await key('Escape', 'Escape', 27);

  const noTimer = snapshotRequests(fixture).length;
  await sleep(2300);
  assert.equal(
    snapshotRequests(fixture).length,
    noTimer,
    'refreshMinutes=0 must not schedule scope checks',
  );
  checks.push('refreshMinutes=0 disables periodic checks');
  const release = fixture.hold({ source: 'alpha', repo: 'demo/one' });
  await visit(fixture, '#/project/alpha/demo/one/graph');
  await until(
    () =>
      evaluate(
        `document.querySelector('.scope-heading')?.textContent.toLowerCase().includes('updating')`,
      ),
    'active job freshness',
  );
  await shot('job-updating');
  await cdp('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  const pollStart = snapshotRequests(fixture).length;
  await advanceBrowserClock(59_000);
  assert.equal(snapshotRequests(fixture).length, pollStart, 'No job follow-up before a minute');
  await advanceBrowserClock(2_000);
  await until(() => snapshotRequests(fixture).length === pollStart + 1, 'first minute follow-up');
  await advanceBrowserClock(60_000);
  await until(() => snapshotRequests(fixture).length === pollStart + 2, 'second minute follow-up');
  checks.push('Active job follows up every 60 seconds (Chromium virtual time)');
  // Activate another real tab, rather than overriding document.visibilityState.
  const background = await cdp('Target.createTarget', { url: 'about:blank' });
  await cdp('Target.activateTarget', { targetId: background.targetId });
  await until(() => evaluate(`document.visibilityState === 'hidden'`), 'browser tab hidden');
  checks.push('Another real tab makes the application hidden');
  await sleep(200);
  const hiddenCount = snapshotRequests(fixture).length;
  await advanceBrowserClock(120_000);
  assert.equal(snapshotRequests(fixture).length, hiddenCount, 'Hidden tab must not poll');
  release();
  await cdp('Target.activateTarget', { targetId: pageTarget.id });
  await cdp('Page.bringToFront');
  await until(() => snapshotRequests(fixture).length > hiddenCount, 'return freshness request');
  await ready();
  await cdp('Target.closeTarget', { targetId: background.targetId });
  await advanceBrowserClock(120_000);
  assert.equal(
    snapshotRequests(fixture).length,
    hiddenCount + 1,
    'Return should check once and completed jobs stop polling',
  );
  assert.ok(
    fixture.upstream.every((r) => r.source === 'alpha' && r.repo === 'demo/one'),
    'Unopened projects must never be polled upstream',
  );
  checks.push('Hidden pause, one return check, completed job stop, unopened projects untouched');
  await visit(fixture, '#/project/alpha/demo/missing/graph');
  await until(
    () => evaluate(`document.body.innerText.includes('Project not in catalog')`),
    'missing project state',
  );
  await shot('missing-project');
  await visit(fixture, '#/view/alpha-view/order');
  await until(
    () => evaluate(`Boolean(document.querySelector('.order .row'))`),
    'legacy named view',
  );
  await expect(`location.hash === '#/view/alpha-view/order'`, 'Named view deep link preserved');
  await expect(
    `document.querySelector('[aria-label="View"]').getClientRects().length > 0 && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Refresh' && button.getClientRects().length > 0)`,
    'Legacy view selector and Refresh remain visible',
  );

  assert.ok(fixture.requests.some((r) => r.url === '/api/views/alpha-view/snapshot'));
  await visit(fixture, '#/releases');
  await until(
    () =>
      evaluate(
        `document.querySelector('.planning-shell')?.hidden === false && document.querySelector('.project-sidebar')?.hidden === false && document.querySelector('.releases')?.hidden === false && document.querySelector('.main')?.hidden === true && document.querySelector('#tab-releases')?.getAttribute('aria-selected') === 'true'`,
      ),
    'release tab mounted with sidebar visible and planning panes hidden',
  );
  await expect(`location.hash === '#/releases'`, 'Release deep link preserved');
  const viewRequestsBefore = fixture.requests.filter(
    (r) => r.url === '/api/views/alpha-view/snapshot',
  ).length;
  await evaluate(`document.querySelector('#tab-problems').click()`);
  await until(
    () =>
      evaluate(
        `location.hash === '#/view/alpha-view/problems' && document.querySelector('.project-sidebar')?.hidden === false && document.querySelector('.releases')?.hidden === true && document.querySelector('.main')?.hidden === false && document.querySelector('#tab-problems')?.getAttribute('aria-selected') === 'true' && document.querySelector('.problems-pane')?.textContent.includes('No problems found')`,
      ),
    'leaving direct Releases through a planning tab renders the view and hides releases',
  );
  assert.ok(
    fixture.requests.filter((r) => r.url === '/api/views/alpha-view/snapshot').length >
      viewRequestsBefore,
    'Leaving direct Releases through a planning tab must request the view snapshot',
  );
  checks.push('Leaving direct Releases through a planning tab requests snapshot and shows main');
  const conflict = await navigationFixture({ conflicts: ['alpha'] });
  fixtures.push(conflict);
  await visit(conflict);
  await until(
    () => evaluate(`document.body.innerText.includes('Planning policy conflict')`),
    'startup policy conflict',
  );
  await expect(
    `location.hash === '#/source/alpha/graph'`,
    'Startup keeps first configured source and exposes its conflict',
  );
  await visit(conflict, '#/source/alpha/graph');
  await until(
    () => evaluate(`document.body.innerText.includes('Planning policy conflict')`),
    'direct policy conflict',
  );
  await shot('policy-conflict');
  const allConflict = await navigationFixture({ conflicts: ['alpha', 'beta'] });
  fixtures.push(allConflict);
  await visit(allConflict);
  await until(
    () => evaluate(`document.body.innerText.includes('Planning policy conflict')`),
    'no usable source state',
  );
  checks.push('Startup and direct conflict branches remain explicit');
  const unavailable = await navigationFixture({ seed: false });
  fixtures.push(unavailable);
  unavailable.fail({ source: 'alpha', repo: 'demo/one' });
  await visit(unavailable, '#/project/alpha/demo/one/graph');
  await until(
    () => evaluate(`document.body.innerText.includes('Project data unavailable')`),
    'unavailable state',
  );
  await expect(
    `!document.body.innerText.includes('No open issues')`,
    'Unavailable data is not presented as empty',
  );
  await shot('unavailable');
  const stale = await navigationFixture();
  fixtures.push(stale);
  stale.fail({ source: 'alpha', repo: 'demo/one' });
  await visit(stale, '#/project/alpha/demo/one/order');
  await advanceBrowserClock(60_000);
  await until(
    () =>
      evaluate(
        `document.querySelector('.scope-heading')?.textContent.includes('Stale (refresh failed)')`,
      ),
    'last-good stale state',
  );
  await expect(
    `Boolean(document.querySelector('.order .row')) && document.querySelector('.scope-heading').textContent.includes('Fixture upstream unavailable')`,
    'Failed refresh retains last-good plan with explicit error',
  );
  await shot('stale-last-good');
  const delayed = await navigationFixture();
  fixtures.push(delayed);
  delayed.cooldown({ source: 'alpha', repo: 'demo/one' });
  await visit(delayed, '#/project/alpha/demo/one/graph');
  await until(
    () => evaluate(`document.querySelector('.scope-heading')?.textContent.includes('Delayed')`),
    'provider cooldown',
  );
  await expect(
    `document.querySelector('.scope-heading').textContent.includes('Expected to resume')`,
    'Cooldown exposes expected resume time',
  );
  await shot('delayed');
  const periodic = await navigationFixture({ refreshMinutes: 1 });
  fixtures.push(periodic);
  await visit(periodic, '#/project/beta/demo/three/graph');
  await ready();
  const beforePeriodic = snapshotRequests(periodic).length;
  // Chromium's virtual clock advances the actual application timer, without replacing timers.
  await advanceBrowserClock(61000);
  await until(
    () => snapshotRequests(periodic).length > beforePeriodic,
    'one-minute visible scope check',
  );
  assert.ok(
    snapshotRequests(periodic).every((r) => r.url === '/api/projects/beta/demo/three/snapshot'),
    'Periodic checks must stay on the open project',
  );
  checks.push('Configured one-minute timer rechecks only the open scope (Chromium virtual time)');
  const periodicOther = await cdp('Target.createTarget', { url: 'about:blank' });
  await cdp('Target.activateTarget', { targetId: periodicOther.targetId });
  await until(() => evaluate(`document.visibilityState === 'hidden'`), 'periodic tab hidden');
  const beforeHiddenPeriodic = snapshotRequests(periodic).length;
  await advanceBrowserClock(61000);
  assert.equal(
    snapshotRequests(periodic).length,
    beforeHiddenPeriodic,
    'Hidden tab must suppress the configured minute timer',
  );
  await cdp('Target.activateTarget', { targetId: pageTarget.id });
  await cdp('Page.bringToFront');
  await until(
    () => snapshotRequests(periodic).length === beforeHiddenPeriodic + 1,
    'periodic return freshness check',
  );
  await cdp('Target.closeTarget', { targetId: periodicOther.targetId });
  checks.push('Configured minute timer pauses while hidden and rechecks once on return');

  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify({ checks, requests: fixtures.map((f) => f.requests) }, null, 2),
  );
  console.log(JSON.stringify({ checks, evidence }, null, 2));
} catch (error) {
  console.error('Navigation regression failed:', error);
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify(
      { error: String(error), checks, requests: fixtures.map((f) => f.requests) },
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
