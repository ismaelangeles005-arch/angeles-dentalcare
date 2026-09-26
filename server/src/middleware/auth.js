const jwt = require("jsonwebtoken");
const db = require("../db");

const ROLE_COMPATIBILITY = {
  owner_doctor: ["head_admin", "admin", "doctor", "owner_doctor"],
  clinic_admin: ["head_admin", "admin", "clinic_admin"],
  receptionist: ["recepcion", "receptionist"],
  independent_assistant: ["recepcion", "assistant", "independent_assistant"],
  assistant: ["assistant", "recepcion"],
  cashier: ["cashier", "recepcion"]
};

function roleMatches(userRole, allowedRole) {
  return userRole === allowedRole || (ROLE_COMPATIBILITY[userRole] || []).includes(allowedRole);
}

function hasAnyRole(userRole, allowedRoles) {
  return allowedRoles.some(role => roleMatches(userRole, role));
}

function deriveScope(role, organizationId) {
  if (role === "PLATFORM_SUPER_ADMIN") {
    return organizationId === null ? "PLATFORM" : null;
  }

  return organizationId ? "ORGANIZATION" : null;
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");

    if (key === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return "";
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const bearerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  let session;
  try {
    const token = getCookie(req, "dental_session") || bearerToken;
    if (!token) {
      return res.status(401).json({ message: "Sesion requerida" });
    }
    session = jwt.verify(token, process.env.JWT_SECRET);
  }
  catch (error) {
    return res.status(401).json({ message: "Sesion invalida o vencida" });
  }

  try {
    const result = await db.query(`
      SELECT
        u.id,
        u.username,
        u.role,
        u.doctor_id,
        u.organization_id,
        u.must_change_password,
        d.name AS doctor,
        o.name AS organization_name,
        o.organization_type
      FROM users u
      LEFT JOIN doctors d ON d.id = u.doctor_id
      LEFT JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = $1
        AND u.active = true
        AND u.deleted_at IS NULL
        AND (o.id IS NULL OR o.active = true)
      LIMIT 1
    `, [session.id]);

    if (!result.rows.length) {
      return res.status(401).json({ message: "La cuenta esta inactiva o ya no existe" });
    }

    const user = result.rows[0];
    const scope = deriveScope(user.role, user.organization_id);

    if (!scope) {
      return res.status(401).json({
        code: "INVALID_ACCOUNT_SCOPE",
        message: "La cuenta tiene una configuracion de acceso invalida"
      });
    }

    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      scope,
      doctorId: user.doctor_id,
      doctor: user.doctor,
      organizationId: user.organization_id,
      organizationName: user.organization_name,
      organizationType: scope === "PLATFORM" ? null : (user.organization_type || "CLINIC"),
      mustChangePassword: user.must_change_password === true,
      isDoctor: hasAnyRole(user.role, ["doctor"]),
      isAdmin: hasAnyRole(user.role, ["head_admin", "admin"]),
      isReception: hasAnyRole(user.role, ["recepcion"]),
      isCashier: hasAnyRole(user.role, ["cashier"])
    };
    const authPath = req.path.toLowerCase().replace(/\/+$/, "");
    const passwordChangeResource = req.baseUrl.toLowerCase() === "/api/auth" && (
      (["GET", "HEAD"].includes(req.method) && authPath === "/me") ||
      (req.method === "POST" && ["/change-password", "/logout"].includes(authPath))
    );
    if (req.user.mustChangePassword && !passwordChangeResource) {
      return res.status(403).json({
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "Debes cambiar tu contrasena antes de continuar"
      });
    }
    if (req.user.scope === "PLATFORM" && req.baseUrl.toLowerCase() !== "/api/auth") {
      return res.status(403).json({
        code: "PLATFORM_TENANT_ACCESS_DENIED",
        message: "La cuenta de plataforma no tiene acceso operativo directo"
      });
    }

    return next();
  }
  catch (error) {
    return next(error);
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!hasAnyRole(req.user.role, roles)) {
      return res.status(403).json({ message: "No tienes permiso para esta accion" });
    }

    return next();
  };
}

module.exports = {
  authenticate,
  allowRoles,
  hasAnyRole,
  roleMatches,
  deriveScope
};
