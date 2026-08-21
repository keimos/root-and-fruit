/**
 * Production redirect-target guard — node:test.
 *
 * Lives in its own file because APP_URL / ALLOWED_ORIGIN are read once at module
 * load, so the "neither is set, in production" state cannot be simulated inside
 * a file that has already imported the server with them present.
 *
 * The rule: both variables are optional, so a deploy that sets neither would
 * silently return paying customers to http://localhost:8080 after checkout. The
 * webhook would still grant the credits, so the user is charged, credited, and
 * shown a dead page — worse than not selling at all.
 */

process.env.NODE_ENV = 'production';
delete process.env.APP_URL;
delete process.env.ALLOWED_ORIGIN;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

const USER = { uid: 'u-1', email: 'a@b.com', email_verified: true, sub: 'u-1' };

let server, base;

before(async () => {
  // A Stripe client must exist, or the route short-circuits on a different 503
  // and the guard under test never runs.
  app.__setStripe({ prices: { async retrieve() { throw new Error('should not be reached'); } } });
  app.__setAuthVerifier(async () => USER);
  await new Promise((resolve) => {
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  app.__setStripe(null);
  app.__setAuthVerifier(null);
  await new Promise((resolve) => server.close(resolve));
});

test('checkout is disabled in production when no redirect target is configured', async () => {
  const res = await fetch(`${base}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({ priceId: 'price_pack' })
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'app_url_unset');
});

test('resolveAppUrl still reports the localhost fallback it is guarding against', () => {
  assert.equal(app.resolveAppUrl(undefined, undefined), 'http://localhost:8080');
});
