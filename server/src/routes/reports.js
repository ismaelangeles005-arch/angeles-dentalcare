const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, allowRoles("head_admin", "admin"));

router.get("/summary", asyncHandler(async (req, res) => {
  const { from, to, doctorId } = req.query;
  const params = [req.user.organizationId];
  const patientWhere = ["p.deleted_at IS NULL", "p.organization_id = $1"];
  const appointmentWhere = ["a.deleted_at IS NULL", "a.organization_id = $1"];

  if (from) {
    params.push(from);
    patientWhere.push(`p.appointment_date >= $${params.length}`);
    appointmentWhere.push(`a.appointment_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    patientWhere.push(`p.appointment_date <= $${params.length}`);
    appointmentWhere.push(`a.appointment_date <= $${params.length}`);
  }
  if (doctorId) {
    params.push(doctorId);
    patientWhere.push(`p.doctor_id = $${params.length}`);
    appointmentWhere.push(`a.doctor_id = $${params.length}`);
  }

  const [patients, appointments, doctors] = await Promise.all([
    db.query(`SELECT status, COUNT(*)::int AS total FROM patients p WHERE ${patientWhere.join(" AND ")} GROUP BY status`, params),
    db.query(`SELECT status, COUNT(*)::int AS total FROM appointments a WHERE ${appointmentWhere.join(" AND ")} GROUP BY status`, params),
    db.query(`
      SELECT d.id, d.name, COUNT(a.id)::int AS total
      FROM doctors d
      LEFT JOIN appointments a ON a.doctor_id = d.id AND a.organization_id = d.organization_id AND a.deleted_at IS NULL
      WHERE d.active = true AND d.organization_id = $1
      GROUP BY d.id, d.name
      ORDER BY d.name
    `, [req.user.organizationId])
  ]);

  return res.json({ patients: patients.rows, appointments: appointments.rows, doctors: doctors.rows });
}));

module.exports = router;
