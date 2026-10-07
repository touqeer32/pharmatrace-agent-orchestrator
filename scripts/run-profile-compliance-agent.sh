#!/usr/bin/env bash
set -euo pipefail

: "${API:?Set API, for example http://localhost:8800/api/v1}"
: "${SERVICE_API_KEY:?Set SERVICE_API_KEY}"

TENANT_ID="${TENANT_ID:-f6b27eb5-5d5a-4f84-8016-45e2e1193aa1}"
USER_ID="${USER_ID:-22222222-2222-4222-8222-222222222222}"
PROFILE_FAMILY="${PROFILE_FAMILY:-serial}"
LIMIT="${LIMIT:-1}"
GENERATE_DEMO_NUMBERS="${GENERATE_DEMO_NUMBERS:-true}"
DEMO_NUMBER_COUNT="${DEMO_NUMBER_COUNT:-2}"
RESET_REPORTS="${RESET_REPORTS:-false}"
MODEL="${MODEL:-qwen2.5:7b-instruct}"
# Profile compliance testing uses the local Ollama daemon, matching the lot
# anchor runner. Set OLLAMA_BASE_URL explicitly when the orchestrator is remote.
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
MAX_ITERATIONS="${MAX_ITERATIONS:-1}"
MAX_TOOL_CALLS="${MAX_TOOL_CALLS:-1}"

headers=(-H "x-tenant-id: $TENANT_ID" -H "x-user-id: $USER_ID" -H "x-service-api-key: $SERVICE_API_KEY")
profile_family_lower=$(printf '%s' "$PROFILE_FAMILY" | tr '[:upper:]' '[:lower:]')
if [[ "$profile_family_lower" == "all" ]]; then
  for family in serial sscc gdti; do PROFILE_FAMILY="$family" "$0"; done
  exit 0
fi
case "$profile_family_lower" in
  serial|random) TOOL_NAME=run_serial_profile_compliance; LABEL=serial-number ;;
  sscc) TOOL_NAME=run_sscc_profile_compliance; LABEL=SSCC ;;
  gdti) TOOL_NAME=run_gdti_profile_compliance; LABEL=GDTI ;;
  *) echo 'PROFILE_FAMILY must be serial, sscc, gdti, or all' >&2; exit 1 ;;
esac

# This is a real orchestrator MCP agent. The tool itself authenticates with
# Keycloak and calls the configured source API; no profile JSON is injected.
servers=$(curl -sS --fail-with-body "$API/mcp/servers" "${headers[@]}")
server_id=$(echo "$servers" | jq -r '.[]? | select(.metadata.serverType == "PHARMATRACE_PROFILE_COMPLIANCE" and .enabled == true) | .id' | head -n 1)
if [[ -z "$server_id" ]]; then
  server_id=$(curl -sS --fail-with-body -X POST "$API/mcp/servers" "${headers[@]}" -H 'content-type: application/json' -d \
    '{"name":"PharmaTrace Profile Compliance MCP","description":"Keycloak-authenticated profile source and compliance tools","endpoint":"http://profile-compliance.internal","metadata":{"serverType":"PHARMATRACE_PROFILE_COMPLIANCE"}}' | jq -er '.id')
fi
curl -sS --fail-with-body -X POST "$API/mcp/servers/$server_id/sync-tools" "${headers[@]}" | jq
tools=$(curl -sS --fail-with-body "$API/mcp/tools?serverId=$server_id" "${headers[@]}")
tool_id=$(echo "$tools" | jq -er --arg name "$TOOL_NAME" '.[] | select(.name == $name and .enabled == true) | .id' | head -n 1)

if [[ -z "${OLLAMA_CONNECTION_ID:-}" ]]; then
  : "${OLLAMA_API_KEY:?Set OLLAMA_API_KEY}"
  connection_name="Local Ollama Profile Compliance"
  connections=$(curl -sS --fail-with-body "$API/llm/connections" "${headers[@]}")
  OLLAMA_CONNECTION_ID=$(echo "$connections" | jq -r --arg name "$connection_name" '.[]? | select(.name == $name) | .id' | head -n 1)
  if [[ -z "$OLLAMA_CONNECTION_ID" ]]; then
    OLLAMA_CONNECTION_ID=$(curl -sS --fail-with-body -X POST "$API/llm/connections" "${headers[@]}" -H 'content-type: application/json' -d \
      "{\"provider\":\"OLLAMA\",\"name\":\"$connection_name\",\"apiKeySecretRef\":\"env:OLLAMA_API_KEY\",\"baseUrl\":\"$OLLAMA_BASE_URL\"}" | jq -er '.id')
  else
    echo "Reusing Ollama connection: $OLLAMA_CONNECTION_ID"
  fi
fi

# Existing connections may point at hosted Ollama or at an old endpoint. Make
# the selected connection match this run so the model is resolved by the same
# Ollama service that the caller requested.
connection=$(curl -sS --fail-with-body "$API/llm/connections/$OLLAMA_CONNECTION_ID" "${headers[@]}")
connection_base_url=$(echo "$connection" | jq -r '.base_url // .baseUrl // empty')
if [[ "$connection_base_url" != "$OLLAMA_BASE_URL" ]]; then
  curl -sS --fail-with-body -X PATCH "$API/llm/connections/$OLLAMA_CONNECTION_ID" "${headers[@]}" \
    -H 'content-type: application/json' \
    -d "{\"baseUrl\":\"$OLLAMA_BASE_URL\",\"apiKeySecretRef\":\"env:OLLAMA_API_KEY\"}" >/dev/null
  echo "Updated Ollama connection endpoint to $OLLAMA_BASE_URL"
fi

echo "Testing Ollama model $MODEL at $OLLAMA_BASE_URL"
curl -sS --fail-with-body -X POST "$API/llm/connections/$OLLAMA_CONNECTION_ID/test" "${headers[@]}" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\"}" | jq

AGENT_NAME="${AGENT_NAME:-PharmaTrace $LABEL Profile Compliance Agent}"
agent_payload=$(jq -n --arg name "$AGENT_NAME" --arg connection "$OLLAMA_CONNECTION_ID" --arg model "$MODEL" --arg server "$server_id" --arg tool "$tool_id" --argjson iterations "$MAX_ITERATIONS" --argjson calls "$MAX_TOOL_CALLS" --argjson limit "$LIMIT" --argjson generate "$GENERATE_DEMO_NUMBERS" --argjson count "$DEMO_NUMBER_COUNT" --argjson reset "$RESET_REPORTS" --arg label "$LABEL" '{name:$name,description:("Validate real " + $label + " profiles fetched through authenticated MCP."),expectedOutput:"Review one profile at a time using only the supplied rule and evidence. If processed is zero, return NO_DATA. Return only findingId, assessment, comment, and optional instruction.",outputSchema:{type:"object",required:["processingStatus","summary","profiles"],properties:{processingStatus:{type:"string",enum:["COMPLETED","NO_DATA"]},summary:{type:"string"},profiles:{type:"array",items:{type:"object",required:["profileId","resultStatus","findings"],properties:{profileId:{type:"string"},resultStatus:{type:"string",enum:["PASS","FAIL","REVIEW"]},findings:{type:"array",items:{type:"object",required:["findingId","assessment","comment"],properties:{findingId:{type:"string"},assessment:{type:"string",enum:["CONFIRMED","DISPUTED","NEEDS_CONTEXT"]},comment:{type:"string"},instruction:{type:"string"}}}}}}}}},triggerMode:"MANUAL",llmConnectionId:$connection,llmProvider:"OLLAMA",llmModel:$model,maxIterations:$iterations,maxToolCalls:$calls,defaultInput:{limit:$limit,generateDemoNumbers:$generate,demoNumberCount:$count,resetReports:$reset},allowedMcpServerIds:[$server],allowedMcpToolIds:[$tool]}')

agent_id=""
if [[ -n "${AGENT_ID:-}" ]]; then
  candidate=$(curl -sS "$API/agents/$AGENT_ID" "${headers[@]}" || true)
  if echo "$candidate" | jq -e '.id' >/dev/null 2>&1; then
    agent_id="$AGENT_ID"
    echo "Reusing agent by AGENT_ID: $agent_id"
    curl -sS --fail-with-body -X PATCH "$API/agents/$agent_id" "${headers[@]}" -H 'content-type: application/json' -d "$agent_payload" >/dev/null
  else
    echo "AGENT_ID $AGENT_ID was not found; falling back to stable agent name '$AGENT_NAME'"
  fi
fi
if [[ -z "$agent_id" ]]; then
  agents=$(curl -sS --fail-with-body "$API/agents" "${headers[@]}")
  agent_id=$(echo "$agents" | jq -r --arg name "$AGENT_NAME" '.[]? | select(.name == $name) | .id' | head -n 1)
  if [[ -n "$agent_id" ]]; then
    echo "Reusing agent '$AGENT_NAME': $agent_id"
    curl -sS --fail-with-body -X PATCH "$API/agents/$agent_id" "${headers[@]}" -H 'content-type: application/json' -d "$agent_payload" >/dev/null
  else
    echo "Creating agent: $AGENT_NAME"
    agent=$(curl -sS --fail-with-body -X POST "$API/agents" "${headers[@]}" -H 'content-type: application/json' -d "$agent_payload")
    echo "$agent" | jq
    agent_id=$(echo "$agent" | jq -er '.id')
  fi
fi
run=$(curl -sS --fail-with-body -X POST "$API/agents/$agent_id/run" "${headers[@]}" -H 'content-type: application/json' -d \
  "{\"query\":\"Fetch real $LABEL profiles through MCP, reset prior test reports, validate them, review the rules and initial findings, create reports, and return HCS statuses.\",\"input\":{\"limit\":$LIMIT,\"generateDemoNumbers\":$GENERATE_DEMO_NUMBERS,\"demoNumberCount\":$DEMO_NUMBER_COUNT,\"resetReports\":$RESET_REPORTS},\"forceReplan\":true}")
run_id=$(echo "$run" | jq -er '.id')
for attempt in $(seq 1 120); do
  run=$(curl -fsS "$API/agents/$agent_id/runs/$run_id" "${headers[@]}")
  status=$(echo "$run" | jq -r '.status'); echo "[$attempt/120] status=$status"
  case "$status" in COMPLETED|FAILED|CANCELLED) break ;; esac
  sleep 2
done
echo 'Tool calls:'
tool_calls=$(curl -fsS "$API/agents/$agent_id/runs/$run_id/tool-calls" "${headers[@]}")
echo "$tool_calls" | jq
echo 'Profile API response counts:'
echo "$tool_calls" | jq -r '
  . as $calls |
  ($calls | map(select(.status == "COMPLETED") | .output_payload) | length) as $completedCalls |
  ($calls | map(select(.status != "COMPLETED") | {tool: .tool_name, status: .status, error: .error_message})) as $failedCalls |
  ($calls | map(select(.status == "COMPLETED") | .output_payload) | last // {}) as $result |
  {
    completedToolCalls: $completedCalls,
    failedToolCalls: $failedCalls,
    apiSourceRecords: ($result.sourceRecords // null),
    selectedRecords: ($result.processed // null),
    processedReports: ($result.processed // null),
    skippedRecords: ($result.skipped // null),
    pass: ($result.pass // null),
    fail: ($result.fail // null),
    review: ($result.review // null),
    reportIds: (($result.reports // []) | map(.id) | map(select(. != null)))
  }
  | if .completedToolCalls == 0 then
      . + {message: "No completed MCP tool response. The LLM/orchestrator failed before profile retrieval; inspect failedToolCalls and the run error."}
    else . end'
echo 'Final result:'; echo "$run" | jq '{status,final_response,final_response_json,error_message,error_details}'
echo "AGENT_ID=$agent_id"; echo "RUN_ID=$run_id"
