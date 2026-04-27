terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  # Optional but recommended: store state in GCS so the team shares it
  # Uncomment after running: gsutil mb gs://YOUR_BUCKET_NAME
  # backend "gcs" {
  #   bucket = "root-and-fruit-tf-state"
  #   prefix = "terraform/state"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# ── Data: current project ──────────────────────────────────────────
data "google_project" "project" {
  project_id = var.project_id
}

locals {
  project_number     = data.google_project.project.number
  compute_sa         = "${local.project_number}-compute@developer.gserviceaccount.com"
  cloudbuild_sa      = "${local.project_number}@cloudbuild.gserviceaccount.com"
  artifact_repo_url  = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo_name}"
}