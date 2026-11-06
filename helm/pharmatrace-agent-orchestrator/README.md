# PharmaTrace Agent Orchestrator Helm deployment

This chart deploys the NestJS orchestrator in the `serialization` namespace. It includes the Deployment, Service, optional Ingress, CORS configuration, health probes, and a pre-install/pre-upgrade database migration Job.

## Build and push the image

Run from `pharmatrace-agent-orchestrator`:

```bash
IMAGE=035764999992.dkr.ecr.eu-central-1.amazonaws.com/pharmatrace-agent-orchestrator
TAG=v1

docker build --platform linux/amd64 -t "$IMAGE:$TAG" .
docker push "$IMAGE:$TAG"
```

## Production secrets

Do not put production credentials or private keys in Helm values, Git, Docker images, or the UI. The chart expects the Secret named by `secret.existingName`:

```yaml
secret:
  existingName: pharmatrace-agent-orchestrator-secrets
```

Create that Secret through your approved secret-management process. The required key names are listed in `production-secret-keys.txt`. For EKS, the recommended option is AWS Secrets Manager plus External Secrets Operator:

```bash
helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --create-namespace \
  --set externalSecret.enabled=true \
  --set externalSecret.remoteKey=serialization/pharmatrace-agent-orchestrator
```

This requires a preconfigured `ClusterSecretStore` named `aws-secretsmanager` and an AWS Secrets Manager record containing all keys in `production-secret-keys.txt`.

For a direct Helm-managed test deployment, create a local `values-production.yaml` containing `secret.create: true` and `secret.data`, then install with `-f values-production.yaml`. Do not commit that file:

```yaml
secret:
  create: true
  existingName: pharmatrace-agent-orchestrator-secrets
  data:
    DATABASE_URL: postgresql://postgres:<password>@serialization-pg16.remote-systems.svc.cluster.local:5432/audit_anchor
    SERVICE_API_KEY: <service-api-key>
    SECRET_ENCRYPTION_KEY: <encryption-key>
    KEYCLOAK_CLIENT_SECRET: <keycloak-client-secret>
    KEYCLOAK_USERNAME: ai-agent
    KEYCLOAK_PASSWORD: <keycloak-password>
    AGENT_HEDERA_ACCOUNT_ID: 0.0.8093895
    AGENT_HEDERA_KEY_TYPE: ECDSA
    AGENT_HEDERA_PRIVATE_KEY: <matching-private-key>
    OLLAMA_API_KEY: <ollama-key>
    ANTHROPIC_API_KEY: <anthropic-api-key>
```

Install it with:

```bash
helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --create-namespace \
  -f values-production.yaml \
  --set externalSecret.enabled=false
```

To use Claude for the bootstrapped production agent, override the provider
settings and pass the key through the Kubernetes Secret. This adds/updates the
Anthropic connection; it does not affect existing NVIDIA or Ollama connections
unless bootstrap is enabled for the deployment:

The chart does not read a shell variable automatically. Put the real key in
your uncommitted `values-production.yaml` or in the existing Kubernetes Secret
(`pharmatrace-agent-orchestrator-secrets`). If Anthropic bootstrap is enabled
with `secret.create=true` and the key is missing, Helm now fails before it can
deploy an unusable release.

An overlay template is available at
`helm/pharmatrace-agent-orchestrator/values-anthropic-overlay.example.yaml`.
Copy it to an untracked file, replace the placeholder, and merge it after your
private production values file.

```bash
helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --create-namespace \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set-string secret.data.ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --set config.llmBootstrapEnabled=true \
  --set-string config.llmBootstrapProvider="ANTHROPIC" \
  --set-string config.llmBootstrapModel="claude-sonnet-4-5" \
  --set-string config.llmBootstrapConnectionName="Anthropic Production" \
  --set-string config.llmBootstrapBaseUrl="https://api.anthropic.com" \
  --set-string config.llmBootstrapApiKeyRef="env:ANTHROPIC_API_KEY" \
  --set-string config.llmBootstrapAgentName="Manual PharmaTrace Hedera Lot Anchor Agent"
```

```bash
kubectl get secret pharmatrace-agent-orchestrator-secrets -n serialization
```

The important agent signer values are:

```text
AGENT_HEDERA_ACCOUNT_ID=0.0.8093895
AGENT_HEDERA_KEY_TYPE=ECDSA
AGENT_HEDERA_PRIVATE_KEY=<matching private key>
```

The account must be funded on Testnet and must match the private key. Topic `0.0.10123883` currently has no submit key.

The database URL in the Kubernetes Secret must use the cluster Service, not localhost:

```text
DATABASE_URL=postgresql://postgres:<password>@serialization-pg16.remote-systems.svc.cluster.local:5432/audit_anchor
```

The container listens on port `3000`; the Helm Service exposes it on port `80`. Do not set `PORT=8800` inside the pod.

## Deploy

```bash
helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --create-namespace \
  --set image.tag="$TAG"
```

The migration Job runs before the Deployment. Check it with:

```bash
kubectl get pods,jobs -n serialization \
  -l app.kubernetes.io/name=pharmatrace-agent-orchestrator
kubectl rollout status deployment/pharmatrace-agent-orchestrator -n serialization
```

## Internal service URL

No Ingress is required. From another EKS workload, use:

```text
http://pharmatrace-agent-orchestrator.serialization.svc.cluster.local/api/v1
```

Do not configure a browser to call a Kubernetes Service DNS name directly. The UI must use its own backend proxy or an existing same-origin gateway. Set `config.corsOrigins` only for the actual browser origin, for example:

```yaml
config:
  corsOrigins: https://firstbucket.k8s.pharmatrace.io
```

The API base path is `/api/v1`.

## Ollama

Hosted Ollama is the default. The orchestrator uses the configured remote
OpenAI-compatible endpoint and the API key from the Kubernetes Secret. No
model is downloaded into the cluster.

For a self-hosted model, enable the optional internal Deployment and ClusterIP
Service named `ollama`. It persists downloaded models in the `ollama-models`
PVC and automatically pulls the configured model on startup:

```yaml
ollama:
  enabled: true
  model: qwen2.5:7b-instruct
  persistence:
    enabled: true
    size: 20Gi
```

When local Ollama is enabled, the orchestrator connects internally through:

```text
http://ollama:11434/v1
```

Check model startup with:

```bash
kubectl get pods,svc,pvc -n serialization -l app.kubernetes.io/name=ollama
kubectl logs deployment/ollama -n serialization
```

The Ollama API key is only the orchestrator connection placeholder; Ollama is
not exposed outside the cluster.
