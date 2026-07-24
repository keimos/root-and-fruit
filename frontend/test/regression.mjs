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
//   AUDIT_TIMEOUT_MS optional — max wait for the audit (default 240000)
// out: exit code 0 on pass, 1 on failure (with a diagnostic on stderr).

import { chromium } from 'playwright';

const FRONTEND_URL = process.env.FRONTEND_URL;
const EXPECTED_VERDICT = (process.env.EXPECTED_VERDICT || '').trim();
const SUBJECT = (process.env.SUBJECT || 'Billion Godson').trim();
const AUDIT_TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS || 240000);

// fail MSG — print a diagnostic and exit non-zero.
// in:  MSG (string)
// out: never returns (process exit 1)
function fail(msg) {
  console.error(`✗ regression FAILED: ${msg}`);
  process.exit(1);
}

if (!FRONTEND_URL) fail('FRONTEND_URL env var is required');

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

    // Results view is the default; the subject input + Auto-Analyze live there.
    await page.fill('#nameInput', SUBJECT);
    console.log(`→ Running Auto-Audit for "${SUBJECT}" (up to ${Math.round(AUDIT_TIMEOUT_MS / 1000)}s)…`);
    await page.click('#analyzeBtn');

    // Race the two terminal outcomes: a verdict renders (#verdictTitle leaves
    // its "UNGRADED" default) or the app surfaces an error (#errorBox shown).
    await page.waitForFunction(
      () => {
        const v = document.getElementById('verdictTitle');
        const err = document.getElementById('errorBox');
        const verdictReady = v && v.textContent.trim() && v.textContent.trim() !== 'UNGRADED';
        const errorShown = err && err.style.display === 'block' && err.textContent.trim();
        return verdictReady || errorShown;
      },
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
