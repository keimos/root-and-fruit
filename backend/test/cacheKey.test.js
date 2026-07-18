/**
 * Unit tests for the cache-key utility (spec §5) — node:test (no deps).
 *
 * Covers the pure normalization + hashing logic:
 *   - normalizeSubject: case / whitespace / punctuation / diacritics / ligatures
 *     / non-Latin scripts / empty input / optional token sort
 *   - cacheKey: 32-hex doc ID, determinism, variant collision, subject
 *     distinctness, the bare spec form (sha256(normalized)), and order-
 *     independent extra dimensions (so candidate ≠ policy audits of one name)
 *   - ReDoS guard: linear-time on a large adversarial input
 *
 * Pure functions only — no clock, network, or randomness — so the suite is
 * deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { normalizeSubject, cacheKey } = require('../lib/cacheKey');

// ── normalizeSubject ───────────────────────────────────
test('normalizeSubject: trims, lowercases, collapses whitespace', () => {
  assert.equal(normalizeSubject('  Jane   DOE  '), 'jane doe');
  assert.equal(normalizeSubject('Jane\t\nDoe'), 'jane doe');
});

test('normalizeSubject: punctuation and symbols become word breaks', () => {
  assert.equal(normalizeSubject("O'Brien-Smith, Jr."), 'o brien smith jr');
  assert.equal(normalizeSubject('Prop. 47!'), 'prop 47');
});

test('normalizeSubject: strips diacritics via NFKD', () => {
  assert.equal(normalizeSubject('José Peña'), 'jose pena');
  assert.equal(normalizeSubject('Renée Zellweger'), 'renee zellweger');
});

test('normalizeSubject: decomposes compatibility ligatures', () => {
  // "ﬁle" uses the U+FB01 fi ligature; NFKD splits it to "fi".
  assert.equal(normalizeSubject('ﬁle'), 'file');
});

test('normalizeSubject: preserves non-Latin scripts (stable, non-empty)', () => {
  const out = normalizeSubject('李明');
  assert.equal(out, '李明');
  assert.notEqual(out, '');
});

test('normalizeSubject: empty / whitespace / nullish inputs collapse to ""', () => {
  for (const v of ['', '   ', '\t\n', null, undefined]) {
    assert.equal(normalizeSubject(v), '');
  }
});

test('normalizeSubject: token order preserved by default; sorted only on opt-in', () => {
  assert.notEqual(normalizeSubject('Jane Doe'), normalizeSubject('Doe Jane'));
  assert.equal(
    normalizeSubject('Jane Doe', { sortTokens: true }),
    normalizeSubject('Doe Jane', { sortTokens: true })
  );
  assert.equal(normalizeSubject('Jane Doe', { sortTokens: true }), 'doe jane');
});

// ── cacheKey ───────────────────────────────────────────
test('cacheKey: docId is 32 lowercase hex chars', () => {
  const { docId } = cacheKey('Jane Doe');
  assert.match(docId, /^[0-9a-f]{32}$/);
});

test('cacheKey: deterministic for the same input', () => {
  assert.equal(cacheKey('Shirley Chisholm').docId, cacheKey('Shirley Chisholm').docId);
});

test('cacheKey: case / spacing / punctuation / diacritic variants collide', () => {
  const base = cacheKey('José Doe').docId;
  for (const v of ['  josé   doe ', 'JOSÉ DOE', 'José, Doe!', 'Jose Doe']) {
    assert.equal(cacheKey(v).docId, base, `expected "${v}" to collide with "José Doe"`);
  }
});

test('cacheKey: distinct subjects produce distinct docIds', () => {
  assert.notEqual(cacheKey('Jane Doe').docId, cacheKey('John Doe').docId);
});

test('cacheKey: bare form equals the spec form sha256(normalized) truncated to 32', () => {
  const raw = 'Prop 47';
  const normalized = normalizeSubject(raw);
  const expected = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
  const { docId, normalized: outNorm } = cacheKey(raw);
  assert.equal(docId, expected);
  assert.equal(outNorm, normalized);
});

test('cacheKey: extra dimensions change the docId (candidate ≠ policy, elected ≠ community)', () => {
  const cand = cacheKey('Prop 47', { subjectType: 'candidate' }).docId;
  const pol = cacheKey('Prop 47', { subjectType: 'policy' }).docId;
  assert.notEqual(cand, pol);
  assert.notEqual(
    cacheKey('X', { pathway: 'elected' }).docId,
    cacheKey('X', { pathway: 'community' }).docId
  );
});

test('cacheKey: extra dimensions are order-independent', () => {
  const a = cacheKey('X', { subjectType: 'candidate', pathway: 'elected', model: 'opus' }).docId;
  const b = cacheKey('X', { model: 'opus', pathway: 'elected', subjectType: 'candidate' }).docId;
  assert.equal(a, b);
});

test('cacheKey: empty / nullish dimensions are ignored (equal to no dimension)', () => {
  const base = cacheKey('X').docId;
  assert.equal(cacheKey('X', { subjectType: '' }).docId, base);
  assert.equal(cacheKey('X', { subjectType: null, pathway: undefined }).docId, base);
});

test('cacheKey: sortTokens is a control flag, not a hashed dimension', () => {
  // With sortTokens on, "Jane Doe" normalizes to "doe jane" and must equal the
  // bare docId of "doe jane" — proving sortTokens did not leak into the key.
  const sorted = cacheKey('Jane Doe', { sortTokens: true }).docId;
  assert.equal(sorted, cacheKey('doe jane').docId);
  assert.equal(sorted, cacheKey('Doe Jane', { sortTokens: true }).docId);
});

// ── ReDoS guard ────────────────────────────────────────
test('normalizeSubject: linear-time on a large adversarial input', () => {
  // Mix of the shapes that break naive regexes: many dots, combining marks,
  // and whitespace runs. Linear char-class replaces handle this in a few ms;
  // the generous bound only trips on a catastrophic (super-linear) regression.
  const evil = ('a.' .repeat(200000)) + ('é '.repeat(100000));
  const t0 = performance.now();
  const out = normalizeSubject(evil);
  const t1 = performance.now();
  assert.equal(typeof out, 'string');
  assert.ok(t1 - t0 < 2000, `normalizeSubject took ${(t1 - t0).toFixed(0)}ms on ${evil.length} chars`);
});
