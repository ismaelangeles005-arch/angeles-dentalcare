ALTER TABLE clinical_notes
  ADD COLUMN IF NOT EXISTS note_type TEXT NOT NULL DEFAULT 'evolucion'
    CHECK (note_type IN ('consulta_ambulatoria', 'procedimiento', 'evolucion')),
  ADD COLUMN IF NOT EXISTS consultation_status TEXT
    CHECK (consultation_status IS NULL OR consultation_status IN ('en_espera', 'en_consulta', 'atendido', 'finalizado')),
  ADD COLUMN IF NOT EXISTS chief_complaint TEXT,
  ADD COLUMN IF NOT EXISTS clinical_evaluation TEXT,
  ADD COLUMN IF NOT EXISTS odontological_diagnosis TEXT,
  ADD COLUMN IF NOT EXISTS performed_procedures TEXT,
  ADD COLUMN IF NOT EXISTS indications TEXT,
  ADD COLUMN IF NOT EXISTS observations TEXT,
  ADD COLUMN IF NOT EXISTS next_appointment_date DATE,
  ADD COLUMN IF NOT EXISTS next_appointment_time TIME,
  ADD COLUMN IF NOT EXISTS general_status TEXT,
  ADD COLUMN IF NOT EXISTS clinical_findings TEXT,
  ADD COLUMN IF NOT EXISTS evolution TEXT,
  ADD COLUMN IF NOT EXISTS medications TEXT,
  ADD COLUMN IF NOT EXISTS procedure_status TEXT
    CHECK (procedure_status IS NULL OR procedure_status IN ('pendiente', 'programado', 'realizado', 'cancelado')),
  ADD COLUMN IF NOT EXISTS tooth_number TEXT,
  ADD COLUMN IF NOT EXISTS clinical_description TEXT,
  ADD COLUMN IF NOT EXISTS material_used TEXT,
  ADD COLUMN IF NOT EXISTS next_review_date DATE;

UPDATE clinical_notes
SET odontological_diagnosis = diagnosis
WHERE odontological_diagnosis IS NULL AND diagnosis IS NOT NULL;

UPDATE clinical_notes
SET indications = prescription
WHERE indications IS NULL AND prescription IS NOT NULL;

UPDATE clinical_notes
SET evolution = note
WHERE evolution IS NULL AND note IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_notes_type_patient
  ON clinical_notes (patient_id, note_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_notes_procedure_status
  ON clinical_notes (procedure_status, created_at DESC)
  WHERE procedure_status IS NOT NULL;
