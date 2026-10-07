#!/usr/bin/env bash
set -euo pipefail

: "${API:?Set API to the orchestrator base URL}"
: "${SERVICE_API_KEY:?Set SERVICE_API_KEY}"

TENANT_ID="${TENANT_ID:-f6b27eb5-5d5a-4f84-8016-45e2e1193aa1}"
USER_ID="${USER_ID:-22222222-2222-4222-8222-222222222222}"
SERVER_ID="${SERVER_ID:?Set SERVER_ID to the tenant-owned PharmaTrace GraphQL MCP server}"
MODEL="${MODEL:-qwen2.5:7b-instruct}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
PAGE="${PAGE:-1}"
SIZE="${SIZE:-100}"
MAX_ITERATIONS="${MAX_ITERATIONS:-1}"
MAX_TOOL_CALLS="${MAX_TOOL_CALLS:-2}"
EXECUTION_TIMEOUT_SECONDS="${EXECUTION_TIMEOUT_SECONDS:-1200}"
FORCE_REPLAN="${FORCE_REPLAN:-false}"
AGENT_NAME="${AGENT_NAME:-Manual PharmaTrace Hedera Lot Anchor Agent}"
QUERY="${QUERY:-Find pharmaceutical lots that are not confirmed on Hedera, anchor them on Hedera Testnet, persist each successful anchor, and return a compact English summary. Use list_batch_lots first and push_lots_to_hedera second.}"

headers=(
  -H "x-tenant-id: $TENANT_ID"
  -H "x-user-id: $USER_ID"
  -H "x-service-api-key: $SERVICE_API_KEY"
)

server=$(curl -fsS "$API/mcp/servers/$SERVER_ID" "${headers[@]}")
endpoint=$(echo "$server" | jq -r '.endpoint // empty')
server_type=$(echo "$server" | jq -r '.metadata.serverType // empty')

if [[ "$server_type" != "PHARMATRACE_GRAPHQL" || "$endpoint" != *"/graphql"* ]]; then
  echo "SERVER_ID is not the PharmaTrace GraphQL server." >&2
  echo "$server" | jq '{id, name, endpoint, metadata}' >&2
  exit 1
fi

echo "Using PharmaTrace GraphQL server: $SERVER_ID"
echo "Endpoint: $endpoint"

echo "Syncing MCP tools..."
curl -fsS -X POST "$API/mcp/servers/$SERVER_ID/sync-tools" "${headers[@]}" | jq

tools=$(curl -fsS "$API/mcp/tools?serverId=$SERVER_ID" "${headers[@]}")
list_tool_id=$(echo "$tools" | jq -er '.[] | select(.name == "list_batch_lots" and .enabled == true) | .id' | head -n 1)
anchor_tool_id=$(echo "$tools" | jq -er '.[] | select(.name == "push_lots_to_hedera" and .enabled == true) | .id' | head -n 1)

tool_ids=$(jq -n --arg list "$list_tool_id" --arg anchor "$anchor_tool_id" '[$list, $anchor]')

if [[ -z "${OLLAMA_CONNECTION_ID:-}" ]]; then
  : "${OLLAMA_API_KEY:?Set OLLAMA_API_KEY when creating the Ollama connection at runtime}"
  connection_payload=$(jq -n \
    --arg name "Local Ollama Lot Anchor $(date +%Y%m%d-%H%M%S)" \
    --arg secretRef "env:OLLAMA_API_KEY" \
    --arg baseUrl "$OLLAMA_BASE_URL" \
    '{provider:"OLLAMA", name:$name, apiKeySecretRef:$secretRef, baseUrl:$baseUrl}')
  echo "Creating Ollama connection..."
  connection_response=$(curl -fsS -X POST "$API/llm/connections" "${headers[@]}" \
    -H 'content-type: application/json' -d "$connection_payload")
  OLLAMA_CONNECTION_ID=$(echo "$connection_response" | jq -er '.id')
else
  echo "Using Ollama connection: $OLLAMA_CONNECTION_ID"
fi

agent_payload=$(jq -n \
  --arg name "$AGENT_NAME" \
  --arg connectionId "$OLLAMA_CONNECTION_ID" \
  --arg model "$MODEL" \
  --arg serverId "$SERVER_ID" \
  --argjson toolIds "$tool_ids" \
  --argjson maxIterations "$MAX_ITERATIONS" \
  --argjson maxToolCalls "$MAX_TOOL_CALLS" \
  --argjson executionTimeoutSeconds "$EXECUTION_TIMEOUT_SECONDS" \
  --argjson page "$PAGE" \
  --argjson size "$SIZE" \
  '{
    name:$name,
    description:"Find unconfirmed PharmaTrace lots and anchor them on Hedera Testnet.",
    expectedOutput:"Return a compact English summary of pushed, skipped, and failed lots with transaction IDs.",
    triggerMode:"MANUAL",
    llmConnectionId:$connectionId,
    llmProvider:"OLLAMA",
    llmModel:$model,
    maxIterations:$maxIterations,
    maxToolCalls:$maxToolCalls,
    executionTimeoutSeconds:$executionTimeoutSeconds,
    defaultInput:{page:$page,size:$size},
    allowedMcpServerIds:[$serverId],
    allowedMcpToolIds:$toolIds
  }')

agent_id=""
if [[ -n "${AGENT_ID:-}" ]]; then
  candidate=$(curl -sS "$API/agents/$AGENT_ID" "${headers[@]}" || true)
  if echo "$candidate" | jq -e '.id' >/dev/null 2>&1; then
    agent_id="$AGENT_ID"
    echo "Reusing agent by AGENT_ID: $agent_id"
    curl -fsS -X PATCH "$API/agents/$agent_id" "${headers[@]}" \
      -H 'content-type: application/json' -d "$agent_payload" >/dev/null
  else
    echo "AGENT_ID $AGENT_ID was not found; falling back to stable agent name '$AGENT_NAME'"
  fi
fi
if [[ -z "$agent_id" ]]; then
  agents=$(curl -fsS "$API/agents" "${headers[@]}")
  agent_id=$(echo "$agents" | jq -r --arg name "$AGENT_NAME" '.[]? | select(.name == $name) | .id' | head -n 1)
  if [[ -n "$agent_id" ]]; then
    echo "Reusing agent '$AGENT_NAME': $agent_id"
    curl -fsS -X PATCH "$API/agents/$agent_id" "${headers[@]}" \
      -H 'content-type: application/json' -d "$agent_payload" >/dev/null
  else
    echo "Creating agent: $AGENT_NAME"
    agent_response=$(curl -fsS -X POST "$API/agents" "${headers[@]}" \
      -H 'content-type: application/json' -d "$agent_payload")
    echo "$agent_response" | jq
    agent_id=$(echo "$agent_response" | jq -er '.id')
  fi
fi
AGENT_ID="$agent_id"

run_payload=$(jq -n --arg query "$QUERY" --argjson page "$PAGE" --argjson size "$SIZE" \
  --argjson forceReplan "$FORCE_REPLAN" \
  '{query:$query,input:{page:$page,size:$size},forceReplan:$forceReplan}')

echo "Starting agent run: $AGENT_ID"
run_response=$(curl -fsS -X POST "$API/agents/$AGENT_ID/run" "${headers[@]}" \
  -H 'content-type: application/json' -d "$run_payload")
RUN_ID=$(echo "$run_response" | jq -er '.id')
echo "RUN_ID=$RUN_ID"

run='{}'
for attempt in $(seq 1 120); do
  run=$(curl -fsS "$API/agents/$AGENT_ID/runs/$RUN_ID" "${headers[@]}")
  status=$(echo "$run" | jq -r '.status')
  echo "[$attempt/120] status=$status"
  case "$status" in
    COMPLETED|FAILED|CANCELLED) break ;;
  esac
  sleep 2
done

echo "Tool calls:"
curl -fsS "$API/agents/$AGENT_ID/runs/$RUN_ID/tool-calls" "${headers[@]}" | jq

echo "Final result:"
echo "$run" | jq '{status, final_response, final_response_json, error_message, error_details}'
echo "AGENT_ID=$AGENT_ID"
echo "RUN_ID=$RUN_ID"
