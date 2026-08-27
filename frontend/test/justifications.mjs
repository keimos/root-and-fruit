/**
 * Root & Fruit — community-justification rule test.
 *
 * The rule: once an AI baseline exists, moving any score away from it requires
 * a written justification for that section before the audit can be saved,
 * shared, or exported. This test drives the real page and covers the cases the
 * rule is easy to get wrong on:
 *   - no baseline (manual-only audit) → nothing is an "adjustment", no demand
 *   - editing a section → that section, and only that section, is required
 *   - round-trip (change then undo) → requirement clears, because the score
 *     matches the baseline again
 *   - a token answer ("n/a") → still blocked; non-empty is not the bar
 *   - a real justification → the action proceeds
 *   - re-running the analysis → old text is cleared, since it explained a
 *     difference from a baseline that no longer exists
 *
 * No backend is needed: baseline capture and the rule are entirely client-side.
 *
 * Run locally:
 *   cd frontend && npm ci
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   node test/justifications.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const PORT = process.env.JUSTIFY_PORT || '8101';
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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.calculate === 'function', { timeout: 5000 });

  const r = await page.evaluate(() => {
    const out = {};
    // Swallow toasts so the assertions below read state, not UI chrome.
    const realToast = window.showToast;
    window.showToast = () => {};
    document.getElementById('splashOverlay')?.classList.add('hidden');

    // A manual audit has no baseline: every score is original, not a revision.
    rootCBs[0].checked = true; calculate();
    out.noBaselineAdjusted = getAdjustedSections().length;
    out.noBaselineAllows = enforceJustifications('saving');

    // Freeze the "AI" read, then move one section away from it.
    captureBaseline();
    out.atBaseline = getAdjustedSections().length;
    rootCBs[1].checked = true; calculate();
    out.adjusted = getAdjustedSections();
    out.blocks = !enforceJustifications('saving');
    out.marked = document.getElementById('justRoot').classList.contains('missing');
    out.otherSectionUntouched = !document.getElementById('justFruit').classList.contains('missing');

    // Undo the change — the score matches baseline again, so the demand lifts.
    rootCBs[1].checked = false; calculate();
    out.roundTripAdjusted = getAdjustedSections().length;
    out.roundTripAllows = enforceJustifications('saving');

    // A token answer must not satisfy the rule.
    rootCBs[1].checked = true; calculate();
    document.getElementById('justRoot').value = 'n/a';
    onJustificationChange();
    out.tokenBlocked = !enforceJustifications('saving');

    // A real justification lets the action through.
    document.getElementById('justRoot').value =
      'Local organizers confirmed this record at the March town hall.';
    onJustificationChange();
    out.justifiedAllows = enforceJustifications('saving');
    out.clearedMark = !document.getElementById('justRoot').classList.contains('missing');

    // Re-analysis re-takes the baseline, so old text must not survive.
    clearJustifications();
    out.clearedText = document.getElementById('justRoot').value === '';

    window.showToast = realToast;
    return out;
  });

  check(r.noBaselineAdjusted === 0, 'manual audit (no baseline) has no adjustments');
  check(r.noBaselineAllows === true, 'manual audit is never blocked');
  check(r.atBaseline === 0, 'freshly captured baseline reports no adjustment');
  check(JSON.stringify(r.adjusted) === '["root"]', 'editing Root flags exactly Root');
  check(r.blocks === true, 'an unexplained change blocks the action');
  check(r.marked === true, 'the offending field is marked');
  check(r.otherSectionUntouched === true, 'untouched sections are not marked');
  check(r.roundTripAdjusted === 0, 'undoing the change clears the adjustment');
  check(r.roundTripAllows === true, 'back at baseline, the action proceeds');
  check(r.tokenBlocked === true, 'a token answer ("n/a") does not satisfy the rule');
  check(r.justifiedAllows === true, 'a real justification lets the action through');
  check(r.clearedMark === true, 'the error mark clears once satisfied');
  check(r.clearedText === true, 're-analysis clears stale justification text');

  if (pageErrors.length) fail(`uncaught page errors:\n  - ${pageErrors.join('\n  - ')}`);
  console.log('✓ community-justification rule passed');
} catch (err) {
  console.error(`✗ ${err.message || err}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}
