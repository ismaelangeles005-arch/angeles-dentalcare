ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS default_tooth_numbering_system TEXT NOT NULL DEFAULT 'FDI'
    CHECK (default_tooth_numbering_system IN ('FDI', 'UNIVERSAL'));

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS patient_type TEXT NOT NULL DEFAULT 'regular'
    CHECK (patient_type IN ('regular', 'ambulatory')),
  ADD COLUMN IF NOT EXISTS operational_classification TEXT NOT NULL DEFAULT 'sin_clasificacion'
    CHECK (operational_classification IN (
      'cumplido',
      'impuntual',
      'ausencias_frecuentes',
      'requiere_confirmacion',
      'incumplimiento_indicaciones',
      'documentacion_pendiente',
      'sin_clasificacion'
    )),
  ADD COLUMN IF NOT EXISTS operational_classification_observation TEXT,
  ADD COLUMN IF NOT EXISTS operational_classification_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operational_classification_by UUID REFERENCES users(id);

CREATE TABLE IF NOT EXISTS patient_classification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (classification IN (
    'cumplido',
    'impuntual',
    'ausencias_frecuentes',
    'requiere_confirmacion',
    'incumplimiento_indicaciones',
    'documentacion_pendiente',
    'sin_clasificacion'
  )),
  observation TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patient_medical_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  condition_key TEXT NOT NULL,
  condition_label TEXT NOT NULL,
  observation TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS dental_area TEXT,
  ADD COLUMN IF NOT EXISTS tooth_count_mode TEXT,
  ADD COLUMN IF NOT EXISTS tooth_numbering_system TEXT NOT NULL DEFAULT 'FDI'
    CHECK (tooth_numbering_system IN ('FDI', 'UNIVERSAL')),
  ADD COLUMN IF NOT EXISTS tooth_selections JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE clinical_notes
  ADD COLUMN IF NOT EXISTS dental_area TEXT,
  ADD COLUMN IF NOT EXISTS tooth_count_mode TEXT,
  ADD COLUMN IF NOT EXISTS tooth_numbering_system TEXT NOT NULL DEFAULT 'FDI'
    CHECK (tooth_numbering_system IN ('FDI', 'UNIVERSAL')),
  ADD COLUMN IF NOT EXISTS tooth_selections JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pharmacotherapy JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_patient_classification_history_patient
  ON patient_classification_history (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_medical_conditions_patient
  ON patient_medical_conditions (patient_id, active);

CREATE INDEX IF NOT EXISTS idx_appointments_dental_area
  ON appointments (organization_id, dental_area, appointment_date)
  WHERE deleted_at IS NULL;
