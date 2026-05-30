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
├── backend/
│   ├── server.js         # Express API: /api/analyze, /api/audits, /api/share, /health
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── public/
│   │   └── index.html    # the entire frontend app (single file)
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
any Node-friendly platform; the reference deployment is Google Cloud Run.

**Deploy the backend first** (the frontend needs its URL):

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

There is **no CI/CD or infra-as-code in this repo** by design — it ships
application code only.

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

No automated tests yet — `npm test` in each service is a passing placeholder.
