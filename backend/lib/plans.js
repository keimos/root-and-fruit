/**
 * Root & Fruit — Stripe plan catalog and credit resolution.
 *
 * How many credits a payment is worth lives in Stripe **price metadata**
 * (`metadata.credits`), falling back to the parent product's metadata. The
 * catalog changes far more often than this code does, so keeping the number in
 * Stripe means repricing is a dashboard edit rather than a redeploy.
 *
 * The cost of that choice is that a dashboard typo becomes a credit grant, so
 * every number read from metadata is clamped to MAX_GRANT before it can reach a
 * balance. Nothing here trusts a client: the browser only ever names a price id,
 * and the amount is always re-resolved from Stripe server-side.
 */

const { rolloverCap } = require('./credits');

// Hard ceiling on a single grant, whatever the metadata says. The largest real
// pack is 100 credits; this leaves room for a multi-quantity purchase while
// still blocking a fat-fingered `credits: 100000` from minting a fortune.
const MAX_GRANT = Number.parseInt(process.env.MAX_CREDIT_GRANT, 10) > 0
  ? Number.parseInt(process.env.MAX_CREDIT_GRANT, 10)
  : 1000;

/**
 * Read a credit count out of a Stripe metadata bag, clamped into a safe range.
 * @param {object} [metadata]  a Stripe `metadata` object (values are strings)
 * @returns {number}  a non-negative integer no greater than MAX_GRANT; 0 when
 *          the key is absent or unparseable (never fail open into a big grant)
 */
function creditsFromMetadata(metadata) {
  const raw = Number(metadata?.credits);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(MAX_GRANT, Math.floor(raw));
}

/**
 * Resolve a Stripe Price (with its product expanded) into a purchasable plan.
 * @param {object} price  a Stripe Price object; `price.product` may be an
 *        expanded Product object or a bare id string
 * @returns {{priceId: string, productId: string|null, name: string|null, credits: number,
 *           bucket: string, cap: number|null, interval: string|null, unitAmount: number|null,
 *           currency: string|null, active: boolean}|null}
 *          the plan, or null when the price carries no usable credit count
 */
function planFromPrice(price) {
  if (!price || !price.id) return null;
  const product = typeof price.product === 'object' && price.product ? price.product : null;
  // Price metadata wins over product metadata, so a single tier can be
  // overridden per-price (e.g. a promotional price on the same product).
  const credits = creditsFromMetadata(price.metadata) || creditsFromMetadata(product?.metadata);
  if (credits <= 0) return null;

  const recurring = price.recurring || null;
  const bucket = recurring ? 'cycle' : 'pack';
  return {
    priceId: price.id,
    productId: product?.id || (typeof price.product === 'string' ? price.product : null),
    name: product?.name || price.nickname || null,
    credits,
    bucket,
    // Only subscription accrual is capped; a purchased pack is never clamped.
    cap: bucket === 'cycle' ? rolloverCap(credits) : null,
    interval: recurring?.interval || null,
    unitAmount: price.unit_amount ?? null,
    currency: price.currency || null,
    active: price.active !== false
  };
}

/**
 * Multiply a plan's credits by a purchased quantity, re-clamped to MAX_GRANT.
 * @param {number} credits   per-unit credit count
 * @param {number} [quantity]  line-item quantity (defaults to 1)
 * @returns {number}  total credits to grant, clamped
 */
function scaleCredits(credits, quantity = 1) {
  const q = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
  return Math.min(MAX_GRANT, Math.max(0, Math.floor(credits || 0)) * q);
}

/**
 * List every active, credit-bearing price in the Stripe account.
 *
 * Deliberately uncached: both services are stateless by design (see CLAUDE.md),
 * and this is called only when a user opens the plan picker.
 * @param {import('stripe')} stripe  a configured Stripe client
 * @returns {Promise<object[]>}  plans (see planFromPrice), cheapest first
 */
async function listCatalog(stripe) {
  const prices = await stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] });
  return prices.data
    .map(planFromPrice)
    .filter((p) => p && p.active)
    // A price whose product has been archived is not purchasable.
    .filter((p) => {
      const price = prices.data.find((x) => x.id === p.priceId);
      return typeof price.product !== 'object' || price.product.active !== false;
    })
    .sort((a, b) => (a.unitAmount ?? 0) - (b.unitAmount ?? 0));
}

/**
 * Fetch a single price by id and resolve it to a plan.
 * @param {import('stripe')} stripe  a configured Stripe client
 * @param {string} priceId  the Stripe price id
 * @returns {Promise<object|null>}  the plan, or null when unknown/not purchasable
 */
async function planById(stripe, priceId) {
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) return null;
  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const plan = planFromPrice(price);
    if (!plan || !plan.active) return null;
    return plan;
  } catch {
    return null;
  }
}

module.exports = {
  MAX_GRANT,
  creditsFromMetadata,
  planFromPrice,
  scaleCredits,
  listCatalog,
  planById
};
