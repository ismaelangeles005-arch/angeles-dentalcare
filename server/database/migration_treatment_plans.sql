CREATE TABLE IF NOT EXISTS treatment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PRESENTED', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED',
    'POSTPONED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
  )),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treatment_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treatment_plan_id UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE NO ACTION,
  procedure_id UUID REFERENCES procedure_catalog(id) ON DELETE SET NULL,
  odontogram_entry_id UUID REFERENCES odontogram_entries(id) ON DELETE SET NULL,
  tooth_id TEXT CHECK (tooth_id IS NULL OR tooth_id ~
    '^PERMANENT_(UPPER|LOWER)_(RIGHT|LEFT)_(THIRD_MOLAR|SECOND_MOLAR|FIRST_MOLAR|SECOND_PREMOLAR|FIRST_PREMOLAR|CANINE|LATERAL_INCISOR|CENTRAL_INCISOR)$'),
  surface TEXT CHECK (surface IS NULL OR surface IN (
    'MESIAL', 'DISTAL', 'BUCCAL', 'LINGUAL', 'PALATAL', 'OCCLUSAL', 'INCISAL'
  )),
  procedure_name_snapshot TEXT NOT NULL CHECK (btrim(procedure_name_snapshot) <> ''),
  procedure_area_snapshot TEXT,
  unit_price_snapshot NUMERIC(12,2) NOT NULL CHECK (unit_price_snapshot BETWEEN 0 AND 9999999999.99),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount BETWEEN 0 AND 9999999999.99),
  final_amount NUMERIC(12,2) NOT NULL CHECK (final_amount BETWEEN 0 AND 9999999999.99),
  priority TEXT,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN (
    'PROPOSED', 'ACCEPTED', 'REJECTED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
  )),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (surface IS NULL OR tooth_id IS NOT NULL),
  CHECK (discount_amount <= unit_price_snapshot * quantity),
  CHECK (final_amount = unit_price_snapshot * quantity - discount_amount)
);

CREATE INDEX IF NOT EXISTS idx_treatment_plans_organization_status
  ON treatment_plans (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_treatment_plans_patient_created_at
  ON treatment_plans (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_treatment_plan_items_plan
  ON treatment_plan_items (treatment_plan_id);

CREATE INDEX IF NOT EXISTS idx_treatment_plan_items_odontogram
  ON treatment_plan_items (odontogram_entry_id)
  WHERE odontogram_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_treatment_plan_items_procedure
  ON treatment_plan_items (procedure_id)
  WHERE procedure_id IS NOT NULL;
