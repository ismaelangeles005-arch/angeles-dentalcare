const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.resolve(__dirname, "../../pacientes.html"), "utf8");
function extract(name) {
  const start = html.indexOf(`        function ${name}(`);
  assert(start >= 0);
  const next = /\n        (?:async )?function /.exec(html.slice(start + 1));
  assert(next);
  return html.slice(start, start + 1 + next.index);
}
const escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
function render(name, patient = {}, notes = [], state) {
  const node = {};
  const context = vm.createContext({ pacienteExpediente: patient, notasClinicas: notes,
    DentalRoles: { escapeHtml }, document: { getElementById: () => node } });
  vm.runInContext(extract(name), context);
  context[name](state);
  return node.innerHTML;
}

test("persistent context uses only patient data, escapes values and filters inactive alerts", () => {
  const patient = { patient_code: "QA-CODE", patient_type: "ambulatory", estado: "Pendiente", doctor: "Doctor QA",
    allergies: "<Alergia>", medical_conditions: [{ condition_label: "Diabetes" }, { condition_label: "Inactive", active: false }] };
  const before = JSON.stringify(patient);
  const output = render("renderContextoPaciente", patient);
  for (const value of ["QA-CODE", "Ambulatorio", "Pendiente", "Doctor QA", "&lt;Alergia>", "Diabetes"]) assert(output.includes(value));
  assert(!output.includes("Inactive")); assert(!output.includes("<Alergia>"));
  assert.equal(JSON.stringify(patient), before);
  assert(render("renderContextoPaciente", { national_id: "QA-ID" }).includes("QA-ID"));
  assert(!render("renderContextoPaciente").includes('class="overview-alerts"'));
});

test("summary retains data and labels stored follow-up neutrally without assuming agenda confirmation", () => {
  const output = render("renderInformacionGeneralPaciente", { fecha: "2026-10-01", hora: "09:00",
    allergies: "QA allergy", medical_history: "QA history", current_medications: "QA medicine", diagnosis: "QA legacy reason" });
  for (const value of ["Próximo seguimiento registrado", "2026-10-01 09:00", "QA allergy", "QA history", "QA medicine", "QA legacy reason"]) assert(output.includes(value));
  assert(!output.includes("Próxima cita")); assert(output.includes("Sin clasificación"));
});

test("recent note summary distinguishes loading, failure, empty and real clinical content without requests", () => {
  assert(render("renderResumenClinicoReciente", {}, [], "loading").includes("Cargando"));
  assert(render("renderResumenClinicoReciente", {}, [], "error").includes("No fue posible"));
  assert(render("renderResumenClinicoReciente").includes("Sin evoluciones registradas"));
  const notes = [{ fecha_registro: "2026-10-01", doctor: "QA", evaluacion_clinica: "<Evaluación>", diagnostico_odontologico: "Diagnóstico QA" }];
  const before = JSON.stringify(notes), output = render("renderResumenClinicoReciente", {}, notes);
  assert(output.includes("&lt;Evaluación>")); assert(output.includes("Diagnóstico QA")); assert(output.includes("2026-10-01"));
  assert.equal(JSON.stringify(notes), before);
  for (const name of ["renderResumenClinicoReciente", "renderContextoPaciente", "renderInformacionGeneralPaciente"]) assert(!extract(name).includes("DentalApi"));
});

test("six navigation destinations retain all eight panels and unchanged forms", () => {
  const nav = html.match(/<nav class="clinical-tabs"[\s\S]*?<\/nav>/)[0];
  assert.equal((nav.match(/<button /g) || []).length, 6);
  for (const key of ["general", "historia", "evaluacion", "procedimientos", "odontograma", "plan", "evolucion", "archivos"]) {
    assert.equal(html.split(`data-clinical-panel="${key}"`).length - 1 - (html.match(new RegExp(`\\[data-clinical-panel="${key}"\\]`, "g")) || []).length, 1);
    assert(html.includes(`data-clinical-tab="${key}"`));
  }
  for (const id of ["clinicalNoteForm", "clinicalUploadForm"]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
});

test("navigation activates matching subgroups; direct clinical navigation still works without extra loads", () => {
  const make = dataset => ({ dataset, hidden: false, classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; } });
  const tabs = ["general", "historia", "evaluacion", "procedimientos", "odontograma", "plan", "evolucion", "archivos"].map(clinicalTab => make({ clinicalTab }));
  const groups = ["historia", "evolucion"].map(clinicalGroup => make({ clinicalGroup }));
  const subnavs = groups.map(g => make({ clinicalSubnav: g.dataset.clinicalGroup }));
  const panels = tabs.map(t => make({ clinicalPanel: t.dataset.clinicalTab }));
  let calls = 0;
  const context = vm.createContext({ cargarPlanesPaciente: () => calls++, document: { querySelectorAll: selector => ({
    "[data-clinical-tab]": tabs, "[data-clinical-group]": groups, "[data-clinical-subnav]": subnavs, "[data-clinical-panel]": panels
  })[selector] } });
  vm.runInContext(extract("cambiarPestanaExpediente"), context);
  for (const tab of tabs) {
    const key = tab.dataset.clinicalTab;
    context.cambiarPestanaExpediente(key);
    assert.equal(tab["aria-pressed"], "true");
    assert.deepEqual(panels.filter(p => !p.hidden).map(p => p.dataset.clinicalPanel), [key]);
    const group = ["historia", "evaluacion"].includes(key) ? "historia" : ["procedimientos", "evolucion"].includes(key) ? "evolucion" : null;
    assert.deepEqual(subnavs.filter(n => !n.hidden).map(n => n.dataset.clinicalSubnav), group ? [group] : []);
  }
  assert.equal(calls, 1);
});

test("responsive context remains inside sticky header, keyboard focus visible and patient reset precedes loading", () => {
  assert.match(html, /class="clinical-header"[\s\S]*?id="clinicalPatientName"[\s\S]*?id="clinicalPatientContext"[\s\S]*?id="clinicalClose"/);
  assert.match(html, /\.clinical-header,[\s\S]*?position: sticky;/);
  assert(html.includes(".patients-page .clinical-tab:focus-visible, .patients-page .clinical-close:focus-visible"));
  assert(html.includes(".patients-page .clinical-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }"));
  const opening = html.slice(html.indexOf("        async function abrirExpediente("), html.indexOf("        function cerrarExpediente("));
  assert(opening.indexOf("notasClinicas = []") < opening.indexOf("renderResumenExpediente()"));
  assert(opening.indexOf("renderContextoPaciente()") < opening.indexOf("await Promise.all"));
});
