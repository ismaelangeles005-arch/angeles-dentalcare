const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.resolve(__dirname,"../../pacientes.html"),"utf8");
function extract(name){const start=html.indexOf("        function "+name+"(");const next=/\n        (?:async )?function /.exec(html.slice(start+1));assert(start>=0&&next);return html.slice(start,start+1+next.index);}
const escape=value=>String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
function overview(patient){const node={};const ctx=vm.createContext({pacienteExpediente:patient,DentalRoles:{escapeHtml:escape},document:{getElementById:()=>node}});vm.runInContext(extract("renderInformacionGeneralPaciente"),ctx);ctx.renderInformacionGeneralPaciente();return node.innerHTML;}
test("overview keeps current fields and formats classification without mutation",()=>{
 const p={nombre:"Nombre QA",patient_code:"CODE-QA",estado:"Estado QA",patient_type:"ambulatory",national_id:"ID-QA",phone:"PHONE-QA",email:"qa@example.invalid",doctor:"Doctor QA",fecha:"2026-10-01",hora:"10:30",operational_classification:"sin_clasificacion"};
 const before=JSON.stringify(p),result=overview(p);
 for(const [key,value]of Object.entries(p))if(!["operational_classification","patient_type"].includes(key))assert(result.includes(value),key);
 assert(result.includes("Sin clasificación"));assert(!result.includes("sin_clasificacion"));assert(result.includes("Ambulatorio"));assert.equal(JSON.stringify(p),before);
 assert(result.includes("Identificación / Contacto"));assert(result.includes(">Atención<"));assert(result.includes(">Clasificación<"));
});
test("overview summary uses existing active data, omits empty block and escapes labels",()=>{
 assert(!overview({}).includes("Alertas activas:"));
 const result=overview({medical_conditions:[{condition_label:"Diabetes"},{condition_label:"Inactive",active:false},{condition_label:"<img>"}]});
 assert(result.includes("Diabetes"));assert(!result.includes("Inactive"));assert(result.includes("&lt;img>"));assert(!result.includes("<img>"));
 assert(!extract("renderInformacionGeneralPaciente").includes("DentalApi"));
});
function dialog(){
 const inputs=["alzheimer","diabetes","hipertension","anticoagulacion","alergias","discapacidad_cognitiva","necesita_acompanante","riesgo_medico_especial","otro"].map(value=>({value,checked:value==="diabetes",focus(){doc.activeElement=this;}}));
 const cancel={focus(){doc.activeElement=this;}},save={focus(){doc.activeElement=this;}},previous={isConnected:true,focus(){doc.activeElement=this;}};
 const calls=[];const backdrop={handlers:{},remove(){this.removed=true;},addEventListener(k,fn){this.handlers[k]=fn;},querySelector(q){return q==="input"?inputs[0]:q==="[data-cancel]"?cancel:save;},querySelectorAll(q){return q==="input:checked"?inputs.filter(i=>i.checked):[...inputs,cancel,save];}};
 const doc={activeElement:previous,createElement:()=>backdrop,body:{appendChild(){}}};
 const ctx=vm.createContext({pacientes:[{id:"patient",nombre:"<QA>",medical_conditions:[{condition_key:"diabetes"}]}],document:doc,DentalRoles:{escapeHtml:escape,notify(){}},DentalApi:{async updatePatientMedicalConditions(id,conditions){calls.push({id,conditions:JSON.parse(JSON.stringify(conditions))});}},async cargarPacientes(){calls.push("reload");}});
 vm.runInContext(extract("abrirCondicionesMedicas"),ctx);ctx.abrirCondicionesMedicas(0);
 return{backdrop,inputs,cancel,save,doc,previous,calls};
}
test("all nine alert codes have accessible real checkboxes and selected non-color cues",()=>{
 const{backdrop,inputs}=dialog();
 for(const input of inputs)assert(backdrop.innerHTML.includes('type="checkbox" value="'+input.value+'"'));
 assert.equal((backdrop.innerHTML.match(/class="clinical-alert-option"/g)||[]).length,9);
 assert(backdrop.innerHTML.includes('aria-labelledby="clinicalAlertsTitle"'));
 assert(backdrop.innerHTML.includes("&lt;QA>"));
 assert(html.includes(":has(input:checked)"));assert(html.includes("font-weight: 700; box-shadow: inset 3px"));
 assert(html.includes(".clinical-alert-option:focus-within"));
});
test("saving preserves endpoint, patient id, and exact selected conditionKey payload",async()=>{
 const{inputs,save,calls,backdrop}=dialog();inputs[1].checked=false;inputs[2].checked=true;await save.onclick();
 assert.deepEqual(calls,[{id:"patient",conditions:[{conditionKey:"hipertension"}]},"reload"]);assert(backdrop.removed);
});
test("cancel/Escape do not persist; focus cycles and returns to opener",()=>{
 for(const mode of ["cancel","escape"]){
 const{backdrop,inputs,cancel,save,doc,previous,calls}=dialog();assert.equal(doc.activeElement,inputs[0]);
 backdrop.handlers.keydown({key:"Tab",shiftKey:true,preventDefault(){}});assert.equal(doc.activeElement,save);
 backdrop.handlers.keydown({key:"Tab",shiftKey:false,preventDefault(){}});assert.equal(doc.activeElement,inputs[0]);
 if(mode==="cancel")cancel.onclick();else backdrop.handlers.keydown({key:"Escape",preventDefault(){},stopPropagation(){}});
 assert.equal(doc.activeElement,previous);assert(backdrop.removed);assert.deepEqual(calls,[]);
 }
});
test("responsive overview and alert selectors remain scoped",()=>{
 assert(html.includes(".patients-page .overview-columns, .patients-page .clinical-alert-options { grid-template-columns: minmax(0, 1fr)"));
 assert(html.includes(".clinical-alert-dialog { width: min(620px, 100%)"));
 assert(html.includes('class="patient-overview" id="clinicalGeneralSummary"'));
});
