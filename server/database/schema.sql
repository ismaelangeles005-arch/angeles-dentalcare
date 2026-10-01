CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  organization_type TEXT NOT NULL DEFAULT 'CLINIC'
    CHECK (organization_type IN ('INDEPENDENT', 'CLINIC')),
  owner_user_id UUID,
  default_tooth_numbering_system TEXT NOT NULL DEFAULT 'FDI'
    CHECK (default_tooth_numbering_system IN ('FDI', 'UNIVERSAL')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_default_name
  ON organizations (LOWER(name));

CREATE TABLE IF NOT EXISTS doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  name TEXT UNIQUE NOT NULL,
  specialty TEXT,
  phone TEXT,
  email TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  organization_id UUID REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('head_admin', 'admin', 'doctor', 'recepcion', 'owner_doctor', 'clinic_admin', 'receptionist', 'independent_assistant', 'assistant', 'cashier', 'PLATFORM_SUPER_ADMIN')),
  full_name TEXT NOT NULL,
  national_id TEXT,
  patient_code TEXT,
  doctor_id UUID REFERENCES doctors(id),
  pin_hash TEXT,
  pin_lookup_hash TEXT,
  pin_enabled BOOLEAN NOT NULL DEFAULT false,
  failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_platform_tenant_scope_check CHECK (
    (role = 'PLATFORM_SUPER_ADMIN' AND organization_id IS NULL)
    OR
    (role <> 'PLATFORM_SUPER_ADMIN' AND organization_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  full_name TEXT NOT NULL,
  national_id TEXT,
  patient_code TEXT,
  doctor_id UUID REFERENCES doctors(id),
  assigned_by UUID REFERENCES users(id),
  assigned_at TIMESTAMPTZ,
  procedure_name TEXT,
  appointment_date DATE,
  appointment_time TIME,
  status TEXT NOT NULL DEFAULT 'Pendiente'
    CHECK (status IN ('Pendiente', 'Confirmada', 'Completada', 'Cancelada')),
  phone TEXT,
  email TEXT,
  notes TEXT,
  allergies TEXT,
  medical_history TEXT,
  current_medications TEXT,
  diagnosis TEXT,
  treatment_plan TEXT,
  patient_type TEXT NOT NULL DEFAULT 'regular'
    CHECK (patient_type IN ('regular', 'ambulatory')),
  operational_classification TEXT NOT NULL DEFAULT 'sin_clasificacion'
    CHECK (operational_classification IN ('cumplido', 'impuntual', 'ausencias_frecuentes', 'requiere_confirmacion', 'incumplimiento_indicaciones', 'documentacion_pendiente', 'sin_clasificacion')),
  operational_classification_observation TEXT,
  operational_classification_at TIMESTAMPTZ,
  operational_classification_by UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  patient_id UUID REFERENCES patients(id),
  patient_name TEXT,
  doctor_id UUID REFERENCES doctors(id),
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  appointment_duration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (appointment_duration_minutes IN (15, 30, 45, 60, 90, 120)),
  appointment_timezone TEXT NOT NULL DEFAULT 'America/Santo_Domingo',
  status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'confirmada', 'en_consulta', 'completada', 'cancelada', 'no_asistio', 'reprogramada')),
  reason TEXT,
  procedure_category TEXT,
  procedure_name TEXT,
  dental_area TEXT,
  tooth_number TEXT,
  tooth_count_mode TEXT,
  tooth_numbering_system TEXT NOT NULL DEFAULT 'FDI'
    CHECK (tooth_numbering_system IN ('FDI', 'UNIVERSAL')),
  tooth_selections JSONB NOT NULL DEFAULT '[]'::jsonb,
  clinical_detail TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clinical_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  patient_id UUID NOT NULL REFERENCES patients(id),
  appointment_id UUID REFERENCES appointments(id),
  doctor_id UUID REFERENCES doctors(id),
  note_type TEXT NOT NULL DEFAULT 'evolucion'
    CHECK (note_type IN ('consulta_ambulatoria', 'procedimiento', 'evolucion')),
  consultation_status TEXT
    CHECK (consultation_status IS NULL OR consultation_status IN ('en_espera', 'en_consulta', 'atendido', 'finalizado')),
  procedure_name TEXT,
  procedure_status TEXT
    CHECK (procedure_status IS NULL OR procedure_status IN ('pendiente', 'programado', 'realizado', 'cancelado')),
  dental_area TEXT,
  tooth_number TEXT,
  tooth_count_mode TEXT,
  tooth_numbering_system TEXT NOT NULL DEFAULT 'FDI'
    CHECK (tooth_numbering_system IN ('FDI', 'UNIVERSAL')),
  tooth_selections JSONB NOT NULL DEFAULT '[]'::jsonb,
  diagnosis TEXT,
  odontological_diagnosis TEXT,
  treatment TEXT,
  prescription TEXT,
  pharmacotherapy JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_steps TEXT,
  chief_complaint TEXT,
  clinical_evaluation TEXT,
  performed_procedures TEXT,
  indications TEXT,
  observations TEXT,
  next_appointment_date DATE,
  next_appointment_time TIME,
  general_status TEXT,
  clinical_findings TEXT,
  evolution TEXT,
  medications TEXT,
  clinical_description TEXT,
  material_used TEXT,
  next_review_date DATE,
  note TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS procedure_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  category_key TEXT NOT NULL,
  category_name TEXT NOT NULL,
  name TEXT NOT NULL,
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (base_price >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes IN (15, 30, 45, 60, 90, 120)),
  requires_tooth BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_procedure_catalog_org_category_name
    ON procedure_catalog (organization_id, category_key, name)
    WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS odontogram_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE NO ACTION,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  tooth_id TEXT NOT NULL,
  surface TEXT
    CHECK (surface IS NULL OR surface IN (
      'MESIAL',
      'DISTAL',
      'BUCCAL',
      'LINGUAL',
      'PALATAL',
      'OCCLUSAL',
      'INCISAL'
    )),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'EXISTING_CONDITION',
    'DIAGNOSIS',
    'PROPOSED_TREATMENT',
    'COMPLETED_TREATMENT'
  )),
  condition_code TEXT NOT NULL,
  condition_label TEXT NOT NULL,
  procedure_id UUID REFERENCES procedure_catalog(id) ON DELETE SET NULL,
  related_entry_id UUID NULL REFERENCES odontogram_entries(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
    'ACTIVE',
    'RESOLVED',
    'SUPERSEDED',
    'VOIDED'
  )),
  notes TEXT,
  doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE NO ACTION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_clinical_note_id UUID REFERENCES clinical_notes(id) ON DELETE SET NULL
);


CREATE TABLE IF NOT EXISTS treatment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PRESENTED', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED',
    'POSTPONED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
  )),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treatment_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treatment_plan_id UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE NO ACTION,
  procedure_id UUID REFERENCES procedure_catalog(id) ON DELETE SET NULL,
  odontogram_entry_id UUID REFERENCES odontogram_entries(id) ON DELETE SET NULL,
  tooth_id TEXT CHECK (tooth_id IS NULL OR tooth_id ~
    '^(PERMANENT_(UPPER|LOWER)_(RIGHT|LEFT)_(THIRD_MOLAR|SECOND_MOLAR|FIRST_MOLAR|SECOND_PREMOLAR|FIRST_PREMOLAR|CANINE|LATERAL_INCISOR|CENTRAL_INCISOR)|PRIMARY_(UPPER|LOWER)_(RIGHT|LEFT)_(SECOND_MOLAR|FIRST_MOLAR|CANINE|LATERAL_INCISOR|CENTRAL_INCISOR))$'),
  surface TEXT CHECK (surface IS NULL OR surface IN (
    'MESIAL', 'DISTAL', 'BUCCAL', 'LINGUAL', 'PALATAL', 'OCCLUSAL', 'INCISAL'
  )),
  procedure_name_snapshot TEXT NOT NULL CHECK (btrim(procedure_name_snapshot) <> ''),
  procedure_area_snapshot TEXT,
  unit_price_snapshot NUMERIC(12,2) NOT NULL CHECK (unit_price_snapshot BETWEEN 0 AND 9999999999.99),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount BETWEEN 0 AND 9999999999.99),
  final_amount NUMERIC(12,2) NOT NULL CHECK (final_amount BETWEEN 0 AND 9999999999.99),
  priority TEXT,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN (
    'PROPOSED', 'ACCEPTED', 'REJECTED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
  )),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (surface IS NULL OR tooth_id IS NOT NULL),
  CHECK (discount_amount <= unit_price_snapshot * quantity),
  CHECK (final_amount = unit_price_snapshot * quantity - discount_amount)
);

CREATE INDEX IF NOT EXISTS idx_treatment_plans_organization_status
  ON treatment_plans (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_treatment_plans_patient_created_at
  ON treatment_plans (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_treatment_plan_items_plan
  ON treatment_plan_items (treatment_plan_id);

CREATE INDEX IF NOT EXISTS idx_treatment_plan_items_odontogram
  ON treatment_plan_items (odontogram_entry_id)
  WHERE odontogram_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_treatment_plan_items_procedure
  ON treatment_plan_items (procedure_id)
  WHERE procedure_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS treatment_plan_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
  treatment_plan_id UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE NO ACTION,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  accepted_by_name TEXT NOT NULL CHECK (btrim(accepted_by_name) <> ''),
  signature_data TEXT NOT NULL CHECK (signature_data LIKE 'data:image/png;base64,%' AND octet_length(signature_data) <= 350000),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  plan_status_snapshot TEXT NOT NULL CHECK (plan_status_snapshot IN (
    'PRESENTED', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED'
  )),
  total_snapshot NUMERIC(20,2) NOT NULL CHECK (total_snapshot BETWEEN 0 AND 999999999999999999.99),
  accepted_total_snapshot NUMERIC(20,2) NOT NULL CHECK (accepted_total_snapshot BETWEEN 0 AND total_snapshot),
  items_snapshot JSONB NOT NULL CHECK (jsonb_typeof(items_snapshot) = 'array' AND jsonb_array_length(items_snapshot) > 0)
);

CREATE INDEX IF NOT EXISTS idx_treatment_plan_acceptances_plan
  ON treatment_plan_acceptances (organization_id, treatment_plan_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS patient_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  visit_type TEXT NOT NULL DEFAULT 'unica' CHECK (visit_type IN ('unica', 'seguimiento')),
  note TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS patient_classification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (classification IN ('cumplido', 'impuntual', 'ausencias_frecuentes', 'requiere_confirmacion', 'incumplimiento_indicaciones', 'documentacion_pendiente', 'sin_clasificacion')),
  observation TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patient_medical_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  condition_key TEXT NOT NULL,
  condition_label TEXT NOT NULL,
  observation TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
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
  organization_id UUID REFERENCES organizations(id),
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doctor_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_national_id_active
  ON patients (national_id)
  WHERE national_id IS NOT NULL AND national_id <> '' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_patient_code_active
  ON patients (patient_code)
  WHERE patient_code IS NOT NULL AND patient_code <> '' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patients_doctor_date
  ON patients (doctor_id, appointment_date, appointment_time)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date
  ON appointments (doctor_id, appointment_date, appointment_time)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_patient
  ON appointments (patient_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patient_visits_patient
  ON patient_visits (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_visits_doctor_day
  ON patient_visits (doctor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patient_files_patient
  ON patient_files (patient_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_notes_patient
  ON clinical_notes (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_notes_appointment
  ON clinical_notes (appointment_id);

CREATE INDEX IF NOT EXISTS idx_clinical_notes_type_patient
  ON clinical_notes (patient_id, note_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_notes_procedure_status
  ON clinical_notes (procedure_status, created_at DESC)
  WHERE procedure_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_patient
  ON odontogram_entries (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_patient_tooth
  ON odontogram_entries (patient_id, tooth_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_procedure
  ON odontogram_entries (procedure_id)
  WHERE procedure_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_related_entry
  ON odontogram_entries (related_entry_id)
  WHERE related_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_odontogram_entries_created_at
  ON odontogram_entries (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_availability_active_day
  ON doctor_availability (doctor_id, work_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_doctor_availability_day
  ON doctor_availability (work_date, doctor_id)
  WHERE deleted_at IS NULL;










CREATE INDEX IF NOT EXISTS idx_users_organization ON users (organization_id, role) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_doctors_organization ON doctors (organization_id, active);
CREATE INDEX IF NOT EXISTS idx_patients_organization ON patients (organization_id, full_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_organization_date ON appointments (organization_id, appointment_date, appointment_time) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_notes_organization ON clinical_notes (organization_id, patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_files_organization ON patient_files (organization_id, patient_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_organization ON audit_logs (organization_id, created_at DESC);


CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_pin_lookup_active
  ON users (organization_id, pin_lookup_hash)
  WHERE pin_lookup_hash IS NOT NULL AND pin_enabled = true AND active = true AND deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_patient_classification_history_patient
  ON patient_classification_history (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_medical_conditions_patient
  ON patient_medical_conditions (patient_id, active);

