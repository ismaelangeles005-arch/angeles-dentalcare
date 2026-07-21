const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");

const router = express.Router();

router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  const params = [req.user.organizationId];
  let where = "WHERE v.deleted_at IS NULL AND v.organization_id = $1";

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    where += ` AND v.doctor_id = $${params.length}`;
  }
  else if (req.query.doctorId) {
    params.push(req.query.doctorId);
    where += ` AND v.doctor_id = $${params.length}`;
  }

  const result = await db.query(`
    SELECT
      v.id,
      v.doctor_id,
      d.name AS doctor,
      TO_CHAR(v.work_date, 'YYYY-MM-DD') AS fecha,
      v.status,
      v.max_patients,
      v.note,
      v.created_at
    FROM doctor_availability v
    JOIN doctors d ON d.id = v.doctor_id AND d.organization_id = v.organization_id
    ${where}
    ORDER BY v.work_date DESC, d.name
    LIMIT 120
  `, params);

  return res.json(result.rows);
}));

router.post("/", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  const { doctorId, fecha, status, maxPatients, note } = req.body;
  const effectiveDoctorId = req.user.isDoctor ? req.user.doctorId : doctorId;
  const validStatus = ["libre", "limitado"];
  const cleanStatus = typeof status === "string" ? status.trim().toLowerCase() : "";
  const cleanNote = typeof note === "string" ? note.trim().slice(0, 300) : "";
  const limit = Number(maxPatients);

  if (!effectiveDoctorId || !fecha || !validStatus.includes(cleanStatus)) {
    return res.status(400).json({ message: "Completa doctor, fecha y tipo de aviso" });
  }

  if (cleanStatus === "limitado" && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    return res.status(400).json({ message: "Indica cuantos pacientes atendera ese dia" });
  }

  const doctor = await db.query(
    "SELECT id FROM doctors WHERE id = $1 AND organization_id = $2 AND active = true LIMIT 1",
    [effectiveDoctorId, req.user.organizationId]
  );

  if (!doctor.rows.length) {
    return res.status(404).json({ message: "Doctor no encontrado" });
  }

  const result = await db.query(`
    INSERT INTO doctor_availability (organization_id, doctor_id, work_date, status, max_patients, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (doctor_id, work_date)
    WHERE deleted_at IS NULL
    DO UPDATE SET
      status = EXCLUDED.status,
      max_patients = EXCLUDED.max_patients,
      note = EXCLUDED.note,
      created_by = EXCLUDED.created_by,
      updated_at = NOW()
    RETURNING *
  `, [
    req.user.organizationId,
    effectiveDoctorId,
    fecha,
    cleanStatus,
    cleanStatus === "limitado" ? limit : null,
    cleanNote || null,
    req.user.id
  ]);

  await writeAuditLog(req, "upsert", "doctor_availability", result.rows[0].id, {
    doctorId: effectiveDoctorId,
    fecha,
    status: cleanStatus,
    maxPatients: cleanStatus === "limitado" ? limit : null
  });

  return res.status(201).json(result.rows[0]);
}));

router.delete("/:id", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  const params = [req.params.id, req.user.organizationId];
  let doctorCondition = "";

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    doctorCondition = `AND doctor_id = $${params.length}`;
  }

  const result = await db.query(`
    UPDATE doctor_availability
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND organization_id = $2 ${doctorCondition} AND deleted_at IS NULL
    RETURNING id
  `, params);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Aviso no encontrado" });
  }

  await writeAuditLog(req, "delete", "doctor_availability", req.params.id);
  return res.status(204).send();
}));

module.exports = router;
