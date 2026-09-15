/**
 * Root & Fruit — when the Ballot Builder is open for business.
 *
 * A ballot cannot be built before candidate filing closes, because until then
 * there is no authoritative list of who is running. This is not a policy choice
 * dressed up as a constraint — it is what the data actually does. Asking for a
 * ballot in an election whose filing has not closed does not return an empty
 * result; it returns nothing at all. A traced attempt searched, found no filed
 * candidates, and then ground on for minutes without ever concluding, because
 * "nobody has filed yet" is not an answer a search can confirm. The identical
 * query against a past, settled election answered correctly in 24 seconds.
 *
 * So the feature is date-gated rather than left to fail. Before the open date
 * the route refuses immediately, cheaply, and without charging anyone, and the
 * UI says when to come back instead of spinning.
 *
 * BALLOT_AVAILABLE_FROM overrides the date (ISO 8601, offset included). The
 * default is anchored to US Central: the pilot states span Central and Pacific,
 * and picking the earlier zone means nobody is told "not yet" on a morning the
 * date has already arrived where they live.
 */

const DEFAULT_OPEN = '2026-10-08T00:00:00-05:00';

const raw = process.env.BALLOT_AVAILABLE_FROM || DEFAULT_OPEN;
const parsed = new Date(raw);
// A malformed override must not silently open the gate forever or close it
// forever; fall back to the shipped default and say so.
const AVAILABLE_FROM = Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_OPEN) : parsed;
if (Number.isNaN(parsed.getTime())) {
  console.error(`CONFIG ERROR: BALLOT_AVAILABLE_FROM="${raw}" is not a valid date — using ${DEFAULT_OPEN}`);
}

/**
 * Is the Ballot Builder open yet?
 * @param {Date|number} [now]  the moment to test, for tests; defaults to now
 * @returns {boolean}  true once the open date has passed
 */
function isBallotOpen(now = Date.now()) {
  return new Date(now).getTime() >= AVAILABLE_FROM.getTime();
}

// The day we SAY it opens is taken straight from the configured date string,
// not by re-formatting the parsed instant in some timezone. Those disagree: a
// value of 2099-01-01T00:00:00-05:00 rendered in America/Chicago reads
// "December 31", because midnight at -05:00 is still the previous evening in
// Central. The shipped October default happens to survive that (October is
// CDT, also -05:00), so the bug would have stayed hidden until someone changed
// the date and every visitor was told to come back a day early. Reading the
// calendar date the operator actually wrote removes the whole class of error.
const OPEN_LABEL = (() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw) || /^(\d{4})-(\d{2})-(\d{2})/.exec(DEFAULT_OPEN);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
})();

/**
 * The availability facts the UI needs to render a "come back on..." panel
 * without having to make a failing request first.
 * @param {Date|number} [now]  the moment to describe; defaults to now
 * @returns {{open: boolean, availableFrom: string, message: string}}
 *          open state, the ISO open date, and display copy
 */
function availability(now = Date.now()) {
  const open = isBallotOpen(now);
  const when = OPEN_LABEL;
  return {
    open,
    availableFrom: AVAILABLE_FROM.toISOString(),
    message: open
      ? 'The Ballot Builder is open.'
      : `The Ballot Builder opens ${when}. Candidate filing closes first — until then there is no ballot to build.`
  };
}

module.exports = { isBallotOpen, availability, AVAILABLE_FROM, DEFAULT_OPEN, OPEN_LABEL };
