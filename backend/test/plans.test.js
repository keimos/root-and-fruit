/**
 * Plan catalog + credit resolution tests — node:test, no live Stripe.
 *
 * These cover the rule that keeps a dashboard typo from becoming a fortune:
 * every credit count read out of Stripe metadata is clamped to MAX_GRANT before
 * it can reach a balance.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { creditsFromMetadata, planFromPrice, scaleCredits, MAX_GRANT } = require('../lib/plans');
const { ROLLOVER_MULTIPLIER } = require('../lib/credits');

/** Build a Stripe-shaped Price fixture. */
const price = (over = {}) => ({
  id: 'price_1',
  active: true,
  unit_amount: 3000,
  currency: 'usd',
  metadata: {},
  product: { id: 'prod_1', name: 'Organizer Pack (20)', active: true, metadata: {} },
  ...over
});

// ── creditsFromMetadata ────────────────────────────────
test('creditsFromMetadata: reads the string metadata value as an integer', () => {
  assert.equal(creditsFromMetadata({ credits: '20' }), 20);
  assert.equal(creditsFromMetadata({ credits: 100 }), 100);
});

test('creditsFromMetadata: absent or junk values resolve to 0, never a grant', () => {
  assert.equal(creditsFromMetadata({}), 0);
  assert.equal(creditsFromMetadata(undefined), 0);
  assert.equal(creditsFromMetadata({ credits: 'twenty' }), 0);
  assert.equal(creditsFromMetadata({ credits: '-5' }), 0);
  assert.equal(creditsFromMetadata({ credits: '0' }), 0);
});

// The whole reason the number is allowed to live in a dashboard field.
test('creditsFromMetadata: clamps a fat-fingered value to MAX_GRANT', () => {
  assert.equal(creditsFromMetadata({ credits: '100000' }), MAX_GRANT);
  assert.equal(creditsFromMetadata({ credits: String(MAX_GRANT + 1) }), MAX_GRANT);
});

// ── planFromPrice ──────────────────────────────────────
test('planFromPrice: a one-time price is an uncapped pack', () => {
  const plan = planFromPrice(price({ metadata: { credits: '20' } }));
  assert.equal(plan.credits, 20);
  assert.equal(plan.bucket, 'pack');
  assert.equal(plan.cap, null, 'purchased packs are never capped');
  assert.equal(plan.interval, null);
});

test('planFromPrice: a recurring price is a capped cycle grant', () => {
  const plan = planFromPrice(price({
    metadata: { credits: '20' },
    recurring: { interval: 'month' }
  }));
  assert.equal(plan.bucket, 'cycle');
  assert.equal(plan.cap, 20 * ROLLOVER_MULTIPLIER, 'rollover ceiling comes from the allowance');
  assert.equal(plan.interval, 'month');
});

test('planFromPrice: falls back to product metadata when the price has none', () => {
  const plan = planFromPrice(price({
    metadata: {},
    product: { id: 'prod_1', name: 'Power Pack (50)', active: true, metadata: { credits: '50' } }
  }));
  assert.equal(plan.credits, 50);
  assert.equal(plan.name, 'Power Pack (50)');
});

test('planFromPrice: price metadata overrides the product, for per-price promos', () => {
  const plan = planFromPrice(price({
    metadata: { credits: '25' },
    product: { id: 'prod_1', name: 'x', active: true, metadata: { credits: '20' } }
  }));
  assert.equal(plan.credits, 25);
});

test('planFromPrice: a price with no credit metadata anywhere is not purchasable', () => {
  assert.equal(planFromPrice(price()), null, 'no credits → no plan, rather than a free grant');
  assert.equal(planFromPrice(null), null);
  assert.equal(planFromPrice({}), null);
});

test('planFromPrice: tolerates an unexpanded product reference', () => {
  const plan = planFromPrice(price({ metadata: { credits: '10' }, product: 'prod_9' }));
  assert.equal(plan.productId, 'prod_9');
  assert.equal(plan.credits, 10);
});

// ── scaleCredits ───────────────────────────────────────
test('scaleCredits: multiplies by quantity and re-clamps', () => {
  assert.equal(scaleCredits(20, 3), 60);
  assert.equal(scaleCredits(20), 20, 'missing quantity means 1');
  assert.equal(scaleCredits(20, 0), 20, 'a nonsense quantity means 1, not 0');
  assert.equal(scaleCredits(MAX_GRANT, 5), MAX_GRANT, 'quantity cannot escape the ceiling');
});
