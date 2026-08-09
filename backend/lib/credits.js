/**
 * Root & Fruit — credit accounting.
 *
 * Credits are the unit of paid work: one AI audit costs one credit. The balance
 * is authoritative in Firestore and is NEVER read from or trusted from the
 * client — the browser only ever displays what `/api/account` reports.
 *
 * Two buckets, because the two credit sources expire differently:
 *   - `cycleBalance` — subscription credits, reset each billing cycle, expire.
 *   - `packBalance`  — purchased packs and the one-time free grant, never expire.
 * Debits spend `cycleBalance` first so the expiring credits are used before the
 * permanent ones.
 *
 * Every balance change is a Firestore transaction that also appends a row to
 * `credit_ledger`, so the balance is always reconstructible and a stuck debit is
 * manually reversible.
 *
 * Debits are taken BEFORE the Anthropic call and reversed with `refund()` if it
 * fails. Charging after success would let concurrent requests all pass the same
 * balance check and overspend; the cost of reserving first is that a crash
 * between the debit and the refund leaves the user one credit short, which the
 * ledger row (carrying the request ref) makes recoverable.
 */

const { Firestore } = require('@google-cloud/firestore');

const ACCOUNTS = 'accounts';
const LEDGER = 'credit_ledger';

// One-time grant for a new account. Free credits land in `packBalance` (they do
// not expire) and are never replenished — see the free-tier decision in CLAUDE.md.
const FREE_CREDIT_GRANT = Number.parseInt(process.env.FREE_CREDITS, 10) >= 0
  ? Number.parseInt(process.env.FREE_CREDITS, 10)
  : 5;

// What each billable unit of work costs. `electability` is 0 because it runs
// automatically for every candidate audit — charging for work the user did not
// opt into is a surprise. The Scrubber is an explicit opt-in checkbox and the UI
// already tells users it costs extra.
const CREDIT_COSTS = { analyze: 1, scrubber: 1, electability: 0 };

/**
 * Error thrown when an account cannot cover a debit. Carries the numbers the
 * caller needs to render an upsell (HTTP 402).
 */
class InsufficientCreditsError extends Error {
  /**
   * @param {number} balance   the account's total balance at the time of the attempt
   * @param {number} required  credits the operation needed
   */
  constructor(balance, required) {
    super('Insufficient credits');
    this.name = 'InsufficientCreditsError';
    this.balance = balance;
    this.required = required;
  }
}

/**
 * Look up the credit cost of a unit of work.
 * @param {string} kind  one of the CREDIT_COSTS keys ('analyze', 'scrubber', 'electability')
 * @returns {number}     cost in credits; 0 for unknown kinds (never fail open into a charge)
 */
function creditCost(kind) {
  return CREDIT_COSTS[kind] ?? 0;
}

/**
 * Total spendable credits on an account (both buckets).
 * @param {object} account  an account document (may be partial)
 * @returns {number}        cycleBalance + packBalance, floored at 0 per bucket
 */
function totalBalance(account) {
  return Math.max(0, account?.cycleBalance || 0) + Math.max(0, account?.packBalance || 0);
}

/**
 * Pure: work out how a debit splits across the two buckets, cycle-first.
 * Does not touch Firestore — this is the arithmetic core, unit-tested directly.
 * @param {object} account  account document with cycleBalance / packBalance
 * @param {number} cost     credits to debit (>= 0)
 * @returns {{ok: boolean, cycleDelta: number, packDelta: number, bucket: string, balanceAfter: number}}
 *          deltas are NEGATIVE (amounts to add to each balance); ok=false when short
 */
function planDebit(account, cost) {
  const cycle = Math.max(0, account?.cycleBalance || 0);
  const pack = Math.max(0, account?.packBalance || 0);
  const available = cycle + pack;
  if (available < cost) {
    return { ok: false, cycleDelta: 0, packDelta: 0, bucket: null, balanceAfter: available };
  }
  const fromCycle = Math.min(cycle, cost);
  const fromPack = cost - fromCycle;
  const bucket = fromCycle && fromPack ? 'split' : (fromCycle ? 'cycle' : 'pack');
  return {
    ok: true,
    // `|| 0` normalizes -0 (which `-fromCycle` yields when the amount is 0) to 0
    // so the deltas compare and serialize cleanly.
    cycleDelta: -fromCycle || 0,
    packDelta: -fromPack || 0,
    bucket,
    balanceAfter: available - cost
  };
}

/**
 * Pure: build a fresh account document for a newly-seen user.
 * @param {{uid: string, email: string|null}} user  the verified Firebase user
 * @param {number} grant                            free credits to seed into packBalance
 * @param {*} ts                                    timestamp value for createdAt/updatedAt
 * @returns {object}                                the account document to write
 */
function newAccount(user, grant, ts) {
  return {
    uid: user.uid,
    email: user.email || null,
    firstName: '',
    lastName: '',
    org: '',
    role: '',
    plan: 'free',
    cycleBalance: 0,
    packBalance: grant,
    cycleStart: null,
    cycleEnd: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    acceptedTerms: false,
    termsVersion: null,
    acceptedAt: null,
    lifetimeGranted: grant,
    lifetimeSpent: 0,
    createdAt: ts,
    updatedAt: ts
  };
}

/**
 * Pick the client-settable profile fields out of a request body, ignoring
 * everything else (balances, plan, and Stripe ids are server-owned and can never
 * be set by a caller).
 * @param {object} input  raw profile object from the request body
 * @param {*} ts          timestamp used for acceptedAt when terms are accepted
 * @returns {object}      a patch containing only permitted fields (may be empty)
 */
function profilePatch(input = {}, ts = null) {
  const patch = {};
  for (const key of ['firstName', 'lastName', 'org', 'role']) {
    if (typeof input[key] === 'string') patch[key] = input[key].trim().slice(0, 200);
  }
  if (input.acceptedTerms === true) {
    patch.acceptedTerms = true;
    patch.termsVersion = typeof input.termsVersion === 'string' ? input.termsVersion.slice(0, 40) : 'v1';
    patch.acceptedAt = ts;
  }
  return patch;
}

/**
 * Shape an account document for the client. Strips nothing secret (there are no
 * secrets on the doc) but flattens the two buckets into the single `balance` the
 * UI displays, and drops the Stripe ids the browser has no use for.
 * @param {object} account  the stored account document
 * @returns {object}        the public view of the account
 */
function publicAccount(account) {
  return {
    uid: account.uid,
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    org: account.org,
    role: account.role,
    plan: account.plan,
    balance: totalBalance(account),
    cycleBalance: Math.max(0, account.cycleBalance || 0),
    packBalance: Math.max(0, account.packBalance || 0),
    subscriptionStatus: account.subscriptionStatus,
    acceptedTerms: !!account.acceptedTerms
  };
}

/**
 * Build the credit API bound to a Firestore instance.
 * @param {import('@google-cloud/firestore').Firestore} db  the Firestore client
 * @param {{now?: Function, grant?: number}} [opts]  test seams: timestamp factory
 *        and the free-grant size (defaults to Firestore.Timestamp.now / FREE_CREDITS)
 * @returns {{ensureAccount: Function, getAccount: Function, debit: Function, refund: Function}}
 *          the credit operations, each returning a Promise
 */
function createCredits(db, opts = {}) {
  const now = opts.now || (() => Firestore.Timestamp.now());
  const grant = Number.isInteger(opts.grant) ? opts.grant : FREE_CREDIT_GRANT;

  /**
   * Fetch the account, creating it (with the one-time free grant) if this is the
   * first time we've seen this uid. Idempotent: the grant is written inside the
   * same transaction that creates the doc, so it can never be issued twice.
   * @param {{uid: string, email: string|null}} user  the verified Firebase user
   * @param {object} [profile]  optional profile fields to merge (see profilePatch)
   * @returns {Promise<object>}  the stored account document
   */
  async function ensureAccount(user, profile = {}) {
    const accRef = db.collection(ACCOUNTS).doc(user.uid);
    const ledgerRef = db.collection(LEDGER).doc();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(accRef);
      const ts = now();
      if (snap.exists) {
        const patch = profilePatch(profile, ts);
        if (Object.keys(patch).length === 0) return snap.data();
        patch.updatedAt = ts;
        tx.update(accRef, patch);
        return { ...snap.data(), ...patch };
      }
      const account = { ...newAccount(user, grant, ts), ...profilePatch(profile, ts) };
      tx.set(accRef, account);
      if (grant > 0) {
        tx.set(ledgerRef, {
          uid: user.uid,
          delta: grant,
          reason: 'free_grant',
          bucket: 'pack',
          balanceAfter: grant,
          ref: null,
          createdAt: ts
        });
      }
      return account;
    });
  }

  /**
   * Read an account without creating it.
   * @param {string} uid  the verified Firebase uid
   * @returns {Promise<object|null>}  the account document, or null if none exists
   */
  async function getAccount(uid) {
    const snap = await db.collection(ACCOUNTS).doc(uid).get();
    return snap.exists ? snap.data() : null;
  }

  /**
   * Reserve credits for a unit of work. Transactional and cycle-bucket-first.
   * @param {string} uid  the verified Firebase uid
   * @param {{kind: string, ref?: string|null}} opts  work kind (see CREDIT_COSTS)
   *        and an optional reference (e.g. the subject name) recorded on the ledger row
   * @returns {Promise<{charged: number, cycleDelta: number, packDelta: number, entryId: string|null, balanceAfter: number}>}
   *          the charge receipt — pass it to refund() to reverse it
   * @throws {InsufficientCreditsError}  when the account cannot cover the cost
   */
  async function debit(uid, { kind, ref = null } = {}) {
    const cost = creditCost(kind);
    if (cost <= 0) return { charged: 0, cycleDelta: 0, packDelta: 0, entryId: null, balanceAfter: null };

    const accRef = db.collection(ACCOUNTS).doc(uid);
    const ledgerRef = db.collection(LEDGER).doc();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(accRef);
      if (!snap.exists) throw new InsufficientCreditsError(0, cost);
      const account = snap.data();
      const plan = planDebit(account, cost);
      if (!plan.ok) throw new InsufficientCreditsError(plan.balanceAfter, cost);

      const ts = now();
      tx.update(accRef, {
        cycleBalance: Math.max(0, account.cycleBalance || 0) + plan.cycleDelta,
        packBalance: Math.max(0, account.packBalance || 0) + plan.packDelta,
        lifetimeSpent: (account.lifetimeSpent || 0) + cost,
        updatedAt: ts
      });
      tx.set(ledgerRef, {
        uid,
        delta: -cost,
        reason: kind,
        bucket: plan.bucket,
        balanceAfter: plan.balanceAfter,
        ref,
        createdAt: ts
      });
      return {
        charged: cost,
        cycleDelta: plan.cycleDelta,
        packDelta: plan.packDelta,
        entryId: ledgerRef.id,
        balanceAfter: plan.balanceAfter
      };
    });
  }

  /**
   * Reverse a charge, returning credits to the exact buckets they came from (so
   * a refunded subscription credit does not silently become a non-expiring one).
   * Best-effort by contract: callers use it on the failure path and must not let
   * a refund error mask the original error.
   * @param {string} uid  the verified Firebase uid
   * @param {object} charge  the receipt returned by debit()
   * @returns {Promise<null|{restored: number}>}  null when there was nothing to refund
   */
  async function refund(uid, charge) {
    if (!charge || !charge.charged) return null;
    const accRef = db.collection(ACCOUNTS).doc(uid);
    const ledgerRef = db.collection(LEDGER).doc();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(accRef);
      if (!snap.exists) return null;
      const account = snap.data();
      const ts = now();
      const cycleBalance = Math.max(0, account.cycleBalance || 0) - charge.cycleDelta;
      const packBalance = Math.max(0, account.packBalance || 0) - charge.packDelta;
      tx.update(accRef, {
        cycleBalance,
        packBalance,
        lifetimeSpent: Math.max(0, (account.lifetimeSpent || 0) - charge.charged),
        updatedAt: ts
      });
      tx.set(ledgerRef, {
        uid,
        delta: charge.charged,
        reason: 'refund',
        bucket: 'reversal',
        balanceAfter: cycleBalance + packBalance,
        ref: charge.entryId || null,
        createdAt: ts
      });
      return { restored: charge.charged };
    });
  }

  return { ensureAccount, getAccount, debit, refund };
}

module.exports = {
  createCredits,
  creditCost,
  totalBalance,
  planDebit,
  newAccount,
  profilePatch,
  publicAccount,
  InsufficientCreditsError,
  CREDIT_COSTS,
  FREE_CREDIT_GRANT,
  ACCOUNTS,
  LEDGER
};
