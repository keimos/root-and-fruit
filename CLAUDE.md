# CLAUDE.md — Root & Fruit (Integrity Index)

## Project Overview

**Root & Fruit** is a civic accountability tool that scores elected officials, community leaders, and policies/bills against a 57-point **Integrity Index** rooted in Black community-centered values. (Plus an optional +5 "People's Choice" community bonus, and a separate 0–10 "Light" transparency indicator that does NOT factor into the composite score.)

The app is two stateless Cloud Run services — a **frontend** (vanilla HTML/CSS/JS, single page) and a **backend** (Node + Express) — backed by **Firestore** for audit persistence and the **Anthropic API** for AI-driven auto-audits ("Forensic Audit") that combine adaptive thinking with server-side web search.

The app supports manual audits (a human checks boxes / drags sliders), AI-assisted audits (Claude pre-fills the form against current public sources), saved audits per user, comparison between two audits, public shareable links, share-card image export, and PDF export.

---

## Tech Stack

- **Frontend:** vanilla HTML + CSS + JS in a **single file** (`frontend/public/index.html`) served by a thin Express runtime-config injector. **No bundler, no framework, no build step.**
  - External libs are loaded from CDNs only: Google Fonts (Bebas Neue, DM Sans, DM Mono), Font Awesome, jsPDF.
  - All app state lives in module-level JS variables in the inline `<script>`. Persistence is via `localStorage` (user ID + offline cache) and the backend (`/api/audits`).
- **Backend:** Node 20 + Express. Dependencies kept tight: `@anthropic-ai/sdk`, `@google-cloud/firestore`, `cors`, `express`, `express-rate-limit` (per-route rate limiting), `firebase-admin` (ID-token verification for auth).
- **AI integration:** Anthropic API via `@anthropic-ai/sdk`. Default model is `claude-opus-4-7` (override with `ANTHROPIC_MODEL`). Uses **adaptive thinking** + `web_search_20260209` tool (max 5 uses). System prompt is wrapped with `cache_control: ephemeral` so repeated audits start hitting the prompt cache once it grows past the model's minimum-prefix threshold.
- **Storage:** Firestore Native, five collections — `audits` (keyed by user), `shared_audits` (token-keyed, public-readable), `registrations` (append-only splash-registration leads), `accounts` (uid-keyed; authoritative credit balance + profile), and `credit_ledger` (append-only record of every balance change).
- **Deploy:** Two stateless containers (`root-and-fruit-backend`, `root-and-fruit-frontend`) suitable for Cloud Run, Fly, Render, or any platform that runs a Node container and can wire `BACKEND_URL` into the frontend at runtime. **GitHub Actions CI/CD to Cloud Run is checked in** as a single gated pipeline at `.github/workflows/pipeline.yml` (PRs run tests + CodeQL + Docker build; merge to `main` re-runs them and then deploys, keyless via Workload Identity Federation) — see the [Deployment](#deployment) section. The app stays platform-agnostic; the workflow is the reference path, not a hard dependency.

---

## Repository Layout

```
root-and-fruit/
├── .github/
│   └── workflows/
│       └── pipeline.yml  ← one gated pipeline: PR runs tests + CodeQL + Docker build;
│                            merge to main re-runs them, then deploys (WIF, backend→frontend)
├── backend/
│   ├── server.js         ← Express API: /api/analyze, /api/search, /api/register, /api/audits, /api/share, /health
│   ├── test/
│   │   ├── server.test.js  ← node:test HTTP integration (routing/validation/no-key guards)
│   │   └── retry.test.js   ← node:test unit tests for the Anthropic retry helper
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── public/
│   │   └── index.html    ← THE entire frontend app (single file)
│   ├── server.js         ← static server + runtime config injection
│   ├── Dockerfile
│   └── package.json
└── .gitignore
```

The "single file" rule applies to **`frontend/public/index.html`** only. Everything else is conventional.

---

## Architecture

### Two-service runtime topology

```
Browser
   │
   ▼  HTTPS
Cloud Run: root-and-fruit-frontend (Node 20, port 8080)
   ├── GET /static/*  → cached static assets (7d immutable)
   └── GET /*         → public/index.html with window.__RF_CONFIG__ injected
                        before </head> at request time
   │
   │  fetch(`${BACKEND_URL}/api/...`)   (cross-origin, CORS-enabled)
   ▼
Cloud Run: root-and-fruit-backend (Node 20, port 8080)
   ├── GET  /health
   ├── POST /api/analyze              → Anthropic Messages API (adaptive thinking + web_search)
   ├── POST /api/search               → Anthropic Messages API (web_search, no thinking) — Scrubber + Electability
   ├── POST /api/register             → Resend email (team notify + auto-reply) + Firestore: registrations.add(...)
   ├── POST /api/audits               → Firestore: audits.add({userId, ...audit})
   ├── GET  /api/audits/:userId       → Firestore: audits.where(userId).orderBy(createdAt desc)
   ├── DELETE /api/audits/:userId/:id → Firestore: audits.delete (with userId ownership check)
   ├── POST /api/share                → mints token, writes shared_audits.{token}
   └── GET  /api/share/:token         → reads shared_audits, increments views
                                                                                      │
                                                                                      ▼
                                                                                 Firestore
                                                                            (collections:
                                                                              audits, shared_audits,
                                                                              registrations)
                                                                                      ▲
                                                                                      │
                                                                            Anthropic API
                                                                            (api.anthropic.com)
```

### Why two services and not one

- **Different scaling profiles.** Frontend is cheap static delivery (256Mi, max 5 instances). Backend is CPU/memory heavier and handles long-running AI requests with `--timeout=600` (600Mi, max 10 instances).
- **Key isolation.** `ANTHROPIC_API_KEY` only needs to live in the backend service environment.
- **Faster frontend redeploys.** The frontend has no build step — pushing index.html changes does not need to rebuild the backend image.

### Why runtime config injection (not bundling `BACKEND_URL`)

The frontend reads its backend URL from `window.__RF_CONFIG__.backendUrl`, which is **injected by `frontend/server.js` into `<head>` on every HTML response**. This means:

- One frontend image can be promoted across environments by changing only the `BACKEND_URL` env var.
- HTML responses carry `Cache-Control: no-cache, no-store, must-revalidate` so config never gets stuck in a CDN.
- Static assets under `/static/*` keep `maxAge=7d, immutable=true`.

---

## Frontend — `frontend/public/index.html`

### View model

Six views are rendered as sibling `<div class="view">` elements; `showView(v)` toggles the `.active` class. The current view is also reflected in the top nav tabs. **Nav order (left→right): Results · Community Assessment · Full Report · Compare · Saved Audits · About.** `results` is the **default active view** on load. Note the tab **labels** differ from their internal slugs: `assess` is labelled **"Full Report"** and `methodology` is labelled **"About"**.

| View (slug)       | Tab label    | Purpose                                                          |
|-------------------|--------------|------------------------------------------------------------------|
| `results`         | Results      | **Entry point.** Subject input + candidate/policy toggle + manual pathway toggle + Auto-Analyze + Evidence-Quality bar, then verdict, score breakdown, radar chart, **Electability Rating** (separate indicator, backend-routed; candidates only), and share-card preview. |
| `community`       | Community Assessment | The 6 scoring cards (Root, Branches, Fruit, Light, Toxic) + People's Choice + per-section justification textareas + baseline-vs-adjusted indicator. This is where the scoring inputs live. |
| `assess`          | Full Report  | **Read-only** rendered audit. Report-header share-card image + subject metadata strip, an empty state until an analysis exists, the AI report (`#auditContent`, "Official Audit Report"), and the opt-in **Legislative Scrubber** (backend-routed). No subject input lives here anymore. |
| `compare`         | Compare      | Side-by-side comparison of two saved audits                     |
| `saved`           | Saved Audits | List of saved audits (cloud-first, local fallback)              |
| `methodology`     | About        | Static educational content explaining the framework             |

`showView('community')` triggers `updateCommunityScoreIndicator()`.
`showView('results')` triggers `updateResultsView()` and `drawShareCard()` (after a 100ms tick).
`showView('assess')` triggers `populateReportHeader()` (fills the metadata strip + captures the share-card canvas into `#reportShareImg`).
`showView('saved')` triggers `renderSavedList()`.
`showView('compare')` triggers `populateCompareSelects()`.

`autoAnalyze()` runs from the Results tab: on success it reveals the report, calls `updateResultsView()` + `drawShareCard()` + `populateReportHeader()`, and (for candidates) kicks off `runElectabilityScore()` plus `runLegislativeScrubber()` when the Scrubber opt-in is checked.

**Baseline vs Adjusted:** `Auto-Analyze` fills the form, then `captureBaseline()` freezes the AI's read into `baselineScores`. Any later edit to a checkbox/slider/People's-Choice becomes the "Adjusted" community score. `calculate()` updates the Adjusted footer pair live; the Baseline pair stays frozen. `getCommunityDelta()` / `updateCommunityScoreIndicator()` drive the indicator in the Community view. `baselineScores` + justifications are persisted in the saved-audit object.

> **NOTE:** `showView` is defined twice in the file (the canonical one is the **second/bottom** definition). The **dead earlier copy still carries the old `tabs` array** (`['assess','community','results',…]`); the canonical copy holds the live order `['results','community','assess','compare','saved','methodology']` — matching the nav DOM — plus the deferred share-card draw (`setTimeout(drawShareCard, 100)` on `results`) and `populateReportHeader()` on `assess`. The `tabs` array indexes into the nav buttons by position, so it **must** mirror nav DOM order. Leave the dead copy alone unless you're doing a focused cleanup PR; if you do remove it, the canonical copy is the one to keep.

> **⚠️ Divergent standalone prototype.** A single-file `root-and-fruit.html` circulates outside this repo as a browser-only fork. The canonical app has since **adopted its layout** — Results-first nav, read-only "Full Report" tab with a share-card image header, the Legislative Scrubber, and the Electability Rating — but **routed through the backend**, not the browser. The prototype still violates this repo's hard constraints and must **not** be merged wholesale: it calls `https://api.anthropic.com` **directly from the browser** (`sessionStorage` key + `anthropic-dangerous-direct-browser-access`) and persists to `localStorage` only (no `CloudAuditStore`/Firestore), and it uses an API-key modal + auto-detected pathway **badge** we deliberately did not adopt (we kept the manual pathway toggle). If asked to port anything else from it, re-route every Anthropic call through the backend — never the browser-direct pattern.

### Subject model

Two **subject types** (toggled by `setType(t)`):
- `candidate` — human (elected official, community leader, etc.)
- `policy` — bill or policy

When subject type is `candidate`, a second toggle exposes a **pathway**:
- `elected` — held formal office (default)
- `community` — organizer / activist / civic leader

The pathway changes the framing of "Fruit" scoring. Community-leader Fruit reflects organizing wins, institutions built, and lasting community impact — **not legislation**. The locked prompt enforces equal weight.

### Scoring (57-point Integrity Index)

| Section             | Mechanic                | Max | Notes                                                  |
|---------------------|-------------------------|----:|--------------------------------------------------------|
| Root (Values)       | 5 checkboxes × 5 pts    |  25 | Boolean. Foundational worldview.                       |
| Branches (Advocacy) | 6 checkboxes × 2 pts    |  12 | Boolean. The 6th is "Education Reform (Black Communities)" — voucher/charter advocacy that diverts from public schools is a nuance flag, NOT a TRUE. |
| Fruit (Outcomes)    | 5 sliders × 0–3 pts     |  15 | Tiered: None / Talk / Pilot or Partial / Full impact.  |
| Toxic Soil          | 3 checkboxes (penalties)| −15 | Subtracted: Gatekeeper −3, Plantation −4, Betrayal −8. (For policy: Carve-Out / Trojan Horse / Unfunded Mandate.) |
| People's Choice     | 1 community-awarded toggle | +5 | Optional community bonus. Off by default. |
| Light (Visibility)  | 1 slider 0–10 pts       |  10 | **Separate indicator. Does NOT factor into the composite score.** Documentation richness — voting AND organizing AND press AND testimony all count. |

`calculate()` recomputes total = `max(0, root + branch + fruit − toxic + peoplesChoiceBonus)`. The verdict tiers in `getVerdict(score)`:

| Threshold | Candidate label  | Policy label             |
|----------:|------------------|--------------------------|
| ≥ 44      | THE VANGUARD     | TRANSFORMATIVE LAW       |
| ≥ 35      | THE WORKER       | PROGRESSIVE REFORM       |
| ≥ 26      | THE PRAGMATIST   | INCREMENTAL REFORM       |
| ≥ 16      | THE POLITICIAN   | MAINTENANCE BILL         |
| ≥ 7       | THE BYSTANDER    | LOW ALIGNMENT POLICY     |
| < 7       | THE MISALIGNED   | MISALIGNED POLICY        |

Verdict colors come from CSS variables (`--green`, `--gold`, `--blue`, `--orange`, `--red`).

### Auto-Audit (Claude AI)

Triggered by `autoAnalyze()`. Builds a system prompt via `buildAuditPrompt(target, isCandidate, isCommunity)`, posts to `${backendUrl}/api/analyze`, parses the returned JSON, and animates the form via `applyAnalysis(data)` — checkboxes flip in sequence, sliders ramp up tick by tick. The text report renders into `#auditContent` via `renderAuditReport`.

**Expected JSON shape from Claude (see locked prompt):**
```js
{
  historicalBackground: string,        // 2–3 substantive paragraphs
  subjectPathway: 'elected' | 'community',  // auto-detected; drives UI pathway badge
  supporters: string[],
  opponents: string[],
  funders: string[],                   // PACs, industry donors, dark money, major individual contributors
  root:     [{met: bool, reasoning: string}, ... 5 items],
  branches: [{met: bool, reasoning: string}, ... 6 items],  // 6th = Education Reform
  fruit:    [{score: 0..3, reasoning: string}, ... 5 items],
  visibility: { score: 0..10, reasoning: string },
  toxic:    [{present: bool, reasoning: string}, ... 3 items],
  evidenceQuality: 0..100,
  summary: string,
  sources: [{title, url, category, biasRating}, ...]
}
```

**Parsing is forgiving** — it strips ```` ```json ```` fences before `JSON.parse`. If the call fails, it sets `errorBox` and leaves the form untouched.

### Storage strategy (cloud-first, local fallback)

`CloudAuditStore` wraps the backend API. `getUserId()` lazily mints a per-browser `crypto.randomUUID()` and persists it in `localStorage` under `rfUserId`. Saved audits live under `rfAudits` in `localStorage`.

`saveAudit()` / `deleteAudit()` try the cloud first; on network or 5xx error, fall back to `localStorage` and toast accordingly. `syncCloudAuditsToLocal()` overwrites the local cache after each successful cloud op so the UI stays consistent.

> **localStorage is intentional here**, unlike CivicSorter. Root & Fruit needs a stable per-browser user ID across page loads, plus an offline cache. Don't remove it.

---

## Backend — `backend/server.js`

### Endpoints

| Method | Path                              | Behavior                                                  |
|--------|-----------------------------------|-----------------------------------------------------------|
| GET    | `/health`                         | `{status:"ok", ts}` — used by Cloud Run liveness          |
| POST   | `/api/analyze`                    | **Signed-in only. Costs 1 credit.** Anthropic Messages proxy for the main audit. Body: `{messages, system, max_tokens?}`. Wraps `system` with `cache_control: ephemeral`, uses adaptive thinking + web_search. Streams to `finalMessage()`. Returns the full Anthropic message object, plus an `X-Credit-Balance` response header. 401 anonymous, 402 out of credits. |
| POST   | `/api/search`                     | **Signed-in only.** Lighter web-search proxy for the **Legislative Scrubber** (costs 1 credit) and **Electability Rating** (free). Body: `{messages, system, max_tokens?=3000, max_uses?=4}`. **No** adaptive thinking (structured extract-from-search task); uses `messages.create` + web_search. Returns the full Anthropic message object. Keeps the key server-side just like `/api/analyze`. |
| GET    | `/api/account`                    | **Signed-in only.** Returns `{account}` (see `publicAccount`, which also reports `emailVerified`). Creates the account doc on first call, and issues the one-time free grant on the first call where the token says the address is verified. |
| POST   | `/api/account`                    | **Signed-in only.** Merges profile fields (`firstName`, `lastName`, `org`, `role`, `acceptedTerms`). Balances, plan, and Stripe ids are server-owned and **cannot** be set by a caller. |
| POST   | `/api/register`                   | Splash registration. Body: `{name, email, phone?, org?, isEvent?, eventName?, eventLocation?, eventDate?}`. Validates name + email, persists the lead to Firestore `registrations` (best-effort), then sends a team notification + registrant auto-reply via **Resend** (best-effort — `RESEND_API_KEY` only). Returns `{ ok:true, stored, emailed }`; email failures don't fail the request. Replaces the old `mailto:`/FormSubmit flow. |
| POST   | `/api/audits`                     | `{userId, audit}` → adds doc with `createdAt`/`updatedAt` Firestore timestamps. |
| GET    | `/api/audits/:userId`             | Returns audits for a user, ordered by `createdAt desc`, capped at `limit` (default 50, max 100). Timestamps converted to ISO strings. |
| DELETE | `/api/audits/:userId/:auditId`    | Verifies ownership before deleting (403 if `userId` doesn't match). |
| POST   | `/api/share`                      | `{audit}` → mints a random token (`Math.random + Date.now`-based), writes `shared_audits/{token}`. Returns `{token, url}`. |
| GET    | `/api/share/:token`               | Reads `shared_audits/{token}`, increments `views` async, returns the audit. |

### CORS

`cors({ origin: ALLOWED_ORIGIN || '*' })` — wide-open by default, intentionally. Tighten by setting `ALLOWED_ORIGIN` to the frontend's Cloud Run URL once the domain is final.

### Rate limiting

`backend/lib/rateLimit.js` (built via `buildLimiters()`) mounts `express-rate-limit` over `/api/*`: a blanket cap (`RATE_LIMIT_API`, 100/min) plus stricter per-route limiters on the billed Anthropic routes (`RATE_LIMIT_AI`, 15/min on `/api/analyze` + `/api/search`) and the email-sending `/api/register` (`RATE_LIMIT_REGISTER`, 5/min). Windows and limits are env-tunable; `app.set('trust proxy', …)` keys the limiter on the real client IP behind Cloud Run's front end.

> **Per-instance caveat.** This uses the default **in-memory** store, so counters are per Cloud Run instance — the real ceiling is up to `max-instances × limit`, not a precise global quota. It's a deliberate, stateless-friendly cost/abuse backstop (no Firestore/Redis round-trip per request), **not** a hard global cap. For an exact global limit, back the money routes with a shared store (Firestore/Redis); for volumetric/DDoS protection, add an edge limiter (Cloud Armor in front of an HTTPS LB, with ingress locked to `internal-and-cloud-load-balancing`). The two layers are complementary.

### Credits (57-point scoring is free; AI is metered)

`backend/lib/credits.js` owns the balance. **The client never supplies, and is never trusted for, a balance** — the browser only displays what `/api/account` and the `X-Credit-Balance` header report, and the backend re-checks and debits on every billed call.

| Rule | Value |
|------|-------|
| Free tier | **3 credits, one-time, per registered account with a _verified_ email.** Not per browser — the anonymous `rfUserId` is a `localStorage` UUID that re-rolls on clear/incognito, so a quota keyed to it is unenforceable. Verification is the other half of that: an unverified Firebase account is just as cheap to re-mint (`you+2@…`), so a grant keyed to it would be equally unenforceable. Requiring the click makes each grant cost one real, deliverable inbox. |
| Refresh | None. The free grant is issued at most once, guarded by `grantIssued()` re-checked inside the transaction. An account created before verification starts at **0** credits and is topped up on the first `/api/account` call after the link is clicked. |
| AI audit (`/api/analyze`) | 1 credit |
| Legislative Scrubber (`task: 'scrubber'`) | 1 credit — explicit opt-in, and the UI already says it costs extra |
| Electability Rating (`task: 'electability'`) | **Free** — it runs automatically for candidates, so a charge would be a surprise |
| Free, no account | Manual scoring, saved audits, compare, share links |

**Two buckets, not one balance.** `cycleBalance` holds subscription credits (expire each cycle); `packBalance` holds purchased packs and the free grant (never expire). Debits spend `cycleBalance` **first**, and `refund()` returns credits to the exact bucket they came from so a refunded expiring credit never silently becomes a permanent one.

**Reserve-then-refund, not charge-on-success.** The debit happens *before* the Anthropic call and is reversed if it throws. Charging after success would let concurrent requests all pass the same balance check and overspend. The tradeoff — a crash between debit and refund costs one credit — is recoverable via the `credit_ledger` row, which carries the subject as `ref`.

**Verification gate.** Two enforcement points, both server-side. `ensureAccount()` withholds the grant until the ID token carries `email_verified` — that is the one that matters, since it is what stops a farmed account from ever holding credits. `billableAllowed()` in `server.js` additionally refuses **cost > 0** work with `403 {code: 'email_unverified'}`, so an unverified user gets an actionable error instead of a confusing "out of credits". Zero-cost work (Electability) is deliberately **not** gated: it fires automatically, so blocking it would break a call the user never made. Note the claim is baked into the token at issue time — the frontend's `recheckVerification()` must `reload()` + `getIdToken(true)` after the user clicks the link, or the backend keeps seeing the stale `false`.

**Legacy accounts.** `grantIssued()` falls back to `lifetimeGranted > 0` for docs written before the `freeGrantIssued` flag existed. Without that fallback every pre-existing account would collect a *second* grant on its next `/api/account` call. Don't "simplify" it to a bare flag read.

**Collections:** `accounts/{uid}` (authoritative balance + profile) and `credit_ledger` (append-only; every balance change writes a row in the same transaction). The ledger needs a `(uid ASC, createdAt DESC)` composite index **only once something queries it** — nothing does yet, so no index is required today.

> **Regression harness impact.** `frontend/test/regression.mjs` drives the real app's Auto-Analyze, which is now signed-in and billed. It signs in via `REGRESSION_USER_EMAIL` (repo/Environment **variable**) and `REGRESSION_USER_PASSWORD` (Actions **secret** — never a variable; variables are plaintext and unmasked in logs) and **fails fast** if they're unset. The dev account must exist in the Firebase project, have a **verified** address (unverified accounts receive no grant), and hold credits — the free grant covers only three runs, so top it up in Firestore.

### Authentication (Firebase — additive)

Auth is **additive for storage, required for AI**: the app keeps its anonymous per-browser flow (a `crypto.randomUUID()` in `localStorage`) for manual scoring, saved audits, and sharing — but the **billed Anthropic routes (`/api/analyze`, `/api/search`) now require a signed-in account**, because credits can only be metered against an identity a user cannot cheaply re-roll. See [Credits](#credits-57-point-scoring-is-free-ai-is-metered).

- **Client owns the credential flow.** The frontend loads the Firebase **compat** SDK from `gstatic` CDN and calls it directly for register / sign-in / **password reset** (`sendPasswordResetEmail` — enumeration-safe, expiring links, all hosted by Firebase) / email verification. **No passwords ever touch our backend**, and none of that flow lives in `buildAuditPrompt` territory — it's ordinary client code. The Firebase auth JS lives in the `AUTH (Firebase Authentication)` section of `index.html`; the modal is `#authModal` (reusing the `.modal-overlay`/`.modal` classes), triggered from the header `#authBtn`.
- **Backend only verifies ID tokens.** `backend/lib/auth.js` verifies the `Authorization: Bearer <idToken>` with `firebase-admin` (`verifyIdToken`) and attaches `req.user = {uid, email, emailVerified}`. `optionalAuth` is mounted on all `/api/*` and **never rejects** — a missing/invalid token just means anonymous. `requireAuth` returns 401 and **is mounted** on `/api/analyze`, `/api/search`, and both `/api/account` routes. No secret is needed: verification fetches Google's public keys; the Admin SDK uses the runtime SA's ADC.
- **Data ownership.** The audits routes prefer `req.user.uid` over any client-supplied id, so a signed-in user's audits are keyed to their **verified** uid and the path/body id can't be used to read or delete someone else's. Anonymous callers still use their per-browser id. This preserves the existing ownership check and keeps all prior tests green.
- **Config injection.** The public Firebase web config is injected into `window.__RF_CONFIG__.firebase` by `frontend/server.js` (same runtime-injection pattern as `BACKEND_URL`) — **only when `FIREBASE_API_KEY` is set**. If it's absent, the auth UI stays hidden and the app is fully anonymous.

**One-time setup (operator, not automated)** — mirrors the WIF/Secret-Manager pattern:
1. In the Firebase console, add Firebase to the GCP project (dev + prod), enable **Authentication → Email/Password**, and register a **Web app** to get the public config (apiKey, authDomain, appId).
2. Set the frontend `FIREBASE_*` repo/Environment variables from that config, and (if it differs from `GOOGLE_CLOUD_PROJECT`) the backend `FIREBASE_PROJECT_ID`.
3. Grant the **runtime** service account the token-verification path (Firebase Admin works with the existing `datastore.user`/project roles; no extra secret). Optionally customize the Firebase password-reset & verification email templates and authorized domains.

Until step 1–2 are done, the code ships dormant — the auth button never appears and every request is anonymous, exactly as before.

### Anthropic call shape

```js
anthropic.messages.stream({
  model: MODEL,                          // claude-opus-4-7 by default
  max_tokens,                            // 16000 from the frontend
  system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
  messages,
  thinking: { type: 'adaptive' },
  tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]
})
```

`stream.finalMessage()` collects the full response. Token usage (input/output, cache read/write) is logged on success. On error, the original status code is forwarded if available.

### Environment variables

| Variable                | Required | Notes                                                                                        |
|-------------------------|---------|----------------------------------------------------------------------------------------------|
| `ANTHROPIC_API_KEY`     | yes     | If missing, `/api/analyze` returns 500 `"API key not configured"` but other endpoints still work. Mounted from Secret Manager `anthropic-api-key:latest` in Cloud Run. |
| `ANTHROPIC_MODEL`       | no      | Defaults to `claude-opus-4-7`.                                                               |
| `RESEND_API_KEY`        | no      | Enables `/api/register` email. If missing, registrations are still stored in Firestore but no email is sent (logged as a warning). Mount from Secret Manager in Cloud Run — never plaintext. |
| `REGISTRATION_EMAIL`    | no      | Inbox that receives new-registration notifications. Defaults to `rootandfruit@wetheanvil.org`. |
| `REGISTRATION_FROM`     | no      | Resend `from` sender. Defaults to the `onboarding@resend.dev` sandbox (delivers only to the Resend account owner) — **set this to a verified domain sender (e.g. `Root & Fruit <noreply@rootandfruit.app>`) in production.** |
| `DONATION_URL`          | no      | Donation CTA link in the registrant auto-reply email. If unset, the auto-reply omits the donation line entirely (rather than shipping a placeholder). Set to the live donation URL (e.g. `https://anvilinstitute.org/give`) in production. |
| `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` | yes (in production) | Firestore client uses this. Cloud Run injects it automatically. |
| `ALLOWED_ORIGIN`        | no      | CORS origin allowlist. Defaults to `*`.                                                      |
| `RATE_LIMIT_AI`         | no      | Max `/api/analyze` + `/api/search` requests per window per client IP. Defaults to `15`.       |
| `RATE_LIMIT_REGISTER`   | no      | Max `/api/register` requests per window per client IP. Defaults to `5`.                       |
| `RATE_LIMIT_API`        | no      | Blanket cap over the rest of `/api/*` per window per client IP. Defaults to `100`.           |
| `RATE_LIMIT_WINDOW_MS`  | no      | Rate-limit window length in ms. Defaults to `60000` (1 min).                                 |
| `TRUST_PROXY_HOPS`      | no      | Proxy hops to trust for client-IP resolution behind the LB. Defaults to `1` (Cloud Run).    |
| `FIREBASE_PROJECT_ID`   | no      | Firebase project for auth ID-token verification. Falls back to `GOOGLE_CLOUD_PROJECT`. If neither resolves, auth is disabled and every request is anonymous. |
| `FREE_CREDITS`          | no      | One-time credit grant issued when an account's address is first seen verified. Defaults to `3`. Set to `0` to disable the free tier entirely. Forwarded by the pipeline from the optional `FREE_CREDITS` repo/Environment variable. |
| `PORT`                  | no      | Cloud Run injects it. Defaults to 8080 locally.                                              |

| Frontend env var        | Required | Notes                                                                                        |
|-------------------------|---------|----------------------------------------------------------------------------------------------|
| `BACKEND_URL`           | yes     | Backend Cloud Run URL. Injected into HTML at request time as `window.__RF_CONFIG__.backendUrl`. |
| `FIREBASE_API_KEY`      | no      | Firebase Web API key. **Presence of this var enables the auth UI.** Public value (safe in HTML). |
| `FIREBASE_AUTH_DOMAIN`  | no      | Firebase auth domain (e.g. `your-app.firebaseapp.com`). Required when auth is enabled.        |
| `FIREBASE_PROJECT_ID`   | no      | Firebase project id (frontend copy of the public web config). Required when auth is enabled.  |
| `FIREBASE_APP_ID`       | no      | Firebase web app id. Required when auth is enabled.                                          |
| `FIREBASE_STORAGE_BUCKET` / `FIREBASE_MESSAGING_SENDER_ID` | no | Rest of the public web config; only needed if Storage/FCM are later used. |
| `APP_VERSION`           | no      | Surfaced in `__RF_CONFIG__.version`.                                                         |
| `NODE_ENV`              | no      | Surfaced in `__RF_CONFIG__.env`.                                                             |
| `PORT`                  | no      | Cloud Run injects it.                                                                        |

---

## Locked Prompt — DO NOT CASUALLY MODIFY

`buildAuditPrompt(target, isCandidate, isCommunity)` in [backend/lib/prompts.js](backend/lib/prompts.js) is the locked prompt. **It moved server-side** (prompt-injection fix #1): the client now sends only structured subject fields and the backend assembles the prompt from the locked template, so a caller hitting `/api/analyze` directly cannot supply or override it. `backend/test/prompts.equivalence.test.js` proves the moved text is byte-for-byte the former client-side prompt.

**Current baseline (as of the 57-pt scoring rewrite):**
- 6 Branches criteria (the 6th is "Education Reform (Black Communities)")
- Returns `subjectPathway` (`elected` | `community`) for auto-detected pathway
- Returns `funders` array alongside `supporters` / `opponents`
- All other fields and discipline preserved from the prior baseline.

**⚠️ Pending regression test:** the prior locked baseline (5-branch / 60-pt) was the version verified against Billion Godson. This new 6-branch baseline has NOT yet been regression-tested. Anyone shipping this needs to run Billion Godson through it and confirm the verdict is still accurate before this is treated as the new locked baseline.

Going forward, any change to this function MUST be:
1. Explicitly agreed upon before editing
2. Tested against Billion Godson immediately after
3. Rolled back if the result regresses

Do NOT modify this function as a side effect of other changes. **Treat this as a hard constraint.** If a refactor happens to touch the function, restore it exactly. If the user asks for a prompt change, confirm explicitly, propose the diff, then plan to regression-test against Billion Godson before merging.

The short system message passed to `/api/analyze` (in `autoAnalyze`) — the one that reminds Claude to return only valid JSON, never truncate `historicalBackground`, weight community-leader records equally, and use web_search to verify — is part of the same baseline. Same rules apply.

---

## Deployment

Deployment targets **two stateless containers** (`root-and-fruit-backend`, `root-and-fruit-frontend`) built from `backend/Dockerfile` and `frontend/Dockerfile`, run on a Node-friendly platform (Cloud Run, Fly, Render, ECS, a plain VM, …). GitHub Actions CI/CD to Cloud Run **is now checked in** (see below); the workflows are the reference deploy path, but the app itself is platform-agnostic and can still be deployed by hand anywhere that runs a Node container.

The non-negotiable wiring:

1. Provision a Firestore (or Firestore-compatible) database. The app uses five collections: `audits`, `shared_audits`, `registrations`, `accounts`, and `credit_ledger`. The `audits` collection needs a **composite index on `(userId ASC, createdAt DESC)`** — Firestore will refuse the listing query otherwise. `registrations` and `credit_ledger` are append-only and `accounts` is read by document id, so none of them need an index today (a ledger listing UI would need `(uid ASC, createdAt DESC)`).
2. Deploy the **backend** first. It needs `ANTHROPIC_API_KEY` (from a secret store, never a plaintext env), service-account credentials with Firestore read/write, and `GOOGLE_CLOUD_PROJECT` (or equivalent) for the Firestore client. Long-running AI requests can take tens of seconds — set the platform's request timeout to ≥ 300s.
3. Deploy the **frontend** with `BACKEND_URL` pointing at the backend's public URL. The frontend image carries no build-time config — `BACKEND_URL` is read at request time and injected into HTML via `frontend/server.js`.
4. (Optional) Tighten CORS by setting `ALLOWED_ORIGIN` on the backend to the frontend's public URL.

**Build order is a hard constraint** regardless of how you deploy: the frontend deploy depends on the backend's URL, so the two cannot be parallelized. The backend must be deployed (and its URL captured) before the frontend.

### CI/CD — GitHub Actions → Cloud Run

A single gated workflow lives at `.github/workflows/pipeline.yml`. It runs on both `pull_request → main` and `push → main`, with four jobs:

| Job | Runs on | Does |
|-----|---------|------|
| `test` | PR + push | Backend test suite (`npm test`). **Gate.** |
| `codeql` | PR + push | CodeQL static analysis (`javascript-typescript`); results surface in the Security tab and as a PR check. **Gate.** |
| `docker-build` | PR + push | Builds both images as a compile-check (no push). **Gate.** |
| `deploy` | **push to `main` only** | `needs: [test, codeql, docker-build]` + `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`. Authenticates **keyless via WIF**, then Cloud Run **source-deploys** the backend, reads back its URL, and deploys the frontend with `BACKEND_URL` wired to it. |

**The deploy job runs only if all three gate jobs pass, and only on a merge to `main`** — never on a PR, and never on a fork PR (where the WIF repo variables are absent). The `if:` guard is what prevents the auth step from firing in contexts that lack the deploy config. A per-ref `concurrency` group cancels superseded PR runs but **serializes** main runs so a deploy is never interrupted mid-flight.

Design decisions baked into the workflow:

- **Keyless auth (WIF).** The `deploy` job requests an OIDC token (`permissions: id-token: write`) and impersonates a deploy service account via a workload identity provider locked to this repo. **No long-lived credential is stored in GitHub.** A preflight step fails with a readable message if the `GCP_*` repo variables are missing (instead of the auth action's cryptic "must specify exactly one of workload_identity_provider or credentials_json").
- **App secrets stay in Secret Manager.** `ANTHROPIC_API_KEY` and `RESEND_API_KEY` are attached with `--set-secrets` (`anthropic-api-key:latest`, `resend-api-key:latest`); the workflow never sees their values. `GOOGLE_CLOUD_PROJECT` is injected by Cloud Run automatically and is **not** set in the workflow.
- **Cloud Run source deploy.** `gcloud run deploy --source` builds each image with Cloud Build from the Dockerfile — no Artifact Registry wiring by hand, fitting the app's no-build-step design.
- **Backend deploy flags** encode the documented shape: `--memory 600Mi --max-instances 10 --timeout 600`. **Frontend:** `--memory 256Mi --max-instances 5`.

Configuration lives in **GitHub repo variables** (Settings → Secrets and variables → Actions → Variables), not secrets — WIF means **zero secrets are stored in GitHub**:

| Variable | Purpose |
|----------|---------|
| `GCP_PROJECT_ID` | Target project (e.g. `root-and-fruit-app`). |
| `GCP_REGION` | Cloud Run region (e.g. `us-central1`). |
| `GCP_WIF_PROVIDER` | Full workload-identity-provider resource name. |
| `GCP_DEPLOY_SA` | Deploy service-account email the workflow impersonates. |
| *(optional)* `ANTHROPIC_MODEL`, `REGISTRATION_EMAIL`, `REGISTRATION_FROM`, `DONATION_URL`, `ALLOWED_ORIGIN`, `FREE_CREDITS`, `APP_VERSION` | Passed through as env vars only when set; unset → the app's built-in defaults apply. |
| *(optional, enables auth)* `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` (+ `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`) | Public Firebase web config, forwarded to the frontend deploy (and `FIREBASE_PROJECT_ID` to the backend). Set per-Environment (development/production) for separate Firebase projects. Any absent → auth stays off, frontend fully anonymous. |

One-time GCP setup (not automated — run once by an operator): enable the `run`, `cloudbuild`, `artifactregistry`, `iamcredentials`, and `secretmanager` APIs; create the two Secret Manager secrets; create the deploy SA with `run.admin` + `cloudbuild.builds.editor` + `artifactregistry.admin` + `storage.admin` + `iam.serviceAccountUser`; grant the **runtime** SA `datastore.user` + `secretmanager.secretAccessor`; and create the WIF pool/provider bound to this repo. The `audits` composite index still must be created manually — the workflow does not manage Firestore indexes.

**Gotchas:** both Secret Manager secrets must exist before the first deploy or the backend step fails (create `resend-api-key` with a placeholder if Resend isn't in use yet, or drop its token from `--set-secrets`). CORS stays `*` until `ALLOWED_ORIGIN` is set as a repo variable.

### Local dev

Backend:
```bash
cd backend
npm ci
ANTHROPIC_API_KEY=sk-ant-... GOOGLE_CLOUD_PROJECT=root-and-fruit-app npm run dev
# → http://localhost:8080  (or 8081 if you set PORT)
```

Frontend:
```bash
cd frontend
npm ci
BACKEND_URL=http://localhost:8081 npm run dev
# → http://localhost:8080
```

The frontend hits `BACKEND_URL` directly — no proxy. The backend's `cors({ origin: '*' })` default permits this.

You can run the frontend with **no backend** and the manual scoring + localStorage save flow still works. Auto-Audit / cloud save / cloud share will fail and toast appropriately.

---

## Data Model

### Audit object (frontend → `/api/audits` → Firestore `audits` doc)

`buildAuditObject()` returns:
```js
{
  id: number,                  // Date.now() — used for local matching only; Firestore generates its own doc id
  name: string,
  subjectType: 'candidate' | 'policy',
  total: number,               // 0..60
  verdict: string,             // e.g. "THE VANGUARD"
  date: string,                // localized
  pathway: 'elected' | 'community',
  scores: { root, branch, fruit, vis, toxic },
  fruitVals: number[5],        // 0..3
  visVal: number,              // 0..10
  rootChecked: boolean[5],
  branchChecked: boolean[5],
  toxicChecked: boolean[3]
}
```

The backend adds `userId`, `id` (Firestore-generated), `createdAt`, `updatedAt` before persisting.

### Shared audit (`shared_audits/{token}`)

```js
{ audit, token, createdAt, views }
```

Tokens are **non-cryptographic** (`Math.random().toString(36).slice(2,10) + Date.now().toString(36)`). They are unguessable enough for casual sharing but **must not** be used for any security-sensitive context. If sharing tokens ever become sensitive, switch to `crypto.randomBytes(16).toString('hex')`.

---

## Code Conventions

### Function documentation (required for all new functions)

**Every function created in this project MUST carry a doc comment that states three things:**

1. **What the function does** — a one-line (or short) description of its purpose.
2. **Inputs** — each parameter, its type, and its meaning. State "none" if it takes no arguments.
3. **Outputs** — the return value and its type/shape, plus any notable side effects (DOM mutation, Firestore write, network call). State "none / void" if it returns nothing.

This applies to **all** functions across every surface: backend modules (`backend/**`), the inline `<script>` functions in `frontend/public/index.html`, `frontend/server.js`, and test helpers. It applies to new functions and to any existing function you meaningfully change. This is a hard project rule — it overrides the general "match surrounding comment density" guidance.

**Preferred format — JSDoc** (works for backend modules and the frontend single file alike):

```js
/**
 * Build the cache document ID for a subject.
 * @param {string} subject  raw user search string
 * @param {object} [extra]  extra key dimensions (subjectType, pathway, …)
 * @returns {{docId: string, normalized: string}}  32-char hex ID + normalized subject
 */
function cacheKey(subject, extra = {}) { /* … */ }
```

For a tiny helper where full JSDoc is overkill, a two- or three-line block comment is acceptable **as long as it still names the purpose, the inputs, and the output** — e.g.:

```js
// Escape a value for safe innerHTML interpolation.
// in:  v (any) — untrusted value
// out: string — HTML-entity-encoded text
function escapeHtml(v) { /* … */ }
```

`backend/lib/cacheKey.js` is the reference example for the JSDoc style. Do not ship a new function with an undocumented signature.

---

## Styling Conventions

- All styles are in a `<style>` block at the top of `index.html`. CSS custom properties (CSS variables) define the palette under `:root`.
- Color palette — the app is a **light/eggshell** theme with navy chrome and gold accents:
  - Background: `--black: #F5F1E8` (eggshell — the name is a leftover from the original dark theme, **not** a dark value), `--surface: #FFFFFF`, `--surface2: #EDE9DF`
  - Chrome: `--navy: #0D1B3E` (header, nav bar, radar chart), `--gold-bright: #E8C96A` (on-navy text)
  - Borders: `--border: #D4CDB8`, `--border-light: #C4BC9E`
  - Section accents: `--gold: #8B6914` (Root), `--blue: #2563a8` (Branches), `--green: #2a9d5c` (Fruit), `--orange: #c4620a` (Light/Visibility), `--red: #c0392b` (Toxic)
  - Text: `--text: #1a1a18`, `--text-dim: #5a5248`, `--text-dimmer: #9a9080`
- Typography: Bebas Neue (display), DM Sans (body), DM Mono (labels/badges). All loaded from Google Fonts CDN.
- Decorative grain overlay is implemented as an inline-SVG noise filter on `body::before`.
- Inline styles (`style="..."`) are used freely inside the dynamically-rendered audit report — keep them; don't add a CSS framework.

---

## Extension Points

### Adding a new scoring criterion

If you add a new boolean to **Root** (or a new slider to **Fruit**, etc.), you must update **all** of:
1. The DOM in `index.html` (a new `.check-row` / `.slider-card`).
2. `MAX` constants and the per-section sums in `calculate()`.
3. The corresponding section labels arrays inside `setType` and `renderAuditReport` (`rootLabels`, `branchLabels`, `fruitLabels`, `toxicLabels`).
4. **The locked prompt** — same locked-prompt rules apply. Coordinate explicitly.
5. The radar chart in `drawRadar` (axis count, labels, normalization), if it touches one of the radar dimensions.
6. The share-card categories in `drawShareCard` if you want it visible there.
7. The audit object schema (`buildAuditObject` + `loadAudit`) so save/load round-trips correctly. Old saved audits without the new field need a tolerant load.

### Adding a new view (nav tab)

1. Add a `<button class="nav-tab">` and a `<div class="view">` block.
2. Add the slug to the `tabs` array inside the **bottom** `showView` (the canonical one), not the earlier one.
3. If the view needs setup, branch on `v === 'yourview'` inside `showView` to call its initializer.

### Adding a new backend endpoint

1. Add the route to `backend/server.js`. Keep handlers small and async-arrow-style; use the existing `try/catch` pattern with `console.error` + status pass-through.
2. Update CORS only if you need new methods/headers.
3. If it touches Firestore with new query patterns, **add the corresponding composite index** in your deployment environment before shipping — Firestore will refuse the query otherwise.
4. Wire a frontend caller through `CloudAuditStore` (or a new sibling object). Always thread the dynamic `getBackendUrl()` — never hardcode.

### Adding a new Anthropic capability (e.g. tool, beta header)

Two backend handlers talk to Anthropic: `/api/analyze` (`anthropic.messages.stream({...})` + `finalMessage()`, adaptive thinking) and `/api/search` (`anthropic.messages.create({...})`, web_search only, no thinking — used by the Scrubber/Electability). Modify the arguments in the relevant handler. If you switch `/api/analyze` from `messages.stream` to `messages.create`, remove the `finalMessage()` call. Keep all browser → Anthropic traffic flowing through one of these proxies; never add a browser-direct call.

---

## What Claude Should Never Do in This Project

- **Do not** modify `buildAuditPrompt` (the locked prompt) or the analyze-time short system message without an explicit, agreed-upon change request and a Billion Godson regression test plan.
- **Do not** introduce a frontend bundler (Vite, webpack, esbuild, etc.) or split `frontend/public/index.html` into multiple files. The single-file constraint is intentional.
- **Do not** add a frontend framework (React, Vue, Svelte, …). The app is vanilla JS by design.
- **Do not** call `https://api.anthropic.com` from the browser. Always go through a backend proxy — `${backendUrl}/api/analyze` for the main audit, `${backendUrl}/api/search` for the Scrubber/Electability lookups.
- **Do not** hardcode the backend URL into the frontend image — read it from `window.__RF_CONFIG__.backendUrl`. The runtime injection in `frontend/server.js` is load-bearing.
- **Do not** commit any file containing the Anthropic API key, service account JSON, or other secrets.
- **Do not** weaken Firestore ownership checks (`/api/audits/:userId/:auditId` must reject when the doc's `userId` doesn't match the path).
- **Do not** trust a client-supplied credit balance, plan, or entitlement, and **do not** let a client-writable field reach `accounts` outside `profilePatch()`'s allowlist. The balance is server-owned; the browser's copy is display state only.
- **Do not** grant credits from anywhere except `ensureAccount()`'s one-time grant (and, later, the signature-verified Stripe webhook). A URL parameter, a redirect, or a client call must never increase a balance.
- **Do not** issue the free grant to an unverified address, and do not drop the `billableAllowed()` check on the billed routes. Without the verification gate the credit quota is decorative — a throwaway `+alias` mints another 5 Opus calls, and the Anthropic bill is unbounded.
- **Do not** remove the `requireAuth()` gate or the debit on `/api/analyze` / `/api/search` — without them the Anthropic key is an open, unmetered bill.
- **Do not** treat `/api/share/:token` tokens as a security boundary — they are casual share URLs only. If something stronger is needed, switch to `crypto.randomBytes`.
- **Do not** alter the verdict thresholds, section maxima, or 57-point total without updating the verdict labels, share-card layout, and methodology copy together.
- **Do not** introduce session affinity, in-memory caching, or sticky sessions on Cloud Run — both services are stateless.
- **Do not** remove the cache-control wrapping around the system prompt in `/api/analyze`. It is a no-op below the threshold and a free win above it.
- **Do not** remove `localStorage` use from the frontend. It powers the per-browser user ID and the offline-fallback save path — both are intentional. (CivicSorter's no-localStorage rule does **not** apply here.)
- **Do not** add a function without a doc comment stating its purpose, inputs, and outputs — see [Code Conventions](#code-conventions). This is required for every new or meaningfully-changed function on all surfaces.
