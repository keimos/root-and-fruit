# Terraform — Root & Fruit environments

Provisions the GCP infrastructure for an environment (dev / staging / prod) as
code: Firestore (Native) + the `audits` composite index, Secret Manager secret
containers, the runtime + deploy service accounts with their IAM roles, and
keyless GitHub Actions deploy via Workload Identity Federation.

One reusable module (`modules/environment`) is instantiated per environment in
`envs/<env>`. The **GCP projects are assumed to already exist** (pre-created:
`root-and-fruit-dev`, `root-and-fruit-staging`) — Terraform does not create them.

```
infra/terraform/
├── modules/environment/   # all the resources (module)
└── envs/
    ├── dev/               # instantiates the module for root-and-fruit-dev
    └── staging/           # …and root-and-fruit-staging
```

## One-time prerequisites

1. **A GCS bucket for Terraform state** (create once; can be in any project you own):
   ```
   gcloud storage buckets create gs://<your-org>-rf-tfstate --location us-central1 --uniform-bucket-level-access
   ```
   Then put that bucket name in each env's `backend.tf` (replace `REPLACE_ME-rf-tfstate`),
   or pass it at init: `terraform init -backend-config="bucket=<your-org>-rf-tfstate"`.
   State is separated per env by the `prefix` (`dev` / `staging`), so one bucket is fine.

2. **Your own credentials** need permission to manage these projects
   (`roles/owner` or the equivalent granular set) — `gcloud auth application-default login`.

## Apply an environment

```
cd infra/terraform/envs/dev      # or envs/staging
terraform init
terraform plan
terraform apply
```

> ⚠️ **Firestore location is permanent.** `region` in `terraform.tfvars` sets the
> Firestore location (and the Cloud Run region). You cannot change it after the
> first apply — pick it deliberately and keep dev/staging/prod consistent.

> If a project already has a `(default)` Firestore database, import it first so
> Terraform doesn't try to recreate it:
> `terraform import module.environment.google_firestore_database.db "<project_id>/(default)"`

## Load the secret VALUES (out-of-band — never in Terraform)

Terraform creates the empty secrets; add the values yourself so they stay out of
TF state:
```
printf '%s' "$DEV_ANTHROPIC_KEY" | gcloud secrets versions add anthropic-api-key --data-file=- --project root-and-fruit-dev
printf '%s' "$DEV_RESEND_KEY"    | gcloud secrets versions add resend-api-key    --data-file=- --project root-and-fruit-dev
```
(`resend-api-key` is optional — the backend runs without it, just no registration email.)

## Wire the environment into CI/CD

`terraform output` prints the values the pipeline needs. Put them in the GitHub
**Environment** (Settings → Environments → `dev` / `staging` → variables):

| GitHub env variable | Terraform output |
|---|---|
| `GCP_PROJECT_ID`   | `project_id`       |
| `GCP_REGION`       | `region`           |
| `GCP_WIF_PROVIDER` | `wif_provider`     |
| `GCP_DEPLOY_SA`    | `deploy_sa_email`  |

The Cloud Run services should run **as the runtime SA** (`runtime_sa_email`
output) — add `--service-account <that email>` to the deploy commands, or set it
per environment.

> **Pipeline note:** the current `.github/workflows/pipeline.yml` reads these as
> repo-level variables and deploys on push to `main`. To deploy dev/staging you
> need the workflow to select the environment (e.g. `environment: dev` on the
> deploy job keyed off the branch, or a `workflow_dispatch` env input) so it
> picks up the per-environment variables. That workflow change is separate from
> this Terraform and not included here.

## prod

`envs/prod` is intentionally omitted — prod (`root-and-fruit-app`) was created by
hand. To bring it under Terraform later, add an `envs/prod` mirroring `dev` and
`terraform import` the existing resources rather than re-creating them.
