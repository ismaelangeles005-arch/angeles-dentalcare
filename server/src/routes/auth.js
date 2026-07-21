const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");
const { validateStrongPassword } = require("../utils/passwordPolicy");

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Demasiados intentos. Intenta de nuevo en 15 minutos." }
});

const pinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Demasiados intentos. Intenta de nuevo en unos minutos." }
});

const dummyHash = "$2a$12$LQv3c1yqBWQ0w4DncL8nFe9fpma.K2JZF8lQmJzv3N0q5nEqvHU7u";
const MAX_PIN_ATTEMPTS = Number(process.env.PIN_MAX_ATTEMPTS || 5);
const PIN_LOCK_SECONDS = Number(process.env.PIN_LOCK_SECONDS || 30);

function buildTokenPayload(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    doctorId: user.doctor_id,
    doctor: user.doctor_name || user.doctor,
    organizationId: user.organization_id,
    organizationName: user.organization_name,
    organizationType: user.organization_type || "CLINIC",
    mustChangePassword: user.must_change_password
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.full_name,
    doctorId: user.doctor_id,
    doctor_id: user.doctor_id,
    doctor: user.doctor_name,
    organizationId: user.organization_id,
    organization_id: user.organization_id,
    organizationName: user.organization_name,
    organizationType: user.organization_type || "CLINIC",
    operating_mode: user.organization_type || "CLINIC",
    permissions: [],
    mustChangePassword: user.must_change_password
  };
}

function setSessionCookie(res, user) {
  const token = jwt.sign(buildTokenPayload(user), process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "8h"
  });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `dental_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`
  );
}

function pinLookupHash(pin, organizationId) {
  const secret = process.env.PIN_LOOKUP_SECRET || process.env.JWT_SECRET;
  return crypto
    .createHmac("sha256", secret)
    .update(`${organizationId}:${pin}`)
    .digest("hex");
}

function validPin(pin) {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

async function resolveOrganizationId(requestedOrganizationId) {
  if (typeof requestedOrganizationId === "string" && /^[0-9a-f-]{36}$/i.test(requestedOrganizationId)) {
    return requestedOrganizationId;
  }

  const result = await db.query(`
    SELECT id
    FROM organizations
    WHERE active = true
    ORDER BY created_at
    LIMIT 1
  `);
  return result.rows[0]?.id || null;
}

async function loadLoginUserByUsername(username) {
  const result = await db.query(`
    SELECT
      u.id,
      u.username,
      u.password_hash,
      u.role,
      u.full_name,
      u.doctor_id,
      u.organization_id,
      u.must_change_password,
      d.name AS doctor_name,
      o.name AS organization_name,
      o.organization_type
    FROM users u
    LEFT JOIN doctors d ON d.id = u.doctor_id AND d.organization_id = u.organization_id
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE u.username = $1
      AND u.active = true
      AND u.deleted_at IS NULL
      AND (o.id IS NULL OR o.active = true)
    LIMIT 1
  `, [username]);
  return result.rows[0] || null;
}

async function markLoginSuccess(userId) {
  await db.query(`
    UPDATE users
    SET last_login_at = NOW(), last_activity_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `, [userId]);
}

router.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const cleanUsername = typeof username === "string" ? username.trim().toLowerCase() : "";

  if (!cleanUsername || typeof password !== "string" || !password) {
    return res.status(400).json({ message: "Usuario y contrasena son requeridos" });
  }

  if (cleanUsername.length > 80 || password.length > 200) {
    return res.status(400).json({ message: "Credenciales invalidas" });
  }

  const user = await loadLoginUserByUsername(cleanUsername);
  const validPassword = await bcrypt.compare(password, user?.password_hash || dummyHash);

  if (!user || !validPassword) {
    return res.status(401).json({ message: "Credenciales invalidas" });
  }

  await markLoginSuccess(user.id);
  setSessionCookie(res, user);
  return res.json({ user: publicUser(user) });
}));

router.post("/pin-login", pinLimiter, asyncHandler(async (req, res) => {
  const { pin, organizationId } = req.body;

  if (!validPin(pin)) {
    await bcrypt.compare("0000", dummyHash);
    return res.status(401).json({ success: false, message: "Codigo incorrecto" });
  }

  const resolvedOrganizationId = await resolveOrganizationId(organizationId);
  if (!resolvedOrganizationId) {
    await bcrypt.compare(pin, dummyHash);
    return res.status(401).json({ success: false, message: "Codigo incorrecto" });
  }

  const lookupHash = pinLookupHash(pin, resolvedOrganizationId);
  const result = await db.query(`
    SELECT
      u.id,
      u.username,
      u.pin_hash,
      u.failed_pin_attempts,
      u.pin_locked_until,
      u.role,
      u.full_name,
      u.doctor_id,
      u.organization_id,
      u.must_change_password,
      d.name AS doctor_name,
      o.name AS organization_name,
      o.organization_type
    FROM users u
    JOIN organizations o ON o.id = u.organization_id AND o.active = true
    LEFT JOIN doctors d ON d.id = u.doctor_id AND d.organization_id = u.organization_id
    WHERE u.organization_id = $1
      AND u.pin_lookup_hash = $2
      AND u.pin_enabled = true
      AND u.active = true
      AND u.deleted_at IS NULL
    LIMIT 1
  `, [resolvedOrganizationId, lookupHash]);

  const user = result.rows[0];
  if (!user) {
    await bcrypt.compare(pin, dummyHash);
    return res.status(401).json({ success: false, message: "Codigo incorrecto" });
  }

  if (user.pin_locked_until && new Date(user.pin_locked_until).getTime() > Date.now()) {
    return res.status(423).json({
      success: false,
      message: "Acceso bloqueado temporalmente. Intenta de nuevo en unos segundos."
    });
  }

  const ok = await bcrypt.compare(pin, user.pin_hash || dummyHash);
  if (!ok) {
    const attempts = Number(user.failed_pin_attempts || 0) + 1;
    const locked = attempts >= MAX_PIN_ATTEMPTS;
    await db.query(`
      UPDATE users
      SET failed_pin_attempts = $2,
          pin_locked_until = CASE WHEN $3 THEN NOW() + ($4 || ' seconds')::interval ELSE NULL END,
          updated_at = NOW()
      WHERE id = $1
    `, [user.id, locked ? 0 : attempts, locked, PIN_LOCK_SECONDS]);

    return res.status(401).json({ success: false, message: "Codigo incorrecto" });
  }

  await db.query(`
    UPDATE users
    SET failed_pin_attempts = 0,
        pin_locked_until = NULL,
        last_login_at = NOW(),
        last_activity_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `, [user.id]);

  setSessionCookie(res, user);
  return res.json({ success: true, user: publicUser(user) });
}));

router.post("/change-password", authenticate, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (typeof currentPassword !== "string" || !currentPassword) {
    return res.status(400).json({ message: "Escribe tu contrasena actual" });
  }

  const passwordError = validateStrongPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ message: "La nueva contrasena debe ser diferente a la temporal" });
  }

  const result = await db.query(`
    SELECT id, password_hash
    FROM users
    WHERE id = $1 AND active = true AND deleted_at IS NULL
    LIMIT 1
  `, [req.user.id]);

  const user = result.rows[0];
  const validPassword = await bcrypt.compare(currentPassword, user?.password_hash || dummyHash);

  if (!user || !validPassword) {
    return res.status(401).json({ message: "La contrasena actual no es correcta" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.query(`
    UPDATE users
    SET password_hash = $1, must_change_password = false, updated_at = NOW()
    WHERE id = $2
  `, [passwordHash, req.user.id]);

  await writeAuditLog(req, "change_password", "users", req.user.id);

  const payload = {
    id: req.user.id,
    username: req.user.username,
    role: req.user.role,
    doctorId: req.user.doctorId,
    doctor: req.user.doctor,
    organizationId: req.user.organizationId,
    organizationName: req.user.organizationName,
    organizationType: req.user.organizationType,
    mustChangePassword: false
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "8h"
  });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `dental_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`
  );

  return res.status(204).send();
}));

router.get("/me", authenticate, (req, res) => {
  return res.json({ user: req.user });
});

router.post("/logout", (req, res) => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `dental_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  );
  return res.status(204).send();
});

module.exports = router;
module.exports.pinLookupHash = pinLookupHash;
module.exports.validPin = validPin;
