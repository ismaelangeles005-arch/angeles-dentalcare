BEGIN;

-- Replace only the single-column tooth check; never convert historical rows.
DO $$
DECLARE
  tooth_attribute SMALLINT;
  existing_check RECORD;
  check_count INTEGER;
BEGIN
  SELECT attnum INTO STRICT tooth_attribute FROM pg_attribute
    WHERE attrelid = 'treatment_plan_items'::regclass AND attname = 'tooth_id' AND NOT attisdropped;
  SELECT COUNT(*) INTO check_count FROM pg_constraint
    WHERE conrelid = 'treatment_plan_items'::regclass AND contype = 'c' AND conkey = ARRAY[tooth_attribute];
  IF check_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected treatment_plan_items tooth constraint count: %', check_count;
  END IF;
  SELECT conname, pg_get_constraintdef(oid) AS definition INTO STRICT existing_check FROM pg_constraint
    WHERE conrelid = 'treatment_plan_items'::regclass AND contype = 'c' AND conkey = ARRAY[tooth_attribute];
  IF existing_check.conname <> 'treatment_plan_items_tooth_id_check'
      OR POSITION('PERMANENT_' IN existing_check.definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected tooth constraint; manual review required';
  END IF;
  EXECUTE format('ALTER TABLE treatment_plan_items DROP CONSTRAINT %I', existing_check.conname);
END $$;

ALTER TABLE treatment_plan_items ADD CONSTRAINT treatment_plan_items_tooth_id_check
  CHECK (tooth_id IS NULL OR tooth_id ~
    '^(PERMANENT_(UPPER|LOWER)_(RIGHT|LEFT)_(THIRD_MOLAR|SECOND_MOLAR|FIRST_MOLAR|SECOND_PREMOLAR|FIRST_PREMOLAR|CANINE|LATERAL_INCISOR|CENTRAL_INCISOR)|PRIMARY_(UPPER|LOWER)_(RIGHT|LEFT)_(SECOND_MOLAR|FIRST_MOLAR|CANINE|LATERAL_INCISOR|CENTRAL_INCISOR))$');

COMMIT;
