ALTER TABLE compliance_reports
  ADD COLUMN IF NOT EXISTS record_type VARCHAR(120),
  ADD COLUMN IF NOT EXISTS record_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(160),
  ADD COLUMN IF NOT EXISTS source_version VARCHAR(160),
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS record_fingerprint VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_compliance_reports_record
  ON compliance_reports (tenant_id, record_type, record_id, agent_type, created_at DESC)
  WHERE record_type IS NOT NULL AND record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_compliance_reports_record_fingerprint
  ON compliance_reports (tenant_id, record_type, record_id, record_fingerprint, report_version DESC)
  WHERE record_type IS NOT NULL AND record_id IS NOT NULL;
