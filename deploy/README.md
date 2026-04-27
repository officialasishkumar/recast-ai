# Deployment

This directory holds everything needed to ship Recast AI to a real
environment. The local docker-compose stack stays under `/docker` for
day-to-day development.

## Helm chart (recommended)

```bash
helm upgrade --install recast deploy/helm/recast-ai \
  --namespace recast-ai \
  --create-namespace \
  --set global.imageTag=v0.5.0 \
  --set secrets.data.GEMINI_API_KEY=$GEMINI_API_KEY \
  --set secrets.data.JWT_SECRET=$JWT_SECRET \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=app.example.com
```

The chart wires up:

- Deployments + Services for every Recast service
- HPAs (CPU + memory) where autoscaling is enabled in `values.yaml`
- PodDisruptionBudgets for replicated services
- ServiceMonitors compatible with kube-prometheus-stack
- NetworkPolicies (deny-all baseline + targeted allows for DNS, HTTPS
  egress, and intra-cluster datastore traffic)
- Ingress with TLS (off by default)

Override anything with `--set` or your own `values.yaml`. See
[`deploy/helm/recast-ai/values.yaml`](helm/recast-ai/values.yaml) for the
full schema.

## Raw manifests

`deploy/k8s/namespace.yaml` provides a hardened namespace with the
restricted Pod Security Standard enforced. Apply it before installing
the chart in environments that mandate baseline namespace labels.

## Secrets management

Production deployments should not commit `secrets.data` values. Use one
of:

- **External Secrets Operator** + your secret backend (Vault, AWS SSM,
  GCP Secret Manager, etc.)
- **Sealed Secrets** for GitOps workflows
- **CSI Secret Store** with an encrypted backend

Pass `--set secrets.create=false` and reference your existing Secret
through `secrets.name`.

## Observability

Set `serviceMonitor.enabled=true` (the default) when running on a cluster
with the Prometheus Operator. The full Recast monitoring stack
(Prometheus + Grafana + Loki + Tempo + Alertmanager) is also bundled in
[`docker/monitoring`](../docker/monitoring) for local validation.
