ALTER TABLE billing_estimate_items
  ADD COLUMN IF NOT EXISTS gross_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gross_total >= 0),
  ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0);

UPDATE billing_estimate_items
SET gross_total = total + discount
WHERE gross_total = 0;

CREATE TABLE IF NOT EXISTS billing_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID NOT NULL REFERENCES billing_estimates(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'efectivo',
  note TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_billing_payments_estimate ON billing_payments (estimate_id, paid_at DESC) WHERE deleted_at IS NULL;

INSERT INTO billing_payments (estimate_id, amount, method, note, paid_at, received_by)
SELECT e.id, e.paid, 'registro_inicial', 'Pago inicial registrado antes del historial detallado', e.created_at, e.created_by
FROM billing_estimates e
WHERE e.deleted_at IS NULL
  AND e.paid > 0
  AND NOT EXISTS (
    SELECT 1 FROM billing_payments bp WHERE bp.estimate_id = e.id AND bp.deleted_at IS NULL
  );
