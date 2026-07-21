ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS procedure_category TEXT,
  ADD COLUMN IF NOT EXISTS procedure_name TEXT,
  ADD COLUMN IF NOT EXISTS tooth_number TEXT,
  ADD COLUMN IF NOT EXISTS clinical_detail TEXT;

UPDATE appointments
SET procedure_name = reason
WHERE procedure_name IS NULL AND reason IS NOT NULL;
