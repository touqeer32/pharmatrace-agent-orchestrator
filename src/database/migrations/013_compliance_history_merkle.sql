CREATE TABLE IF NOT EXISTS compliance_report_history_leaves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES compliance_reports (id) ON DELETE CASCADE,
  report_version INTEGER NOT NULL,
  leaf_index INTEGER NOT NULL,
  leaf_type VARCHAR(30) NOT NULL,
  source_id UUID,
  leaf_hash VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  merkle_proof JSONB NOT NULL DEFAULT '[]'::jsonb,
  history_merkle_root VARCHAR(64) NOT NULL,
  finding_state_root VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_id, leaf_index)
);

CREATE INDEX IF NOT EXISTS idx_compliance_history_leaves_report
  ON compliance_report_history_leaves (tenant_id, report_id, leaf_index);
