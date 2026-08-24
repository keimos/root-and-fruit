/**
 * Firebase auth-middleware tests — node:test (no deps, no live Firebase).
 *
 * A fake verifier is injected via __setVerifier so token verification is
 * exercised without a Firebase project. Covers:
 *   - extractBearer: header parsing
 *   - optionalAuth: attaches req.user on a good token; stays anonymous (never
 *     rejects) on missing / invalid tokens
 *   - requireAuth: 401 without a valid token, passes through with one
 *   - HTTP: optionalAuth is non-blocking — an invalid token still reaches the
 *     handler (validation 400, not 401)
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const authLib = require('../lib/auth');
const { extractBearer, optionalAuth, requireAuth, __setVerifier, MAX_AUTH_HEADER } = authLib;
const app = require('../server');

/** Build a minimal Express-ish response spy. @returns {object} res with status/json capture */
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

/** Run a middleware and resolve once next() is called (or a response is sent).
 * @param {Function} mw   the middleware
 * @param {object} req    fake request
 * @returns {Promise<{res: object, nexted: boolean}>}
 */
function runMw(mw, req) {
  return new Promise((resolve) => {
    const res = mockRes();
    let nexted = false;
    const done = () => resolve({ res, nexted });
    mw(req, res, () => { nexted = true; done(); });
    // requireAuth resolves via res.json without calling next — poll a tick.
    setImmediate(() => { if (!nexted) done(); });
  });
}

afterEach(() => __setVerifier(null)); // restore real verification between tests

// ── extractBearer ──────────────────────────────────────
test('extractBearer: pulls the token from a Bearer header', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.equal(extractBearer({ headers: { authorization: 'bearer TOKEN' } }), 'TOKEN'); // case-insensitive
});

test('extractBearer: returns null for missing / malformed headers', () => {
  assert.equal(extractBearer({ headers: {} }), null);
  assert.equal(extractBearer({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(extractBearer({ headers: { authorization: 'abc.def' } }), null);
});

// ── optionalAuth ───────────────────────────────────────
test('optionalAuth: attaches req.user for a valid token', async () => {
  __setVerifier(async () => ({ uid: 'u-123', email: 'a@b.com', email_verified: true }));
  const req = { headers: { authorization: 'Bearer good' } };
  const { nexted } = await runMw(optionalAuth(), req);
  assert.ok(nexted, 'passed through');
  assert.deepEqual(req.user, { uid: 'u-123', email: 'a@b.com', emailVerified: true });
});

test('optionalAuth: stays anonymous (req.user null) with no token', async () => {
  const req = { headers: {} };
  const { nexted } = await runMw(optionalAuth(), req);
  assert.ok(nexted);
  assert.equal(req.user, null);
});

test('optionalAuth: never rejects on an invalid token — treats it as anonymous', async () => {
  __setVerifier(async () => { throw new Error('token expired'); });
  const req = { headers: { authorization: 'Bearer bad' } };
  const { res, nexted } = await runMw(optionalAuth(), req);
  assert.ok(nexted, 'still passed through');
  assert.equal(req.user, null);
  assert.equal(res.statusCode, 200);
});

// ── requireAuth ────────────────────────────────────────
test('requireAuth: 401 when no valid token is present', async () => {
  const req = { headers: {} };
  const { res, nexted } = await runMw(requireAuth(), req);
  assert.ok(!nexted, 'did not pass through');
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /authentication required/i);
});

test('requireAuth: passes through and sets req.user for a valid token', async () => {
  __setVerifier(async () => ({ sub: 'u-9', email_verified: false }));
  const req = { headers: { authorization: 'Bearer good' } };
  const { nexted } = await runMw(requireAuth(), req);
  assert.ok(nexted);
  assert.equal(req.user.uid, 'u-9');
  assert.equal(req.user.emailVerified, false);
});

// ── HTTP: optionalAuth is non-blocking ─────────────────
test('an invalid token does not block the request (reaches handler → 400, not 401)', async () => {
  __setVerifier(async () => { throw new Error('bad token'); });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Empty body fails validation (400) BEFORE any Firestore call; the point is
    // it's 400 (handler ran), not 401 (blocked by auth).
    const res = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bad' },
      body: '{}',
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// ── extractBearer: ReDoS resistance (CodeQL js/polynomial-redos) ──────
// The Authorization header is attacker-controlled and unauthenticated —
// optionalAuth parses it on EVERY /api/* request. The old
// /^Bearer\s+(.+)$/i was quadratic because \s and . both match a space, so
// every split point between them had to be retried before the match failed.
test('extractBearer: a pathological header parses in linear time', () => {
  // Shape that forced the backtracking: a long run of spaces, then content
  // the trailing anchor cannot accept.
  const hostile = 'Bearer ' + ' '.repeat(50000) + 'x\ny';
  const t0 = process.hrtime.bigint();
  extractBearer({ headers: { authorization: hostile } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 250, `parse took ${ms.toFixed(1)}ms — quadratic behaviour is back`);
});

test('extractBearer: refuses an oversized header outright', () => {
  const huge = 'Bearer ' + 'a'.repeat(MAX_AUTH_HEADER + 1);
  assert.equal(extractBearer({ headers: { authorization: huge } }), null);
  // Just under the cap still parses, so the bound does not reject real tokens
  // (a Firebase ID token is roughly 1KB).
  const ok = 'Bearer ' + 'a'.repeat(2000);
  assert.equal(extractBearer({ headers: { authorization: ok } }), 'a'.repeat(2000));
});

test('extractBearer: still tolerates the whitespace real clients send', () => {
  assert.equal(extractBearer({ headers: { authorization: '  Bearer   tok  ' } }), 'tok');
  assert.equal(extractBearer({ headers: { authorization: 'Bearer\ttok' } }), 'tok');
  assert.equal(extractBearer({ headers: { authorization: 'Bearer' } }), null, 'scheme with no token');
  assert.equal(extractBearer({ headers: { authorization: 'Bearer   ' } }), null, 'whitespace-only token');
  assert.equal(extractBearer({ headers: { authorization: 123 } }), null, 'non-string header');
});
