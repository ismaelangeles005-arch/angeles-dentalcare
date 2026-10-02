const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const html = read("pacientes.html");
const functions = [
  "codigoOdontograma", "entradasOdontograma", "renderOdontogramArch", "cambiarNumeracionOdontograma",
  "renderOdontogramView", "superficiesPiezaOdontograma", "preservarSuperficieHistorica",
  "seleccionarPiezaOdontograma", "etiquetaEntradaOdontograma", "renderOdontogramDetail",
  "instalarSuperficiesVisualesOdontograma", "sincronizarSuperficiesVisualesOdontograma",
  "etiquetaRelacionOdontograma", "renderOdontogramEntry", "actualizarSuperficieOdontograma", "actualizarDiagnosticoOdontograma"
];
function extract(name) {
  const start = html.indexOf("        function " + name + "(");
  assert(start >= 0, name);
  const next = /\n        (?:async )?function /.exec(html.slice(start + 1));
  assert(next, name);
  return html.slice(start, start + 1 + next.index);
}
function element() {
  return {
    value: "", innerHTML: "", textContent: "", dataset: {}, children: [], attributes: {}, disabled: false,
    parentElement: { insertAdjacentElement() {} },
    setAttribute(k, v) { this.attributes[k] = v; },
    appendChild(child) { this.children.push(child); },
    append(child) { this.children.push(child); child.remove = () => this.children.splice(this.children.indexOf(child), 1); },
    querySelectorAll() { return this.children; },
    addEventListener(name, fn) { this.listener = fn; },
    dispatchEvent() { this.onchange?.(); this.listener?.(); },
    closest() { return this.section ||= {}; }
  };
}
function browser() {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = vm.createContext({
    window: {}, Event: class {}, document: { getElementById: el, createElement: element },
    DentalRoles: { escapeHtml: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") },
    selectedOdontogramToothId: null, odontogramCurrent: { teeth: {} }
  });
  vm.runInContext(read("dental-tooth-catalog.js"), context);
  context.window.DentalToothCatalog = context.DentalToothCatalog;
  vm.runInContext(read("dental-tooth-selector.js"), context);
  context.DentalToothSelector = context.window.DentalToothSelector;
  context.clinicalToothSelector = context.DentalToothSelector.createSelector({
    gridId: "clinicalToothGrid",
    dentitionModeId: "clinicalDentition",
    countModeId: "clinicalToothCountMode",
    numberingSystemId: "clinicalToothNumberingSystem",
    hiddenInputId: "clinicalToothNumber",
    toggleFunctionName: "toggleClinicalTooth",
    visual: true
  });
  vm.runInContext(html.slice(html.indexOf("        const ODONTOGRAM_EXISTING_CONDITIONS"), html.indexOf("        async function cargarDoctores")), context);
  vm.runInContext(functions.map(extract).join("\n"), context);
  el("odontogramDentition").value = "PERMANENT";
  el("odontogramNumberingSystem").value = "FDI";
  return { context, el, catalog: context.DentalToothCatalog };
}
const central = "PERMANENT_UPPER_RIGHT_CENTRAL_INCISOR";
const primary = "PRIMARY_LOWER_LEFT_SECOND_MOLAR";

test("clinical names and four distinct SVG tooth families reuse all 52 canonical identities", () => {
  const { context, catalog } = browser();
  const helper = context.DentalToothSelector;
  const families = new Set();
  for (const tooth of catalog.TOOTH_MAP) {
    const svg = helper.clinicalIllustration(tooth.toothId);
    assert(svg.includes('<svg')); assert(!svg.includes(tooth.toothId));
    families.add(svg.match(/data-family="([^"]+)"/)[1]);
    assert(!helper.clinicalName(tooth.toothId).includes("_"));
    assert(helper.clinicalName(tooth.toothId).includes(tooth.dentition === "PRIMARY" ? "temporal" : "permanente"));
  }
  assert.equal(families.size, 4);
  assert.equal(helper.clinicalName(central), "Incisivo central superior derecho permanente");
  assert.equal(helper.clinicalIllustration("invalid"), "");
});

for (const [mode, count] of [["PERMANENT", 32], ["PRIMARY", 20], ["MIXED", 52]]) {
  test("clinical arch rendering " + mode + " preserves identities, accessible selection and numbering", () => {
    const { context, el } = browser();
    el("odontogramDentition").value = mode;
    context.renderOdontogramView();
    const ids = ["odontogramUpperGrid", "odontogramLowerGrid", "odontogramPrimaryUpperGrid", "odontogramPrimaryLowerGrid"];
    const rendered = () => ids.map(id => el(id).innerHTML).join("");
    assert.equal((rendered().match(/<svg/g) || []).length, count);
    const selected = mode === "PRIMARY" ? primary : central;
    context.seleccionarPiezaOdontograma(selected);
    assert.equal((rendered().match(/aria-pressed="true"/g) || []).length, 1);
    assert(rendered().includes("seleccionarPiezaOdontograma('" + selected + "')"));
    el("odontogramNumberingSystem").value = "UNIVERSAL";
    const detail = el("odontogramDetail").innerHTML;
    context.cambiarNumeracionOdontograma();
    assert.equal(context.selectedOdontogramToothId, selected);
    assert.equal(el("odontogramDetail").innerHTML, detail, "form DOM retained");
    assert.equal(el("odontogramPieceTitle").textContent, "Pieza " + context.DentalToothSelector.getLabel(selected, "UNIVERSAL"));
    assert.equal((rendered().match(/<svg/g) || []).length, count);
  });
}

test("panel has clinical names, four empty states and no visible raw toothId", () => {
  const { context, el } = browser();
  context.seleccionarPiezaOdontograma(central);
  const panel = el("odontogramDetail").innerHTML;
  assert(!panel.includes("toothId")); assert(!panel.includes(central));
  for (const label of ["Sin condiciones registradas", "Sin diagnósticos registrados", "Sin tratamientos propuestos", "Sin tratamientos realizados"]) assert(panel.includes(label));
  assert(panel.includes("Incisivo central superior derecho permanente"));
  context.renderOdontogramDetail();
  assert.equal(el("odontogramDetail").innerHTML, panel);
});

test("frontal lower arch aligns patient sides without mutating canonical catalog order", () => {
  const { context, el, catalog } = browser();
  const teeth = catalog.getTeethByDentition("PERMANENT").filter(tooth => tooth.arch === "LOWER");
  const before = JSON.stringify(teeth);
  context.renderOdontogramArch("lower", teeth);
  const codes = [...el("lower").innerHTML.matchAll(/class="odontogram-code">([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(codes, ["48", "47", "46", "45", "44", "43", "42", "41", "31", "32", "33", "34", "35", "36", "37", "38"]);
  assert.equal(JSON.stringify(teeth), before);
});

test("four record types/markers and historical proposal references stay distinct and escaped", () => {
  const { context, el } = browser();
  const types = ["EXISTING_CONDITION", "DIAGNOSIS", "PROPOSED_TREATMENT", "COMPLETED_TREATMENT"];
  context.odontogramCurrent = { teeth: { [central]: types.map((entry_type, i) => ({
    id: String(i), tooth_id: central, entry_type, condition_label: "<clinical>", surface: "MESIAL", status: "ACTIVE",
    related_entry_id: i === 3 ? "old" : null
  })) }, related_entries: { old: { id: "old", entry_type: "PROPOSED_TREATMENT", condition_label: "Propuesta histórica", status: "RESOLVED", surface: null } } };
  const before = JSON.stringify(context.odontogramCurrent);
  context.seleccionarPiezaOdontograma(central);
  const panel = el("odontogramDetail").innerHTML;
  assert(panel.includes("Basado en propuesta: Propuesta histórica"));
  assert(panel.includes("&lt;clinical>")); assert(!panel.includes("<clinical>"));
  types.forEach(type => assert(el("odontogramUpperGrid").innerHTML.includes('data-kind="' + type + '"')));
  assert.equal(JSON.stringify(context.odontogramCurrent), before);
  assert(!extract("renderOdontogramEntry").includes("DentalApi"));
});

test("visual surfaces share original form values; full tooth, anatomy, historical exception and disabled state", () => {
  const { context, el } = browser();
  context.selectedOdontogramToothId = central;
  const select = element();
  const detail = { querySelectorAll: () => [select] };
  context.instalarSuperficiesVisualesOdontograma(detail);
  const buttons = select.odontogramSurfaceMap.children;
  assert.deepEqual(buttons.map(b => b.dataset.surface), ["", "MESIAL", "DISTAL", "BUCCAL", "PALATAL", "INCISAL"]);
  buttons.find(b => b.dataset.surface === "MESIAL").onclick();
  assert.equal(select.value, "MESIAL");
  assert.equal(buttons.find(b => b.dataset.surface === "MESIAL").attributes["aria-pressed"], "true");
  buttons.find(b => b.dataset.surface === "").onclick();
  assert.equal(select.value, "");
  context.preservarSuperficieHistorica(select, { tooth_id: central, surface: "LINGUAL" });
  context.sincronizarSuperficiesVisualesOdontograma(select);
  assert.equal(select.value, "LINGUAL");
  assert(select.children[0].textContent.includes("(histórica)"));
  assert(!buttons.some(b => b.dataset.surface === "LINGUAL"), "historical surface not offered to new entries");
  buttons.find(b => b.dataset.surface === "PALATAL").onclick();
  assert.equal(select.children.length, 0); assert.equal(select.value, "PALATAL");
  select.disabled = true; context.sincronizarSuperficiesVisualesOdontograma(select);
  assert(buttons.every(b => b.disabled));
  buttons[0].onclick(); assert.equal(select.value, "PALATAL");
  el("odontogramConditionCode").value = "CROWN";
  el("odontogramSurface").value = "MESIAL";
  context.actualizarSuperficieOdontograma();
  assert.equal(el("odontogramSurface").value, "");
  assert.equal(el("odontogramSurface").disabled, true);
});

test("surface map lower primary anatomy and mesial orientation follow selected tooth", () => {
  const { context } = browser();
  context.selectedOdontogramToothId = primary;
  const select = element();
  context.instalarSuperficiesVisualesOdontograma({ querySelectorAll: () => [select] });
  const buttons = select.odontogramSurfaceMap.children;
  assert(buttons.some(b => b.dataset.surface === "LINGUAL"));
  assert(buttons.some(b => b.dataset.surface === "OCCLUSAL"));
  assert(!buttons.some(b => ["PALATAL", "INCISAL"].includes(b.dataset.surface)));
  assert.equal(buttons.find(b => b.dataset.surface === "MESIAL").dataset.position, "left");
});

test("responsive rules keep quadrant labels, mobile targets, focus and form-specific surface maps", () => {
  assert(html.includes("@media (max-width: 760px)"));
  assert(html.includes("@media (max-width: 480px)"));
  assert(html.includes(".odontogram-tooth:focus-visible"));
  assert(html.includes('min-height: 44px'));
  assert(html.includes('aria-label="Tipos de registros clínicos"'));
  assert(!extract("instalarSuperficiesVisualesOdontograma").includes("DentalApi"));
  assert(!extract("cambiarNumeracionOdontograma").includes("renderOdontogramDetail()"));
  assert.equal((html.match(/superficiesPiezaOdontograma\(\)\.map/g) || []).length, 4);
});
