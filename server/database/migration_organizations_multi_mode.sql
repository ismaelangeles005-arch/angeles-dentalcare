CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  organization_type TEXT NOT NULL DEFAULT 'CLINIC'
    CHECK (organization_type IN ('INDEPENDENT', 'CLINIC')),
  owner_user_id UUID REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_default_name
  ON organizations (LOWER(name));

INSERT INTO organizations (name, organization_type)
SELECT 'Angeles DentalCare',
       CASE
         WHEN (SELECT COUNT(*) FROM doctors WHERE active = true) <= 1 THEN 'INDEPENDENT'
         ELSE 'CLINIC'
       END
WHERE NOT EXISTS (
  SELECT 1 FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare')
);

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE clinical_notes ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE patient_visits ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE patient_files ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE doctor_availability ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE procedure_catalog ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE billing_estimates ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE doctors SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE users SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE patients SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE appointments SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE clinical_notes SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE patient_visits SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE notifications SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE patient_files SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE audit_logs SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE doctor_availability SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE procedure_catalog SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE billing_estimates SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

UPDATE billing_payments bp
SET organization_id = e.organization_id
FROM billing_estimates e
WHERE bp.estimate_id = e.id AND bp.organization_id IS NULL;

WITH default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE billing_payments SET organization_id = (SELECT id FROM default_org) WHERE organization_id IS NULL;

WITH owner_candidate AS (
  SELECT id
  FROM users
  WHERE role IN ('head_admin', 'admin') AND deleted_at IS NULL
  ORDER BY CASE role WHEN 'head_admin' THEN 1 ELSE 2 END, created_at
  LIMIT 1
), default_org AS (
  SELECT id FROM organizations WHERE LOWER(name) = LOWER('Angeles DentalCare') ORDER BY created_at LIMIT 1
)
UPDATE organizations o
SET owner_user_id = COALESCE(o.owner_user_id, (SELECT id FROM owner_candidate)), updated_at = NOW()
WHERE o.id = (SELECT id FROM default_org);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'head_admin',
  'admin',
  'doctor',
  'recepcion',
  'owner_doctor',
  'clinic_admin',
  'receptionist',
  'independent_assistant',
  'assistant',
  'cashier'
));

CREATE INDEX IF NOT EXISTS idx_users_organization ON users (organization_id, role) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_doctors_organization ON doctors (organization_id, active);
CREATE INDEX IF NOT EXISTS idx_patients_organization ON patients (organization_id, full_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_organization_date ON appointments (organization_id, appointment_date, appointment_time) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_notes_organization ON clinical_notes (organization_id, patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_files_organization ON patient_files (organization_id, patient_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_estimates_organization ON billing_estimates (organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_payments_organization ON billing_payments (organization_id, paid_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_organization ON audit_logs (organization_id, created_at DESC);
