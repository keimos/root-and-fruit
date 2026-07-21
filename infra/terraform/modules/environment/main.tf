terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

# ── APIs ────────────────────────────────────────────────
locals {
  services = [
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "secretmanager.googleapis.com",
    "firestore.googleapis.com",
  ]
}

resource "google_project_service" "svc" {
  for_each                   = toset(local.services)
  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}

# ── Firestore (Native) + the composite index the app requires ──
# The app lists audits with .where(userId).orderBy(createdAt desc), which needs
# this composite index (Firestore refuses the query otherwise).
resource "google_firestore_database" "db" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.svc]
}

resource "google_firestore_index" "audits_user_created" {
  project    = var.project_id
  database   = google_firestore_database.db.name
  collection = "audits"

  fields {
    field_path = "userId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
}

# ── Secret CONTAINERS only ──────────────────────────────
# Terraform creates the empty secrets; the VALUES are added out-of-band so they
# never land in TF state (see README). resend-api-key is optional at runtime.
resource "google_secret_manager_secret" "secrets" {
  for_each  = toset(["anthropic-api-key", "resend-api-key"])
  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }
  depends_on = [google_project_service.svc]
}

# ── Service accounts ────────────────────────────────────
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "rf-runtime"
  display_name = "Root & Fruit Cloud Run runtime (${var.env})"
}

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "rf-deploy"
  display_name = "Root & Fruit CI deployer (${var.env})"
}

# Runtime SA: read/write Firestore + read secrets.
resource "google_project_iam_member" "runtime_roles" {
  for_each = toset([
    "roles/datastore.user",
    "roles/secretmanager.secretAccessor",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Deploy SA: source-build + deploy Cloud Run, and act-as the runtime SA.
# (artifactregistry.admin covers the auto-created cloud-run-source-deploy repo.)
resource "google_project_iam_member" "deploy_roles" {
  for_each = toset([
    "roles/run.admin",
    "roles/cloudbuild.builds.editor",
    "roles/artifactregistry.admin",
    "roles/storage.admin",
    "roles/iam.serviceAccountUser",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# ── Workload Identity Federation (keyless GitHub Actions deploy) ──
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.svc]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  # GCP requires a condition on the provider; restrict token exchange to this repo.
  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Let this repo's OIDC identity impersonate the deploy SA.
resource "google_service_account_iam_member" "wif_deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
