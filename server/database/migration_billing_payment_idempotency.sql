BEGIN;

-- One receipt protects the whole operation, including estimate + initial payment.
-- Existing payments need no key or backfill and are not modified.
CREATE TABLE IF NOT EXISTS billing_payment_operations (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  estimate_id UUID REFERENCES billing_estimates(id),
  response_status INTEGER CHECK (response_status IN (200, 201)),
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, idempotency_key),
  CHECK (
    (estimate_id IS NULL AND response_status IS NULL AND response_body IS NULL)
    OR (estimate_id IS NOT NULL AND response_status IS NOT NULL AND response_body IS NOT NULL)
  )
);

COMMIT;
