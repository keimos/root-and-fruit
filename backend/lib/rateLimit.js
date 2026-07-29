/**
 * Rate limiting for the API surface — Option A: express-rate-limit with the
 * default in-memory store.
 *
 * The limiter guards the routes that cost real money or send real email —
 * /api/analyze + /api/search (each a billed Anthropic call) and /api/register
 * (Firestore write + two Resend emails) — plus a looser blanket limiter over the
 * rest of /api/*. It bounds a runaway loop or a single abusive caller.
 *
 * CAVEAT (per-instance): the in-memory store keeps a counter PER Cloud Run
 * instance. With `--max-instances N` the real ceiling is up to N × the limit,
 * and counters are not shared across instances. That is an intentional trade —
 * it stays stateless-friendly (no Firestore/Redis round-trip per request) and
 * is a coarse cost/abuse backstop, not a precise global quota. For an exact
 * global cap, back the money routes with a shared store (Firestore/Redis) or
 * add an edge limiter (Cloud Armor). See CLAUDE.md.
 */

const rateLimit = require('express-rate-limit');

/**
 * Parse an integer from an env string, falling back to a default.
 * @param {string|undefined} raw  the raw env value
 * @param {number} def            fallback when raw is missing / non-numeric / <= 0
 * @returns {number}              a positive integer
 */
function intFromEnv(raw, def) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Build one configured express-rate-limit middleware.
 * @param {object} opts
 * @param {number} opts.windowMs  sliding window length, in milliseconds
 * @param {number} opts.limit     max requests per window per client key (IP)
 * @param {string} opts.label     short name surfaced in the 429 body
 * @returns {import('express').RequestHandler}  the limiter middleware
 */
function makeLimiter({ windowMs, limit, label }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7', // emit RateLimit-* headers so clients can back off
    legacyHeaders: false,       // drop the deprecated X-RateLimit-* headers
    message: { error: `Too many requests (${label}). Please slow down and try again shortly.` },
  });
}

/**
 * Build the app's rate limiters from env config, applying production defaults.
 * Per-window limits (60s window by default) are tuned to the cost of each route:
 * AI calls are billed, register sends email, the rest are cheap Firestore ops.
 * @param {NodeJS.ProcessEnv} [env=process.env]  environment to read config from
 * @returns {{ ai: import('express').RequestHandler,
 *             register: import('express').RequestHandler,
 *             api: import('express').RequestHandler }}  three limiter middlewares
 */
function buildLimiters(env = process.env) {
  const windowMs = intFromEnv(env.RATE_LIMIT_WINDOW_MS, 60_000);
  return {
    // Billed Anthropic calls (/api/analyze, /api/search) — tightest.
    ai: makeLimiter({ windowMs, limit: intFromEnv(env.RATE_LIMIT_AI, 15), label: 'ai' }),
    // Firestore write + two emails (/api/register) — tight (anti-spam).
    register: makeLimiter({ windowMs, limit: intFromEnv(env.RATE_LIMIT_REGISTER, 5), label: 'register' }),
    // Blanket cap over the rest of /api/* (cheap Firestore reads/writes).
    api: makeLimiter({ windowMs, limit: intFromEnv(env.RATE_LIMIT_API, 100), label: 'api' }),
  };
}

module.exports = { buildLimiters, makeLimiter, intFromEnv };
