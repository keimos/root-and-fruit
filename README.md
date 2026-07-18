# Root & Fruit — Integrity Index

A civic accountability tool that scores elected officials, community leaders, and
policies/bills against a 57-point **Integrity Index** rooted in Black
community-centered values (plus an optional +5 "People's Choice" community bonus
and a separate 0–10 "Light" transparency indicator that does **not** factor into
the composite score).

The app supports manual audits, AI-assisted "Forensic Audit" auto-fills (Claude +
server-side web search), saved audits per browser, comparison between two audits,
public shareable links, share-card image export, and PDF export.

---

## Architecture

Two stateless services, backed by Firestore and the Anthropic API.

```
Browser
   │  HTTPS
   ▼
frontend  (Node 20 + Express)         ← serves public/index.html, injects BACKEND_URL at request time
   │  fetch(`${BACKEND_URL}/api/...`)  (CORS)
   ▼
backend   (Node 20 + Express)         ← Anthropic proxy + Firestore persistence
   ├── Anthropic API (adaptive thinking + web_search)
   └── Firestore (collections: audits, shared_audits)
```

- **Frontend** is a single vanilla HTML/CSS/JS file (`frontend/public/index.html`) —
  no bundler, no framework, no build step. External libs load from CDNs. A thin
  Express server injects `window.__RF_CONFIG__.backendUrl` into the HTML at request
  time, so one image promotes across environments by changing only `BACKEND_URL`.
- **Backend** is a small Express API. The Anthropic API key lives only here and is
  never exposed to the browser.

See [CLAUDE.md](CLAUDE.md) for the full architecture rationale and contributor
guardrails.

---

## Repository layout

```
root-and-fruit/
├── .github/
│   └── workflows/
│       └── pipeline.yml  # CI/CD: test → codeql → docker-build → audit →
│                          # frontend-smoke → deploy (Cloud Run) → rollback
├── backend/
│   ├── server.js         # Express API: /api/analyze, /api/audits, /api/share, /health
│   ├── test/
│   │   ├── server.test.js  # node:test — HTTP integration
│   │   └── retry.test.js   # node:test — Anthropic retry helper
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── public/
│   │   └── index.html    # the entire frontend app (single file)
│   ├── test/
│   │   └── smoke.mjs     # Playwright nav smoke test (run via CI, see Tests)
│   ├── server.js         # static server + runtime config injection
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── .env.example
│   └── package.json
├── .editorconfig
├── .nvmrc                # Node 20
├── CLAUDE.md
└── README.md
```

---

## Prerequisites

- **Node 20+** (`.nvmrc` pins 20 — run `nvm use`).
- An **Anthropic API key** for auto-audits.
- A **Firestore** (Native mode) database for persistence. The `audits` collection
  needs a composite index on `(userId ASC, createdAt DESC)`.

---

## Local development

Each service reads its config from environment variables. Copy the examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

**Backend** (terminal 1):

```bash
cd backend
npm ci
PORT=8081 ANTHROPIC_API_KEY=sk-ant-... GOOGLE_CLOUD_PROJECT=root-and-fruit-app npm run dev
# → http://localhost:8081
```

**Frontend** (terminal 2):

```bash
cd frontend
npm ci
BACKEND_URL=http://localhost:8081 npm run dev
# → http://localhost:8080
```

The frontend hits `BACKEND_URL` directly — no proxy (the backend's default
`cors({ origin: '*' })` permits this). You can run the frontend with **no backend**
and the manual scoring + `localStorage` save flow still works; auto-audit, cloud
save, and cloud share will fail and toast appropriately.

---

## Environment variables

### Backend

| Variable                | Required | Default            | Notes                                                        |
|-------------------------|----------|--------------------|--------------------------------------------------------------|
| `ANTHROPIC_API_KEY`     | yes\*    | —                  | Without it the server boots but `/api/analyze` returns 500.  |
| `ANTHROPIC_MODEL`       | no       | `claude-opus-4-7`  | Model override.                                              |
| `GOOGLE_CLOUD_PROJECT`  | yes\*\*  | —                  | Firestore client project (`GCLOUD_PROJECT` also accepted).  |
| `ALLOWED_ORIGIN`        | no       | `*`                | CORS allowlist; set to the frontend URL in production.       |
| `PORT`                  | no       | `8080`             | Injected by Cloud Run.                                       |

\* required for AI auto-audits &nbsp;·&nbsp; \*\* required in production.

### Frontend

| Variable      | Required | Default                  | Notes                                                       |
|---------------|----------|--------------------------|-------------------------------------------------------------|
| `BACKEND_URL` | yes      | `http://localhost:8081`  | Injected into HTML as `window.__RF_CONFIG__.backendUrl`.    |
| `APP_VERSION` | no       | `1.0.0`                  | Surfaced in `__RF_CONFIG__.version`.                        |
| `NODE_ENV`    | no       | `production`             | Surfaced in `__RF_CONFIG__.env`.                            |
| `PORT`        | no       | `8080`                   | Injected by Cloud Run.                                      |

Never commit a real `.env` — `.gitignore` excludes `.env*` except `.env.example`.

---

## Deployment

Both services are stateless containers built from their `Dockerfile`s. They run on
any Node-friendly platform; the reference deployment is Google Cloud Run, driven by
the CI/CD pipeline at [`.github/workflows/pipeline.yml`](.github/workflows/pipeline.yml).

### CI/CD pipeline

On every pull request and push to `main`, five gate jobs run in parallel:

| Job              | Checks                                                             |
|-------------------|--------------------------------------------------------------------|
| `test`            | Backend `node:test` suite (`backend/test/`).                      |
| `codeql`          | CodeQL static analysis (`security-and-quality` query suite) over the backend, frontend server, and the inline `<script>` in `index.html`. Results in the repo's **Security → Code scanning** tab. |
| `docker-build`    | Both Dockerfiles build cleanly (compile check only — not pushed). |
| `audit`           | `npm audit --audit-level=critical` on the backend dependency tree. |
| `frontend-smoke`  | Boots `frontend/server.js` and drives every nav tab in headless Chromium (`frontend/test/smoke.mjs`) to catch broken navigation / uncaught JS errors. |

**Only on push to `main`, and only if every gate passes**, the `deploy` job runs:
records the currently-live revisions, deploys the backend (`--source` build via
Cloud Build), reads back its URL, deploys the frontend with `BACKEND_URL` wired to
it, then runs a post-deploy `curl` health check against both services' public URLs.

Auth is keyless — [Workload Identity Federation](https://github.com/google-github-actions/auth),
no long-lived GCP key stored in GitHub. Required repo variables (Settings →
Secrets and variables → Actions → Variables): `GCP_PROJECT_ID`, `GCP_REGION`,
`GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

**Rollback:** trigger the workflow manually (Actions → CI/CD Pipeline → *Run
workflow*) to reroute 100% of traffic to a prior Cloud Run revision without
rebuilding — pick `backend`, `frontend`, or `both`, and optionally a specific
revision name (defaults to the revision that was live before the last deploy).

### Manual / first-time deploy

For a first deploy, or deploying outside CI, the same two commands the pipeline
runs under the hood:

**Backend first** (the frontend needs its URL):

```bash
gcloud run deploy root-and-fruit-backend \
  --source backend \
  --region us-central1 \
  --project root-and-fruit-app
```

**Then the frontend**, pointing `BACKEND_URL` at the backend's public URL:

```bash
gcloud run deploy root-and-fruit-frontend \
  --source frontend \
  --region us-east1 \
  --project root-and-fruit-app
```

Wiring notes:

1. Provision Firestore (Native). Collections: `audits`, `shared_audits`. Add the
   composite index on `audits (userId ASC, createdAt DESC)`.
2. Backend needs `ANTHROPIC_API_KEY` (from a secret store), Firestore read/write
   credentials, and `GOOGLE_CLOUD_PROJECT`. AI requests can take tens of seconds —
   set the request timeout to ≥ 300s.
3. Frontend carries no build-time config; `BACKEND_URL` is read at request time.
4. (Optional) Tighten CORS with `ALLOWED_ORIGIN` on the backend.

Cloud Run keeps existing env vars across `--source` redeploys, so you only need to
pass `--set-env-vars` when actually changing one.

---

## API

| Method | Path                              | Description                                          |
|--------|-----------------------------------|------------------------------------------------------|
| GET    | `/health`                         | Liveness — `{status:"ok", ts}`.                      |
| POST   | `/api/analyze`                    | Anthropic Messages proxy (adaptive thinking + web search). |
| POST   | `/api/audits`                     | Save an audit for a user.                            |
| GET    | `/api/audits/:userId`             | List a user's audits (newest first).                |
| DELETE | `/api/audits/:userId/:auditId`    | Delete an audit (ownership-checked).                |
| POST   | `/api/share`                      | Mint a public share token.                          |
| GET    | `/api/share/:token`               | Read a shared audit (increments views).             |

---

## Tests

**Backend** — `node:test` HTTP integration + unit tests:

```bash
cd backend
npm ci
npm test
```

**Frontend** — no unit tests (`npm test` is a passing placeholder — the app is a
single static file with no build step). CI instead runs a Playwright smoke test
that boots the server and clicks through every nav tab in headless Chromium,
catching uncaught JS errors and nav/view-routing drift:

```bash
cd frontend
npm ci
npm i -D --no-save playwright && npx playwright install chromium
node test/smoke.mjs
```
