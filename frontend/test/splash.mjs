/**
 * Root & Fruit — splash sequence test.
 *
 * Boots frontend/server.js in headless Chromium and asserts the first-run
 * ordering: the ACCOUNT card comes before the "Before You Begin" onboarding,
 * it is skippable, and a signed-in user never sees the separate lead-capture
 * form. Covers the wiring most likely to rot:
 *   - account card first, only when Firebase config is injected
 *   - Create Account walks the 4 onboarding steps, THEN opens the register form
 *   - the shared #authModal opens ABOVE the splash (z-index 2000 vs 1000)
 *   - "Continue without an account" reaches the covenant step
 *   - the 4 onboarding steps advance and the agreement gate holds
 *   - anonymous → lead form
 *   - existing account (sign-in or restored session) → straight into the tool,
 *     never the onboarding
 *
 * No Firebase project and no backend are needed: a dummy FIREBASE_API_KEY is
 * enough to enable the UI, and the signed-in branch is driven by setting
 * currentAuthUser in page context (the same flag the real listener sets).
 *
 * Run locally:
 *   cd frontend && node test/splash.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const PORT = process.env.SPLASH_PORT || '8097';
const BASE = `http://localhost:${PORT}`;
const DUMMY_BACKEND = 'http://backend.invalid';

// fail — abort with a message (thrown, caught by the outer runner).
// in:  msg (string)   out: never returns — throws Error(msg)
function fail(msg) {
  throw new Error(msg);
}

// ok — assert a condition, reporting the label on success.
// in:  cond (any) — truthy to pass; label (string)
// out: void; throws via fail() when falsy
function ok(cond, label) {
  if (!cond) fail(label);
  console.log(`✓ ${label}`);
}

/**
 * Poll the frontend server until it responds 200, or time out.
 * @param {number} [timeoutMs=15000]  max wait
 * @returns {Promise<void>}  resolves once up; calls fail() on timeout
 */
async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { redirect: 'manual' });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  fail(`server did not start on ${BASE} within ${timeoutMs}ms`);
}

/**
 * Start frontend/server.js with the given extra environment.
 * @param {object} extraEnv  env vars merged over the defaults
 * @returns {Promise<import('node:child_process').ChildProcess>}  the running server
 */
async function startServer(extraEnv) {
  const proc = spawn('node', ['server.js'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT, BACKEND_URL: DUMMY_BACKEND, NODE_ENV: 'test', ...extraEnv },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer();
  return proc;
}

/**
 * Read whether an element is effectively visible (non-zero box).
 * @param {import('playwright').Page} page
 * @param {string} sel  CSS selector
 * @returns {Promise<boolean>}  true when the element renders
 */
async function visible(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, sel);
}

const FIREBASE_ENV = {
  FIREBASE_API_KEY: 'test-key-not-a-real-project',
  FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  FIREBASE_PROJECT_ID: 'example',
  FIREBASE_APP_ID: '1:2:web:3',
};

let server, browser;
try {
  const { chromium } = await import('playwright');

  // ── With auth enabled ────────────────────────────────
  server = await startServer(FIREBASE_ENV);
  browser = await chromium.launch();
  let page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // Firebase's auth listener resolves asynchronously; give it a beat to fire.
  await sleep(1200);

  ok(await visible(page, '#splashAuthWrap'), 'account card shows first');
  ok(!(await visible(page, '#splashOnboardWrap')), 'onboarding is hidden behind it');
  ok(
    (await page.textContent('#splashStepLabel')).trim() === 'Account',
    'step label reads "Account"'
  );

  // ── Create Account path: onboarding first, register form last ──
  await page.click('text=Create Account →');
  ok(!(await visible(page, '#authModal')), 'Create Account does not jump straight to the form');
  ok(await visible(page, '#splashStep1'), 'it walks "Before You Begin" first');
  await page.click('#splashStep1 >> text=Get Started →');
  await page.click('#splashStep1b >> text=Next →');
  await page.click('#splashStep1c >> text=Next →');
  ok(await visible(page, '#splashStep1d'), 'and reaches One Last Thing');
  ok(
    (await page.textContent('#btnStep1Next')).trim() === 'Create Account →',
    'the agreement button says it creates the account'
  );
  await page.click('#agreeRow');
  await page.click('#btnStep1Next');
  ok(await visible(page, '#authModal'), 'agreeing opens the shared auth modal');
  ok(await visible(page, '#rgPassword'), 'on the register panel');

  // The shared modal must render above the splash overlay, not behind it.
  const stacking = await page.evaluate(() => ({
    modal: Number(getComputedStyle(document.getElementById('authModal')).zIndex),
    splash: Number(getComputedStyle(document.getElementById('splashOverlay')).zIndex),
  }));
  ok(stacking.modal > stacking.splash,
    `auth modal stacks above the splash (${stacking.modal} > ${stacking.splash})`);
  await page.evaluate(() => closeAuthModal());
  ok(
    (await page.evaluate(() => document.getElementById('authModal').style.zIndex)) === '',
    'closing the modal drops the lifted z-index'
  );

  // Registering fires the auth listener, which must take them into the tool.
  await page.evaluate(() => {
    currentAuthUser = { uid: 'u-new', email: 'new@b.com' };
    splashOnAuthChange();
  });
  ok(
    await page.evaluate(() => document.getElementById('splashOverlay').classList.contains('hidden')),
    'a newly registered user enters the tool'
  );

  // ── Skip path ────────────────────────────────────────
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await page.click('text=Continue without an account');
  ok(!(await visible(page, '#splashAuthWrap')), 'skipping hides the account card');
  ok(await visible(page, '#splashStep1'), 'skipping lands on "Before You Begin"');
  ok(
    (await page.textContent('#splashStep1 .onboard-title')).trim() === 'Before You Begin',
    'the covenant step is the first onboarding card'
  );

  // ── Walk the onboarding ──────────────────────────────
  await page.click('#splashStep1 >> text=Get Started →');
  ok(await visible(page, '#splashStep1b'), 'step 2 — How It Works');
  await page.click('#splashStep1b >> text=Next →');
  ok(await visible(page, '#splashStep1c'), 'step 3 — The Verdicts');
  await page.click('#splashStep1c >> text=Next →');
  ok(await visible(page, '#splashStep1d'), 'step 4 — One Last Thing');

  ok(
    await page.evaluate(() => document.getElementById('btnStep1Next').disabled),
    'the continue button is gated on the agreement checkbox'
  );
  await page.click('#agreeRow');
  ok(
    !(await page.evaluate(() => document.getElementById('btnStep1Next').disabled)),
    'agreeing enables it'
  );

  // Anonymous visitor → the lead-capture form still appears.
  await page.click('#btnStep1Next');
  ok(await visible(page, '#splashStep2'), 'anonymous users still get the lead form');

  // ── Existing account: sign in → straight to the tool ─
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await page.click('text=I already have an account');
  ok(await visible(page, '#siPassword'), 'I already have an account opens sign-in');
  // Drive the same flag the real auth listener sets on a successful sign-in.
  await page.evaluate(() => {
    currentAuthUser = { uid: 'u-test', email: 'a@b.com' };
    splashOnAuthChange();
    closeAuthModal();
  });
  ok(
    await page.evaluate(() => document.getElementById('splashOverlay').classList.contains('hidden')),
    'signing in skips the onboarding and enters the tool'
  );
  ok(
    await page.evaluate(() => sessionStorage.getItem('rfRegistered') === 'true'),
    'and the splash does not re-show on the next load'
  );

  // ── Restored session on load: no login flash, no onboarding ──
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Stub the Firebase SDK so the auth listener is held, as if a persisted
  // session were still being restored, and resolve it signed in on cue.
  await page.route('**/firebasejs/**/firebase-app-compat.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.firebase = {
      initializeApp() {},
      auth: Object.assign(() => ({
        onAuthStateChanged(cb) { window.__fireAuth = cb; return () => {}; },
        signOut: async () => { window.__fireAuth(null); },
      }), {}),
    };`,
  }));
  await page.route('**/firebasejs/**/firebase-auth-compat.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  ok(!(await visible(page, '#splashAuthWrap')), 'no account card while the session is restoring');
  ok(!(await visible(page, '#splashOnboardWrap')), 'and no onboarding either');
  await page.evaluate(() => window.__fireAuth({ uid: 'u-back', email: 'c@d.com', getIdToken: async () => 't' }));
  await sleep(200);
  ok(
    await page.evaluate(() => document.getElementById('splashOverlay').classList.contains('hidden')),
    'a restored session goes straight to the tool'
  );

  // ── Sign-out returns to login/registration ───────────
  // Walk the onboarding partway first, so the reset has state to clear.
  await page.evaluate(() => { splashNext(); toggleAgree(); });
  await page.evaluate(async () => { await authLogout(); });
  ok(
    !(await page.evaluate(() => document.getElementById('splashOverlay').classList.contains('hidden'))),
    'signing out re-opens the splash'
  );
  ok(await visible(page, '#splashAuthWrap'), 'and lands on the account card');
  ok(!(await visible(page, '#splashOnboardWrap')), 'with the onboarding put away');
  ok(
    (await page.textContent('#splashStepLabel')).trim() === 'Account',
    'step label back to "Account"'
  );
  ok(
    await page.evaluate(() => sessionStorage.getItem('rfRegistered') === null),
    'the registered flag is cleared so the splash returns on reload'
  );
  ok(
    await page.evaluate(() =>
      splashStep === 0
      && document.getElementById('splashStep1').classList.contains('active')
      && !document.getElementById('agreeCB').checked
      && document.getElementById('btnStep1Next').disabled),
    'onboarding is rewound to step 1 with the agreement gate re-armed'
  );

  await page.close();
  server.kill('SIGTERM');
  await sleep(500);

  // ── With auth disabled ───────────────────────────────
  // No Firebase config → the account card must never appear, so this change is
  // safe to deploy ahead of the Firebase enablement.
  server = await startServer({ FIREBASE_API_KEY: '' });
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(800);
  ok(!(await visible(page, '#splashAuthWrap')), 'no account card when auth is unconfigured');
  ok(await visible(page, '#splashStep1'), 'the splash opens on the covenant, as before');

  if (errors.length) fail(`uncaught page errors:\n  ${errors.join('\n  ')}`);
  console.log('\n✓ splash sequence test passed');
} catch (err) {
  console.error(`\n✗ splash sequence test FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
}
