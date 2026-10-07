ALTER TABLE compliance_attestations
  ADD COLUMN IF NOT EXISTS payer_account_id VARCHAR(80),
  ADD COLUMN IF NOT EXISTS prepared_transaction_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS wallet_transaction_bytes TEXT;

CREATE INDEX IF NOT EXISTS idx_compliance_attestations_action_status
  ON compliance_attestations (action_event_id, status)
  WHERE action_event_id IS NOT NULL;
