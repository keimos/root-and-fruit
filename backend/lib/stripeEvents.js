/**
 * Root & Fruit — Stripe webhook event interpretation.
 *
 * Pure functions: an already-signature-verified Stripe event goes in, an
 * "intent" describing what should happen to the account comes out. No I/O, so
 * every branch is unit-testable against recorded payloads.
 *
 * Field locations here were verified against a live test-mode event on API
 * version 2026-07-29.dahlia, which matters because several moved in recent
 * versions:
 *   - `invoice.subscription` no longer exists → `invoice.parent.subscription_details.subscription`
 *   - `invoice.lines.data[].price` is null    → `.pricing.price_details.price`
 * Legacy locations are still read as fallbacks so an older API version, or a
 * replayed historical event, does not silently resolve to "no credits".
 *
 * Which events grant, and why:
 *   - one-time packs  → `checkout.session.completed` (mode: payment)
 *   - subscriptions   → `invoice.paid` ONLY, because it fires for the first
 *     payment *and* every renewal, so both run one code path. Granting on the
 *     checkout session as well would double-credit the first month.
 */

// Ledger reasons, also used as the human-readable label on the ledger row.
const REASON_PACK = 'pack_purchase';
const REASON_SUBSCRIPTION = 'subscription_credit';

/**
 * Pull the Root & Fruit uid out of a checkout session.
 * `client_reference_id` is the canonical slot; metadata is the belt-and-braces
 * copy in case a session was created by an older build.
 * @param {object} session  a Stripe Checkout Session object
 * @returns {string|null}  the Firebase uid, or null when absent
 */
function uidFromSession(session) {
  return session?.client_reference_id || session?.metadata?.uid || null;
}

/**
 * Pull the uid out of an invoice, via the subscription metadata stamped at
 * checkout time (`subscription_data.metadata`), which rides along on every
 * renewal invoice for the life of the subscription.
 * @param {object} invoice  a Stripe Invoice object
 * @returns {string|null}  the Firebase uid, or null when absent (the caller
 *          then falls back to a customer-id lookup)
 */
function uidFromInvoice(invoice) {
  return invoice?.parent?.subscription_details?.metadata?.uid
    || invoice?.subscription_details?.metadata?.uid
    || invoice?.metadata?.uid
    || null;
}

/**
 * Resolve the subscription id an invoice belongs to.
 * @param {object} invoice  a Stripe Invoice object
 * @returns {string|null}  the subscription id, or null for a one-off invoice
 */
function subscriptionFromInvoice(invoice) {
  const sub = invoice?.parent?.subscription_details?.subscription
    ?? invoice?.subscription
    ?? null;
  return typeof sub === 'string' ? sub : (sub?.id || null);
}

/**
 * Resolve the price id on an invoice line item across API-version shapes.
 * @param {object} line  an entry from `invoice.lines.data`
 * @returns {string|null}  the price id, or null when it cannot be determined
 */
function priceFromInvoiceLine(line) {
  const modern = line?.pricing?.price_details?.price;
  if (typeof modern === 'string') return modern;
  const legacy = line?.price;
  if (typeof legacy === 'string') return legacy;
  if (legacy?.id) return legacy.id;
  if (typeof line?.plan === 'string') return line.plan;
  if (line?.plan?.id) return line.plan.id;
  return null;
}

/**
 * Pick the credit-bearing line off an invoice.
 *
 * Proration and credit-adjustment lines can ride along on the same invoice, so
 * take the first line with a positive amount and a resolvable price rather than
 * blindly reading `lines.data[0]`.
 * @param {object} invoice  a Stripe Invoice object
 * @returns {{priceId: string, quantity: number, periodEnd: number|null}|null}
 *          the billable line, or null when none qualifies
 */
function billableLine(invoice) {
  const lines = invoice?.lines?.data || [];
  for (const line of lines) {
    const priceId = priceFromInvoiceLine(line);
    if (!priceId) continue;
    if (typeof line.amount === 'number' && line.amount <= 0) continue;
    return {
      priceId,
      quantity: Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 1,
      periodEnd: line.period?.end ?? null
    };
  }
  return null;
}

/**
 * Interpret a verified Stripe event into an action for the account store.
 *
 * @param {object} event  a signature-verified Stripe Event
 * @returns {{kind: string, uid: string|null, customerId: string|null, priceId: string|null,
 *            credits: number|null, quantity: number, bucket: string, reason: string,
 *            ref: string|null, subscriptionId: string|null, status: string|null,
 *            periodEnd: number|null}|null}
 *          `kind: 'grant'` — add credits (resolve `credits` from `priceId` when null)
 *          `kind: 'subscription'` — update plan/status only, never a balance
 *          `null` — an event this app does not act on (still ack it with 200)
 */
function intentFromEvent(event) {
  const object = event?.data?.object;
  if (!object) return null;

  switch (event.type) {
    // ── One-time packs ────────────────────────────────
    case 'checkout.session.completed': {
      // Subscriptions are credited on invoice.paid instead — crediting here too
      // would grant the first month twice.
      if (object.mode !== 'payment') return null;
      if (object.payment_status !== 'paid') return null;
      return {
        kind: 'grant',
        uid: uidFromSession(object),
        customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
        priceId: object.metadata?.priceId || null,
        // Stamped at session-creation time so the payload is self-describing;
        // null falls back to re-reading the price metadata.
        credits: Number(object.metadata?.credits) > 0 ? Number(object.metadata.credits) : null,
        quantity: Number(object.metadata?.quantity) > 0 ? Number(object.metadata.quantity) : 1,
        bucket: 'pack',
        reason: REASON_PACK,
        ref: object.id || null,
        subscriptionId: null,
        status: null,
        periodEnd: null
      };
    }

    // ── Subscription credits (first payment AND every renewal) ──
    case 'invoice.paid': {
      const subscriptionId = subscriptionFromInvoice(object);
      if (!subscriptionId) return null; // a one-off invoice, not our subscription flow
      const line = billableLine(object);
      if (!line) return null;
      const stamped = Number(object?.parent?.subscription_details?.metadata?.credits);
      return {
        kind: 'grant',
        uid: uidFromInvoice(object),
        customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
        priceId: line.priceId,
        credits: stamped > 0 ? stamped : null,
        quantity: line.quantity,
        bucket: 'cycle',
        reason: REASON_SUBSCRIPTION,
        ref: object.id || null,
        subscriptionId,
        status: null,
        periodEnd: line.periodEnd
      };
    }

    // ── Subscription lifecycle: status only, never a balance ──
    // Credits roll over and are permanent, so cancelling must not claw any back.
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      return {
        kind: 'subscription',
        uid: object.metadata?.uid || null,
        customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
        priceId: null,
        credits: null,
        quantity: 1,
        bucket: 'cycle',
        reason: 'subscription_status',
        ref: object.id || null,
        subscriptionId: object.id || null,
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : (object.status || null),
        periodEnd: null
      };
    }

    default:
      return null;
  }
}

module.exports = {
  intentFromEvent,
  uidFromSession,
  uidFromInvoice,
  subscriptionFromInvoice,
  priceFromInvoiceLine,
  billableLine,
  REASON_PACK,
  REASON_SUBSCRIPTION
};
