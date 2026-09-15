/**
 * Ballot availability window — node:test, pure.
 *
 * The gate exists because of what the data does, not as a product preference: a
 * ballot lookup for an election whose candidate filing has not closed does not
 * come back empty, it does not come back at all. The same query against a
 * settled election answers in about 24 seconds. So the window is enforced, and
 * these pin the boundary, the override, and the failure mode of a bad override.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const w = require('../lib/ballotWindow');

test('closed the instant before the open date, open from it onward', () => {
  const open = w.AVAILABLE_FROM.getTime();
  assert.equal(w.isBallotOpen(open - 1), false);
  assert.equal(w.isBallotOpen(open), true, 'open AT the boundary, not after it');
  assert.equal(w.isBallotOpen(open + 86400000), true);
});

test('availability reports the date and readable copy in both states', () => {
  const open = w.AVAILABLE_FROM.getTime();
  const before = w.availability(open - 1000);
  assert.equal(before.open, false);
  assert.equal(before.availableFrom, w.AVAILABLE_FROM.toISOString());
  assert.match(before.message, /opens/i, 'tells the visitor when to come back');

  const after = w.availability(open);
  assert.equal(after.open, true);
  assert.match(after.message, /open/i);
});

// The shipped default is the pilot date; a deploy that forgets the env var must
// still gate correctly rather than defaulting to wide open.
test('the default open date is the pilot date, in US Central', () => {
  assert.equal(w.DEFAULT_OPEN, '2026-10-08T00:00:00-05:00');
  assert.equal(new Date(w.DEFAULT_OPEN).toISOString(), '2026-10-08T05:00:00.000Z');
});

// The displayed day must be the one the operator wrote, whatever offset they
// wrote it with. Formatting the parsed instant in a named timezone does NOT do
// that: 2099-01-01T00:00:00-05:00 rendered in America/Chicago reads
// "December 31", and the shipped October default hides it because October is
// also -05:00. Every visitor would have been told to come back a day early.
test('the displayed date is the configured calendar date, not a re-zoned one', () => {
  const cases = [
    ['2099-01-01T00:00:00-05:00', 'January 1'],
    ['2026-10-08T00:00:00-05:00', 'October 8'],
    ['2026-10-08T00:00:00-07:00', 'October 8'],
    ['2026-03-01T00:00:00+00:00', 'March 1'],
  ];
  const orig = process.env.BALLOT_AVAILABLE_FROM;
  try {
    for (const [value, expected] of cases) {
      process.env.BALLOT_AVAILABLE_FROM = value;
      delete require.cache[require.resolve('../lib/ballotWindow')];
      const reloaded = require('../lib/ballotWindow');
      assert.equal(reloaded.OPEN_LABEL, expected, `${value} must display as ${expected}`);
    }
  } finally {
    if (orig === undefined) delete process.env.BALLOT_AVAILABLE_FROM; else process.env.BALLOT_AVAILABLE_FROM = orig;
    delete require.cache[require.resolve('../lib/ballotWindow')];
  }
});

// A typo in the override must not open the gate forever or close it forever.
test('a malformed override falls back to the shipped default', () => {
  const orig = process.env.BALLOT_AVAILABLE_FROM;
  process.env.BALLOT_AVAILABLE_FROM = 'not-a-date';
  try {
    delete require.cache[require.resolve('../lib/ballotWindow')];
    const reloaded = require('../lib/ballotWindow');
    assert.equal(reloaded.AVAILABLE_FROM.toISOString(), new Date(reloaded.DEFAULT_OPEN).toISOString());
  } finally {
    if (orig === undefined) delete process.env.BALLOT_AVAILABLE_FROM; else process.env.BALLOT_AVAILABLE_FROM = orig;
    delete require.cache[require.resolve('../lib/ballotWindow')];
  }
});
