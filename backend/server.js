/**
 * Root & Fruit — Backend API Server
 * Handles: Anthropic API proxy, Firestore persistence, CORS
 */

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const prompts = require('./lib/prompts');
const { buildLimiters } = require('./lib/rateLimit');
const auth = require('./lib/auth');
const creditsLib = require('./lib/credits');
const plansLib = require('./lib/plans');
const stripeEvents = require('./lib/stripeEvents');

const app = express();
const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';
// `let` (not const) so tests can inject a mock client via __setAnthropic below.
let anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── Transient-error retry ──────────────────────────────
// Anthropic occasionally returns 429 (rate limit) or 529 (fleet overloaded),
// plus transient 5xx / network errors. These are load-driven and unrelated to
// the request content, so the right response is exponential backoff + retry.
// The SDK already retries a couple times internally; this outer loop covers the
// cases where the fleet is overloaded for longer than the SDK's own window.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status != null) return RETRYABLE_STATUS.has(status);
  // No status → network/connection error (ECONNRESET, timeouts, etc.).
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Report an upstream (Anthropic) failure to the client WITHOUT forwarding its
 * status code or message.
 *
 * Forwarding either conflates a provider problem with a caller problem, and the
 * frontend routes on status: an upstream 401 (our key rotated/revoked) became
 * "Please sign in again" + the sign-in modal, so a dead API key looked exactly
 * like the audit button logging the user out. The same trap sits behind other
 * codes — Anthropic's 400 ("credit balance too low") reads as a malformed client
 * request, and its 429 is indistinguishable from the `limiters.ai` 429 that
 * really does mean "you clicked too fast".
 *
 * So every upstream failure becomes a 502 with a generic message; the real
 * status and message are logged server-side. This matches what the billing
 * routes already do with Stripe errors rather than inventing a second rule.
 * @param {import('express').Response} res  response to write
 * @param {*} err       the caught error (Anthropic SDK error, or a network error
 *                      with no `.status`)
 * @param {string} label  log label, e.g. 'analyze' / 'search'
 * @returns {void}  none (side effects: console.error, response sent)
 */
function sendUpstreamFailure(res, err, label) {
  console.error(`${label} upstream error:`, err?.status ?? 'network', err?.message);
  res.status(502).json({ error: 'The AI service is unavailable right now. Please try again.' });
}

async function withRetry(fn, { retries = 3, baseDelay = 500, label = 'anthropic' } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isRetryable(err)) throw err;
      // Exponential backoff with jitter: ~0.5s, ~1s, ~2s (+/- up to baseDelay).
      const delay = baseDelay * 2 ** (attempt - 1) + Math.random() * baseDelay;
      const status = err?.status ?? err?.response?.status ?? 'network';
      console.warn(`${label} retry ${attempt}/${retries} after ${status} — waiting ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}

// ── Request guardrails (bound abuse of the LLM proxy) ──
// The prompt is built client-side (the locked prompt lives in the frontend), so
// /api/analyze and /api/search must bound what a hostile or buggy caller — one
// hitting the backend directly, bypassing the UI — can drive: clamp the token
// budget + search rounds into a safe range and reject oversized prompts. The
// model is NOT client-selectable (fixed to MODEL), so there's nothing to
// allowlist there. This touches request LIMITS only, never prompt CONTENT — the
// locked prompt is unaffected.
const LIMITS = {
  analyzeMaxTokens: 32000, // UI sends 16000
  searchMaxTokens: 8000,   // UI sends 3000
  searchMaxUses: 5,        // UI sends 4
  promptChars: 200000      // UI prompt is ~10KB; caps giant-prompt abuse
};

/**
 * Coerce a client-supplied value to an integer clamped into [min, max].
 * Only real numbers or non-empty numeric strings count; anything else (missing,
 * null, '', or non-numeric) falls back to def — Number(null)/Number('')/etc. are
 * all 0 in JS, so we guard on type before coercing rather than trusting Number().
 * @param {*} v         raw value (may be missing, a string, NaN, or out of range)
 * @param {number} min  lower bound (inclusive)
 * @param {number} max  upper bound (inclusive)
 * @param {number} def  fallback used when v is not a usable number
 * @returns {number}    an integer in [min, max]
 */
function clampInt(v, min, max, def) {
  let n = def;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Approximate character size of a system + messages prompt payload, used to
 * reject oversized requests before they reach the Anthropic API.
 * @param {(string|Array|undefined)} system  system prompt (string or block array)
 * @param {Array} messages                    the messages array
 * @returns {number}                          total character count of the payload
 */
function promptSize(system, messages) {
  let n = 0;
  if (typeof system === 'string') n += system.length;
  else if (Array.isArray(system)) n += JSON.stringify(system).length;
  n += JSON.stringify(messages || []).length;
  return n;
}

// ── Email (Resend) ─────────────────────────────────────
// RESEND_API_KEY enables registration emails. REGISTRATION_FROM must be a
// verified sender on your Resend domain in production; the resend.dev sandbox
// address only delivers to the Resend account owner. REGISTRATION_EMAIL is the
// inbox that receives new-registration notifications.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const REGISTRATION_EMAIL = process.env.REGISTRATION_EMAIL || 'rootandfruit@wetheanvil.org';
const REGISTRATION_FROM = process.env.REGISTRATION_FROM || 'Root & Fruit <onboarding@resend.dev>';
// Donation CTA link for the registrant auto-reply. If unset, the auto-reply
// omits the donation line entirely rather than shipping a placeholder.
const DONATION_URL = process.env.DONATION_URL || '';
const AUTO_REPLY_SUBJECT = "Welcome to Root & Fruit: You're Part of Something Bigger";

async function sendResendEmail({ to, subject, text, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: REGISTRATION_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
  return res.json();
}

function buildAutoReplyBody(firstName) {
  const donationLine = DONATION_URL
    ? `SUPPORT THE ANVIL INSTITUTE: ${DONATION_URL}\n\n`
    : '';
  return `Dear ${firstName},

Welcome to the Root & Fruit Integrity Index. You just joined something that matters. Root & Fruit was built on a simple conviction: by their fruits, shall you know them. Not their rhetoric. Their record.

You're now connected to a tool rooted in 240 years of Free African civic tradition, from the Free African Society of 1787 straight to you and every community member who ever had to size up a candidate or policy with nothing but a voter guide and their own good sense. We built Root & Fruit to sharpen that judgment, and foster more informed community conversation.

Root & Fruit, its scoring framework, the audit reports, the community assessment: all of it was designed to bring information right to the hands of the people and we need your support to keep it going, growing and accessible without compromise. If you believe this kind of tool should exist, please consider making a donation of your choosing to help us to continue building tools that meet the needs of our community.

${donationLine}The Anvil Institute is a 501(c)(3) nonprofit charitable organization. Your donation is tax-deductible to the extent permitted by law.

Your support keeps this work in the hands of the people, not the politicians.

Thank you for your support and dedication. Now go out and make the change you want to see!

In solidarity,

Kirkpatrick (Kp) Tyler
Executive Director
The Anvil Institute · 501(c)(3) Nonprofit Charitable Organization

© 2026 Cast Your Net Media and Technologies · The Anvil Institute · Free African Alliance
rootandfruit.app`;
}

// ── Firestore ──────────────────────────────────────────
const db = new Firestore({ projectId: PROJECT_ID });
const COLLECTION = 'audits';

// ── Credits ────────────────────────────────────────────
// Balances live in Firestore and are debited server-side before every billed
// Anthropic call. `let` (not const) so tests can inject a fake via __setCredits.
let credits = creditsLib.createCredits(db);

// ── Middleware ─────────────────────────────────────────
// Cloud Run terminates TLS at Google's front end and forwards the real client
// IP in X-Forwarded-For. Trust that single proxy hop so the rate limiter keys
// on the actual client, not the shared front-end address. Override the hop
// count with TRUST_PROXY_HOPS if the platform inserts more proxies.
app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1);

// ── Stripe webhook (MUST be mounted before express.json) ──
// Signature verification hashes the EXACT bytes Stripe sent. Any body parser
// that runs first replaces the raw Buffer with a parsed object and the
// signature can never validate again — so this route is registered above the
// JSON parser on purpose. Moving it below silently breaks every webhook.
//
// It also sits OUTSIDE /api/, which keeps it clear of the per-IP rate limiters
// mounted there: throttling Stripe would turn a retry burst into 429s, and
// Stripe eventually disables an endpoint that keeps failing.
app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhookHandler);

app.use(express.json({ limit: '2mb' }));
// Local-dev fallback, used only when ALLOWED_ORIGIN is unset. The frontend dev
// server listens on 8080 (see "Local dev" in CLAUDE.md); a dev running it on
// another port sets ALLOWED_ORIGIN explicitly.
const DEV_ORIGINS = Object.freeze(['http://localhost:8080', 'http://127.0.0.1:8080']);

/**
 * Parse ALLOWED_ORIGIN into the origin allowlist handed to the `cors` package.
 *
 * A LIST, not a single string, because one deployment legitimately answers on
 * several origins: Cloud Run serves every service on two URL formats
 * (`<svc>-<hash>-<region>.a.run.app` and `<svc>-<projectNumber>.<region>.run.app`),
 * and a custom domain adds a third. With only one configured, a browser on any
 * other one gets a preflight whose Allow-Origin does not match, silently drops
 * the real request, and the app looks broken with nothing in the server logs
 * but an OPTIONS 204.
 *
 * `*` is NOT supported — not as the default, and not as an explicit value.
 * A wildcard here was only ever harmless by accident: nothing relies on ambient
 * browser credentials today (auth is a Bearer ID token, and `credentials` is
 * deliberately never enabled below), so `*` exposed nothing curl could not
 * already reach. But that safety is incidental rather than structural — the
 * first cookie or `credentials: true` added anywhere in this app would turn it
 * into an account-takeover path, with nothing in that diff pointing back here.
 * Unset falls back to DEV_ORIGINS, which keeps `npm run dev` working without a
 * wildcard ever appearing in the source.
 * @param {string|undefined} raw  comma-separated origins ('*' entries dropped)
 * @returns {string[]}  a concrete origin allowlist, never a wildcard
 */
function parseAllowedOrigins(raw) {
  const list = String(raw || '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
  return list.length ? list : [...DEV_ORIGINS];
}
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGIN);

// Mirrors the APP_URL guard further down: ALLOWED_ORIGIN is optional, so a
// deploy that drops it silently narrows CORS to localhost and every browser
// request from the real frontend dies at its preflight — an OPTIONS 204 and no
// server-side error. Say so at boot instead.
const ALLOWED_ORIGINS_CONFIGURED =
  ALLOWED_ORIGINS.length !== DEV_ORIGINS.length ||
  ALLOWED_ORIGINS.some((origin, i) => origin !== DEV_ORIGINS[i]);
if (!ALLOWED_ORIGINS_CONFIGURED && process.env.NODE_ENV === 'production') {
  console.error(
    'CONFIG ERROR: ALLOWED_ORIGIN is not set, so CORS admits only ' + DEV_ORIGINS.join(', ') + '. ' +
    'Browser requests from the deployed frontend will fail their preflight.'
  );
}

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // The billed routes report the post-debit balance in a header so the UI can
  // update its counter without a second round-trip. Cross-origin readers only
  // see custom headers that are explicitly exposed.
  exposedHeaders: ['X-Credit-Balance']
}));

// ── Rate limiting (Option A: per-instance in-memory backstop) ──
// Blanket cap over every /api/* route; stricter per-route limiters (below) stack
// on top of it for the billed Anthropic calls and the email-sending register
// route. See lib/rateLimit.js for the per-instance caveat.
const limiters = buildLimiters();
app.use('/api/', limiters.api);

// ── Authentication (Firebase ID-token verification, additive) ──
// Verifies a `Authorization: Bearer <idToken>` if present and attaches req.user;
// requests without a valid token continue as anonymous (the per-browser flow is
// preserved). Routes that own user data (audits) prefer req.user.uid over any
// client-supplied id so a signed-in user cannot be spoofed. See lib/auth.js.
app.use('/api/', auth.optionalAuth());

/**
 * Refuse billed work for an account whose email address is not verified.
 *
 * Defence in depth alongside the grant gate in credits.ensureAccount(): an
 * unverified account is free to mint, so anything it can spend money on is
 * effectively unmetered. Free-of-charge work (the automatic Electability
 * lookup) is deliberately left open — blocking it would break a call the user
 * never asked for. Sends the 403 itself so callers can `return` on false.
 * @param {import('express').Request} req   the request (req.user is set by requireAuth)
 * @param {import('express').Response} res  the response, written on refusal
 * @param {string} kind  the work kind, as keyed in credits CREDIT_COSTS
 * @returns {boolean}  true when the caller may proceed; false once a 403 is sent
 */
function billableAllowed(req, res, kind) {
  if (creditsLib.creditCost(kind) <= 0) return true;
  if (req.user && req.user.emailVerified) return true;
  res.status(403).json({
    error: 'Email verification required',
    code: 'email_unverified'
  });
  return false;
}

// ── Stripe ─────────────────────────────────────────────
// `let` (not const) so tests can inject a mock client via __setStripe below.
// Both values come from Secret Manager in production; absent locally, the
// billing routes stay dormant and the rest of the app is unaffected.
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
let stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Handle a Stripe webhook delivery: verify the signature, interpret the event,
 * and apply it to the account.
 *
 * Status-code contract, which is really a retry contract — Stripe retries any
 * non-2xx with backoff and eventually disables an endpoint that keeps failing:
 *   - 400 → the signature did not verify. Not from Stripe (or the wrong secret);
 *           retrying cannot help, and answering 200 would invite forgeries.
 *   - 200 → handled, OR permanently unactionable (unknown event type, no uid,
 *           no credit metadata). Retrying these forever achieves nothing, so we
 *           log loudly and ack.
 *   - 500 → transient (Firestore unavailable). We WANT Stripe to retry, and
 *           addCredits() is idempotent per event id, so a retry is safe.
 * @param {import('express').Request} req   raw-body request (see the mount site)
 * @param {import('express').Response} res  the response
 * @returns {Promise<void>}  responds directly; side effects: Firestore writes
 */
async function stripeWebhookHandler(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.error('Stripe webhook received but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are not configured');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const intent = stripeEvents.intentFromEvent(event);
  if (!intent) return res.json({ received: true, ignored: event.type });

  try {
    // The uid rides on metadata we stamp at checkout; the customer lookup covers
    // anything created outside that flow (or by an older build).
    const uid = intent.uid || await credits.uidByCustomer(intent.customerId);
    if (!uid) {
      console.error('Stripe webhook could not resolve a uid:', event.type, event.id, intent.customerId);
      return res.json({ received: true, unresolved: true });
    }

    if (intent.kind === 'subscription') {
      await credits.setSubscription(uid, {
        subscriptionId: intent.subscriptionId,
        status: intent.status,
        customerId: intent.customerId
      });
      return res.json({ received: true, uid, status: intent.status });
    }

    // kind === 'grant'
    const plan = intent.credits == null ? await plansLib.planById(stripe, intent.priceId) : null;
    const perUnit = intent.credits ?? plan?.credits ?? 0;
    if (perUnit <= 0) {
      // A price with no `credits` metadata is a catalog problem, not a transient
      // one — the customer paid, so this needs a human, not a retry loop.
      console.error('Stripe payment with no resolvable credits:', event.id, intent.priceId);
      return res.json({ received: true, unresolved: true });
    }

    const amount = plansLib.scaleCredits(perUnit, intent.quantity);
    const receipt = await credits.addCredits(uid, {
      amount,
      bucket: intent.bucket,
      reason: intent.reason,
      eventId: event.id,
      ref: intent.ref,
      // Only subscription accrual is capped (see credits.rolloverCap).
      cap: intent.bucket === 'cycle' ? creditsLib.rolloverCap(amount) : null
    });

    // Keep plan/status current off the same payment, so an active subscriber is
    // never shown as inactive just because the lifecycle event arrived first.
    //
    // Skipped on a duplicate: a redelivery of an old invoice.paid carries no new
    // information, and writing 'active' from it would resurrect a subscription
    // that has since been cancelled.
    if (intent.subscriptionId && !receipt.duplicate) {
      await credits.setSubscription(uid, {
        subscriptionId: intent.subscriptionId,
        status: 'active',
        plan: plan?.name || null,
        customerId: intent.customerId
      });
    }

    console.log('Stripe grant:', {
      event: event.id, type: event.type, uid,
      granted: receipt.granted, forfeited: receipt.forfeited, duplicate: receipt.duplicate
    });
    return res.json({ received: true, granted: receipt.granted, duplicate: receipt.duplicate });
  } catch (err) {
    if (err instanceof creditsLib.UnknownAccountError) {
      console.error('Stripe payment for a uid with no account:', event.id, err.uid);
      return res.json({ received: true, unresolved: true });
    }
    // Transient — let Stripe retry into the idempotent path.
    console.error('Stripe webhook error:', event.type, event.id, err);
    return res.status(500).json({ error: 'Webhook handling failed' });
  }
}

// ── Health check ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Claude agent: Integrity Index Auditor ─────────────
// Keeps the API key server-side; never exposed to the browser.
// Uses adaptive thinking + server-side web_search so the model
// can verify claims against current sources instead of relying
// solely on its training cutoff.
app.post('/api/analyze', limiters.ai, auth.requireAuth(), auth.liveEmailVerification(), async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'API key not configured' });

  // Injection fix #1: the client sends only structured subject fields — the
  // audit prompt is assembled HERE from the locked template, so a caller (incl.
  // one hitting this endpoint directly) cannot supply or override the system
  // prompt. buildAuditPrompt/analyzeSystem are byte-for-byte the former
  // client-side prompt (proven by test/prompts.equivalence.test.js).
  const { name, subjectType, pathway, jurisdiction, office, year, sponsor } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const target = prompts.buildAuditTarget({ name: name.trim(), jurisdiction, office, year, sponsor, subjectType });
  const systemText = prompts.analyzeSystem();
  const messages = [{ role: 'user', content: prompts.buildAuditPrompt(target, subjectType === 'candidate', pathway === 'community') }];

  // Guardrails still apply — bound the assembled prompt (a giant subject field
  // is the only remaining size lever) and clamp the token budget.
  if (promptSize(systemText, messages) > LIMITS.promptChars) {
    return res.status(413).json({ error: 'prompt too large' });
  }
  const max_tokens = clampInt(req.body.max_tokens, 1, LIMITS.analyzeMaxTokens, 16000);

  // Attach cache_control so repeated audits can hit the prompt cache once the
  // prefix grows past the model's minimum threshold (a no-op below it).
  const systemBlocks = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];

  // Reserve the credit before spending money on the model. A 402 here is what
  // drives the upsell in the UI; the charge is reversed below if Anthropic fails.
  if (!billableAllowed(req, res, 'analyze')) return;
  let charge;
  try {
    charge = await credits.debit(req.user.uid, { kind: 'analyze', ref: name.trim() });
  } catch (err) {
    if (err instanceof creditsLib.InsufficientCreditsError) {
      return res.status(402).json({ error: 'Insufficient credits', balance: err.balance, required: err.required });
    }
    console.error('Credit debit error:', err);
    return res.status(500).json({ error: 'Could not verify credit balance' });
  }

  try {
    const message = await withRetry(() => {
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens,
        system: systemBlocks,
        messages,
        thinking: { type: 'adaptive' },
        // Low effort trims thinking depth/tokens — this is a structured
        // extract-and-verify task, not frontier reasoning. (effort errors on
        // Haiku 4.5; only set it on Opus/Sonnet tiers.)
        ...(/haiku/i.test(MODEL) ? {} : { output_config: { effort: 'low' } }),
        // Fewer search rounds = less sequential wall-clock. Each round is a
        // network fetch + model re-reason; 2 covers verification without the tail.
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: 2 }
        ]
      });
      return stream.finalMessage();
    }, { label: 'analyze' });

    const usage = message.usage || {};
    console.log('Audit complete:', {
      stop_reason: message.stop_reason,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens,
      cache_write: usage.cache_creation_input_tokens
    });

    // #3b: validate the model's output against the audit schema. Non-blocking —
    // we log integrity issues (malformed/out-of-range output, incl. anything an
    // injection tried to reshape) but still return the message; the frontend
    // parses it as before. Flip to a hard reject once the live flow is proven.
    const parsedAudit = prompts.parseAuditFromMessage(message);
    if (!parsedAudit) {
      console.warn('Audit output not parseable as JSON');
    } else {
      const v = prompts.validateAudit(parsedAudit);
      if (!v.ok) console.warn('Audit output failed schema validation:', v.errors);
    }

    if (charge.balanceAfter != null) res.setHeader('X-Credit-Balance', String(charge.balanceAfter));
    res.json(message);
  } catch (err) {
    // The audit never happened — give the credit back. A refund failure must not
    // mask the original error, so it is logged and swallowed.
    await credits.refund(req.user.uid, charge).catch((e) => console.error('Refund failed:', e));
    sendUpstreamFailure(res, err, 'analyze');
  }
});

// ── Auxiliary web-search lookups (Legislative Scrubber, Electability) ──
// Lighter-weight sibling of /api/analyze: no adaptive thinking (these are
// structured extract-from-search tasks, not reasoning), smaller token budget.
//
// Injection fix (same as /api/analyze): the client sends only a `task` name +
// subject `name`; the system prompt + messages are assembled HERE from the
// fixed per-task templates in lib/prompts.js. A caller hitting this endpoint
// directly can NO LONGER supply or override the system prompt — so it can't be
// used as an open Anthropic proxy on our key. Any client `system`/`messages`
// in the body are ignored.
app.post('/api/search', limiters.ai, auth.requireAuth(), auth.liveEmailVerification(), async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'API key not configured' });

  const { task, name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const built = prompts.buildSearchRequest(task, { name: name.trim() });
  if (!built) {
    return res.status(400).json({ error: 'unknown task' });
  }

  // Guardrails still apply — bound the assembled prompt (the subject name is the
  // only client lever) and clamp the token budget. Search rounds are fixed by
  // the task, then clamped to the server ceiling for defense in depth.
  if (promptSize(built.system, built.messages) > LIMITS.promptChars) {
    return res.status(413).json({ error: 'prompt too large' });
  }
  const max_tokens = clampInt(req.body.max_tokens, 1, LIMITS.searchMaxTokens, 3000);
  const max_uses = clampInt(built.maxUses, 1, LIMITS.searchMaxUses, 4);

  // Charged per task: the opt-in Scrubber costs a credit, the Electability
  // lookup is free (it runs automatically, so a charge would be a surprise).
  // creditCost() returns 0 for the free task and debit() short-circuits on 0 —
  // which is also why the verification gate below lets Electability through.
  if (!billableAllowed(req, res, task)) return;
  let charge;
  try {
    charge = await credits.debit(req.user.uid, { kind: task, ref: name.trim() });
  } catch (err) {
    if (err instanceof creditsLib.InsufficientCreditsError) {
      return res.status(402).json({ error: 'Insufficient credits', balance: err.balance, required: err.required });
    }
    console.error('Credit debit error:', err);
    return res.status(500).json({ error: 'Could not verify credit balance' });
  }

  try {
    const message = await withRetry(() => anthropic.messages.create({
      model: MODEL,
      max_tokens,
      system: built.system,
      messages: built.messages,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses }
      ]
    }), { label: 'search' });
    if (charge.balanceAfter != null) res.setHeader('X-Credit-Balance', String(charge.balanceAfter));
    res.json(message);
  } catch (err) {
    await credits.refund(req.user.uid, charge).catch((e) => console.error('Refund failed:', e));
    sendUpstreamFailure(res, err, 'search');
  }
});

// ── Register (Resend email + Firestore lead capture) ──
// Persists every registration to Firestore first so a lead is never lost,
// then sends a team notification + registrant auto-reply via Resend.
// Email is best-effort: a delivery failure does not fail the request.
app.post('/api/register', limiters.register, async (req, res) => {
  const { name, email, phone, org, isEvent, eventName, eventLocation, eventDate } = req.body || {};
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
  if (!name || !emailValid) return res.status(400).json({ error: 'Valid name and email required' });

  // 1. Durable lead capture (best-effort)
  let stored = false;
  try {
    await db.collection('registrations').add({
      name, email,
      phone: phone || '', org: org || '',
      isEvent: !!isEvent,
      eventName: eventName || '', eventLocation: eventLocation || '', eventDate: eventDate || '',
      createdAt: Firestore.Timestamp.now()
    });
    stored = true;
  } catch (err) {
    console.error('Registration persist error:', err);
  }

  // 2. Email via Resend (best-effort)
  let emailed = false;
  if (RESEND_API_KEY) {
    const subject = `Root & Fruit Registration — ${name}${org ? ' (' + org + ')' : ''}`;
    let body = 'ROOT & FRUIT — NEW USER REGISTRATION\n';
    body += '─────────────────────────────────────\n';
    body += `Timestamp   : ${new Date().toISOString()}\n`;
    body += `Name        : ${name}\n`;
    body += `Email       : ${email}\n`;
    if (phone) body += `Phone       : ${phone}\n`;
    if (org)   body += `Organization: ${org}\n`;
    if (isEvent) {
      body += '\nEVENT DETAILS\n─────────────────────────────────────\n';
      if (eventName)     body += `Event Name  : ${eventName}\n`;
      if (eventLocation) body += `Location    : ${eventLocation}\n`;
      if (eventDate)     body += `Date        : ${eventDate}\n`;
    }
    body += '\n─────────────────────────────────────\nRoot & Fruit Integrity Index';

    try {
      // Notify the team (reply-to goes straight to the registrant)
      await sendResendEmail({ to: REGISTRATION_EMAIL, subject, text: body, replyTo: email });
      // Auto-reply to the registrant
      const firstName = (String(name).split(' ')[0]) || name;
      await sendResendEmail({ to: email, subject: AUTO_REPLY_SUBJECT, text: buildAutoReplyBody(firstName), replyTo: REGISTRATION_EMAIL });
      emailed = true;
    } catch (err) {
      console.error('Registration email error:', err);
    }
  } else {
    console.warn('RESEND_API_KEY not set — registration stored but no email sent');
  }

  res.json({ ok: true, stored, emailed });
});

// ── Account (credits + profile) ────────────────────────
// Signed-in only. The account doc is created on first read, which is also where
// the one-time free grant is issued — inside the same transaction that creates
// the doc, so it can never be issued twice for the same uid.
app.get('/api/account', auth.requireAuth(), auth.liveEmailVerification(), async (req, res) => {
  try {
    const account = await credits.ensureAccount(req.user);
    res.json({ account: creditsLib.publicAccount(account, req.user) });
  } catch (err) {
    console.error('Get account error:', err);
    res.status(500).json({ error: 'Could not load account' });
  }
});

// Profile update. Only the fields in profilePatch() are writable — balances,
// plan, and Stripe ids are server-owned and cannot be set by a caller.
app.post('/api/account', auth.requireAuth(), auth.liveEmailVerification(), async (req, res) => {
  try {
    const account = await credits.ensureAccount(req.user, req.body || {});
    res.json({ account: creditsLib.publicAccount(account, req.user) });
  } catch (err) {
    console.error('Update account error:', err);
    res.status(500).json({ error: 'Could not update account' });
  }
});

// ── Billing (Stripe Checkout + Customer Portal) ────────
/**
 * Trim trailing '/' characters without a backtracking quantifier.
 *
 * The obvious `replace(/\/+$/, '')` is quadratic: anchored at `$`, the engine
 * retries the run of slashes from every start offset before it can fail. This
 * input is operator-supplied config rather than request data, so the exposure
 * is small — but a counted scan is both linear and clearer about intent.
 * @param {string} s  the string to trim
 * @returns {string}  s with any trailing slashes removed
 */
function stripTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return s.slice(0, end);
}

/**
 * Resolve the single public URL Stripe sends the browser back to.
 *
 * Deliberately NOT derived from the request's Origin/Referer: those are
 * attacker-controllable, and a redirect target built from them is an open
 * redirect wearing a Stripe URL.
 *
 * Takes only the FIRST entry when falling back to ALLOWED_ORIGIN, because that
 * variable is a LIST (one deployment answers on several origins) while a
 * redirect target must be exactly one URL. Concatenating the list produced
 * `https://a,https://b/?checkout=success`, which is not a reachable address.
 * Trailing slashes are trimmed so callers can append `/?...` unambiguously.
 * @param {string|undefined} appUrl   explicit APP_URL, if set
 * @param {string|undefined} allowed  ALLOWED_ORIGIN (may be a list, or '*')
 * @returns {string}  one origin with no trailing slash
 */
function resolveAppUrl(appUrl, allowed) {
  const first = (v) => stripTrailingSlashes(String(v || '').split(',')[0].trim());
  const explicit = first(appUrl);
  if (explicit) return explicit;
  const fallback = first(allowed);
  if (fallback && fallback !== '*') return fallback;
  return 'http://localhost:8080';
}
const APP_URL_FALLBACK = 'http://localhost:8080';
const APP_URL = resolveAppUrl(process.env.APP_URL, process.env.ALLOWED_ORIGIN);
// Both APP_URL and ALLOWED_ORIGIN are optional, so a deploy that sets neither
// silently sends paying customers to localhost after checkout. Treat that as a
// misconfiguration in production rather than a default worth honouring.
const APP_URL_CONFIGURED = APP_URL !== APP_URL_FALLBACK;
if (!APP_URL_CONFIGURED && process.env.NODE_ENV === 'production') {
  console.error(
    'CONFIG ERROR: neither APP_URL nor a concrete ALLOWED_ORIGIN is set. ' +
    'Stripe checkout would return buyers to ' + APP_URL_FALLBACK + ', so /api/billing/* is disabled.'
  );
}

/**
 * The purchasable catalog, resolved live from Stripe.
 *
 * Public on purpose — prices are public information and the plan picker should
 * render before a sign-in prompt. The blanket /api/ rate limiter is the abuse
 * backstop; there is no cache, because both services are stateless by design.
 */
app.get('/api/billing/plans', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured' });
  try {
    res.json({ plans: await plansLib.listCatalog(stripe) });
  } catch (err) {
    console.error('Plans error:', err);
    res.status(502).json({ error: 'Could not load plans' });
  }
});

/**
 * Start a Stripe Checkout session for the signed-in user.
 *
 * The client sends ONLY a price id — never an amount, a credit count, or a
 * plan name. The server re-resolves everything from Stripe, so a tampered body
 * can at most select a different real product at its real price.
 *
 * Verification is required here even though it costs nothing, because
 * billableAllowed() refuses cost>0 work from an unverified account: without
 * this gate a user could buy 100 credits and then be refused every audit.
 * Gating the purchase instead means anyone holding credits is verified by
 * construction, with no extra state to track.
 */
app.post('/api/billing/checkout', auth.requireAuth(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured' });
  // Refusing the sale beats taking the money and stranding the buyer on a dead
  // localhost page — the webhook would still grant the credits, so they would be
  // charged, credited, and shown nothing.
  if (!APP_URL_CONFIGURED && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Billing is not configured', code: 'app_url_unset' });
  }
  if (!req.user.emailVerified) {
    return res.status(403).json({ error: 'Email verification required', code: 'email_unverified' });
  }

  try {
    const account = await credits.ensureAccount(req.user);
    const plan = await plansLib.planById(stripe, req.body?.priceId);
    if (!plan) return res.status(400).json({ error: 'Unknown or unavailable plan' });

    // Reuse the account's customer so a returning buyer keeps one billing
    // history (and one portal session) rather than accumulating duplicates.
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email || undefined,
        metadata: { uid: req.user.uid }
      });
      // attachCustomer returns whatever id ends up on the account, so a
      // concurrent second checkout converges on one customer.
      customerId = await credits.attachCustomer(req.user.uid, customer.id) || customer.id;
    }

    const subscription = plan.bucket === 'cycle';
    const stamp = { uid: req.user.uid, credits: String(plan.credits), priceId: plan.priceId, quantity: '1' };

    const session = await stripe.checkout.sessions.create({
      mode: subscription ? 'subscription' : 'payment',
      customer: customerId,
      line_items: [{ price: plan.priceId, quantity: 1 }],
      // client_reference_id is the canonical uid slot; metadata is the copy the
      // webhook reads when resolving a one-time purchase.
      client_reference_id: req.user.uid,
      metadata: stamp,
      // Renewal invoices carry subscription metadata, not session metadata, so
      // the uid must be stamped here too or month two cannot be attributed.
      ...(subscription ? { subscription_data: { metadata: { uid: req.user.uid, credits: String(plan.credits) } } } : {}),
      // {CHECKOUT_SESSION_ID} is a Stripe template token — it must reach Stripe
      // literally, so do not URL-encode or interpolate it.
      success_url: `${APP_URL}/?checkout=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?checkout=cancelled`
    });

    res.json({ url: session.url, priceId: plan.priceId, credits: plan.credits });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(502).json({ error: 'Could not start checkout' });
  }
});

/**
 * Open the Stripe Customer Portal so a subscriber can update their card or
 * cancel without contacting us. Required for a subscription product, not
 * optional. Needs the portal to be configured once in the Stripe dashboard
 * (Settings → Billing → Customer portal) or Stripe rejects the call.
 */
app.post('/api/billing/portal', auth.requireAuth(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured' });
  try {
    const account = await credits.getAccount(req.user.uid);
    if (!account?.stripeCustomerId) {
      return res.status(404).json({ error: 'No billing history yet', code: 'no_customer' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${APP_URL}/`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(502).json({ error: 'Could not open the billing portal' });
  }
});

// ── Save audit ─────────────────────────────────────────
app.post('/api/audits', async (req, res) => {
  const { audit } = req.body;
  // A signed-in user's audits are keyed to their verified uid (unspoofable);
  // anonymous callers supply their per-browser id in the body.
  const userId = req.user?.uid || req.body.userId;
  if (!userId || !audit) return res.status(400).json({ error: 'userId and audit required' });

  try {
    const ref = db.collection(COLLECTION).doc();
    const doc = {
      id: ref.id,
      userId,
      ...audit,
      createdAt: Firestore.Timestamp.now(),
      updatedAt: Firestore.Timestamp.now()
    };
    await ref.set(doc);
    res.json({ id: ref.id });
  } catch (err) {
    console.error('Save audit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Get audits for user ────────────────────────────────
app.get('/api/audits/:userId', async (req, res) => {
  // Signed-in users always read their own audits (the verified uid wins over the
  // path param, so the path can't be used to read someone else's).
  const userId = req.user?.uid || req.params.userId;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  try {
    const snapshot = await db.collection(COLLECTION)
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const audits = snapshot.docs.map(doc => ({
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString(),
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString()
    }));

    res.json({ audits });
  } catch (err) {
    console.error('Get audits error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Delete audit ───────────────────────────────────────
app.delete('/api/audits/:userId/:auditId', async (req, res) => {
  const { auditId } = req.params;
  // Ownership is checked against the verified uid when signed in, else the path
  // param (anonymous per-browser id). Either way the doc's userId must match.
  const userId = req.user?.uid || req.params.userId;
  try {
    const ref = db.collection(COLLECTION).doc(auditId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (doc.data().userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    await ref.delete();
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete audit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Share audit (public, by share token) ──────────────
app.post('/api/share', async (req, res) => {
  const { audit } = req.body;
  if (!audit) return res.status(400).json({ error: 'audit required' });

  try {
    // Cryptographically random, not Math.random(): V8's PRNG state is
    // recoverable from a handful of observed outputs, which would make every
    // OTHER share token predictable from one you were legitimately given.
    // 16 bytes = 128 bits, the same standard as a session identifier.
    const token = crypto.randomBytes(16).toString('hex');
    await db.collection('shared_audits').doc(token).set({
      audit,
      token,
      createdAt: Firestore.Timestamp.now(),
      views: 0
    });
    res.json({ token, url: `/shared/${token}` });
  } catch (err) {
    console.error('Share error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/share/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const doc = await db.collection('shared_audits').doc(token).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shared audit not found' });
    // Increment view count
    doc.ref.update({ views: (doc.data().views || 0) + 1 }).catch(() => {});
    res.json(doc.data());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Only start listening when run directly (`node server.js`). When required by
// the test suite, the app is exported instead so tests can mount it on an
// ephemeral port without booting the production listener.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}

module.exports = app;
// Expose pure internals for unit testing without booting the listener.
module.exports.withRetry = withRetry;
module.exports.isRetryable = isRetryable;
module.exports.clampInt = clampInt;
module.exports.promptSize = promptSize;
module.exports.parseAllowedOrigins = parseAllowedOrigins;
module.exports.resolveAppUrl = resolveAppUrl;
module.exports.LIMITS = LIMITS;
// Test-only: inject a fake Firebase ID-token verifier so the auth middleware can
// be exercised without a live Firebase project. Never called in prod.
module.exports.__setAuthVerifier = auth.__setVerifier;
// Test-only: inject a mock Anthropic client so the /api/analyze handler path can
// be integration-tested without a live key or network. Never called in prod.
module.exports.__setAnthropic = (client) => { anthropic = client; };
// Test-only: inject a fake credit store so the billed routes can be tested
// without Firestore. Pass null to restore the real one. Never called in prod.
module.exports.__setCredits = (fake) => { credits = fake || creditsLib.createCredits(db); };
// Test-only: inject a mock Stripe client so the webhook route can be tested
// without live keys. Never called in prod.
module.exports.__setStripe = (client) => { stripe = client; };