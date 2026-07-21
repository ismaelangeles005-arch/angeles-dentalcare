CREATE TABLE IF NOT EXISTS procedure_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key TEXT NOT NULL,
  category_name TEXT NOT NULL,
  name TEXT NOT NULL,
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (base_price >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes IN (15, 30, 45, 60, 90, 120)),
  requires_tooth BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (category_key, name)
);

CREATE TABLE IF NOT EXISTS billing_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES patients(id),
  patient_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'aprobado', 'pagado', 'cancelado')),
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid >= 0),
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS billing_estimate_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID NOT NULL REFERENCES billing_estimates(id) ON DELETE CASCADE,
  procedure_id UUID REFERENCES procedure_catalog(id),
  description TEXT NOT NULL,
  tooth_number TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0)
);

CREATE INDEX IF NOT EXISTS idx_procedure_catalog_active ON procedure_catalog (active, category_key, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_estimates_patient ON billing_estimates (patient_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_estimates_status ON billing_estimates (status, created_at DESC) WHERE deleted_at IS NULL;

INSERT INTO procedure_catalog (category_key, category_name, name, base_price, duration_minutes, requires_tooth)
VALUES
('evaluacion', 'Evaluacion y diagnostico', 'Consulta inicial', 1000, 30, false),
('evaluacion', 'Evaluacion y diagnostico', 'Evaluacion de urgencia', 1500, 30, false),
('evaluacion', 'Evaluacion y diagnostico', 'Revision de radiografias', 800, 15, false),
('evaluacion', 'Evaluacion y diagnostico', 'Plan de tratamiento', 1200, 30, false),
('prevencion', 'Prevencion', 'Profilaxis dental', 1800, 45, false),
('prevencion', 'Prevencion', 'Aplicacion de fluor', 900, 30, false),
('prevencion', 'Prevencion', 'Sellante de fosas y fisuras', 1200, 30, true),
('caries', 'Caries', 'Evaluacion de caries', 1000, 30, true),
('caries', 'Caries', 'Eliminacion de caries', 2200, 45, true),
('caries', 'Caries', 'Restauracion por caries', 2800, 60, true),
('restauracion', 'Odontologia restauradora', 'Resina compuesta', 2800, 60, true),
('restauracion', 'Odontologia restauradora', 'Incrustacion dental', 6500, 90, true),
('endodoncia', 'Endodoncia', 'Tratamiento de conducto', 8500, 90, true),
('extraccion', 'Extraccion', 'Extraccion simple', 2500, 45, true),
('extraccion', 'Extraccion', 'Extraccion quirurgica', 6500, 90, true),
('ortodoncia', 'Ortodoncia', 'Evaluacion ortodontica', 1500, 30, false),
('ortodoncia', 'Ortodoncia', 'Colocacion de brackets', 25000, 120, false),
('ortodoncia', 'Ortodoncia', 'Control y ajuste de ortodoncia', 1800, 30, false),
('periodoncia', 'Periodoncia', 'Raspado y alisado radicular', 3500, 60, true),
('protesis', 'Protesis y rehabilitacion', 'Corona dental', 16000, 90, true),
('protesis', 'Protesis y rehabilitacion', 'Protesis parcial', 22000, 120, false),
('cirugia', 'Cirugia oral', 'Implante dental', 45000, 120, true),
('estetica', 'Estetica dental', 'Blanqueamiento dental', 8500, 60, false),
('estetica', 'Estetica dental', 'Carilla dental', 18000, 90, true),
('odontopediatria', 'Odontopediatria', 'Consulta odontopediatrica', 1200, 30, false)
ON CONFLICT (category_key, name) DO NOTHING;
