ALTER TABLE compliance_reports
  DROP CONSTRAINT IF EXISTS chk_compliance_report_status;

ALTER TABLE compliance_reports
  ADD CONSTRAINT chk_compliance_report_status CHECK (status IN (
    'REPORT_READY', 'PENDING_REVIEW', 'HUMAN_REVIEW', 'AGENT_REVIEW',
    'APPROVED', 'APPROVED_WITH_OVERRIDE', 'REJECTED', 'READY_FOR_WALLET',
    'SUBMITTED', 'VERIFYING', 'WAITING_FOR_CONFIRMATION', 'ATTESTED',
    'VERIFICATION_FAILED', 'ANALYSIS_FAILED'
  ));

ALTER TABLE compliance_attestations
  DROP CONSTRAINT IF EXISTS chk_compliance_attestation_status;

ALTER TABLE compliance_attestations
  ADD CONSTRAINT chk_compliance_attestation_status CHECK (status IN (
    'PREPARED', 'SUBMITTED', 'VERIFYING', 'WAITING_FOR_CONFIRMATION',
    'CONFIRMED', 'FAILED'
  ));
