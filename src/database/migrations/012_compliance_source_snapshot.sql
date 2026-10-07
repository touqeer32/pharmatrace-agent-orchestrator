ALTER TABLE compliance_reports
  ADD COLUMN IF NOT EXISTS source_data JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN compliance_reports.source_data IS
  'Redacted source record snapshot used to produce the deterministic compliance report';
