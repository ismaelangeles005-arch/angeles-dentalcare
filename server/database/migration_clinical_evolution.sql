ALTER TABLE clinical_notes
  ADD COLUMN IF NOT EXISTS appointment_id UUID REFERENCES appointments(id),
  ADD COLUMN IF NOT EXISTS procedure_name TEXT,
  ADD COLUMN IF NOT EXISTS diagnosis TEXT,
  ADD COLUMN IF NOT EXISTS treatment TEXT,
  ADD COLUMN IF NOT EXISTS prescription TEXT,
  ADD COLUMN IF NOT EXISTS next_steps TEXT;

CREATE INDEX IF NOT EXISTS idx_clinical_notes_patient
  ON clinical_notes (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_notes_appointment
  ON clinical_notes (appointment_id);
