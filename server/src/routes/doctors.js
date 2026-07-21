const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");

const router = express.Router();

router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT id, name, specialty, phone, email, active
    FROM doctors
    WHERE active = true
      AND organization_id = $1
    ORDER BY name
  `, [req.user.organizationId]);

  return res.json(result.rows);
}));

router.post("/", allowRoles("head_admin", "admin"), asyncHandler(async (req, res) => {
  const { name, specialty, phone, email } = req.body;
  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanSpecialty = typeof specialty === "string" ? specialty.trim() : "";
  const cleanPhone = typeof phone === "string" ? phone.trim() : "";
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

  if (!cleanName) {
    return res.status(400).json({ message: "El nombre del doctor es requerido" });
  }

  if (cleanName.length > 160 || cleanSpecialty.length > 120 ||
      cleanPhone.length > 40 || cleanEmail.length > 160) {
    return res.status(400).json({ message: "Uno de los campos supera el tamano permitido" });
  }

  try {
    const result = await db.query(`
      INSERT INTO doctors (organization_id, name, specialty, phone, email)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [req.user.organizationId, cleanName, cleanSpecialty || null, cleanPhone || null, cleanEmail || null]);

    await writeAuditLog(req, "create", "doctors", result.rows[0].id, {
      name: cleanName,
      specialty: cleanSpecialty || null
    });

    return res.status(201).json(result.rows[0]);
  }
  catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "Ya existe un perfil con ese nombre" });
    }
    throw error;
  }
}));

module.exports = router;
