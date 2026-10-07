# Compliance agent implementation plan

## Objective

Create agents that analyze records from existing PharmaTrace APIs, generate versioned compliance reports, avoid duplicate processing, and send the agent-created report proof to HCS. The orchestrator owns report state and matching; source services remain the owners of the source records.

The first implementation is the Serial Number Profile Agent. The same design will then support GDTI, SSCC, audit logs, lots, shortages, recalls, and timing analysis. Remote serial profiles are deferred and are not part of the active profile list.

## Architecture

```text
Agent run
  -> Orchestrator source API adapter
  -> Serial profile API: GET /getAllProfiles
  -> Orchestrator matches source IDs with compliance report records
  -> Only eligible records are returned to the agent
  -> Agent loads the complete record
  -> Agent applies its rule set
  -> Orchestrator creates a versioned compliance report
  -> Agent-created report attestation is submitted to HCS
  -> UI displays the report and review policy
  -> Human comments, resolves, overrides, approves, or rejects
  -> UI wallet prepares/signs/submits human action HCS transactions
  -> Orchestrator verifies every transaction through Mirror Node
```

The source APIs remain the owners of profile records. The orchestrator calls the source API, then matches the returned records against its own generic `compliance_reports` table using tenant, agent type, record type, record ID, and record fingerprint. No source table name is required in the orchestrator.

`GET /api/v1/compliance/reports` supports `recordType`, `recordId`, and `sourceSystem` filters in addition to status, agent type, result status, pagination, and offset.

Report creation accepts `recordType`, `recordId`, `sourceSystem`, `sourceVersion`, `sourceUpdatedAt`, and `recordFingerprint`. These values are persisted on the report and included in the report response as `record`. Matching is tenant-scoped and agent-type-scoped. A source record is eligible for agent processing when it has no report, its source fingerprint changed, or its latest report is pending/failed/under agent review. Human review and wallet/attested states are not returned as new agent targets.

## Profile agent implementations

The deterministic profile agent endpoints are:

```http
POST /api/v1/compliance/serial-profiles/run
POST /api/v1/compliance/sscc-profiles/run
POST /api/v1/compliance/gdti-profiles/run
```

The agents use these source operations:

- Serial number profiles: `GET https://ser-snm.k8s.pharmatrace.io/getAllProfiles`
- SSCC profiles: `allSsccProfiles`
- GDTI profiles: `allGdtiProfiles`

The Random Serial Number Profile agent also calls `POST https://ser-snm.k8s.pharmatrace.io/downloadSerialNumbers` with the profile identifier and a small demo size (two by default). It validates the returned serial numbers against the profile’s configured length, prefix, suffix, and character set. Generation failures or invalid generated values become report findings; the generated values are included in report evidence for testing and are not sent as credentials.

The three GraphQL operations use `https://pt-snm-gdti.k8s.pharmatrace.io/graphql`. Each endpoint creates a separate report family and applies the existing local report-state/fingerprint filter before validation. For local testing, the request may include a `profiles` array instead of reading the source API:

```json
{
  "limit": 100,
  "ruleSetVersion": "GS1-CONFIG-2026-01",
  "profiles": [
    {
      "id": "d113b731-adce-46d6-9680-87d071f37b7d",
      "name": "RS-ABRILADA-01",
      "identifier": "rs-abrilada-01",
      "serialNumberLength": 15,
      "serialNumChars": "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "prepandData": "093",
      "appendData": "32",
      "maxRequestSize": 1000,
      "active": true
    }
  ]
}
```

The validators check each profile family’s required identity, GS1 fields, range, increment, request-size, and active-state rules. Every result creates a report: `PASS` when blocking rules pass, `FAIL` when required findings exist, and `REVIEW` for informational findings. Re-running the same unchanged profile returns the existing report through the existing fingerprint/idempotency path.

Before validation, the adapter compares every API profile with the latest local report. It processes only profiles with no report, a changed source fingerprint, or a latest report in `AGENT_REVIEW`, `VERIFICATION_FAILED`, `ANALYSIS_FAILED`, or `REJECTED`. Profiles already in normal review, wallet preparation, submitted, verifying, or attested states are skipped.

## Source record identity

### Implemented before agent execution

The database/report foundation is implemented in migration `011_compliance_source_records.sql`. It adds generic source identity columns to `compliance_reports`, persists them during report creation, and includes them in the report digest and first HCS payload. The source API adapter and agent definition are implemented for serial profiles.

Every report must identify the source record using these fields:

```text
record_type
record_id
source_system
source_version
source_updated_at
record_fingerprint
```

Example for a serial profile:

```json
{
  "recordType": "SERIAL_NUMBER_PROFILE",
  "recordId": "d113b731-adce-46d6-9680-87d071f37b7d",
  "sourceSystem": "ser-snm",
  "sourceVersion": "2026-09-22T10:30:00Z",
  "sourceFingerprint": "sha256-of-canonical-profile"
}
```

`profileId` remains supported for compatibility, but new agents must use `recordType` and `recordId`.

## Generic report matching

The orchestrator needs a record-to-report link or equivalent report columns. The recommended normalized table is:

```text
compliance_record_reports
```

Required fields:

```text
id
tenant_id
record_type
record_id
source_system
agent_type
report_id
report_version
report_status
record_fingerprint
created_at
updated_at
```

Required indexes:

```text
(tenant_id, record_type, record_id)
(tenant_id, agent_type, report_status)
(tenant_id, record_type, record_id, record_fingerprint)
```

The report fingerprint must include:

```text
tenant_id
agent_type
record_type
record_id
source_fingerprint
rule_set_version
```

This makes report creation idempotent for an unchanged source record.

## Eligible-record states

The source adapter joins each source record to the latest matching report.

Return a record to the agent when:

- no report exists;
- the previous agent report was not submitted or verified;
- the report is in `AGENT_REVIEW`;
- the report is in `VERIFICATION_FAILED`;
- the source fingerprint changed and a new report version is required.

Do not return an unchanged record when the latest report is:

```text
HUMAN_REVIEW
READY_FOR_WALLET
VERIFYING
ATTESTED
```

`HUMAN_REVIEW` belongs to the human queue. `READY_FOR_WALLET` and `VERIFYING` must not create another transaction. `ATTESTED` is complete unless the source fingerprint or rule-set version changes.

## Target API

Add an orchestrator target endpoint or MCP tool. The source service endpoint remains unchanged.

```http
GET /api/v1/compliance/targets
```

Query parameters:

```text
agentType=SERIAL_PROFILE_AGENT
recordType=SERIAL_NUMBER_PROFILE
sourceSystem=ser-snm
reportState=UNREPORTED,AGENT_REVIEW,VERIFICATION_FAILED
limit=50
offset=0
```

Response:

```json
{
  "items": [
    {
      "recordType": "SERIAL_NUMBER_PROFILE",
      "recordId": "d113b731-adce-46d6-9680-87d071f37b7d",
      "sourceSystem": "ser-snm",
      "sourceFingerprint": "sha256...",
      "reportState": "UNREPORTED",
      "latestReportId": null,
      "latestReportStatus": null,
      "latestReportVersion": null
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1,
    "hasMore": false
  }
}
```

Also add:

```http
GET /api/v1/compliance/records/{recordType}/{recordId}/reports
```

This returns all report versions, actions, findings, attestations, and HCS status for one source record.

## Serial Number Profile Agent

Source API:

```http
GET https://ser-snm.k8s.pharmatrace.io/getAllProfiles
```

Required MCP capabilities:

1. `list_serial_profiles_for_compliance` — calls the source API and applies the local report-state join.
2. `get_serial_profile` — returns the complete profile by ID.
3. `create_compliance_report` — creates the report and findings through the orchestrator.

The source adapter must preserve the source profile ID and calculate a canonical fingerprint from the profile fields used by the rules.

Example report payload:

```json
{
  "agentType": "SERIAL_PROFILE_AGENT",
  "recordType": "SERIAL_NUMBER_PROFILE",
  "recordId": "d113b731-adce-46d6-9680-87d071f37b7d",
  "sourceSystem": "ser-snm",
  "sourceData": {
    "name": "RS-ABRILADA-01",
    "identifier": "rs-abrilada-01",
    "serialNumberLength": 15,
    "format": "AlphaNumeric",
    "numericValues": true,
    "active": true
  },
  "sourceFingerprint": "sha256...",
  "resultStatus": "PASS",
  "ruleSetVersion": "GS1-2026-01",
  "summary": "Profile matches the configured GS1 serial-number rules.",
  "findings": []
}
```

## Agent configuration

The existing agent `configuration` object can hold the first version of this configuration:

```json
{
  "reportType": "SERIAL_NUMBER_PROFILE_COMPLIANCE",
  "recordType": "SERIAL_NUMBER_PROFILE",
  "sourceSystem": "ser-snm",
  "ruleSetVersion": "GS1-2026-01",
  "targetStates": [
    "UNREPORTED",
    "AGENT_REVIEW",
    "VERIFICATION_FAILED"
  ],
  "skipStates": [
    "HUMAN_REVIEW",
    "READY_FOR_WALLET",
    "VERIFYING",
    "ATTESTED"
  ],
  "pageSize": 50,
  "maxRecordsPerRun": 100
}
```

The agent must use the target API/tool instead of fetching every source record and deciding locally whether it was already processed.

## Report lifecycle

```text
No report
  -> Agent analyzes source record
  -> REPORT_READY / PENDING_REVIEW
  -> Agent REPORT_CREATED HCS attestation
  -> Human review
  -> HUMAN_REVIEW or AGENT_REVIEW when action is required
  -> APPROVED
  -> READY_FOR_WALLET
  -> UI wallet prepares and submits human decision
  -> VERIFYING
  -> ATTESTED
```

Human comments, resolutions, overrides, approvals, and rejections are separate action events. They must use stable idempotency keys and must never create a second HCS transaction when retried.

If a human rejects or overrides a report, the report moves to `AGENT_REVIEW`. The agent either:

- agrees and records an agent review action; or
- creates a new linked report using `supersedesReportId` and an incremented `report_version`.

The original report remains immutable.

## HCS responsibilities

Agent-created report:

- server-side agent signer may submit the initial `REPORT_CREATED` proof;
- the transaction is linked to the report and source record;
- Mirror Node verification stores sequence and consensus data.

Human action:

- backend receives the UI payer account ID;
- backend freezes and returns `transactionBytes`;
- UI wallet signs, pays, and submits;
- UI calls the existing `/wallet/submitted` callback;
- backend verifies through Mirror Node.

The agent payer must never be used for human wallet preparation.

## Agent creation checklist

- Define `agentType` and `reportType`.
- Define `recordType` and `sourceSystem`.
- Define source API URL and authentication.
- Create or sync MCP source tools.
- Add target filtering through the orchestrator.
- Add the report schema and output schema.
- Add the rule-set version.
- Configure allowed MCP servers and tools.
- Configure manual or scheduled execution.
- Configure page size and maximum records per run.
- Add stable report fingerprints.
- Add idempotent report creation.
- Add agent HCS `REPORT_CREATED` attestation.
- Add UI report/review queue support.
- Add Mirror Node verification.
- Add audit logging for source fetch, eligibility decision, report creation, and HCS submission.

## Testing plan

1. Create a source profile with no report and confirm it is returned as `UNREPORTED`.
2. Run the agent and confirm exactly one report is created.
3. Run the agent again without changing the profile and confirm no new report is created.
4. Put the report in `HUMAN_REVIEW` and confirm the agent does not reclaim it.
5. Put the report in `AGENT_REVIEW` and confirm it is returned to the agent.
6. Change a source field and confirm a new fingerprint and report version are created.
7. Confirm the old report remains linked through `supersedesReportId`.
8. Retry a report creation request and confirm the same report is returned.
9. Confirm agent HCS proof and human HCS actions are stored separately.
10. Confirm Mirror Node verification changes only the matching report or action.
11. Confirm pagination does not skip or duplicate source records.
12. Confirm tenant isolation prevents one tenant from matching another tenant's reports.

## Implementation order

1. Add source-record identity and report-link migration.
2. Add fingerprint and latest-report lookup queries.
3. Implement `/compliance/targets` and record-history endpoints.
4. Implement the serial profile MCP adapter.
5. Add agent configuration for the Serial Number Profile Agent.
6. Implement report creation with record linkage.
7. Add eligibility and duplicate-processing tests.
8. Connect the existing HCS attestation flow.
9. Connect the UI review and wallet flow.
10. Add scheduled execution after manual execution is verified.
