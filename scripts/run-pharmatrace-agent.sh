#!/usr/bin/env bash
set -euo pipefail

: "${API:?Set API to the orchestrator base URL}"
: "${SERVICE_API_KEY:?Set SERVICE_API_KEY}"

TENANT_ID="${TENANT_ID:-f6b27eb5-5d5a-4f84-8016-45e2e1193aa1}"
USER_ID="${USER_ID:-22222222-2222-4222-8222-222222222222}"
SERVER_ID="${SERVER_ID:-7a32537b-f586-4e76-a42a-d0e837d68d41}"
MODEL="${MODEL:-qwen2.5:7b-instruct}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
MAX_ITERATIONS="${MAX_ITERATIONS:-1}"
MAX_TOOL_CALLS="${MAX_TOOL_CALLS:-1}"
PAGE="${PAGE:-1}"
SIZE="${SIZE:-20}"
AGENT_NAME="${AGENT_NAME:-Manual PharmaTrace Ollama Agent}"
QUERY="${QUERY:-Only list pharmaceutical lots. Do not call any other tools.}"

headers=(
  -H "x-tenant-id: $TENANT_ID"
  -H "x-user-id: $USER_ID"
  -H "x-service-api-key: $SERVICE_API_KEY"
)

tool_ids='[
  "3f4012c9-99c9-4dd7-b30b-626a70476e39",
  "1029c2e2-0b25-4750-aa0f-90458a580785",
  "07a908cd-b62b-44b7-818b-47c19a264122",
  "4c1e6e0a-9ccd-43a6-8c0b-835476b2cfc8",
  "562c3f64-aa74-45b7-9cbf-27afaa0dda83",
  "8da38227-0648-4949-aa69-152c9a3a116d"
]'

if [[ -z "${OLLAMA_CONNECTION_ID:-}" ]]; then
  : "${OLLAMA_API_KEY:?Set OLLAMA_API_KEY when creating the connection at runtime}"

  connection_payload=$(jq -n \
    --arg name "Local Ollama $(date +%Y%m%d-%H%M%S)" \
    --arg secretRef "env:OLLAMA_API_KEY" \
    --arg baseUrl "$OLLAMA_BASE_URL" \
    '{
      provider: "OLLAMA",
      name: $name,
      apiKeySecretRef: $secretRef,
      baseUrl: $baseUrl
    }')

  echo "Creating Ollama connection..."
  connection_response=$(curl -fsS -X POST "$API/llm/connections" "${headers[@]}" \
    -H 'content-type: application/json' \
    -d "$connection_payload")
  echo "$connection_response" | jq
  OLLAMA_CONNECTION_ID=$(echo "$connection_response" | jq -er '.id')
else
  echo "Using Ollama connection: $OLLAMA_CONNECTION_ID"
fi

echo "Syncing MCP tools..."
curl -fsS -X POST "$API/mcp/servers/$SERVER_ID/sync-tools" "${headers[@]}" | jq

agent_payload=$(jq -n \
  --arg name "$AGENT_NAME" \
  --arg connectionId "$OLLAMA_CONNECTION_ID" \
  --arg model "$MODEL" \
  --arg serverId "$SERVER_ID" \
  --argjson toolIds "$tool_ids" \
  --argjson maxIterations "$MAX_ITERATIONS" \
  --argjson maxToolCalls "$MAX_TOOL_CALLS" \
  --argjson page "$PAGE" \
  --argjson size "$SIZE" \
  '{
    name: $name,
    description: "Inspect PharmaTrace lots, products, drugs, companies, and lot items.",
    expectedOutput: "Return a clear English summary of pharmaceutical lots.",
    triggerMode: "MANUAL",
    llmConnectionId: $connectionId,
    llmProvider: "OLLAMA",
    llmModel: $model,
    maxIterations: $maxIterations,
    maxToolCalls: $maxToolCalls,
    defaultInput: { page: $page, size: $size },
    allowedMcpServerIds: [$serverId],
    allowedMcpToolIds: $toolIds
  }')

if [[ -n "${AGENT_ID:-}" ]]; then
  echo "Reusing agent by AGENT_ID: $AGENT_ID"
  curl -fsS -X PATCH "$API/agents/$AGENT_ID" "${headers[@]}" \
    -H 'content-type: application/json' -d "$agent_payload" >/dev/null
else
  agents=$(curl -fsS "$API/agents" "${headers[@]}")
  AGENT_ID=$(echo "$agents" | jq -r --arg name "$AGENT_NAME" '.[]? | select(.name == $name) | .id' | head -n 1)
  if [[ -n "$AGENT_ID" ]]; then
    echo "Reusing agent '$AGENT_NAME': $AGENT_ID"
    curl -fsS -X PATCH "$API/agents/$AGENT_ID" "${headers[@]}" \
      -H 'content-type: application/json' -d "$agent_payload" >/dev/null
  else
    echo "Creating agent: $AGENT_NAME"
    agent_response=$(curl -fsS -X POST "$API/agents" "${headers[@]}" \
      -H 'content-type: application/json' -d "$agent_payload")
    echo "$agent_response" | jq
    AGENT_ID=$(echo "$agent_response" | jq -er '.id')
  fi
fi

run_payload=$(jq -n \
  --arg query "$QUERY" \
  --argjson page "$PAGE" \
  --argjson size "$SIZE" \
  '{query: $query, input: {page: $page, size: $size}, forceReplan: true}')

echo "Starting agent run: $AGENT_ID"
run_response=$(curl -fsS -X POST "$API/agents/$AGENT_ID/run" "${headers[@]}" \
  -H 'content-type: application/json' \
  -d "$run_payload")
echo "$run_response" | jq
RUN_ID=$(echo "$run_response" | jq -er '.id')

for attempt in $(seq 1 60); do
  run=$(curl -fsS "$API/agents/$AGENT_ID/runs/$RUN_ID" "${headers[@]}")
  status=$(echo "$run" | jq -r '.status')
  echo "[$attempt/60] status=$status"

  case "$status" in
    COMPLETED|FAILED|CANCELLED)
      echo "$run" | jq
      break
      ;;
  esac

  sleep 2
done

echo "Tool calls:"
curl -fsS "$API/agents/$AGENT_ID/runs/$RUN_ID/tool-calls" "${headers[@]}" | jq

echo "Final result:"
echo "$run" | jq '{status, final_response, final_response_json, error_message, error_details}'

echo "AGENT_ID=$AGENT_ID"
echo "RUN_ID=$RUN_ID"
