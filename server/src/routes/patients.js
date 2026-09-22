const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);

const PATIENT_TYPES = ["regular", "ambulatory"];
const OPERATIONAL_CLASSIFICATIONS = [
  "cumplido",
  "impuntual",
  "ausencias_frecuentes",
  "requiere_confirmacion",
  "incumplimiento_indicaciones",
  "documentacion_pendiente",
  "sin_clasificacion"
];
const MEDICAL_CONDITIONS = {
  alzheimer: "Alzheimer",
  diabetes: "Diabetes",
  hipertension: "Hipertension",
  anticoagulacion: "Anticoagulacion",
  alergias: "Alergias",
  discapacidad_cognitiva: "Discapacidad cognitiva",
  necesita_acompanante: "Necesita acompanante",
  riesgo_medico_especial: "Riesgo médico especial",
  otro: "Otro"
};

function cleanDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function cleanTime(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : null;
}


async function generatePatientCode(client, organizationId) {
  const result = await client.query(`
    SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(patient_code, '[^0-9]', '', 'g'), '')::int), 0) + 1 AS next_number
    FROM patients
    WHERE organization_id = $1 AND patient_code ~ '^P-[0-9]+'
  `, [organizationId]);
  const nextNumber = Number(result.rows[0]?.next_number || 1);
  return `P-${String(nextNumber).padStart(4, "0")}`;
}

router.get("/", asyncHandler(async (req, res) => {
  const params = [req.user.organizationId];
  let assignmentSelect = "false AS is_assigned_to_current_doctor, false AS has_attended_current_doctor";

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    assignmentSelect = `
      (p.doctor_id = $${params.length}) AS is_assigned_to_current_doctor,
      EXISTS (
        SELECT 1
        FROM patient_visits pv
        WHERE pv.patient_id = p.id
          AND pv.organization_id = p.organization_id
          AND pv.doctor_id = $${params.length}
      ) AS has_attended_current_doctor
    `;
  }

  const result = await db.query(`
    SELECT
      p.id,
      p.full_name AS nombre,
      p.national_id,
      p.patient_code,
      d.name AS doctor,
      p.doctor_id,
      ${assignmentSelect},
      p.procedure_name AS proceso,
      p.appointment_date AS fecha,
      p.appointment_time AS hora,
      p.status AS estado,
      p.phone,
      p.email,
      p.notes,
      p.allergies,
      p.medical_history,
      p.current_medications,
      p.diagnosis,
      p.diagnosis AS motivo_consulta,
      p.treatment_plan,
      p.patient_type,
      p.operational_classification,
      p.operational_classification_observation,
      TO_CHAR(p.operational_classification_at, 'YYYY-MM-DD HH24:MI') AS operational_classification_at,
      uc.full_name AS operational_classification_by_name,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', pmc.id,
          'condition_key', pmc.condition_key,
          'condition_label', pmc.condition_label,
          'observation', pmc.observation
        ) ORDER BY pmc.condition_label)
        FROM patient_medical_conditions pmc
        WHERE pmc.patient_id = p.id
          AND pmc.organization_id = p.organization_id
          AND pmc.active = true
      ), '[]'::json) AS medical_conditions,
      p.assigned_at,
      (
        SELECT COUNT(*)::int
        FROM patient_files pf
        WHERE pf.patient_id = p.id AND pf.organization_id = p.organization_id AND pf.deleted_at IS NULL
      ) AS file_count,
      p.created_at
    FROM patients p
    LEFT JOIN doctors d ON d.id = p.doctor_id AND d.organization_id = p.organization_id
    LEFT JOIN users uc ON uc.id = p.operational_classification_by AND uc.organization_id = p.organization_id
    WHERE p.deleted_at IS NULL AND p.organization_id = $1
    ORDER BY p.full_name
  `, params);

  return res.json(result.rows);
}));

router.post("/", allowRoles("head_admin", "admin", "recepcion"), asyncHandler(async (req, res) => {
  const {
    nombre,
    nationalId,
    patientCode,
    phone,
    email,
    notes,
    doctorId,
    allergies,
    medicalHistory,
    currentMedications,
    diagnosis,
    chiefComplaint,
    motivoConsulta,
    treatmentPlan,
    patientType,
    appointmentDate,
    appointmentTime,
    procedureName,
    ambulatoryObservations
  } = req.body;

  const cleanName = typeof nombre === "string" ? nombre.trim() : "";
  const cleanNationalId = typeof nationalId === "string" ? nationalId.trim() : "";
  const cleanPatientCode = typeof patientCode === "string" ? patientCode.trim().toUpperCase() : "";
  const cleanPhone = typeof phone === "string" ? phone.trim() : "";
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cleanNotes = typeof notes === "string" ? notes.trim() : "";
  const cleanAllergies = typeof allergies === "string" ? allergies.trim() : "";
  const cleanMedicalHistory = typeof medicalHistory === "string" ? medicalHistory.trim() : "";
  const cleanMedications = typeof currentMedications === "string" ? currentMedications.trim() : "";
  const cleanDiagnosis = typeof (chiefComplaint || motivoConsulta || diagnosis) === "string" ? (chiefComplaint || motivoConsulta || diagnosis).trim() : "";
  const cleanTreatmentPlan = typeof treatmentPlan === "string" ? treatmentPlan.trim() : "";
  const cleanPatientType = PATIENT_TYPES.includes(patientType) ? patientType : "regular";
  const cleanAppointmentDate = cleanDate(appointmentDate);
  const cleanAppointmentTime = cleanTime(appointmentTime);
  const cleanProcedureName = typeof procedureName === "string" ? procedureName.trim().slice(0, 160) : "";
  const cleanAmbulatoryObservations = typeof ambulatoryObservations === "string" ? ambulatoryObservations.trim().slice(0, 2000) : "";

  if (!cleanName) {
    return res.status(400).json({ message: "El nombre del paciente es requerido" });
  }

  if (
    cleanName.length > 160 ||
    cleanNationalId.length > 40 ||
    cleanPatientCode.length > 40 ||
    cleanPhone.length > 40 ||
    cleanEmail.length > 160 ||
    cleanNotes.length > 2000 ||
    cleanAllergies.length > 1000 ||
    cleanMedicalHistory.length > 2000 ||
    cleanMedications.length > 1500 ||
    cleanDiagnosis.length > 2000 ||
    cleanTreatmentPlan.length > 3000
  ) {
    return res.status(400).json({ message: "Uno de los campos supera el tamaño permitido" });
  }

  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ message: "El correo electronico no es valido" });
  }

  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    if (cleanNationalId) {
      const existingByCedula = await client.query(
        "SELECT id FROM patients WHERE national_id = $1 AND organization_id = $2 AND deleted_at IS NULL LIMIT 1",
        [cleanNationalId, req.user.organizationId]
      );

      if (existingByCedula.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Ya existe un paciente con esa cédula" });
      }
    }

    const finalPatientCode = cleanPatientCode || await generatePatientCode(client, req.user.organizationId);
    const existingByCode = await client.query(
      "SELECT id FROM patients WHERE patient_code = $1 AND organization_id = $2 AND deleted_at IS NULL LIMIT 1",
      [finalPatientCode, req.user.organizationId]
    );

    if (existingByCode.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Ya existe un paciente con ese codigo" });
    }

    if (doctorId) {
      const doctor = await client.query(
        "SELECT id FROM doctors WHERE id = $1 AND organization_id = $2 AND active = true",
        [doctorId, req.user.organizationId]
      );

      if (!doctor.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "El doctor seleccionado no esta disponible" });
      }
    }

    const result = await client.query(`
      INSERT INTO patients (
        organization_id,
        full_name,
        national_id,
        patient_code,
        phone,
        email,
        notes,
        allergies,
        medical_history,
        current_medications,
        diagnosis,
        treatment_plan,
        patient_type,
        procedure_name,
        appointment_date,
        appointment_time,
        doctor_id,
        assigned_by,
        assigned_at,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, CASE WHEN $17::uuid IS NULL THEN NULL ELSE NOW() END, $19)
      RETURNING *
    `, [
      req.user.organizationId,
      cleanName,
      cleanNationalId || null,
      finalPatientCode,
      cleanPhone || null,
      cleanEmail || null,
      (cleanNotes || cleanAmbulatoryObservations) ? [cleanNotes, cleanAmbulatoryObservations].filter(Boolean).join("\n") : null,
      cleanAllergies || null,
      cleanMedicalHistory || null,
      cleanMedications || null,
      cleanDiagnosis || null,
      cleanTreatmentPlan || null,
      cleanPatientType,
      cleanProcedureName || null,
      cleanAppointmentDate,
      cleanAppointmentTime,
      doctorId || null,
      req.user.id,
      req.user.id
    ]);

    if (doctorId) {
      await client.query(`
        INSERT INTO notifications (organization_id, user_id, type, title, message, entity_type, entity_id)
        SELECT
          $4,
          u.id,
          'patient_assigned',
          'Nuevo paciente asignado',
          $2,
          'patient',
          $3
        FROM users u
        WHERE u.doctor_id = $1 AND u.organization_id = $4 AND u.role IN ('doctor', 'owner_doctor') AND u.active = true
      `, [doctorId, `${cleanName} fue asignado a tu lista de pacientes.`, result.rows[0].id, req.user.organizationId]);
    }

    await client.query("COMMIT");
    return res.status(201).json(result.rows[0]);
  }
  catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  finally {
    client.release();
  }
}));

router.patch("/:id/assign", allowRoles("head_admin", "admin", "recepcion"), asyncHandler(async (req, res) => {
  const { doctorId } = req.body;

  if (!doctorId) {
    return res.status(400).json({ message: "Selecciona un doctor" });
  }

  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const doctor = await client.query(
      "SELECT id, name FROM doctors WHERE id = $1 AND organization_id = $2 AND active = true",
      [doctorId, req.user.organizationId]
    );

    if (!doctor.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Doctor no encontrado" });
    }

    const patient = await client.query(`
      UPDATE patients
      SET
        doctor_id = $2,
        assigned_by = $3,
        assigned_at = NOW(),
        updated_at = NOW()
      WHERE id = $1 AND organization_id = $4 AND deleted_at IS NULL
      RETURNING id, full_name, doctor_id, assigned_at
    `, [req.params.id, doctorId, req.user.id, req.user.organizationId]);

    if (!patient.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Paciente no encontrado" });
    }

    await client.query(`
      INSERT INTO notifications (organization_id, user_id, type, title, message, entity_type, entity_id)
      SELECT
        $4,
        u.id,
        'patient_assigned',
        'Nuevo paciente asignado',
        $2,
        'patient',
        $3
      FROM users u
      WHERE u.doctor_id = $1 AND u.organization_id = $4 AND u.role IN ('doctor', 'owner_doctor') AND u.active = true
    `, [
      doctorId,
      `${patient.rows[0].full_name} fue asignado a tu lista de pacientes.`,
      patient.rows[0].id,
      req.user.organizationId
    ]);

    await client.query("COMMIT");
    return res.json({
      ...patient.rows[0],
      doctor: doctor.rows[0].name
    });
  }
  catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  finally {
    client.release();
  }
}));

router.patch("/:id/claim", allowRoles("doctor"), asyncHandler(async (req, res) => {
  if (!req.user.doctorId) {
    return res.status(400).json({ message: "Tu usuario no tiene un perfil médico vinculado" });
  }

  const patient = await db.query(`
    SELECT id, full_name
    FROM patients
    WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
    LIMIT 1
  `, [req.params.id, req.user.organizationId]);

  if (!patient.rows.length) {
    return res.status(404).json({ message: "Paciente no encontrado" });
  }

  const result = await db.query(`
    INSERT INTO patient_visits (organization_id, patient_id, doctor_id, visit_type, note, created_by)
    VALUES ($1, $2, $3, 'unica', $4, $5)
    RETURNING id, patient_id, doctor_id, created_at
  `, [
    req.user.organizationId,
    req.params.id,
    req.user.doctorId,
    "Visita registrada desde pacientes generales.",
    req.user.id
  ]);

  return res.status(201).json({
    ...result.rows[0],
    message: `${patient.rows[0].full_name} fue registrado como visita atendida por ti.`
  });
}));

router.patch("/:id/assign-to-me", allowRoles("doctor"), asyncHandler(async (req, res) => {
  if (!req.user.doctorId) {
    return res.status(400).json({ message: "Tu usuario no tiene un perfil médico vinculado" });
  }

  const result = await db.query(`
    UPDATE patients
    SET
      doctor_id = $2,
      assigned_by = $3,
      assigned_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
      AND deleted_at IS NULL
      AND organization_id = $4
      AND (doctor_id IS NULL OR doctor_id = $2)
    RETURNING id, full_name, doctor_id, assigned_at
  `, [req.params.id, req.user.doctorId, req.user.id, req.user.organizationId]);

  if (!result.rows.length) {
    return res.status(409).json({ message: "Este paciente ya tiene otro doctor de seguimiento" });
  }

  await db.query(`
    INSERT INTO patient_visits (organization_id, patient_id, doctor_id, visit_type, note, created_by)
    VALUES ($1, $2, $3, 'seguimiento', $4, $5)
  `, [req.user.organizationId, req.params.id, req.user.doctorId, "Paciente asignado para seguimiento.", req.user.id]);

  return res.json({
    ...result.rows[0],
    message: `${result.rows[0].full_name} ahora queda en tu seguimiento.`
  });
}));

router.patch("/:id/type", allowRoles("head_admin", "admin", "recepcion"), asyncHandler(async (req, res) => {
  const { patientType } = req.body;
  if (!PATIENT_TYPES.includes(patientType)) {
    return res.status(400).json({ message: "Tipo de paciente invalido" });
  }
  const result = await db.query(`
    UPDATE patients
    SET patient_type = $2, updated_at = NOW()
    WHERE id = $1 AND organization_id = $3 AND deleted_at IS NULL
    RETURNING id, full_name, patient_type
  `, [req.params.id, patientType, req.user.organizationId]);
  if (!result.rows.length) {
    return res.status(404).json({ message: "Paciente no encontrado" });
  }
  return res.json(result.rows[0]);
}));

router.patch("/:id/classification", asyncHandler(async (req, res) => {
  const classification = OPERATIONAL_CLASSIFICATIONS.includes(req.body.classification)
    ? req.body.classification
    : "sin_clasificacion";
  const observation = typeof req.body.observation === "string" ? req.body.observation.trim().slice(0, 1200) : "";
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      UPDATE patients
      SET operational_classification = $2,
          operational_classification_observation = $3,
          operational_classification_at = NOW(),
          operational_classification_by = $4,
          updated_at = NOW()
      WHERE id = $1 AND organization_id = $5 AND deleted_at IS NULL
      RETURNING id, full_name, operational_classification, operational_classification_observation
    `, [req.params.id, classification, observation || null, req.user.id, req.user.organizationId]);
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Paciente no encontrado" });
    }
    await client.query(`
      INSERT INTO patient_classification_history (organization_id, patient_id, classification, observation, created_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.user.organizationId, req.params.id, classification, observation || null, req.user.id]);
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  }
  catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  finally {
    client.release();
  }
}));

router.put("/:id/medical-conditions", asyncHandler(async (req, res) => {
  const conditions = Array.isArray(req.body.conditions) ? req.body.conditions : [];
  const cleanConditions = conditions
    .map(item => {
      const key = String(item.conditionKey || item.condition_key || "").trim();
      return MEDICAL_CONDITIONS[key] ? {
        key,
        label: MEDICAL_CONDITIONS[key],
        observation: String(item.observation || "").trim().slice(0, 1000)
      } : null;
    })
    .filter(Boolean);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const patient = await client.query(
      "SELECT id FROM patients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
      [req.params.id, req.user.organizationId]
    );
    if (!patient.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Paciente no encontrado" });
    }
    await client.query(`
      UPDATE patient_medical_conditions
      SET active = false, updated_at = NOW()
      WHERE patient_id = $1 AND organization_id = $2 AND active = true
    `, [req.params.id, req.user.organizationId]);
    for (const item of cleanConditions) {
      await client.query(`
        INSERT INTO patient_medical_conditions (organization_id, patient_id, condition_key, condition_label, observation, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [req.user.organizationId, req.params.id, item.key, item.label, item.observation || null, req.user.id]);
    }
    await client.query("COMMIT");
    return res.json({ patientId: req.params.id, conditions: cleanConditions });
  }
  catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  finally {
    client.release();
  }
}));

router.patch("/:id/status", asyncHandler(async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["Pendiente", "Confirmada", "Completada", "Cancelada"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "Estado invalido" });
  }

  const params = [req.params.id, status, req.user.organizationId];
  let where = "id = $1 AND organization_id = $3";

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    where += ` AND doctor_id = $${params.length}`;
  }

  const result = await db.query(`
    UPDATE patients
    SET status = $2, updated_at = NOW()
    WHERE ${where} AND deleted_at IS NULL
    RETURNING *
  `, params);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Paciente no encontrado" });
  }

  return res.json(result.rows[0]);
}));

router.delete("/:id", allowRoles("head_admin", "admin", "recepcion"), asyncHandler(async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query(`
      UPDATE patients
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
      RETURNING id
    `, [req.params.id, req.user.organizationId]);

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Paciente no encontrado" });
    }

    await client.query(`
      DELETE FROM notifications
      WHERE organization_id = $2 AND entity_type = 'patient' AND entity_id = $1
    `, [req.params.id, req.user.organizationId]);

    await client.query("COMMIT");
    return res.status(204).send();
  }
  catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  finally {
    client.release();
  }
}));

module.exports = router;
