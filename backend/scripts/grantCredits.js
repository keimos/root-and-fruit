#!/usr/bin/env node
/**
 * Root & Fruit — operator credit grant.
 *
 * Adds credits to one account through the SAME transactional path the Stripe
 * webhook uses (credits.addCredits), so the balance change and its
 * `credit_ledger` row are written atomically. That is the whole reason this
 * script exists rather than an edit in the Firestore console: the ledger is the
 * append-only record of every balance change, and it is what answers "why does
 * this account have N credits" and what makes a crash between debit and refund
 * recoverable. A console edit moves the balance and leaves the ledger behind,
 * and nothing in the app ever reconciles the two.
 *
 * Grants land in the `pack` bucket (non-expiring, uncapped), which is where the
 * free grant and purchased packs live. `lifetimeGranted` is deliberately NOT
 * touched — grantIssued() reads it as "the one-time free grant was already paid
 * out", so incrementing it here would rob a user of a free grant they have not
 * yet received. Note addCredits does add to `lifetimePurchased`; for a comp that
 * slightly overstates revenue-bearing credits, which is the accepted tradeoff
 * for reusing the audited path instead of writing a second one.
 *
 * Idempotent via the `stripe_events` collection: --id is recorded there inside
 * the transaction, so re-running with the same id is a no-op rather than a
 * second grant. Use a new --id for a genuinely new grant.
 *
 * Usage (dry run by default — nothing is written without --yes):
 *   cd backend
 *   GOOGLE_CLOUD_PROJECT=root-and-fruit-app \
 *     node scripts/grantCredits.js --uid <UID> --amount 25 --id comp-2026-09-11-a
 *   # then add --yes to apply
 *
 * Credentials come from ADC (`gcloud auth application-default login`), so the
 * operator's own identity is what writes — there is no service-account key here.
 */

const { Firestore } = require('@google-cloud/firestore');
const creditsLib = require('../lib/credits');

/**
 * Parse `--flag value` pairs and bare `--flag` switches from argv.
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {object}  flag name → string value, or true for a bare switch
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

/**
 * Print a one-line balance summary for an account document.
 * @param {string} label  heading shown before the values
 * @param {object|null} acc  the account document, or null when absent
 * @returns {void}  none (side effect: stdout)
 */
function printAccount(label, acc) {
  if (!acc) { console.log(`${label}: (no account document)`); return; }
  console.log(
    `${label}: total=${creditsLib.totalBalance(acc)} `
    + `(cycle=${acc.cycleBalance || 0}, pack=${acc.packBalance || 0}) `
    + `granted=${acc.lifetimeGranted || 0} spent=${acc.lifetimeSpent || 0} `
    + `purchased=${acc.lifetimePurchased || 0}`
  );
}

/**
 * Entry point: validate arguments, show the current balance, and apply the
 * grant when --yes is passed.
 * @returns {Promise<void>}  resolves when done; sets process.exitCode on error
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uid = typeof args.uid === 'string' ? args.uid : null;
  const amount = Number.parseInt(args.amount, 10);
  const eventId = typeof args.id === 'string' ? args.id : null;
  const reason = typeof args.reason === 'string' ? args.reason : 'manual_grant';
  const ref = typeof args.ref === 'string' ? args.ref : null;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

  if (!uid || !Number.isInteger(amount) || amount <= 0 || !eventId) {
    console.error('Usage: node scripts/grantCredits.js --uid <UID> --amount <N> --id <unique-id> [--reason <r>] [--ref <r>] [--yes]');
    console.error('  --id must be unique per grant; re-running with the same id is a no-op.');
    process.exitCode = 1;
    return;
  }
  if (!projectId) {
    console.error('Set GOOGLE_CLOUD_PROJECT (e.g. root-and-fruit-app) so the Firestore client targets the right project.');
    process.exitCode = 1;
    return;
  }

  const db = new Firestore({ projectId });
  const credits = creditsLib.createCredits(db);

  const before = await credits.getAccount(uid);
  if (!before) {
    // addCredits throws UnknownAccountError here; say so in plain terms first.
    console.error(`No accounts/${uid} document exists. The account doc is created by the`);
    console.error('first successful GET /api/account — have the user load the app while signed in.');
    process.exitCode = 1;
    return;
  }
  console.log(`project: ${projectId}`);
  console.log(`uid:     ${uid} (${before.email || 'no email on file'})`);
  printAccount('before', before);

  if (args.yes !== true) {
    console.log(`\nDRY RUN — would add ${amount} credits to the pack bucket `
      + `(reason=${reason}, id=${eventId}).`);
    console.log('Re-run with --yes to apply.');
    return;
  }

  const receipt = await credits.addCredits(uid, { amount, bucket: 'pack', reason, eventId, ref });
  if (receipt.duplicate) {
    console.log(`\nNo-op: a grant with id "${eventId}" was already applied. Use a new --id for a new grant.`);
    return;
  }
  printAccount('after ', await credits.getAccount(uid));
  console.log(`\nGranted ${receipt.granted} credits. Ledger row written in the same transaction.`);
}

main().catch((err) => {
  console.error('Grant failed:', err.message);
  process.exitCode = 1;
});
