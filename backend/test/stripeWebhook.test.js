/**
 * Stripe webhook tests — node:test, no live Stripe and no Firestore.
 *
 * Signatures are REAL: the Stripe SDK's own generateTestHeaderString signs the
 * fixtures and the route verifies them with constructEvent, so the raw-body
 * plumbing is genuinely exercised. If someone ever moves the express.raw mount
 * below express.json, these tests fail — which is the point, because that
 * mistake is invisible in production until every webhook silently 400s.
 *
 * Payload shapes are copied from a live test-mode event on API version
 * 2026-07-29.dahlia (invoice.parent.subscription_details / lines[].pricing).
 */

// Must be set before the server module is loaded — it reads the secret at import.
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');

const app = require('../server');
const { intentFromEvent, priceFromInvoiceLine, billableLine } = require('../lib/stripeEvents');
const { UnknownAccountError, rolloverCap } = require('../lib/credits');

const SECRET = 'whsec_test_secret';
// A real client, used only for its offline signing/verification helpers.
const signer = new Stripe('sk_test_placeholder');

let server, base;
let accounts, events, calls;

// In-memory stand-in for lib/credits with the same idempotency contract the
// real implementation guarantees, so the route's behaviour is tested honestly.
const fakeCredits = {
  async addCredits(uid, { amount, bucket, reason, eventId, ref, cap }) {
    calls.push({ op: 'addCredits', uid, amount, bucket, reason, eventId, cap });
    if (events.has(eventId)) return { duplicate: true, granted: 0, forfeited: 0, balanceAfter: null };
    const acc = accounts.get(uid);
    if (!acc) throw new UnknownAccountError(uid);
    events.add(eventId);
    const room = bucket === 'cycle' && cap != null ? Math.max(0, cap - acc.cycleBalance) : amount;
    const granted = Math.min(amount, room);
    if (bucket === 'cycle') acc.cycleBalance += granted; else acc.packBalance += granted;
    return {
      duplicate: false, granted, forfeited: amount - granted,
      balanceAfter: acc.cycleBalance + acc.packBalance
    };
  },
  async setSubscription(uid, { subscriptionId = null, status = null, plan = null, customerId = null } = {}) {
    calls.push({ op: 'setSubscription', uid, subscriptionId, status, plan, customerId });
    const acc = accounts.get(uid);
    if (!acc) return null;
    // Mirrors lib/credits setSubscription exactly — including the status →
    // subscriptionStatus rename and the backfill-only customer id — so the fake
    // cannot quietly drift from the store the route really writes to.
    if (subscriptionId !== null) acc.stripeSubscriptionId = subscriptionId;
    if (status !== null) acc.subscriptionStatus = status;
    if (plan !== null) acc.plan = plan;
    if (customerId && !acc.stripeCustomerId) acc.stripeCustomerId = customerId;
    return { subscriptionId, status, plan, customerId };
  },
  async uidByCustomer(customerId) {
    for (const [uid, acc] of accounts) if (acc.stripeCustomerId === customerId) return uid;
    return null;
  }
};

const mockStripe = {
  webhooks: signer.webhooks,
  prices: {
    async retrieve(id) {
      if (id === 'price_no_meta') {
        return { id, active: true, metadata: {}, product: { id: 'p', active: true, metadata: {} } };
      }
      return {
        id, active: true, unit_amount: 3000, currency: 'usd',
        metadata: { credits: '20' },
        recurring: id.startsWith('price_sub') ? { interval: 'month' } : undefined,
        product: { id: 'prod_1', name: 'Organizer Pack (20)', active: true, metadata: {} }
      };
    }
  }
};

/** POST a signed Stripe event to the webhook. */
async function send(event, { secret = SECRET, tamper = false } = {}) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret });
  return fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: tamper ? payload.replace('"amount":3000', '"amount":999999') : payload
  });
}

/** Build a checkout.session.completed event for a one-time pack. */
const packEvent = (over = {}) => ({
  id: over.id || 'evt_pack_1',
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_1', mode: 'payment', payment_status: 'paid',
      customer: 'cus_1', client_reference_id: 'u-1',
      metadata: { uid: 'u-1', credits: '20', priceId: 'price_pack', quantity: '1' },
      ...over.object
    }
  }
});

/** Build an invoice.paid event in the modern (dahlia) shape. */
const invoiceEvent = (over = {}) => ({
  id: over.id || 'evt_inv_1',
  type: 'invoice.paid',
  data: {
    object: {
      id: 'in_1', customer: 'cus_1', billing_reason: over.billing_reason || 'subscription_cycle',
      parent: {
        type: 'subscription_details',
        subscription_details: {
          subscription: 'sub_1',
          metadata: over.subMetadata !== undefined ? over.subMetadata : { uid: 'u-1', credits: '20' }
        }
      },
      lines: {
        data: [{
          amount: 3000, quantity: 1, period: { start: 1, end: 2 },
          price: null,
          pricing: { type: 'price_details', price_details: { price: over.priceId || 'price_sub', product: 'prod_1' } }
        }]
      },
      ...over.object
    }
  }
});

before(async () => {
  app.__setStripe(mockStripe);
  app.__setCredits(fakeCredits);
  await new Promise((resolve) => {
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

beforeEach(() => {
  accounts = new Map([['u-1', { uid: 'u-1', cycleBalance: 0, packBalance: 5, stripeCustomerId: 'cus_1' }]]);
  events = new Set();
  calls = [];
});

after(async () => {
  app.__setStripe(null);
  app.__setCredits(null);
  await new Promise((resolve) => server.close(resolve));
});

// ── Signature verification ─────────────────────────────
test('webhook: rejects an unsigned request with 400', async () => {
  const res = await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(packEvent())
  });
  assert.equal(res.status, 400);
  assert.equal(accounts.get('u-1').packBalance, 5, 'nothing granted');
});

test('webhook: rejects a signature made with the wrong secret', async () => {
  const res = await send(packEvent(), { secret: 'whsec_wrong' });
  assert.equal(res.status, 400);
  assert.equal(accounts.get('u-1').packBalance, 5);
});

// This is the raw-body canary: a tampered body must not verify. It only works
// if the route sees the exact bytes Stripe signed.
test('webhook: rejects a body modified after signing', async () => {
  const res = await send(invoiceEvent(), { tamper: true });
  assert.equal(res.status, 400);
  assert.equal(accounts.get('u-1').cycleBalance, 0);
});

// ── One-time packs ─────────────────────────────────────
test('webhook: a completed one-time checkout grants pack credits', async () => {
  const res = await send(packEvent());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.granted, 20);
  assert.equal(accounts.get('u-1').packBalance, 25, '5 existing + 20 purchased');

  const grant = calls.find((c) => c.op === 'addCredits');
  assert.equal(grant.bucket, 'pack');
  assert.equal(grant.cap, null, 'packs are never capped');
  assert.equal(grant.eventId, 'evt_pack_1', 'the Stripe event id is the idempotency key');
});

// Stripe retries anything that is not a prompt 2xx, so a redelivery of a
// already-applied event must change nothing.
test('webhook: a redelivered event does not credit twice', async () => {
  await send(packEvent());
  const res = await send(packEvent());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  assert.equal(accounts.get('u-1').packBalance, 25, 'still 25, not 45');
});

// Subscriptions are credited on invoice.paid, which also fires for the first
// payment — crediting the session too would grant the first month twice.
test('webhook: a subscription checkout session grants nothing', async () => {
  const res = await send(packEvent({ id: 'evt_sub_cs', object: { mode: 'subscription' } }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, 'checkout.session.completed');
  assert.equal(accounts.get('u-1').packBalance, 5);
});

test('webhook: an unpaid checkout session grants nothing', async () => {
  const res = await send(packEvent({ id: 'evt_unpaid', object: { payment_status: 'unpaid' } }));
  assert.equal(res.status, 200);
  assert.equal(accounts.get('u-1').packBalance, 5);
});

// ── Subscription credits ───────────────────────────────
test('webhook: invoice.paid grants cycle credits with the rollover cap applied', async () => {
  const res = await send(invoiceEvent());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).granted, 20);
  assert.equal(accounts.get('u-1').cycleBalance, 20);

  const grant = calls.find((c) => c.op === 'addCredits');
  assert.equal(grant.bucket, 'cycle');
  assert.equal(grant.cap, rolloverCap(20), 'capped at 3x the monthly allowance');
});

test('webhook: a renewal into a near-full balance is capped, not stacked', async () => {
  accounts.get('u-1').cycleBalance = 55;
  const res = await send(invoiceEvent());
  assert.equal((await res.json()).granted, 5, '55 + 5 = the 60 ceiling');
  assert.equal(accounts.get('u-1').cycleBalance, 60);
});

test('webhook: invoice.paid marks the subscription active', async () => {
  await send(invoiceEvent());
  const sub = calls.find((c) => c.op === 'setSubscription');
  assert.equal(sub.status, 'active');
  assert.equal(sub.subscriptionId, 'sub_1');
});

// The uid normally rides on subscription metadata; without it the customer id
// must still resolve the account, or a renewal would be dropped forever.
test('webhook: falls back to the customer id when metadata carries no uid', async () => {
  const res = await send(invoiceEvent({ id: 'evt_nouid', subMetadata: {} }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).granted, 20, 'resolved via stripeCustomerId');
});

test('webhook: credits are re-read from the price when metadata is not stamped', async () => {
  const res = await send(invoiceEvent({ id: 'evt_nostamp', subMetadata: { uid: 'u-1' } }));
  assert.equal((await res.json()).granted, 20, 'fetched from price metadata');
});

test('webhook: a non-subscription invoice is ignored', async () => {
  const event = invoiceEvent({ id: 'evt_manual' });
  event.data.object.parent = null;
  const res = await send(event);
  assert.equal(res.status, 200);
  assert.equal(accounts.get('u-1').cycleBalance, 0);
});

// ── Subscription lifecycle ─────────────────────────────
// Rolled-over credits are permanent and already paid for. Cancelling changes
// status and nothing else.
test('webhook: cancelling a subscription never touches the balance', async () => {
  accounts.get('u-1').cycleBalance = 40;
  const res = await send({
    id: 'evt_cancel',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { uid: 'u-1' } } }
  });
  assert.equal(res.status, 200);
  assert.equal(accounts.get('u-1').cycleBalance, 40, 'the user paid for these');
  assert.equal(accounts.get('u-1').subscriptionStatus, 'canceled');
  assert.equal(calls.some((c) => c.op === 'addCredits'), false, 'no balance operation at all');
});

test('webhook: a past_due subscription is recorded without revoking credits', async () => {
  accounts.get('u-1').cycleBalance = 40;
  await send({
    id: 'evt_pastdue',
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { uid: 'u-1' } } }
  });
  assert.equal(accounts.get('u-1').subscriptionStatus, 'past_due');
  assert.equal(accounts.get('u-1').cycleBalance, 40);
});

// ── Unactionable and transient failures ────────────────
test('webhook: an unknown event type is acked, not retried', async () => {
  const res = await send({ id: 'evt_x', type: 'payout.paid', data: { object: { id: 'po_1' } } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, 'payout.paid');
});

test('webhook: an unresolvable uid is acked so Stripe stops retrying', async () => {
  const res = await send(packEvent({
    id: 'evt_ghost',
    object: { client_reference_id: null, customer: 'cus_unknown', metadata: {} }
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).unresolved, true);
});

test('webhook: a price with no credit metadata is acked, not retried', async () => {
  const res = await send(invoiceEvent({
    id: 'evt_nometa', subMetadata: { uid: 'u-1' }, priceId: 'price_no_meta'
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).unresolved, true);
  assert.equal(accounts.get('u-1').cycleBalance, 0);
});

// A Firestore blip must produce a 500 so Stripe retries into the idempotent path.
test('webhook: a transient store failure returns 500 so Stripe retries', async () => {
  const boom = new Error('Firestore unavailable');
  const original = fakeCredits.addCredits;
  fakeCredits.addCredits = async () => { throw boom; };
  try {
    const res = await send(packEvent({ id: 'evt_boom' }));
    assert.equal(res.status, 500);
  } finally {
    fakeCredits.addCredits = original;
  }
});

// ── Pure: payload shape handling ───────────────────────
// Verified against a live dahlia event: lines[].price is null and the id lives
// under pricing.price_details.price.
test('priceFromInvoiceLine: reads the modern pricing shape', () => {
  assert.equal(priceFromInvoiceLine({
    price: null,
    pricing: { price_details: { price: 'price_9' } }
  }), 'price_9');
});

test('priceFromInvoiceLine: still reads the legacy shapes', () => {
  assert.equal(priceFromInvoiceLine({ price: { id: 'price_old' } }), 'price_old');
  assert.equal(priceFromInvoiceLine({ price: 'price_str' }), 'price_str');
  assert.equal(priceFromInvoiceLine({ plan: { id: 'plan_old' } }), 'plan_old');
  assert.equal(priceFromInvoiceLine({}), null);
});

// Proration credits ride on the same invoice; the credit-bearing line is the
// one with a positive amount, not simply the first.
test('billableLine: skips zero and negative proration lines', () => {
  const line = billableLine({
    lines: {
      data: [
        { amount: -500, pricing: { price_details: { price: 'price_proration' } } },
        { amount: 3000, quantity: 2, period: { end: 99 }, pricing: { price_details: { price: 'price_real' } } }
      ]
    }
  });
  assert.equal(line.priceId, 'price_real');
  assert.equal(line.quantity, 2);
  assert.equal(line.periodEnd, 99);
});

test('intentFromEvent: returns null for an event with no object', () => {
  assert.equal(intentFromEvent({ type: 'invoice.paid' }), null);
  assert.equal(intentFromEvent(null), null);
});

// ── Review fixes ───────────────────────────────────────

// A plan change produces a real PAID invoice for the prorated difference
// (billing_reason: subscription_update). Granting on it would hand out a second
// full allowance inside one billing period.
test('webhook: a proration invoice from a plan change grants nothing', async () => {
  const res = await send(invoiceEvent({ id: 'evt_proration', billing_reason: 'subscription_update' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, 'invoice.paid');
  assert.equal(accounts.get('u-1').cycleBalance, 0);
});

test('webhook: subscription_create and subscription_cycle both grant', async () => {
  await send(invoiceEvent({ id: 'evt_first', billing_reason: 'subscription_create' }));
  assert.equal(accounts.get('u-1').cycleBalance, 20, 'first payment');
  await send(invoiceEvent({ id: 'evt_renew', billing_reason: 'subscription_cycle' }));
  assert.equal(accounts.get('u-1').cycleBalance, 40, 'renewal stacks');
});

// The credits stamped on the subscription at checkout freeze the plan the user
// FIRST bought. After a portal upgrade, renewals must follow the price actually
// being billed, not the stale stamp.
test('webhook: a renewal follows the invoiced price, not the stamped metadata', async () => {
  const res = await send(invoiceEvent({
    id: 'evt_upgraded',
    subMetadata: { uid: 'u-1', credits: '5' },   // stale: user upgraded since
    priceId: 'price_sub'                          // real plan is 20 credits
  }));
  assert.equal((await res.json()).granted, 20, 'resolved from the price, not the stamp');
  const grant = calls.find((c) => c.op === 'addCredits');
  assert.equal(grant.cap, rolloverCap(20), 'the cap follows the current plan too');
});

// Delayed-notification methods finish the session as `unpaid` and confirm later.
test('webhook: an async payment success credits the pack', async () => {
  const ev = packEvent({ id: 'evt_async' });
  ev.type = 'checkout.session.async_payment_succeeded';
  const res = await send(ev);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).granted, 20);
  assert.equal(accounts.get('u-1').packBalance, 25);
});

// A redelivered old invoice carries no new information; writing 'active' from it
// would resurrect a subscription the user has since cancelled.
test('webhook: a duplicate delivery does not revive a cancelled subscription', async () => {
  await send(invoiceEvent({ id: 'evt_dup_status' }));
  accounts.get('u-1').subscriptionStatus = 'canceled';
  calls = [];

  await send(invoiceEvent({ id: 'evt_dup_status' }));
  assert.equal(accounts.get('u-1').subscriptionStatus, 'canceled', 'still cancelled');
  assert.equal(calls.some((c) => c.op === 'setSubscription'), false, 'no status write at all');
});

// A Stripe outage while resolving the price must NOT be acked as unresolved —
// that would permanently lose the grant for an already-paid invoice.
test('webhook: a transient price-lookup failure returns 500 so Stripe retries', async () => {
  const original = mockStripe.prices.retrieve;
  mockStripe.prices.retrieve = async () => { const e = new Error('Stripe down'); e.statusCode = 503; throw e; };
  try {
    const res = await send(invoiceEvent({ id: 'evt_outage', subMetadata: { uid: 'u-1' } }));
    assert.equal(res.status, 500);
    assert.equal(accounts.get('u-1').cycleBalance, 0);
  } finally {
    mockStripe.prices.retrieve = original;
  }
});

test('webhook: a subscription grant records the plan name', async () => {
  await send(invoiceEvent({ id: 'evt_planname' }));
  const sub = calls.find((c) => c.op === 'setSubscription' && c.plan);
  assert.equal(sub.plan, 'Organizer Pack (20)', 'plan is no longer stuck on free');
});
