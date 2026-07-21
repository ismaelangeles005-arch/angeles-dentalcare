ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('head_admin', 'admin', 'doctor', 'recepcion'));

UPDATE users
SET role = 'head_admin', updated_at = NOW()
WHERE username = 'admin';
