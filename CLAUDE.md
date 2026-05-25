# CLAUDE.md — Root & Fruit (Integrity Index)

## Project Overview

**Root & Fruit** is a civic accountability tool that scores elected officials, community leaders, and policies/bills against a 60-point **Integrity Index** rooted in Black community-centered values.

The app is two stateless Cloud Run services — a **frontend** (vanilla HTML/CSS/JS, single page) and a **backend** (Node + Express) — backed by **Firestore** for audit persistence and the **Anthropic API** for AI-driven auto-audits ("Forensic Audit") that combine adaptive thinking with server-side web search.

The app supports manual audits (a human checks boxes / drags sliders), AI-assisted audits (Claude pre-fills the form against current public sources), saved audits per user, comparison between two audits, public shareable links, share-card image export, and PDF export.

---

## Tech Stack

- **Frontend:** vanilla HTML + CSS + JS in a **single file** (`frontend/public/index.html`) served by a thin Express runtime-config injector. **No bundler, no framework, no build step.**
  - External libs are loaded from CDNs only: Google Fonts (Bebas Neue, DM Sans, DM Mono), Font Awesome, jsPDF.
  - All app state lives in module-level JS variables in the inline `<script>`. Persistence is via `localStorage` (user ID + offline cache) and the backend (`/api/audits`).
- **Backend:** Node 20 + Express. Dependencies kept tight: `@anthropic-ai/sdk`, `@google-cloud/firestore`, `cors`, `express`.
- **AI integration:** Anthropic API via `@anthropic-ai/sdk`. Default model is `claude-opus-4-7` (override with `ANTHROPIC_MODEL`). Uses **adaptive thinking** + `web_search_20260209` tool (max 5 uses). System prompt is wrapped with `cache_control: ephemeral` so repeated audits start hitting the prompt cache once it grows past the model's minimum-prefix threshold.
- **Storage:** Firestore Native, two collections — `audits` (keyed by user) and `shared_audits` (token-keyed, public-readable).
- **Deploy:** Designed for two stateless containers (`root-and-fruit-backend`, `root-and-fruit-frontend`) suitable for Cloud Run, Fly, Render, or any platform that runs a Node container and can wire `BACKEND_URL` into the frontend at runtime. **No CI/CD or infra-as-code is checked in** — the repo ships application code only.

---

## Repository Layout

```
root-and-fruit/
├── backend/
│   ├── server.js         ← Express API: /api/analyze, /api/audits, /api/share, /health
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
   ├── POST /api/audits               → Firestore: audits.add({userId, ...audit})
   ├── GET  /api/audits/:userId       → Firestore: audits.where(userId).orderBy(createdAt desc)
   ├── DELETE /api/audits/:userId/:id → Firestore: audits.delete (with userId ownership check)
   ├── POST /api/share                → mints token, writes shared_audits.{token}
   └── GET  /api/share/:token         → reads shared_audits, increments views
                                                                                      │
                                                                                      ▼
                                                                                 Firestore
                                                                            (collections:
                                                                              audits, shared_audits)
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

Five views are rendered as sibling `<div class="view">` elements; `showView(v)` toggles the `.active` class. The current view is also reflected in the top nav tabs.

| View              | Purpose                                                          |
|-------------------|------------------------------------------------------------------|
| `assess`          | Subject input + 5 scoring cards (Root, Branches, Fruit, Light, Toxic) |
| `results`         | Verdict, score breakdown, radar chart, share-card preview       |
| `compare`         | Side-by-side comparison of two saved audits                     |
| `saved`           | List of saved audits (cloud-first, local fallback)              |
| `methodology`     | Static educational content explaining the framework             |

`showView('results')` triggers `updateResultsView()` and `drawShareCard()` (after a 100ms tick).
`showView('saved')` triggers `renderSavedList()`.
`showView('compare')` triggers `populateCompareSelects()`.

> **NOTE:** `showView` is defined twice in the file. The second definition (near the bottom) is the canonical one and includes the `methodology` tab + share-card draw. The earlier one is dead code — leave it alone unless you're doing a focused cleanup PR.

### Subject model

Two **subject types** (toggled by `setType(t)`):
- `candidate` — human (elected official, community leader, etc.)
- `policy` — bill or policy

When subject type is `candidate`, a second toggle exposes a **pathway**:
- `elected` — held formal office (default)
- `community` — organizer / activist / civic leader

The pathway changes the framing of "Fruit" scoring. Community-leader Fruit reflects organizing wins, institutions built, and lasting community impact — **not legislation**. The locked prompt enforces equal weight.

### Scoring (60-point Integrity Index)

| Section          | Mechanic                | Max | Notes                                                  |
|------------------|-------------------------|----:|--------------------------------------------------------|
| Root (Values)    | 5 checkboxes × 5 pts    |  25 | Boolean. Foundational worldview.                       |
| Branches (Advocacy) | 5 checkboxes × 2 pts |  10 | Boolean. Public stances and organizing efforts.        |
| Fruit (Outcomes) | 5 sliders × 0–3 pts     |  15 | Tiered: None / Talk / Pilot or Partial / Full impact.  |
| Light (Visibility) | 1 slider 0–10 pts     |  10 | Documentation richness — voting AND organizing AND press AND testimony all count. |
| Toxic Soil       | 3 checkboxes (penalties)| −15 | Subtracted: Gatekeeper −3, Plantation −4, Betrayal −8. (For policy: Carve-Out / Trojan Horse / Unfunded Mandate.) |

`calculate()` recomputes total = `max(0, root + branch + fruit + vis - toxic)`. The verdict tiers in `getVerdict(score)`:

| Threshold | Candidate label  | Policy label          |
|----------:|------------------|-----------------------|
| ≥ 52      | THE VANGUARD     | TRANSFORMATIVE LAW    |
| ≥ 42      | THE WORKER       | PROGRESSIVE REFORM    |
| ≥ 32      | THE PRAGMATIST   | INCREMENTAL REFORM    |
| ≥ 20      | THE POLITICIAN   | MAINTENANCE BILL      |
| ≥ 10      | THE OBSTACLE     | HARMFUL POLICY        |
| < 10      | THE OPPOSITION   | DETRIMENTAL POLICY    |

Verdict colors come from CSS variables (`--green`, `--gold`, `--blue`, `--orange`, `--red`).

### Auto-Audit (Claude AI)

Triggered by `autoAnalyze()`. Builds a system prompt via `buildAuditPrompt(target, isCandidate, isCommunity)`, posts to `${backendUrl}/api/analyze`, parses the returned JSON, and animates the form via `applyAnalysis(data)` — checkboxes flip in sequence, sliders ramp up tick by tick. The text report renders into `#auditContent` via `renderAuditReport`.

**Expected JSON shape from Claude (see locked prompt):**
```js
{
  historicalBackground: string,        // 2–3 substantive paragraphs
  supporters: string[],
  opponents: string[],
  root:     [{met: bool, reasoning: string}, ... 5 items],
  branches: [{met: bool, reasoning: string}, ... 5 items],
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
| POST   | `/api/analyze`                    | Anthropic Messages proxy. Body: `{messages, system, max_tokens?}`. Wraps `system` with `cache_control: ephemeral`. Streams to `finalMessage()`. Returns the full Anthropic message object. |
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

`buildAuditPrompt(target, isCandidate, isCommunity)` in [frontend/public/index.html](frontend/public/index.html) (≈ line 1328) is the **confirmed working baseline** as of the session where Billion Godson was accurately evaluated. It is wrapped in a banner comment that reads:

> Any change to this function MUST be:
> 1. Explicitly agreed upon before editing
> 2. Tested against Billion Godson immediately after
> 3. Rolled back if the result regresses
>
> Do NOT modify this function as a side effect of other changes.

**Treat this as a hard constraint.** If a refactor happens to touch the function, restore it exactly. If the user asks for a prompt change, confirm explicitly, propose the diff, then plan to regression-test against Billion Godson before merging.

The short system message at the call site (line ≈ 1453) — the one that reminds Claude to return only valid JSON, never truncate `historicalBackground`, weight community-leader records equally, and use web_search to verify — is part of the same baseline. Same rules apply.

---

## Deployment

There is **no CI/CD or infra-as-code in this repo**. Deployment is whatever the operator wires up externally — typically two stateless containers built from `backend/Dockerfile` and `frontend/Dockerfile` and run on a Node-friendly platform (Cloud Run, Fly, Render, ECS, a plain VM, …).

The non-negotiable wiring:

1. Provision a Firestore (or Firestore-compatible) database. The app uses two collections: `audits` and `shared_audits`. The `audits` collection needs a **composite index on `(userId ASC, createdAt DESC)`** — Firestore will refuse the listing query otherwise.
2. Deploy the **backend** first. It needs `ANTHROPIC_API_KEY` (from a secret store, never a plaintext env), service-account credentials with Firestore read/write, and `GOOGLE_CLOUD_PROJECT` (or equivalent) for the Firestore client. Long-running AI requests can take tens of seconds — set the platform's request timeout to ≥ 300s.
3. Deploy the **frontend** with `BACKEND_URL` pointing at the backend's public URL. The frontend image carries no build-time config — `BACKEND_URL` is read at request time and injected into HTML via `frontend/server.js`.
4. (Optional) Tighten CORS by setting `ALLOWED_ORIGIN` on the backend to the frontend's public URL.

If you re-introduce CI/CD or Terraform later, keep the build order constraint in mind: the frontend deploy depends on the backend's URL, so the two cannot be parallelized.

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

The backend's analyze handler is the only place that talks to Anthropic. Modify `anthropic.messages.stream({...})` arguments there. If you switch from `messages.stream` to `messages.create`, remove the `finalMessage()` call.

---

## What Claude Should Never Do in This Project

- **Do not** modify `buildAuditPrompt` (the locked prompt) or the analyze-time short system message without an explicit, agreed-upon change request and a Billion Godson regression test plan.
- **Do not** introduce a frontend bundler (Vite, webpack, esbuild, etc.) or split `frontend/public/index.html` into multiple files. The single-file constraint is intentional.
- **Do not** add a frontend framework (React, Vue, Svelte, …). The app is vanilla JS by design.
- **Do not** call `https://api.anthropic.com` from the browser. Always go through `${backendUrl}/api/analyze`.
- **Do not** hardcode the backend URL into the frontend image — read it from `window.__RF_CONFIG__.backendUrl`. The runtime injection in `frontend/server.js` is load-bearing.
- **Do not** commit any file containing the Anthropic API key, service account JSON, or other secrets.
- **Do not** weaken Firestore ownership checks (`/api/audits/:userId/:auditId` must reject when the doc's `userId` doesn't match the path).
- **Do not** treat `/api/share/:token` tokens as a security boundary — they are casual share URLs only. If something stronger is needed, switch to `crypto.randomBytes`.
- **Do not** alter the verdict thresholds, section maxima, or 60-point total without updating the verdict labels, share-card layout, and methodology copy together.
- **Do not** introduce session affinity, in-memory caching, or sticky sessions on Cloud Run — both services are stateless.
- **Do not** remove the cache-control wrapping around the system prompt in `/api/analyze`. It is a no-op below the threshold and a free win above it.
- **Do not** remove `localStorage` use from the frontend. It powers the per-browser user ID and the offline-fallback save path — both are intentional. (CivicSorter's no-localStorage rule does **not** apply here.)
