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
- **Backend:** Node 20 + Express. Dependencies kept tight: `@anthropic-ai/sdk`, `@google-cloud/firestore`, `cors`, `express`.
- **AI integration:** Anthropic API via `@anthropic-ai/sdk`. Default model is `claude-opus-4-7` (override with `ANTHROPIC_MODEL`). Uses **adaptive thinking** + `web_search_20260209` tool (max 5 uses). System prompt is wrapped with `cache_control: ephemeral` so repeated audits start hitting the prompt cache once it grows past the model's minimum-prefix threshold.
- **Storage:** Firestore Native, three collections — `audits` (keyed by user), `shared_audits` (token-keyed, public-readable), and `registrations` (append-only splash-registration leads).
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
| POST   | `/api/analyze`                    | Anthropic Messages proxy for the main audit. Body: `{messages, system, max_tokens?}`. Wraps `system` with `cache_control: ephemeral`, uses adaptive thinking + web_search. Streams to `finalMessage()`. Returns the full Anthropic message object. |
| POST   | `/api/search`                     | Lighter web-search proxy for the **Legislative Scrubber** and **Electability Rating**. Body: `{messages, system, max_tokens?=3000, max_uses?=4}`. **No** adaptive thinking (structured extract-from-search task); uses `messages.create` + web_search. Returns the full Anthropic message object. Keeps the key server-side just like `/api/analyze`. |
| POST   | `/api/register`                   | Splash registration. Body: `{name, email, phone?, org?, isEvent?, eventName?, eventLocation?, eventDate?}`. Validates name + email, persists the lead to Firestore `registrations` (best-effort), then sends a team notification + registrant auto-reply via **Resend** (best-effort — `RESEND_API_KEY` only). Returns `{ ok:true, stored, emailed }`; email failures don't fail the request. Replaces the old `mailto:`/FormSubmit flow. |
| POST   | `/api/audits`                     | `{userId, audit}` → adds doc with `createdAt`/`updatedAt` Firestore timestamps. |
| GET    | `/api/audits/:userId`             | Returns audits for a user, ordered by `createdAt desc`, capped at `limit` (default 50, max 100). Timestamps converted to ISO strings. |
| DELETE | `/api/audits/:userId/:auditId`    | Verifies ownership before deleting (403 if `userId` doesn't match). |
| POST   | `/api/share`                      | `{audit}` → mints a random token (`Math.random + Date.now`-based), writes `shared_audits/{token}`. Returns `{token, url}`. |
| GET    | `/api/share/:token`               | Reads `shared_audits/{token}`, increments `views` async, returns the audit. |

### CORS

`cors({ origin: ALLOWED_ORIGIN || '*' })` — wide-open by default, intentionally. Tighten by setting `ALLOWED_ORIGIN` to the frontend's Cloud Run URL once the domain is final.

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
| `PORT`                  | no      | Cloud Run injects it. Defaults to 8080 locally.                                              |

| Frontend env var        | Required | Notes                                                                                        |
|-------------------------|---------|----------------------------------------------------------------------------------------------|
| `BACKEND_URL`           | yes     | Backend Cloud Run URL. Injected into HTML at request time as `window.__RF_CONFIG__.backendUrl`. |
| `APP_VERSION`           | no      | Surfaced in `__RF_CONFIG__.version`.                                                         |
| `NODE_ENV`              | no      | Surfaced in `__RF_CONFIG__.env`.                                                             |
| `PORT`                  | no      | Cloud Run injects it.                                                                        |

---

## Locked Prompt — DO NOT CASUALLY MODIFY

`buildAuditPrompt(target, isCandidate, isCommunity)` in [frontend/public/index.html](frontend/public/index.html) is the locked prompt.

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

1. Provision a Firestore (or Firestore-compatible) database. The app uses three collections: `audits`, `shared_audits`, and `registrations`. The `audits` collection needs a **composite index on `(userId ASC, createdAt DESC)`** — Firestore will refuse the listing query otherwise. `registrations` is append-only (no ordered query), so it needs no special index.
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
| *(optional)* `ANTHROPIC_MODEL`, `REGISTRATION_EMAIL`, `REGISTRATION_FROM`, `DONATION_URL`, `ALLOWED_ORIGIN`, `APP_VERSION` | Passed through as env vars only when set; unset → the app's built-in defaults apply. |

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
- Color palette:
  - Background: `--black: #080808`, `--surface: #111111`, `--surface2: #1a1a1a`
  - Borders: `--border: #2a2a2a`, `--border-light: #333`
  - Section accents: `--gold` (Root), `--blue` (Branches), `--green` (Fruit), `--orange` (Light/Visibility), `--red` (Toxic)
  - Text: `--text: #e8e8e8`, `--text-dim: #888`, `--text-dimmer: #555`
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
- **Do not** treat `/api/share/:token` tokens as a security boundary — they are casual share URLs only. If something stronger is needed, switch to `crypto.randomBytes`.
- **Do not** alter the verdict thresholds, section maxima, or 57-point total without updating the verdict labels, share-card layout, and methodology copy together.
- **Do not** introduce session affinity, in-memory caching, or sticky sessions on Cloud Run — both services are stateless.
- **Do not** remove the cache-control wrapping around the system prompt in `/api/analyze`. It is a no-op below the threshold and a free win above it.
- **Do not** remove `localStorage` use from the frontend. It powers the per-browser user ID and the offline-fallback save path — both are intentional. (CivicSorter's no-localStorage rule does **not** apply here.)
- **Do not** add a function without a doc comment stating its purpose, inputs, and outputs — see [Code Conventions](#code-conventions). This is required for every new or meaningfully-changed function on all surfaces.
