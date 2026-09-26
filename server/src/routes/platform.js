const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);

router.use((req, res, next) => {
  if (
    req.user.role !== "PLATFORM_SUPER_ADMIN" ||
    req.user.scope !== "PLATFORM" ||
    req.user.organizationId !== null
  ) {
    return res.status(403).json({
      code: "PLATFORM_ACCESS_REQUIRED",
      message: "Se requiere acceso de administracion de plataforma"
    });
  }

  return next();
});

router.get("/status", asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total_organizations,
      COUNT(*) FILTER (WHERE active = true)::int AS active_organizations,
      COUNT(*) FILTER (WHERE active = false)::int AS inactive_organizations,
      COUNT(*) FILTER (WHERE organization_type = 'CLINIC')::int AS clinics,
      COUNT(*) FILTER (WHERE organization_type = 'INDEPENDENT')::int AS independent
    FROM organizations
  `);

  const platformResult = await db.query(`
    SELECT COUNT(*)::int AS platform_admins
    FROM users
    WHERE role = 'PLATFORM_SUPER_ADMIN'
      AND organization_id IS NULL
      AND active = true
      AND deleted_at IS NULL
  `);

  return res.json({
    ok: true,
    scope: "PLATFORM",
    organizations: result.rows[0],
    platformAdmins: platformResult.rows[0].platform_admins
  });
}));

router.get("/organizations", asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT
      id,
      name,
      organization_type,
      active,
      created_at,
      updated_at
    FROM organizations
    ORDER BY
      active DESC,
      LOWER(name),
      created_at
  `);

  return res.json({
    organizations: result.rows.map(organization => ({
      id: organization.id,
      name: organization.name,
      organizationType: organization.organization_type,
      active: organization.active,
      createdAt: organization.created_at,
      updatedAt: organization.updated_at
    }))
  });
}));

module.exports = router;