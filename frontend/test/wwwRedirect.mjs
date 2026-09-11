/**
 * Root & Fruit — www canonical-host redirect test.
 *
 * Boots frontend/server.js and asserts redirectWww() sends `www.` hosts to the
 * bare apex while leaving every other host alone. No browser needed — this is
 * pure HTTP, so it runs without Playwright.
 *
 * Guards a failure that is invisible from the server side: the app is served on
 * ONE canonical origin because localStorage (rfUserId + offline audit cache) and
 * the Firebase session are origin-scoped, and because ALLOWED_ORIGIN lists the
 * apex only — a www page's backend preflight is rejected with no
 * Access-Control-Allow-Origin and the real request never fires. Losing this
 * redirect strands www visitors with a split identity and no error anywhere.
 *
 * Run locally:
 *   cd frontend && npm ci
 *   node test/wwwRedirect.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const PORT = process.env.WWW_TEST_PORT || '8098';
const BASE = `http://127.0.0.1:${PORT}`;
const DUMMY_BACKEND = 'http://backend.invalid';

// fail — abort the test with a message (thrown, caught by the outer runner).
// in:  msg (string) — failure description
// out: never returns — throws Error(msg)
function fail(msg) {
  throw new Error(msg);
}

/**
 * Poll the frontend server until it answers, or time out.
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

/**
 * Request a path with an explicit Host header, without following redirects.
 *
 * Uses node:http rather than fetch() on purpose: Host is a forbidden header
 * name in the fetch spec, so undici silently replaces it with the connection's
 * authority and every assertion here would test the wrong hostname.
 * @param {string} host  the Host header to send (e.g. 'www.rootandfruitapp.com')
 * @param {string} [p='/']  request path, including any query string
 * @returns {Promise<{status: number, location: string|null}>}  status + Location
 */
function get(host, p = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(PORT), path: p, method: 'GET', headers: { Host: host } },
      (res) => {
        res.resume();  // drain so the socket can close
        res.on('end', () => resolve({
          status: res.statusCode,
          location: res.headers.location || null
        }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let server;
try {
  server = spawn('node', ['server.js'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT, BACKEND_URL: DUMMY_BACKEND, NODE_ENV: 'test' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForServer();

  // www is redirected, and the path + query survive the hop. A redirect that
  // dropped them would silently dump every deep link on the home page.
  const deep = await get('www.rootandfruitapp.com', '/saved?a=1&b=2');
  if (deep.status !== 301) fail(`www: expected 301, got ${deep.status}`);
  if (deep.location !== 'https://rootandfruitapp.com/saved?a=1&b=2') {
    fail(`www: wrong Location: ${deep.location}`);
  }

  // Always https, never the proxy-visible http — req.protocol reads "http"
  // behind Cloud Run's front end, so a scheme taken from it would downgrade.
  if (!deep.location.startsWith('https://')) fail('www: redirect must be https');

  // Host matching is case-insensitive (Host headers are not normalized for us).
  const upper = await get('WWW.rootandfruitapp.com');
  if (upper.status !== 301) fail(`WWW: expected 301, got ${upper.status}`);

  // The apex serves the app rather than redirecting to itself — a loop here
  // would take the whole site down.
  const apex = await get('rootandfruitapp.com');
  if (apex.status !== 200) fail(`apex: expected 200, got ${apex.status}`);

  // Local dev (and the Cloud Run *.run.app URLs) are untouched.
  const local = await get(`127.0.0.1:${PORT}`);
  if (local.status !== 200) fail(`localhost: expected 200, got ${local.status}`);

  // Prefix match only on the "www." label — a host merely starting with those
  // letters must not be rewritten into a domain that does not exist.
  const notWww = await get('wwwx.rootandfruitapp.com');
  if (notWww.status !== 200) fail(`wwwx: expected 200, got ${notWww.status}`);

  console.log('www redirect test passed (6 assertions)');
} catch (err) {
  console.error('www redirect test FAILED:', err.message);
  process.exitCode = 1;
} finally {
  if (server) server.kill();
}
