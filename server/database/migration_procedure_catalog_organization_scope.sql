-- V4.3: scope procedure catalog by organization.
-- Existing active rows must belong to an organization before
-- organization_id becomes mandatory.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM procedure_catalog
        WHERE organization_id IS NULL
          AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION
            'STOP V4.3: procedure_catalog contains active rows without organization_id';
    END IF;
END $$;

ALTER TABLE procedure_catalog
    ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE procedure_catalog
    DROP CONSTRAINT IF EXISTS procedure_catalog_category_key_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_procedure_catalog_org_category_name
    ON procedure_catalog (organization_id, category_key, name)
    WHERE deleted_at IS NULL;
