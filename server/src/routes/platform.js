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
  const result = await db.query(`SELECT o.id, o.name, o.organization_type, o.active,
    o.owner_user_id, o.created_at, o.updated_at,
    owner.id AS owner_id, owner.full_name AS owner_full_name,
    owner.username AS owner_username, owner.role AS owner_role, owner.active AS owner_active,
    counts.total_users, counts.active_users, counts.inactive_users
    FROM organizations o
    LEFT JOIN users owner ON owner.id = o.owner_user_id AND owner.organization_id = o.id
      AND owner.role <> 'PLATFORM_SUPER_ADMIN' AND owner.deleted_at IS NULL
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE u.active = true)::int AS active_users,
        COUNT(*) FILTER (WHERE u.active = false)::int AS inactive_users
      FROM users u WHERE u.organization_id = o.id
        AND u.role <> 'PLATFORM_SUPER_ADMIN' AND u.deleted_at IS NULL
    ) counts
    WHERE o.id = $1`, [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ message: "Organizacion no encontrada" });
  const row = result.rows[0];
  // Keep the existing flat structural contract; add only safe administrative detail.
  res.json({ ...organizationView(row),
    summary: { totalUsers: row.total_users, activeUsers: row.active_users, inactiveUsers: row.inactive_users },
    owner: row.owner_id ? { id: row.owner_id, fullName: row.owner_full_name,
      username: row.owner_username, role: row.owner_role, active: row.owner_active } : null,
    ownerState: row.owner_id ? "AVAILABLE" : row.owner_user_id ? "UNAVAILABLE" : "UNASSIGNED"
  });
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

const ORGANIZATION_USER_ROLES = Object.freeze({
  CLINIC: ["head_admin", "admin", "clinic_admin", "doctor", "recepcion", "receptionist", "assistant", "cashier"],
  INDEPENDENT: ["owner_doctor", "independent_assistant", "assistant", "receptionist"]
});

router.param("userId", (req, res, next, id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ message: "Identificador no valido" });
  }
  next();
});

router.get("/organizations/:id/users", asyncHandler(async (req, res) => {
  const org = (await db.query("SELECT id, organization_type, owner_user_id, active FROM organizations WHERE id = $1", [req.params.id])).rows[0];
  if (!org) return res.status(404).json({ message: "Organizacion no encontrada" });
  const result = await db.query(`SELECT u.id, u.username, u.full_name, u.role, u.active,
    u.doctor_id, d.name AS doctor_name, u.must_change_password,
    (u.pin_hash IS NOT NULL) AS pin_configured, u.pin_enabled,
    COALESCE(u.pin_locked_until > NOW(), false) AS pin_locked, u.failed_pin_attempts,
    u.last_login_at, u.created_at
    FROM users u LEFT JOIN doctors d ON d.id = u.doctor_id AND d.organization_id = u.organization_id
    WHERE u.organization_id = $1 AND u.deleted_at IS NULL AND u.role <> 'PLATFORM_SUPER_ADMIN'
    ORDER BY u.active DESC, u.full_name, u.id`, [org.id]);
  res.json({ allowedRoles: ORGANIZATION_USER_ROLES[org.organization_type] || [], ownerUserId: org.owner_user_id,
    organizationActive: org.active,
    users: result.rows.map(u => ({ id: u.id, username: u.username, fullName: u.full_name, role: u.role,
      active: u.active, doctorId: u.doctor_id, doctorName: u.doctor_name,
      mustChangePassword: u.must_change_password, pinConfigured: u.pin_configured, pinEnabled: u.pin_enabled,
      pinLocked: u.pin_locked, failedPinAttempts: u.failed_pin_attempts,
      lastLoginAt: u.last_login_at, createdAt: u.created_at })) });
}));

function userError(status, message) { return Object.assign(new Error(message), { publicStatus: status }); }

// All new platform user mutations share one dedicated connection, including their audit.
async function mutateOrganizationUser(req, res, operation, successStatus = 200) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const org = (await client.query(`SELECT id, organization_type, owner_user_id, active
      FROM organizations WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!org) throw userError(404, "Organizacion no encontrada");
    const result = await operation(client, org);
    await client.query("COMMIT");
    res.status(successStatus).json(result);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(error.publicStatus || (error.code === "23505" ? 409 : 500)).json({ message: error.publicStatus
      ? error.message : error.code === "23505" ? "El usuario o perfil profesional ya existe"
        : "No fue posible guardar los cambios" });
  } finally { client.release(); }
}

async function lockedTenantUser(client, orgId, userId) {
  const user = (await client.query(`SELECT id, username, role, active, doctor_id FROM users
    WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
      AND role <> 'PLATFORM_SUPER_ADMIN' FOR UPDATE`, [userId, orgId])).rows[0];
  if (!user) throw userError(404, "Usuario no encontrado");
  return user;
}

router.post("/organizations/:id/users", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const text = key => typeof body[key] === "string" ? body[key].trim() : "";
  const username = text("username").toLowerCase(), fullName = text("fullName"), role = text("role");
  const specialty = text("doctorSpecialty"), phone = text("doctorPhone"), email = text("doctorEmail").toLowerCase();
  const doctorRole = ["doctor", "owner_doctor"].includes(role);
  const passwordError = validateStrongPassword(body.password);
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (!/^[a-z0-9._-]{3,40}$/.test(username) || !fullName || fullName.length > 160 ||
      (doctorRole && (!specialty || specialty.length > 120 || phone.length > 40 || email.length > 160 ||
        (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))))) {
    return res.status(400).json({ message: "Revisa nombre, usuario y datos del doctor" });
  }
  const hash = await bcrypt.hash(body.password, 12);
  await mutateOrganizationUser(req, res, async (client, org) => {
    if (!org.active) throw userError(409, "Activa la organizacion antes de crear usuarios");
    if (!(ORGANIZATION_USER_ROLES[org.organization_type] || []).includes(role)) throw userError(400, "Rol no permitido para esta organizacion");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["maelven-platform-create-organization"]);
    if ((await client.query("SELECT id FROM users WHERE LOWER(username) = $1 LIMIT 1", [username])).rows.length) {
      throw userError(409, "El nombre de usuario ya existe");
    }
    let doctorId = null;
    if (doctorRole) doctorId = (await client.query(`INSERT INTO doctors (organization_id, name, specialty, phone, email)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [org.id, fullName, specialty, phone || null, email || null])).rows[0].id;
    const user = (await client.query(`INSERT INTO users
      (organization_id, username, full_name, password_hash, role, doctor_id, must_change_password)
      VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`, [org.id, username, fullName, hash, role, doctorId])).rows[0];
    await audit(client, req, "platform_create_user", org.id, { targetUserId: user.id, username, role, doctorId });
    return { id: user.id, username, fullName, role, doctorId, mustChangePassword: true };
  }, 201);
}));

router.patch("/organizations/:id/users/:userId/status", asyncHandler(async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== "boolean") return res.status(400).json({ message: "Estado no valido" });
  await mutateOrganizationUser(req, res, async (client, org) => {
    const user = await lockedTenantUser(client, org.id, req.params.userId);
    if (!active && user.id === org.owner_user_id) throw userError(409, "No se puede desactivar al propietario actual");
    if (user.active === active) return { id: user.id, active };
    if (["doctor", "owner_doctor"].includes(user.role) && user.doctor_id) {
      const doctor = await client.query("SELECT id FROM doctors WHERE id = $1 AND organization_id = $2 FOR UPDATE", [user.doctor_id, org.id]);
      if (!doctor.rows.length) throw userError(409, "El vinculo del doctor requiere revision");
      const shared = await client.query("SELECT id FROM users WHERE doctor_id = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1", [user.doctor_id, user.id]);
      if (shared.rows.length) throw userError(409, "El perfil de doctor esta vinculado a otro usuario");
      await client.query("UPDATE doctors SET active = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3", [active, user.doctor_id, org.id]);
    }
    await client.query("UPDATE users SET active = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3", [active, user.id, org.id]);
    await audit(client, req, active ? "platform_activate_user" : "platform_deactivate_user", org.id,
      { targetUserId: user.id, role: user.role, active });
    return { id: user.id, active };
  });
}));

router.patch("/organizations/:id/users/:userId/password", asyncHandler(async (req, res) => {
  const passwordError = validateStrongPassword(req.body?.password);
  if (passwordError) return res.status(400).json({ message: passwordError });
  const hash = await bcrypt.hash(req.body.password, 12);
  await mutateOrganizationUser(req, res, async (client, org) => {
    const user = await lockedTenantUser(client, org.id, req.params.userId);
    await client.query(`UPDATE users SET password_hash = $1, must_change_password = true, updated_at = NOW()
      WHERE id = $2 AND organization_id = $3`, [hash, user.id, org.id]);
    await audit(client, req, "platform_reset_user_password", org.id, { targetUserId: user.id, role: user.role });
    return { id: user.id, mustChangePassword: true };
  });
}));

async function securityMutation(req, res, action, operation) {
  await mutateOrganizationUser(req, res, async (client, org) => {
    const user = await lockedTenantUser(client, org.id, req.params.userId);
    const result = await operation(client, org, user);
    await audit(client, req, action, org.id, { targetUserId: user.id, username: user.username,
      ...(typeof result.pinEnabled === "boolean" ? { enabled: result.pinEnabled } : {}) });
    return { id: user.id, ...result };
  });
}

router.patch("/organizations/:id/users/:userId/pin", asyncHandler(async (req, res) => {
  // Reuse the exact validation and organization-bound lookup used by tenant login.
  const { validPin, pinLookupHash } = require("./auth");
  const { pin, enabled = true } = req.body || {};
  if (!validPin(pin) || typeof enabled !== "boolean") return res.status(400).json({ message: "El PIN debe tener cuatro digitos y el estado debe ser valido" });
  await securityMutation(req, res, "platform_set_user_pin", async (client, org, user) => {
    const lookup = pinLookupHash(pin, org.id);
    const duplicate = await client.query(`SELECT id FROM users WHERE organization_id = $1
      AND pin_lookup_hash = $2 AND id <> $3 AND active = true AND deleted_at IS NULL LIMIT 1`, [org.id, lookup, user.id]);
    if (duplicate.rows.length) throw userError(409, "Ese PIN no esta disponible en esta organizacion");
    const hash = await bcrypt.hash(pin, 12);
    try {
      await client.query(`UPDATE users SET pin_hash = $1, pin_lookup_hash = $2, pin_enabled = $3,
        failed_pin_attempts = 0, pin_locked_until = NULL, updated_at = NOW()
        WHERE id = $4 AND organization_id = $5`, [hash, lookup, enabled, user.id, org.id]);
    } catch (error) {
      if (error.code === "23505") throw userError(409, "Ese PIN no esta disponible en esta organizacion");
      throw error;
    }
    return { pinConfigured: true, pinEnabled: enabled, pinLocked: false, failedPinAttempts: 0 };
  });
}));

router.patch("/organizations/:id/users/:userId/pin/status", asyncHandler(async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ message: "Estado de PIN invalido" });
  await securityMutation(req, res, enabled ? "platform_enable_user_pin" : "platform_disable_user_pin", async (client, org, user) => {
    const current = (await client.query(`SELECT (pin_hash IS NOT NULL AND pin_lookup_hash IS NOT NULL) AS configured
      FROM users WHERE id = $1 AND organization_id = $2`, [user.id, org.id])).rows[0];
    if (enabled && !current?.configured) throw userError(409, "Primero asigna un PIN al usuario");
    try {
      // Preserve lock state: unlock is an explicit, separately audited action.
      await client.query(`UPDATE users SET pin_enabled = $1, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3`, [enabled, user.id, org.id]);
    } catch (error) {
      if (error.code === "23505") throw userError(409, "Ese PIN no esta disponible en esta organizacion");
      throw error;
    }
    return { pinEnabled: enabled };
  });
}));

router.post("/organizations/:id/users/:userId/pin/unlock", asyncHandler(async (req, res) => {
  await securityMutation(req, res, "platform_unlock_user_pin", async (client, org, user) => {
    await client.query(`UPDATE users SET failed_pin_attempts = 0, pin_locked_until = NULL, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2`, [user.id, org.id]);
    return { pinLocked: false, failedPinAttempts: 0 };
  });
}));

router.patch("/organizations/:id/users/:userId/password/force-change", asyncHandler(async (req, res) => {
  if (req.body?.required !== undefined && req.body.required !== true) return res.status(400).json({ message: "Solo se permite exigir el cambio de contrasena" });
  await securityMutation(req, res, "platform_force_password_change", async (client, org, user) => {
    await client.query(`UPDATE users SET must_change_password = true, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2`, [user.id, org.id]);
    return { mustChangePassword: true };
  });
}));


router.patch("/organizations/:id/owner", asyncHandler(async (req, res) => {
  const userId = req.body?.userId;
  if (typeof userId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return res.status(400).json({ message: "Usuario objetivo no valido" });
  }
  await mutateOrganizationUser(req, res, async (client, org) => {
    const user = (await client.query(`SELECT id, full_name, username, role, active FROM users
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND active = true
        AND role <> 'PLATFORM_SUPER_ADMIN' FOR UPDATE`, [userId, org.id])).rows[0];
    if (!user) throw userError(404, "Usuario elegible no encontrado");
    const roles = org.organization_type === "CLINIC" ? ["head_admin", "admin", "clinic_admin"]
      : org.organization_type === "INDEPENDENT" ? ["owner_doctor"] : [];
    if (!roles.includes(user.role)) throw userError(409, "El rol del usuario no permite asignarlo como propietario");
    if (org.owner_user_id !== user.id) {
      await client.query("UPDATE organizations SET owner_user_id = $2, updated_at = NOW() WHERE id = $1", [org.id, user.id]);
      await audit(client, req, "platform_change_organization_owner", org.id,
        { previousOwnerUserId: org.owner_user_id, targetUserId: user.id });
    }
    return { organizationId: org.id, owner: { id: user.id, fullName: user.full_name,
      username: user.username, role: user.role, active: user.active } };
  });
}));

router.get("/audit", asyncHandler(async (req, res) => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const organizationId = typeof req.query.organizationId === "string" ? req.query.organizationId.trim() : "";
  const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
  const actor = typeof req.query.actor === "string" ? req.query.actor.trim() : "";
  const targetUserId = typeof req.query.targetUserId === "string" ? req.query.targetUserId.trim() : "";
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";

  if (organizationId && !uuid.test(organizationId)) {
    return res.status(400).json({ message: "Organizacion no valida" });
  }
  if (targetUserId && !uuid.test(targetUserId)) {
    return res.status(400).json({ message: "Usuario objetivo no valido" });
  }
  if (action && !/^[a-z0-9_]{1,80}$/i.test(action)) {
    return res.status(400).json({ message: "Accion no valida" });
  }
  if (actor.length > 160) {
    return res.status(400).json({ message: "Filtro de actor no valido" });
  }

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    return res.status(400).json({ message: "Rango de fechas no valido" });
  }
  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({ message: "Rango de fechas no valido" });
  }

  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const requestedOffset = Number.parseInt(req.query.offset, 10);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

  const where = ["l.action LIKE 'platform_%'"];
  const values = [];

  const add = (sql, value) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };

  if (organizationId) add("l.organization_id = ?", organizationId);
  if (action) add("l.action = ?", action);
  if (targetUserId) add("l.payload ->> 'targetUserId' = ?", targetUserId);
  if (actor) {
    values.push(`%${actor}%`);
    where.push(`(actor.username ILIKE $${values.length} OR actor.full_name ILIKE $${values.length})`);
  }
  if (fromDate) add("l.created_at >= ?", fromDate.toISOString());
  if (toDate) add("l.created_at <= ?", toDate.toISOString());

  values.push(limit + 1);
  const limitParameter = `$${values.length}`;
  values.push(offset);
  const offsetParameter = `$${values.length}`;

  const result = await db.query(`
    SELECT
      l.id,
      l.action,
      l.entity,
      l.entity_id,
      l.created_at,
      o.id AS organization_id,
      o.name AS organization_name,
      o.organization_type,
      actor.id AS actor_id,
      actor.username AS actor_username,
      actor.full_name AS actor_full_name,
      actor.role AS actor_role,
      target.id AS target_user_id,
      target.username AS target_username,
      target.full_name AS target_full_name,
      target.role AS target_role
    FROM audit_logs l
    LEFT JOIN organizations o ON o.id = l.organization_id
    LEFT JOIN users actor
      ON actor.id = l.user_id
      AND actor.role = 'PLATFORM_SUPER_ADMIN'
      AND actor.organization_id IS NULL
    LEFT JOIN users target
      ON target.id::text = l.payload ->> 'targetUserId'
      AND target.organization_id = l.organization_id
    WHERE ${where.join(" AND ")}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limitParameter}
    OFFSET ${offsetParameter}
  `, values);

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

  return res.json({
    events: rows.map(row => ({
      id: row.id,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      createdAt: row.created_at,
      organization: row.organization_id ? {
        id: row.organization_id,
        name: row.organization_name,
        organizationType: row.organization_type
      } : null,
      actor: row.actor_id ? {
        id: row.actor_id,
        username: row.actor_username,
        fullName: row.actor_full_name,
        role: row.actor_role
      } : null,
      targetUser: row.target_user_id ? {
        id: row.target_user_id,
        username: row.target_username,
        fullName: row.target_full_name,
        role: row.target_role
      } : null
    })),
    pagination: {
      limit,
      offset,
      hasMore
    }
  });
}));
module.exports = router;
