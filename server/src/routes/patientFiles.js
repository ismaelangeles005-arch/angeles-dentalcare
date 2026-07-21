const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");

const router = express.Router({ mergeParams: true });
const uploadDirectory = path.resolve(
  process.env.PATIENT_FILES_DIR || path.join(__dirname, "../../storage/patient-files")
);
const allowedTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "application/dicom"
]);

fs.mkdirSync(uploadDirectory, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename(req, file, callback) {
      const extension = path.extname(file.originalname).toLowerCase().slice(0, 10);
      callback(null, `${crypto.randomUUID()}${extension}`);
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter(req, file, callback) {
    if (!allowedTypes.has(file.mimetype)) {
      const error = new Error("Formato no permitido. Usa PDF, JPG, PNG, WEBP, TIFF o DICOM.");
      error.status = 400;
      return callback(error);
    }

    return callback(null, true);
  }
});

router.use(authenticate);

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

router.get("/", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  if (!await canAccessClinicalFile(req, req.params.patientId)) {
    return res.status(403).json({ message: "No tienes acceso al expediente clinico" });
  }

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

  return res.json(result.rows);
}));

router.post("/", allowRoles("head_admin", "admin", "doctor"), upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Selecciona un archivo" });
  }

  if (!await canAccessClinicalFile(req, req.params.patientId)) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ message: "No tienes acceso al expediente clinico" });
  }

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

  return res.status(201).json(result.rows[0]);
}));

router.get("/:fileId/download", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  if (!await canAccessClinicalFile(req, req.params.patientId)) {
    return res.status(403).json({ message: "No tienes acceso al expediente clinico" });
  }

  const result = await db.query(`
    SELECT original_name, stored_name, mime_type
    FROM patient_files
    WHERE id = $1 AND patient_id = $2 AND organization_id = $3 AND deleted_at IS NULL
  `, [req.params.fileId, req.params.patientId, req.user.organizationId]);

  const file = result.rows[0];
  if (!file) {
    return res.status(404).json({ message: "Archivo no encontrado" });
  }

  const absolutePath = path.join(uploadDirectory, file.stored_name);
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ message: "El archivo fisico no esta disponible" });
  }

  res.type(file.mime_type);
  return res.download(absolutePath, file.original_name);
}));

router.get("/:fileId/view", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  if (!await canAccessClinicalFile(req, req.params.patientId)) {
    return res.status(403).json({ message: "No tienes acceso al expediente clinico" });
  }

  const result = await db.query(`
    SELECT original_name, stored_name, mime_type
    FROM patient_files
    WHERE id = $1 AND patient_id = $2 AND organization_id = $3 AND deleted_at IS NULL
  `, [req.params.fileId, req.params.patientId, req.user.organizationId]);

  const file = result.rows[0];
  if (!file) {
    return res.status(404).json({ message: "Archivo no encontrado" });
  }

  const previewableTypes = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp"
  ]);

  if (!previewableTypes.has(file.mime_type)) {
    return res.status(415).json({
      message: "Este formato necesita un visor especializado y solo puede descargarse"
    });
  }

  const absolutePath = path.join(uploadDirectory, file.stored_name);
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ message: "El archivo fisico no esta disponible" });
  }

  res.setHeader("Content-Type", file.mime_type);
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`
  );
  res.setHeader("Cache-Control", "private, no-store");
  return res.sendFile(absolutePath);
}));

router.delete("/:fileId", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  if (!await canAccessClinicalFile(req, req.params.patientId)) {
    return res.status(403).json({ message: "No tienes acceso al expediente clinico" });
  }

  const result = await db.query(`
    UPDATE patient_files
    SET deleted_at = NOW()
    WHERE id = $1 AND patient_id = $2 AND organization_id = $3 AND deleted_at IS NULL
    RETURNING stored_name
  `, [req.params.fileId, req.params.patientId, req.user.organizationId]);

  if (!result.rows.length) {
    return res.status(404).json({ message: "Archivo no encontrado" });
  }

  fs.unlink(path.join(uploadDirectory, result.rows[0].stored_name), () => {});
  return res.status(204).send();
}));

module.exports = router;
