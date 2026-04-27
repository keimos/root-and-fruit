# ── Cloud Build IAM ────────────────────────────────────────────────
# Allow Cloud Build to deploy to Cloud Run
resource "google_project_iam_member" "cloudbuild_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${local.cloudbuild_sa}"

  depends_on = [google_project_service.apis]
}

# Allow Cloud Build to act as the compute service account
resource "google_project_iam_member" "cloudbuild_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${local.cloudbuild_sa}"

  depends_on = [google_project_service.apis]
}

# Allow Cloud Build to push to Artifact Registry
resource "google_project_iam_member" "cloudbuild_artifact_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${local.cloudbuild_sa}"

  depends_on = [google_project_service.apis]
}

# Allow Cloud Build to write logs to GCS
resource "google_storage_bucket_iam_member" "cloudbuild_log_writer" {
  bucket = google_storage_bucket.build_logs.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${local.cloudbuild_sa}"
}

# ── Cloud Run IAM ──────────────────────────────────────────────────
# Allow Cloud Run's compute SA to read from Firestore
resource "google_project_iam_member" "run_firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${local.compute_sa}"

  depends_on = [google_project_service.apis]
}