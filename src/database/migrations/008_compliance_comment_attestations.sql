ALTER TABLE compliance_attestations
  ADD COLUMN IF NOT EXISTS action_event_id UUID
    REFERENCES compliance_action_events (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_compliance_attestations_action_event
  ON compliance_attestations (action_event_id)
  WHERE action_event_id IS NOT NULL;
