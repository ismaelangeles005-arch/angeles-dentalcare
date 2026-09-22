CREATE TABLE IF NOT EXISTS odontogram_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE NO ACTION,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  tooth_id TEXT NOT NULL,
  surface TEXT
    CHECK (surface IS NULL OR surface IN (
      'MESIAL',
      'DISTAL',
      'BUCCAL',
      'LINGUAL',
      'PALATAL',
      'OCCLUSAL',
      'INCISAL'
    )),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'EXISTING_CONDITION',
    'DIAGNOSIS',
    'PROPOSED_TREATMENT',
    'COMPLETED_TREATMENT'
  )),
  condition_code TEXT NOT NULL,
  condition_label TEXT NOT NULL,
  procedure_id UUID REFERENCES procedure_catalog(id) ON DELETE SET NULL,
  related_entry_id UUID NULL REFERENCES odontogram_entries(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
    'ACTIVE',
    'RESOLVED',
    'SUPERSEDED',
    'VOIDED'
  )),
  notes TEXT,
  doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE NO ACTION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_clinical_note_id UUID REFERENCES clinical_notes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_patient
  ON odontogram_entries (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_patient_tooth
  ON odontogram_entries (patient_id, tooth_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_procedure
  ON odontogram_entries (procedure_id)
  WHERE procedure_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_related_entry
  ON odontogram_entries (related_entry_id)
  WHERE related_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_created_at
  ON odontogram_entries (created_at DESC);
