# ──────────────────────────────────────────────────────────────────
# Cloud Run — Backend
# Deployed here as a placeholder so Terraform owns the service.
# Cloud Build will update the image on every push to main.
# ──────────────────────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "backend" {
  provider = google-beta
  project  = var.project_id
  name     = "root-and-fruit-backend"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    timeout = "120s"

    containers {
      # Placeholder image — Cloud Build replaces this on first deploy
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      ports {
        container_port = 8080
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.run_firestore_user,
  ]
}

# Allow unauthenticated traffic to the backend
resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ──────────────────────────────────────────────────────────────────
# Cloud Run — Frontend
# ──────────────────────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "frontend" {
  provider = google-beta
  project  = var.project_id
  name     = "root-and-fruit-frontend"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "BACKEND_URL"
        value = google_cloud_run_v2_service.backend.uri
      }

      ports {
        container_port = 8080
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_service.backend,
    google_project_service.apis,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "frontend_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.frontend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}