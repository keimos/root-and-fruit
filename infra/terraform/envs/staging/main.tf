terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

module "environment" {
  source     = "../../modules/environment"
  project_id = var.project_id
  region     = var.region
  env        = "staging"
}

output "project_id" {
  value = module.environment.project_id
}
output "region" {
  value = module.environment.region
}
output "deploy_sa_email" {
  value = module.environment.deploy_sa_email
}
output "wif_provider" {
  value = module.environment.wif_provider
}
output "runtime_sa_email" {
  value = module.environment.runtime_sa_email
}
