# PharmaTrace Agent Orchestrator

Backend-only NestJS service for user-defined agents that use Claude or GPT, authenticate with Keycloak before accessing PharmaTrace MCP/GraphQL tools, reuse successful execution plans, and persist schedules, results, and execution history in PostgreSQL.

## Included capabilities

- Claude, GPT, and local Ollama connections through `@ai-sdk/anthropic`, `@ai-sdk/openai`, and the Vercel AI SDK.
- Explicit OpenAI Responses API model selection via `openai.responses(model)`.
- Environment-backed, mounted-file, or AES-256-GCM-encrypted API-key storage; plaintext keys never enter PostgreSQL.
- Keycloak client-credentials or password-grant authentication before protected MCP and GraphQL requests.
- PharmaTrace tools: `list_batch_lots`, `get_batch_lot`, `get_lot_items`, `get_product`, `get_drug`, and `get_company`.
- A JSON-RPC MCP endpoint exposing `initialize`, `tools/list`, and `tools/call`.
- Remote Streamable HTTP MCP client support.
- Tenant-scoped agents, explicit server/tool allowlists, planning, evaluation, replanning, and reusable execution plans.
- Daily, weekly, monthly, and one-time schedules with IANA timezone and daylight-saving support.
- PostgreSQL-backed work claiming using `FOR UPDATE SKIP LOCKED`.
- Full run history, tool-call audit, token accounting, cancellation, Docker, and Kubernetes examples.

## Start locally

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run migrate
npm run start:dev
```

Alternatively:

```bash
cp .env.example .env
docker compose up --build
```

Set `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` in `.env`. The default PharmaTrace setup uses the
Keycloak password grant. Set `KEYCLOAK_USERNAME` to the same value as the web user's
`preferred_username` and provide `KEYCLOAK_PASSWORD` through a Kubernetes Secret or another secret
manager. The backend cannot read browser `localStorage`; never commit these values.

For local inference, start Ollama and pull a small tool-capable model:

```bash
ollama serve
ollama pull qwen2.5:7b-instruct
```

The default Ollama endpoint is `http://127.0.0.1:11434/v1`. When the orchestrator runs in Docker or
Kubernetes, set `OLLAMA_BASE_URL` to the reachable Ollama service URL instead.

Create an Ollama connection without an external API key:

```bash
curl -X POST "$API/llm/connections" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "provider": "OLLAMA",
    "name": "Local Ollama",
    "apiKeySecretRef": "env:OLLAMA_API_KEY",
    "baseUrl": "http://127.0.0.1:11434/v1"
  }'
```

Use `qwen2.5:7b-instruct` as the initial agent model. The model must be installed in the same Ollama
instance reachable by the orchestrator and must support tool calling for MCP execution.

Check availability:

```bash
curl http://localhost:3000/health
```

All protected endpoints require tenant and user UUID headers:

```bash
TENANT_ID=11111111-1111-4111-8111-111111111111
USER_ID=22222222-2222-4222-8222-222222222222
API=http://localhost:3000/api/v1
```

When `SERVICE_API_KEY` is configured, include `-H "x-service-api-key: $SERVICE_API_KEY"` in every request below.

## 1. Create an OpenAI or Claude connection

Use an existing environment variable without sending its value through the API:

```bash
curl -X POST "$API/llm/connections" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "provider": "OPENAI",
    "name": "Production GPT",
    "apiKeySecretRef": "env:OPENAI_API_KEY"
  }'
```

For Claude:

```json
{
  "provider": "ANTHROPIC",
  "name": "Production Claude",
  "apiKeySecretRef": "env:ANTHROPIC_API_KEY"
}
```

Mounted Kubernetes secrets can be referenced as `file:/var/run/secrets/llm/openai-api-key`. To submit `apiKey` directly instead, first set a 32-byte base64 `SECRET_ENCRYPTION_KEY`; the service writes an AES-256-GCM encrypted secret file and stores only its reference in PostgreSQL.

Generate an encryption key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Test a connection using a model available to your provider account:

```bash
CONNECTION_ID=<connection-uuid>

curl -X POST "$API/llm/connections/$CONNECTION_ID/test" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H 'content-type: application/json' \
  -d '{"model":"<your-available-gpt-or-claude-model>"}'
```

## 2. Register the authenticated PharmaTrace MCP server

```bash
curl -X POST "$API/mcp/servers" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name": "PharmaTrace Lots",
    "endpoint": "https://apigateway.k8s.pharmatrace.io/graphql",
    "authConfig": {
      "tokenUrl": "https://kc.k8s.pharmatrace.io/auth/realms/first-bucket/protocol/openid-connect/token",
      "clientId": "api",
      "grantType": "password",
      "clientSecretRef": "env:KEYCLOAK_CLIENT_SECRET",
      "usernameRef": "env:KEYCLOAK_USERNAME",
      "passwordRef": "env:KEYCLOAK_PASSWORD"
    },
    "metadata": {
      "serverType": "PHARMATRACE_GRAPHQL"
    }
  }'
```

The application obtains the access token before issuing a protected request, caches it until shortly before expiry, and invalidates it when upstream returns HTTP 401 or 403.

Populate the six-tool knowledge base:

```bash
SERVER_ID=7a32537b-f586-4e76-a42a-d0e837d68d41

curl -X POST "$API/mcp/servers/$SERVER_ID/sync-tools" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID"

curl "$API/mcp/tools?serverId=$SERVER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID"
```

If your deployed GraphQL schema uses different arguments or selection sets, override individual operations in `metadata.graphqlDocuments`:

```json
{
  "metadata": {
    "serverType": "PHARMATRACE_GRAPHQL",
    "graphqlDocuments": {
      "get_batch_lot": "query GetBatchLot($lotId: String!) { getBatchLotById(lotId: $lotId) }"
    }
  }
}
```

## 3. Create an agent

Collect the MCP tool UUIDs returned by `/mcp/tools`, then create the agent:

```bash
curl -X POST "$API/agents" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name": "Daily Recalled Lot Monitoring",
    "description": "Inspect pharmaceutical lots, identify recalls, and collect related items, deliveries, products, manufacturers, Fabric data, and Hedera anchors.",
    "expectedOutput": "Return recalled lot numbers, affected item counts, delivery destinations, products, manufacturers, Fabric transactions, Hedera references, and a risk summary.",
    "triggerMode": "BOTH",
    "llmConnectionId": "<connection-uuid>",
    "llmProvider": "OPENAI",
    "llmModel": "<your-available-gpt-model>",
    "maxIterations": 6,
    "maxToolCalls": 20,
    "defaultInput": { "page": 1, "size": 50 },
    "allowedMcpServerIds": ["<mcp-server-uuid>"],
    "allowedMcpToolIds": [
      "<list-batch-lots-tool-uuid>",
      "<get-batch-lot-tool-uuid>",
      "<get-lot-items-tool-uuid>",
      "<get-product-tool-uuid>",
      "<get-company-tool-uuid>"
    ]
  }'
```

Switch to Claude by selecting an Anthropic connection and setting `llmProvider` to `ANTHROPIC` plus a Claude model available to that account.

## 4. Run the agent manually

```bash
AGENT_ID=<agent-uuid>

curl -X POST "$API/agents/$AGENT_ID/run" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H 'content-type: application/json' \
  -d '{
    "query": "Show recalled lots and identify deliveries containing recalled items.",
    "input": { "page": 1, "size": 100 },
    "forceReplan": false
  }'
```

Check the response, stored tool calls, and reusable plan:

```bash
RUN_ID=<run-uuid>

curl "$API/agents/$AGENT_ID/runs/$RUN_ID" \
  -H "x-tenant-id: $TENANT_ID" -H "x-user-id: $USER_ID"

curl "$API/agents/$AGENT_ID/runs/$RUN_ID/tool-calls" \
  -H "x-tenant-id: $TENANT_ID" -H "x-user-id: $USER_ID"

curl "$API/agents/$AGENT_ID/execution-plan" \
  -H "x-tenant-id: $TENANT_ID" -H "x-user-id: $USER_ID"
```

## 5. Configure scheduled execution

```bash
curl -X POST "$API/agents/$AGENT_ID/schedules" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H 'content-type: application/json' \
  -d '{
    "scheduleType": "DAILY",
    "timezone": "Europe/Malta",
    "timeOfDay": "09:00:00",
    "inputOverride": { "page": 1, "size": 100 }
  }'
```

Other supported schedules:

```json
{"scheduleType":"WEEKLY","timezone":"Europe/Malta","timeOfDay":"09:00:00","dayOfWeek":1}
{"scheduleType":"MONTHLY","timezone":"Europe/Malta","timeOfDay":"09:00:00","dayOfMonth":31}
{"scheduleType":"ONCE","timezone":"Europe/Malta","scheduledFor":"2026-09-01T09:00:00+02:00"}
```

`dayOfWeek` uses `0 = Sunday`. Monthly schedules configured for the 31st run on the final available day of shorter months.

## MCP JSON-RPC endpoint

The registered PharmaTrace server is exposed at:

```text
POST /api/v1/mcp/servers/:serverId/rpc
```

List tools:

```bash
curl -X POST "$API/mcp/servers/$SERVER_ID/rpc" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Every `tools/call` obtains a valid Keycloak token before invoking the upstream GraphQL operation.

## Optional seed data

```bash
export SEED_TENANT_ID=11111111-1111-4111-8111-111111111111
npm run seed
```

The seed command registers the PharmaTrace MCP server, all six tools, and environment-backed OpenAI/Anthropic connections when the corresponding API keys are present.

## Kubernetes

Example manifests are in `k8s/`. The service runs as numeric UID/GID 1000, so Kubernetes can verify `runAsNonRoot`. The internal service address is:

```text
http://pharmatrace-agent-orchestrator.serialization.svc.cluster.local:3000
```

For multiple replicas, use environment-backed or mounted external secret-manager credentials. The example `emptyDir` is local to each pod and should not be used to share API keys submitted directly to one replica.

## API routes

```text
GET    /health

POST   /api/v1/llm/connections
GET    /api/v1/llm/connections
GET    /api/v1/llm/connections/:connectionId
PATCH  /api/v1/llm/connections/:connectionId
DELETE /api/v1/llm/connections/:connectionId
POST   /api/v1/llm/connections/:connectionId/test
GET    /api/v1/llm/providers/:provider/models

POST   /api/v1/mcp/servers
GET    /api/v1/mcp/servers
GET    /api/v1/mcp/servers/:serverId
PATCH  /api/v1/mcp/servers/:serverId
POST   /api/v1/mcp/servers/:serverId/sync-tools
POST   /api/v1/mcp/servers/:serverId/rpc
GET    /api/v1/mcp/tools
GET    /api/v1/mcp/tools/:toolId

POST   /api/v1/agents
GET    /api/v1/agents
GET    /api/v1/agents/:agentId
PATCH  /api/v1/agents/:agentId
DELETE /api/v1/agents/:agentId
POST   /api/v1/agents/:agentId/pause
POST   /api/v1/agents/:agentId/resume

POST   /api/v1/agents/:agentId/run
GET    /api/v1/agents/:agentId/runs
GET    /api/v1/agents/:agentId/runs/:runId
GET    /api/v1/agents/:agentId/runs/:runId/steps
GET    /api/v1/agents/:agentId/runs/:runId/tool-calls
POST   /api/v1/agents/:agentId/runs/:runId/cancel

GET    /api/v1/agents/:agentId/execution-plan
POST   /api/v1/agents/:agentId/execution-plan/invalidate
POST   /api/v1/agents/:agentId/execution-plan/rebuild

POST   /api/v1/agents/:agentId/schedules
GET    /api/v1/agents/:agentId/schedules
PATCH  /api/v1/agents/:agentId/schedules/:scheduleId
DELETE /api/v1/agents/:agentId/schedules/:scheduleId
```

## Validation

```bash
npm run typecheck
npm test
npm run build
DEBUG_LLM_RESPONSES=true npm run start:dev
```

AGENT_ID="7c834c38-9a7e-4e03-afb7-408d9d6c6ce5"
RUN_ID="c005bf2d-5d1e-4e04-80b1-66382ad64ac2"



curl -X POST "$API/agents" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "content-type: application/json" \
  -d "{
    \"name\": \"Manual PharmaTrace Lot Agent v2\",
    \"description\": \"Inspect PharmaTrace lots, products, drugs, companies, and lot items.\",
    \"expectedOutput\": \"Return a clear summary of lots, products, drugs, companies, and related items.\",
    \"triggerMode\": \"MANUAL\",
    \"llmConnectionId\": \"$CONNECTION_ID\",
    \"llmProvider\": \"OPENAI\",
    \"llmModel\": \"gpt-4o-mini\",
    \"maxIterations\": 6,
    \"maxToolCalls\": 30,
    \"defaultInput\": {
      \"page\": 1,
      \"size\": 20
    },
    \"allowedMcpServerIds\": [
      \"9e033624-81cc-496c-a2b1-21c0e7069b86\"
    ],
    \"allowedMcpToolIds\": [
      \"793ba783-f625-4ac9-bb7a-42710a08175d\",
      \"d9f0910c-c062-480a-aa5c-2b130c55586a\",
      \"84756a6b-a3db-4e16-8ba0-b810844a0fb0\",
      \"2fd4f6d6-03ba-4ef2-8b35-a9a56f2a5bb4\",
      \"949ebeea-cd9c-4a22-921d-1e4de668a3f1\",
      \"73e5f563-8a9a-4534-8fa5-5a71a29cf556\"
    ]
  }"
curl -X POST "$API/llm/connections" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "provider": "OLLAMA",
    "name": "Local Ollama",
    "apiKeySecretRef": "env:OLLAMA_API_KEY",
    "baseUrl": "http://127.0.0.1:11434/v1"
  }'

OLLAMA_CONNECTION_ID=8db6063c-defd-4f87-b282-09050b095727

curl -X POST "$API/llm/connections/$OLLAMA_CONNECTION_ID/test" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"qwen2.5:7b-instruct"}' | jq


export TENANT_ID="f6b27eb5-5d5a-4f84-8016-45e2e1193aa1"
export USER_ID="22222222-2222-4222-8222-222222222222"

curl -X POST "$API/agents" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "content-type: application/json" \
  -d "{
    \"name\": \"Manual PharmaTrace Ollama Agent v6\",
    \"description\": \"Inspect PharmaTrace lots, products, drugs, companies, and lot items.\",
    \"expectedOutput\": \"Return a clear English summary of pharmaceutical lots.\",
    \"triggerMode\": \"MANUAL\",
    \"llmConnectionId\": \"$OLLAMA_CONNECTION_ID\",
    \"llmProvider\": \"OLLAMA\",
    \"llmModel\": \"qwen2.5:7b-instruct\",
    \"maxIterations\": 1,
    \"maxToolCalls\": 1,
    \"defaultInput\": {
      \"page\": 1,
      \"size\": 20
    },
    \"allowedMcpServerIds\": [
      \"$SERVER_ID\"
    ],
    \"allowedMcpToolIds\": [
      \"3f4012c9-99c9-4dd7-b30b-626a70476e39\",
      \"1029c2e2-0b25-4750-aa0f-90458a580785\",
      \"07a908cd-b62b-44b7-818b-47c19a264122\",
      \"4c1e6e0a-9ccd-43a6-8c0b-835476b2cfc8\",
      \"562c3f64-aa74-45b7-9cbf-27afaa0dda83\",
      \"8da38227-0648-4949-aa69-152c9a3a116d\"
    ]
  }" | jq

export AGENT_ID="c5a367f6-8aec-42fc-b0c4-2c79a82c6dea"

curl -X PATCH "$API/agents/$AGENT_ID" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "maxIterations": 1,
    "maxToolCalls": 1
  }' | jq


curl -X POST "$API/agents/$AGENT_ID/run" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "query": "List pharmaceutical lots, then inspect their related items, products, drugs, and companies. Return the results clearly.",
    "input": {
      "page": 1,
      "size": 20
    },
    "forceReplan": true
  }'

RUN_ID="c9977e3c-39b1-4de4-9995-4fc788ad77c0"

curl "$API/agents/$AGENT_ID/runs/$RUN_ID" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" | jq

curl "$API/agents/$AGENT_ID/runs/$RUN_ID/tool-calls" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: $SERVICE_API_KEY" | jq

export API=http://localhost:3000/api/v1
export SERVICE_API_KEY="YOUR_SERVICE_API_KEY"
export OLLAMA_API_KEY="ollama"

./scripts/run-pharmatrace-agent.sh


 docker build \
  --platform linux/amd64 \
  -t 035764999992.dkr.ecr.eu-central-1.amazonaws.com/pt-agent-orchestrator:latest \
  .

helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --create-namespace \
  --set externalSecret.enabled=false

helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --create-namespace \
  --values ./values-production.yaml \
  --set secret.create=true \
  --set externalSecret.enabled=false \
  --debug

helm delete agent-orchestrator --namespace serialization

IMAGE=035764999992.dkr.ecr.eu-central-1.amazonaws.com/pt-agent-orchestrator
TAG=profile-agent-di-fix-20260922

docker build --platform linux/amd64 -t "$IMAGE:$TAG" .
docker push "$IMAGE:$TAG"

helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --values values-production.yaml \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set-string secret.data.SERVICE_API_KEY="$NEW_SERVICE_API_KEY"

helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --values values-production.yaml \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set ollama.enabled=false \
  --set-string secret.data.SERVICE_API_KEY="$NEW_SERVICE_API_KEY"



helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  -n serialization \
  -f values-production.yaml \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set ollama.enabled=false \
  --set image.repository="$IMAGE" \
  --set image.tag="$TAG" \
  --set-string secret.data.SERVICE_API_KEY="$NEW_SERVICE_API_KEY"

  kubectl rollout restart deployment/pharmatrace-agent-orchestrator \
  -n serialization

kubectl rollout status deployment/pharmatrace-agent-orchestrator \
  -n serialization


curl -i \
  "localhost:5555/api/v1/compliance/reports" \
  -H "x-tenant-id: f6b27eb5-5d5a-4f84-8016-45e2e1193aa1" \
  -H "x-user-id: 22222222-2222-4222-8222-222222222222" \
  -H "x-service-api-key: ${NEW_SERVICE_API_KEY}"



curl -X POST "localhost:5555/api/v1/compliance/reports/demo/seed" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-service-api-key: ${NEW_SERVICE_API_KEY}" \
  -H "content-type: application/json" \
  -d '{"count":6}'


  helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  --namespace serialization \
  --create-namespace \
  --values values-production.yaml \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set ollama.enabled=false \
  --set image.repository="$IMAGE" \
  --set image.tag="$TAG" \
  --set-string secret.data.SERVICE_API_KEY="$NEW_SERVICE_API_KEY" \
  --set-string secret.data.NVIDIA_API_KEY="$NVIDIA_API_KEY"

helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  -n serialization \
  -f values-production.yaml \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set ollama.enabled=false \
  --set config.llmBootstrapEnabled=true \
  --set-string config.llmBootstrapTenantId="$TENANT_ID" \
  --set-string config.llmBootstrapAgentId="$AGENT_ID" \
  --set-string secret.data.NVIDIA_API_KEY="$NVIDIA_API_KEY"



  export TAG="v-$(date +%Y%m%d-%H%M%S)"

docker build --platform linux/amd64 -t "$IMAGE:$TAG" .
docker push "$IMAGE:$TAG"

helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  -n serialization \
  -f values-production.yaml \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set ollama.enabled=false \
  --set image.repository="$IMAGE" \
  --set image.tag="$TAG" \
  --set config.llmBootstrapEnabled=true \
  --set-string config.llmBootstrapAgentName="Manual PharmaTrace Hedera Lot Anchor Agent" \
  --set-string secret.data.NVIDIA_API_KEY="$NVIDIA_API_KEY"
export IMAGE="035764999992.dkr.ecr.eu-central-1.amazonaws.com/pt-agent-orchestrator"
export TAG="v-$(date +%Y%m%d-%H%M%S)"


docker build --platform linux/amd64 -t "$IMAGE:$TAG" .
docker push "$IMAGE:$TAG"

helm upgrade --install agent-orchestrator \
  ./helm/pharmatrace-agent-orchestrator \
  -n serialization \
  -f values-production.yaml \
  --set externalSecret.enabled=false \
  --set secret.create=true \
  --set ollama.enabled=false \
  --set image.repository="$IMAGE" \
  --set image.tag="$TAG" \
  --set config.llmBootstrapEnabled=true \
  --set-string config.llmBootstrapAgentName="Manual PharmaTrace Hedera Lot Anchor Agent" \
  --set-string secret.data.NVIDIA_API_KEY="$NVIDIA_API_KEY"

  export EXECUTION_TIMEOUT_SECONDS=1200
export MAX_ITERATIONS=1
export MAX_TOOL_CALLS=2
export FORCE_REPLAN=false

./scripts/run-pharmatrace-lot-anchor-agent.sh