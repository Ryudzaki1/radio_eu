CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_charge_id
  ON payments (provider, provider_charge_id)
  WHERE provider_charge_id IS NOT NULL;
