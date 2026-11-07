/** Built application, isolated browser profiles, real HTTP/session/CSRF and durable preferences. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { preferencesFixture } from './preferences-browser-fixture.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'forge-preferences-'));
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
    `--user-data-dir=${join(temporary, 'chrome')}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let chromeErrors = '';
let launchError;
chrome.stderr.on('data', (chunk) => {
  chromeErrors = (chromeErrors + chunk).slice(-4000);
});
chrome.on('error', (error) => {
  launchError = error;
});
chrome.on('exit', (code, signal) => {
  launchError = new Error(`Chromium exited (${code ?? signal}): ${chromeErrors}`);
});
let socket;
let sequence = 0;
const pending = new Map();
const fixtures = [];
const profiles = [];
const preferenceTraffic = new Map();
const checks = [];
const started = Date.now();
async function until(check, description, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (await check()) return;
    await sleep(30);
  }
  throw new Error(`Timed out: ${description}`);
}
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function profile() {
  // Each context has its own cookies and local/session storage, but shares the server.
  const { browserContextId } = await cdp('Target.createBrowserContext');
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => cdp(method, params, sessionId);
  const inflight = new Set();
  preferenceTraffic.set(sessionId, inflight);
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  let siblingTargetId;
  const page = {
    send,
    evaluate,
    browserContextId,
    targetId,
    inflight,
    async hide() {
      // Isolated contexts own separate windows; focusing another profile is not tab hiding.
      // Activate a genuine sibling tab in this context to emit real visibilitychange events.
      if (!siblingTargetId) {
        const sibling = await cdp('Target.createTarget', {
          url: 'about:blank',
          browserContextId,
          newWindow: false,
        });
        siblingTargetId = sibling.targetId;
      }
      await cdp('Target.activateTarget', { targetId: siblingTargetId });
      await until(() => evaluate('document.hidden'), 'profile tab hidden by sibling');
    },
    async show() {
      await send('Page.bringToFront');
      await until(() => evaluate('!document.hidden'), 'profile tab visible');
    },
    async wait(expression, description) {
      await until(() => evaluate(expression), description);
    },
    async expect(expression, description) {
      assert.ok(await evaluate(expression), description);
      checks.push(description);
    },
    async click(label) {
      await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
    },
    async shot(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(evidence, `${name}.png`), Buffer.from(data, 'base64'));
    },
  };
  profiles.push(page);
  return page;
}
let visits = 0;
async function visit(page, fixture, hash = '') {
  page.fixture = fixture;
  await page.show();
  const search = `?preferences-case=${++visits}`;
  await page.send('Page.navigate', { url: fixture.origin + '/' + search + hash });
  await page.wait(
    `location.origin === ${JSON.stringify(fixture.origin)} && location.search === ${JSON.stringify(search)} && Boolean(document.querySelector('.project-sidebar-entry'))`,
    'application mounted',
  );
}
async function login(page, fixture) {
  page.fixture = fixture;
  await page.show();
  await page.send('Page.navigate', { url: fixture.origin + '/login' });
  await page.wait(
    `location.origin === ${JSON.stringify(fixture.origin)} && location.pathname === '/login' && Boolean(document.querySelector('input[name="username"]'))`,
    'login form',
  );
  await page.evaluate(
    `document.querySelector('[name=username]').value='browser'; document.querySelector('[name=password]').value='disposable-browser-password'; document.querySelector('form').requestSubmit()`,
  );
  await page.wait(
    `Boolean(document.querySelector('.project-sidebar-entry'))`,
    'authenticated application',
  );
}
const favoriteNames = `[...document.querySelectorAll('[aria-label="Favorites"] .project-sidebar-entry')].map(b => b.getAttribute('aria-label'))`;
const writable = `Boolean(document.querySelector('.project-sidebar-star:not([aria-disabled="true"])'))`;
async function favorites(page, names) {
  await until(
    () =>
      JSON.stringify(
        page.fixture.preferences.read().profile.favorites.map((p) => `${p.source} / ${p.repo}`),
      ) === JSON.stringify(names),
    'durable favorite list',
  );
  await page.wait(
    `JSON.stringify(${favoriteNames}) === ${JSON.stringify(JSON.stringify(names.map((name) => `Open ${name}`)))} && ${writable}`,
    'authoritative favorite list',
  );
  await settle(page);
}
const rememberWrites = (fixture) =>
  fixture.requests.filter(
    (r) => r.method === 'PUT' && r.url === '/api/preferences/remembered-project',
  ).length;
const reads = (fixture) =>
  fixture.requests.filter((r) => r.method === 'GET' && r.url === '/api/preferences').length;
async function settle(page) {
  await until(() => page.inflight.size === 0, 'preference HTTP responses completed');
  await page.wait(writable, 'preferences writable');
  // Let fetch completion continuations render before inspecting stable state.
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve()))');
}
async function fixture(name, options) {
  const value = await preferencesFixture(join(temporary, name), options);
  fixtures.push(value);
  return value;
}
try {
  let browserPath;
  let port;
  await until(async () => {
    try {
      [port, browserPath] = (
        await readFile(join(temporary, 'chrome', 'DevToolsActivePort'), 'utf8')
      )
        .trim()
        .split('\n');
      return true;
    } catch {
      return false;
    }
  }, 'Chromium debugging port');
  socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const response = JSON.parse(event.data);
    const traffic = preferenceTraffic.get(response.sessionId);
    if (
      traffic &&
      response.method === 'Network.requestWillBeSent' &&
      new URL(response.params.request.url).pathname.startsWith('/api/preferences')
    ) {
      traffic.add(response.params.requestId);
    }
    if (traffic && ['Network.loadingFinished', 'Network.loadingFailed'].includes(response.method)) {
      traffic.delete(response.params.requestId);
    }
    const call = pending.get(response.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(response.id);
    if (response.error) call.reject(new Error(JSON.stringify(response.error)));
    else call.resolve(response.result);
  });
  const shared = await fixture('shared');
  const a = await profile();
  const b = await profile();
  await login(a, shared);
  await settle(a);
  await a.click('Add alpha / demo/one to favorites');
  await favorites(a, ['alpha / demo/one']);
  await a.click('Add alpha / demo/two to favorites');
  await favorites(a, ['alpha / demo/one', 'alpha / demo/two']);
  await a.click('Remove alpha / demo/one from favorites');
  await favorites(a, ['alpha / demo/two']);
  await a.click('Add alpha / demo/one to favorites');
  await favorites(a, ['alpha / demo/two', 'alpha / demo/one']);
  checks.push(
    'Add/remove/re-add persists insertion order through real session and CSRF HTTP mutations',
  );
  assert.equal(rememberWrites(shared), 0, 'Favorite changes do not remember a project');
  await login(b, shared);
  await favorites(b, ['alpha / demo/two', 'alpha / demo/one']);
  await b.expect(
    `location.hash === '#/project/alpha/demo/two/graph'`,
    'Second isolated profile starts at first favorite',
  );
  assert.equal(rememberWrites(shared), 0, 'Favorite startup fallback does not remember');
  await b.shot('second-profile-favorite-fallback');

  await b.hide();
  await a.show();
  await a.click('Add beta / demo/three to favorites');
  await favorites(a, ['alpha / demo/two', 'alpha / demo/one', 'beta / demo/three']);
  const beforeReturn = reads(shared);
  await b.show();
  await favorites(b, ['alpha / demo/two', 'alpha / demo/one', 'beta / demo/three']);
  assert.ok(reads(shared) > beforeReturn, 'Tab return rereads shared preferences');
  checks.push('Tab return synchronizes ordered favorites across isolated profiles');
  const openDestination = await a.evaluate('location.hash');
  await a.hide();
  await b.show();
  await b.click('Open beta / demo/three');
  await until(
    () => shared.preferences.read().profile.rememberedProject?.repo === 'demo/three',
    'explicit project remembered',
  );
  const beforeRemoteReturn = reads(shared);
  await a.show();
  await until(() => reads(shared) > beforeRemoteReturn, 'remote remembered-project reread');
  await settle(a);
  await a.expect(
    `location.hash === ${JSON.stringify(openDestination)}`,
    'A remote remembered-project change never moves an already open page',
  );
  await visit(a, shared);
  await a.wait(
    `location.hash === '#/project/beta/demo/three/graph' && ${writable}`,
    'remembered startup resolved',
  );
  await a.expect(
    `location.hash === '#/project/beta/demo/three/graph'`,
    'Bare startup resumes the remembered project across profiles',
  );
  await settle(a);
  let before = rememberWrites(shared);
  await a.evaluate(`location.hash='#/project/beta/demo/three/order?q=Browser&sort=updated'`);
  await a.wait(`Boolean(document.querySelector('.order .row'))`, 'tab and query change');
  await a.click('All projects from alpha');
  await a.wait(`location.hash.startsWith('#/source/alpha/')`, 'source navigation');
  await a.click('Views');
  await a.wait(`location.hash.startsWith('#/view/')`, 'view navigation');
  await settle(a);
  assert.equal(
    rememberWrites(shared),
    before,
    'Tab/query/source/view navigation and reads must not remember',
  );
  checks.push('Source/view navigation, tab/query changes and passive reads do not remember');
  await visit(a, shared, '#/project/alpha/demo/one/graph');
  await until(
    () => shared.preferences.read().profile.rememberedProject?.repo === 'demo/one',
    'explicit hash remembered',
  );
  await settle(a);
  checks.push('An explicit project deep link is remembered');

  shared.failNext('reject');
  await a.click('Remove alpha / demo/one from favorites');
  await a.wait(
    `Boolean(document.querySelector('.preference-error')?.textContent.includes('saved'))`,
    'save failure feedback',
  );
  await favorites(a, ['alpha / demo/two', 'alpha / demo/one', 'beta / demo/three']);
  checks.push('Failed favorite save restores confirmed order and shows an error');
  await a.shot('favorite-save-failure');
  const beforeTruncatedRead = reads(shared);
  shared.failNext('truncated');
  await a.click('Remove alpha / demo/one from favorites');
  await until(() => reads(shared) > beforeTruncatedRead, 'truncated-response reconciliation GET');
  await favorites(a, ['alpha / demo/two', 'beta / demo/three']);
  await a.expect(
    `Boolean(document.querySelector('.preference-error')?.textContent)`,
    'Truncated save-response error is visible after reconciliation',
  );
  assert.deepEqual(
    shared.preferences.read().profile.favorites.map((p) => p.repo),
    ['demo/two', 'demo/three'],
  );
  checks.push('Truncated save response reconciles the committed disk state by a fresh GET');
  await a.shot('truncated-response-recovered');
  shared.failNext('reject');
  await a.click('Open alpha / demo/two');
  await a.wait(
    `location.hash === '#/project/alpha/demo/two/graph' && Boolean(document.querySelector('.preference-notice')?.textContent.includes('saved'))`,
    'nonblocking remember error',
  );
  await settle(a);
  assert.equal(shared.preferences.read().profile.rememberedProject.repo, 'demo/one');
  checks.push('Failed remember keeps navigation usable without changing the stored selection');
  await a.shot('remember-failure');

  // Revoke the real session behind the still-open app, then trigger its normal tab-return read.
  const mutationsBeforeExpiry = shared.requests.filter(
    (r) => r.url.startsWith('/api/preferences/') && r.method !== 'GET',
  ).length;
  await a.evaluate(`fetch('/logout', {method:'POST'}).then(r => r.text())`);
  await a.hide();
  await a.show();
  await a.wait(`${favoriteNames}.length === 0`, 'expired session clears personal UI');
  checks.push('Session expiry clears personal favorites on the first unauthorized read');
  await a.wait(
    `location.pathname === '/login' && Boolean(document.querySelector('input[name="username"]'))`,
    'expired session requires login',
  );
  // Retrying the protected page must stay behind the real login gate, never replay a save.
  await a.send('Page.navigate', { url: shared.origin + '/?expired-retry=1' });
  await a.wait(
    `location.pathname === '/login' && Boolean(document.querySelector('input[name="username"]'))`,
    'protected-page retry still requires login',
  );
  assert.equal(
    shared.requests.filter((r) => r.url.startsWith('/api/preferences/') && r.method !== 'GET')
      .length,
    mutationsBeforeExpiry,
    'Expired sessions never replay protected mutations',
  );
  checks.push('Retry after session expiry requires login and does not replay preference mutations');
  await a.shot('session-expired');
  await login(b, shared);
  await favorites(b, ['alpha / demo/two', 'beta / demo/three']);
  await b.click('Theme');
  await b.wait(`Boolean(document.querySelector('form[action="logout"]'))`, 'logout menu');
  await b.evaluate(
    `document.addEventListener('submit', event => event.preventDefault(), {once:true}); document.querySelector('form[action="logout"]').requestSubmit()`,
  );
  await b.expect(
    `${favoriteNames}.length === 0 && !(${writable})`,
    'Logout clears personal UI synchronously before the HTTP response',
  );
  await b.evaluate(`document.querySelector('form[action="logout"]').submit()`);
  await b.wait(
    `Boolean(document.querySelector('input[name="username"]')) && ${favoriteNames}.length === 0`,
    'logout removes personal UI',
  );
  checks.push('Explicit logout leaves no personal favorites visible');

  const transient = await fixture('transient-read');
  transient.failNext('read');
  await login(a, transient);
  await a.wait(
    `Boolean(document.querySelector('.preference-retry:not([hidden])'))`,
    'bare preference read failure offers retry',
  );
  await a.expect(
    `['', '#/'].includes(location.hash) && !(${writable})`,
    'Failed bare preference read does not silently choose a destination',
  );
  await a.shot('bare-read-failure');
  await a.evaluate(`document.querySelector('.preference-retry').click()`);
  await a.wait(
    `location.hash === '#/source/alpha/graph' && ${writable}`,
    'bare retry resolves after recovered preference read',
  );
  assert.equal(rememberWrites(transient), 0, 'Retry fallback does not remember');
  checks.push('Bare preference-error retry rereads and resolves startup after recovery');
  await a.shot('bare-read-recovered');

  for (const [name, options, fragment] of [
    ['login-disabled', { login: false }, 'require the application login'],
    ['storage-not-configured', { storage: false }, 'storage is not configured'],
    ['unreadable', { unreadable: true }, 'cannot be safely read'],
  ]) {
    const target = await fixture(name, options);
    if (target.login) await login(a, target);
    else await visit(a, target);
    await a.wait(
      `document.body.innerText.includes(${JSON.stringify(fragment)})`,
      `${name} explanation`,
    );
    await a.expect(`!(${writable})`, `${name} keeps personal controls unavailable`);
    if (name === 'unreadable')
      await a.expect(
        `!location.hash.startsWith('#/source/') && !location.hash.startsWith('#/project/')`,
        'Configured unreadable storage blocks silent bare fallback',
      );
    else
      await a.expect(`location.hash === '#/source/alpha/graph'`, `${name} permits source fallback`);
    await a.shot(name);
  }
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      { checks, elapsedMs: Date.now() - started, requests: fixtures.map((f) => f.requests) },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, evidence, elapsedMs: Date.now() - started }, null, 2));
} catch (error) {
  console.error('Preferences browser regression failed:', error);
  const pages = [];
  for (const [index, page] of profiles.entries()) {
    pages.push(
      await page
        .evaluate(`({hash:location.hash,text:document.body.innerText})`)
        .catch(() => 'unavailable'),
    );
    await page.shot(`failure-${index}`).catch(() => {});
  }
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify(
      { error: String(error), checks, pages, requests: fixtures.map((f) => f.requests) },
      null,
      2,
    ),
  );
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
    (error) => console.warn('Temporary profile cleanup:', error.message),
  );
}
