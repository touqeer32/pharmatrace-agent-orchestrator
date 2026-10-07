#!/usr/bin/env bash
set -euo pipefail

# Creates a deliberately valid GDTI profile in the real PharmaTrace GDTI API.
# It does not create a compliance report; run the real GDTI profile agent after
# this script finishes.

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Prefer the same endpoint used by the real GDTI compliance agent. Keep
# GRAPHQL_URL as an explicit override for local/testing usage.
GRAPHQL_URL="${GRAPHQL_URL:-${SERIAL_PROFILE_GDTI_API_URL:-https://pt-snm-gdti.k8s.pharmatrace.io/graphql}}"
EXTERNAL_SYSTEM="${EXTERNAL_SYSTEM:-388e3401-8cbd-42b4-8d9e-a196fc8e5cc6}"
GDTI_NAME="${GDTI_NAME:-GDTI-$(date +%m%d%H%M%S)}"
COMPANY_PREFIX="${COMPANY_PREFIX:-CP-01}"
DOCUMENT_TYPE="${DOCUMENT_TYPE:-Demo}"
RANGE_SIZE="${RANGE_SIZE:-1}"
THRESHOLD_PERCENTAGE="${THRESHOLD_PERCENTAGE:-1}"
GDTI_INDEX="${GDTI_INDEX:-1}"
EPC_FILTER_VALUE="${EPC_FILTER_VALUE:-1}"
TOKEN="${GRAPHQL_TOKEN:-}"

if ! command -v curl >/dev/null || ! command -v jq >/dev/null; then
  echo 'curl and jq are required.' >&2
  exit 1
fi

if [[ -z "$TOKEN" ]]; then
  : "${KEYCLOAK_TOKEN_URL:?Set KEYCLOAK_TOKEN_URL or GRAPHQL_TOKEN}"
  : "${KEYCLOAK_CLIENT_ID:?Set KEYCLOAK_CLIENT_ID}"
  : "${KEYCLOAK_CLIENT_SECRET:?Set KEYCLOAK_CLIENT_SECRET}"
  : "${KEYCLOAK_USERNAME:?Set KEYCLOAK_USERNAME}"
  : "${KEYCLOAK_PASSWORD:?Set KEYCLOAK_PASSWORD}"
  TOKEN=$(curl -fsS -X POST "$KEYCLOAK_TOKEN_URL" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode "client_id=$KEYCLOAK_CLIENT_ID" \
    --data-urlencode "client_secret=$KEYCLOAK_CLIENT_SECRET" \
    --data-urlencode "username=$KEYCLOAK_USERNAME" \
    --data-urlencode "password=$KEYCLOAK_PASSWORD" | jq -er '.access_token')
fi

if [[ "${STRICT_RULE_PROFILE:-false}" == 'true' ]]; then
  if ! [[ "$COMPANY_PREFIX" =~ ^[0-9]{6,12}$ ]]; then
    echo 'COMPANY_PREFIX must contain 6 through 12 digits.' >&2
    exit 1
  fi
  if ! [[ "$DOCUMENT_TYPE" =~ ^[0-9]+$ ]]; then
    echo 'DOCUMENT_TYPE must contain only digits.' >&2
    exit 1
  fi
  if (( ${#COMPANY_PREFIX} + ${#DOCUMENT_TYPE} != 12 )); then
    echo 'COMPANY_PREFIX plus DOCUMENT_TYPE must contain exactly 12 digits.' >&2
    exit 1
  fi
fi
if ! [[ "$RANGE_SIZE" =~ ^[1-9]$ ]]; then
  echo 'RANGE_SIZE must be between 1 and 9 for the GDTI API.' >&2
  exit 1
fi
if ! [[ "$GDTI_INDEX" =~ ^[1-9][0-9]{0,6}$ ]]; then
  echo 'GDTI_INDEX must be between 1 and 9999999.' >&2
  exit 1
fi
if ! [[ "$EPC_FILTER_VALUE" =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo 'EPC_FILTER_VALUE must be between 1 and 999999999.' >&2
  exit 1
fi

metadata='[{"key":"","value":""}]'
mutation=$(jq -n \
  --arg companyPrefix "$COMPANY_PREFIX" \
  --arg documentType "$DOCUMENT_TYPE" \
  --arg externalSystem "$EXTERNAL_SYSTEM" \
  --arg name "$GDTI_NAME" \
  --arg metadata "$metadata" \
  --argjson index "$GDTI_INDEX" \
  --argjson epcFilter "$EPC_FILTER_VALUE" \
  --argjson rangeSize "$RANGE_SIZE" \
  --argjson threshold "$THRESHOLD_PERCENTAGE" \
  '{query:("mutation { createGdtiProfile(gdtiProfile: {" +
    "companyPrefix: \"" + $companyPrefix + "\", " +
    "currentNumber: 1, numberRangeSize: " + ($rangeSize|tostring) + ", " +
    "documentType: \"" + $documentType + "\", epcApiKey: \"\", " +
    "epcFilterValue: " + ($epcFilter|tostring) + ", externalSystem: \"" + $externalSystem + "\", " +
    "gs1ApiKey: \"\", incrementBy: 1, index: " + ($index|tostring) + ", name: \"" + $name + "\", " +
    "realmName: \"\", remaining: " + ($rangeSize|tostring) + ", startNumber: 1, " +
    "status: \"Active\", thresholdPercentage: " + ($threshold|tostring) + ", " +
    "metadata: " + ($metadata|@json) + "}) { status message response { " +
    "id name startNumber incrementBy currentNumber numberRangeSize thresholdPercentage " +
    "externalSystem status index remaining companyPrefix epcFilterValue metadata " +
    "documentType gs1ApiKey epcApiKey realmName createdOn } } }") }')

headers=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
if [[ -n "${TENANT_ID:-}" ]]; then headers+=(-H "x-tenant-id: $TENANT_ID"); fi
if [[ -n "${USER_ID:-}" ]]; then headers+=(-H "x-user-id: $USER_ID"); fi

echo "Creating valid GDTI profile '$GDTI_NAME' at $GRAPHQL_URL"
echo 'GraphQL request:'
echo "$mutation" | jq -r '.query'
if [[ "${DRY_RUN:-false}" == 'true' ]]; then
  exit 0
fi
response=$(curl -fsS -X POST "$GRAPHQL_URL" "${headers[@]}" -d "$mutation")
echo "$response" | jq

profile=$(echo "$response" | jq -e '.data.createGdtiProfile.response')
profile_id=$(echo "$profile" | jq -r '.id')
if [[ -z "$profile_id" || "$profile_id" == "null" ]]; then
  echo 'The GDTI API did not return a profile ID.' >&2
  exit 1
fi

echo
echo "PROFILE_ID=$profile_id"
echo "PROFILE_FAMILY=gdti LIMIT=1 GENERATE_DEMO_NUMBERS=true ./scripts/run-profile-compliance-agent.sh"

if [[ "${RUN_AGENT:-false}" == 'true' ]]; then
  : "${API:?Set API to the orchestrator base URL when RUN_AGENT=true}"
  : "${SERVICE_API_KEY:?Set SERVICE_API_KEY when RUN_AGENT=true}"
  PROFILE_FAMILY=gdti LIMIT=1 GENERATE_DEMO_NUMBERS=true \
    "$SCRIPT_DIR/run-profile-compliance-agent.sh"
fi
