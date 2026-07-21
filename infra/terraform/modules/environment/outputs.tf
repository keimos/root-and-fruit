# These feed straight into the GitHub Environment variables the CI/CD pipeline
# reads (Settings → Environments → <env> → variables). See README.

output "project_id" {
  description = "GitHub env var: GCP_PROJECT_ID"
  value       = var.project_id
}

output "region" {
  description = "GitHub env var: GCP_REGION"
  value       = var.region
}

output "deploy_sa_email" {
  description = "GitHub env var: GCP_DEPLOY_SA"
  value       = google_service_account.deploy.email
}

output "wif_provider" {
  description = "GitHub env var: GCP_WIF_PROVIDER (full provider resource name)"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "runtime_sa_email" {
  description = "Runtime service account Cloud Run should run as (--service-account)."
  value       = google_service_account.runtime.email
}
