# Profile compliance agent flows

The backend currently runs three independent profile agents. Remote Serial Number Profiles are deferred and are not included.

## Common flow

1. Authenticate to the source API with the configured Keycloak credentials.
2. Load the source profiles for the selected family.
3. Match each source record by `tenant_id`, `agent_type`, `record_type`, and source `record_id`.
4. Skip an unchanged record when its latest report is still pending, submitted, verifying, or attested.
5. Reprocess a new or changed record, or a record whose latest report is `AGENT_REVIEW`, `VERIFICATION_FAILED`, `ANALYSIS_FAILED`, or `REJECTED`.
6. Request a demo generated value from the serial-number service.
7. Evaluate the family-specific GS1 rules.
8. Create a PASS, FAIL, or REVIEW compliance report with the source fingerprint and generated-value evidence.
9. Create the agent attestation. If the agent Hedera signer is configured, the first report-created proof is submitted to HCS automatically.
10. A human reviews the report, resolves or overrides findings, approves/rejects it, and uses the wallet flow for the human decision proof.

## Serial / Random profile agent

Endpoint:

```text
POST /api/v1/compliance/serial-profiles/run
```

Source:

```text
GET https://ser-snm.k8s.pharmatrace.io/getAllProfiles
```

Report identity:

```text
agentType=SERIAL_PROFILE
recordType=SERIAL_NUMBER_PROFILE
sourceSystem=ser-snm
```

Generator request uses `idType=GTIN` and the profile `identifier` or `name` as the object-key value. The generated values are checked against the configured prefix, suffix, length, format, and character set.

## SSCC profile agent

Endpoint:

```text
POST /api/v1/compliance/sscc-profiles/run
```

Source:

```text
POST https://pt-snm-gdti.k8s.pharmatrace.io/graphql
query { allSsccProfiles { ... } }
```

Report identity:

```text
agentType=SSCC_PROFILE
recordType=SSCC_PROFILE
sourceSystem=pt-snm-gdti
```

Generator request uses `idType=SSCC` and the SSCC profile UUID as the object-key value. The result must be an 18-digit numeric SSCC using AI `(00)` and a valid GS1 Mod-10 check digit. GDTI-style output such as `[253 GS11]` is rejected.

The agent also checks prefix capacity, extension digit, EPC filter, range state, threshold, index/remaining reconciliation, and remote-system selection.

## GDTI profile agent

Endpoint:

```text
POST /api/v1/compliance/gdti-profiles/run
```

Source:

```text
POST https://pt-snm-gdti.k8s.pharmatrace.io/graphql
query { allGdtiProfiles { ... } }
```

Report identity:

```text
agentType=GDTI_PROFILE
recordType=GDTI_PROFILE
sourceSystem=pt-snm-gdti
```

Generator request uses `idType=GDTI` and the GDTI profile UUID as the object-key value. The agent checks the numeric Company Prefix, document reference, 12-digit base-key composition, GDTI-96 limits, range/index/remaining state, threshold, EPC filter, and active/exhausted state.

## Run options

The request body is shared by all three endpoints:

```json
{
  "limit": 100,
  "ruleSetVersion": "GS1-CONFIG-2026-01",
  "generateDemoNumbers": true,
  "demoNumberCount": 2
}
```

For controlled tests, `profiles` may be supplied directly instead of loading the source API. Set `generateDemoNumbers` to `false` to test only profile validation.

## Local runner

The reusable runner is:

```text
scripts/run-profile-compliance-agent.sh
```

Set the orchestrator URL and service key, then select the profile family:

```bash
export API="http://localhost:3000/api/v1"
export SERVICE_API_KEY="your-service-api-key"

PROFILE_FAMILY=serial ./scripts/run-profile-compliance-agent.sh
PROFILE_FAMILY=sscc ./scripts/run-profile-compliance-agent.sh
PROFILE_FAMILY=gdti ./scripts/run-profile-compliance-agent.sh
```

Run all three active profile agents sequentially:

```bash
PROFILE_FAMILY=all ./scripts/run-profile-compliance-agent.sh
```

Optional runner settings:

```bash
LIMIT=100
DEMO_NUMBER_COUNT=2
GENERATE_DEMO_NUMBERS=true
RULE_SET_VERSION=GS1-CONFIG-2026-01
```

The profile runner calls the deterministic compliance endpoints directly. It does not create an Ollama/MCP agent because profile selection, generation, validation, report creation, and HCS attestation are backend-controlled steps. The lot-anchor runner remains separate because it uses LLM planning and MCP tools.

## Report filtering

Use the report list endpoint to view one agent independently:

```text
GET /api/v1/compliance/reports?agentType=GDTI_PROFILE&status=REPORT_READY&limit=50&offset=0
GET /api/v1/compliance/reports?recordType=SSCC_PROFILE&resultStatus=FAIL&limit=50&offset=0
GET /api/v1/compliance/reports?agentType=SERIAL_PROFILE&recordId={profileId}
```

The report contains `record`, `recordFingerprint`, `sourceData`, findings, generated values, and HCS attestation details. Secrets and source API credentials are never included in the report or HCS payload.
