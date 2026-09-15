/**
 * Root & Fruit — address to districts, via the US Census Bureau geocoder.
 *
 * A ballot is defined by the districts a residence sits in, and working those
 * out is a geospatial problem: geocode the address, then test the point against
 * district boundaries. It is not a search-and-read task, and asking a model to
 * do it does not work — a traced attempt burned its search budget in seconds and
 * then spent over two and a half minutes in code execution without ever
 * producing an answer. So the deterministic half is done deterministically here,
 * and the model is left with the part it is good at: finding who is running in
 * districts that have already been named.
 *
 * Why the Census geocoder specifically:
 *   - official, free, and needs NO API KEY (that is api.census.gov, the separate
 *     Census *Data* API, which does require one — different service)
 *   - sub-second, and exact rather than inferred
 *   - it means the street address NEVER reaches Anthropic. Only district names
 *     do. The address goes from our backend to a US government API and stops
 *     there, which is strictly better than putting it in a prompt.
 *
 * What it does not cover: municipal districts — city council, school board,
 * judicial subdistricts — are not in Census geography. Those races stay
 * unresolved and the ballot must say so rather than guess.
 *
 * Failure policy: this is a free public service with no SLA. Every failure is
 * reported, never guessed around, because the failure mode has to be "no
 * ballot", never "a confident wrong ballot".
 */

const GEOCODER = 'https://geocoding.geo.census.gov/geocoder/geographies/address';

// Current vintage of the current benchmark: the districts in effect now.
const BENCHMARK = 'Public_AR_Current';
const VINTAGE = 'Current_Current';

// The geocoder is usually sub-second. Past this it is not going to help, and a
// voter is waiting.
const TIMEOUT_MS = 8000;

/**
 * Pull a named geography out of a Census `geographies` object.
 *
 * Matched by substring rather than exact key because the key names carry the
 * Congress number and redistricting year — "119th Congressional Districts",
 * "2024 State Legislative Districts - Upper" — and those change underneath us.
 * An exact-key lookup would silently return nothing after the next cycle.
 * @param {object} geographies  the geographies map from an address match
 * @param {string[]} must  substrings that must all appear in the key
 * @returns {{name: string, code: string}|null}  the district, or null if absent
 */
function pickGeography(geographies, must) {
  const key = Object.keys(geographies || {}).find((k) => must.every((m) => k.includes(m)));
  if (!key) return null;
  const entry = (geographies[key] || [])[0];
  if (!entry) return null;
  return {
    name: entry.NAME || entry.BASENAME || '',
    code: entry.BASENAME || ''
  };
}

/**
 * Resolve a street address to the districts that define its ballot.
 * @param {{street: string, city?: string, state: string, zip?: string}} addr
 *        the voter's address; `state` is a two-letter code
 * @returns {Promise<{ok: true, matchedAddress: string, county: string|null,
 *                    congressional: string|null, stateSenate: string|null,
 *                    stateHouse: string|null}
 *                 | {ok: false, reason: 'no_match'|'unavailable', detail: string}>}
 *          resolved districts, or a typed failure. Never throws.
 *          (side effect: one outbound request to the Census geocoder)
 */
async function resolveDistricts(addr = {}) {
  const params = new URLSearchParams({
    street: addr.street || '',
    city: addr.city || '',
    state: addr.state || '',
    zip: addr.zip || '',
    benchmark: BENCHMARK,
    vintage: VINTAGE,
    format: 'json'
  });

  let payload;
  try {
    const res = await fetch(`${GEOCODER}?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
      return { ok: false, reason: 'unavailable', detail: `census ${res.status}` };
    }
    payload = await res.json();
  } catch (err) {
    // Timeout, DNS, TLS, malformed JSON — all the same to the caller: we could
    // not resolve districts, so there is no ballot to build.
    return { ok: false, reason: 'unavailable', detail: err.name === 'TimeoutError' ? 'census timeout' : err.message };
  }

  const match = ((payload.result || {}).addressMatches || [])[0];
  if (!match) {
    return { ok: false, reason: 'no_match', detail: 'the geocoder did not recognise that address' };
  }

  const g = match.geographies || {};
  const county = pickGeography(g, ['Counties']);
  const congressional = pickGeography(g, ['Congressional']);
  const upper = pickGeography(g, ['Legislative', 'Upper']);
  const lower = pickGeography(g, ['Legislative', 'Lower']);

  return {
    ok: true,
    matchedAddress: match.matchedAddress || '',
    county: county ? county.name : null,
    congressional: congressional ? congressional.name : null,
    stateSenate: upper ? upper.name : null,
    stateHouse: lower ? lower.name : null
  };
}

/**
 * Summarize which districts came back, for logging without the address.
 * @param {object} resolved  a successful resolveDistricts result
 * @returns {string[]}  names of the district types that resolved
 */
function resolvedKinds(resolved) {
  return ['county', 'congressional', 'stateSenate', 'stateHouse'].filter((k) => resolved && resolved[k]);
}

module.exports = { resolveDistricts, resolvedKinds, pickGeography, GEOCODER, TIMEOUT_MS };
