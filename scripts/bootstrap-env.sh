#!/usr/bin/env bash
#
# bootstrap-env.sh — one-time GCP setup for the Root & Fruit development
# project (root-and-fruit-dev), mirroring the production project's config.
#
# What it does (idempotent — safe to re-run):
#   1. Enables the required GCP APIs on the target project.
#   2. Grants the SHARED deploy service account (which lives in the prod
#      project) the deploy roles ON the target project — cross-project
#      impersonation, so branch/merge deploys can build + deploy here.
#   3. Grants the target project's Compute default SA the build role plus the
#      runtime roles (Firestore + Secret Manager) — it is both the Cloud Build
#      identity for `--source` deploys and the Cloud Run runtime identity.
#   4. Creates the Firestore Native database (us-east1, matching prod) and the
#      audits composite index the listing query requires.
#   5. Stores the Anthropic (and Resend) API keys in Secret Manager under the
#      SAME names prod uses, so the CI `--set-secrets` line never has to branch
#      by environment (Option A — per-project secrets).
#
# Secret VALUES are read from environment variables so they never touch disk,
# git, or shell history.
#
# Usage:
#   ANTHROPIC_API_KEY_VALUE='sk-ant-...'  \
#   RESEND_API_KEY_VALUE='re_...'         \  # optional — placeholder if unset
#     ./scripts/bootstrap-env.sh dev
#
# Re-running with no ANTHROPIC_API_KEY_VALUE is fine once the secret exists —
# the secret step is skipped rather than clobbered.
#
# Optional cleanup of the interim prod-project duplicate (anthropic-api-dev-key).
# Run ONLY after a successful deploy has proven the new per-project secret works:
#   CLEANUP_PROD_DUP=1 ./scripts/bootstrap-env.sh dev
#
# Prereq: gcloud authenticated as a principal with owner (or editor + project
# IAM admin) on the target project.

set -euo pipefail

# ── Resolve target environment → project ────────────────────────────────────
ENVIRONMENT="${1:-dev}"
case "$ENVIRONMENT" in
  dev) PROJECT_ID="root-and-fruit-dev"; PROD_DUP_SECRET="anthropic-api-dev-key" ;;
  *) echo "Usage: $0 [dev]   (staging retired — dev is the only non-prod env; got: '${ENVIRONMENT}')" >&2; exit 1 ;;
esac

# ── Fixed facts shared with production ───────────────────────────────────────
PROD_PROJECT="root-and-fruit-app"                                   # holds WIF + deploy SA + interim dup secrets
DEPLOY_SA="deploy-sa@${PROD_PROJECT}.iam.gserviceaccount.com"       # the SA GitHub Actions impersonates via WIF
FIRESTORE_LOCATION="us-east1"                                       # match prod
SECRET_ANTHROPIC="anthropic-api-key"                                # same name per project (Option A)
SECRET_RESEND="resend-api-key"

# step MSG — print a section banner.
# in:  MSG (string)
# out: none (stdout)
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# grant PROJECT SA ROLE — idempotently add one project-level IAM binding.
# in:  PROJECT (project id), SA (member email), ROLE (roles/...)
# out: none (mutates IAM policy; add-iam-policy-binding is a no-op if present)
grant() {
  local project="$1" sa="$2" role="$3"
  gcloud projects add-iam-policy-binding "$project" \
    --member="serviceAccount:${sa}" --role="$role" \
    --condition=None --quiet >/dev/null
  echo "  ✓ ${sa} → ${role}"
}

# put_secret PROJECT NAME VALUE — create the secret or add a new version.
# in:  PROJECT (project id), NAME (secret id), VALUE (secret material)
# out: none (writes to Secret Manager)
put_secret() {
  local project="$1" name="$2" value="$3"
  if gcloud secrets describe "$name" --project="$project" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --project="$project" --data-file=- >/dev/null
    echo "  ✓ added new version to ${name}"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --project="$project" \
      --replication-policy=automatic --data-file=- >/dev/null
    echo "  ✓ created ${name}"
  fi
}

echo "Bootstrapping '${ENVIRONMENT}' → project ${PROJECT_ID}"

# ── Cleanup-only mode (destructive; opt-in) ─────────────────────────────────
if [[ "${CLEANUP_PROD_DUP:-}" == "1" ]]; then
  step "Deleting interim prod-project duplicate secret: ${PROD_DUP_SECRET} (in ${PROD_PROJECT})"
  if gcloud secrets describe "$PROD_DUP_SECRET" --project="$PROD_PROJECT" >/dev/null 2>&1; then
    gcloud secrets delete "$PROD_DUP_SECRET" --project="$PROD_PROJECT" --quiet
    echo "  ✓ deleted ${PROD_DUP_SECRET}"
  else
    echo "  – ${PROD_DUP_SECRET} not present; nothing to delete"
  fi
  echo "Cleanup done."
  exit 0
fi

# ── 1. Enable APIs ──────────────────────────────────────────────────────────
step "Enabling APIs on ${PROJECT_ID}"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  compute.googleapis.com \
  --project="$PROJECT_ID"
echo "  ✓ APIs enabled (compute is included so the Compute default SA exists)"

# Compute default SA — created once the Compute API is on. It is both the
# Cloud Build identity for `--source` deploys and the Cloud Run runtime identity.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "  Compute default SA: ${COMPUTE_SA}"

# ── 2. Deploy SA cross-project roles (build + deploy here) ───────────────────
step "Granting deploy SA the deploy roles on ${PROJECT_ID}"
for role in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.admin \
  roles/storage.admin \
  roles/iam.serviceAccountUser; do
  grant "$PROJECT_ID" "$DEPLOY_SA" "$role"
done

# ── 3. Compute SA: build role + runtime roles ────────────────────────────────
step "Granting the Compute default SA its build + runtime roles"
for role in \
  roles/cloudbuild.builds.builder \
  roles/logging.logWriter \
  roles/datastore.user \
  roles/secretmanager.secretAccessor; do
  grant "$PROJECT_ID" "$COMPUTE_SA" "$role"
done

# ── 4. Firestore Native DB + audits composite index ──────────────────────────
step "Ensuring Firestore Native database (${FIRESTORE_LOCATION})"
if gcloud firestore databases describe --project="$PROJECT_ID" --database='(default)' >/dev/null 2>&1; then
  echo "  – (default) database already exists"
else
  gcloud firestore databases create --project="$PROJECT_ID" \
    --location="$FIRESTORE_LOCATION" --type=firestore-native
  echo "  ✓ created (default) Firestore Native database"
fi

step "Ensuring audits composite index (userId ASC, createdAt DESC)"
# Duplicate creates return an ALREADY_EXISTS error; tolerate it. Index builds
# are asynchronous and may take a few minutes to become READY.
if gcloud firestore indexes composite create \
  --project="$PROJECT_ID" \
  --collection-group=audits \
  --field-config=field-path=userId,order=ascending \
  --field-config=field-path=createdAt,order=descending \
  --quiet 2>/tmp/rf-index-err; then
  echo "  ✓ index create submitted (builds asynchronously)"
else
  if grep -qi 'already exists' /tmp/rf-index-err; then
    echo "  – index already exists"
  else
    echo "  ! index create failed:" >&2; cat /tmp/rf-index-err >&2; exit 1
  fi
fi
rm -f /tmp/rf-index-err

# ── 5. Secrets (Option A — per-project, prod-matching names) ─────────────────
step "Storing secrets in ${PROJECT_ID}"
if [[ -n "${ANTHROPIC_API_KEY_VALUE:-}" ]]; then
  put_secret "$PROJECT_ID" "$SECRET_ANTHROPIC" "$ANTHROPIC_API_KEY_VALUE"
elif gcloud secrets describe "$SECRET_ANTHROPIC" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "  – ${SECRET_ANTHROPIC} exists and no new ANTHROPIC_API_KEY_VALUE given; leaving as-is"
else
  echo "  ! ${SECRET_ANTHROPIC} does not exist and ANTHROPIC_API_KEY_VALUE was not set." >&2
  echo "    Re-run with: ANTHROPIC_API_KEY_VALUE='sk-ant-...' $0 ${ENVIRONMENT}" >&2
  exit 1
fi

# Resend is best-effort in the app; create a placeholder if no value is given so
# the backend's --set-secrets reference resolves. Replace later with a real key.
if [[ -n "${RESEND_API_KEY_VALUE:-}" ]]; then
  put_secret "$PROJECT_ID" "$SECRET_RESEND" "$RESEND_API_KEY_VALUE"
elif gcloud secrets describe "$SECRET_RESEND" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "  – ${SECRET_RESEND} exists; leaving as-is"
else
  put_secret "$PROJECT_ID" "$SECRET_RESEND" "placeholder-set-a-real-resend-key"
  echo "    (placeholder — set a real Resend key later to enable registration email)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
cat <<EOF

✅ ${ENVIRONMENT} project (${PROJECT_ID}) is bootstrapped.

Next:
  • Add a GitHub 'development' environment with GCP_PROJECT_ID=${PROJECT_ID}
    (same WIF provider, deploy SA, and region as prod).
  • Wire the deploy-dev job in .github/workflows/pipeline.yml.
  • After the first successful deploy proves the secret resolves, remove the
    interim prod duplicate:
        CLEANUP_PROD_DUP=1 $0 ${ENVIRONMENT}
EOF
