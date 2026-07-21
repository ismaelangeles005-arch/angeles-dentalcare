ALTER TABLE appointments
  ALTER COLUMN appointment_timezone SET DEFAULT 'America/Santo_Domingo';

UPDATE appointments
SET appointment_timezone = 'America/Santo_Domingo'
WHERE appointment_timezone IS NULL
   OR appointment_timezone = 'America/La_Paz';
