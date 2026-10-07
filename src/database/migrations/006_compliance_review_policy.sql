ALTER TABLE compliance_reports
  ADD COLUMN IF NOT EXISTS review_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE compliance_findings
  ADD COLUMN IF NOT EXISTS requires_resolution BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE compliance_attestations
  DROP CONSTRAINT IF EXISTS chk_compliance_attestation_type;

ALTER TABLE compliance_attestations
  ADD CONSTRAINT chk_compliance_attestation_type CHECK (
    attestation_type IN ('REPORT_CREATED', 'REPORT_COMMENT', 'DECISION')
  );

CREATE INDEX IF NOT EXISTS idx_compliance_findings_required_status
  ON compliance_findings (report_id, requires_resolution, status);
