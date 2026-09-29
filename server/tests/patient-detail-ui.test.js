const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.resolve(__dirname, "../../pacientes.html"), "utf8");
const start = html.indexOf("        function verDetallePaciente(");
const source = html.slice(start, html.indexOf("        /* NAVIGATION */", start));
function open(patient) {
  const button = { handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; }, focus() { this.focused = true; } };
  const backdrop = { handlers: {}, querySelector: () => button, addEventListener(k, fn) { this.handlers[k] = fn; }, remove() { this.removed = true; } };
  const previous = { isConnected: true, focus() { this.focused = true; } };
  const document = { activeElement: previous, querySelector: () => null, createElement: () => backdrop, body: { appendChild() {} } };
  const context = vm.createContext({ pacientes: [patient], document,
    DentalRoles: { escapeHtml: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") } });
  vm.runInContext(source, context);
  context.verDetallePaciente(0);
  return { backdrop, button, previous };
}
test("patient detail preserves all data with grouped semantic sections and no patient mutation", () => {
  const patient = { nombre: "Nombre QA", national_id: "IDENT-QA", patient_code: "CODE-QA", phone: "PHONE-QA",
    email: "qa@example.invalid", doctor: "Doctor QA", fecha: "2026-10-02", hora: "09:30", proceso: "Procedimiento QA",
    estado: "Estado QA", notes: "Notas QA\nsegunda línea", allergies: "Alergias QA", medical_history: "Antecedentes QA",
    current_medications: "Medicamentos QA", motivo_consulta: "Motivo QA", patient_type: "ambulatory" };
  const original = JSON.stringify(patient);
  const { backdrop } = open(patient);
  for (const [key,value] of Object.entries(patient)) if (key !== "patient_type") assert(backdrop.innerHTML.includes(value), key);
  for (const section of ["Contacto","Atención","Información clínica","Notas"]) assert(backdrop.innerHTML.includes(">" + section + "<"));
  assert(backdrop.innerHTML.includes(">Ambulatorio<"));
  assert(!backdrop.innerHTML.includes('class="detail-row"'));
  assert.equal(JSON.stringify(patient), original);
  assert(!source.includes("DentalApi"));
});
test("patient detail escapes clinical text, preserves diagnosis fallback, handles absent fields/type", () => {
  const { backdrop } = open({ nombre: "<img src=x>", notes: "<script>alert(1)</script>", diagnosis: "Diagnóstico histórico" });
  assert(!backdrop.innerHTML.includes("<img")); assert(!backdrop.innerHTML.includes("<script>"));
  assert(backdrop.innerHTML.includes("&lt;img")); assert(backdrop.innerHTML.includes("Diagnóstico histórico"));
  assert(backdrop.innerHTML.includes("Sin dato"));
  assert(!backdrop.innerHTML.includes('patient-detail-badge type'));
  assert(open({ patient_type: "regular" }).backdrop.innerHTML.includes(">Regular<"));
});
test("dialog preserves detailTitle and close marker, traps focus, Escape/backdrop/close restore focus", () => {
  for (const action of ["button","escape","backdrop"]) {
    const { backdrop, button, previous } = open({ nombre: "QA" });
    assert(button.focused);
    assert(backdrop.innerHTML.includes('aria-labelledby="detailTitle"'));
    assert(backdrop.innerHTML.includes('aria-modal="true"'));
    let prevented = false;
    backdrop.handlers.keydown({ key:"Tab", preventDefault() { prevented = true; } });
    assert(prevented);
    if (action === "button") button.handlers.click();
    if (action === "escape") backdrop.handlers.keydown({ key:"Escape", preventDefault() {}, stopPropagation() {} });
    if (action === "backdrop") backdrop.handlers.click({ target:backdrop });
    assert(backdrop.removed); assert(previous.focused);
  }
});
test("responsive detail styles are scoped, use two/one columns and preserve long/multiline data", () => {
  assert(html.includes(".patient-detail-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr))"));
  assert(html.includes("@media (max-width: 600px)"));
  assert(html.includes(".patients-page .patient-detail-columns, .patients-page .patient-detail-clinical dl { grid-template-columns: minmax(0, 1fr)"));
  assert(html.includes("max-height: calc(100dvh - 40px)"));
  assert(html.includes("white-space: pre-wrap; overflow-wrap: anywhere;"));
});
