ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS appointment_duration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (appointment_duration_minutes IN (15, 30, 45, 60, 90, 120));

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS allergies TEXT,
  ADD COLUMN IF NOT EXISTS medical_history TEXT,
  ADD COLUMN IF NOT EXISTS current_medications TEXT,
  ADD COLUMN IF NOT EXISTS diagnosis TEXT,
  ADD COLUMN IF NOT EXISTS treatment_plan TEXT;
