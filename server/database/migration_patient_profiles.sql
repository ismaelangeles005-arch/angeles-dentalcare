ALTER TABLE patients
  ALTER COLUMN procedure_name DROP NOT NULL,
  ALTER COLUMN appointment_date DROP NOT NULL,
  ALTER COLUMN appointment_time DROP NOT NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id),
  ADD COLUMN IF NOT EXISTS appointment_timezone TEXT NOT NULL DEFAULT 'America/Santo_Domingo';

ALTER TABLE appointments
  ALTER COLUMN patient_name DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_patient
  ON appointments (patient_id)
  WHERE deleted_at IS NULL;
