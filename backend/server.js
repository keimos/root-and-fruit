/**
 * Root & Fruit — Backend API Server
 * Handles: Anthropic API proxy, Firestore persistence, CORS
 */

const express = require('express');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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

// ── Middleware ─────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── Health check ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Claude agent: Integrity Index Auditor ─────────────
// Keeps the API key server-side; never exposed to the browser.
// Uses adaptive thinking + server-side web_search so the model
// can verify claims against current sources instead of relying
// solely on its training cutoff.
app.post('/api/analyze', async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'API key not configured' });

  const { messages, system, max_tokens = 16000 } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // Wrap the system prompt so we can attach cache_control. Below the
  // model's minimum-prefix threshold this is a no-op; once the prompt
  // grows past the threshold, repeated audits start hitting the cache.
  const systemBlocks = typeof system === 'string'
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

  try {
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

    const message = await stream.finalMessage();

    const usage = message.usage || {};
    console.log('Audit complete:', {
      stop_reason: message.stop_reason,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens,
      cache_write: usage.cache_creation_input_tokens
    });

    res.json(message);
  } catch (err) {
    console.error('Analyze error:', err);
    const status = err?.status || 500;
    res.status(status).json({ error: err.message || 'Analyze failed' });
  }
});

// ── Auxiliary web-search lookups (Legislative Scrubber, Electability) ──
// Lighter-weight sibling of /api/analyze: no adaptive thinking (these are
// structured extract-from-search tasks, not reasoning), smaller token budget,
// caller supplies its own system prompt + messages. Keeps the API key
// server-side — the frontend never talks to api.anthropic.com directly.
app.post('/api/search', async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'API key not configured' });

  const { messages, system, max_tokens = 3000, max_uses = 4 } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens,
      system,
      messages,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses }
      ]
    });
    res.json(message);
  } catch (err) {
    console.error('Search error:', err);
    const status = err?.status || 500;
    res.status(status).json({ error: err.message || 'Search failed' });
  }
});

// ── Register (Resend email + Firestore lead capture) ──
// Persists every registration to Firestore first so a lead is never lost,
// then sends a team notification + registrant auto-reply via Resend.
// Email is best-effort: a delivery failure does not fail the request.
app.post('/api/register', async (req, res) => {
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

// ── Save audit ─────────────────────────────────────────
app.post('/api/audits', async (req, res) => {
  const { userId, audit } = req.body;
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
  const { userId } = req.params;
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
  const { userId, auditId } = req.params;
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