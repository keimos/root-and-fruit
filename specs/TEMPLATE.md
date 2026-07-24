# NNNN — <Feature title>

- **Status:** Draft | Approved | In progress | Shipped | Superseded
- **Author:** <name>
- **Date:** <YYYY-MM-DD>
- **Tracking:** <issue / PR link, if any>

## 1. Intent — why
<1–3 sentences: the problem or opportunity, and who it's for. If it doesn't
change what a user can do or trust, say that plainly.>

## 2. Scope
- **In:** <what this feature does>
- **Out:** <explicitly what it does NOT do — the boundary that keeps it small>

## 3. Guardrails — which hard constraints does this touch?
Tick every box that applies; each maps to a rule in CLAUDE.md. **Any ticked box
must be addressed in §6 (Regression & tests).**

- [ ] **Single-file frontend** — all frontend changes stay in
      `frontend/public/index.html`. No bundler, no framework, no second file.
- [ ] **Locked prompt** — touches `buildAuditPrompt` or the `/api/analyze` short
      system message. → **Requires** the Billion Godson regression plan in §6
      *and* explicit sign-off before merge.
- [ ] **Scoring change** — adds/alters a Root/Branches/Fruit/Toxic/Light
      criterion, a `MAX`, or a verdict threshold. → **Requires** the 7-step
      "Adding a new scoring criterion" checklist (CLAUDE.md → Extension Points),
      plus verdict-label / share-card / methodology updates in lockstep.
- [ ] **New/changed backend endpoint** — CORS reviewed; any new Firestore
      composite index created in the deploy environments **before** ship.
- [ ] **Browser → Anthropic** — routed through `/api/analyze` or `/api/search`
      only. Never a browser-direct call.
- [ ] **New or changed functions** — each carries a doc comment (purpose,
      inputs, outputs), per CLAUDE.md → Code Conventions.
- [ ] **Persistence** — `localStorage` user-ID / offline cache and the Firestore
      ownership checks are preserved (not removed or weakened).
- [ ] None of the above (pure additive UI / copy / infra change).

## 4. Design sketch
<A few bullets: key functions/DOM added or changed, data shape, and the
request/response for any new endpoint. Only what a reviewer needs — not full
code.>

## 5. Acceptance criteria
<Verifiable outcomes. Prefer criteria something can CHECK over prose.>
- [ ] <user-visible behavior — e.g. "Results view shows X when Y">
- [ ] Backend: <new node:test case in `backend/test/` passes>
- [ ] Frontend: survives the nav smoke test (`frontend/test/smoke.mjs`) with no
      uncaught errors
- [ ] Data round-trips: save → reload → identical
      (`buildAuditObject` / `loadAudit`), old audits still load

## 6. Regression & tests
- **New tests:** <files / cases you'll add>
- **Locked-prompt regression** (required if §3 "Locked prompt" is ticked): run
  Billion Godson through the dev deploy; expected verdict stays **THE WORKER**
  (the `EXPECTED_VERDICT` baseline). If this change *intends* to move it, state
  the new expected verdict and why, and update `EXPECTED_VERDICT` in the same
  change.
- **Manual checks:** <anything not automatable>

## 7. Rollout
Default path: land on `develop-dev` → dev deploy + regression green → open a
`develop-dev → main` PR (full gates) → approve the prod deploy. Note anything
non-default here: feature flag, data migration, new index, new env var/secret.

## 8. Open questions
<Unknowns to resolve before or during implementation. Delete if none.>
