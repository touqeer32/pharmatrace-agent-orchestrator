CREATE TABLE compliance_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_type VARCHAR(120) NOT NULL,
  source_run_id UUID REFERENCES agent_runs (id) ON DELETE SET NULL,
  profile_id UUID,
  report_version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(40) NOT NULL DEFAULT 'PENDING_REVIEW',
  result_status VARCHAR(20) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'INFO',
  rule_set_version VARCHAR(80) NOT NULL,
  issue_fingerprint VARCHAR(128),
  source_data_digest VARCHAR(128),
  report_digest VARCHAR(128) NOT NULL,
  evidence_digest VARCHAR(128),
  summary TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_by UUID,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_compliance_report_status CHECK (status IN (
    'REPORT_READY', 'PENDING_REVIEW', 'APPROVED', 'APPROVED_WITH_OVERRIDE',
    'REJECTED', 'READY_FOR_WALLET', 'SUBMITTED', 'WAITING_FOR_CONFIRMATION',
    'ATTESTED', 'VERIFICATION_FAILED', 'ANALYSIS_FAILED'
  )),
  CONSTRAINT chk_compliance_result_status CHECK (result_status IN ('PASS', 'FAIL', 'REVIEW')),
  CONSTRAINT chk_compliance_severity CHECK (severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT chk_compliance_report_version CHECK (report_version > 0)
);

CREATE INDEX idx_compliance_reports_tenant_created
  ON compliance_reports (tenant_id, created_at DESC);
CREATE INDEX idx_compliance_reports_tenant_status
  ON compliance_reports (tenant_id, status, created_at DESC);
CREATE INDEX idx_compliance_reports_tenant_agent
  ON compliance_reports (tenant_id, agent_type, created_at DESC);
CREATE INDEX idx_compliance_reports_issue_fingerprint
  ON compliance_reports (tenant_id, issue_fingerprint)
  WHERE issue_fingerprint IS NOT NULL;

CREATE TABLE compliance_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES compliance_reports (id) ON DELETE CASCADE,
  rule_id VARCHAR(160) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
  severity VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  title VARCHAR(300) NOT NULL,
  comment TEXT,
  recommendation TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_to UUID,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_compliance_finding_status CHECK (status IN (
    'OPEN', 'ACKNOWLEDGED', 'REMEDIATION_IN_PROGRESS', 'RESOLVED',
    'OVERRIDDEN', 'CLOSED_NO_ACTION'
  )),
  CONSTRAINT chk_compliance_finding_severity CHECK (severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
);

CREATE INDEX idx_compliance_findings_report ON compliance_findings (report_id, created_at);
CREATE INDEX idx_compliance_findings_tenant_status ON compliance_findings (tenant_id, status, created_at DESC);

CREATE TABLE compliance_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES compliance_reports (id) ON DELETE CASCADE,
  finding_id UUID REFERENCES compliance_findings (id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL,
  action_status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED',
  actor_id UUID NOT NULL,
  comment TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(180),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_compliance_action_status CHECK (action_status IN ('REQUESTED', 'COMPLETED', 'FAILED'))
);

CREATE INDEX idx_compliance_actions_report ON compliance_action_events (report_id, created_at DESC);
CREATE UNIQUE INDEX uq_compliance_action_idempotency
  ON compliance_action_events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE compliance_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES compliance_reports (id) ON DELETE CASCADE,
  report_version INTEGER NOT NULL,
  decision VARCHAR(35) NOT NULL,
  actor_id UUID NOT NULL,
  comment TEXT,
  decision_digest VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_compliance_decision CHECK (decision IN ('APPROVED', 'APPROVED_WITH_OVERRIDE', 'REJECTED'))
);

CREATE INDEX idx_compliance_decisions_report ON compliance_decisions (report_id, created_at DESC);

CREATE TABLE compliance_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES compliance_reports (id) ON DELETE CASCADE,
  attestation_type VARCHAR(40) NOT NULL,
  status VARCHAR(35) NOT NULL DEFAULT 'PREPARED',
  payload_digest VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  topic_id VARCHAR(80),
  transaction_id VARCHAR(160),
  sequence_number VARCHAR(80),
  consensus_timestamp VARCHAR(80),
  last_error TEXT,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT chk_compliance_attestation_type CHECK (attestation_type IN ('REPORT_CREATED', 'DECISION')),
  CONSTRAINT chk_compliance_attestation_status CHECK (status IN (
    'PREPARED', 'SUBMITTED', 'WAITING_FOR_CONFIRMATION', 'CONFIRMED', 'FAILED'
  ))
);

CREATE INDEX idx_compliance_attestations_report ON compliance_attestations (report_id, prepared_at DESC);
