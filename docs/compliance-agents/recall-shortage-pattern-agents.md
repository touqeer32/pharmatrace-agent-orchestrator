# Recall and shortage pattern agents

These agents use the existing tenant-owned profile-compliance MCP server. They
authenticate to the PharmaTrace GDTI GraphQL API with the configured Keycloak
password grant, fetch real records, group repeated patterns, and create the
existing compliance report/HCS attestation record.

## MCP tools

- `run_recall_pattern_compliance` reads `allProductRecallRequests`.
- `run_shortage_pattern_compliance` reads `allProductShortages`.

Both tools accept:

```json
{
  "limit": 500,
  "minEvents": 2,
  "windowDays": 365,
  "resetReports": false
}
```

Patterns are grouped by product and drug. A report is created only when the
group contains at least `minEvents` records inside the time window. Existing
pattern reports are not recreated in any status. `resetReports: true` is a
test-only explicit reset.

## HTTP endpoints

```text
POST /api/v1/compliance/reports/recall-patterns/run
POST /api/v1/compliance/reports/shortage-patterns/run
```

Example body:

```json
{
  "limit": 500,
  "minEvents": 2,
  "windowDays": 365,
  "resetReports": false
}
```

The resulting reports use `recordType` and `agentType` of `RECALL_PATTERN` or
`SHORTAGE_PATTERN`. Their evidence contains the source record IDs, grouping
dimension, grouping value, and event count. Missing recall investigation/root
cause data and missing shortage mitigation/end-date data create required
findings; otherwise the report is informational and still requires normal
human review/approval.

## Runner

```bash
export API="http://localhost:8800/api/v1"
export SERVICE_API_KEY="..."
export OLLAMA_API_KEY="ollama"
export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"
export OLLAMA_CONNECTION_ID="..."

PATTERN_FAMILY=recall ./scripts/run-pattern-compliance-agent.sh
PATTERN_FAMILY=shortage ./scripts/run-pattern-compliance-agent.sh
PATTERN_FAMILY=all ./scripts/run-pattern-compliance-agent.sh
```

The script synchronizes MCP tools, tests the configured LLM connection, starts
one manual agent run, prints tool calls and source/pattern/report counts, and
prints the final run result.
