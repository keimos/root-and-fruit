/**
 * Cached Search Reports — cache-key utility (spec §5).
 *
 * Turns a raw user search string into (a) a stable normalized form for storage
 * / debugging, and (b) a Firestore document ID. Two users typing the same
 * subject differently must land on the same document.
 *
 * This module is PURE and has no side effects or dependencies beyond Node
 * built-ins (`crypto`, native `String.prototype.normalize`). Nothing imports it
 * yet — wiring into the read-through cache is a later phase.
 *
 * ReDoS note: every regex below is a single character-class global replace
 * (linear time), so this is safe to run on uncontrolled input.
 */

const crypto = require('node:crypto');

/**
 * Normalize a raw subject string into a stable canonical form. Order matters:
 *   1. NFKD-decompose and strip combining marks   ("José" -> "Jose", "ﬁ" -> "fi")
 *   2. lowercase
 *   3. replace anything that isn't a letter/number/space with a space
 *   4. collapse runs of whitespace, then trim
 *
 * Non-Latin scripts are preserved (\p{L}/\p{N} are Unicode-aware), so names
 * like "李明" still normalize to a stable, non-empty form.
 *
 * @param {string} raw
 * @param {{sortTokens?: boolean}} [opts]
 *   sortTokens (default false): when true, "Jane Doe" and "Doe Jane" collide.
 *   Left OFF by default — token order is preserved so genuinely distinct
 *   subjects with the same word multiset don't share a cache entry. Flip it on
 *   here (one line) if the product decides order-insensitive matching is worth
 *   the occasional false collision.
 * @returns {string} normalized subject ('' for empty/whitespace-only input)
 */
function normalizeSubject(raw, opts = {}) {
  const { sortTokens = false } = opts;
  let s = String(raw ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')            // strip combining marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation / symbols -> space
    .replace(/\s+/gu, ' ')             // collapse whitespace
    .trim();
  if (sortTokens && s) s = s.split(' ').sort().join(' ');
  return s;
}

// Field separator for the hash material: a NUL (0x00). Normalization reduces
// all whitespace to single ASCII spaces, so NUL can never appear in a
// normalized subject, and the extra dimensions are app constants — so there is
// no delimiter-collision or injection surface. Built via fromCharCode so the
// source stays plain ASCII (no literal control byte in the file).
const SEP = String.fromCharCode(0);

/**
 * Build the cache document ID for a subject, optionally folding in extra key
 * dimensions so distinct audit variants of the same name don't collide (a
 * candidate audit and a policy audit of "Prop 47" are different reports).
 *
 * With no extras this is exactly the spec's `sha256(normalized)` truncated to
 * 32 hex chars. Extra dimensions are app-controlled values (not raw user
 * input) — e.g. subjectType, pathway, promptVersion, model — folded in
 * order-independently so the caller doesn't have to remember a canonical order.
 *
 * @param {string} subject  raw user search string
 * @param {object} [extra]  extra key dimensions; the reserved `sortTokens`
 *                          key is a control flag, not a dimension
 * @returns {{docId: string, normalized: string}}
 *   docId: 32-char hex (store as the Firestore doc ID)
 *   normalized: the normalized subject (store in `subjectNormalized` for debug)
 */
function cacheKey(subject, extra = {}) {
  const { sortTokens, ...dimsIn } = extra;
  const normalized = normalizeSubject(subject, { sortTokens });

  // Deterministic, order-independent dimension list: drop empties, lowercase,
  // and sort by "key=value" so the caller need not fix an order.
  const dims = Object.entries(dimsIn)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${String(v).toLowerCase()}`)
    .sort();

  const material = [normalized, ...dims].join(SEP);
  const docId = crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
  return { docId, normalized };
}

module.exports = { normalizeSubject, cacheKey };
