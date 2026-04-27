# ── Firestore Database ─────────────────────────────────────────────
resource "google_firestore_database" "main" {
  provider    = google-beta
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

# ── Firestore Indexes ──────────────────────────────────────────────
# Composite index for querying audits by userId ordered by createdAt
resource "google_firestore_index" "audits_user_date" {
  provider   = google-beta
  project    = var.project_id
  collection = "audits"

  fields {
    field_path = "userId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.main]
}

# ── Artifact Registry: Docker image repository ─────────────────────
resource "google_artifact_registry_repository" "app_repo" {
  provider      = google-beta
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repo_name
  format        = "DOCKER"
  description   = "Root & Fruit app Docker images"

  depends_on = [google_project_service.apis]
}

# ── GCS bucket for Cloud Build logs ───────────────────────────────
resource "google_storage_bucket" "build_logs" {
  name                        = "${var.project_id}-build-logs"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true

  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 30 }  # auto-purge build logs after 30 days
  }

  depends_on = [google_project_service.apis]
}