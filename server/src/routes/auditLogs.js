const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate);
router.use(allowRoles("head_admin", "admin"));

router.get("/", asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT l.id, l.action, l.entity, l.entity_id, l.payload, l.created_at, u.username, u.full_name, u.role
    FROM audit_logs l
    LEFT JOIN users u ON u.id = l.user_id AND u.organization_id = l.organization_id
    WHERE l.organization_id = $1
    ORDER BY l.created_at DESC
    LIMIT 200
  `, [req.user.organizationId]);
  return res.json(result.rows);
}));

module.exports = router;
