#!/usr/bin/env bash
set -euo pipefail

for env_file in .env .env.local; do
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done

API="${API:-http://localhost:8800/api/v1}"
: "${SERVICE_API_KEY:?Set SERVICE_API_KEY in .env or the shell}"

TENANT_ID="${TENANT_ID:-f6b27eb5-5d5a-4f84-8016-45e2e1193aa1}"
USER_ID="${USER_ID:-22222222-2222-4222-8222-222222222222}"
PATTERN_FAMILY="$(printf '%s' "${PATTERN_FAMILY:-recall}" | tr '[:upper:]' '[:lower:]')"
LIMIT="${LIMIT:-500}"
MIN_EVENTS="${MIN_EVENTS:-2}"
WINDOW_DAYS="${WINDOW_DAYS:-365}"
RESET_REPORTS="${RESET_REPORTS:-false}"
LLM_PROVIDER="${LLM_PROVIDER:-ANTHROPIC}"
MODEL="${MODEL:-claude-sonnet-4-5}"
RUN_AGENT="${RUN_AGENT:-false}"

case "$PATTERN_FAMILY" in
  recall) TOOL_NAME=run_recall_pattern_compliance; LABEL=recall ;;
  shortage) TOOL_NAME=run_shortage_pattern_compliance; LABEL=shortage ;;
  all) PATTERN_FAMILY=recall "$0"; PATTERN_FAMILY=shortage "$0"; exit 0 ;;
  *) echo 'PATTERN_FAMILY must be recall, shortage, or all' >&2; exit 1 ;;
esac

headers=(-H "x-tenant-id: $TENANT_ID" -H "x-user-id: $USER_ID" -H "x-service-api-key: $SERVICE_API_KEY")
servers=$(curl -fsS "$API/mcp/servers" "${headers[@]}")
server_id="${PATTERN_SERVER_ID:-$(echo "$servers" | jq -r '.[]? | select(.metadata.serverType == "PHARMATRACE_PROFILE_COMPLIANCE" and .enabled == true) | .id' | head -n 1)}"
if [[ -z "$server_id" ]]; then
  server_id=$(curl -fsS -X POST "$API/mcp/servers" "${headers[@]}" -H 'content-type: application/json' -d \
    '{"name":"PharmaTrace Pattern Compliance MCP","description":"Keycloak-authenticated recall and shortage pattern tools","endpoint":"http://pattern-compliance.internal","metadata":{"serverType":"PHARMATRACE_PROFILE_COMPLIANCE"}}' | jq -er '.id')
fi
curl -fsS -X POST "$API/mcp/servers/$server_id/sync-tools" "${headers[@]}" | jq
tools=$(curl -fsS "$API/mcp/tools?serverId=$server_id" "${headers[@]}")
tool_id=$(echo "$tools" | jq -er --arg name "$TOOL_NAME" '.[] | select(.name == $name and .enabled == true) | .id' | head -n 1)

case "$LLM_PROVIDER" in
  ANTHROPIC) LLM_CONNECTION_ID="${LLM_CONNECTION_ID:-${ANTHROPIC_CONNECTION_ID:-}}"; LLM_API_KEY="${ANTHROPIC_API_KEY:-}"; LLM_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"; LLM_SECRET_REF="env:ANTHROPIC_API_KEY" ;;
  OLLAMA) LLM_CONNECTION_ID="${LLM_CONNECTION_ID:-${OLLAMA_CONNECTION_ID:-}}"; LLM_API_KEY="${OLLAMA_API_KEY:-}"; LLM_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"; LLM_SECRET_REF="env:OLLAMA_API_KEY" ;;
  OPENAI) LLM_CONNECTION_ID="${LLM_CONNECTION_ID:-${OPENAI_CONNECTION_ID:-}}"; LLM_API_KEY="${OPENAI_API_KEY:-}"; LLM_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"; LLM_SECRET_REF="env:OPENAI_API_KEY" ;;
  *) echo "Unsupported LLM_PROVIDER: $LLM_PROVIDER" >&2; exit 1 ;;
esac
CONNECTION_NAME="${CONNECTION_NAME:-PharmaTrace $LABEL Pattern Compliance $LLM_PROVIDER}"
if [[ -z "$LLM_CONNECTION_ID" ]]; then
  connections=$(curl -fsS "$API/llm/connections" "${headers[@]}")
  LLM_CONNECTION_ID=$(echo "$connections" | jq -r --arg name "$CONNECTION_NAME" --arg provider "$LLM_PROVIDER" '.[]? | select(.name == $name and .provider == $provider) | .id' | head -n 1)
  if [[ -z "$LLM_CONNECTION_ID" ]]; then
    LLM_CONNECTION_ID=$(echo "$connections" | jq -r --arg provider "$LLM_PROVIDER" '.[]? | select(.provider == $provider and (.enabled // true) == true) | .id' | head -n 1)
  fi
fi
if [[ -z "$LLM_CONNECTION_ID" ]]; then
  LLM_CONNECTION_ID=$(curl -fsS -X POST "$API/llm/connections" "${headers[@]}" -H 'content-type: application/json' -d \
    "{\"provider\":\"$LLM_PROVIDER\",\"name\":\"$CONNECTION_NAME\",\"apiKeySecretRef\":\"$LLM_SECRET_REF\",\"baseUrl\":\"$LLM_BASE_URL\"}" | jq -er '.id')
else
  echo "Reusing $LLM_PROVIDER connection: $LLM_CONNECTION_ID"
fi
connection=$(curl -fsS "$API/llm/connections/$LLM_CONNECTION_ID" "${headers[@]}")
connection_base_url=$(echo "$connection" | jq -r '.base_url // .baseUrl // empty')
if [[ "$connection_base_url" != "$LLM_BASE_URL" ]]; then
  curl -fsS -X PATCH "$API/llm/connections/$LLM_CONNECTION_ID" "${headers[@]}" -H 'content-type: application/json' \
    -d "{\"baseUrl\":\"$LLM_BASE_URL\",\"apiKeySecretRef\":\"$LLM_SECRET_REF\"}" >/dev/null
fi
if [[ "$RUN_AGENT" == "true" ]]; then
  curl -fsS -X POST "$API/llm/connections/$LLM_CONNECTION_ID/test" "${headers[@]}" -H 'content-type: application/json' \
    -d "{\"model\":\"$MODEL\"}" | jq
fi

AGENT_NAME="${AGENT_NAME:-PharmaTrace $LABEL Pattern Compliance Agent}"
agent_payload=$(jq -n --arg name "$AGENT_NAME" --arg label "$LABEL" --arg connection "$LLM_CONNECTION_ID" --arg provider "$LLM_PROVIDER" --arg model "$MODEL" --arg server "$server_id" --arg tool "$tool_id" --argjson limit "$LIMIT" --argjson minEvents "$MIN_EVENTS" --argjson windowDays "$WINDOW_DAYS" --argjson reset "$RESET_REPORTS" \
  '{name:$name,description:("Detect repeated " + $label + " patterns from real PharmaTrace records."),expectedOutput:"Return only evidence-backed pattern summaries and remediation instructions in English.",triggerMode:"MANUAL",llmConnectionId:$connection,llmProvider:$provider,llmModel:$model,maxIterations:1,maxToolCalls:1,defaultInput:{limit:$limit,minEvents:$minEvents,windowDays:$windowDays,resetReports:$reset},allowedMcpServerIds:[$server],allowedMcpToolIds:[$tool]}')
agent_id=""
if [[ -n "${AGENT_ID:-}" ]]; then
  candidate=$(curl -sS "$API/agents/$AGENT_ID" "${headers[@]}" || true)
  if echo "$candidate" | jq -e '.id' >/dev/null 2>&1; then
    agent_id="$AGENT_ID"
    echo "Reusing agent by AGENT_ID: $agent_id"
    curl -fsS -X PATCH "$API/agents/$agent_id" "${headers[@]}" -H 'content-type: application/json' -d "$agent_payload" >/dev/null
  else
    echo "AGENT_ID $AGENT_ID was not found; falling back to stable agent name '$AGENT_NAME'"
  fi
fi
if [[ -z "$agent_id" ]]; then
  agents=$(curl -fsS "$API/agents" "${headers[@]}")
  agent_id=$(echo "$agents" | jq -r --arg name "$AGENT_NAME" '.[]? | select(.name == $name) | .id' | head -n 1)
  if [[ -n "$agent_id" ]]; then
    echo "Reusing agent '$AGENT_NAME': $agent_id"
    curl -fsS -X PATCH "$API/agents/$agent_id" "${headers[@]}" -H 'content-type: application/json' -d "$agent_payload" >/dev/null
  else
    echo "Creating agent: $AGENT_NAME"
    agent=$(curl -fsS -X POST "$API/agents" "${headers[@]}" -H 'content-type: application/json' -d "$agent_payload")
    echo "$agent" | jq
    agent_id=$(echo "$agent" | jq -er '.id')
  fi
fi
if [[ "$RUN_AGENT" != "true" ]]; then
  echo "Agent created/updated for UI-triggered runs."
  echo "AGENT_ID=$agent_id"
  echo "Set RUN_AGENT=true to trigger a run from the command line."
  exit 0
fi
run=$(curl -fsS -X POST "$API/agents/$agent_id/run" "${headers[@]}" -H 'content-type: application/json' -d \
  "{\"query\":\"Fetch real $LABEL records through MCP, group repeated patterns, create reports only for new patterns, and return a compact English summary.\",\"input\":{\"limit\":$LIMIT,\"minEvents\":$MIN_EVENTS,\"windowDays\":$WINDOW_DAYS,\"resetReports\":$RESET_REPORTS},\"forceReplan\":true}")
run_id=$(echo "$run" | jq -er '.id')
for attempt in $(seq 1 120); do
  run=$(curl -fsS "$API/agents/$agent_id/runs/$run_id" "${headers[@]}")
  status=$(echo "$run" | jq -r '.status'); echo "[$attempt/120] status=$status"
  case "$status" in COMPLETED|FAILED|CANCELLED) break ;; esac
  sleep 2
done
tool_calls=$(curl -fsS "$API/agents/$agent_id/runs/$run_id/tool-calls" "${headers[@]}")
echo 'Tool calls:'; echo "$tool_calls" | jq
echo 'Pattern API response counts:'
echo "$tool_calls" | jq '([.[] | select(.status == "COMPLETED") | .output_payload] | last // {}) | {sourceRecords, candidatePatterns, processed, minEvents, windowDays, reportIds: ((.reports // []) | map(.id) | map(select(. != null)))}'
echo 'Final result:'; echo "$run" | jq '{status,final_response,final_response_json,error_message,error_details}'
echo "AGENT_ID=$agent_id"; echo "RUN_ID=$run_id"
