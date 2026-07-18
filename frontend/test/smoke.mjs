/**
 * Root & Fruit — frontend smoke test.
 *
 * Boots frontend/server.js with a dummy BACKEND_URL, loads the page in headless
 * Chromium, and clicks through every nav tab. Catches the class of bug the
 * single-file frontend is most prone to:
 *   - uncaught JS errors on load or interaction (pageerror)
 *   - runtime-config injection failure (window.__RF_CONFIG__ missing)
 *   - nav drift: a tab that activates the wrong view or highlights the wrong
 *     button — i.e. the canonical `tabs` array in showView() falling out of
 *     sync with the nav DOM order (the exact hazard CLAUDE.md warns about).
 *
 * No backend and no live Anthropic key are needed — the app renders and
 * navigates entirely client-side; only Auto-Analyze needs the backend.
 *
 * Run locally:
 *   cd frontend && npm ci
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   node test/smoke.mjs
 * CI installs Playwright + Chromium ad-hoc (see .github/workflows/pipeline.yml).
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const PORT = process.env.SMOKE_PORT || '8099';
const BASE = `http://localhost:${PORT}`;
const DUMMY_BACKEND = 'http://backend.invalid';

// Nav order MUST mirror the buttons in public/index.html and the canonical
// `tabs` array in the bottom showView() definition. [slug, visible label]
const EXPECTED_TABS = [
  ['results', 'Results'],
  ['community', 'Community Assessment'],
  ['assess', 'Full Report'],
  ['compare', 'Compare'],
  ['saved', 'Saved Audits'],
  ['methodology', 'About'],
];

// fail — abort the smoke test with a message (thrown, caught by the outer runner).
// in:  msg (string) — failure description
// out: never returns — throws Error(msg)
function fail(msg) {
  throw new Error(msg);
}

/**
 * Poll the frontend server until it responds 200, or time out.
 * @param {number} [timeoutMs=15000]  max time to wait before giving up
 * @returns {Promise<void>}  resolves once the server is up; calls fail() on timeout
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

  // Bypass the splash/registration overlay so the app is interactive.
  await context.addInitScript(() => {
    try { sessionStorage.setItem('rfRegistered', 'true'); } catch { /* ignore */ }
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function', { timeout: 5000 });

  // Runtime-config injection (frontend/server.js writes window.__RF_CONFIG__).
  const backendUrl = await page.evaluate(() => window.__RF_CONFIG__?.backendUrl);
  if (backendUrl !== DUMMY_BACKEND) fail(`__RF_CONFIG__.backendUrl not injected (got ${backendUrl})`);

  const navCount = await page.locator('#navTabs .nav-tab').count();
  if (navCount !== EXPECTED_TABS.length) {
    fail(`expected ${EXPECTED_TABS.length} nav tabs, found ${navCount}`);
  }

  for (let i = 0; i < EXPECTED_TABS.length; i++) {
    const [slug, label] = EXPECTED_TABS[i];

    // Click the button at DOM position i — exercises its onclick → showView(slug).
    await page.locator('#navTabs .nav-tab').nth(i).click();

    const state = await page.evaluate(() => {
      const activeViews = Array.from(document.querySelectorAll('.view.active')).map((v) => v.id);
      const tabs = Array.from(document.querySelectorAll('#navTabs .nav-tab'));
      const activeTabIdx = tabs.findIndex((t) => t.classList.contains('active'));
      return {
        activeViews,
        activeTabIdx,
        activeTabCount: tabs.filter((t) => t.classList.contains('active')).length,
        activeTabText: activeTabIdx >= 0 ? tabs[activeTabIdx].textContent.trim() : null,
      };
    });

    if (state.activeViews.length !== 1 || state.activeViews[0] !== `view-${slug}`) {
      fail(`tab #${i} (${label}): expected only view-${slug} active, got [${state.activeViews.join(', ')}]`);
    }
    if (state.activeTabCount !== 1) {
      fail(`tab #${i} (${label}): expected exactly one active nav-tab, found ${state.activeTabCount}`);
    }
    if (state.activeTabIdx !== i) {
      fail(`tab #${i} (${label}): clicked position ${i} but nav-tab #${state.activeTabIdx} is highlighted — nav / tabs-array drift`);
    }
    if (state.activeTabText !== label) {
      fail(`tab #${i}: expected label "${label}", highlighted "${state.activeTabText}"`);
    }

    console.log(`✓ ${label} → view-${slug}`);
  }

  if (pageErrors.length) {
    fail(`uncaught page errors:\n  - ${pageErrors.join('\n  - ')}`);
  }

  console.log('✓ frontend smoke test passed');
} catch (err) {
  console.error(`✗ ${err.message || err}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}
