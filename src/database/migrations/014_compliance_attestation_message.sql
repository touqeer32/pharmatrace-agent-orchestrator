ALTER TABLE compliance_attestations
  ADD COLUMN IF NOT EXISTS message TEXT;
