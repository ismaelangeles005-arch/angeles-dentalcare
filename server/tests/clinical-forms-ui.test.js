const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const html = read("pacientes.html");
const form = html.slice(html.indexOf('<form class="clinical-note-form"'), html.indexOf('<div class="clinical-timeline"'));
const ids = ["clinicalToothCountMode", "clinicalDentition", "clinicalToothNumberingSystem"];
test("Evolution labels distinguish stored procedure detail, type and status; payload retained", () => {
  assert(form.includes('for="clinicalProcedureName">Detalle del procedimiento'));
  assert(form.includes('for="clinicalNoteType">Tipo de registro clínico'));
  assert(form.includes('for="procedureStatus">Estado del procedimiento'));
  assert(!form.includes(">Procedimiento realizado</option>"));
  assert(form.includes('value="procedimiento">Procedimiento</option>'));
  for (const value of ["realizado", "programado", "pendiente", "cancelado"]) assert(form.includes('value="' + value + '"'));
  assert(html.includes('procedureName: document.getElementById("clinicalProcedureName").value'));
  assert(html.includes('performedProcedures: document.getElementById("performedProcedures").value'));
});
test("dental controls have visible labels, compact selector, and Universal visual fallback only", () => {
  ids.forEach(id => assert(form.includes('for="' + id + '"')));
  assert(form.includes("<legend>Piezas dentales</legend>"));
  assert(form.includes('aria-label="Selector de piezas"'));
  assert(form.includes('value="UNIVERSAL" selected>Universal'));
  assert(!form.includes("clinicalIllustration"));
  assert(form.includes('value="FDI">FDI'));
  for (const mode of ["PERMANENT", "PRIMARY", "MIXED"]) assert(form.includes('value="' + mode + '"'));
});
test("explicit FDI survives form reset default; switching display never changes canonical selection", () => {
  const elements = {};
  const el = id => elements[id] ||= { value: "", innerHTML: "" };
  el("system").value = "UNIVERSAL"; el("count").value = "multiple"; el("dentition").value = "MIXED";
  const context = vm.createContext({ window: {}, document: { getElementById: el } });
  vm.runInContext(read("dental-tooth-catalog.js"), context);
  context.window.DentalToothCatalog = context.DentalToothCatalog;
  vm.runInContext(read("dental-tooth-selector.js"), context);
  const selector = context.window.DentalToothSelector.createSelector({
    gridId: "grid", countModeId: "count", numberingSystemId: "system", dentitionModeId: "dentition", hiddenInputId: "hidden", toggleFunctionName: "toggle"
  });
  const selected = ["PERMANENT_UPPER_RIGHT_CENTRAL_INCISOR", "PRIMARY_UPPER_RIGHT_SECOND_MOLAR"];
  selector.setSelected(selected);
  context.renderClinicalToothSelector = () => selector.render();
  const start = html.indexOf("        function conservarSistemaDentalEvolucion(");
  const next = html.indexOf("\n        function ", start + 1);
  vm.runInContext(html.slice(start, next), context);
  const select = el("system");
  select.options = [{ value: "UNIVERSAL", defaultSelected: true }, { value: "FDI", defaultSelected: false }];
  select.value = "FDI";
  context.conservarSistemaDentalEvolucion(select);
  assert.equal(select.options.find(option => option.defaultSelected).value, "FDI");
  assert.deepEqual(Array.from(selector.selections(), s => s.toothId), selected);
  assert.deepEqual(Array.from(selector.selections(), s => s.displayCode), ["11", "55"]);
  select.value = "UNIVERSAL"; context.conservarSistemaDentalEvolucion(select);
  assert.deepEqual(Array.from(selector.selections(), s => s.displayCode), ["8", "A"]);
  assert.deepEqual(Array.from(selector.selections(), s => s.toothId), selected);
  for (const [mode, count] of [["PERMANENT",32],["PRIMARY",20],["MIXED",52]]) {
    el("dentition").value = mode; selector.render();
    assert.equal((el("grid").innerHTML.match(/<button/g) || []).length, count);
    assert.deepEqual(Array.from(selector.selections(), s => s.toothId), selected);
  }
});
test("appointments retain existing numbering default and only add visible dental labels", () => {
  const appointments = read("citas.html");
  for (const id of ["toothCountMode","toothDentition","toothNumberingSystem"]) assert(appointments.includes('for="' + id + '"'));
  const selector = appointments.match(/<select id="toothNumberingSystem"[\s\S]*?<\/select>/)[0];
  assert(selector.indexOf('value="FDI"') < selector.indexOf('value="UNIVERSAL"'));
  assert(!selector.includes("selected"));
  assert(appointments.includes('id="procedimiento" onchange="actualizarPiezaDental()"'));
});
