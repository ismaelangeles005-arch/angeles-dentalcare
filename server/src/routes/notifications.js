const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT id, type, title, message, entity_type, entity_id, read_at, created_at
    FROM notifications
    WHERE user_id = $1 AND organization_id = $2
    ORDER BY created_at DESC
    LIMIT 50
  `, [req.user.id, req.user.organizationId]);

  return res.json(result.rows);
}));

router.patch("/read-all", asyncHandler(async (req, res) => {
  const result = await db.query(`
    UPDATE notifications
    SET read_at = NOW()
    WHERE user_id = $1 AND organization_id = $2 AND read_at IS NULL
    RETURNING id
  `, [req.user.id, req.user.organizationId]);

  return res.json({ updated: result.rowCount });
}));

router.patch("/:id/read", asyncHandler(async (req, res) => {
  const result = await db.query(`
    UPDATE notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE id = $1 AND user_id = $2 AND organization_id = $3
    RETURNING id, read_at
  `, [req.params.id, req.user.id, req.user.organizationId]);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Notificacion no encontrada" });
  }

  return res.json(result.rows[0]);
}));

module.exports = router;
