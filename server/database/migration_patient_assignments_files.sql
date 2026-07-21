ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patient_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name TEXT UNIQUE NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  category TEXT NOT NULL DEFAULT 'otro'
    CHECK (category IN ('radiografia', 'fotografia', 'documento', 'otro')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patient_files_patient
  ON patient_files (patient_id, created_at DESC)
  WHERE deleted_at IS NULL;

DELETE FROM notifications n
WHERE n.entity_type = 'patient'
  AND NOT EXISTS (
    SELECT 1
    FROM patients p
    WHERE p.id = n.entity_id AND p.deleted_at IS NULL
  );
