BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role = ANY (ARRAY['head_admin'::text,'admin'::text,'doctor'::text,'recepcion'::text,'owner_doctor'::text,'clinic_admin'::text,'receptionist'::text,'independent_assistant'::text,'assistant'::text,'cashier'::text,'PLATFORM_SUPER_ADMIN'::text]));

ALTER TABLE users ADD CONSTRAINT users_platform_tenant_scope_check CHECK ((role = 'PLATFORM_SUPER_ADMIN' AND organization_id IS NULL) OR (role <> 'PLATFORM_SUPER_ADMIN' AND organization_id IS NOT NULL));

COMMIT;


