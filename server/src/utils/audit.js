const db = require("../db");

async function writeAuditLog(req, action, entity, entityId = null, payload = {}, queryClient = db) {
  if (!req.user) {
    return;
  }

  await queryClient.query(`
    INSERT INTO audit_logs (organization_id, user_id, action, entity, entity_id, payload)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    req.user.organizationId || null,
    req.user.id,
    action,
    entity,
    entityId,
    payload
  ]);
}

module.exports = { writeAuditLog };
