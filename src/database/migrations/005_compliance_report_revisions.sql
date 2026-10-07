ALTER TABLE compliance_reports
  ADD COLUMN supersedes_report_id UUID REFERENCES compliance_reports (id) ON DELETE SET NULL,
  ADD COLUMN revision_reason TEXT;

CREATE INDEX idx_compliance_reports_supersedes
  ON compliance_reports (supersedes_report_id);

