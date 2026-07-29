/**
 * Rate-limiting tests — node:test (no deps).
 *
 * Two layers:
 *   - Unit: buildLimiters/intFromEnv read env config with production defaults.
 *   - HTTP: a burst past the configured limit returns 429 with RateLimit-*
 *     headers, and the general /api limiter is looser than the AI limiter.
 *
 * The limits are shrunk via env BEFORE requiring the app so a short burst trips
 * them. The AI routes short-circuit with 500 ("API key not configured") in the
 * no-key test env, so the burst never touches the network — we only assert that
 * requests past the limit flip to 429.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Shrink the limits before the app (and its limiters) are constructed.
process.env.RATE_LIMIT_AI = '3';
process.env.RATE_LIMIT_REGISTER = '2';
process.env.RATE_LIMIT_API = '50';
process.env.RATE_LIMIT_WINDOW_MS = '60000';

const { buildLimiters, intFromEnv } = require('../lib/rateLimit');
const app = require('../server');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server && server.close());

/**
 * POST empty JSON to a path.
 * @param {string} path  request path
 * @returns {Promise<Response>}  the fetch response
 */
function post(path) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

// ── Unit: config parsing ───────────────────────────────
test('intFromEnv: parses positives, falls back on junk / non-positive', () => {
  assert.equal(intFromEnv('7', 15), 7);
  assert.equal(intFromEnv(undefined, 15), 15);
  assert.equal(intFromEnv('nope', 15), 15);
  assert.equal(intFromEnv('0', 15), 15);
  assert.equal(intFromEnv('-4', 15), 15);
});

test('buildLimiters: returns the three named limiter middlewares', () => {
  const l = buildLimiters({});
  for (const k of ['ai', 'register', 'api']) {
    assert.equal(typeof l[k], 'function', `${k} limiter is middleware`);
  }
});

// ── HTTP: the AI limiter trips after RATE_LIMIT_AI requests ──
test('POST /api/analyze returns 429 once the AI limit is exceeded', async () => {
  // limit=3: the first 3 pass through to the handler (500, no key), #4 is 429.
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await post('/api/analyze');
    statuses.push(res.status);
  }
  assert.ok(!statuses.slice(0, 3).includes(429), `first 3 not limited: ${statuses}`);
  assert.equal(statuses[3], 429, `4th request limited: ${statuses}`);
  assert.equal(statuses[4], 429, `5th request limited: ${statuses}`);
});

test('a 429 response carries standard RateLimit headers and a JSON error', async () => {
  // /api/search shares the same AI limiter bucket, already exhausted above.
  const res = await post('/api/search');
  assert.equal(res.status, 429);
  assert.ok(res.headers.has('ratelimit-limit') || res.headers.has('ratelimit'),
    'emits draft-7 RateLimit headers');
  const body = await res.json();
  assert.match(body.error, /too many requests/i);
});

test('the general /api limiter is looser than the AI limiter', async () => {
  // POST /api/audits with an empty body is rejected at validation (400) BEFORE
  // any Firestore call, so this stays offline. It's under the blanket limiter
  // only (limit=50), so a burst of 5 stays well under it and never 429s —
  // proving the cheap routes aren't capped at the tight AI threshold of 3.
  for (let i = 0; i < 5; i++) {
    const res = await post('/api/audits');
    assert.equal(res.status, 400, 'validation rejects, not rate-limited');
  }
});
