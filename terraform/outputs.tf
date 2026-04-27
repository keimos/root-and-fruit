output "frontend_url" {
  description = "Public URL of the frontend (your app)"
  value       = google_cloud_run_v2_service.frontend.uri
}

output "backend_url" {
  description = "Public URL of the backend API"
  value       = google_cloud_run_v2_service.backend.uri
}

output "artifact_registry_url" {
  description = "Docker registry URL for pushing images"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo_name}"
}

output "firestore_database" {
  description = "Firestore database name"
  value       = google_firestore_database.main.name
}

output "cloudbuild_trigger" {
  description = "Cloud Build trigger name"
  value       = google_cloudbuild_trigger.main_branch.name
}