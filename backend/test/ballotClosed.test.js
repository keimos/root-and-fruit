/**
 * /api/ballot/lookup while the builder is CLOSED — node:test, no live API.
 *
 * Its own file because the open date is read at module load, so the window has
 * to be set before the server is required. node:test gives each file its own
 * process, which makes that clean.
 *
 * What matters here is that a closed builder is refused FIRST: no model call, no
 * debit, no district lookup, and a response that tells the visitor when to come
 * back. Ungated, this request hangs for minutes and then times out.
 */

process.env.BALLOT_AVAILABLE_FROM = '2099-01-01T00:00:00-05:00';
process.env.RATE_LIMIT_AI = '500';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

let server, base, modelCalled = false, debited = false, geocoded = false;

before(async () => {
  app.__setAnthropic({ messages: { create: async () => { modelCalled = true; return { content: [] }; } } });
  app.__setAuthVerifier(async () => ({ uid: 'u-test', email: 'a@b.com', email_verified: true }));
  app.__setCredits({
    async debit() { debited = true; return { charged: 3, balanceAfter: 7 }; },
    async refund() { return null; },
  });
  app.__setDistricts(async () => { geocoded = true; return { ok: false, reason: 'no_match', detail: 'x' }; });
  await new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => {
  app.__setAnthropic(null); app.__setAuthVerifier(null); app.__setCredits(null); app.__setDistricts(null);
  await new Promise((r) => server.close(r));
});

test('a closed builder refuses with 503 and the return date', async () => {
  const res = await fetch(`${base}/api/ballot/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good' },
    body: JSON.stringify({ state: 'LA', address: '1300 Perdido St', city: 'New Orleans' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'not_yet_available');
  assert.match(body.error, /opens/i, 'says when to come back');
  assert.equal(body.availableFrom, new Date('2099-01-01T00:00:00-05:00').toISOString());
});

// The gate is the FIRST thing in the handler, so a closed builder costs nothing
// — not a credit, not a model call, not even a geocoder request.
test('nothing is spent while the builder is closed', () => {
  assert.equal(debited, false, 'no credit debited');
  assert.equal(modelCalled, false, 'no Anthropic call');
  assert.equal(geocoded, false, 'no geocoder call');
});

test('availability reports closed, with the date, to anyone', async () => {
  const res = await fetch(`${base}/api/ballot/availability`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.open, false);
  assert.match(body.message, /opens January 1\b/i, 'the operator wrote Jan 1, so visitors are told Jan 1');
});
