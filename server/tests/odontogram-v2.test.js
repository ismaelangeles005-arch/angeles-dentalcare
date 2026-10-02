const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const catalog = require("../src/utils/dentalTeeth");
const root = path.resolve(__dirname, "../..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const central = "PERMANENT_UPPER_RIGHT_CENTRAL_INCISOR";
const primary = "PRIMARY_UPPER_RIGHT_SECOND_MOLAR";
const uuid = digit => digit.repeat(8) + "-" + digit.repeat(4) + "-4" + digit.repeat(3) + "-8" + digit.repeat(3) + "-" + digit.repeat(12);
const patient = uuid("1"), org = uuid("2"), originalId = uuid("3"), procedure = uuid("4");

test("52 unique identities/labels, exact legacy permanent order and browser parity", () => {
  assert.equal(catalog.TOOTH_IDS.length, 52);
  assert.equal(new Set(catalog.TOOTH_IDS).size, 52);
  assert.equal(catalog.getTeethByDentition("PERMANENT").length, 32);
  assert.equal(catalog.getTeethByDentition("PRIMARY").length, 20);
  assert.equal(catalog.getTeethByDentition("MIXED").length, 52);
  const expectedTypes = ["THIRD_MOLAR", "SECOND_MOLAR", "FIRST_MOLAR", "SECOND_PREMOLAR", "FIRST_PREMOLAR", "CANINE", "LATERAL_INCISOR", "CENTRAL_INCISOR"];
  const expected = ["UPPER_RIGHT", "UPPER_LEFT", "LOWER_LEFT", "LOWER_RIGHT"].flatMap((quadrant, i) =>
    (i % 2 ? [...expectedTypes].reverse() : expectedTypes).map(type => "PERMANENT_" + quadrant + "_" + type));
  assert.deepEqual(catalog.TOOTH_IDS.slice(0, 32), expected);
  for (const system of ["FDI", "UNIVERSAL"]) assert.equal(new Set(catalog.TOOTH_MAP.map(t => t.labels[system])).size, 52);
  assert.equal(read("server/src/utils/dentalTeeth.js"), read("dental-tooth-catalog.js"));
  assert.deepEqual(fs.readFileSync(path.join(root, "server/src/utils/dentalTeeth.js")), fs.readFileSync(path.join(root, "dental-tooth-catalog.js")));
  assert(catalog.TOOTH_MAP.every(Object.isFrozen));
  for (const invalid of ["11", "8", "A", "arbitrary", "PRIMARY_UPPER_RIGHT_FIRST_PREMOLAR", "PRIMARY_LOWER_LEFT_THIRD_MOLAR"]) assert(!catalog.isValidToothId(invalid));
});

test("all Universal primary A-T correspond to FDI 55-51,61-65,75-71,81-85; permanent 11 is Universal 8", () => {
  assert.equal(catalog.getLabel(central, "FDI"), "11");
  assert.equal(catalog.getLabel(central, "UNIVERSAL"), "8");
  const fdi = ["55","54","53","52","51","61","62","63","64","65","75","74","73","72","71","81","82","83","84","85"];
  catalog.getTeethByDentition("PRIMARY").forEach((tooth, i) => {
    assert.equal(tooth.labels.FDI, fdi[i]);
    assert.equal(tooth.labels.UNIVERSAL, String.fromCharCode(65 + i));
  });
});

for (const [id, allowed, denied] of [
  [central, ["PALATAL", "INCISAL"], ["LINGUAL", "OCCLUSAL"]],
  ["PRIMARY_UPPER_LEFT_CANINE", ["PALATAL", "INCISAL"], ["LINGUAL", "OCCLUSAL"]],
  ["PERMANENT_LOWER_RIGHT_CENTRAL_INCISOR", ["LINGUAL", "INCISAL"], ["PALATAL", "OCCLUSAL"]],
  ["PRIMARY_LOWER_LEFT_FIRST_MOLAR", ["LINGUAL", "OCCLUSAL"], ["PALATAL", "INCISAL"]]
]) test("anatomical surfaces: " + id, () => {
  allowed.forEach(surface => assert(catalog.isValidSurfaceForTooth(id, surface)));
  denied.forEach(surface => assert(!catalog.isValidSurfaceForTooth(id, surface)));
  assert(catalog.isValidSurfaceForTooth(id, null));
});

test("bounded canonical cleaning supports 52, derives labels, rejects spoofed IDs/systems/duplicates", () => {
  const selections = catalog.TOOTH_IDS.map(toothId => ({ toothId, numberingSystem: "FDI", displayCode: "SPOOF" }));
  const result = catalog.cleanToothSelections(selections);
  assert.equal(result.length, 52);
  assert.equal(result[7].displayCode, "11");
  assert.equal(selections[7].displayCode, "SPOOF");
  assert.equal(catalog.cleanToothSelections([{ toothId: primary, numberingSystem: "UNIVERSAL" }])[0].displayCode, "A");
  for (const value of [[...selections, selections[0]], [selections[0], selections[0]], [{ toothId: "11", numberingSystem: "FDI" }],
    [{ toothId: central, numberingSystem: "PALMER" }], [{ toothId: primary }], "bad"]) {
    assert.throws(() => catalog.cleanToothSelections(value), error => error.status === 400);
  }
  for (const route of ["appointments", "clinicalNotes"]) {
    const source = read("server/src/routes/" + route + ".js");
    assert(source.includes('const { cleanToothSelections } = require("../utils/dentalTeeth")'));
    assert(source.includes("cleanToothSelections(toothSelections)"));
    assert(!source.includes(".slice(0, 32)"));
  }
});

function browser() {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "" }); return elements.get(id); };
  const context = { window: {}, document: { getElementById: el } };
  vm.runInNewContext(read("dental-tooth-catalog.js"), context);
  context.window.DentalToothCatalog = context.DentalToothCatalog;
  vm.runInNewContext(read("dental-tooth-selector.js"), context);
  el("count").value = "1"; el("system").value = "FDI";
  const selector = context.window.DentalToothSelector.createSelector({ gridId: "grid", countModeId: "count", numberingSystemId: "system", hiddenInputId: "hidden", toggleFunctionName: "toggle" });
  return { el, selector, context };
}

test("selector primary, numbering switch, 1/2/3/4/multiple and historical permanent selection", () => {
  const { el, selector } = browser();
  selector.setSelected([{ toothId: central, displayCode: "1.1", numberingSystem: "FDI" }]);
  assert.equal(selector.selections()[0].displayCode, "11");
  el("system").value = "UNIVERSAL"; selector.render();
  assert.equal(selector.selections()[0].toothId, central); assert.equal(selector.selections()[0].displayCode, "8");
  selector.setSelected([primary]); assert(el("grid").innerHTML.includes(primary));
  assert.equal(selector.selections()[0].displayCode, "A");
  selector.setDentitionMode("MIXED");
  assert.equal((el("grid").innerHTML.match(/<button/g) || []).length, 52);
  for (const count of ["1", "2", "3", "4", "multiple"]) {
    selector.reset(); el("count").value = count;
    const n = count === "multiple" ? 5 : Number(count);
    for (const id of catalog.TOOTH_IDS.slice(0, n)) selector.toggle(id);
    assert(selector.isValid());
    if (count !== "multiple") { selector.toggle(primary); assert.equal(selector.selectedToothIds().length, n); }
  }
  selector.toggle("FAKE"); assert(!selector.selectedToothIds().includes("FAKE"));
});

// Execute real route handlers against a transactional in-memory SQL double.
function routeHarness(file, initial = []) {
  let rows = initial.map(row => ({ organization_id: org, patient_id: patient, status: "ACTIVE", ...row })), saved;
  let audits = [], savedAudits;
  const calls = [], routes = [];
  const query = async (sql, values = []) => {
    const q = sql.replace(/\s+/g, " ").trim(); calls.push({ q, values });
    if (q === "BEGIN") { saved = structuredClone(rows); savedAudits = [...audits]; return { rows: [] }; }
    if (q === "ROLLBACK") { rows = saved; audits = savedAudits; return { rows: [] }; }
    if (q === "COMMIT") return { rows: [] };
    if (file === "appointments" || file === "clinicalNotes") {
      if (q.startsWith("SELECT") && q.includes("FROM patients")) return { rows: [{ id: patient, full_name: "Mock", doctor_id: procedure }] };
      if (q.startsWith("SELECT") && q.includes("FROM doctors")) return { rows: [{ id: procedure }] };
      if (q.startsWith("SELECT") && /FROM (appointments|doctor_availability|users)/.test(q)) return { rows: [] };
      if (q.startsWith("INSERT INTO appointments") || q.startsWith("INSERT INTO clinical_notes")) return { rows: [{ id: originalId }] };
      if (q.startsWith("UPDATE patients") || q.startsWith("INSERT INTO notifications")) return { rows: [] };
    }
    if (q.startsWith("SELECT oe.*")) return { rows: rows.filter(r => r.id === values[0] && r.organization_id === values[1]) };
    if (q.startsWith("SELECT id FROM patients")) return { rows: values[1] === org ? [{ id: patient }] : [] };
    if (q.startsWith("SELECT id FROM odontogram_entries WHERE related_entry_id")) return { rows: rows.filter(r => r.related_entry_id === values[0]) };
    if (q.startsWith("SELECT id, status FROM odontogram_entries")) return { rows: rows.filter(r => r.id === values[0] && r.patient_id === values[1] && r.organization_id === values[2] && r.entry_type === values[3]) };
    if (q.startsWith("SELECT id FROM odontogram_entries")) return { rows: rows.filter(r => r.related_entry_id === values[0] && r.entry_type === "COMPLETED_TREATMENT" && !["VOIDED","SUPERSEDED"].includes(r.status)) };
    if (q.includes("FROM procedure_catalog")) return { rows: [{ id: procedure, name: "Snapshot", category_name: "Operatoria", base_price: "100.00" }] };
    if (q.startsWith("INSERT INTO odontogram_entries")) {
      const keys = ["organization_id","patient_id","tooth_id","surface","entry_type","condition_code","condition_label","procedure_id","status","notes","doctor_id","created_by","source_clinical_note_id","related_entry_id"];
      const row = { id: uuid(String(rows.length + 5)), created_at: new Date().toISOString() };
      keys.forEach((key, index) => row[key] = values[index]); rows.push(row); return { rows: [row] };
    }
    if (q.startsWith("UPDATE odontogram_entries")) {
      const row = rows.find(r => r.id === values[0] && r.organization_id === (q.includes("RESOLVED") ? values[2] : values[1]));
      if (row) row.status = q.includes("RESOLVED") ? "RESOLVED" : "SUPERSEDED";
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (q.includes("FROM odontogram_entries oe")) return { rows: rows.filter(r => r.organization_id === values[0] && r.patient_id === values[1] && (!q.includes("oe.status = 'ACTIVE'") || r.status === "ACTIVE")) };
    if (q.includes("SELECT tp.*")) return { rows: [{ id: values[0], patient_id: patient, organization_id: org, status: "DRAFT" }] };
    if (q.startsWith("SELECT tooth_id, surface")) return { rows: rows.filter(r => r.id === values[0] && r.organization_id === values[1] && r.patient_id === values[2] && r.entry_type === "PROPOSED_TREATMENT" && r.status === "ACTIVE") };
    if (q.startsWith("SELECT id FROM treatment_plan_items")) return { rows: [] };
    if (q.startsWith("INSERT INTO treatment_plan_items")) return { rows: [{ id: uuid("8"), tooth_id: values[3], surface: values[4], procedure_name_snapshot: values[5], unit_price_snapshot: values[7], odontogram_entry_id: values[2] }] };
    if (q.includes("FROM treatment_plan_acceptances")) return { rows: [] };
    if (q.startsWith("UPDATE treatment_plans")) return { rows: [] };
    throw new Error("Unhandled SQL: " + q);
  };
  const client = { query, release() {} };
  const router = { use() {}, param() {}, delete() {}, get(p, ...h) { routes.push({ verb: "get", p, h }); }, post(p, ...h) { routes.push({ verb: "post", p, h }); }, patch() {} };
  const context = { module: { exports: {} }, require(name) {
    if (name === "express") return { Router: () => router };
    if (name === "../db") return { query, pool: { connect: async () => client } };
    if (name === "../utils/asyncHandler") return fn => fn;
    if (name === "../middleware/auth") return { authenticate() {}, allowRoles: () => () => {} };
    if (name === "../utils/audit") return { writeAuditLog: async (...args) => audits.push(args.slice(1, 5)) };
    if (name === "../utils/dentalTeeth") return catalog;
    throw Error(name);
  }};
  vm.runInNewContext(read("server/src/routes/" + file + ".js"), context);
  return { calls, rows: () => rows, audits: () => audits, async run(p, body = {}, params = {}, verb = "post") {
    const route = routes.find(r => r.verb === verb && (Array.isArray(r.p) ? r.p.includes(p) : r.p === p));
    assert(route, p);
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
    await route.h.at(-1)({ body, params, query: {}, user: { organizationId: org, id: uuid("9") } }, res);
    return res;
  }};
}
const payload = (tooth = central, surface = "PALATAL", type = "DIAGNOSIS") => ({
  patient_id: patient, tooth_id: tooth, surface, entry_type: type, condition_code: "CARIES", condition_label: "Caries", status: "ACTIVE", notes: "Changed"
});

for (const [surface, status] of [["LINGUAL", 400], ["PALATAL", 201], [null, 201]]) test("new odontogram anatomical surface " + surface, async () => {
  const h = routeHarness("odontogram"); const response = await h.run("/", { ...payload(central, surface), legacy: true, previous_surface: surface });
  assert.equal(response.code, status); assert.equal(h.rows().length, status === 201 ? 1 : 0);
});

for (const [surface, status] of [["LINGUAL", 201], ["PALATAL", 201], ["OCCLUSAL", 400], [null, 400]]) test("locked historical correction LINGUAL to " + surface, async () => {
  const h = routeHarness("odontogram", [{ ...payload(central, "LINGUAL"), id: originalId }]);
  const response = await h.run("/:entryId/correct", { ...payload(central, surface), reason: "Correct notes", previous_surface: surface, legacy: true }, { entryId: originalId });
  assert.equal(response.code, status);
  assert(h.calls.find(call => call.q.includes("FOR UPDATE OF oe")));
  if (status === 201) {
    assert.equal(h.rows()[0].status, "SUPERSEDED");
    assert.equal(h.rows()[0].surface, "LINGUAL");
    assert.equal(h.rows()[1].surface, surface);
    assert.equal(h.audits()[0][0], "correct");
  } else { assert.equal(h.rows().length, 1); assert.equal(h.rows()[0].status, "ACTIVE"); }
});

test("primary diagnosis/proposal/completed relations, audit, current/history and correction retain canonical identity", async () => {
  const h = routeHarness("odontogram");
  const diagnosis = await h.run("/", payload(primary, "OCCLUSAL"));
  const proposed = await h.run("/", { ...payload(primary, "OCCLUSAL", "PROPOSED_TREATMENT"), related_entry_id: diagnosis.body.id, procedure_id: procedure });
  const completed = await h.run("/", { ...payload(primary, "OCCLUSAL", "COMPLETED_TREATMENT"), related_entry_id: proposed.body.id, procedure_id: procedure });
  assert.equal(completed.code, 201);
  assert.equal(h.rows().find(r => r.id === proposed.body.id).status, "RESOLVED");
  const current = await h.run("/patient/:patientId/current", {}, { patientId: patient }, "get");
  assert.equal(current.body.teeth[primary].length, 2);
  const history = await h.run("/patient/:patientId", {}, { patientId: patient }, "get");
  assert.equal(history.body.length, 3);
  assert.equal(h.audits().filter(a => a[0] === "create").length, 3);
  assert.equal(h.audits().filter(a => a[0] === "update_status").length, 1);
  const correction = routeHarness("odontogram", [{ ...payload(primary, "PALATAL"), id: originalId }]);
  assert.equal((await correction.run("/:entryId/correct", { ...payload(primary, "PALATAL"), reason: "Notes only" }, { entryId: originalId })).body.tooth_id, primary);
});

test("primary and permanent proposals create plan items with server snapshots; invalid anatomy rejected", async () => {
  for (const tooth of [primary, central]) {
    const h = routeHarness("treatmentPlans", [{ id: originalId, tooth_id: tooth, surface: "PALATAL", entry_type: "PROPOSED_TREATMENT", procedure_id: procedure }]);
    const result = await h.run("/:planId/items", { procedure_id: procedure, odontogram_entry_id: originalId }, { planId: uuid("7") });
    assert.equal(result.code, 201); assert.equal(result.body.tooth_id, tooth);
    assert.equal(result.body.odontogram_entry_id, originalId); assert.equal(result.body.procedure_name_snapshot, "Snapshot");
    assert.equal(result.body.unit_price_snapshot, "100.00");
  }
  for (const [tooth, surface] of [["FAKE", null], [central, "LINGUAL"]]) {
    const h = routeHarness("treatmentPlans");
    await assert.rejects(() => h.run("/:planId/items", { procedure_id: procedure, tooth_id: tooth, surface }, { planId: uuid("7") }), error => error.status === 400);
    assert(h.calls.some(call => call.q === "ROLLBACK"));
  }
});

for (const file of ["appointments", "clinicalNotes"]) test(file + " real handler derives primary display code and rejects noncanonical selection before writing", async () => {
  for (const system of ["FDI", "UNIVERSAL"]) {
    const h = routeHarness(file);
    const body = { pacienteId: patient, patientId: patient, doctorId: procedure, fecha: "2026-10-01", hora: "10:00",
      categoriaProcedimiento: "evaluacion", procedimiento: "Evaluacion", dentalArea: "Operatoria",
      note: "Mock note", toothCountMode: "1", toothNumberingSystem: system, toothNumber: "A", piezaDental: "A",
      toothSelections: [{ toothId: primary, numberingSystem: system, displayCode: "SPOOF" }] };
    const response = await h.run("/", body);
    assert.equal(response.code, 201);
    const insert = h.calls.find(c => c.q.startsWith("INSERT INTO " + (file === "appointments" ? file : "clinical_notes")));
    const stored = insert.values.find(value => typeof value === "string" && value.startsWith('[{"toothId"'));
    assert.equal(JSON.parse(stored)[0].displayCode, system === "FDI" ? "55" : "A");
    const invalid = routeHarness(file);
    await assert.rejects(() => invalid.run("/", { ...body, toothSelections: [{ toothId: "55", numberingSystem: system }] }), e => e.status === 400);
    assert.equal(invalid.calls.length, 0);
  }
});

test("forward migration/schema exact supported IDs, nullable, transactional, ordered, no historical conversion", () => {
  const migration = read("server/database/migration_odontogram_primary_teeth.sql");
  const schema = read("server/database/schema.sql");
  const pattern = migration.match(/'\^\(PERMANENT_[^']+'/)[0].slice(1, -1);
  assert(schema.includes("'" + pattern + "'"));
  const regex = new RegExp(pattern);
  catalog.TOOTH_IDS.forEach(id => assert(regex.test(id)));
  for (const id of ["FAKE", "11", "PRIMARY_UPPER_LEFT_THIRD_MOLAR", "PRIMARY_UPPER_RIGHT_FIRST_PREMOLAR"]) assert(!regex.test(id));
  assert(migration.includes("BEGIN;") && migration.includes("COMMIT;"));
  assert(migration.includes("tooth_id IS NULL"));
  assert(migration.includes("RAISE EXCEPTION"));
  assert(!/UPDATE |DELETE FROM|odontogram_entries|PALMER/.test(migration));
  const names = JSON.parse(read("server/database/migrations.json"));
  assert.equal(names.length, 28); assert.equal(names.at(-1), "migration_billing_payment_idempotency.sql");
});

test("historical UI option is local to correction; default retained; changing dentition only clears hidden UI selection", () => {
  const html = read("pacientes.html");
  const extract = name => {
    const start = html.indexOf("        function " + name + "(");
    const end = html.indexOf("\n        function ", start + 1);
    return html.slice(start, end);
  };
  let selected = "unset", options = [];
  const select = { dataset: {}, append(option) { options.push(option); }, get value() { return selected; }, set value(v) { selected = v; } };
  const context = { DentalToothSelector: catalog, ODONTOGRAM_SURFACES: [{ value: "LINGUAL", label: "Lingual" }],
    document: { createElement: () => ({ remove() { options = options.filter(o => o !== this); } }) } };
  vm.runInNewContext(extract("preservarSuperficieHistorica"), context);
  context.preservarSuperficieHistorica(select, { tooth_id: central, surface: "LINGUAL" });
  assert.equal(options[0].textContent, "Lingual (histórica)"); assert.equal(select.value, "LINGUAL");
  select.value = "PALATAL"; select.onchange(); assert.equal(options.length, 0);
  context.preservarSuperficieHistorica(select, { tooth_id: "PERMANENT_LOWER_RIGHT_CENTRAL_INCISOR", surface: "LINGUAL" });
  assert.equal(options.length, 0);
  assert(!extract("renderOdontogramDetail").includes("preservarSuperficieHistorica"));
  const view = extract("renderOdontogramView");
  assert(view.includes("selectedOdontogramToothId = null"));
  assert(!view.includes("DentalApi"));
  assert.equal((html.match(/superficiesPiezaOdontograma\(\)\.map/g) || []).length, 4);
});

test("odontogram view exposes 32/20/52 in separate arches, clears hidden selection without touching clinical memory", () => {
  const html = read("pacientes.html");
  const start = html.indexOf("        function renderOdontogramView()");
  const end = html.indexOf("\n        function ", start + 1);
  const elements = new Map(), groups = {};
  const el = id => { if (!elements.has(id)) { const section = {}; elements.set(id, { value: "PERMANENT", closest: () => section }); } return elements.get(id); };
  const current = Object.freeze({ teeth: Object.freeze({ [primary]: Object.freeze([{ id: originalId, tooth_id: primary }]) }) });
  const context = { DentalToothSelector: catalog, document: { getElementById: el },
    odontogramCurrent: current, selectedOdontogramToothId: primary,
    renderOdontogramArch: (id, teeth) => { groups[id] = teeth; }, renderOdontogramDetail() {} };
  vm.runInNewContext(html.slice(start, end), context);
  for (const [mode, count] of [["PERMANENT", 32], ["PRIMARY", 20], ["MIXED", 52]]) {
    el("odontogramDentition").value = mode; context.renderOdontogramView();
    assert.equal(Object.values(groups).reduce((sum, teeth) => sum + teeth.length, 0), count);
    assert.equal(context.odontogramCurrent, current);
    for (const [id, teeth] of Object.entries(groups)) assert.equal(el(id).closest().hidden, teeth.length === 0);
  }
  assert.equal(context.selectedOdontogramToothId, null);
  context.selectedOdontogramToothId = primary; context.renderOdontogramView();
  assert.equal(context.selectedOdontogramToothId, primary);
});
