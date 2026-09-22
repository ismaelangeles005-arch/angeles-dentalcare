const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles, hasAnyRole } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");

const router = express.Router();
router.use(authenticate);

const ALLOWED_PROCEDURE_AREAS = new Map([
  ["operatoria", "Operatoria"],
  ["cirugia", "Cirugía"],
  ["endodoncia", "Endodoncia"],
  ["periodoncia", "Periodoncia"],
  ["estetica", "Estética"],
  ["ortodoncia", "Ortodoncia"],
  ["odontopediatria", "Odontopediatría"],
  ["protesis", "Prótesis y rehabilitación"],
  ["evaluacion", "Evaluación y diagnóstico"]
]);

function isAllowedProcedureArea(item) {
  return ALLOWED_PROCEDURE_AREAS.get(item.categoryKey) === item.categoryName;
}

function cleanProcedure(body) {
  return {
    categoryKey: String(body.categoryKey || "").trim().toLowerCase().replace(/[^a-z0-9_\-]/g, "_"),
    categoryName: String(body.categoryName || "").trim(),
    name: String(body.name || "").trim(),
    basePrice: Number(body.basePrice || 0),
    durationMinutes: Number(body.durationMinutes || 30),
    requiresTooth: Boolean(body.requiresTooth),
    active: body.active !== false
  };
}

router.get("/", asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === "true" && hasAnyRole(req.user, ["head_admin", "admin"]);
  const visibility = includeInactive ? "deleted_at IS NULL" : "active = true AND deleted_at IS NULL";
  const result = await db.query(`
    SELECT id, category_key, category_name, name, base_price, duration_minutes, requires_tooth, active
    FROM procedure_catalog
    WHERE organization_id = $1 AND ${visibility}
    ORDER BY category_name, name
  `, [req.user.organizationId]);
  return res.json(result.rows);
}));

router.post("/", allowRoles("head_admin", "admin"), asyncHandler(async (req, res) => {
  const item = cleanProcedure(req.body);
  if (!item.categoryKey || !item.categoryName || !item.name) {
    return res.status(400).json({ message: "Completa categoria y nombre del procedimiento" });
  }
  if (!isAllowedProcedureArea(item)) {
    return res.status(400).json({ message: "Selecciona un area odontologica valida" });
  }
  if (item.basePrice < 0 || ![15, 30, 45, 60, 90, 120].includes(item.durationMinutes)) {
    return res.status(400).json({ message: "Precio o duracion invalida" });
  }
  const result = await db.query(`
    INSERT INTO procedure_catalog (organization_id, category_key, category_name, name, base_price, duration_minutes, requires_tooth, active)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, category_key, category_name, name, base_price, duration_minutes, requires_tooth, active
  `, [req.user.organizationId, item.categoryKey, item.categoryName, item.name, item.basePrice, item.durationMinutes, item.requiresTooth, item.active]);
  await writeAuditLog(req, "create", "procedure_catalog", result.rows[0].id, { name: item.name, basePrice: item.basePrice });
  return res.status(201).json(result.rows[0]);
}));

router.patch("/:id", allowRoles("head_admin", "admin"), asyncHandler(async (req, res) => {
  const item = cleanProcedure(req.body);
  if (!item.categoryKey || !item.categoryName || !item.name) {
    return res.status(400).json({ message: "Completa categoria y nombre del procedimiento" });
  }
  const current = await db.query(`
    SELECT category_key, category_name
    FROM procedure_catalog
    WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
  `, [req.params.id, req.user.organizationId]);
  if (!current.rows.length) {
    return res.status(404).json({ message: "Procedimiento no encontrado" });
  }
  const keepsHistoricalArea = current.rows[0].category_key === item.categoryKey && current.rows[0].category_name === item.categoryName;
  if (!keepsHistoricalArea && !isAllowedProcedureArea(item)) {
    return res.status(400).json({ message: "Selecciona un area odontologica valida" });
  }
  const result = await db.query(`
    UPDATE procedure_catalog
    SET category_key = $3, category_name = $4, name = $5, base_price = $6,
        duration_minutes = $7, requires_tooth = $8, active = $9, updated_at = NOW()
    WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
    RETURNING id, category_key, category_name, name, base_price, duration_minutes, requires_tooth, active
  `, [req.params.id, req.user.organizationId, item.categoryKey, item.categoryName, item.name, item.basePrice, item.durationMinutes, item.requiresTooth, item.active]);
  if (!result.rows.length) {
    return res.status(404).json({ message: "Procedimiento no encontrado" });
  }
  await writeAuditLog(req, "update", "procedure_catalog", req.params.id, { name: item.name, basePrice: item.basePrice });
  return res.json(result.rows[0]);
}));

module.exports = router;
