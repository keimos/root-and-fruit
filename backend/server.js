/**
 * Root & Fruit — Backend API Server
 * Handles: Anthropic API proxy, Firestore persistence, CORS
 */

const express = require('express');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const prompts = require('./lib/prompts');
const { buildLimiters } = require('./lib/rateLimit');
const auth = require('./lib/auth');
const creditsLib = require('./lib/credits');

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

app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
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

// ── Health check ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Claude agent: Integrity Index Auditor ─────────────
// Keeps the API key server-side; never exposed to the browser.
// Uses adaptive thinking + server-side web_search so the model
// can verify claims against current sources instead of relying
// solely on its training cutoff.
app.post('/api/analyze', limiters.ai, auth.requireAuth(), async (req, res) => {
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
    console.error('Analyze error:', err);
    // The audit never happened — give the credit back. A refund failure must not
    // mask the original error, so it is logged and swallowed.
    await credits.refund(req.user.uid, charge).catch((e) => console.error('Refund failed:', e));
    const status = err?.status || 500;
    res.status(status).json({ error: err.message || 'Analyze failed' });
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
app.post('/api/search', limiters.ai, auth.requireAuth(), async (req, res) => {
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
  // creditCost() returns 0 for the free task and debit() short-circuits on 0.
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
    console.error('Search error:', err);
    await credits.refund(req.user.uid, charge).catch((e) => console.error('Refund failed:', e));
    const status = err?.status || 500;
    res.status(status).json({ error: err.message || 'Search failed' });
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
app.get('/api/account', auth.requireAuth(), async (req, res) => {
  try {
    const account = await credits.ensureAccount(req.user);
    res.json({ account: creditsLib.publicAccount(account) });
  } catch (err) {
    console.error('Get account error:', err);
    res.status(500).json({ error: 'Could not load account' });
  }
});

// Profile update. Only the fields in profilePatch() are writable — balances,
// plan, and Stripe ids are server-owned and cannot be set by a caller.
app.post('/api/account', auth.requireAuth(), async (req, res) => {
  try {
    const account = await credits.ensureAccount(req.user, req.body || {});
    res.json({ account: creditsLib.publicAccount(account) });
  } catch (err) {
    console.error('Update account error:', err);
    res.status(500).json({ error: 'Could not update account' });
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
    const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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