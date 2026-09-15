/**
 * Root & Fruit — Ballot Builder availability panel test.
 *
 * The panel's only job right now is to tell a visitor when to come back, so the
 * thing worth pinning is that the date shown is the one the BACKEND enforces,
 * not a date hardcoded in the page. Those drifting apart is the failure that
 * matters: the gate refuses on one date while the page promises another.
 *
 * Also covers the offline path — with no backend reachable the panel must settle
 * on readable copy rather than sitting forever on "Checking availability…".
 *
 * Run locally:
 *   cd frontend && npm ci
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   node test/ballotPanel.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const PORT = process.env.BALLOT_PANEL_PORT || '8103';
const BASE = `http://localhost:${PORT}`;
const DUMMY_BACKEND = 'http://backend.invalid';

/** Abort with a message. @param {string} m @returns {never} */
function fail(m) { throw new Error(m); }

/** Assert a condition. @param {boolean} ok @param {string} m @returns {void} */
function check(ok, m) { if (!ok) fail(m); else console.log(`✓ ${m}`); }

/** Poll until the dev server answers. @param {number} timeoutMs @returns {Promise<void>} */
async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE, { redirect: 'manual' })).ok) return; } catch { /* not up */ }
    await sleep(300);
  }
  fail(`server did not start on ${BASE} within ${timeoutMs}ms`);
}

let server, browser;
try {
  server = spawn('node', ['server.js'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT, BACKEND_URL: DUMMY_BACKEND, NODE_ENV: 'test' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForServer();

  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try { sessionStorage.setItem('rfRegistered', 'true'); } catch { /* ignore */ }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // ── closed: the panel repeats the backend's date verbatim ──
  let served = {
    open: false,
    availableFrom: '2026-10-08T05:00:00.000Z',
    message: 'The Ballot Builder opens October 8. Candidate filing closes first — until then there is no ballot to build.',
  };
  let requested = 0;
  await page.route('**/api/ballot/availability', async (route) => {
    requested += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(served),
    });
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function', { timeout: 5000 });
  await page.evaluate(() => {
    window.showToast = () => {};
    document.getElementById('splashOverlay')?.classList.add('hidden');
    window.showView('ballot');
  });
  await page.waitForFunction(
    () => !/Checking availability/.test(document.getElementById('ballotAvailability').textContent),
    { timeout: 8000 },
  );

  const closedText = await page.evaluate(() => document.getElementById('ballotAvailability').textContent.trim());
  check(requested === 1, 'opening the tab asks the backend when it opens');
  check(closedText === served.message, 'the panel shows the backend message verbatim, not its own date');
  check(/October 8/.test(closedText), 'the visitor is told the date');

  const visible = await page.evaluate(() => {
    const v = document.getElementById('view-ballot');
    return v && getComputedStyle(v).display !== 'none';
  });
  check(visible === true, 'the Ballot Builder view is the active view');

  // ── open: same panel, different message, still from the backend ──
  served = { open: true, availableFrom: served.availableFrom, message: 'The Ballot Builder is open.' };
  await page.evaluate(() => window.loadBallotAvailability());
  await page.waitForFunction(
    () => document.getElementById('ballotAvailability').textContent.includes('is open'),
    { timeout: 8000 },
  );
  check(true, 'when the backend says open, the panel says open');

  // ── offline: never strand the visitor on a spinner ──
  await page.unroute('**/api/ballot/availability');
  await page.route('**/api/ballot/availability', (route) => route.abort());
  await page.evaluate(() => {
    document.getElementById('ballotAvailability').textContent = 'Checking availability…';
    return window.loadBallotAvailability();
  });
  const offlineText = await page.evaluate(() => document.getElementById('ballotAvailability').textContent.trim());
  check(!/Checking availability/.test(offlineText), 'an unreachable backend still resolves the panel');
  check(/coming soon/i.test(offlineText), 'and falls back to readable copy');

  if (pageErrors.length) fail(`uncaught page errors:\n  - ${pageErrors.join('\n  - ')}`);
  console.log('✓ ballot availability panel passed');
} catch (err) {
  console.error(`✗ ${err.message || err}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}
