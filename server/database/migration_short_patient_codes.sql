WITH active_patients AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, full_name, id) AS rn
  FROM patients
  WHERE deleted_at IS NULL
), temp_codes AS (
  UPDATE patients p
  SET patient_code = 'TMP-' || REPLACE(p.id::text, '-', '')
  FROM active_patients ap
  WHERE p.id = ap.id
  RETURNING p.id
)
UPDATE patients p
SET patient_code = 'P-' || LPAD(ap.rn::text, 4, '0')
FROM active_patients ap
WHERE p.id = ap.id;
