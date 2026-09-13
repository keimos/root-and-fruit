/**
 * Root & Fruit — shared-audit-cache UI test.
 *
 * The backend serves a previously-run audit of the same subject from a global
 * cache and does not charge a credit for it. That is only acceptable if the
 * page is honest about it, so this drives the real Auto-Analyze flow against a
 * stubbed /api/analyze and checks the two halves of that contract:
 *   - a cached response (`cached: true`) surfaces the notice with the audit's
 *     date, instead of passing a weeks-old report off as a fresh one
 *   - "Run a fresh audit" re-requests with `refresh: true` (the flag that makes
 *     the backend bypass the cache and bill for a new call) and, when the
 *     answer is uncached, the notice goes away
 *
 * No backend and no Anthropic key are needed — /api/analyze and /api/search are
 * intercepted in the browser.
 *
 * Run locally:
 *   cd frontend && npm ci
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   node test/auditCache.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const PORT = process.env.CACHE_UI_PORT || '8102';
const BASE = `http://localhost:${PORT}`;
const DUMMY_BACKEND = 'http://backend.invalid';

/** Abort the run with a message. @param {string} m  @returns {never} */
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

// A schema-valid audit, matching what the backend's validator accepts.
const AUDIT = {
  historicalBackground: 'Background paragraph.',
  subjectPathway: 'elected',
  supporters: ['A'], opponents: ['B'], funders: ['C'],
  root: Array.from({ length: 5 }, () => ({ met: true, reasoning: 'r' })),
  branches: Array.from({ length: 6 }, () => ({ met: false, reasoning: 'r' })),
  fruit: Array.from({ length: 5 }, () => ({ score: 2, reasoning: 'r' })),
  visibility: { score: 7, reasoning: 'r' },
  toxic: Array.from({ length: 3 }, () => ({ present: false, reasoning: 'r' })),
  evidenceQuality: 80, summary: 'Summary.', sources: [],
};

const CACHED_AT = new Date(Date.now() - 10 * 86400000).toISOString();

/**
 * Build the Anthropic-shaped message the backend returns.
 * @param {boolean} cached  whether to mark it as served from the cache
 * @returns {object}  the message body
 */
function message(cached) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-7',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(AUDIT) }],
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(cached ? { cached: true, cachedAt: CACHED_AT } : {}),
  };
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

  // Every /api/analyze body the page sent, so the refresh flag can be asserted.
  const requests = [];
  let serveCached = true;
  await page.route('**/api/analyze', async (route) => {
    requests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(message(serveCached)),
    });
  });
  // Electability fires automatically for candidates; answer it so the run has
  // no stray network failure of its own.
  await page.route('**/api/search', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ content: [{ type: 'text', text: '{}' }] }),
  }));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.autoAnalyze === 'function', { timeout: 5000 });
  await page.evaluate(() => {
    window.showToast = () => {};
    document.getElementById('splashOverlay')?.classList.add('hidden');
    document.getElementById('nameInput').value = 'Ada Test';
  });

  // ── a cached audit announces itself ──────────────────
  await page.evaluate(() => window.autoAnalyze(), { timeout: 30000 });
  const cachedState = await page.evaluate(() => ({
    visible: getComputedStyle(document.getElementById('cacheNotice')).display !== 'none',
    date: document.getElementById('cacheNoticeDate').textContent,
    scored: document.getElementById('resultsName').textContent,
  }));
  const expectedDate = new Date(CACHED_AT).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  check(requests.length === 1, 'Auto-Analyze called /api/analyze');
  check(requests[0].refresh === undefined, 'a normal audit does not ask to bypass the cache');
  check(cachedState.visible === true, 'a cached audit shows the notice');
  check(cachedState.date === expectedDate, `the notice carries the audit date (${expectedDate})`);
  check(cachedState.scored === 'Ada Test', 'the cached audit still populated the report');

  // ── the refresh button pays for a fresh look ─────────
  serveCached = false;
  await page.evaluate(() => document.querySelector('#cacheNotice button').click());
  await page.waitForFunction(() => getComputedStyle(document.getElementById('cacheNotice')).display === 'none', { timeout: 30000 });

  check(requests.length === 2, 'the refresh button re-ran the audit');
  check(requests[1].refresh === true, 'the refresh request asks the backend to bypass the cache');
  check(requests[1].name === 'Ada Test', 'the refresh keeps the same subject');

  if (pageErrors.length) fail(`uncaught page errors:\n  - ${pageErrors.join('\n  - ')}`);
  console.log('✓ audit-cache UI test passed');
} catch (err) {
  console.error(`✗ ${err.message || err}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}
