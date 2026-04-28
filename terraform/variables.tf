variable "project_id" {
  description = "GCP project ID (must already exist)"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run and Artifact Registry"
  type        = string
  default     = "us-east1"
}

variable "firestore_location" {
  description = "Firestore multi-region or region location"
  type        = string
  default     = "us-east1"
}

variable "artifact_repo_name" {
  description = "Artifact Registry repository name"
  type        = string
  default     = "root-and-fruit"
}

variable "github_owner" {
  description = "GitHub username or org that owns the repo"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name (not the full URL, just the name)"
  type        = string
  default     = "root-and-fruit"
}