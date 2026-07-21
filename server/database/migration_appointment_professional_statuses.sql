ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN (
    'pendiente',
    'confirmada',
    'en_consulta',
    'completada',
    'cancelada',
    'no_asistio',
    'reprogramada'
  ));
