/**
 * Credit accounting tests — node:test, no live Firestore.
 *
 * Two layers:
 *   - the pure arithmetic (planDebit / totalBalance / profilePatch), tested directly
 *   - the transactional API (ensureAccount / debit / refund) against a fake
 *     Firestore that implements just enough of collection/doc/runTransaction
 *
 * The fake runs the transaction body once against an in-memory store and applies
 * writes at the end, which is enough to prove read-modify-write correctness,
 * bucket ordering, the one-time grant, and refund symmetry.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createCredits, creditCost, totalBalance, planDebit, profilePatch,
  publicAccount, InsufficientCreditsError, CREDIT_COSTS
} = require('../lib/credits');

// ── Fake Firestore ─────────────────────────────────────

/**
 * Build a minimal in-memory Firestore stand-in.
 * @param {object} [seed]  initial docs keyed by `${collection}/${id}`
 * @returns {{db: object, store: Map, ids: string[]}}  the fake db, its backing
 *          store, and the auto-generated doc ids handed out (for assertions)
 */
function fakeFirestore(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ids = [];
  let counter = 0;

  const makeRef = (collection, id) => ({
    id,
    _key: `${collection}/${id}`,
    get() {
      const data = store.get(`${collection}/${id}`);
      return Promise.resolve({ exists: data !== undefined, data: () => data });
    }
  });

  const db = {
    collection(name) {
      return {
        doc(id) {
          if (id === undefined) {
            id = `auto-${++counter}`;
            ids.push(id);
          }
          return makeRef(name, id);
        }
      };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data) => writes.push([ref._key, data, false]),
        update: (ref, patch) => writes.push([ref._key, patch, true])
      };
      const result = await fn(tx);
      for (const [key, data, isPatch] of writes) {
        store.set(key, isPatch ? { ...store.get(key), ...data } : data);
      }
      return result;
    }
  };

  return { db, store, ids };
}

const USER = { uid: 'u-1', email: 'a@b.com' };
/** Build a credits API over a fake db with a fixed timestamp. */
const build = (seed, grant = 5) => {
  const f = fakeFirestore(seed);
  return { ...f, credits: createCredits(f.db, { now: () => 'TS', grant }) };
};

// ── Pure: cost table ───────────────────────────────────
test('creditCost: audit and scrubber cost 1, electability is free', () => {
  assert.equal(creditCost('analyze'), 1);
  assert.equal(creditCost('scrubber'), 1);
  assert.equal(creditCost('electability'), 0);
});

test('creditCost: unknown kinds cost 0 — never fail open into a charge', () => {
  assert.equal(creditCost('nonsense'), 0);
  assert.equal(creditCost(undefined), 0);
  assert.equal(Object.keys(CREDIT_COSTS).length, 3);
});

// ── Pure: planDebit bucket ordering ────────────────────
test('planDebit: spends the expiring cycle bucket before the permanent pack', () => {
  const plan = planDebit({ cycleBalance: 3, packBalance: 10 }, 2);
  assert.deepEqual(
    { ok: plan.ok, cycleDelta: plan.cycleDelta, packDelta: plan.packDelta, bucket: plan.bucket },
    { ok: true, cycleDelta: -2, packDelta: 0, bucket: 'cycle' }
  );
  assert.equal(plan.balanceAfter, 11);
});

test('planDebit: spills into the pack bucket once the cycle is drained', () => {
  const plan = planDebit({ cycleBalance: 1, packBalance: 4 }, 3);
  assert.equal(plan.cycleDelta, -1);
  assert.equal(plan.packDelta, -2);
  assert.equal(plan.bucket, 'split');
  assert.equal(plan.balanceAfter, 2);
});

test('planDebit: refuses when the combined balance is short', () => {
  const plan = planDebit({ cycleBalance: 0, packBalance: 1 }, 2);
  assert.equal(plan.ok, false);
  assert.equal(plan.cycleDelta, 0);
  assert.equal(plan.packDelta, 0);
  assert.equal(plan.balanceAfter, 1, 'reports the balance it had, for the 402 body');
});

test('totalBalance: sums both buckets and floors negatives at 0', () => {
  assert.equal(totalBalance({ cycleBalance: 2, packBalance: 3 }), 5);
  assert.equal(totalBalance({ cycleBalance: -9, packBalance: 3 }), 3);
  assert.equal(totalBalance(undefined), 0);
});

// ── Pure: profilePatch is an allowlist ─────────────────
test('profilePatch: ignores server-owned fields a caller might try to set', () => {
  const patch = profilePatch({
    org: 'Anvil', role: 'Organizer',
    packBalance: 9999, plan: 'newsroom', stripeCustomerId: 'cus_evil', uid: 'someone-else'
  });
  assert.deepEqual(patch, { org: 'Anvil', role: 'Organizer' });
});

test('profilePatch: records terms acceptance with a version and timestamp', () => {
  const patch = profilePatch({ acceptedTerms: true }, 'TS');
  assert.equal(patch.acceptedTerms, true);
  assert.equal(patch.termsVersion, 'v1');
  assert.equal(patch.acceptedAt, 'TS');
  // A falsy/absent flag records nothing at all.
  assert.deepEqual(profilePatch({ acceptedTerms: false }, 'TS'), {});
});

test('publicAccount: flattens the buckets into one balance for the UI', () => {
  const view = publicAccount({ uid: 'u', cycleBalance: 2, packBalance: 3, plan: 'free' });
  assert.equal(view.balance, 5);
  assert.equal(view.plan, 'free');
});

// ── ensureAccount ──────────────────────────────────────
test('ensureAccount: creates the account with the free grant and a ledger row', async () => {
  const { credits, store } = build();
  const account = await credits.ensureAccount(USER);

  assert.equal(account.packBalance, 5, 'free credits land in the non-expiring bucket');
  assert.equal(account.cycleBalance, 0);
  assert.equal(account.plan, 'free');
  assert.equal(store.get('accounts/u-1').packBalance, 5);

  const ledger = [...store.entries()].filter(([k]) => k.startsWith('credit_ledger/'));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0][1].reason, 'free_grant');
  assert.equal(ledger[0][1].delta, 5);
});

test('ensureAccount: is idempotent — the grant is never issued twice', async () => {
  const { credits, store } = build();
  await credits.ensureAccount(USER);
  await credits.ensureAccount(USER);
  await credits.ensureAccount(USER);

  assert.equal(store.get('accounts/u-1').packBalance, 5, 'still 5, not 15');
  const ledger = [...store.keys()].filter((k) => k.startsWith('credit_ledger/'));
  assert.equal(ledger.length, 1, 'only one grant row');
});

test('ensureAccount: merges profile fields into an existing account', async () => {
  const { credits, store } = build();
  await credits.ensureAccount(USER);
  const updated = await credits.ensureAccount(USER, { org: 'Anvil', packBalance: 9999 });

  assert.equal(updated.org, 'Anvil');
  assert.equal(store.get('accounts/u-1').packBalance, 5, 'balance is not client-writable');
});

// ── debit ──────────────────────────────────────────────
test('debit: deducts a credit and writes a ledger row', async () => {
  const { credits, store } = build();
  await credits.ensureAccount(USER);

  const charge = await credits.debit('u-1', { kind: 'analyze', ref: 'Billion Godson' });
  assert.equal(charge.charged, 1);
  assert.equal(charge.balanceAfter, 4);
  assert.equal(store.get('accounts/u-1').packBalance, 4);
  assert.equal(store.get('accounts/u-1').lifetimeSpent, 1);

  const row = [...store.entries()].find(([k, v]) => k.startsWith('credit_ledger/') && v.reason === 'analyze');
  assert.equal(row[1].delta, -1);
  assert.equal(row[1].ref, 'Billion Godson');
});

test('debit: a free task costs nothing and touches neither balance nor ledger', async () => {
  const { credits, store } = build();
  await credits.ensureAccount(USER);
  const before = [...store.keys()].length;

  const charge = await credits.debit('u-1', { kind: 'electability', ref: 'X' });
  assert.equal(charge.charged, 0);
  assert.equal(store.get('accounts/u-1').packBalance, 5);
  assert.equal([...store.keys()].length, before, 'no ledger row written');
});

test('debit: throws InsufficientCreditsError once the free grant is spent', async () => {
  const { credits } = build(undefined, 1);
  await credits.ensureAccount(USER);
  await credits.debit('u-1', { kind: 'analyze' });

  await assert.rejects(
    () => credits.debit('u-1', { kind: 'analyze' }),
    (err) => {
      assert.ok(err instanceof InsufficientCreditsError);
      assert.equal(err.balance, 0);
      assert.equal(err.required, 1);
      return true;
    }
  );
});

test('debit: an unknown uid cannot spend — it is treated as a zero balance', async () => {
  const { credits } = build();
  await assert.rejects(
    () => credits.debit('ghost', { kind: 'analyze' }),
    InsufficientCreditsError
  );
});

// ── refund ─────────────────────────────────────────────
test('refund: returns credits to the exact buckets they were taken from', async () => {
  // 1 cycle credit + 5 pack credits, debit 1 → comes out of cycle.
  const { credits, store } = build({
    'accounts/u-1': {
      uid: 'u-1', cycleBalance: 1, packBalance: 5, lifetimeSpent: 0, plan: 'individual'
    }
  });

  const charge = await credits.debit('u-1', { kind: 'analyze' });
  assert.equal(store.get('accounts/u-1').cycleBalance, 0);

  await credits.refund('u-1', charge);
  const acc = store.get('accounts/u-1');
  assert.equal(acc.cycleBalance, 1, 'expiring credit restored as expiring, not converted');
  assert.equal(acc.packBalance, 5);
  assert.equal(acc.lifetimeSpent, 0);
});

test('refund: is a no-op for a zero-cost charge', async () => {
  const { credits, store } = build();
  await credits.ensureAccount(USER);
  const charge = await credits.debit('u-1', { kind: 'electability' });
  assert.equal(await credits.refund('u-1', charge), null);
  assert.equal(store.get('accounts/u-1').packBalance, 5);
});

test('refund: debit + refund round-trips the balance exactly', async () => {
  const { credits, store } = build();
  await credits.ensureAccount(USER);
  const charge = await credits.debit('u-1', { kind: 'analyze' });
  await credits.refund('u-1', charge);
  assert.equal(store.get('accounts/u-1').packBalance, 5);

  const rows = [...store.values()].filter((v) => v.reason);
  assert.deepEqual(rows.map((r) => r.reason).sort(), ['analyze', 'free_grant', 'refund']);
});
