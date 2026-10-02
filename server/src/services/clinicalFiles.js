const crypto = require("crypto");
const path = require("path");

const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff", "application/dicom"]);
const previewableTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
function failure(status, message) { return Object.assign(new Error(message), { status }); }

// Dependencies are injected so clinical authorization and metadata remain independent of storage.
function createClinicalFilesService({ db, storage, logger = console }) {
  async function canAccessClinicalFile(req, patientId) {
    if (req.user.isReception) {
      return false;
    }

    const params = [patientId, req.user.organizationId];
    let doctorCondition = "";

    if (req.user.isDoctor) {
      params.push(req.user.doctorId);
      doctorCondition = `AND (
        p.doctor_id = $${params.length}
        OR EXISTS (
          SELECT 1 FROM patient_visits pv
          WHERE pv.patient_id = p.id
            AND pv.organization_id = p.organization_id
            AND pv.doctor_id = $${params.length}
        )
      )`;
    }

    const result = await db.query(`
      SELECT p.id
      FROM patients p
      WHERE p.id = $1
        AND p.organization_id = $2
        AND p.deleted_at IS NULL
        ${doctorCondition}
    `, params);

    return Boolean(result.rows.length);
  }

  async function authorize(req) {
    if (!await canAccessClinicalFile(req, req.params.patientId)) {
      throw failure(403, "No tienes acceso al expediente clinico");
    }
  }

  function validateFile(file) {
    if (!allowedTypes.has(file.mimetype)) {
      throw failure(400, "Formato no permitido. Usa PDF, JPG, PNG, WEBP, TIFF o DICOM.");
    }
  }

  async function storeUpload(file) {
    validateFile(file);
    const extension = path.extname(file.originalname).toLowerCase().slice(0, 10);
    const object = await storage.put({
      key: `${crypto.randomUUID()}${extension}`, stream: file.stream,
      contentType: file.mimetype, ifAbsent: true
    });
    return { filename: object.key, size: object.size };
  }

  async function discardUpload(file) {
    if (file.filename) await storage.delete({ key: file.filename });
  }

  async function list(req) {
    await authorize(req);
    const result = await db.query(`
      SELECT
        pf.id,
        pf.original_name AS name,
        pf.mime_type,
        pf.size_bytes,
        pf.category,
        pf.description,
        pf.created_at,
        u.full_name AS uploaded_by
      FROM patient_files pf
      JOIN users u ON u.id = pf.uploaded_by AND u.organization_id = pf.organization_id
      WHERE pf.patient_id = $1 AND pf.organization_id = $2 AND pf.deleted_at IS NULL
      ORDER BY pf.created_at DESC
    `, [req.params.patientId, req.user.organizationId]);

    return result.rows;
  }

  async function create(req) {
    if (!req.file) throw failure(400, "Selecciona un archivo");
    try {
      await authorize(req);
      const validCategories = ["radiografia", "fotografia", "documento", "otro"];
      const category = validCategories.includes(req.body.category) ? req.body.category : "otro";
      const description = typeof req.body.description === "string"
        ? req.body.description.trim().slice(0, 500)
        : "";

      const result = await db.query(`
        INSERT INTO patient_files (
          organization_id, patient_id, uploaded_by, original_name, stored_name, mime_type,
          size_bytes, category, description
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, original_name AS name, mime_type, size_bytes, category, description, created_at
      `, [
        req.user.organizationId,
        req.params.patientId,
        req.user.id,
        path.basename(req.file.originalname).slice(0, 255),
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        category,
        description || null
      ]);

      return result.rows[0];
    } catch (error) {
      await discardUpload(req.file).catch(() => logger.error("Clinical upload cleanup failed"));
      throw error;
    }
  }

  async function retrieve(req, preview) {
    await authorize(req);
    const result = await db.query(`
      SELECT original_name, stored_name, mime_type
      FROM patient_files
      WHERE id = $1 AND patient_id = $2 AND organization_id = $3 AND deleted_at IS NULL
    `, [req.params.fileId, req.params.patientId, req.user.organizationId]);

    const file = result.rows[0];
    if (!file) {
      throw failure(404, "Archivo no encontrado");
    }

    if (preview && !previewableTypes.has(file.mime_type)) {
      throw failure(415, "Este formato necesita un visor especializado y solo puede descargarse");
    }
    const object = await storage.stat({ key: file.stored_name });
    if (!object) throw failure(404, "El archivo fisico no esta disponible");
    return { file, object };
  }

  async function openRead(file, range = {}) {
    try { return await storage.openRead({ key: file.stored_name, ...range }); }
    catch (error) {
      if (error.code === "ENOENT") throw failure(404, "El archivo fisico no esta disponible");
      throw error;
    }
  }

  async function remove(req) {
    await authorize(req);
    const result = await db.query(`
      UPDATE patient_files
      SET deleted_at = NOW()
      WHERE id = $1 AND patient_id = $2 AND organization_id = $3 AND deleted_at IS NULL
      RETURNING stored_name
    `, [req.params.fileId, req.params.patientId, req.user.organizationId]);

    if (!result.rows.length) {
      throw failure(404, "Archivo no encontrado");
    }

    // Keep the existing soft-delete and best-effort physical removal policy.
    await storage.delete({ key: result.rows[0].stored_name })
      .catch(() => logger.error("Clinical file physical removal failed"));
  }

  return { canAccessClinicalFile, validateFile, storeUpload, discardUpload, list, create, retrieve, openRead, remove };
}

module.exports = createClinicalFilesService;
