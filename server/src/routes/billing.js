const express = require("express");
const db = require("../db");
const { createHash } = require("node:crypto");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");

const router = express.Router();
router.use(authenticate, allowRoles("head_admin", "admin", "recepcion", "doctor", "cashier"));

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

function estimateAccessWhere(req, alias = "e", params = []) {
  const where = [`${alias}.deleted_at IS NULL`];
  params.push(req.user.organizationId);
  const orgParam = params.length;
  where.push(`${alias}.organization_id = $${orgParam}`);

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    where.push(`EXISTS (
      SELECT 1 FROM patients p
      WHERE p.id = ${alias}.patient_id
        AND p.deleted_at IS NULL
        AND p.organization_id = $${orgParam}
        AND p.doctor_id = $${params.length}
    )`);
  }

  return { where: where.join(" AND "), params };
}

async function assertPatientAccess(req, patientId, client) {
  if (!patientId) return null;
  const params = [patientId, req.user.organizationId];
  let where = "id = $1 AND organization_id = $2 AND deleted_at IS NULL";

  if (req.user.isDoctor) {
    params.push(req.user.doctorId);
    where += ` AND doctor_id = $${params.length}`;
  }

  const result = await client.query(`SELECT id, full_name FROM patients WHERE ${where} LIMIT 1`, params);
  return result.rows[0] || null;
}

function billingError(status, message) {
  return Object.assign(new Error(message), { billingStatus: status });
}

async function validateTreatmentPlanLinks(req, client, patientId, items) {
  const linked = items.filter(item => item.treatmentPlanItemId !== null);
  if (!linked.length) return;
  if (!patientId) throw billingError(400, "El vinculo al plan requiere un paciente registrado");
  for (const item of linked) {
    if (typeof item.treatmentPlanItemId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.treatmentPlanItemId)) {
      throw billingError(400, "Identificador de item del plan invalido");
    }
  }
  const ids = [...new Set(linked.map(item => item.treatmentPlanItemId.toLowerCase()))].sort();
  // Keep the validated ownership and procedure stable through the financial commit.
  const result = await client.query(`
    SELECT tpi.id, tpi.procedure_id
    FROM treatment_plan_items tpi
    JOIN treatment_plans tp ON tp.id = tpi.treatment_plan_id
    WHERE tpi.id = ANY($1::uuid[])
      AND tp.organization_id = $2 AND tp.patient_id = $3
    ORDER BY tpi.id FOR SHARE OF tpi, tp
  `, [ids, req.user.organizationId, patientId]);
  const references = new Map(result.rows.map(row => [row.id, row]));
  for (const item of linked) {
    const reference = references.get(item.treatmentPlanItemId.toLowerCase());
    if (!reference) throw billingError(404, "Item del plan no disponible para este paciente y organizacion");
    const procedure = typeof item.procedureId === "string" ? item.procedureId.toLowerCase() : item.procedureId;
    if ((reference.procedure_id || null) !== procedure) {
      throw billingError(409, "El procedimiento no coincide con el item del plan");
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

async function lockEstimate(req, client, id) {
  const access = estimateAccessWhere(req, "e", [id]);
  const result = await client.query(`SELECT e.* FROM billing_estimates e
    WHERE e.id = $1 AND ${access.where} FOR UPDATE`, access.params);
  if (!result.rows.length) throw billingError(404, "Presupuesto no encontrado");
  return result.rows[0];
}

async function billingTransaction(req, res, operation, responseStatus, work) {
  const key = req.body.idempotencyKey;
  if (operation && (typeof key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))) {
    return res.status(400).json({ message: "Se requiere una clave de idempotencia UUID para este intento" });
  }
  const { idempotencyKey, ...body } = req.body;
  const hash = createHash("sha256").update(JSON.stringify(canonical({
    operation, target: req.params.id || null, actor: req.user.id, body
  }))).digest("hex");
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    if (operation) {
      // Unique insertion waits for a concurrent owner of this key before any estimate lock.
      const claim = await client.query(`INSERT INTO billing_payment_operations
        (organization_id, idempotency_key, request_hash) VALUES ($1, $2, $3)
        ON CONFLICT (organization_id, idempotency_key) DO NOTHING
        RETURNING idempotency_key`, [req.user.organizationId, key, hash]);
      if (!claim.rows.length) {
        const prior = await client.query(`SELECT request_hash, estimate_id, response_status, response_body
          FROM billing_payment_operations WHERE organization_id = $1 AND idempotency_key = $2`,
        [req.user.organizationId, key]);
        const receipt = prior.rows[0];
        if (!receipt || receipt.request_hash !== hash) {
          throw billingError(409, "La clave de idempotencia ya corresponde a otro intento o datos diferentes");
        }
        if (!receipt.response_body) throw billingError(409, "El intento no tiene un resultado confirmado");
        // Recheck current tenant/doctor access even when returning a stored response.
        await lockEstimate(req, client, receipt.estimate_id);
        await client.query("COMMIT");
        return res.status(receipt.response_status).json(receipt.response_body);
      }
    }
    const result = await work(client);
    if (operation) {
      await client.query(`UPDATE billing_payment_operations
        SET estimate_id = $3, response_status = $4, response_body = $5::jsonb
        WHERE organization_id = $1 AND idempotency_key = $2`,
      [req.user.organizationId, key, result.id, responseStatus, JSON.stringify(result)]);
    }
    await client.query("COMMIT");
    return res.status(responseStatus).json(result);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.billingStatus) return res.status(error.billingStatus).json({ message: error.message });
    throw error;
  } finally {
    client.release();
  }
}

router.get("/estimates", asyncHandler(async (req, res) => {
  const access = estimateAccessWhere(req, "e", []);
  const result = await db.query(`
    SELECT
      e.*,
      COUNT(i.id)::int AS items_count,
      COALESCE(
        STRING_AGG(
          DISTINCT i.description || CASE WHEN i.quantity > 1 THEN ' x' || i.quantity::text ELSE '' END,
          ', '
        ) FILTER (WHERE i.id IS NOT NULL),
        'Sin procedimientos'
      ) AS procedures_summary
    FROM billing_estimates e
    LEFT JOIN billing_estimate_items i ON i.estimate_id = e.id
    WHERE ${access.where}
    GROUP BY e.id
    ORDER BY e.created_at DESC
    LIMIT 200
  `, access.params);
  return res.json(result.rows);
}));

router.get("/estimates/:id", asyncHandler(async (req, res) => {
  const access = estimateAccessWhere(req, "e", [req.params.id]);
  const estimate = await db.query(`
    SELECT e.*
    FROM billing_estimates e
    WHERE e.id = $1 AND ${access.where}
  `, access.params);

  if (!estimate.rows.length) {
    return res.status(404).json({ message: "Presupuesto no encontrado" });
  }

  const [items, payments] = await Promise.all([
    db.query("SELECT * FROM billing_estimate_items WHERE estimate_id = $1 ORDER BY id", [req.params.id]),
    db.query(`
      SELECT bp.*, u.full_name AS received_by_name, u.username AS received_by_username
      FROM billing_payments bp
      LEFT JOIN users u ON u.id = bp.received_by AND u.organization_id = bp.organization_id
      WHERE bp.estimate_id = $1 AND bp.organization_id = $2 AND bp.deleted_at IS NULL
      ORDER BY bp.paid_at ASC, bp.created_at ASC
    `, [req.params.id, req.user.organizationId])
  ]);

  return res.json({ ...estimate.rows[0], items: items.rows, payments: payments.rows });
}));

router.post("/estimates", asyncHandler(async (req, res) => {
  const patientId = req.body.patientId || null;
  const patientName = String(req.body.patientName || "").trim();
  const notes = String(req.body.notes || "").trim();
  const globalDiscount = money(req.body.discount);
  const requestedPaid = money(req.body.paid);
  const paymentMethod = String(req.body.paymentMethod || "efectivo").trim() || "efectivo";
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  if (!patientName || !items.length) {
    return res.status(400).json({ message: "Selecciona paciente y agrega procedimientos" });
  }

  const cleanItems = items.map(item => {
    const quantity = Math.max(1, Number.parseInt(item.quantity || 1, 10));
    const unitPrice = money(item.unitPrice);
    const grossTotal = Math.round(quantity * unitPrice * 100) / 100;
    const discount = Math.min(money(item.discount), grossTotal);
    const total = Math.max(0, Math.round((grossTotal - discount) * 100) / 100);
    return {
      procedureId: item.procedureId || null,
      treatmentPlanItemId: item.treatmentPlanItemId ?? null,
      description: String(item.description || "").trim(),
      toothNumber: String(item.toothNumber || "").trim() || null,
      quantity,
      unitPrice,
      grossTotal,
      discount,
      total
    };
  }).filter(item => item.description && item.grossTotal >= 0);

  if (!cleanItems.length) {
    return res.status(400).json({ message: "Agrega al menos un procedimiento valido" });
  }

  const grossSubtotal = cleanItems.reduce((sum, item) => sum + item.grossTotal, 0);
  const lineDiscount = cleanItems.reduce((sum, item) => sum + item.discount, 0);
  const subtotal = cleanItems.reduce((sum, item) => sum + item.total, 0);
  const totalDiscount = Math.min(Math.round((lineDiscount + globalDiscount) * 100) / 100, grossSubtotal);
  const total = Math.max(0, Math.round((subtotal - globalDiscount) * 100) / 100);
  const paid = Math.min(requestedPaid, total);
  const balance = Math.max(0, Math.round((total - paid) * 100) / 100);
  const initialStatus = balance <= 0 ? "pagado" : "en_deuda";

  return billingTransaction(req, res, "create_estimate", 201, async client => {
    const patient = await assertPatientAccess(req, patientId, client);
    if (patientId && !patient) throw billingError(403, "No tienes acceso a ese paciente");
    if (items.some(item => item.treatmentPlanItemId != null) && cleanItems.length !== items.length) {
      throw billingError(400, "Los items vinculados requieren datos financieros validos");
    }
    await validateTreatmentPlanLinks(req, client, patientId, cleanItems);
    const estimate = await client.query(`
      INSERT INTO billing_estimates (organization_id, patient_id, patient_name, status, subtotal, discount, total, paid, balance, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [req.user.organizationId, patientId, patientName, initialStatus, grossSubtotal, totalDiscount, total, paid, balance, notes, req.user.id]);

    for (const item of cleanItems) {
      await client.query(`
        INSERT INTO billing_estimate_items (estimate_id, procedure_id, description, tooth_number, quantity, unit_price, gross_total, discount, total, treatment_plan_item_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [estimate.rows[0].id, item.procedureId, item.description, item.toothNumber, item.quantity, item.unitPrice, item.grossTotal, item.discount, item.total, item.treatmentPlanItemId]);
    }

    if (paid > 0) {
      await client.query(`
        INSERT INTO billing_payments (organization_id, estimate_id, amount, method, note, received_by)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [req.user.organizationId, estimate.rows[0].id, paid, paymentMethod, "Abono inicial", req.user.id]);
    }

    await writeAuditLog(req, "create", "billing_estimates", estimate.rows[0].id, { patientName, total, paid, balance, totalDiscount }, client);
    return estimate.rows[0];
  });
}));

router.post("/estimates/:id/payments", asyncHandler(async (req, res) => {
  const amount = money(req.body.amount);
  const method = String(req.body.method || "efectivo").trim() || "efectivo";
  const note = String(req.body.note || "").trim();

  if (amount <= 0) {
    return res.status(400).json({ message: "Ingresa un monto de pago valido" });
  }

  return billingTransaction(req, res, "payment", 200, async client => {
    const estimate = await lockEstimate(req, client, req.params.id);
    if (estimate.status === "cancelado") {
      throw billingError(400, "No se puede pagar un presupuesto cancelado");
    }

    const balance = money(estimate.balance);
    if (balance <= 0) {
      throw billingError(400, "Este presupuesto ya esta saldado");
    }

    if (amount > balance) {
      throw billingError(400, "El monto no puede superar el pendiente");
    }

    const newPaid = Math.round((money(estimate.paid) + amount) * 100) / 100;
    const newBalance = Math.max(0, Math.round((money(estimate.total) - newPaid) * 100) / 100);
    const newStatus = newBalance <= 0 ? "pagado" : "en_deuda";

    await client.query(`
      INSERT INTO billing_payments (organization_id, estimate_id, amount, method, note, received_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.organizationId, req.params.id, amount, method, note || null, req.user.id]);

    const result = await client.query(`
      UPDATE billing_estimates
      SET paid = $2, balance = $3, status = $4, updated_at = NOW()
      WHERE id = $1 AND organization_id = $5 AND deleted_at IS NULL
      RETURNING *
    `, [req.params.id, newPaid, newBalance, newStatus, req.user.organizationId]);

    await writeAuditLog(req, "payment", "billing_estimates", req.params.id, { amount, method, paid: newPaid, balance: newBalance, status: newStatus }, client);
    return result.rows[0];
  });
}));

router.patch("/estimates/:id/status", asyncHandler(async (req, res) => {
  const status = String(req.body.status || "").trim();
  if (!["pendiente", "en_deuda", "pagado", "cancelado", "borrador", "aprobado"].includes(status)) {
    return res.status(400).json({ message: "Estado invalido" });
  }

  return billingTransaction(req, res, status === "pagado" ? "settle" : null, 200, async client => {
    const current = await lockEstimate(req, client, req.params.id);
    let result;
    if (status === "pagado") {
      if (current.status === "cancelado") throw billingError(400, "No se puede pagar un presupuesto cancelado");
      const remaining = money(current.balance);
      if (remaining > 0) {
        await client.query(`
          INSERT INTO billing_payments (organization_id, estimate_id, amount, method, note, received_by)
          VALUES ($1, $2, $3, 'saldo_total', 'Saldado desde boton Pagado', $4)
        `, [req.user.organizationId, req.params.id, remaining, req.user.id]);
      }
      result = await client.query(`
        UPDATE billing_estimates
        SET status = $2, paid = total, balance = 0, updated_at = NOW()
        WHERE id = $1 AND organization_id = $3 AND deleted_at IS NULL
        RETURNING *
      `, [req.params.id, status, req.user.organizationId]);
    }
    else if (status === "pendiente") {
      result = await client.query(`
        UPDATE billing_estimates
        SET status = $2, balance = GREATEST(total - paid, 0), updated_at = NOW()
        WHERE id = $1 AND organization_id = $3 AND deleted_at IS NULL
        RETURNING *
      `, [req.params.id, status, req.user.organizationId]);
    }
    else {
      result = await client.query(`
        UPDATE billing_estimates SET status = $2, updated_at = NOW()
        WHERE id = $1 AND organization_id = $3 AND deleted_at IS NULL
        RETURNING *
      `, [req.params.id, status, req.user.organizationId]);
    }

    await writeAuditLog(req, "update", "billing_estimates", req.params.id, { status }, client);
    return result.rows[0];
  });
}));

module.exports = router;
