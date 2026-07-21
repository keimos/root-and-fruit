# Remote state in GCS. The bucket MUST exist before `terraform init` — create it
# once by hand (see README). Same bucket as dev is fine (state is separated by
# the per-env `prefix` below); a separate bucket per env also works.
terraform {
  backend "gcs" {
    bucket = "REPLACE_ME-rf-tfstate"
    prefix = "staging"
  }
}
