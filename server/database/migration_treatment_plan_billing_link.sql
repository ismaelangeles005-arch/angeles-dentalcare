BEGIN;

ALTER TABLE billing_estimate_items
  ADD COLUMN IF NOT EXISTS treatment_plan_item_id UUID NULL
    REFERENCES treatment_plan_items(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_billing_estimate_items_treatment_plan_item
  ON billing_estimate_items (treatment_plan_item_id)
  WHERE treatment_plan_item_id IS NOT NULL;

COMMIT;
