const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.resolve(__dirname,"../../pacientes.html"),"utf8");
const fn=name=>{const start=html.indexOf("        function "+name+"(");assert(start>=0);const end=/\n        (?:async )?function /.exec(html.slice(start+1));return html.slice(start,start+1+end.index)};
function render(role="admin",patients=[],search=""){
const grid={innerHTML:""};
const ctx=vm.createContext({rol:role,document:{getElementById:id=>id==="patientGrid"?grid:{value:search}},pacientesVisibles:()=>patients.map((paciente,index)=>({paciente,index})),pacienteEsDelDoctor:p=>!!p.mine,pacienteFueAtendidoPorDoctor:p=>!!p.attended,
DentalRoles:{escapeHtml:v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}});
vm.runInContext(fn("inicialesPaciente")+fn("renderPacientes"),ctx);ctx.renderPacientes();return{html:grid.innerHTML,ctx};
}
test("patient initials: one/multiple names, accents, blanks and untrusted input",()=>{
const{ctx}=render();for(const[name,expected]of [["Marlon","M"],["Isaac Pérez","IP"],["  ángel  pérez ","ÁP"],["Juan Carlos Pérez","JP"],["","?"],[null,"?"],["123 !","?"]])assert.equal(ctx.inicialesPaciente(name),expected);
assert(!ctx.inicialesPaciente("<script>").includes("<"));
});
test("card keeps identity/contact/doctor/count/actions, removes only email display",()=>{
const patient={nombre:"Isaac Pérez",patient_code:"P-0001",patient_type:"ambulatory",national_id:"ID-QA",phone:"PHONE-QA",email:"qa@example.invalid",doctor:"Doctor QA",file_count:7};
const before=JSON.stringify(patient),result=render("admin",[patient]).html;
for(const value of["Isaac Pérez","P-0001","Ambulatorio","ID-QA","PHONE-QA","Doctor QA","Expediente (7)",">IP</div>"])assert(result.includes(value),value);
assert(!result.includes("qa@example.invalid"));assert(!result.includes('meta-label">Correo'));
for(const handler of["verDetallePaciente","abrirExpediente","abrirClasificacionPaciente","abrirCondicionesMedicas","convertirPacienteRegular","asignarDoctor","eliminar"])assert(result.includes(handler+"(0)"));
assert(result.includes("Cambiar doctor"));assert.equal(JSON.stringify(patient),before);
const menu=result.slice(result.indexOf('<details class="patient-more"'));
for(const handler of["abrirClasificacionPaciente","asignarDoctor","eliminar"])assert(menu.includes(handler+"(0)"));
assert(!menu.includes("abrirExpediente"));assert(!menu.includes("abrirCondicionesMedicas"));
});
test("search preserves original patient indices and existing fallbacks",()=>{
const result=render("admin",[{nombre:"A"},{nombre:"B",patient_code:"P-2"}],"p-2").html;
assert(result.includes("verDetallePaciente(1)"));assert(!result.includes("verDetallePaciente(0)"));
for(const text of["No registrada","No registrado","Sin asignar","Asignar doctor"])assert(result.includes(text));
assert(render("admin",[]).html.includes("No hay pacientes para mostrar"));
assert(render("admin",[{nombre:"A"}],"missing").html.includes("No hay pacientes que coincidan"));
});
test("doctor/reception restrictions and doctor-specific visit/follow-up actions remain",()=>{
const doc=render("doctor",[{nombre:"QA"}]).html;
assert(!doc.includes('onclick="eliminar('));assert(!doc.includes('onclick="asignarDoctor('));
assert(doc.includes("tomarPaciente(0)"));assert(doc.includes("asignarPacienteSeguimiento(0)"));
assert(doc.includes('disabled title="Atiende la visita'));
const attended=render("doctor",[{nombre:"QA",attended:true}]).html;assert(!attended.includes("disabled title="));
const rec=render("recepcion",[{nombre:"QA"}]).html;
for(const action of["abrirExpediente","abrirCondicionesMedicas","abrirClasificacionPaciente"])assert(!rec.includes(action+"("));
assert(rec.includes("verDetallePaciente(0)"));
});
test("native disclosure menu has independent state, descriptive label, Escape and safe patient text",()=>{
const result=render("admin",[{nombre:'<img src=x>'},{nombre:"Other"}]).html;
assert.equal((result.match(/<details class="patient-more"/g)||[]).length,2);
assert(result.includes('aria-label="Más acciones de &lt;img'));
assert(!result.includes("<img"));assert(result.includes("event.key === 'Escape'"));
assert(html.includes(".patients-page .patient-menu-actions .delete-btn"));
assert(html.includes(".patient-more summary:focus-visible"));
});
