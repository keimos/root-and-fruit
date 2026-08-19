// regression.mjs — post-deploy regression check for the DEVELOPMENT environment.
//
// Drives the real, deployed dev frontend in headless Chromium: enters the
// canonical regression subject (Billion Godson — see CLAUDE.md's locked-prompt
// rule), runs a full Auto-Audit against the live backend + Anthropic API, and
// asserts the rendered verdict. Driving the actual app (not a hand-rolled API
// call) means the locked prompt in index.html is exercised exactly as shipped —
// no duplication of buildAuditPrompt.
//
// This is the gate that catches prompt/scoring regressions before a change is
// promoted from develop-dev to main.
//
// in (env):
//   FRONTEND_URL     required — the deployed dev frontend base URL
//   EXPECTED_VERDICT optional — known-good verdict label (e.g. "THE WORKER").
//                    When set, the run FAILS unless the verdict matches exactly.
//                    When unset, the run only sanity-checks that a real verdict
//                    rendered and prints the actual one (baseline-establishing
//                    mode — see the CLAUDE.md "pending regression test" note).
//   SUBJECT          optional — override the subject (default "Billion Godson")
//   REGRESSION_USER_EMAIL    required — account the harness signs in as
//   REGRESSION_USER_PASSWORD required — its password. Auto-Analyze is a billed,
//                    signed-in-only route; the account must also hold credits
//                    (the free grant covers 5 runs, so top it up in Firestore).
//   AUDIT_TIMEOUT_MS optional — max wait for the audit (default 240000)
// out: exit code 0 on pass, 1 on failure (with a diagnostic on stderr).

import { chromium } from 'playwright';

const FRONTEND_URL = process.env.FRONTEND_URL;
const EXPECTED_VERDICT = (process.env.EXPECTED_VERDICT || '').trim();
const SUBJECT = (process.env.SUBJECT || 'Billion Godson').trim();
// Auto-Analyze is billed and signed-in only, so the harness needs an account.
const REGRESSION_EMAIL = (process.env.REGRESSION_USER_EMAIL || '').trim();
const REGRESSION_PASSWORD = process.env.REGRESSION_USER_PASSWORD || '';
const AUDIT_TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS || 240000);

// fail MSG — print a diagnostic and exit non-zero.
// in:  MSG (string)
// out: never returns (process exit 1)
function fail(msg) {
  console.error(`✗ regression FAILED: ${msg}`);
  process.exit(1);
}

if (!FRONTEND_URL) fail('FRONTEND_URL env var is required');

// signIn PAGE — authenticate the harness through the app's own sign-in modal.
// Auto-Analyze is billed and requires a verified account; the regression account
// must therefore exist in the environment's Firebase project AND hold credits
// (the 5-credit free grant covers only five runs — top it up in Firestore).
// in:  page (playwright.Page) — the loaded app
// out: Promise<void>; exits the process with a diagnostic if sign-in is
//      unconfigured or fails
async function signIn(page) {
  if (!REGRESSION_EMAIL || !REGRESSION_PASSWORD) {
    fail('REGRESSION_USER_EMAIL and REGRESSION_USER_PASSWORD are required — '
      + 'Auto-Analyze is a billed route and no longer runs anonymously');
  }
  console.log(`→ Signing in as ${REGRESSION_EMAIL}`);
  await page.evaluate(() => openAuthModal('signin'));
  await page.fill('#siEmail', REGRESSION_EMAIL);
  await page.fill('#siPassword', REGRESSION_PASSWORD);
  await page.click('#siSubmit');

  // The header swaps the Sign In button for the account block once Firebase
  // resolves the session.
  try {
    await page.waitForFunction(
      () => {
        const acct = document.getElementById('authAccount');
        return acct && acct.style.display !== 'none';
      },
      null,
      { timeout: 30000, polling: 500 }
    );
  } catch {
    const authErr = await page.evaluate(() => {
      const el = document.getElementById('authError');
      return el && el.textContent.trim();
    });
    fail(`sign-in did not complete${authErr ? ` — ${authErr}` : ''}`);
  }
  console.log('✓ Signed in');
}

// run — execute the regression against the deployed dev frontend.
// in:  none (reads module-level config)
// out: Promise<void>; exits the process with pass/fail status
async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Surface uncaught page errors — a broken single-file build fails silently otherwise.
  page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message}`));

  try {
    console.log(`→ Loading ${FRONTEND_URL}`);
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Dismiss the splash/onboarding+registration overlay — it covers the page on
    // load and intercepts pointer events, so the Auto-Analyze click never lands.
    // The app itself hides it (initSplash) when sessionStorage.rfRegistered is
    // set; we mirror that returning-user path and also force the hidden class as
    // a belt-and-suspenders in case initSplash has already run.
    await page.evaluate(() => {
      try { sessionStorage.setItem('rfRegistered', '1'); } catch (e) { /* ignore */ }
      document.getElementById('splashOverlay')?.classList.add('hidden');
    });

    // Auto-Analyze is a billed route and now requires a signed-in account, so
    // the harness must authenticate before it can run. Without this the click
    // silently opens the sign-in modal and the audit never starts, which would
    // surface only as an opaque timeout.
    await signIn(page);

    // Results view is the default; the subject input + Auto-Analyze live there.
    await page.fill('#nameInput', SUBJECT);
    console.log(`→ Running Auto-Audit for "${SUBJECT}" (up to ${Math.round(AUDIT_TIMEOUT_MS / 1000)}s)…`);
    await page.click('#analyzeBtn');

    // Wait for the AUDIT to actually complete: the report renders into
    // #auditContent (empty until renderAuditReport runs), or the app errors.
    // NB: #verdictTitle is NOT a valid completion signal — the page runs
    // calculate() on load, so it already shows "THE MISALIGNED" (score 0)
    // before any audit runs. Keying on it reads the pristine form, not the audit.
    await page.waitForFunction(
      () => {
        const report = document.getElementById('auditContent');
        const err = document.getElementById('errorBox');
        const reportReady = report && report.textContent.trim().length > 200;
        const errorShown = err && err.style.display === 'block' && err.textContent.trim();
        return reportReady || errorShown;
      },
      null, // no page-function arg — options MUST be the 3rd param, else timeout
            // silently falls back to Playwright's 30s default.
      { timeout: AUDIT_TIMEOUT_MS, polling: 2000 }
    );

    const errorText = await page.evaluate(() => {
      const err = document.getElementById('errorBox');
      return err && err.style.display === 'block' ? err.textContent.trim() : '';
    });
    if (errorText) fail(`app reported an error: "${errorText}"`);

    // The audit applies via an animated ramp — checkboxes flip and sliders climb
    // from 0 over a few seconds — so #finalScore / #verdictTitle pass through
    // intermediate values, notably a premature 0/57 → "THE MISALIGNED". Wait for
    // the score to SETTLE (unchanged for a few seconds) before reading, so we
    // capture the real result instead of a mid-animation frame.
    console.log('→ Verdict rendering; waiting for the score to settle…');
    await page.waitForFunction(
      (stableMs) => {
        const el = document.getElementById('finalScore');
        if (!el) return false;
        const now = parseInt(el.textContent, 10);
        const w = window.__rfSettle || (window.__rfSettle = { last: NaN, since: 0 });
        const t = performance.now();
        if (now !== w.last) { w.last = now; w.since = t; return false; }
        return t - w.since >= stableMs;
      },
      4000, // require 4s with no change
      { timeout: AUDIT_TIMEOUT_MS, polling: 400 }
    );

    const verdict = (await page.textContent('#verdictTitle')).trim();
    const scoreText = (await page.textContent('#finalScore')).trim(); // e.g. "37/57"
    const score = parseInt(scoreText, 10);

    console.log('');
    console.log('  ┌─────────────────────────────────────────');
    console.log(`  │ Subject : ${SUBJECT}`);
    console.log(`  │ Verdict : ${verdict}`);
    console.log(`  │ Score   : ${Number.isNaN(score) ? scoreText : `${score}/57`}`);
    console.log('  └─────────────────────────────────────────');
    console.log('');

    // Sanity: a real verdict + an in-range score must have rendered.
    if (!verdict || verdict === 'UNGRADED') fail('no verdict rendered');
    if (Number.isNaN(score) || score < 0 || score > 57) fail(`score out of range: "${scoreText}"`);

    // Strict baseline comparison, once EXPECTED_VERDICT is known.
    if (EXPECTED_VERDICT) {
      if (verdict !== EXPECTED_VERDICT) {
        fail(`verdict "${verdict}" != expected "${EXPECTED_VERDICT}" — possible prompt/scoring regression`);
      }
      console.log(`✓ regression PASSED — verdict matches baseline "${EXPECTED_VERDICT}"`);
    } else {
      console.log('✓ regression PASSED (sanity mode) — a real verdict rendered.');
      console.log('  NOTE: EXPECTED_VERDICT is unset, so the verdict label is not yet');
      console.log('  enforced. Once you confirm the known-good verdict above is correct,');
      console.log('  set the EXPECTED_VERDICT repo/environment variable to lock the baseline.');
    }
  } finally {
    await browser.close();
  }
}

run().catch((e) => fail(e.message));
