const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const { validateStrongPassword } = require("../utils/passwordPolicy");

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

function organizationView(row) {
  return { id: row.id, name: row.name, organizationType: row.organization_type,
    active: row.active, ownerUserId: row.owner_user_id,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

router.param("id", (req, res, next, id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ message: "Identificador no valido" });
  }
  next();
});

router.get("/organizations/:id", asyncHandler(async (req, res) => {
  const result = await db.query(`SELECT id, name, organization_type, active,
    owner_user_id, created_at, updated_at FROM organizations WHERE id = $1`, [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ message: "Organizacion no encontrada" });
  res.json(organizationView(result.rows[0]));
}));

// Target tenant belongs to the event; the authenticated platform user remains the actor.
async function audit(client, req, action, organizationId, payload) {
  await client.query(`INSERT INTO audit_logs
    (organization_id, user_id, action, entity, entity_id, payload)
    VALUES ($1, $2, $3, 'organizations', $1, $4)`,
  [organizationId, req.user.id, action, payload]);
}

router.post("/organizations", asyncHandler(async (req, res) => {
  const organization = req.body?.organization || {};
  const initialUser = req.body?.initialUser || {};
  const name = typeof organization.name === "string" ? organization.name.trim() : "";
  const type = organization.organizationType;
  const username = typeof initialUser.username === "string" ? initialUser.username.trim().toLowerCase() : "";
  const fullName = typeof initialUser.fullName === "string" ? initialUser.fullName.trim() : "";
  const role = type === "INDEPENDENT" ? "owner_doctor" : "head_admin";
  const passwordError = validateStrongPassword(initialUser.password);
  if (!name || name.length > 200 || !["CLINIC", "INDEPENDENT"].includes(type) ||
      !/^[a-z0-9._-]{3,40}$/.test(username) || !fullName || fullName.length > 160 ||
      (initialUser.role !== undefined && initialUser.role !== role)) {
    return res.status(400).json({ message: "Revisa los datos de organizacion y propietario" });
  }
  if (passwordError) return res.status(400).json({ message: passwordError });
  const hash = await bcrypt.hash(initialUser.password, 12);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize this provisioning path; existing unique constraints remain the final guard.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["maelven-platform-create-organization"]);
    const duplicate = await client.query(`SELECT 1 FROM organizations WHERE LOWER(name) = LOWER($1)
      UNION ALL SELECT 1 FROM users WHERE LOWER(username) = $2 LIMIT 1`, [name, username]);
    if (duplicate.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "La organizacion o el usuario ya existe" });
    }
    const org = (await client.query(`INSERT INTO organizations (name, organization_type)
      VALUES ($1, $2) RETURNING id`, [name, type])).rows[0];
    let doctorId = null;
    if (type === "INDEPENDENT") {
      doctorId = (await client.query(`INSERT INTO doctors (organization_id, name)
        VALUES ($1, $2) RETURNING id`, [org.id, fullName])).rows[0].id;
    }
    const user = (await client.query(`INSERT INTO users
      (organization_id, username, full_name, password_hash, role, doctor_id, must_change_password)
      VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [org.id, username, fullName, hash, role, doctorId])).rows[0];
    const updated = (await client.query(`UPDATE organizations SET owner_user_id = $2,
      updated_at = NOW() WHERE id = $1 RETURNING id, name, organization_type, active,
      owner_user_id, created_at, updated_at`, [org.id, user.id])).rows[0];
    await audit(client, req, "platform_create_organization", org.id,
      { initialUserId: user.id, role, doctorId, organizationType: type });
    await client.query("COMMIT");
    return res.status(201).json({ organization: organizationView(updated), initialUser: { id: user.id, role, mustChangePassword: true } });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(error.code === "23505" ? 409 : 500).json({ message: error.code === "23505"
      ? "La organizacion, usuario o perfil profesional ya existe"
      : "No fue posible crear la organizacion; no se guardaron cambios" });
  } finally { client.release(); }
}));

router.patch("/organizations/:id/status", asyncHandler(async (req, res) => {
  if (typeof req.body?.active !== "boolean") return res.status(400).json({ message: "Estado no valido" });
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT id, name, organization_type, active, owner_user_id,
      created_at, updated_at FROM organizations WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Organizacion no encontrada" });
    }
    let updated = current;
    if (current.active !== req.body.active) {
      updated = (await client.query(`UPDATE organizations SET active = $2, updated_at = NOW()
        WHERE id = $1 RETURNING id, name, organization_type, active, owner_user_id, created_at, updated_at`,
      [current.id, req.body.active])).rows[0];
      await audit(client, req, req.body.active ? "platform_activate_organization" : "platform_deactivate_organization",
        current.id, { previousActive: current.active, active: req.body.active });
    }
    await client.query("COMMIT");
    res.json(organizationView(updated));
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "No fue posible cambiar el estado" });
  } finally { client.release(); }
}));

module.exports = router;
