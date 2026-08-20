/**
 * Unit tests for the LLM-proxy request guardrails — node:test (no deps).
 *
 * These cover the pure helpers that bound abuse of /api/analyze and /api/search
 * (clamp token/search knobs, reject oversized prompts) without booting the
 * listener or touching the network:
 *   - clampInt: range clamping + non-numeric fallback + float flooring
 *   - promptSize: character accounting for string- and block-array system prompts
 *   - LIMITS: the documented ceilings leave headroom for the real UI values
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clampInt, promptSize, LIMITS, parseAllowedOrigins } = require('../server');

// ── clampInt ───────────────────────────────────────────
test('clampInt: passes through a value already in range', () => {
  assert.equal(clampInt(16000, 1, 32000, 8000), 16000);
});

test('clampInt: clamps above max and below min', () => {
  assert.equal(clampInt(999999, 1, 32000, 8000), 32000);
  assert.equal(clampInt(0, 1, 32000, 8000), 1);
  assert.equal(clampInt(-50, 1, 32000, 8000), 1);
});

test('clampInt: non-numeric / missing falls back to def (then clamped)', () => {
  assert.equal(clampInt(undefined, 1, 32000, 8000), 8000);
  assert.equal(clampInt(null, 1, 32000, 8000), 8000);
  assert.equal(clampInt('not a number', 1, 32000, 8000), 8000);
  assert.equal(clampInt(NaN, 1, 32000, 8000), 8000);
});

test('clampInt: coerces numeric strings and floors floats', () => {
  assert.equal(clampInt('12000', 1, 32000, 8000), 12000);
  assert.equal(clampInt(1500.9, 1, 32000, 8000), 1500);
});

// ── promptSize ─────────────────────────────────────────
test('promptSize: counts a string system prompt plus the messages', () => {
  const size = promptSize('abcde', [{ role: 'user', content: 'hi' }]);
  // 5 (system) + JSON length of the messages array
  assert.equal(size, 5 + JSON.stringify([{ role: 'user', content: 'hi' }]).length);
});

test('promptSize: handles a block-array system prompt', () => {
  const sys = [{ type: 'text', text: 'x' }];
  const size = promptSize(sys, []);
  assert.equal(size, JSON.stringify(sys).length + JSON.stringify([]).length);
});

test('promptSize: tolerates a missing system prompt and messages', () => {
  assert.equal(promptSize(undefined, undefined), JSON.stringify([]).length);
});

test('promptSize: grows past the cap on an oversized payload', () => {
  const huge = 'a'.repeat(LIMITS.promptChars + 1);
  assert.ok(promptSize(huge, []) > LIMITS.promptChars);
});

// ── LIMITS sanity ──────────────────────────────────────
test('LIMITS: ceilings leave headroom above the real UI values', () => {
  assert.ok(LIMITS.analyzeMaxTokens >= 16000);
  assert.ok(LIMITS.searchMaxTokens >= 3000);
  assert.ok(LIMITS.searchMaxUses >= 4);
  assert.ok(LIMITS.promptChars >= 20000);
});

// ── CORS origin list ───────────────────────────────────
// One deployment answers on several origins: Cloud Run gives every service two
// URL formats, and a custom domain adds a third. A single configured origin
// means a browser on any other one has its preflight rejected and its real
// request silently dropped — which shows up as OPTIONS 204 with no GET.
test('parseAllowedOrigins: splits a comma-separated list', () => {
  assert.deepEqual(
    parseAllowedOrigins('https://a.example.com,https://b.example.com'),
    ['https://a.example.com', 'https://b.example.com']
  );
});

test('parseAllowedOrigins: trims whitespace around entries', () => {
  assert.deepEqual(
    parseAllowedOrigins(' https://a.example.com , https://b.example.com '),
    ['https://a.example.com', 'https://b.example.com']
  );
});

test('parseAllowedOrigins: unset or wildcard stays fully open', () => {
  assert.equal(parseAllowedOrigins(undefined), '*');
  assert.equal(parseAllowedOrigins(''), '*');
  assert.equal(parseAllowedOrigins('*'), '*');
  assert.equal(parseAllowedOrigins('https://a.example.com,*'), '*', 'a wildcard anywhere wins');
});

test('parseAllowedOrigins: a single origin still works', () => {
  assert.deepEqual(parseAllowedOrigins('https://only.example.com'), ['https://only.example.com']);
});
