const express = require("express");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { writeAuditLog } = require("../utils/audit");
const { isValidToothId, isValidSurfaceForTooth } = require("../utils/dentalTeeth");

const router = express.Router();
router.use(authenticate, allowRoles("head_admin", "admin", "doctor"));
const surfaces = new Set(["MESIAL", "DISTAL", "BUCCAL", "LINGUAL", "PALATAL", "OCCLUSAL", "INCISAL"]);

function reject(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function uuid(value, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    reject("Identificador invalido");
  }
  return value.toLowerCase();
}

function text(value, limit, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) reject("Texto requerido o longitud invalida");
  return value.trim() || null;
}

function cents(value) {
  if (!["string", "number"].includes(typeof value) || !/^\d{1,10}(\.\d{1,2})?$/.test(String(value))) reject("Importe invalido: usa hasta dos decimales");
  const [whole, fraction = ""] = String(value).split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > 999999999999n) reject("Importe fuera de rango");
  return result;
}

function money(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

const executableStatuses = ["ACCEPTED", "IN_PROGRESS", "COMPLETED"];

function executionProgress(items) {
  const executable = items.filter(item => executableStatuses.includes(item.status));
  const completed = executable.filter(item => item.status === "COMPLETED").length;
  return {
    total: executable.length, completed,
    in_progress: executable.filter(item => item.status === "IN_PROGRESS").length,
    pending: executable.filter(item => item.status === "ACCEPTED").length,
    percent: executable.length ? Math.round(completed * 100 / executable.length) : 0
  };
}

async function transaction(work) {
  const client = await db.pool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { releaseError = rollbackError; error.rollbackError = rollbackError; }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function patient(client, id, organizationId) {
  const result = await client.query("SELECT id FROM patients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL", [id, organizationId]);
  if (!result.rows.length) reject("Paciente no encontrado", 404);
}

router.get("/patient/:patientId", asyncHandler(async (req, res) => {
  const patientId = uuid(req.params.patientId);
  await patient(db, patientId, req.user.organizationId);
  const result = await db.query(`
    SELECT tp.id, tp.name, tp.status, tp.doctor_id, d.name AS doctor, tp.created_at,
      COALESCE((SELECT SUM(i.final_amount) FROM treatment_plan_items i WHERE i.treatment_plan_id = tp.id), 0) AS total
    FROM treatment_plans tp
    LEFT JOIN doctors d ON d.id = tp.doctor_id AND d.organization_id = tp.organization_id
    WHERE tp.patient_id = $1 AND tp.organization_id = $2
    ORDER BY tp.created_at DESC
  `, [patientId, req.user.organizationId]);
  res.json(result.rows);
}));

router.get("/:planId", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  const result = await db.query(`
    SELECT tp.*, p.full_name AS patient, d.name AS doctor
    FROM treatment_plans tp
    JOIN patients p ON p.id = tp.patient_id AND p.organization_id = tp.organization_id AND p.deleted_at IS NULL
    LEFT JOIN doctors d ON d.id = tp.doctor_id AND d.organization_id = tp.organization_id
    WHERE tp.id = $1 AND tp.organization_id = $2
  `, [planId, req.user.organizationId]);
  if (!result.rows.length) reject("Plan no encontrado", 404);
  const items = await db.query(`
    SELECT i.* FROM treatment_plan_items i
    JOIN treatment_plans tp ON tp.id = i.treatment_plan_id
    WHERE tp.id = $1 AND tp.organization_id = $2
    ORDER BY i.created_at, i.id
  `, [planId, req.user.organizationId]);
  const total = items.rows.reduce((sum, item) => sum + cents(item.final_amount), 0n);
  const accepted = items.rows.filter(item => executableStatuses.includes(item.status)).reduce((sum, item) => sum + cents(item.final_amount), 0n);
  const acceptances = await db.query(`
    SELECT id, accepted_by_name, accepted_at, accepted_total_snapshot
    FROM treatment_plan_acceptances WHERE treatment_plan_id = $1 AND organization_id = $2
    ORDER BY accepted_at DESC, id
  `, [planId, req.user.organizationId]);
  res.json({ ...result.rows[0], items: items.rows, total: money(total), accepted_total: money(accepted), acceptances: acceptances.rows, progress: executionProgress(items.rows) });
}));

router.post("/", asyncHandler(async (req, res) => {
  const patientId = uuid(req.body.patient_id);
  const doctorId = uuid(req.body.doctor_id, true);
  const name = text(req.body.name, 200, true);
  const notes = text(req.body.notes, 2000);
  const plan = await transaction(async client => {
    await patient(client, patientId, req.user.organizationId);
    if (doctorId) {
      const doctor = await client.query("SELECT id FROM doctors WHERE id = $1 AND organization_id = $2 AND active = true FOR SHARE", [doctorId, req.user.organizationId]);
      if (!doctor.rows.length) reject("Doctor no disponible en esta organizacion");
    }
    const result = await client.query(`
      INSERT INTO treatment_plans (organization_id, patient_id, doctor_id, name, status, notes, created_by)
      VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6) RETURNING *
    `, [req.user.organizationId, patientId, doctorId, name, notes, req.user.id]);
    await writeAuditLog(req, "create", "treatment_plans", result.rows[0].id, { patient_id: patientId }, client);
    return result.rows[0];
  });
  res.status(201).json(plan);
}));

router.post("/:planId/items", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  const procedureId = uuid(req.body.procedure_id);
  const entryId = uuid(req.body.odontogram_entry_id, true);
  const quantity = req.body.quantity === undefined ? 1 : req.body.quantity;
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 2147483647) reject("La cantidad debe ser un entero positivo");
  const discount = cents(req.body.discount_amount === undefined ? 0 : req.body.discount_amount);
  const priority = text(req.body.priority, 100);
  const notes = text(req.body.notes, 2000);
  const item = await transaction(async client => {
    const plans = await client.query(`
      SELECT tp.* FROM treatment_plans tp
      JOIN patients p ON p.id = tp.patient_id AND p.organization_id = tp.organization_id AND p.deleted_at IS NULL
      WHERE tp.id = $1 AND tp.organization_id = $2 FOR UPDATE OF tp
    `, [planId, req.user.organizationId]);
    const plan = plans.rows[0];
    if (!plan) reject("Plan no encontrado", 404);
    await assertPlanAdministrationUnlocked(client, plan);
    if (plan.status !== "DRAFT") reject("Solo se pueden agregar items a un plan DRAFT", 409);
    let toothId = req.body.tooth_id ?? null;
    let surface = req.body.surface ?? null;
    if (entryId) {
      const entries = await client.query(`
        SELECT tooth_id, surface, procedure_id FROM odontogram_entries
        WHERE id = $1 AND organization_id = $2 AND patient_id = $3
          AND entry_type = 'PROPOSED_TREATMENT' AND status = 'ACTIVE'
        FOR SHARE
      `, [entryId, req.user.organizationId, plan.patient_id]);
      const entry = entries.rows[0];
      if (!entry || entry.procedure_id !== procedureId) reject("Propuesta no disponible o procedimiento distinto al del odontograma");
      toothId = entry.tooth_id;
      surface = entry.surface;
      const duplicates = await client.query("SELECT id FROM treatment_plan_items WHERE treatment_plan_id = $1 AND odontogram_entry_id = $2 LIMIT 1", [planId, entryId]);
      if (duplicates.rows.length) reject("Esta propuesta del odontograma ya pertenece al plan", 409);
    }
    if (toothId !== null && !isValidToothId(toothId)) reject("Pieza dental invalida");
    if (toothId !== null) toothId = toothId.trim();
    if (surface !== null && (!surfaces.has(surface) || !isValidSurfaceForTooth(toothId, surface))) reject("Superficie dental invalida o sin pieza");
    const procedures = await client.query(`
      SELECT id, name, category_name, base_price FROM procedure_catalog
      WHERE id = $1 AND organization_id = $2 AND active = true AND deleted_at IS NULL
      FOR SHARE
    `, [procedureId, req.user.organizationId]);
    const procedure = procedures.rows[0];
    if (!procedure) reject("Procedimiento no disponible");
    const unit = cents(procedure.base_price);
    const final = unit * BigInt(quantity) - discount;
    if (final < 0n || final > 999999999999n) reject("Descuento o total fuera de rango");
    const result = await client.query(`
      INSERT INTO treatment_plan_items (
        treatment_plan_id, procedure_id, odontogram_entry_id, tooth_id, surface,
        procedure_name_snapshot, procedure_area_snapshot, unit_price_snapshot,
        quantity, discount_amount, final_amount, priority, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PROPOSED', $13)
      RETURNING *
    `, [planId, procedureId, entryId, toothId, surface, procedure.name, procedure.category_name,
      money(unit), quantity, money(discount), money(final), priority, notes]);
    await client.query("UPDATE treatment_plans SET updated_at = NOW() WHERE id = $1 AND organization_id = $2", [planId, req.user.organizationId]);
    await writeAuditLog(req, "create", "treatment_plan_items", result.rows[0].id, { treatment_plan_id: planId }, client);
    return result.rows[0];
  });
  res.status(201).json(item);
}));

const decisionPlanStatuses = ["PRESENTED", "ACCEPTED", "PARTIALLY_ACCEPTED", "REJECTED", "POSTPONED"];
const decisions = ["ACCEPTED", "REJECTED", "POSTPONED"];

function globalDecisionStatus(items) {
  if (items.every(item => item.status === "ACCEPTED")) return "ACCEPTED";
  if (items.some(item => item.status === "ACCEPTED")) return "PARTIALLY_ACCEPTED";
  if (items.every(item => item.status === "REJECTED")) return "REJECTED";
  if (items.some(item => item.status === "PROPOSED")) return "PRESENTED";
  return "POSTPONED";
}

async function lockPlan(client, planId, organizationId) {
  const result = await client.query(`
    SELECT tp.* FROM treatment_plans tp
    JOIN patients p ON p.id = tp.patient_id AND p.organization_id = tp.organization_id AND p.deleted_at IS NULL
    WHERE tp.id = $1 AND tp.organization_id = $2 FOR UPDATE OF tp
  `, [planId, organizationId]);
  if (!result.rows.length) reject("Plan no encontrado", 404);
  return result.rows[0];
}

// Call only after locking the plan: signature creation uses the same lock.
async function assertPlanAdministrationUnlocked(client, plan) {
  const acceptance = await client.query(`
    SELECT id FROM treatment_plan_acceptances
    WHERE treatment_plan_id = $1 AND organization_id = $2
    LIMIT 1
  `, [plan.id, plan.organization_id]);
  if (acceptance.rows.length) reject("Este plan ya tiene un consentimiento firmado y está protegido. No se permiten cambios administrativos.", 409);
}

async function validateClinicalReferences(client, plan, items) {
  const linked = items.filter(item => item.odontogram_entry_id);
  if (!linked.length) return;
  const ids = [...new Set(linked.map(item => item.odontogram_entry_id))].sort();
  // Stable lock order; SHARE conflicts with odontogram correction/status updates until commit.
  const result = await client.query(`
    SELECT oe.id, oe.status, oe.procedure_id, oe.tooth_id, oe.surface
    FROM odontogram_entries oe
    WHERE oe.id = ANY($1::uuid[]) AND oe.organization_id = $2 AND oe.patient_id = $3
      AND oe.entry_type = 'PROPOSED_TREATMENT'
    ORDER BY oe.id FOR SHARE OF oe
  `, [ids, plan.organization_id, plan.patient_id]);
  const entries = new Map(result.rows.map(entry => [entry.id, entry]));
  for (const item of linked) {
    const entry = entries.get(item.odontogram_entry_id);
    // RESOLVED remains historically valid; it never advances the item's own status.
    if (!entry || !["ACTIVE", "RESOLVED"].includes(entry.status) ||
        (entry.procedure_id ?? null) !== (item.procedure_id ?? null) ||
        (entry.tooth_id ?? null) !== (item.tooth_id ?? null) ||
        (entry.surface ?? null) !== (item.surface ?? null)) {
      throw Object.assign(new Error("La referencia clinica de un item requiere revision antes de continuar."), {
        status: 409, code: "TREATMENT_PLAN_CLINICAL_REFERENCE_INVALID", itemId: item.id
      });
    }
  }
}

router.patch("/:planId/execution", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  if (req.body.status !== "IN_PROGRESS") reject("Solo se permite iniciar la ejecucion del plan");
  const result = await transaction(async client => {
    const plan = await lockPlan(client, planId, req.user.organizationId);
    if (plan.status === "IN_PROGRESS") return plan;
    if (!["ACCEPTED", "PARTIALLY_ACCEPTED"].includes(plan.status)) reject("El plan no admite iniciar tratamiento", 409);
    const items = await client.query("SELECT * FROM treatment_plan_items WHERE treatment_plan_id = $1 ORDER BY id FOR UPDATE", [planId]);
    const accepted = items.rows.filter(item => item.status === "ACCEPTED");
    if (!accepted.length) reject("El plan debe tener al menos un item aceptado", 409);
    await validateClinicalReferences(client, plan, accepted);
    const updated = await client.query("UPDATE treatment_plans SET status = $3, updated_at = NOW() WHERE id = $1 AND organization_id = $2 RETURNING *", [planId, req.user.organizationId, "IN_PROGRESS"]);
    await writeAuditLog(req, "update_execution", "treatment_plans", planId, { previous_status: plan.status, status: "IN_PROGRESS" }, client);
    return updated.rows[0];
  });
  res.json(result);
}));

router.patch("/:planId/items/:itemId/execution", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  const itemId = uuid(req.params.itemId);
  const status = req.body.status;
  if (!["IN_PROGRESS", "COMPLETED"].includes(status)) reject("Estado de ejecucion invalido");
  const result = await transaction(async client => {
    const plan = await lockPlan(client, planId, req.user.organizationId);
    if (!["IN_PROGRESS", "COMPLETED"].includes(plan.status)) reject("Primero inicia el tratamiento del plan", 409);
    const items = await client.query("SELECT * FROM treatment_plan_items WHERE treatment_plan_id = $1 ORDER BY id FOR UPDATE", [planId]);
    const item = items.rows.find(row => row.id === itemId);
    if (!item) reject("Item no encontrado en este plan", 404);
    // A retry of the final completion must also work after the parent has completed.
    if (item.status === status && (plan.status === "IN_PROGRESS" || status === "COMPLETED")) {
      return { item, plan_status: plan.status, progress: executionProgress(items.rows) };
    }
    if (plan.status !== "IN_PROGRESS") reject("Un plan completado no puede reabrirse", 409);
    const required = status === "IN_PROGRESS" ? "ACCEPTED" : "IN_PROGRESS";
    if (item.status !== required) reject("El item no admite esa transicion de ejecucion", 409);
    await validateClinicalReferences(client, plan, [item]);
    let evidenceId = null;
    if (status === "COMPLETED" && item.odontogram_entry_id) {
      const evidence = await client.query(`
        SELECT oe.id FROM odontogram_entries oe
        WHERE oe.related_entry_id = $1 AND oe.organization_id = $2 AND oe.patient_id = $3
          AND oe.entry_type = 'COMPLETED_TREATMENT' AND oe.status NOT IN ('VOIDED', 'SUPERSEDED')
          AND oe.procedure_id IS NOT DISTINCT FROM $4::uuid
          AND oe.tooth_id IS NOT DISTINCT FROM $5::text
          AND oe.surface IS NOT DISTINCT FROM $6::text
        ORDER BY oe.id LIMIT 1 FOR SHARE OF oe
      `, [item.odontogram_entry_id, plan.organization_id, plan.patient_id, item.procedure_id, item.tooth_id, item.surface]);
      if (!evidence.rows.length) reject("Primero registra el tratamiento realizado en el Odontograma, vinculado a esta propuesta y con la misma pieza, superficie y procedimiento.", 409);
      evidenceId = evidence.rows[0].id;
    }
    const previousStatus = item.status;
    const updated = await client.query("UPDATE treatment_plan_items SET status = $3 WHERE id = $1 AND treatment_plan_id = $2 RETURNING *", [itemId, planId, status]);
    item.status = status;
    const progress = executionProgress(items.rows);
    const planStatus = progress.total > 0 && progress.completed === progress.total ? "COMPLETED" : "IN_PROGRESS";
    await client.query("UPDATE treatment_plans SET status = $3, updated_at = NOW() WHERE id = $1 AND organization_id = $2", [planId, req.user.organizationId, planStatus]);
    await writeAuditLog(req, "update_execution", "treatment_plan_items", itemId, {
      treatment_plan_id: planId, previous_status: previousStatus, status,
      ...(evidenceId ? { completed_treatment_id: evidenceId } : {})
    }, client);
    if (plan.status !== planStatus) {
      await writeAuditLog(req, "update_execution", "treatment_plans", planId, { item_id: itemId, previous_status: plan.status, status: planStatus }, client);
    }
    return { item: updated.rows[0], plan_status: planStatus, progress };
  });
  res.json(result);
}));

router.patch("/:planId/status", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  if (req.body.status !== "PRESENTED") reject("Solo se permite presentar un plan DRAFT");
  const plan = await transaction(async client => {
    const original = await lockPlan(client, planId, req.user.organizationId);
    if (original.status !== "DRAFT") reject("El plan ya no esta en DRAFT", 409);
    const items = await client.query("SELECT * FROM treatment_plan_items WHERE treatment_plan_id = $1 ORDER BY id FOR SHARE", [planId]);
    if (!items.rows.length) reject("Agrega al menos un item antes de presentar el plan", 409);
    await validateClinicalReferences(client, original, items.rows);
    const updated = await client.query("UPDATE treatment_plans SET status = 'PRESENTED', updated_at = NOW() WHERE id = $1 AND organization_id = $2 RETURNING *", [planId, req.user.organizationId]);
    await writeAuditLog(req, "update_status", "treatment_plans", planId, { previous_status: "DRAFT", status: "PRESENTED" }, client);
    return updated.rows[0];
  });
  res.json(plan);
}));

router.patch("/:planId/items/:itemId/status", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  const itemId = uuid(req.params.itemId);
  const status = req.body.status;
  if (!decisions.includes(status)) reject("Selecciona aceptar, rechazar o posponer");
  const result = await transaction(async client => {
    const plan = await lockPlan(client, planId, req.user.organizationId);
    await assertPlanAdministrationUnlocked(client, plan);
    if (!decisionPlanStatuses.includes(plan.status)) reject("El plan no admite decisiones de aceptacion", 409);
    const items = await client.query("SELECT * FROM treatment_plan_items WHERE treatment_plan_id = $1 ORDER BY id FOR UPDATE", [planId]);
    const item = items.rows.find(row => row.id === itemId);
    if (!item) reject("Item no encontrado en este plan", 404);
    if (items.rows.some(row => !["PROPOSED", ...decisions].includes(row.status))) reject("El plan contiene items clinicamente avanzados; requiere revisar su estado antes de cambiar decisiones", 409);
    await validateClinicalReferences(client, plan, [item]);
    if (item.status === status) return { item, plan_status: plan.status };
    const previousStatus = item.status;
    const updated = await client.query("UPDATE treatment_plan_items SET status = $3 WHERE id = $1 AND treatment_plan_id = $2 RETURNING *", [itemId, planId, status]);
    item.status = status;
    const planStatus = globalDecisionStatus(items.rows);
    await client.query("UPDATE treatment_plans SET status = $3, updated_at = NOW() WHERE id = $1 AND organization_id = $2", [planId, req.user.organizationId, planStatus]);
    await writeAuditLog(req, "update_status", "treatment_plan_items", itemId, { treatment_plan_id: planId, previous_status: previousStatus, status }, client);
    if (plan.status !== planStatus) {
      await writeAuditLog(req, "update_status", "treatment_plans", planId, { item_id: itemId, previous_status: plan.status, status: planStatus }, client);
    }
    return { item: updated.rows[0], plan_status: planStatus };
  });
  res.json(result);
}));

router.get("/:planId/acceptances/:acceptanceId", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  const acceptanceId = uuid(req.params.acceptanceId);

  const result = await db.query(`
    SELECT
      a.id,
      a.treatment_plan_id,
      a.patient_id,
      a.accepted_by_name,
      a.accepted_at,
      a.signature_data,
      a.plan_status_snapshot,
      a.total_snapshot,
      a.accepted_total_snapshot,
      a.items_snapshot,
      p.full_name AS patient
    FROM treatment_plan_acceptances a
    JOIN treatment_plans tp
      ON tp.id = a.treatment_plan_id
      AND tp.organization_id = a.organization_id
    JOIN patients p
      ON p.id = a.patient_id
      AND p.organization_id = a.organization_id
      AND p.deleted_at IS NULL
    WHERE a.id = $1
      AND a.treatment_plan_id = $2
      AND a.organization_id = $3
  `, [acceptanceId, planId, req.user.organizationId]);

  if (!result.rows.length) reject("Consentimiento no encontrado", 404);

  res.json(result.rows[0]);
}));
router.post("/:planId/acceptance", asyncHandler(async (req, res) => {
  const planId = uuid(req.params.planId);
  const signer = text(req.body.accepted_by_name, 200, true);
  const signature = req.body.signature_data;
  if (typeof signature !== "string" || signature.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature)) reject("Firma PNG obligatoria o demasiado grande");
  const png = Buffer.from(signature.slice(22), "base64");
  if (png.length < 45 || png.toString("base64") !== signature.slice(22) ||
      !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      png.toString("ascii", 12, 16) !== "IHDR" || png.readUInt32BE(8) !== 13 ||
      png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 1200 ||
      png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 600 ||
      png.toString("ascii", png.length - 8, png.length - 4) !== "IEND") reject("Formato de firma invalido");
  const acceptance = await transaction(async client => {
    const plan = await lockPlan(client, planId, req.user.organizationId);
    await assertPlanAdministrationUnlocked(client, plan);
    if (["DRAFT", "CANCELLED"].includes(plan.status)) reject("Este plan no puede formalizarse", 409);
    if (req.body.expected_updated_at !== undefined &&
        new Date(req.body.expected_updated_at).getTime() !== new Date(plan.updated_at).getTime()) reject("El plan cambio mientras se firmaba. Revisa el plan actualizado y firma nuevamente", 409);
    const result = await client.query("SELECT * FROM treatment_plan_items WHERE treatment_plan_id = $1 ORDER BY created_at, id FOR SHARE", [planId]);
    if (!result.rows.some(item => item.status === "ACCEPTED")) reject("El plan debe tener al menos un item aceptado", 409);
    // The signed snapshot includes every item, not only accepted items.
    await validateClinicalReferences(client, plan, result.rows);
    const snapshots = result.rows.map(item => ({
      item_id: item.id, procedure_name_snapshot: item.procedure_name_snapshot,
      procedure_area_snapshot: item.procedure_area_snapshot, tooth_id: item.tooth_id, surface: item.surface,
      status: item.status, unit_price_snapshot: item.unit_price_snapshot, quantity: item.quantity,
      discount_amount: item.discount_amount, final_amount: item.final_amount
    }));
    const total = money(result.rows.reduce((sum, item) => sum + cents(item.final_amount), 0n));
    const accepted = money(result.rows.filter(item => item.status === "ACCEPTED").reduce((sum, item) => sum + cents(item.final_amount), 0n));
    const created = await client.query(`
      INSERT INTO treatment_plan_acceptances (organization_id, treatment_plan_id, patient_id,
        accepted_by_name, signature_data, created_by, plan_status_snapshot, total_snapshot, accepted_total_snapshot, items_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, accepted_by_name, accepted_at, accepted_total_snapshot
    `, [req.user.organizationId, planId, plan.patient_id, signer, signature, req.user.id,
      plan.status, total, accepted, JSON.stringify(snapshots)]);
    const row = created.rows[0];
    await writeAuditLog(req, "create", "treatment_plan_acceptances", row.id, {
      treatment_plan_id: planId, accepted_total_snapshot: accepted, accepted_at: row.accepted_at
    }, client);
    return row;
  });
  res.status(201).json(acceptance);
}));

router.use((error, req, res, next) => {
  if (error.code !== "TREATMENT_PLAN_CLINICAL_REFERENCE_INVALID") return next(error);
  return res.status(409).json({ code: error.code, message: error.message, item_id: error.itemId });
});

module.exports = router;
