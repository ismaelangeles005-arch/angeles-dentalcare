const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");
const { cleanToothSelections } = require("../utils/dentalTeeth");

const router = express.Router();

router.use(authenticate);

const NOTE_TYPES = ["consulta_ambulatoria", "procedimiento", "evolucion"];
const CONSULTATION_STATUSES = ["en_espera", "en_consulta", "atendido", "finalizado"];
const PROCEDURE_STATUSES = ["pendiente", "programado", "realizado", "cancelado"];
const TOOTH_PATTERN = /^([1-4]\.[1-8]|[1-4][1-8]|[1-9]|[12][0-9]|3[0-2])$/;
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

function cleanPharmacotherapy(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map(item => ({
    drug: cleanText(item?.drug, 160),
    presentation: cleanText(item?.presentation, 160),
    dose: cleanText(item?.dose, 160),
    frequency: cleanText(item?.frequency, 160),
    route: cleanText(item?.route, 160),
    indications: cleanText(item?.indications, 500)
  })).filter(item => Object.values(item).some(Boolean)).slice(0, 20);
}

function cleanText(value, maxLength = 2000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function cleanTime(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

function buildFallbackNote(payload) {
  return [
    payload.chiefComplaint && `Motivo: ${payload.chiefComplaint}`,
    payload.clinicalEvaluation && `Evaluación: ${payload.clinicalEvaluation}`,
    payload.odontologicalDiagnosis && `Diagnóstico: ${payload.odontologicalDiagnosis}`,
    payload.performedProcedures && `Procedimientos: ${payload.performedProcedures}`,
    payload.evolution && `Evolución: ${payload.evolution}`,
    payload.indications && `Indicaciones: ${payload.indications}`,
    payload.observations && `Observaciones: ${payload.observations}`
  ].filter(Boolean).join("\n");
}

router.get("/", asyncHandler(async (req, res) => {
  const params = [req.user.organizationId];
  let where = "WHERE p.deleted_at IS NULL AND cn.organization_id = $1 AND p.organization_id = $1";

  if (req.query.patientId) {
    params.push(req.query.patientId);
    where += ` AND cn.patient_id = $${params.length}`;
  }

  if (req.query.appointmentId) {
    params.push(req.query.appointmentId);
    where += ` AND cn.appointment_id = $${params.length}`;
  }

  if (req.query.type && NOTE_TYPES.includes(req.query.type)) {
    params.push(req.query.type);
    where += ` AND cn.note_type = $${params.length}`;
  }

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    where += ` AND (cn.doctor_id = $${params.length} OR p.doctor_id = $${params.length})`;
  }

  const result = await db.query(`
    SELECT
      cn.id,
      cn.patient_id,
      p.full_name AS paciente,
      cn.appointment_id,
      cn.doctor_id,
      d.name AS doctor,
      cn.note_type,
      cn.consultation_status,
      cn.procedure_name AS procedimiento,
      cn.procedure_status,
      cn.dental_area,
      cn.tooth_number,
      cn.tooth_count_mode,
      cn.tooth_numbering_system,
      cn.tooth_selections,
      cn.diagnosis AS diagnostico,
      COALESCE(cn.odontological_diagnosis, cn.diagnosis) AS diagnostico_odontologico,
      cn.treatment AS tratamiento,
      cn.prescription AS receta,
      cn.pharmacotherapy,
      cn.next_steps AS proxima_indicacion,
      cn.chief_complaint AS motivo_consulta,
      cn.clinical_evaluation AS evaluacion_clinica,
      cn.performed_procedures AS procedimientos_realizados,
      cn.indications AS indicaciones,
      cn.observations AS observaciones,
      TO_CHAR(cn.next_appointment_date, 'YYYY-MM-DD') AS proxima_cita_fecha,
      TO_CHAR(cn.next_appointment_time, 'HH24:MI') AS proxima_cita_hora,
      cn.general_status AS estado_general,
      cn.clinical_findings AS hallazgos_clinicos,
      cn.evolution AS evolucion,
      cn.medications AS medicamentos_indicados,
      cn.clinical_description AS descripcion_clinica,
      cn.material_used AS material_utilizado,
      TO_CHAR(cn.next_review_date, 'YYYY-MM-DD') AS proxima_revision,
      cn.note AS nota,
      TO_CHAR(cn.created_at, 'YYYY-MM-DD HH24:MI') AS fecha_registro
    FROM clinical_notes cn
    JOIN patients p ON p.id = cn.patient_id
    LEFT JOIN doctors d ON d.id = cn.doctor_id
    ${where}
    ORDER BY cn.created_at DESC
  `, params);

  return res.json(result.rows);
}));

router.post("/", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  const {
    patientId,
    appointmentId,
    noteType,
    consultationStatus,
    procedureName,
    procedureStatus,
    toothNumber,
    toothSelections,
    toothCountMode,
    toothNumberingSystem,
    dentalArea,
    diagnosis,
    odontologicalDiagnosis,
    treatment,
    prescription,
    pharmacotherapy,
    nextSteps,
    chiefComplaint,
    clinicalEvaluation,
    performedProcedures,
    indications,
    observations,
    nextAppointmentDate,
    nextAppointmentTime,
    generalStatus,
    clinicalFindings,
    evolution,
    medications,
    clinicalDescription,
    materialUsed,
    nextReviewDate,
    note
  } = req.body;

  const cleanNoteType = NOTE_TYPES.includes(noteType) ? noteType : "evolucion";
  const cleanConsultationStatus = CONSULTATION_STATUSES.includes(consultationStatus) ? consultationStatus : null;
  const cleanProcedureStatus = PROCEDURE_STATUSES.includes(procedureStatus) ? procedureStatus : null;
  const cleanTooth = cleanText(toothNumber, 12);
  const cleanSelections = cleanToothSelections(toothSelections);
  const cleanToothCountMode = ["1", "2", "3", "4", "multiple"].includes(String(toothCountMode)) ? String(toothCountMode) : "";
  const cleanNumberingSystem = toothNumberingSystem === "UNIVERSAL" ? "UNIVERSAL" : "FDI";
  const cleanDentalArea = normalizeDentalArea(dentalArea);
  const cleanPharma = cleanPharmacotherapy(pharmacotherapy);
  const payload = {
    procedureName: cleanText(procedureName, 160),
    diagnosis: cleanText(diagnosis, 1000),
    odontologicalDiagnosis: cleanText(odontologicalDiagnosis || diagnosis, 1000),
    treatment: cleanText(treatment, 2000),
    prescription: cleanText(prescription, 2000),
    nextSteps: cleanText(nextSteps, 1000),
    chiefComplaint: cleanText(chiefComplaint, 1200),
    clinicalEvaluation: cleanText(clinicalEvaluation, 2500),
    performedProcedures: cleanText(performedProcedures, 2500),
    indications: cleanText(indications || prescription, 2000),
    observations: cleanText(observations, 2000),
    generalStatus: cleanText(generalStatus, 1000),
    clinicalFindings: cleanText(clinicalFindings, 2500),
    evolution: cleanText(evolution, 3000),
    medications: cleanText(medications, 2000),
    clinicalDescription: cleanText(clinicalDescription, 2500),
    materialUsed: cleanText(materialUsed, 1000),
    note: cleanText(note, 3000)
  };

  const finalNote = payload.note || buildFallbackNote(payload);

  if (!patientId || !finalNote) {
    return res.status(400).json({ message: "Selecciona el paciente y registra información clínica" });
  }

  if (cleanDentalArea && !DENTAL_AREAS.includes(cleanDentalArea)) {
    return res.status(400).json({ message: "Selecciona un area odontologica valida" });
  }

  if (!cleanSelections.length && cleanTooth && !TOOTH_PATTERN.test(cleanTooth)) {
    return res.status(400).json({ message: "La pieza dental no es valida" });
  }

  const patientParams = [patientId, req.user.organizationId];
  let patientWhere = "id = $1 AND organization_id = $2 AND deleted_at IS NULL";

  if (req.user.isDoctor) {
    patientParams.push(req.user.doctorId);
    patientWhere += ` AND (
      doctor_id = $${patientParams.length}
      OR doctor_id IS NULL
      OR EXISTS (
        SELECT 1 FROM patient_visits pv
        WHERE pv.patient_id = patients.id AND pv.doctor_id = $${patientParams.length}
      )
    )`;
  }

  const patient = await db.query(`
    SELECT id, doctor_id
    FROM patients
    WHERE ${patientWhere}
    LIMIT 1
  `, patientParams);

  if (!patient.rows.length) {
    return res.status(404).json({
      message: req.user.isDoctor
        ? "Solo puedes registrar evolución de pacientes asignados o atendidos por ti"
        : "Paciente no encontrado"
    });
  }

  let doctorId = req.user.isDoctor ? req.user.doctorId : patient.rows[0].doctor_id;

  if (appointmentId) {
    const appointmentParams = [appointmentId, patientId, req.user.organizationId];
    let appointmentWhere = "id = $1 AND patient_id = $2 AND organization_id = $3 AND deleted_at IS NULL";

    if (req.user.isDoctor) {
      appointmentParams.push(req.user.doctorId);
      appointmentWhere += ` AND doctor_id = $${appointmentParams.length}`;
    }

    const appointment = await db.query(`
      SELECT doctor_id
      FROM appointments
      WHERE ${appointmentWhere}
      LIMIT 1
    `, appointmentParams);

    if (!appointment.rows.length) {
      return res.status(404).json({ message: "Cita no encontrada para este paciente" });
    }

    doctorId = appointment.rows[0].doctor_id;
  }

  const result = await db.query(`
    INSERT INTO clinical_notes (
      organization_id,
      patient_id,
      appointment_id,
      doctor_id,
      note_type,
      consultation_status,
      procedure_name,
      procedure_status,
      dental_area,
      tooth_number,
      tooth_count_mode,
      tooth_numbering_system,
      tooth_selections,
      diagnosis,
      odontological_diagnosis,
      treatment,
      prescription,
      pharmacotherapy,
      next_steps,
      chief_complaint,
      clinical_evaluation,
      performed_procedures,
      indications,
      observations,
      next_appointment_date,
      next_appointment_time,
      general_status,
      clinical_findings,
      evolution,
      medications,
      clinical_description,
      material_used,
      next_review_date,
      note,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35)
    RETURNING id
  `, [
    req.user.organizationId,
    patientId,
    appointmentId || null,
    doctorId || null,
    cleanNoteType,
    cleanConsultationStatus,
    payload.procedureName || null,
    cleanProcedureStatus,
    cleanDentalArea || null,
    cleanSelections[0]?.displayCode || cleanTooth || null,
    cleanToothCountMode || null,
    cleanNumberingSystem,
    JSON.stringify(cleanSelections),
    payload.diagnosis || null,
    payload.odontologicalDiagnosis || null,
    payload.treatment || null,
    payload.prescription || null,
    JSON.stringify(cleanPharma),
    payload.nextSteps || null,
    payload.chiefComplaint || null,
    payload.clinicalEvaluation || null,
    payload.performedProcedures || null,
    payload.indications || null,
    payload.observations || null,
    cleanDate(nextAppointmentDate),
    cleanTime(nextAppointmentTime),
    payload.generalStatus || null,
    payload.clinicalFindings || null,
    payload.evolution || null,
    payload.medications || null,
    payload.clinicalDescription || null,
    payload.materialUsed || null,
    cleanDate(nextReviewDate),
    finalNote,
    req.user.id
  ]);

  if (appointmentId) {
    const nextStatus = cleanConsultationStatus === "en_consulta"
      ? "en_consulta"
      : (["atendido", "finalizado"].includes(cleanConsultationStatus) || cleanProcedureStatus === "realizado" ? "completada" : null);

    if (nextStatus) {
      await db.query(`
        UPDATE appointments
        SET status = $2, updated_at = NOW()
        WHERE id = $1
          AND organization_id = $3
          AND deleted_at IS NULL
          AND status <> 'cancelada'
      `, [appointmentId, nextStatus, req.user.organizationId]);
    }
  }

  await writeAuditLog(req, "create", "clinical_notes", result.rows[0].id, {
    patientId,
    appointmentId: appointmentId || null,
    noteType: cleanNoteType,
    procedureName: payload.procedureName || null,
    procedureStatus: cleanProcedureStatus
  });

  return res.status(201).json({ id: result.rows[0].id });
}));

module.exports = router;






