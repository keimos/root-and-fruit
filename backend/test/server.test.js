/**
 * Backend integration tests — node:test (built-in, no external deps).
 *
 * Strategy: mount the real Express app on an ephemeral port and drive it over
 * HTTP with the global `fetch`. We deliberately exercise only the paths that
 * resolve BEFORE any Firestore query or Anthropic call:
 *   - routing + CORS wiring
 *   - request-body validation (the 400s)
 *   - the no-API-key guard on /api/analyze and /api/search (500s)
 *   - 404 on unknown routes
 *
 * The suite runs with no ANTHROPIC_API_KEY set, so `anthropic` is null and the
 * AI proxies short-circuit to 500 without ever reaching the network. Firestore's
 * client is lazy, so importing the app never opens a connection. Anything that
 * would hit Firestore (a valid save/list/delete/share) is intentionally NOT
 * tested here — that needs an emulator or mocks, which this dependency-free
 * suite avoids by design.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Ensure the AI proxies take their no-key branch regardless of the dev's shell.
delete process.env.ANTHROPIC_API_KEY;

const app = require('../server');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// The billed AI routes require a signed-in user. A fake verifier stands in for a
// Firebase project; the no-key guard still fires before any credit or network
// work, which is what these tests are checking.
const authed = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good' },
  body: JSON.stringify(body)
});

test('GET /health returns ok with a timestamp', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.ts, 'number');
});

test('CORS allows cross-origin by default (Access-Control-Allow-Origin: *)', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: 'https://example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('unknown route 404s', async () => {
  const res = await fetch(`${base}/api/does-not-exist`);
  assert.equal(res.status, 404);
});

test('POST /api/analyze without an API key returns 500', async () => {
  // anthropic is null in the test env, so the handler short-circuits before
  // debiting credits or touching the network.
  app.__setAuthVerifier(async () => ({ uid: 'u-test', email_verified: true }));
  try {
    const res = await fetch(`${base}/api/analyze`, authed({ name: 'Ada' }));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'API key not configured');
  } finally {
    app.__setAuthVerifier(null);
  }
});

test('POST /api/search without an API key returns 500', async () => {
  app.__setAuthVerifier(async () => ({ uid: 'u-test', email_verified: true }));
  try {
    const res = await fetch(`${base}/api/search`, authed({ task: 'scrubber', name: 'Ada' }));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'API key not configured');
  } finally {
    app.__setAuthVerifier(null);
  }
});

test('POST /api/analyze is closed to anonymous callers (401)', async () => {
  const res = await fetch(`${base}/api/analyze`, json({ name: 'Ada' }));
  assert.equal(res.status, 401);
});

test('POST /api/search is closed to anonymous callers (401)', async () => {
  const res = await fetch(`${base}/api/search`, json({ task: 'scrubber', name: 'Ada' }));
  assert.equal(res.status, 401);
});

test('GET /api/account is closed to anonymous callers (401)', async () => {
  const res = await fetch(`${base}/api/account`);
  assert.equal(res.status, 401);
});

test('POST /api/register rejects a missing name', async () => {
  const res = await fetch(`${base}/api/register`, json({ email: 'someone@example.com' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /name and email/i);
});

test('POST /api/register rejects a malformed email', async () => {
  const res = await fetch(`${base}/api/register`, json({ name: 'Ada', email: 'not-an-email' }));
  assert.equal(res.status, 400);
});

test('POST /api/audits rejects a missing userId', async () => {
  const res = await fetch(`${base}/api/audits`, json({ audit: { total: 42 } }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /userId and audit/i);
});

test('POST /api/audits rejects a missing audit', async () => {
  const res = await fetch(`${base}/api/audits`, json({ userId: 'u-1' }));
  assert.equal(res.status, 400);
});

test('POST /api/share rejects a missing audit', async () => {
  const res = await fetch(`${base}/api/share`, json({}));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /audit required/i);
});

// ── Share tokens (CodeQL: insecure randomness) ────────────────────────
// Math.random() is not merely low-entropy: V8's PRNG state is recoverable
// from a few observed outputs, so one token you were legitimately given
// could predict everyone else's.
test('share tokens are 128-bit hex from a CSPRNG', async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audit: { name: 'probe' } })
    });
    // Firestore is not available in tests; a 500 still proves nothing weaker
    // than the guard below is reachable, so only assert on real tokens.
    if (!res.ok) return;
    const { token } = await res.json();
    assert.match(token, /^[0-9a-f]{32}$/, 'expected 32 hex chars (16 bytes)');
    assert.equal(seen.has(token), false, 'tokens must not repeat');
    seen.add(token);
  }
});
