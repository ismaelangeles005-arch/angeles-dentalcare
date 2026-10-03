BEGIN;

-- Distribution only: received money remains in billing_payments. No backfill.
CREATE TABLE IF NOT EXISTS billing_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL REFERENCES billing_payments(id) ON DELETE RESTRICT,
  billing_estimate_item_id UUID NOT NULL REFERENCES billing_estimate_items(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_allocations_payment
  ON billing_payment_allocations (organization_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_billing_allocations_item
  ON billing_payment_allocations (organization_id, billing_estimate_item_id);

-- One immutable, total reversal per allocation; the original amount never changes.
CREATE TABLE IF NOT EXISTS billing_payment_allocation_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  allocation_id UUID NOT NULL UNIQUE REFERENCES billing_payment_allocations(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_allocation_reversals_organization
  ON billing_payment_allocation_reversals (organization_id);

-- Separate namespace from payment operation keys, shared by allocate/reverse.
CREATE TABLE IF NOT EXISTS billing_allocation_operations (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  estimate_id UUID REFERENCES billing_estimates(id) ON DELETE RESTRICT,
  response_status INTEGER CHECK (response_status = 201),
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, idempotency_key),
  CHECK (
    (estimate_id IS NULL AND response_status IS NULL AND response_body IS NULL)
    OR (estimate_id IS NOT NULL AND response_status IS NOT NULL AND response_body IS NOT NULL)
  )
);

COMMIT;
