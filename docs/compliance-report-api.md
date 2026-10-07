# Compliance report API

The orchestrator is the system of record for agent-produced compliance reports. Agents create reports and findings; reviewers update findings and approve or reject the report; the UI wallet submits the approved attestation to HCS.

For source-record matching, agent setup, eligibility filtering, and implementation order, see [the compliance agent implementation plan](./compliance-agent-implementation-plan.md).

All routes use the global prefix `/api/v1` and the existing tenant headers:

- `x-tenant-id`
- `x-user-id`
- `x-service-api-key` when `SERVICE_API_KEY` is configured

## Lifecycle

```text
Agent run
  -> POST /compliance/reports
  -> agent REPORT_CREATED attestation is submitted to HCS when the agent signer is configured
  -> findings OPEN / report PENDING_REVIEW
  -> UI reads reviewPolicy
  -> direct approval for informational/pass reports, or comment/resolve/override required findings
  -> POST /compliance/reports/{id}/approve
  -> POST /compliance/reports/{id}/wallet/prepare
  -> UI wallet signs and submits the returned attestation payload to HCS
  -> POST /compliance/reports/{id}/wallet/submitted
  -> Mirror Node verification updates the attestation to CONFIRMED
```

## Tables

### `compliance_reports`

One report version and its canonical digests. It stores the result (`PASS`, `FAIL`, or `REVIEW`), rule-set version, report JSON, evidence digest, issue fingerprint, creator identity, approval state, and source agent run. A replacement report sets `supersedesReportId` and receives the next `report_version`.

### `compliance_findings`

Individual rule failures or warnings. A finding can be `OPEN`, `ACKNOWLEDGED`, `REMEDIATION_IN_PROGRESS`, `RESOLVED`, `OVERRIDDEN`, or `CLOSED_NO_ACTION`. `requires_resolution=false` marks an informational finding that must remain visible but does not block approval.

### `compliance_action_events`

Append-only audit history for report creation, comments, finding updates, approval, rejection, and overrides. This is the record of who changed what and when.

### `compliance_decisions`

Review decisions with reviewer, report version, comment, and decision digest. A decision is separate from the current report status so approval/rejection remains auditable.

### `compliance_attestations`

HCS proof state for `REPORT_CREATED`, `REPORT_COMMENT`, and `DECISION` attestations. It stores only the canonical payload/digest and HCS transaction metadata; raw operational secrets are never stored.

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/compliance/reports` | Create an idempotent report and findings |
| `POST` | `/compliance/reports/demo/seed` | Create sample reports for UI testing; disabled unless `COMPLIANCE_DEMO_ENABLED=true` |
| `GET` | `/compliance/reports` | List reports; supports `status`, `agentType`, `resultStatus`, `limit`, `offset` |
| `GET` | `/compliance/reports/{id}` | Return report, findings, actions, decisions, and attestations |
| `POST` | `/compliance/reports/{id}/findings/{findingId}/comment` | Add reviewer comment and acknowledge finding |
| `POST` | `/compliance/reports/{id}/comment` | Add a report-level reviewer comment and return its `commentId` |
| `POST` | `/compliance/reports/{id}/findings/{findingId}/resolve` | Resolve a finding with a required comment |
| `POST` | `/compliance/reports/{id}/findings/{findingId}/override` | Explicitly override a finding with a required comment |
| `POST` | `/compliance/reports/{id}/approve` | Approve report; non-PASS reports require all findings resolved/overridden |
| `POST` | `/compliance/reports/{id}/reject` | Reject report and record reviewer decision |
| `POST` | `/compliance/reports/{id}/agent/review` | Agent agrees with the human action or creates a linked revised report |
| `POST` | `/compliance/reports/{id}/wallet/prepare` | Prepare the canonical decision attestation payload and frozen `transactionBytes` using the UI payer |
| `POST` | `/compliance/reports/{id}/wallet/submitted` | Store wallet HCS transaction ID, topic, sequence, and consensus timestamp, then move the report to `VERIFYING` |
| `POST` | `/compliance/reports/{id}/comments/{commentId}/wallet/prepare` | Prepare unsigned HCS transaction bytes for a reviewer comment |
| `POST` | `/compliance/reports/{id}/comments/{commentId}/wallet/submitted` | Store the wallet submission for a reviewer comment |
| `GET` | `/compliance/reports/{id}/comments/{commentId}/verify` | Return reviewer-comment HCS proof state |
| `POST` | `/compliance/reports/{id}/actions/{actionId}/wallet/prepare` | Prepare HCS bytes for any review action |
| `POST` | `/compliance/reports/{id}/actions/prepare-pending` | Prepare all pending comment/review actions once; submitted or confirmed actions are skipped |
| `POST` | `/compliance/reports/{id}/actions/{actionId}/wallet/submitted` | Store wallet submission for any review action |
| `GET` | `/compliance/reports/{id}/actions/{actionId}/verify` | Verify any review action through Mirror Node |
| `GET` | `/compliance/reports/{id}/verify` | Return current report/attestation verification state |

## Action idempotency and multiple comments

Each user or agent comment/review action has its own action ID and HCS attestation. Distinct comments are retained, even when their text is the same. A retry must reuse the original action's `idempotencyKey`; it must not generate a new timestamp-based key.

Wallet preparation is idempotent. The first preparation stores the exact unsigned transaction bytes and prepared transaction ID. Later calls for the same payer return the same bytes with `alreadyPrepared: true`. A still-`PREPARED` attestation is regenerated only when the UI explicitly supplies a different payer account, because the payer is part of the signed transaction. Once an attestation is `SUBMITTED`, `WAITING_FOR_CONFIRMATION`, or `CONFIRMED`, preparation returns `alreadyProcessed: true` and does not create another wallet transaction.

For several pending comments/actions, call `POST /compliance/reports/{id}/actions/prepare-pending` with `{ "payerAccountId": "0.0.x" }`. The response separates `prepared` actions from `skipped` actions. The UI signs each item in `prepared` once, then calls that action's `/wallet/submitted` endpoint. Items in `skipped` must not be submitted again.

## Review policy returned to the UI

`GET /compliance/reports` and `GET /compliance/reports/{id}` return `review_policy` and `reviewPolicy` for compatibility:

- `DIRECT_APPROVAL`: no required finding is open; the reviewer may approve directly.
- `RESOLUTION_REQUIRED`: one or more findings have `requires_resolution=true` and remain open; the reviewer must resolve them.
- `HUMAN_REVIEW`: a reviewer added a comment or resolution and the report remains in the human review queue.
- `AGENT_REVIEW`: a reviewer rejected or overrode the result; the report is queued for agent re-analysis.
- `READY_FOR_APPROVAL`: all required findings are closed and the report can be approved.

The policy also includes `reviewQueue`, `agentReviewRequired`, `requiresUserAction`, `openRequiredFindings`, `allowApprove`, `allowResolve`, `allowOverride`, and `allowReject`. The UI should use these flags instead of deriving behavior from `resultStatus` alone. A `FAIL` or `REVIEW` report can be approved after all required findings are resolved; informational findings never block approval. Filter agent work with `GET /compliance/reports?status=AGENT_REVIEW` and human work with `GET /compliance/reports?status=HUMAN_REVIEW`.

## Demo data

Enable only in a development/test environment:

```text
COMPLIANCE_DEMO_ENABLED=true
```

Then call `POST /api/v1/compliance/reports/demo/seed` with:

```json
{ "count": 3 }
```

The generator first removes only previous reports marked with `scope.source=demo-seed` or `report.generatedBy=compliance-demo-seed` for the current tenant. It never removes real agent reports. Existing HCS messages are immutable and remain on the topic. The generator then creates PASS, REVIEW, and FAIL examples across the agent report types. Use `count=6` to also create queue examples: one `HUMAN_REVIEW` report from a reviewer comment, one `AGENT_REVIEW` report from an override, and one `AGENT_REVIEW` report from a rejection. Each report includes `agentType`, `profileId`, creator ID, creator name, creator public key, a report digest, findings, a `REPORT_CREATED` attestation, and a `REPORT_CREATED` action event. If the agent signer is configured, the seed submits exactly one first HCS transaction per report automatically; otherwise the attestation remains `PREPARED` for UI wallet submission.

The demo cases intentionally cover the review paths:

- PASS: no required findings; directly approvable.
- REVIEW: informational finding with `requiresResolution=false`; visible but does not block approval.
- FAIL: required finding with `requiresResolution=true`; must be resolved or overridden before approval.

## Review actions and HCS

## Source-record matching before agent execution

The source tables and orchestrator tables share PostgreSQL. The agent adapter should query the source table and left-join the latest `compliance_reports` row using tenant, agent type, record type, record ID, and record fingerprint. It should return only records with no report, a changed source fingerprint, a pending/failed status, or `AGENT_REVIEW`. Human-review, wallet, and attested records should be excluded.

Report creation accepts `recordType`, `recordId`, `sourceSystem`, `sourceVersion`, `sourceUpdatedAt`, and `recordFingerprint`. The same identity is returned as `record` in report details. Matching is tenant-scoped and atomic in the database; no extra target-filter HTTP endpoint is required.

Every comment, resolution, override, approval, rejection, and agent review is stored as an immutable action event and receives an HCS attestation. Human actions are prepared for wallet signing. Agent review actions can be submitted by the configured agent signer. The action verification endpoint reconciles the transaction through Mirror Node and changes the attestation to `CONFIRMED`.

For the automatic testnet path, configure:

```env
HEDERA_NETWORK=testnet
HEDERA_TOPIC_ID=0.0.10123883
MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
AGENT_HEDERA_ACCOUNT_ID=0.0.xxxxx
AGENT_HEDERA_PRIVATE_KEY=302e...
```

The endpoint `POST /compliance/reports/{id}/agent/submit` can retry the first transaction for an existing prepared report. The private key never goes to the UI.

The creator public key is metadata for report attribution. It is not a private key and it does not replace the wallet signature. HCS authenticity comes from the connected wallet transaction; the digest binds the on-chain message to the stored report.

## Rejected-report review

The agent can review a human rejection without mutating the report evidence. A human rejection records a `REJECTED` decision and moves the report status to `AGENT_REVIEW`, so the agent queue can find it with `status=AGENT_REVIEW`. If the rejection is valid, the agent can create a new report through `POST /compliance/reports` with:

```json
{
  "supersedesReportId": "old-report-uuid",
  "revisionReason": "Agent rechecked the evidence and corrected the profile rule result.",
  "agentType": "serial-profile-agent",
  "resultStatus": "PASS",
  "ruleSetVersion": "gs1-1.0",
  "summary": "Corrected report after agent review."
}
```

The original report remains immutable and linked through `supersedes_report_id`; the new report has `report_version = old version + 1`, a new digest, new findings, and a new HCS attestation.

Agent review request example:

```json
{
  "decision": "DISAGREE",
  "comment": "The reviewer decision is not supported by the evidence.",
  "revisionReason": "The agent recalculated the rule using the current profile.",
  "resultStatus": "FAIL",
  "summary": "Revised report with the corrected finding.",
  "findings": []
}
```

Use `decision=AGREE` when the agent accepts the human action. The original report moves back to `HUMAN_REVIEW`. Use `DISAGREE` when a new linked report is required; the response contains the new report.

## Migration and deployment

The migrations are `003_compliance_reports.sql` through `011_compliance_source_records.sql`. Run them after deploying the orchestrator code:

```text
npm run migrate
```

The migration runner records applied files in `schema_migrations`, so it is safe to run during deployment. The first report transaction uses the dedicated agent signer when configured; the human decision transaction remains wallet-signed in the UI.
