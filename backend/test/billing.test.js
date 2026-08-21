/**
 * Billing route tests — node:test, no live Stripe and no Firestore.
 *
 * The rules these pin down are the ones that cost money or lock a paying user
 * out if they regress:
 *   - the client names a price and NOTHING else; credits/amount are re-resolved
 *     server-side, so a tampered body cannot buy 1000 credits for $8.50
 *   - checkout requires a verified address, because billableAllowed() would
 *     otherwise refuse every audit the user just paid for
 *   - the uid is stamped on BOTH the session and (for subscriptions) the
 *     subscription, which is what makes renewal webhooks attributable
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

let server, base;
let accounts, created, stripeCalls;

const VERIFIED = { uid: 'u-1', email: 'a@b.com', email_verified: true, sub: 'u-1' };
const UNVERIFIED = { uid: 'u-2', email: 'c@d.com', email_verified: false, sub: 'u-2' };

// Token string → claims. The route only ever sees the decoded result.
const TOKENS = { 'tok-verified': VERIFIED, 'tok-unverified': UNVERIFIED };

const fakeCredits = {
  async ensureAccount(user) {
    if (!accounts.has(user.uid)) {
      accounts.set(user.uid, { uid: user.uid, cycleBalance: 0, packBalance: 0, stripeCustomerId: null });
    }
    return accounts.get(user.uid);
  },
  async getAccount(uid) { return accounts.get(uid) || null; },
  async attachCustomer(uid, customerId) {
    const acc = accounts.get(uid);
    if (!acc) return null;
    if (acc.stripeCustomerId) return acc.stripeCustomerId;
    acc.stripeCustomerId = customerId;
    return customerId;
  }
};

const PRICES = {
  price_pack: {
    id: 'price_pack', active: true, unit_amount: 3000, currency: 'usd',
    metadata: { credits: '20' },
    product: { id: 'prod_1', name: 'Organizer Pack (20)', active: true, metadata: {} }
  },
  price_sub: {
    id: 'price_sub', active: true, unit_amount: 2650, currency: 'usd',
    metadata: { credits: '20' }, recurring: { interval: 'month' },
    product: { id: 'prod_1', name: 'Organizer Pack (20)', active: true, metadata: {} }
  },
  price_nometa: {
    id: 'price_nometa', active: true, unit_amount: 500, currency: 'usd',
    metadata: {}, product: { id: 'prod_2', name: 'Mystery', active: true, metadata: {} }
  }
};

const mockStripe = {
  prices: {
    async list() { return { data: Object.values(PRICES) }; },
    async retrieve(id) {
      if (!PRICES[id]) { const e = new Error('No such price'); e.statusCode = 404; throw e; }
      return PRICES[id];
    }
  },
  customers: {
    async create(args) { stripeCalls.push({ op: 'customers.create', args }); return { id: 'cus_new' }; }
  },
  checkout: {
    sessions: {
      async create(args) {
        stripeCalls.push({ op: 'sessions.create', args });
        created = args;
        return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' };
      }
    }
  },
  billingPortal: {
    sessions: {
      async create(args) {
        stripeCalls.push({ op: 'portal.create', args });
        return { url: 'https://billing.stripe.com/p/session_1' };
      }
    }
  }
};

/** POST helper with an optional bearer token. */
const post = (path, body, token) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body || {})
});

before(async () => {
  app.__setStripe(mockStripe);
  app.__setCredits(fakeCredits);
  app.__setAuthVerifier(async (token) => {
    if (!TOKENS[token]) throw new Error('bad token');
    return TOKENS[token];
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

beforeEach(() => {
  accounts = new Map();
  created = null;
  stripeCalls = [];
});

after(async () => {
  app.__setStripe(null);
  app.__setCredits(null);
  app.__setAuthVerifier(null);
  await new Promise((resolve) => server.close(resolve));
});

// ── Catalog ────────────────────────────────────────────
test('GET /api/billing/plans lists only credit-bearing prices', async () => {
  const res = await fetch(`${base}/api/billing/plans`);
  assert.equal(res.status, 200);
  const { plans } = await res.json();
  const ids = plans.map((p) => p.priceId);
  assert.ok(ids.includes('price_pack') && ids.includes('price_sub'));
  assert.equal(ids.includes('price_nometa'), false, 'a price with no credits metadata is not purchasable');
});

test('GET /api/billing/plans is readable without signing in', async () => {
  const res = await fetch(`${base}/api/billing/plans`);
  assert.equal(res.status, 200, 'prices are public — the picker renders before sign-in');
});

// ── Checkout: auth and verification ────────────────────
test('POST /api/billing/checkout requires a signed-in user', async () => {
  const res = await post('/api/billing/checkout', { priceId: 'price_pack' });
  assert.equal(res.status, 401);
});

// Without this gate a buyer could pay and then be refused every audit by
// billableAllowed(), which rejects cost>0 work from an unverified account.
test('POST /api/billing/checkout refuses an unverified address', async () => {
  const res = await post('/api/billing/checkout', { priceId: 'price_pack' }, 'tok-unverified');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'email_unverified');
  assert.equal(created, null, 'no Stripe session created');
});

// ── Checkout: the client cannot set the price of anything ──
test('POST /api/billing/checkout ignores a client-supplied credit count and amount', async () => {
  const res = await post('/api/billing/checkout', {
    priceId: 'price_pack', credits: 100000, amount: 1, unit_amount: 1
  }, 'tok-verified');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).credits, 20, 're-resolved from Stripe, not the body');
  assert.equal(created.metadata.credits, '20');
  assert.equal(created.line_items[0].price, 'price_pack');
});

test('POST /api/billing/checkout rejects an unknown price', async () => {
  const res = await post('/api/billing/checkout', { priceId: 'price_does_not_exist' }, 'tok-verified');
  assert.equal(res.status, 400);
});

test('POST /api/billing/checkout rejects a price with no credit metadata', async () => {
  const res = await post('/api/billing/checkout', { priceId: 'price_nometa' }, 'tok-verified');
  assert.equal(res.status, 400, 'selling something that grants nothing is worse than failing');
});

test('POST /api/billing/checkout rejects a non-price identifier', async () => {
  const res = await post('/api/billing/checkout', { priceId: 'prod_1' }, 'tok-verified');
  assert.equal(res.status, 400);
});

// ── Checkout: mode and uid stamping ────────────────────
test('POST /api/billing/checkout uses payment mode for a one-time pack', async () => {
  await post('/api/billing/checkout', { priceId: 'price_pack' }, 'tok-verified');
  assert.equal(created.mode, 'payment');
  assert.equal(created.client_reference_id, 'u-1');
  assert.equal(created.subscription_data, undefined, 'no subscription metadata on a one-off');
});

// Renewal invoices carry subscription metadata, never session metadata — without
// this stamp, month two arrives with no uid and cannot be credited.
test('POST /api/billing/checkout stamps the uid on the subscription too', async () => {
  await post('/api/billing/checkout', { priceId: 'price_sub' }, 'tok-verified');
  assert.equal(created.mode, 'subscription');
  assert.equal(created.client_reference_id, 'u-1');
  assert.equal(created.subscription_data.metadata.uid, 'u-1');
  assert.equal(created.subscription_data.metadata.credits, '20');
});

test('POST /api/billing/checkout keeps the Stripe session template token literal', async () => {
  await post('/api/billing/checkout', { priceId: 'price_pack' }, 'tok-verified');
  assert.ok(created.success_url.includes('{CHECKOUT_SESSION_ID}'), 'Stripe substitutes this itself');
  assert.ok(created.cancel_url.includes('checkout=cancelled'));
});

// ── Checkout: customer reuse ───────────────────────────
test('POST /api/billing/checkout creates one customer and reuses it', async () => {
  await post('/api/billing/checkout', { priceId: 'price_pack' }, 'tok-verified');
  assert.equal(accounts.get('u-1').stripeCustomerId, 'cus_new');

  await post('/api/billing/checkout', { priceId: 'price_sub' }, 'tok-verified');
  const creations = stripeCalls.filter((c) => c.op === 'customers.create');
  assert.equal(creations.length, 1, 'a returning buyer keeps one billing history');
  assert.equal(created.customer, 'cus_new');
});

test('POST /api/billing/checkout tags the Stripe customer with the uid', async () => {
  await post('/api/billing/checkout', { priceId: 'price_pack' }, 'tok-verified');
  const creation = stripeCalls.find((c) => c.op === 'customers.create');
  assert.equal(creation.args.metadata.uid, 'u-1');
  assert.equal(creation.args.email, 'a@b.com');
});

// ── Portal ─────────────────────────────────────────────
test('POST /api/billing/portal requires a signed-in user', async () => {
  assert.equal((await post('/api/billing/portal')).status, 401);
});

test('POST /api/billing/portal 404s before any purchase exists', async () => {
  const res = await post('/api/billing/portal', {}, 'tok-verified');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'no_customer');
});

test('POST /api/billing/portal returns a portal url once a customer exists', async () => {
  await post('/api/billing/checkout', { priceId: 'price_pack' }, 'tok-verified');
  const res = await post('/api/billing/portal', {}, 'tok-verified');
  assert.equal(res.status, 200);
  assert.ok((await res.json()).url.startsWith('https://billing.stripe.com/'));
  assert.equal(stripeCalls.find((c) => c.op === 'portal.create').args.customer, 'cus_new');
});
