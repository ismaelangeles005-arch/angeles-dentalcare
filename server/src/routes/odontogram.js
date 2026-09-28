const express = require("express");
const db = require("../db");
const { writeAuditLog } = require("../utils/audit");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { isValidToothId, isValidSurfaceForTooth, isValidCorrectionSurface } = require("../utils/dentalTeeth");

const router = express.Router();

router.use(authenticate);

const VALID_SURFACES = ["MESIAL", "DISTAL", "BUCCAL", "LINGUAL", "PALATAL", "OCCLUSAL", "INCISAL"];
const VALID_ENTRY_TYPES = ["EXISTING_CONDITION", "DIAGNOSIS", "PROPOSED_TREATMENT", "COMPLETED_TREATMENT"];
const VALID_STATUSES = ["ACTIVE", "RESOLVED", "SUPERSEDED", "VOIDED"];

function isValidUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

router.param("patientId", (req, res, next, patientId) => {
  if (!isValidUuid(patientId)) {
    return res.status(400).json({ message: "El identificador del paciente no es valido" });
  }
  next();
});

function cleanText(value, maxLength = 1000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeNullableEnum(value, validValues) {
  if (value === null || value === undefined || value === "") return null;
  const clean = String(value).trim().toUpperCase();
  return validValues.includes(clean) ? clean : "";
}

async function findPatient(req, patientId, queryClient = db) {
  const result = await queryClient.query(`
    SELECT id
    FROM patients
    WHERE id = $1
      AND organization_id = $2
      AND deleted_at IS NULL
    LIMIT 1
  `, [patientId, req.user.organizationId]);

  return result.rows[0] || null;
}

function mapEntry(row) {
  return {
    id: row.id,
    patient_id: row.patient_id,
    tooth_id: row.tooth_id,
    surface: row.surface,
    entry_type: row.entry_type,
    condition_code: row.condition_code,
    condition_label: row.condition_label,
    procedure_id: row.procedure_id,
    related_entry_id: row.related_entry_id,
    status: row.status,
    notes: row.notes,
    doctor_id: row.doctor_id,
    doctor: row.doctor,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
    source_clinical_note_id: row.source_clinical_note_id
  };
}

router.get("/patient/:patientId", asyncHandler(async (req, res) => {
  const patient = await findPatient(req, req.params.patientId);
  if (!patient) {
    return res.status(404).json({ message: "Paciente no encontrado" });
  }

  const params = [req.user.organizationId, req.params.patientId];
  let toothFilter = "";

  if (req.query.tooth_id) {
    const toothId = cleanText(req.query.tooth_id, 80);
    if (!isValidToothId(toothId)) {
      return res.status(400).json({ message: "La pieza dental no es valida" });
    }
    params.push(toothId);
    toothFilter = ` AND oe.tooth_id = $${params.length}`;
  }

  const result = await db.query(`
    SELECT
      oe.id,
      oe.patient_id,
      oe.tooth_id,
      oe.surface,
      oe.entry_type,
      oe.condition_code,
      oe.condition_label,
      oe.procedure_id,
      oe.related_entry_id,
      oe.status,
      oe.notes,
      oe.doctor_id,
      d.name AS doctor,
      oe.created_by,
      u.full_name AS created_by_name,
      oe.created_at,
      oe.source_clinical_note_id
    FROM odontogram_entries oe
    LEFT JOIN doctors d ON d.id = oe.doctor_id AND d.organization_id = oe.organization_id
    LEFT JOIN users u ON u.id = oe.created_by AND u.organization_id = oe.organization_id
    WHERE oe.organization_id = $1
      AND oe.patient_id = $2
      ${toothFilter}
    ORDER BY oe.created_at DESC
  `, params);

  return res.json(result.rows.map(mapEntry));
}));

router.get("/patient/:patientId/current", asyncHandler(async (req, res) => {
  const patient = await findPatient(req, req.params.patientId);
  if (!patient) {
    return res.status(404).json({ message: "Paciente no encontrado" });
  }

  const result = await db.query(`
      SELECT
        oe.id,
        oe.patient_id,
        oe.tooth_id,
        oe.surface,
        oe.entry_type,
        oe.condition_code,
        oe.condition_label,
        oe.procedure_id,
        oe.related_entry_id,
        oe.status,
        oe.notes,
        oe.doctor_id,
        d.name AS doctor,
        oe.created_by,
        u.full_name AS created_by_name,
        oe.created_at,
        oe.source_clinical_note_id,
        CASE WHEN related.id IS NOT NULL THEN jsonb_build_object(
          'id', related.id,
          'entry_type', related.entry_type,
          'condition_label', related.condition_label,
          'surface', related.surface,
          'status', related.status
        ) END AS related_entry
      FROM odontogram_entries oe
      LEFT JOIN odontogram_entries related ON related.id = oe.related_entry_id
        AND related.patient_id = oe.patient_id
        AND related.organization_id = oe.organization_id
      LEFT JOIN doctors d ON d.id = oe.doctor_id AND d.organization_id = oe.organization_id
      LEFT JOIN users u ON u.id = oe.created_by AND u.organization_id = oe.organization_id
      WHERE oe.organization_id = $1
        AND oe.patient_id = $2
        AND oe.status = 'ACTIVE'
      ORDER BY oe.tooth_id, oe.created_at DESC, oe.id DESC
  `, [req.user.organizationId, req.params.patientId]);

  const teeth = {};
  const relatedEntries = {};
  result.rows.forEach(row => {
    if (!teeth[row.tooth_id]) teeth[row.tooth_id] = [];
    teeth[row.tooth_id].push(mapEntry(row));
    if (row.related_entry) relatedEntries[row.related_entry.id] = row.related_entry;
  });

  return res.json({
    patient_id: req.params.patientId,
    teeth,
    related_entries: relatedEntries
  });
}));

router.post(["/", "/:entryId/correct"], allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  const originalId = req.params.entryId;
  const reason = req.body.reason;
  if (originalId && (!isValidUuid(originalId) ||
      typeof reason !== "string" || !reason.trim() || reason.length > 2000)) {
    return res.status(400).json({ message: "Indica un registro valido y el motivo de correccion" });
  }
  const patientId = cleanText(req.body.patientId || req.body.patient_id, 80);
  const toothId = cleanText(req.body.toothId || req.body.tooth_id, 80);
  const surface = normalizeNullableEnum(req.body.surface, VALID_SURFACES);
  const entryType = normalizeNullableEnum(req.body.entryType || req.body.entry_type, VALID_ENTRY_TYPES);
  const status = normalizeNullableEnum(req.body.status || "ACTIVE", VALID_STATUSES);
  const conditionCode = cleanText(req.body.conditionCode || req.body.condition_code, 80);
  const conditionLabel = cleanText(req.body.conditionLabel || req.body.condition_label, 200);
  const procedureId = cleanText(req.body.procedureId || req.body.procedure_id, 80);
  const relatedEntryId = req.body.related_entry_id ?? null;
  const notes = cleanText(req.body.notes, 2000);
  const sourceClinicalNoteId = cleanText(req.body.sourceClinicalNoteId || req.body.source_clinical_note_id, 80);

  if (!patientId) {
    return res.status(400).json({ message: "Selecciona el paciente" });
  }

  if (!isValidToothId(toothId)) {
    return res.status(400).json({ message: "La pieza dental no es valida" });
  }

  if (surface === "") {
    return res.status(400).json({ message: "La superficie dental no es valida" });
  }

  if (!entryType) {
    return res.status(400).json({ message: "El tipo de entrada del odontograma no es valido" });
  }

  if (!status) {
    return res.status(400).json({ message: "El estado del odontograma no es valido" });
  }

  if (!conditionCode || !conditionLabel) {
    return res.status(400).json({ message: "Registra el codigo y nombre de la condicion" });
  }

  if (relatedEntryId !== null && !isValidUuid(relatedEntryId)) {
    return res.status(400).json({ message: "El identificador del evento relacionado no es valido" });
  }

  const client = await db.pool.connect();
  let releaseError;
  try {
  await client.query("BEGIN");
  let original;
  if (originalId) {
    const locked = await client.query(`
      SELECT oe.* FROM odontogram_entries oe
      JOIN patients p ON p.id = oe.patient_id AND p.organization_id = oe.organization_id
      WHERE oe.id = $1 AND oe.organization_id = $2 AND p.deleted_at IS NULL
      FOR UPDATE OF oe
    `, [originalId, req.user.organizationId]);
    original = locked.rows[0];
    if (!original) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Registro original no encontrado" });
    }
    if (original.patient_id !== patientId || original.tooth_id !== toothId || original.entry_type !== entryType || status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "La correccion debe conservar paciente, pieza y tipo y crear una entrada activa" });
    }
    const dependents = await client.query("SELECT id FROM odontogram_entries WHERE related_entry_id = $1 LIMIT 1", [originalId]);
    if (["VOIDED", "SUPERSEDED"].includes(original.status) || dependents.rows.length ||
        (original.entry_type === "PROPOSED_TREATMENT" && original.status === "RESOLVED") ||
        (original.entry_type === "COMPLETED_TREATMENT" && original.related_entry_id)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "El original ya fue invalidado o tiene dependencias clínicas que requieren revisión" });
    }
  }
  if (!(original ? isValidCorrectionSurface(toothId, surface, original) : isValidSurfaceForTooth(toothId, surface))) {
    await client.query("ROLLBACK");
    return res.status(400).json({ message: "La superficie no corresponde a la pieza. Conserva la superficie historica o selecciona una superficie anatomica valida." });
  }
  const patient = await findPatient(req, patientId, client);
  if (!patient) {
    await client.query("ROLLBACK");
    return res.status(404).json({ message: "Paciente no encontrado" });
  }

  if (relatedEntryId !== null) {
    const expectedType = entryType === "PROPOSED_TREATMENT" ? "DIAGNOSIS"
      : entryType === "COMPLETED_TREATMENT" ? "PROPOSED_TREATMENT" : null;
    if (!expectedType) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Este tipo de entrada no permite un evento relacionado" });
    }
    const relatedEntry = await client.query(`
      SELECT id, status
      FROM odontogram_entries
      WHERE id = $1
        AND patient_id = $2
        AND organization_id = $3
        AND entry_type = $4
        AND status NOT IN ('VOIDED', 'SUPERSEDED')
      LIMIT 1
      FOR UPDATE
    `, [relatedEntryId, patientId, req.user.organizationId, expectedType]);
    if (!relatedEntry.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "El evento relacionado no es valido para este paciente y tipo de entrada" });
    }
    if (entryType === "COMPLETED_TREATMENT") {
      if (relatedEntry.rows[0].status !== "ACTIVE") {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "La propuesta ya esta resuelta y no puede completarse nuevamente" });
      }
      // El bloqueo de la propuesta serializa las finalizaciones relacionadas.
      const completed = await client.query(`
        SELECT id FROM odontogram_entries
        WHERE related_entry_id = $1
          AND patient_id = $2
          AND organization_id = $3
          AND entry_type = 'COMPLETED_TREATMENT'
          AND status NOT IN ('VOIDED', 'SUPERSEDED')
        LIMIT 1
      `, [relatedEntryId, patientId, req.user.organizationId]);
      if (completed.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "La propuesta ya tiene un tratamiento realizado vigente" });
      }
    }
  }

  if (sourceClinicalNoteId) {
    const note = await client.query(`
      SELECT id
      FROM clinical_notes
      WHERE id = $1
        AND patient_id = $2
        AND organization_id = $3
      LIMIT 1
    `, [sourceClinicalNoteId, patientId, req.user.organizationId]);

    if (!note.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "La nota clínica relacionada no pertenece a este paciente" });
    }
  }

  if (procedureId) {
    if (!["PROPOSED_TREATMENT", "COMPLETED_TREATMENT"].includes(entryType)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Solo un tratamiento propuesto o realizado puede vincular un procedimiento" });
    }

    const procedure = await client.query(`
      SELECT id
      FROM procedure_catalog
      WHERE id = $1
        AND organization_id = $2
        AND active = true
        AND deleted_at IS NULL
      LIMIT 1
    `, [procedureId, req.user.organizationId]);

    if (!procedure.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "El procedimiento seleccionado no esta disponible" });
    }
  }

  const result = await client.query(`
    INSERT INTO odontogram_entries (
      organization_id,
      patient_id,
      tooth_id,
      surface,
      entry_type,
      condition_code,
      condition_label,
      procedure_id,
      status,
      notes,
      doctor_id,
      created_by,
      source_clinical_note_id,
      related_entry_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING
      id,
      patient_id,
      tooth_id,
      surface,
      entry_type,
      condition_code,
      condition_label,
      procedure_id,
      status,
      notes,
      doctor_id,
      created_by,
      created_at,
      source_clinical_note_id,
      related_entry_id
  `, [
    req.user.organizationId,
    patientId,
    toothId,
    surface,
    entryType,
    conditionCode,
    conditionLabel,
    procedureId || null,
    status,
    notes || null,
    req.user.doctorId || null,
    req.user.id,
    sourceClinicalNoteId || null,
    relatedEntryId
  ]);

  if (!original) {
    const created = result.rows[0];
    await writeAuditLog(req, "create", "odontogram_entries", created.id, {
      patient_id: created.patient_id,
      tooth_id: created.tooth_id,
      surface: created.surface,
      entry_type: created.entry_type,
      condition_code: created.condition_code,
      condition_label: created.condition_label,
      procedure_id: created.procedure_id,
      related_entry_id: created.related_entry_id,
      status: created.status
    }, client);
  }

  if (entryType === "COMPLETED_TREATMENT" && relatedEntryId) {
    const resolved = await client.query(`
      UPDATE odontogram_entries
      SET status = 'RESOLVED'
      WHERE id = $1
        AND patient_id = $2
        AND organization_id = $3
        AND entry_type = 'PROPOSED_TREATMENT'
        AND status = 'ACTIVE'
      RETURNING id
    `, [relatedEntryId, patientId, req.user.organizationId]);
    if (resolved.rows.length) {
      await writeAuditLog(req, "update_status", "odontogram_entries", relatedEntryId, {
        previous_status: "ACTIVE",
        status: "RESOLVED",
        completed_treatment_id: result.rows[0].id
      }, client);
    }
  }
  if (original) {
    await client.query("UPDATE odontogram_entries SET status = 'SUPERSEDED' WHERE id = $1 AND organization_id = $2", [originalId, req.user.organizationId]);
    await writeAuditLog(req, "correct", "odontogram_entries", originalId, {
      previous_status: original.status,
      status: "SUPERSEDED",
      reason: reason.trim(),
      original_entry_id: originalId,
      replacement_entry_id: result.rows[0].id
    }, client);
  }
  await client.query("COMMIT");
  return res.status(201).json(mapEntry(result.rows[0]));
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError;
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}));

router.patch("/:entryId/status", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  const { entryId } = req.params;
  const { status, reason, replacement_entry_id: replacementId } = req.body;
  if (!isValidUuid(entryId) ||
      status !== "VOIDED" || typeof reason !== "string" || !reason.trim() || reason.length > 2000) {
    return res.status(400).json({ message: "Indica un registro valido, la accion y un motivo de hasta 2000 caracteres" });
  }
  if (replacementId != null) {
    return res.status(400).json({ message: "La relacion formal de reemplazo aun no esta disponible" });
  }
  const client = await db.pool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT oe.*
      FROM odontogram_entries oe
      JOIN patients p ON p.id = oe.patient_id AND p.organization_id = oe.organization_id
      WHERE oe.id = $1 AND oe.organization_id = $2 AND p.deleted_at IS NULL
      FOR UPDATE OF oe
    `, [entryId, req.user.organizationId]);
    const entry = result.rows[0];
    if (!entry) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Registro del odontograma no encontrado" });
    }
    if (["VOIDED", "SUPERSEDED"].includes(entry.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "El registro ya fue anulado o marcado para correccion" });
    }
    const dependents = await client.query(`
      SELECT id FROM odontogram_entries
      WHERE related_entry_id = $1
      LIMIT 1
    `, [entryId]);
    if (dependents.rows.length ||
        (entry.entry_type === "PROPOSED_TREATMENT" && entry.status === "RESOLVED") ||
        (entry.entry_type === "COMPLETED_TREATMENT" && entry.related_entry_id)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Este registro tiene relaciones clínicas o una propuesta resuelta. Requiere revisar su trazabilidad antes de corregirlo o anularlo" });
    }
    const updated = await client.query(`
      UPDATE odontogram_entries SET status = $3
      WHERE id = $1 AND organization_id = $2
      RETURNING *
    `, [entryId, req.user.organizationId, status]);
    await writeAuditLog(req, "update_status", "odontogram_entries", entryId, {
      previous_status: entry.status,
      status,
      reason: reason.trim()
    }, client);
    await client.query("COMMIT");
    return res.json(mapEntry(updated.rows[0]));
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError;
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}));

module.exports = router;
