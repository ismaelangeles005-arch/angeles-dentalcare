const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { createRequire } = require("node:module");
const express = require("express");
const createService = require("../src/services/clinicalFiles");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maelven-clinical-storage-"));
  const rows = new Map();
  const state = { failInsert: false, actor: { id: "user", organizationId: "org", role: "admin" }, queries: [] };
  const db = { async query(sql, params) {
    state.queries.push({ sql, params });
    if (sql.includes("FROM patients")) {
      assert.match(sql, /p.organization_id = \$2/);
      assert.match(sql, /p.deleted_at IS NULL/);
      if (params.length === 3) {
        assert.match(sql, /FROM patient_visits/);
        assert.match(sql, /pv.organization_id = p.organization_id/);
      }
      return { rows: params[0] === "patient" && params[1] === "org"
        && (params.length < 3 || ["assigned", "visited"].includes(params[2])) ? [{ id: "patient" }] : [] };
    }
    if (sql.includes("INSERT INTO patient_files")) {
      if (state.failInsert) throw new Error("metadata fixture failure");
      const [organization_id, patient_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, category, description] = params;
      const row = { id: String(rows.size + 1), organization_id, patient_id, uploaded_by, original_name,
        stored_name, mime_type, size_bytes, category, description, created_at: "2026-10-01T00:00:00Z" };
      rows.set(row.id, row);
      return { rows: [safe(row)] };
    }
    assert.match(sql, /organization_id = \$[23]/);
    assert.match(sql, /deleted_at IS NULL/);
    if (sql.includes("JOIN users")) {
      return { rows: [...rows.values()].filter(row => row.patient_id === params[0]
        && row.organization_id === params[1] && !row.deleted_at).map(safe) };
    }
    const row = rows.get(params[0]);
    if (!row || row.patient_id !== params[1] || row.organization_id !== params[2] || row.deleted_at) return { rows: [] };
    if (sql.includes("UPDATE patient_files")) row.deleted_at = "deleted";
    return { rows: [row] };
  } };
  function safe(row) {
    return { id: row.id, name: row.original_name, mime_type: row.mime_type, size_bytes: row.size_bytes,
      category: row.category, description: row.description, created_at: row.created_at };
  }
  const file = path.resolve(__dirname, "../src/routes/patientFiles.js");
  const actualRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, exports: module.exports, console, Buffer,
    require(name) {
      if (name === "../db") return db;
      if (name === "../config/deployment") return { patientFilesDirectory: () => root };
      if (name === "../middleware/auth") return {
        authenticate(req, res, next) { req.user = state.actor; next(); },
        allowRoles: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.sendStatus(403)
      };
      return actualRequire(name);
    }
  });
  const app = express();
  app.use("/patients/:patientId/files", module.exports);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/patients/patient/files`;
  async function upload(type = "application/pdf", fields = {}, content = "document bytes", name = "original.pdf") {
    const form = new FormData();
    form.append("file", new Blob([content], { type }), name);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
  }
  return { root, rows, state, url, upload };
}

test("HTTP upload/list/view/download/HEAD/range/delete preserve metadata and original filename", async t => {
  const { root, rows, url, upload } = await fixture(t);
  const response = await upload("application/pdf", { category: "radiografia", description: "  detalle  " });
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(file.name, "original.pdf");
  assert.equal(file.category, "radiografia");
  assert.equal(file.description, "detalle");
  assert.equal(file.size_bytes, 14);
  assert.equal(file.stored_name, undefined);
  assert.match(rows.get(file.id).stored_name, /^[a-f0-9-]{36}\.pdf$/);
  assert.equal((await (await fetch(url)).json()).length, 1);
  const view = await fetch(`${url}/${file.id}/view`);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get("content-type"), "application/pdf");
  assert.match(view.headers.get("content-disposition"), /^inline; filename\*=UTF-8''original.pdf$/);
  assert.equal(view.headers.get("cache-control"), "private, no-store");
  assert.equal(await view.text(), "document bytes");
  const download = await fetch(`${url}/${file.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="original.pdf"$/);
  assert.equal(await download.text(), "document bytes");
  const head = await fetch(`${url}/${file.id}/download`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "14");
  assert.equal(await head.text(), "");
  const part = await fetch(`${url}/${file.id}/view`, { headers: { Range: "bytes=0-3" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 0-3/14");
  assert.equal(await part.text(), "docu");
  assert.equal((await fetch(`${url}/${file.id}/view`, { headers: { Range: "bytes=999-" } })).status, 416);
  assert.equal((await fetch(`${url}/${file.id}/view`, { headers: { "If-Match": '"wrong"' } })).status, 412);
  // Node fetch otherwise adds Cache-Control: no-cache to conditional requests, forcing 200.
  assert.equal((await fetch(`${url}/${file.id}/view`, { headers: {
    "If-None-Match": view.headers.get("etag"), "Cache-Control": "max-age=3600"
  } })).status, 304);
  assert.equal((await fetch(`${url}/${file.id}`, { method: "DELETE" })).status, 204);
  assert.equal(rows.get(file.id).deleted_at, "deleted");
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(await (await fetch(url)).json(), []);
  assert.equal((await fetch(`${url}/${file.id}/view`)).status, 404);
  assert.equal((await fetch(`${url}/${file.id}`, { method: "DELETE" })).status, 404);
});

test("image previews and TIFF/DICOM download-only behavior stay unchanged", async t => {
  const { upload, url } = await fixture(t);
  for (const type of ["image/jpeg", "image/png", "image/webp", "image/tiff", "application/dicom"]) {
    const uploaded = await upload(type);
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    const view = await fetch(`${url}/${file.id}/view`);
    assert.equal(view.status, ["image/tiff", "application/dicom"].includes(type) ? 415 : 200);
    await view.arrayBuffer();
    const download = await fetch(`${url}/${file.id}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), type);
    await download.arrayBuffer();
  }
});

test("patient/organization and doctor assignment or visit checks retain access boundaries", async t => {
  const { state, url, upload, root } = await fixture(t);
  const file = await (await upload()).json();
  state.actor.organizationId = "other-org";
  for (const suffix of ["", `/${file.id}/view`, `/${file.id}/download`]) {
    assert.equal((await fetch(url + suffix)).status, 403);
  }
  assert.equal((await upload()).status, 403);
  assert.equal(fs.readdirSync(root).length, 1);
  state.actor.organizationId = "org";
  assert.equal((await fetch(url.replace("/patient/", "/other-patient/"))).status, 403);
  state.actor = { ...state.actor, role: "doctor", isDoctor: true, doctorId: "unassigned" };
  assert.equal((await fetch(url)).status, 403);
  for (const doctorId of ["assigned", "visited"]) {
    state.actor.doctorId = doctorId;
    assert.equal((await fetch(url)).status, 200);
  }
  state.actor.isReception = true;
  assert.equal((await fetch(url)).status, 403);
  state.actor = { role: "PLATFORM_SUPER_ADMIN" };
  assert.equal((await fetch(url)).status, 403);
});

test("metadata failure compensates only new upload; missing physical file and soft delete stay compatible", async t => {
  const { state, upload, root, rows, url } = await fixture(t);
  state.failInsert = true;
  assert.equal((await upload()).status, 500);
  assert.deepEqual(fs.readdirSync(root), []);
  state.failInsert = false;
  const file = await (await upload("application/pdf", { category: "unknown", description: "x".repeat(600) })).json();
  assert.equal(file.category, "otro");
  assert.equal(file.description.length, 500);
  fs.unlinkSync(path.join(root, rows.get(file.id).stored_name));
  const missing = await fetch(`${url}/${file.id}/download`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).message, "El archivo fisico no esta disponible");
  assert.equal((await fetch(`${url}/${file.id}`, { method: "DELETE" })).status, 204);
  assert.equal(rows.get(file.id).deleted_at, "deleted");
});

test("service soft delete remains best effort on storage errors without changing clinical metadata policy", async () => {
  let deleted = false;
  let logged = false;
  const service = createService({ db: { async query(sql) {
    if (sql.includes("FROM patients")) return { rows: [{ id: "p" }] };
    assert.match(sql, /SET deleted_at = NOW\(\)/);
    deleted = true;
    return { rows: [{ stored_name: "fixture.pdf" }] };
  } }, storage: { async delete() { throw new Error("fixture locked file"); } },
  logger: { error() { logged = true; } } });
  await service.remove({ params: { patientId: "p", fileId: "f" }, user: { organizationId: "o" } });
  assert.equal(deleted, true);
  assert.equal(logged, true);
});

test("aborting a multipart upload cleans its temporary file and inserts no metadata", async t => {
  const { url, rows, root } = await fixture(t);
  const request = http.request(url, { method: "POST", headers: {
    "Content-Type": "multipart/form-data; boundary=fixture", "Content-Length": "1000000"
  } });
  request.on("error", () => {});
  request.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="cancelled.pdf"\r\nContent-Type: application/pdf\r\n\r\npartial');
  const deadline = Date.now() + 2000;
  while (!fs.readdirSync(root).some(name => name.endsWith(".tmp")) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.readdirSync(root).length, 1);
  request.destroy();
  while (fs.readdirSync(root).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(rows.size, 0);
});
