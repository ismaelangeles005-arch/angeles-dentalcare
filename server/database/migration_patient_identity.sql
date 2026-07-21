ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS national_id TEXT,
  ADD COLUMN IF NOT EXISTS patient_code TEXT;

UPDATE patients
SET patient_code = 'PAC-' || UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 8))
WHERE patient_code IS NULL OR patient_code = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_national_id_active
  ON patients (national_id)
  WHERE national_id IS NOT NULL AND national_id <> '' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_patient_code_active
  ON patients (patient_code)
  WHERE patient_code IS NOT NULL AND patient_code <> '' AND deleted_at IS NULL;
