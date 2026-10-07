# Profile Compliance Agent Review Plan

## Scope

One profile is one compliance job and one logical agent-review session. A profile is
never split into separate profiles. Its findings may be sent to the model in small,
related groups only to control context size.

## Flow

1. Fetch profiles from the authenticated source API.
2. Validate the profile configuration deterministically.
3. Generate non-consuming sample values.
4. Build complete GS1 values:
   - Pharmaceutical serial: `(01)<GTIN-14>(21)<serial>`
   - GDTI: `(253)<GDTI-base><serial>`
   - SSCC: `(00)<18-digit-SSCC>`
5. Validate complete values with `gs1encoder`.
6. Compare generated values with the profile's character, prefix, suffix, and length rules.
7. Consolidate repeated sample failures into focused findings.
8. Store the complete deterministic draft report.
9. Group the findings for that same profile by related fields and severity, normally four
   findings per group.
10. Review every group sequentially for that profile.
11. Merge each response into the original finding by `findingId`.
12. Preserve findings that were not reviewed or whose group failed.
13. Calculate the final profile result from the complete merged report.
14. Create a new report version and anchor its compact digest to HCS.

## Agent context contract

Each group contains the profile ID, report ID, relevant profile fields, the matching
rule definition, focused validation evidence, and representative generated samples.
The full rule catalog and repeated full profile snapshots are not sent to the model.

The model must return the exact `findingId` supplied in the group and one of:

- `CONFIRMED`
- `DISPUTED`
- `NOT_APPLICABLE`

Every assessment must include the current value, expected value, ownership target, and
an actionable remediation with an explicit current-to-expected change.

## Persistence rules

The deterministic findings are authoritative evidence. Agent output enriches those
findings and never replaces or deletes them. An omitted finding remains
`NOT_REVIEWED`; an LLM group failure remains `REVIEW_FAILED`. The merged result is a
new version linked with `supersedes_report_id`.

## Parallelism

Different profiles may run concurrently with a bounded worker limit. Finding groups
within one profile are sequential to avoid conflicting recommendations. Profiles are
never mixed in one model context.

## Current implementation status

- Complete GS1 value construction and `gs1encoder` validation are wired.
- Deterministic evidence is focused on the relevant field instead of repeating every
  profile field.
- Profile review context is grouped into related finding groups.
- Agent review persistence merges assessments into the original findings.
- Sequential multi-call execution for all groups is the next implementation slice.
