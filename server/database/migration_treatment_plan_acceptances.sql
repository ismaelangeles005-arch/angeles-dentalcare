CREATE TABLE IF NOT EXISTS treatment_plan_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
  treatment_plan_id UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE NO ACTION,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  accepted_by_name TEXT NOT NULL CHECK (btrim(accepted_by_name) <> ''),
  signature_data TEXT NOT NULL CHECK (signature_data LIKE 'data:image/png;base64,%' AND octet_length(signature_data) <= 350000),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  plan_status_snapshot TEXT NOT NULL CHECK (plan_status_snapshot IN (
    'PRESENTED', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED'
  )),
  total_snapshot NUMERIC(20,2) NOT NULL CHECK (total_snapshot BETWEEN 0 AND 999999999999999999.99),
  accepted_total_snapshot NUMERIC(20,2) NOT NULL CHECK (accepted_total_snapshot BETWEEN 0 AND total_snapshot),
  items_snapshot JSONB NOT NULL CHECK (jsonb_typeof(items_snapshot) = 'array' AND jsonb_array_length(items_snapshot) > 0)
);

CREATE INDEX IF NOT EXISTS idx_treatment_plan_acceptances_plan
  ON treatment_plan_acceptances (organization_id, treatment_plan_id, accepted_at DESC);
