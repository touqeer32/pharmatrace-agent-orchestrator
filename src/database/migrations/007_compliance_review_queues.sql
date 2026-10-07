ALTER TABLE compliance_reports
  DROP CONSTRAINT IF EXISTS chk_compliance_report_status;

ALTER TABLE compliance_reports
  ADD CONSTRAINT chk_compliance_report_status CHECK (status IN (
    'REPORT_READY', 'PENDING_REVIEW', 'HUMAN_REVIEW', 'AGENT_REVIEW',
    'APPROVED', 'APPROVED_WITH_OVERRIDE', 'REJECTED', 'READY_FOR_WALLET',
    'SUBMITTED', 'WAITING_FOR_CONFIRMATION', 'ATTESTED', 'VERIFICATION_FAILED',
    'ANALYSIS_FAILED'
  ));

CREATE INDEX IF NOT EXISTS idx_compliance_reports_review_queue
  ON compliance_reports (tenant_id, status, updated_at DESC)
  WHERE status IN ('HUMAN_REVIEW', 'AGENT_REVIEW');
