ALTER TABLE billing_estimates
  DROP CONSTRAINT IF EXISTS billing_estimates_status_check;

ALTER TABLE billing_estimates
  ADD CONSTRAINT billing_estimates_status_check
  CHECK (status IN ('borrador', 'aprobado', 'pendiente', 'en_deuda', 'pagado', 'cancelado'));

ALTER TABLE billing_estimates
  ALTER COLUMN status SET DEFAULT 'pendiente';

UPDATE billing_estimates
SET status = CASE
  WHEN status = 'borrador' THEN 'pendiente'
  WHEN status = 'aprobado' AND balance > 0 THEN 'en_deuda'
  WHEN status = 'aprobado' THEN 'pendiente'
  ELSE status
END
WHERE status IN ('borrador', 'aprobado');
