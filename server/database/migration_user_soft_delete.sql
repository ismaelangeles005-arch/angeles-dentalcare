ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_active_visible
  ON users (role, full_name)
  WHERE deleted_at IS NULL;
