/**
 * Byte-equivalence gate for the prompt relocation (injection fix #1) — node:test.
 *
 * The locked audit prompt moved from the frontend (index.html `buildAuditPrompt`
 * + the short analyze system message) to backend/lib/prompts.js. This test
 * proves the move is LOSSLESS: it extracts the frontend originals straight out
 * of index.html at test time, evals them, and asserts the backend module
 * produces STRING-IDENTICAL output across an input matrix. If the bytes match,
 * the audit result cannot change — this stands in for the live Billion Godson
 * regression for the relocation itself (the delimiting change #2 is staged OFF
 * by default and is NOT covered here — it needs the live run before enabling).
 *
 * No API, no network — pure string comparison.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = require('../lib/prompts');
const { buildAuditTarget } = backend;

const INDEX_HTML = path.join(__dirname, '..', '..', 'frontend', 'public', 'index.html');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

// ── Extract the frontend originals from index.html ─────
// buildAuditPrompt: from its `function` keyword to the `}` just before the
// END-LOCKED-PROMPT marker, then eval to a live function.
function extractFrontendBuild() {
  const fnStart = html.indexOf('function buildAuditPrompt(target, isCandidate, isCommunity) {');
  const marker = html.indexOf('// ── END LOCKED PROMPT');
  assert.ok(fnStart !== -1, 'frontend buildAuditPrompt not found in index.html');
  assert.ok(marker !== -1 && marker > fnStart, 'END LOCKED PROMPT marker not found');
  const closeBrace = html.lastIndexOf('}', marker);
  const src = html.slice(fnStart, closeBrace + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src});`)();
}

// The analyze system message has MIGRATED to the backend and been removed from
// the frontend, so it can no longer be extracted from index.html. It was proven
// byte-identical to the frontend original before removal (this test passed at
// migration); the ongoing guard is a frozen snapshot against accidental drift.
const FROZEN_ANALYZE_SYSTEM = `You are the Integrity Index Auditor. Return ONLY valid JSON — no markdown fences, no prose before or after. Never truncate historicalBackground — it must be 2-3 full substantive paragraphs. For community leaders, civic and organizing records carry equal weight to legislative records when scoring Fruit and Evidence Quality. Use the web_search tool to verify claims, dates, vote counts, and recent activity against current sources before scoring; cite specific sources in the 'sources' array.`;

const frontendBuild = extractFrontendBuild();

// ── buildAuditPrompt: identical across the input matrix ─
test('buildAuditPrompt is byte-identical to the frontend original (input matrix)', () => {
  const targets = [
    'Billion Godson',
    'Shirley Chisholm (Jurisdiction: NY, Office: Congress)',
    'Prop 47 (Jurisdiction: CA, Year: 1994, Sponsor: Jane Doe)',
    'Name with "quotes" & symbols — em-dash, 100%',
    "O'Brien-Smith, Jr.",
    '',
  ];
  for (const target of targets) {
    for (const isCandidate of [true, false]) {
      for (const isCommunity of [true, false]) {
        assert.equal(
          backend.buildAuditPrompt(target, isCandidate, isCommunity),
          frontendBuild(target, isCandidate, isCommunity),
          `mismatch for target=${JSON.stringify(target)} cand=${isCandidate} comm=${isCommunity}`
        );
      }
    }
  }
});

// ── analyze system message: identical (default flag off) ─
test('ANALYZE_SYSTEM matches the frozen snapshot (proven-identical migrated value)', () => {
  assert.equal(backend.ANALYZE_SYSTEM, FROZEN_ANALYZE_SYSTEM);
});

test('analyzeSystem() returns the unmodified system message when #2 is off (default)', () => {
  // In the default env RF_DELIMIT_SUBJECT is unset, so no anti-injection suffix.
  assert.equal(backend.DELIMIT_SUBJECT, false);
  assert.equal(backend.analyzeSystem(), FROZEN_ANALYZE_SYSTEM);
});

// ── buildAuditTarget: matches the frontend assembly ────
test('buildAuditTarget reproduces the frontend target assembly', () => {
  assert.equal(buildAuditTarget({ name: 'Ada', subjectType: 'candidate' }), 'Ada');
  assert.equal(
    buildAuditTarget({ name: 'Ada', jurisdiction: 'NY', office: 'Mayor', subjectType: 'candidate' }),
    'Ada (Jurisdiction: NY, Office: Mayor)'
  );
  // office is candidate-only; year/sponsor are policy-only
  assert.equal(
    buildAuditTarget({ name: 'Ada', office: 'Mayor', year: '1994', sponsor: 'X', subjectType: 'candidate' }),
    'Ada (Office: Mayor)'
  );
  assert.equal(
    buildAuditTarget({ name: 'Prop 47', year: '1994', sponsor: 'Jane', office: 'Mayor', subjectType: 'policy' }),
    'Prop 47 (Year: 1994, Sponsor: Jane)'
  );

  // Reference implementation copied verbatim from the frontend autoAnalyze, to
  // catch any drift in the ported assembly logic.
  const ref = ({ name, jurisdiction, office, year, sponsor, subjectType }) => {
    let target = name;
    const extras = [];
    if (jurisdiction) extras.push('Jurisdiction: ' + jurisdiction);
    if (subjectType === 'candidate' && office) extras.push('Office: ' + office);
    if (subjectType === 'policy' && year) extras.push('Year: ' + year);
    if (subjectType === 'policy' && sponsor) extras.push('Sponsor: ' + sponsor);
    if (extras.length) target += ' (' + extras.join(', ') + ')';
    return target;
  };
  for (const f of [
    { name: 'A', subjectType: 'candidate' },
    { name: 'B', jurisdiction: 'J', office: 'O', year: 'Y', sponsor: 'S', subjectType: 'candidate' },
    { name: 'C', jurisdiction: 'J', office: 'O', year: 'Y', sponsor: 'S', subjectType: 'policy' },
  ]) {
    assert.equal(buildAuditTarget(f), ref(f));
  }
});
