/**
 * Unit tests for the transient-error retry helper — node:test (no deps).
 *
 * These cover the pure logic added to absorb Anthropic's 429 (rate limit) and
 * 529 (fleet overloaded) responses, plus transient 5xx / network errors:
 *   - isRetryable's status classification (retry the transient, fail fast on 4xx)
 *   - withRetry's success / retry-then-succeed / give-up / fail-fast behavior
 *
 * withRetry is driven with a tiny baseDelay so the backoff sleeps stay sub-ms
 * and the suite runs instantly. No network or Anthropic client is involved.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withRetry, isRetryable } = require('../server');

const errWithStatus = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('isRetryable: transient statuses retry', () => {
  for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryable(errWithStatus(s)), true, `expected ${s} to be retryable`);
  }
});

test('isRetryable: client errors fail fast', () => {
  for (const s of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryable(errWithStatus(s)), false, `expected ${s} to be non-retryable`);
  }
});

test('isRetryable: status-less (network) errors retry', () => {
  assert.equal(isRetryable(new Error('ECONNRESET')), true);
});

test('isRetryable: reads a nested response.status', () => {
  assert.equal(isRetryable({ response: { status: 529 } }), true);
  assert.equal(isRetryable({ response: { status: 400 } }), false);
});

test('withRetry: returns on first success without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls += 1; return 'ok'; }, { baseDelay: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: retries a transient error then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw errWithStatus(529);
    return 'recovered';
  }, { retries: 3, baseDelay: 1 });
  assert.equal(result, 'recovered');
  assert.equal(calls, 3); // failed twice, succeeded on the third
});

test('withRetry: gives up after `retries` attempts and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw errWithStatus(529); }, { retries: 2, baseDelay: 1 }),
    /HTTP 529/
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('withRetry: does not retry a non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw errWithStatus(400); }, { retries: 3, baseDelay: 1 }),
    /HTTP 400/
  );
  assert.equal(calls, 1); // failed fast, no retries
});
