const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");
const { validateStrongPassword } = require("../utils/passwordPolicy");

function pinLookupHash(pin, organizationId) {
  const secret = process.env.PIN_LOOKUP_SECRET || process.env.JWT_SECRET;
  return crypto.createHmac("sha256", secret).update(`${organizationId}:${pin}`).digest("hex");
}

function validPin(pin) {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

const router = express.Router();

router.use(authenticate);
router.use(allowRoles("head_admin", "admin"));

function assignableRolesFor(user) {
  if (user.role === "head_admin" || user.role === "owner_doctor") {
    return ["admin", "clinic_admin", "doctor", "recepcion", "receptionist", "independent_assistant", "assistant", "cashier"];
  }
  return ["doctor", "recepcion", "receptionist", "assistant", "cashier"];
}

function manageableRoleCondition(user, params) {
  const conditions = ["u.organization_id = $" + params.length];
  if (user.role === "admin" || user.role === "clinic_admin") {
    conditions.push("u.role IN ('doctor', 'recepcion', 'receptionist', 'assistant', 'cashier')");
  }
  else {
    conditions.push("u.role <> 'head_admin'");
  }
  return conditions.join(" AND ");
}

router.get("/", asyncHandler(async (req, res) => {
  const params = [req.user.organizationId];
  let roleFilter = "WHERE u.deleted_at IS NULL AND u.organization_id = $1";

  if (req.user.role === "admin" || req.user.role === "clinic_admin") {
    roleFilter += " AND u.role IN ('doctor', 'recepcion', 'receptionist', 'assistant', 'cashier')";
  }

  const result = await db.query(`
    SELECT
      u.id,
      u.username,
      u.role,
      u.full_name,
      u.doctor_id,
      u.organization_id,
      u.pin_enabled,
      (u.pin_hash IS NOT NULL) AS pin_configured,
      u.pin_locked_until,
      u.active,
      u.created_at,
      d.name AS doctor_name,
      d.specialty
    FROM users u
    LEFT JOIN doctors d ON d.id = u.doctor_id AND d.organization_id = u.organization_id
    ${roleFilter}
    ORDER BY
      CASE u.role
        WHEN 'head_admin' THEN 1
        WHEN 'owner_doctor' THEN 2
        WHEN 'admin' THEN 3
        WHEN 'clinic_admin' THEN 4
        WHEN 'doctor' THEN 5
        ELSE 6
      END,
      u.full_name
  `, params);

  return res.json(result.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const {
    username,
    password,
    role,
    fullName,
    doctorId,
    doctorSpecialty,
    doctorPhone,
    doctorEmail
  } = req.body;
  const cleanUsername = typeof username === "string" ? username.trim().toLowerCase() : "";
  const cleanName = typeof fullName === "string" ? fullName.trim() : "";
  const cleanSpecialty = typeof doctorSpecialty === "string" ? doctorSpecialty.trim() : "";
  const cleanPhone = typeof doctorPhone === "string" ? doctorPhone.trim() : "";
  const cleanEmail = typeof doctorEmail === "string" ? doctorEmail.trim().toLowerCase() : "";
  const allowedRoles = assignableRolesFor(req.user);

  if (!cleanUsername || !cleanName || typeof password !== "string" || !password) {
    return res.status(400).json({ message: "Completa nombre, usuario y contrasena" });
  }

  if (!allowedRoles.includes(role)) {
    return res.status(403).json({ message: "No puedes crear este tipo de usuario" });
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(cleanUsername)) {
    return res.status(400).json({
      message: "El usuario debe tener 3 a 40 caracteres: letras, numeros, punto, guion o guion bajo"
    });
  }

  const passwordError = validateStrongPassword(password);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  if (cleanName.length > 160) {
    return res.status(400).json({ message: "El nombre supera el tamano permitido" });
  }

  const createsDoctorProfile = role === "doctor" || role === "owner_doctor";
  if (createsDoctorProfile) {
    if (!doctorId && !cleanSpecialty) {
      return res.status(400).json({ message: "Selecciona la especialidad del doctor" });
    }

    if (cleanSpecialty.length > 120 || cleanPhone.length > 40 || cleanEmail.length > 160) {
      return res.status(400).json({ message: "Uno de los campos del doctor supera el tamano permitido" });
    }

    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ message: "El correo profesional no es valido" });
    }
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    let linkedDoctorId = null;

    if (createsDoctorProfile) {
      if (doctorId) {
        const doctor = await client.query(
          "SELECT id FROM doctors WHERE id = $1 AND organization_id = $2 AND active = true",
          [doctorId, req.user.organizationId]
        );

        if (!doctor.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Perfil de doctor no encontrado" });
        }

        const linkedUser = await client.query(`
          SELECT id
          FROM users
          WHERE doctor_id = $1 AND organization_id = $2 AND active = true AND deleted_at IS NULL
          LIMIT 1
        `, [doctorId, req.user.organizationId]);

        if (linkedUser.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({ message: "Ese perfil de doctor ya tiene un usuario activo" });
        }

        linkedDoctorId = doctorId;
      }
      else {
        const doctorResult = await client.query(`
          INSERT INTO doctors (organization_id, name, specialty, phone, email)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, name, specialty
        `, [req.user.organizationId, cleanName, cleanSpecialty || null, cleanPhone || null, cleanEmail || null]);

        linkedDoctorId = doctorResult.rows[0].id;
      }
    }

    const result = await client.query(`
      INSERT INTO users (organization_id, username, password_hash, role, full_name, doctor_id, must_change_password)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING id, username, role, full_name, doctor_id, active, created_at
    `, [req.user.organizationId, cleanUsername, passwordHash, role, cleanName, linkedDoctorId]);

    if (linkedDoctorId && createsDoctorProfile && !doctorId) {
      await client.query(`
        INSERT INTO audit_logs (organization_id, user_id, action, entity, entity_id, payload)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        req.user.organizationId,
        req.user.id,
        "create",
        "doctors",
        linkedDoctorId,
        { name: cleanName, specialty: cleanSpecialty || null, createdFromUser: cleanUsername }
      ]);
    }

    await client.query(`
      INSERT INTO audit_logs (organization_id, user_id, action, entity, entity_id, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      req.user.organizationId,
      req.user.id,
      "create",
      "users",
      result.rows[0].id,
      { username: cleanUsername, role, doctorId: linkedDoctorId }
    ]);

    await client.query("COMMIT");
    return res.status(201).json(result.rows[0]);
  }
  catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({ message: "Ese nombre de usuario ya existe" });
    }
    throw error;
  }
  finally {
    client.release();
  }
}));

router.patch("/:id/pin", asyncHandler(async (req, res) => {
  const { pin, confirmPin, enabled } = req.body;

  if (!validPin(pin) || pin !== confirmPin) {
    return res.status(400).json({ message: "El PIN debe tener 4 digitos y coincidir con la confirmacion" });
  }

  const lookupHash = pinLookupHash(pin, req.user.organizationId);
  const duplicate = await db.query(`
    SELECT id
    FROM users
    WHERE organization_id = $1
      AND pin_lookup_hash = $2
      AND id <> $3
      AND active = true
      AND deleted_at IS NULL
    LIMIT 1
  `, [req.user.organizationId, lookupHash, req.params.id]);

  if (duplicate.rows.length) {
    return res.status(409).json({ message: "Ese PIN ya esta asignado a otro usuario de esta organizacion" });
  }

  const pinHash = await bcrypt.hash(pin, 12);
  const params = [pinHash, lookupHash, enabled !== false, req.params.id, req.user.organizationId];
  const result = await db.query(`
    UPDATE users u
    SET pin_hash = $1,
        pin_lookup_hash = $2,
        pin_enabled = $3,
        failed_pin_attempts = 0,
        pin_locked_until = NULL,
        updated_at = NOW()
    WHERE u.id = $4
      AND ${manageableRoleCondition(req.user, params)}
      AND u.deleted_at IS NULL
    RETURNING id, pin_enabled, (pin_hash IS NOT NULL) AS pin_configured
  `, params);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Usuario no encontrado o protegido" });
  }

  await writeAuditLog(req, "set_pin", "users", req.params.id, { enabled: enabled !== false });
  return res.json(result.rows[0]);
}));

router.patch("/:id/pin/status", asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ message: "Estado de PIN invalido" });
  }

  const params = [enabled, req.params.id, req.user.organizationId];
  const result = await db.query(`
    UPDATE users u
    SET pin_enabled = $1,
        failed_pin_attempts = 0,
        pin_locked_until = NULL,
        updated_at = NOW()
    WHERE u.id = $2
      AND u.pin_hash IS NOT NULL
      AND ${manageableRoleCondition(req.user, params)}
      AND u.deleted_at IS NULL
    RETURNING id, pin_enabled, (pin_hash IS NOT NULL) AS pin_configured
  `, params);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Usuario no encontrado o sin PIN configurado" });
  }

  await writeAuditLog(req, enabled ? "enable_pin" : "disable_pin", "users", req.params.id);
  return res.json(result.rows[0]);
}));
router.patch("/:id/status", asyncHandler(async (req, res) => {
  const { active } = req.body;

  if (typeof active !== "boolean") {
    return res.status(400).json({ message: "Estado de usuario invalido" });
  }

  if (req.params.id === req.user.id && !active) {
    return res.status(400).json({ message: "No puedes desactivar tu propia cuenta" });
  }

  const params = [req.params.id, active, req.user.organizationId];
  const result = await db.query(`
    UPDATE users u
    SET active = $2, updated_at = NOW()
    WHERE u.id = $1
      AND ${manageableRoleCondition(req.user, params)}
      AND u.deleted_at IS NULL
    RETURNING id, active, role, doctor_id
  `, params);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Usuario no encontrado o protegido" });
  }

  if (["doctor", "owner_doctor"].includes(result.rows[0].role) && result.rows[0].doctor_id) {
    await db.query(
      "UPDATE doctors SET active = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3",
      [active, result.rows[0].doctor_id, req.user.organizationId]
    );
  }

  await writeAuditLog(req, active ? "activate" : "deactivate", "users", req.params.id, {
    doctorId: result.rows[0].doctor_id || null
  });

  return res.json(result.rows[0]);
}));

router.patch("/:id/password", asyncHandler(async (req, res) => {
  const { password } = req.body;
  const passwordError = validateStrongPassword(password);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const params = [passwordHash, req.params.id, req.user.organizationId];
  const result = await db.query(`
    UPDATE users u
    SET password_hash = $1, must_change_password = true, updated_at = NOW()
    WHERE u.id = $2
      AND ${manageableRoleCondition(req.user, params)}
      AND u.deleted_at IS NULL
    RETURNING id
  `, params);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Usuario no encontrado o protegido" });
  }

  await writeAuditLog(req, "reset_password", "users", req.params.id);
  return res.status(204).send();
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ message: "No puedes eliminar tu propia cuenta" });
  }

  const params = [req.params.id, req.user.organizationId];
  const result = await db.query(`
    UPDATE users u
    SET active = false, deleted_at = NOW(), updated_at = NOW()
    WHERE u.id = $1
      AND u.active = false
      AND ${manageableRoleCondition(req.user, params)}
      AND u.deleted_at IS NULL
    RETURNING id, username, role, doctor_id
  `, params);

  if (!result.rows.length) {
    return res.status(400).json({ message: "Solo puedes eliminar usuarios desactivados y no protegidos" });
  }

  if (["doctor", "owner_doctor"].includes(result.rows[0].role) && result.rows[0].doctor_id) {
    await db.query(
      "UPDATE doctors SET active = false, updated_at = NOW() WHERE id = $1 AND organization_id = $2",
      [result.rows[0].doctor_id, req.user.organizationId]
    );
  }

  await writeAuditLog(req, "delete", "users", req.params.id, {
    username: result.rows[0].username,
    role: result.rows[0].role,
    doctorId: result.rows[0].doctor_id
  });

  return res.status(204).send();
}));

module.exports = router;


