variable "project_id" {
  type        = string
  description = "Existing GCP project ID (pre-created), e.g. root-and-fruit-dev."
}

variable "region" {
  type        = string
  description = "Cloud Run region AND Firestore location. NOTE: the Firestore location is PERMANENT and cannot be changed after apply."
}

variable "github_repo" {
  type        = string
  description = "owner/repo bound to the Workload Identity provider (who may deploy)."
  default     = "keimos/root-and-fruit"
}

variable "env" {
  type        = string
  description = "Environment name (dev/staging/prod) — used only in resource display names."
}
