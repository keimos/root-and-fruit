# Remote state in GCS. The bucket MUST exist before `terraform init` — create it
# once by hand (see README). The bucket name can't be a variable in a backend
# block (Terraform limitation), so either edit the literal below or pass it at
# init time:  terraform init -backend-config="bucket=<your-tfstate-bucket>"
terraform {
  backend "gcs" {
    bucket = "REPLACE_ME-rf-tfstate"
    prefix = "dev"
  }
}
