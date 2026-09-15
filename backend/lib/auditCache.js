/**
 * Root & Fruit — shared audit cache (read-through, subject-keyed).
 *
 * An Integrity Index audit of a given subject is the same report no matter who
 * asks for it, and producing one costs an Opus call with web search. Auditing
 * the same subject once per user is the biggest cost and latency item in the
 * app — and it is what makes a Ballot Builder (10-30 candidates in one sitting)
 * impossible to price. So audits are cached globally, keyed by the subject and
 * every input that changes the report.
 *
 * What lands in the key (see `keyFor`): the normalized subject, the structured
 * subject fields (jurisdiction/office/year/sponsor), subjectType, pathway, the
 * MODEL, and PROMPT_VERSION — a hash of the locked prompt itself, so editing
 * `buildAuditPrompt` retires every cached audit scored under the old rubric
 * automatically. Nobody has to remember to flush.
 *
 * What this module deliberately does NOT cache: a user's adjusted scores or
 * justifications. Those are per-user edits of a shared baseline, and folding one
 * user's edits into a globally shared document would leak them to everyone else.
 * Only the AI baseline JSON is stored.
 *
 * Failure policy: the cache is an optimization and NEVER a dependency. Every
 * Firestore call is wrapped in a timeout + try/catch; a read error degrades to a
 * miss (the audit runs normally) and a write error is logged and swallowed. A
 * Firestore outage must slow audits down, not stop them.
 */

const crypto = require('node:crypto');
const prompts = require('./prompts');
const { cacheKey, normalizeSubject } = require('./cacheKey');

const COLLECTION = 'audit_cache';

// How long a cached audit stays servable. Records move — a new vote, a new
// endorsement, a scandal — so a cached audit is a "recent read", not a
// permanent one. Seven days is deliberately short: this is a tool people use to
// decide a vote, and during a campaign a week-old read of a candidate is
// already at the edge of useful. It costs more than a longer window would (the
// same subject is re-audited weekly instead of monthly), and that is the
// intended trade — freshness over margin. Set AUDIT_CACHE_TTL_DAYS=0 to disable
// the cache entirely, a kill switch that needs no code change.
const TTL_DAYS = Number.parseFloat(process.env.AUDIT_CACHE_TTL_DAYS ?? '7');
const TTL_MS = Number.isFinite(TTL_DAYS) && TTL_DAYS > 0 ? TTL_DAYS * 86400000 : 0;

// A hung Firestore call must not add its own latency to an audit that is going
// to run anyway. Past this, treat the read as a miss and move on.
const OP_TIMEOUT_MS = 3000;

/**
 * Fingerprint the locked audit prompt so a prompt edit invalidates the cache.
 *
 * Hashes the system message plus all three prompt variants (elected candidate,
 * community candidate, policy) against a fixed sentinel subject, so the digest
 * reflects the TEMPLATE only and changes the moment any branch of
 * `buildAuditPrompt` is edited. This is what keeps a rubric change from being
 * silently undone by month-old cached audits scored under the previous one.
 * @returns {string}  12-char hex digest of the current prompt text
 */
function promptVersion() {
  const SENTINEL = '__rf_prompt_fingerprint__';
  const material = [
    prompts.analyzeSystem(),
    prompts.buildAuditPrompt(SENTINEL, true, false),
    prompts.buildAuditPrompt(SENTINEL, true, true),
    prompts.buildAuditPrompt(SENTINEL, false, false)
  ].join(' ');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12);
}

const PROMPT_VERSION = promptVersion();

/**
 * Build the cache key for a set of subject fields.
 *
 * Every extra dimension is pushed through `normalizeSubject` first. That is not
 * cosmetic: the fields are raw user input, `cacheKey` joins dimensions with a
 * NUL separator, and normalization strips NUL (and every other non
 * letter/number/space character) — so a crafted `jurisdiction` cannot forge the
 * hash material of a different subject and poison its cache entry.
 * @param {object} fields  {name, subjectType, pathway, jurisdiction, office, year, sponsor, model}
 * @returns {{docId: string, normalized: string, dims: object}}
 *   docId: Firestore document ID; normalized: the normalized subject;
 *   dims: the normalized extra dimensions (stored for debugging)
 */
function keyFor(fields = {}) {
  const { name, subjectType, pathway, jurisdiction, office, year, sponsor, model } = fields;
  const dims = {
    subjectType: normalizeSubject(subjectType),
    // Pathway only changes the prompt for candidates; normalizing it away for a
    // policy keeps one policy audit from being split into two cache entries.
    pathway: subjectType === 'candidate' ? normalizeSubject(pathway) : '',
    jurisdiction: normalizeSubject(jurisdiction),
    office: normalizeSubject(office),
    year: normalizeSubject(year),
    sponsor: normalizeSubject(sponsor)
  };
  const { docId, normalized } = cacheKey(name, {
    ...dims,
    model: normalizeSubject(model),
    prompt: PROMPT_VERSION
  });
  return { docId, normalized, dims };
}

/**
 * Reject a promise that outruns a deadline, so a stalled Firestore call cannot
 * stall an audit.
 * @param {Promise} p     the operation
 * @param {number} ms     deadline in milliseconds
 * @returns {Promise<*>}  the operation's value, or a rejection on timeout
 */
function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('audit cache timeout')), ms); })
  ]);
}

/**
 * Re-dress a cached audit as an Anthropic message so a cache hit is
 * shape-identical to a live call and the frontend needs no special case.
 *
 * The stored value is the audit JSON text only — never the raw message. Raw
 * messages carry thinking and web-search result blocks that can approach
 * Firestore's 1MB document limit, and none of it is read back.
 * @param {{audit: string, createdAtMs: number}} entry  the cached record
 * @param {string} model  the model id to report
 * @returns {object}  an Anthropic-shaped message, plus `cached`/`cachedAt` flags
 */
function asMessage(entry, model) {
  return {
    id: 'cached_audit',
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: entry.audit }],
    usage: { input_tokens: 0, output_tokens: 0 },
    cached: true,
    cachedAt: new Date(entry.createdAtMs).toISOString()
  };
}

/**
 * Create the audit cache bound to a Firestore instance.
 * @param {import('@google-cloud/firestore').Firestore|null} db  Firestore client,
 *        or null to run disabled (no project configured, or tests)
 * @returns {{get: Function, put: Function, keyFor: Function, enabled: boolean}}
 *          the cache API; `get` resolves to a record or null, `put` to a boolean
 */
function createAuditCache(db) {
  const enabled = Boolean(db) && TTL_MS > 0;

  /**
   * Read a cached audit for these subject fields.
   * @param {object} fields  subject fields (see keyFor)
   * @returns {Promise<{audit: string, createdAtMs: number, docId: string}|null>}
   *          the record, or null on a miss, an expired entry, or any error
   */
  async function get(fields) {
    if (!enabled) return null;
    const { docId } = keyFor(fields);
    try {
      const snap = await withTimeout(db.collection(COLLECTION).doc(docId).get(), OP_TIMEOUT_MS);
      if (!snap.exists) return null;
      const data = snap.data() || {};
      const createdAtMs = Number(data.createdAtMs) || 0;
      if (!data.audit || !createdAtMs) return null;
      if (Date.now() - createdAtMs > TTL_MS) return null;
      // Hit counting is economics telemetry, not correctness — never block the
      // response on it (same pattern as the share-link view counter).
      snap.ref.update({ hits: (Number(data.hits) || 0) + 1 }).catch(() => {});
      return { audit: data.audit, createdAtMs, docId };
    } catch (err) {
      console.warn('Audit cache read failed (serving a miss):', err.message);
      return null;
    }
  }

  /**
   * Store an audit for these subject fields, overwriting any expired entry.
   * @param {object} fields  subject fields (see keyFor)
   * @param {string} audit   the validated audit JSON text
   * @returns {Promise<boolean>}  true when written; false when disabled or on error
   *          (side effect: one Firestore write)
   */
  async function put(fields, audit) {
    if (!enabled || typeof audit !== 'string' || !audit) return false;
    const { docId, normalized, dims } = keyFor(fields);
    try {
      await withTimeout(db.collection(COLLECTION).doc(docId).set({
        audit,
        subjectNormalized: normalized,
        dims,
        model: fields.model || null,
        promptVersion: PROMPT_VERSION,
        createdAtMs: Date.now(),
        createdAt: new Date().toISOString(),
        hits: 0
      }), OP_TIMEOUT_MS);
      return true;
    } catch (err) {
      console.warn('Audit cache write failed (audit still served):', err.message);
      return false;
    }
  }

  return { get, put, keyFor, enabled };
}

module.exports = {
  createAuditCache,
  keyFor,
  asMessage,
  promptVersion,
  PROMPT_VERSION,
  TTL_MS,
  COLLECTION
};
