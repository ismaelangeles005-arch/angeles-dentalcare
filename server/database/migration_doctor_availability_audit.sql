CREATE TABLE IF NOT EXISTS doctor_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  work_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('libre', 'limitado')),
  max_patients INTEGER CHECK (max_patients IS NULL OR max_patients BETWEEN 1 AND 50),
  note TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT doctor_availability_limit_required
    CHECK (status <> 'limitado' OR max_patients IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_availability_active_day
  ON doctor_availability (doctor_id, work_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_doctor_availability_day
  ON doctor_availability (work_date, doctor_id)
  WHERE deleted_at IS NULL;
