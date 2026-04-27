# ── Cloud Build Trigger ────────────────────────────────────────────
# Connects your GitHub repo to Cloud Build.
# On every push to `main`, it runs cloudbuild.yaml automatically.

resource "google_cloudbuild_trigger" "main_branch" {
  provider    = google-beta
  project     = var.project_id
  name        = "root-and-fruit-deploy"
  description = "Deploy Root & Fruit on push to main"
  location    = "global"

  github {
    owner = var.github_owner
    name  = var.github_repo

    push {
      branch = "^main$"
    }
  }

  filename = "cloudbuild.yaml"

  substitutions = {
    _REGION  = var.region
    _REPO    = var.artifact_repo_name
    _PROJECT = var.project_id
  }

  depends_on = [
    google_project_service.apis,
    google_artifact_registry_repository.app_repo,
    google_project_iam_member.cloudbuild_run_admin,
    google_project_iam_member.cloudbuild_artifact_writer,
  ]
}