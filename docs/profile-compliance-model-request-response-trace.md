# Profile Compliance Model Request/Response Trace

## Runtime trace file

The example above is only the contract. To capture a real rerun, enable the
redacted runtime trace before starting the orchestrator:

```bash
export MODEL_TRACE_ENABLED=true
export MODEL_TRACE_DIR="$PWD/logs/model-traces"
```

Each run writes one file named `<runId>.json`. It records the actual model
`request` (`system`, serialized `prompt`, and schema) and the model `response`
for planner, tool execution, evaluation, profile-finding-group review, and
final-response stages. Model API keys, bearer tokens, passwords, and secrets
are redacted before the file is written. The directory is git-ignored and
should be treated as diagnostic data, not as a production audit record.

This file is a diagnostic contract and review example for one GDTI profile. It
shows what the deterministic validator knows, what one LLM group request must
contain, what the model returned, and where the result must be rejected or merged.

## Trace metadata

```json
{
  "agentType": "GDTI_PROFILE",
  "profileId": "66676389-19e4-4945-b32d-f7dae851663a",
  "reportVersion": 1,
  "ruleSetVersion": "GS1-CONFIG-2026-01",
  "reviewSession": "one profile",
  "groupNumber": 1,
  "totalGroups": 3
}
```

## Deterministic source input

The profile must be present in every review request. Do not send `{}`.

```json
{
  "profileId": "66676389-19e4-4945-b32d-f7dae851663a",
  "profile": {
    "id": "66676389-19e4-4945-b32d-f7dae851663a",
    "name": " GDTI-01",
    "companyPrefix": " GS1",
    "documentType": "Document-01",
    "epcFilterValue": 1,
    "startNumber": 1,
    "currentNumber": 21,
    "incrementBy": 1,
    "numberRangeSize": 1,
    "remaining": 0,
    "index": 1,
    "status": "Active"
  },
  "generation": {
    "status": "ERROR",
    "compliance": "NOT_TESTED",
    "error": "Serial number generation API returned HTTP 400",
    "samples": []
  }
}
```

Because generation returned no samples, the report must not claim that generated
GS1 values were validated. Profile configuration validation and generation
validation are separate results.

## Correct model request: one finding group

Only the rules and evidence related to this group are sent. The other groups are
sent in later calls for the same profile review session.

```json
{
  "profileId": "66676389-19e4-4945-b32d-f7dae851663a",
  "reportId": "REPORT_ID",
  "groupNumber": 1,
  "totalGroups": 3,
  "profile": {
    "name": " GDTI-01",
    "companyPrefix": " GS1",
    "documentType": "Document-01",
    "epcFilterValue": 1
  },
  "findings": [
    {
      "findingId": "FINDING_NAME",
      "rule": {
        "ruleId": "GDTI-NAME-003",
        "title": "GDTI name contains surrounding whitespace",
        "field": "name",
        "severity": "MEDIUM",
        "requiresResolution": false
      },
      "evidence": {
        "field": "name",
        "currentValue": " GDTI-01",
        "expectedValue": "GDTI-01",
        "reason": "The profile name has leading whitespace."
      }
    },
    {
      "findingId": "FINDING_PREFIX",
      "rule": {
        "ruleId": "GDTI-PREFIX-002",
        "title": "GS1 Company Prefix is not numeric",
        "field": "companyPrefix",
        "severity": "HIGH",
        "requiresResolution": true
      },
      "evidence": {
        "field": "companyPrefix",
        "currentValue": " GS1",
        "expectedValue": "Assigned numeric GS1 Company Prefix",
        "reason": "The value contains whitespace and letters."
      }
    },
    {
      "findingId": "FINDING_DOCUMENT",
      "rule": {
        "ruleId": "GDTI-DOC-002",
        "title": "GDTI document reference is not numeric",
        "field": "documentType",
        "severity": "HIGH",
        "requiresResolution": true
      },
      "evidence": {
        "field": "documentType",
        "currentValue": "Document-01",
        "expectedValue": "Numeric document reference",
        "reason": "The value contains letters and punctuation."
      }
    },
    {
      "findingId": "FINDING_BASE",
      "rule": {
        "ruleId": "GDTI-DOC-003",
        "title": "GDTI base cannot be constructed as 12 digits",
        "field": "companyPrefix + documentType",
        "severity": "HIGH",
        "requiresResolution": true
      },
      "evidence": {
        "currentValue": " GS1 + Document-01",
        "expectedValue": "Numeric components whose combined base is 12 digits",
        "reason": "Both components must be numeric before their combined length can be checked."
      }
    }
  ]
}
```

## Observed model response that must be rejected

The reviewed response returned `NOT_APPLICABLE` for obvious deterministic
failures and invented an unsupported document value such as:

```json
{
  "findingId": "FINDING_DOCUMENT",
  "agentAssessment": "NOT_APPLICABLE",
  "expectedValue": {
    "documentType": "90123456789012"
  },
  "remediation": {
    "action": "UPDATE_PROFILE",
    "instruction": "Replace the document type."
  }
}
```

This response is invalid because:

- `NOT_APPLICABLE` contradicts the remediation.
- The expected value was not present in the source data.
- The invented value has no assigned-prefix evidence.
- It is not tied to the required 12-digit GDTI construction.

The backend must reject or mark this finding `REVIEW_FAILED`; it must not accept
the invented value into the finalized report.

## Required response validation

For every submitted `findingId`:

```json
{
  "findingId": "FINDING_PREFIX",
  "ruleId": "GDTI-PREFIX-002",
  "agentAssessment": "CONFIRMED",
  "finding": "The companyPrefix value is not a valid numeric GS1 Company Prefix.",
  "currentValue": " GS1",
  "expectedValue": "Assigned numeric GS1 Company Prefix",
  "remediation": {
    "action": "UPDATE_PROFILE_FIELD",
    "from": " GS1",
    "to": "Assigned numeric GS1 Company Prefix",
    "instruction": "Replace companyPrefix with the assigned numeric GS1 Company Prefix."
  }
}
```

Validation rules:

1. `findingId` must match a submitted deterministic finding.
2. `ruleId` must match the rule supplied for that finding.
3. `currentValue` must equal the deterministic value or be a faithful representation.
4. `expectedValue` must come from the rule, deterministic evidence, or a constrained description.
5. `NOT_APPLICABLE` cannot contain a remediation that asks the user to fix the finding.
6. The model cannot invent company prefixes, document references, GTINs, or IDs.
7. Every submitted finding must receive an assessment.
8. Omitted findings remain `NOT_REVIEWED`.

## Merge result

The response from each group is merged into the original finding by `findingId`.
The original deterministic evidence remains authoritative:

```json
{
  "findingId": "FINDING_PREFIX",
  "deterministic": {
    "ruleId": "GDTI-PREFIX-002",
    "status": "OPEN",
    "currentValue": " GS1"
  },
  "agentReview": {
    "assessment": "CONFIRMED",
    "comment": "The companyPrefix value is not a valid numeric GS1 Company Prefix.",
    "remediation": {
      "action": "UPDATE_PROFILE_FIELD",
      "from": " GS1",
      "to": "Assigned numeric GS1 Company Prefix"
    }
  }
}
```

After all groups finish:

```text
Version 1 deterministic report
→ review group 1
→ review group 2
→ review group 3
→ validate and merge all responses
→ create report version 2
→ create REPORT_CREATED attestation for version 2
→ anchor the compact digest to HCS
```

This trace is the reference file for diagnosing whether a problem came from the
source API, deterministic validation, context construction, model output, output
validation, report merging, or HCS attestation.
