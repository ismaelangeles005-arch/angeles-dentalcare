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
  const token = getCookie(req, "dental_session") || bearerToken;

  if (!token) {
    return res.status(401).json({ message: "Sesion requerida" });
  }

  try {
    const session = jwt.verify(token, process.env.JWT_SECRET);
    const result = await db.query(`
      SELECT
        u.id,
        u.username,
        u.role,
        u.doctor_id,
        u.organization_id,
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
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      doctorId: user.doctor_id,
      doctor: user.doctor,
      organizationId: user.organization_id,
      organizationName: user.organization_name,
      organizationType: user.organization_type || "CLINIC",
      isDoctor: hasAnyRole(user.role, ["doctor"]),
      isAdmin: hasAnyRole(user.role, ["head_admin", "admin"]),
      isReception: hasAnyRole(user.role, ["recepcion"]),
      isCashier: hasAnyRole(user.role, ["cashier"])
    };
    return next();
  }
  catch (error) {
    return res.status(401).json({ message: "Sesion invalida o vencida" });
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
  roleMatches
};
