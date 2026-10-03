const express = require("express");
const multer = require("multer");
const { pipeline } = require("stream/promises");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, allowRoles } = require("../middleware/auth");
const { patientFilesDirectory } = require("../config/deployment");
const { env } = require("node:process");
const createStorageAdapter = require("../storage/createStorageAdapter");
const createClinicalFilesService = require("../services/clinicalFiles");

const router = express.Router({ mergeParams: true });
const files = createClinicalFilesService({ db, storage: createStorageAdapter({
  provider: env.PATIENT_FILES_STORAGE_PROVIDER,
  localRoot: patientFilesDirectory()
}) });
const upload = multer({
  storage: {
    _handleFile(req, file, callback) {
      const abort = () => file.stream.destroy();
      req.once("aborted", abort);
      files.storeUpload(file).then(
        result => { req.removeListener("aborted", abort); callback(null, result); },
        error => { req.removeListener("aborted", abort); callback(error); }
      );
    },
    _removeFile(req, file, callback) {
      files.discardUpload(file).then(() => callback(null), callback);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    try { files.validateFile(file); callback(null, true); }
    catch (error) { callback(error); }
  }
});

router.use(authenticate);

router.get("/", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  return res.json(await files.list(req));
}));

router.post("/", allowRoles("head_admin", "admin", "doctor"), upload.single("file"), asyncHandler(async (req, res) => {
  return res.status(201).json(await files.create(req));
}));

async function sendClinicalFile(req, res, next, preview) {
  const { file, object } = await files.retrieve(req, preview);
  if (preview) {
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader("Cache-Control", "private, no-store");
  } else {
    res.attachment(file.original_name);
    res.setHeader("Cache-Control", "public, max-age=0");
  }
  res.type(file.mime_type);
  const etag = `W/"${object.size.toString(16)}-${object.modifiedAt.getTime().toString(16)}"`;
  const modified = Math.floor(object.modifiedAt.getTime() / 1000) * 1000;
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", object.modifiedAt.toUTCString());
  res.setHeader("Accept-Ranges", "bytes");

  // Preserve conditional and byte-range responses while reading through the adapter.
  const match = req.get("If-Match");
  const unmodified = Date.parse(req.get("If-Unmodified-Since"));
  if ((match && match !== "*" && !match.split(/ *, */).some(tag => tag.replace(/^W\//, "") === etag.slice(2)))
    || (!match && !Number.isNaN(unmodified) && modified > unmodified)) {
    return next(Object.assign(new Error("Precondition Failed"), { status: 412 }));
  }
  if (req.fresh) {
    res.removeHeader("Content-Type");
    return res.status(304).end();
  }
  let range = {};
  const ifRange = req.get("If-Range");
  const rangeFresh = !ifRange || (ifRange.includes('"') ? ifRange.includes(etag) : Date.parse(ifRange) >= modified);
  if (/^ *bytes=/.test(req.get("Range")) && rangeFresh) {
    const ranges = req.range(object.size, { combine: true });
    if (ranges === -1) {
      res.setHeader("Content-Range", `bytes */${object.size}`);
      return next(Object.assign(new Error("Range Not Satisfiable"), { status: 416 }));
    }
    if (ranges && ranges.type === "bytes" && ranges.length === 1) range = ranges[0];
  }
  const stream = await files.openRead(file, range);
  if (range.start != null) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${object.size}`);
  }
  res.setHeader("Content-Length", range.start != null ? range.end - range.start + 1 : object.size);
  if (req.method === "HEAD") {
    stream.on("error", () => {});
    stream.destroy();
    return res.end();
  }
  try { await pipeline(stream, res); }
  catch (error) {
    // A disconnected response closes the readable; never append JSON to document bytes.
    if (!res.headersSent && !res.destroyed) return next(error);
    if (!res.destroyed) res.destroy(error);
  }
}

router.get("/:fileId/download", allowRoles("head_admin", "admin", "doctor"),
  asyncHandler((req, res, next) => sendClinicalFile(req, res, next, false)));

router.get("/:fileId/view", allowRoles("head_admin", "admin", "doctor"),
  asyncHandler((req, res, next) => sendClinicalFile(req, res, next, true)));

router.delete("/:fileId", allowRoles("head_admin", "admin", "doctor"), asyncHandler(async (req, res) => {
  await files.remove(req);
  return res.status(204).send();
}));

module.exports = router;
