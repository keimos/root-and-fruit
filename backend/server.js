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
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
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

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));