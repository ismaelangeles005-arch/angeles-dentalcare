const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");

const router = express.Router();

const DENTAL_AREAS = [
  "Operatoria",
  "Cirugía",
  "Endodoncia",
  "Periodoncia",
  "Estética",
  "Ortodoncia",
  "Odontopediatría",
  "Prótesis y rehabilitación",
  "Evaluación y diagnóstico"
];
const AREA_ALIASES = new Map([
  ["Cirugia", "Cirugía"],
  ["Estetica", "Estética"],
  ["Odontopediatria", "Odontopediatría"],
  ["Protesis y rehabilitacion", "Prótesis y rehabilitación"],
  ["Evaluacion y diagnostico", "Evaluación y diagnóstico"]
]);

function normalizeDentalArea(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  return AREA_ALIASES.get(clean) || clean;
}

function cleanToothSelections(value) {
  const selections = Array.isArray(value) ? value : [];
  return selections
    .filter(item => item && typeof item === "object")
    .map(item => ({
      toothId: String(item.toothId || "").trim(),
      numberingSystem: String(item.numberingSystem || "FDI").trim() === "UNIVERSAL" ? "UNIVERSAL" : "FDI",
      displayCode: String(item.displayCode || "").trim()
    }))
    .filter(item => item.toothId && item.displayCode)
    .slice(0, 32);
}

function validToothCount(mode, selections) {
  if (["1", "2", "3", "4"].includes(mode)) return selections.length === Number(mode);
  if (mode === "multiple") return selections.length >= 5;
  return selections.length === 0;
}
router.use(authenticate);

const CLOSED_STATUSES = ["cancelada", "no_asistio", "reprogramada"];
const VALID_STATUSES = ["pendiente", "confirmada", "en_consulta", "completada", "cancelada", "no_asistio", "reprogramada"];
const STATUS_ROLE_PERMISSIONS = {
  pendiente: ["head_admin", "admin", "recepcion"],
  confirmada: ["head_admin", "admin", "recepcion"],
  en_consulta: ["head_admin", "admin", "doctor"],
  completada: ["head_admin", "admin", "doctor", "recepcion"],
  cancelada: ["head_admin", "admin", "recepcion"],
  no_asistio: ["head_admin", "admin", "recepcion"],
  reprogramada: ["head_admin", "admin", "recepcion"]
};

function roleAllowed(req, roles) {
  const { hasAnyRole } = require("../middleware/auth");
  return hasAnyRole(req.user.role, roles);
}

async function notifyClinicStaff(title, message, entityType, entityId, organizationId) {
  return db.query(`
    INSERT INTO notifications (organization_id, user_id, type, title, message, entity_type, entity_id)
    SELECT $5, u.id, 'clinic_activity', $1, $2, $3, $4
    FROM users u
    WHERE u.organization_id = $5
      AND u.role IN ('head_admin', 'admin', 'clinic_admin', 'recepcion', 'receptionist')
      AND u.active = true
  `, [title, message, entityType, entityId, organizationId]);
}

async function notifyDoctorAppointment(doctorId, appointmentId, patientName, fecha, hora, procedureName, organizationId) {
  const message = `${patientName} tiene una cita programada para ${fecha} a las ${hora}.`;
  return db.query(`
    INSERT INTO notifications (organization_id, user_id, type, title, message, entity_type, entity_id)
    SELECT $4, u.id, 'appointment_created', 'Nueva cita en tu agenda', $2, 'appointment', $3
    FROM users u
    WHERE u.doctor_id = $1
      AND u.organization_id = $4
      AND u.role IN ('doctor', 'owner_doctor')
      AND u.active = true
  `, [doctorId, procedureName ? `${message} Procedimiento: ${procedureName}.` : message, appointmentId, organizationId]);
}

router.get("/", asyncHandler(async (req, res) => {
  const params = [req.user.organizationId];
  let where = "WHERE a.deleted_at IS NULL AND a.organization_id = $1";

  if (req.query.status) {
    params.push(req.query.status);
    where += ` AND a.status = $${params.length}`;
  }

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    where += ` AND a.doctor_id = $${params.length}`;
  }

  const result = await db.query(`
    SELECT
      a.id,
      COALESCE(p.full_name, a.patient_name) AS paciente,
      a.patient_id,
      TO_CHAR(a.appointment_date, 'YYYY-MM-DD') AS fecha,
      TO_CHAR(a.appointment_time, 'HH24:MI') AS hora,
      a.appointment_duration_minutes AS duracion_minutos,
      TO_CHAR(a.appointment_time + (a.appointment_duration_minutes || ' minutes')::interval, 'HH24:MI') AS hora_fin,
      a.appointment_timezone AS zona_horaria,
      a.status AS estado,
      a.reason AS motivo,
      a.procedure_category AS categoria_procedimiento,
      a.procedure_name AS procedimiento,
      a.dental_area,
      a.tooth_number AS pieza_dental,
      a.tooth_count_mode,
      a.tooth_numbering_system,
      a.tooth_selections,
      a.clinical_detail AS detalle_clinico,
      d.name AS doctor,
      a.doctor_id
    FROM appointments a
    LEFT JOIN patients p ON p.id = a.patient_id AND p.organization_id = a.organization_id
    LEFT JOIN doctors d ON d.id = a.doctor_id AND d.organization_id = a.organization_id
    ${where}
    ORDER BY a.appointment_date DESC, a.appointment_time DESC
  `, params);

  return res.json(result.rows);
}));

router.post("/", allowRoles("head_admin", "admin", "recepcion", "doctor"), asyncHandler(async (req, res) => {
  const { pacienteId, fecha, hora, doctorId, duracionMinutos, motivo, categoriaProcedimiento, procedimiento, piezaDental, detalleClinico, dentalArea, toothSelections, toothCountMode, toothNumberingSystem } = req.body;
  const effectiveDoctorId = req.user.isDoctor ? req.user.doctorId : doctorId;
  const validCategories = ["evaluacion", "prevencion", "restauracion", "caries", "endodoncia", "extraccion", "ortodoncia", "periodoncia", "protesis", "cirugia", "estetica", "odontopediatria", "urgencia"];
  const cleanCategory = typeof categoriaProcedimiento === "string" ? categoriaProcedimiento.trim().toLowerCase() : "";
  const cleanProcedure = typeof procedimiento === "string" ? procedimiento.trim() : "";
  const cleanTooth = typeof piezaDental === "string" ? piezaDental.trim() : "";
  const cleanDetail = typeof detalleClinico === "string" ? detalleClinico.trim() : "";
  const cleanDentalArea = normalizeDentalArea(dentalArea);
  const cleanSelections = cleanToothSelections(toothSelections);
  const cleanToothCountMode = ["1", "2", "3", "4", "multiple"].includes(String(toothCountMode)) ? String(toothCountMode) : "";
  const cleanNumberingSystem = toothNumberingSystem === "UNIVERSAL" ? "UNIVERSAL" : "FDI";
  const duration = Number(duracionMinutos || 30);

  if (!pacienteId || !fecha || !hora || !effectiveDoctorId || !cleanCategory || !cleanProcedure || !cleanDentalArea) {
    return res.status(400).json({ message: "Completa todos los campos requeridos" });
  }
  if (![15, 30, 45, 60, 90, 120].includes(duration)) {
    return res.status(400).json({ message: "Selecciona una duracion valida para la cita" });
  }
  if (!validCategories.includes(cleanCategory)) {
    return res.status(400).json({ message: "La categoria del procedimiento no es valida" });
  }
  if (!DENTAL_AREAS.includes(cleanDentalArea)) {
    return res.status(400).json({ message: "Selecciona un area odontologica valida" });
  }
  if (cleanToothCountMode && !validToothCount(cleanToothCountMode, cleanSelections)) {
    return res.status(400).json({ message: "La cantidad de piezas no coincide con la seleccion" });
  }
  if (cleanProcedure.length > 160 || cleanDetail.length > 500) {
    return res.status(400).json({ message: "Los datos clínicos superan el tamaño permitido" });
  }
  if (cleanTooth && !/^([1-4]\.[1-8]|[1-4][1-8]|[1-9]|[12][0-9]|3[0-2])$/.test(cleanTooth)) {
    return res.status(400).json({ message: "La pieza dental no es valida" });
  }

  const patientParams = [pacienteId, req.user.organizationId];
  let patientDoctorCondition = "";
  if (req.user.isDoctor) {
    patientParams.push(req.user.doctorId);
    patientDoctorCondition = `AND doctor_id = $${patientParams.length}`;
  }

  const patient = await db.query(`
    SELECT id, full_name
    FROM patients
    WHERE id = $1
      AND organization_id = $2
      AND deleted_at IS NULL
      ${patientDoctorCondition}
    LIMIT 1
  `, patientParams);
  if (!patient.rows.length) {
    return res.status(404).json({ message: req.user.isDoctor ? "Solo puedes agendar pacientes asignados a ti" : "Selecciona un paciente registrado" });
  }

  const doctor = await db.query(`
    SELECT id FROM doctors
    WHERE id = $1 AND organization_id = $2 AND active = true
    LIMIT 1
  `, [effectiveDoctorId, req.user.organizationId]);
  if (!doctor.rows.length) {
    return res.status(400).json({ message: "El doctor seleccionado no esta disponible" });
  }

  const conflict = await db.query(`
    SELECT id, TO_CHAR(appointment_time, 'HH24:MI') AS hora,
      TO_CHAR(appointment_time + (appointment_duration_minutes || ' minutes')::interval, 'HH24:MI') AS hora_fin
    FROM appointments
    WHERE doctor_id = $1
      AND organization_id = $6
      AND appointment_date = $2
      AND deleted_at IS NULL
      AND status <> ALL($5::text[])
      AND $3::time < appointment_time + (appointment_duration_minutes || ' minutes')::interval
      AND ($3::time + ($4::int || ' minutes')::interval) > appointment_time
    LIMIT 1
  `, [effectiveDoctorId, fecha, hora, duration, CLOSED_STATUSES, req.user.organizationId]);
  if (conflict.rows.length) {
    return res.status(409).json({ message: `El doctor ya tiene una cita de ${conflict.rows[0].hora} a ${conflict.rows[0].hora_fin}` });
  }

  const availability = await db.query(`
    SELECT status, max_patients
    FROM doctor_availability
    WHERE doctor_id = $1
      AND organization_id = $3
      AND work_date = $2
      AND deleted_at IS NULL
    LIMIT 1
  `, [effectiveDoctorId, fecha, req.user.organizationId]);

  if (availability.rows.length) {
    const dayRule = availability.rows[0];
    if (dayRule.status === "libre") {
      return res.status(409).json({ message: "El doctor marco ese dia como libre" });
    }
    if (dayRule.status === "limitado") {
      const count = await db.query(`
        SELECT COUNT(*)::int AS total
        FROM appointments
        WHERE doctor_id = $1
          AND organization_id = $4
          AND appointment_date = $2
          AND deleted_at IS NULL
          AND status <> ALL($3::text[])
      `, [effectiveDoctorId, fecha, CLOSED_STATUSES, req.user.organizationId]);
      if (count.rows[0].total >= dayRule.max_patients) {
        return res.status(409).json({ message: `El doctor limito ese dia a ${dayRule.max_patients} paciente(s)` });
      }
    }
  }

  const result = await db.query(`
    INSERT INTO appointments (
      organization_id, patient_id, patient_name, appointment_date, appointment_time,
      appointment_duration_minutes, appointment_timezone, doctor_id, reason,
      procedure_category, procedure_name, dental_area, tooth_number, tooth_count_mode,
      tooth_numbering_system, tooth_selections, clinical_detail, status, created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pendiente', $18)
    RETURNING *
  `, [
    req.user.organizationId,
    pacienteId,
    patient.rows[0].full_name,
    fecha,
    hora,
    duration,
    "America/Santo_Domingo",
    effectiveDoctorId,
    typeof motivo === "string" ? motivo.trim().slice(0, 300) || cleanProcedure : cleanProcedure,
    cleanCategory,
    cleanProcedure,
    cleanDentalArea,
    cleanSelections[0]?.displayCode || cleanTooth || null,
    cleanToothCountMode || null,
    cleanNumberingSystem,
    JSON.stringify(cleanSelections),
    cleanDetail || null,
    req.user.id
  ]);

  await db.query(`
    UPDATE patients
    SET procedure_name = $2, appointment_date = $3, appointment_time = $4, status = 'Pendiente', updated_at = NOW()
    WHERE id = $1 AND organization_id = $5 AND deleted_at IS NULL
  `, [pacienteId, cleanProcedure, fecha, hora, req.user.organizationId]);

  if (!req.user.isDoctor) {
    await notifyDoctorAppointment(effectiveDoctorId, result.rows[0].id, patient.rows[0].full_name, fecha, hora, cleanProcedure, req.user.organizationId);
  }
  else {
    await notifyClinicStaff("Nueva cita creada por doctor", `${patient.rows[0].full_name} fue agendado para ${fecha} a las ${hora}. Procedimiento: ${cleanProcedure}.`, "appointment", result.rows[0].id, req.user.organizationId);
  }

  await writeAuditLog(req, "create", "appointments", result.rows[0].id, { patientId: pacienteId, doctorId: effectiveDoctorId, fecha, hora, duracionMinutos: duration, procedimiento: cleanProcedure, dentalArea: cleanDentalArea });
  return res.status(201).json(result.rows[0]);
}));

router.patch("/:id/status", asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ message: "Estado invalido" });
  }
  if (!roleAllowed(req, STATUS_ROLE_PERMISSIONS[status])) {
    return res.status(403).json({ message: "No tienes permiso para aplicar ese estado" });
  }

  const params = [req.params.id, status, req.user.organizationId];
  let where = "id = $1 AND organization_id = $3";
  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    where += ` AND doctor_id = $${params.length}`;
  }
  params.push(CLOSED_STATUSES);
  const closedStatusesParam = params.length;

  const result = await db.query(`
    UPDATE appointments
    SET status = $2, updated_at = NOW()
    WHERE ${where}
      AND deleted_at IS NULL
      AND status <> ALL($${closedStatusesParam}::text[])
    RETURNING *
  `, params);
  if (!result.rows.length) {
    return res.status(404).json({ message: "Cita no encontrada" });
  }

  await notifyClinicStaff("Estado de cita actualizado", `Una cita fue marcada como ${status}.`, "appointment", req.params.id, req.user.organizationId);
  await writeAuditLog(req, "update_status", "appointments", req.params.id, { status });
  return res.json(result.rows[0]);
}));

router.delete("/:id", allowRoles("head_admin", "admin", "recepcion"), asyncHandler(async (req, res) => {
  const result = await db.query(`
    UPDATE appointments
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
    RETURNING id
  `, [req.params.id, req.user.organizationId]);
  if (!result.rows.length) {
    return res.status(404).json({ message: "Cita no encontrada" });
  }
  await writeAuditLog(req, "delete", "appointments", req.params.id);
  return res.status(204).send();
}));

module.exports = router;
