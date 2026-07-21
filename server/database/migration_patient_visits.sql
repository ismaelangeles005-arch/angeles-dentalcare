CREATE TABLE IF NOT EXISTS patient_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  visit_type TEXT NOT NULL DEFAULT 'unica' CHECK (visit_type IN ('unica', 'seguimiento')),
  note TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_visits_patient
  ON patient_visits (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_visits_doctor_day
  ON patient_visits (doctor_id, created_at DESC);
