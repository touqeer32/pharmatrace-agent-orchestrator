ALTER TABLE compliance_reports
  ADD COLUMN creator_id UUID,
  ADD COLUMN creator_name VARCHAR(200),
  ADD COLUMN creator_public_key TEXT;

CREATE INDEX idx_compliance_reports_creator
  ON compliance_reports (tenant_id, creator_id, created_at DESC);

