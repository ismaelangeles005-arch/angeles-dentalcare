const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const patientId=id(1),planId=id(2),itemId=id(3),procedureId=id(4);
const eligible=['ACCEPTED','PARTIALLY_ACCEPTED','IN_PROGRESS'];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function planFixture(){
    return {id:planId,patient_id:patientId,name:'Plan de prueba',status:'ACCEPTED',acceptances:[],items:[
        {id:itemId,treatment_plan_id:planId,procedure_id:procedureId,status:'ACCEPTED',procedure_name_snapshot:'Nombre histórico',quantity:2,final_amount:'800.00'}
    ]};
}
function patientPage(){
    const state={patient:{id:patientId},plan:planFixture(),busy:false},notifications=[];
    const container={innerHTML:'',querySelectorAll:()=>[]};
    const context=vm.createContext({treatmentPlanState:state,document:{getElementById:()=>container},window:{location:{href:''}},URLSearchParams,
        DentalRoles:{escapeHtml:escape,notify:(...args)=>notifications.push(args)},odontogramCurrent:{teeth:{}},odontogramLoaded:true,
        ODONTOGRAM_SURFACES:[],piezaPlanPaciente:()=> '1.1'});
    const html=read('pacientes.html');
    vm.runInContext(html.slice(html.indexOf('        function renderPlanPaciente()'),html.indexOf('        async function abrirRegistroRealizadoDesdePlan')),context);
    return {state,context,container,notifications};
}
function billingPage(search='?paciente='+patientId+'&treatmentPlanItemId='+itemId){
    const elements=new Map(),calls=[],notifications=[],options={},plan=planFixture();
    const procedures=[{id:id(5),name:'Procedimiento actual',category_name:'Operatoria',base_price:'900.00',active:true},
        {id:procedureId,name:'Procedimiento actual',category_name:'Operatoria',base_price:'500.00',active:true}];
    function el(name){
        if(!elements.has(name)){
            const node={innerHTML:'',textContent:'',hidden:true,disabled:false,dataset:{},classList:{add(){},remove(){},toggle(){}},
                listeners:{},focus(){},reset(){},querySelectorAll:()=>[],addEventListener(event,handler){this.listeners[event]=handler;}};
            let value='0';Object.defineProperty(node,'value',{get:()=>value,set:v=>{value=String(v);}});
            Object.defineProperty(node,'selectedOptions',{get:()=>{
                const match=[...node.innerHTML.matchAll(/<option value="([^"]*)"([^>]*)>(.*?)<\/option>/g)].find(m=>m[1]===value);
                return match?[{value:match[1],dataset:{name:match[2].match(/data-name="([^"]*)"/)?.[1],price:match[2].match(/data-price="([^"]*)"/)?.[1]}}]:[];
            }});
            elements.set(name,node);
        }
        return elements.get(name);
    }
    const document={getElementById:el,querySelectorAll:()=>[]};
    el('estimateForm').querySelectorAll=()=>['patientSelect','procedureSelect','quantity','unitPrice','paid'].map(el);
    const api={
        getPatients:async()=>{calls.push('patients');return options.noPatient?[]:[{id:patientId,nombre:'Paciente de prueba'}];},
        getProcedures:async()=>{calls.push('procedures');return clone(procedures);},
        getBillingEstimates:async()=>{calls.push('estimates');return[];},
        getPatientTreatmentPlans:async id=>{calls.push(['plans',id]);if(options.failure)throw new Error('read failed');return [{id:plan.id,status:plan.status}];},
        getTreatmentPlan:async id=>{calls.push(['plan',id]);return clone(plan);},
        createBillingIdempotencyKey:()=>id(90),
        createBillingEstimate:async(body,key)=>{calls.push(['create',clone(body),key]);return {};},
        addBillingPayment:()=>{throw new Error('Unexpected payment');},
        allocateBillingPayment:()=>{throw new Error('Unexpected allocation');}
    };
    const context=vm.createContext({document,window:{location:{search}},URLSearchParams,setTimeout:fn=>fn(),
        DentalRoles:{escapeHtml:escape,notify:(...args)=>notifications.push(args)},DentalApi:api});
    const html=read('facturacion.html'),source=html.match(/<script type="text\/plain"[^>]*>([\s\S]*?)<\/script>/)[1];
    vm.runInContext(source.slice(0,source.lastIndexOf('        init();renderItems();')),context);
    return {context,el,calls,notifications,options,plan,procedures,
        items:()=>clone(vm.runInContext('items',context)),
        start:()=>context.init(),
        submit:()=>el('estimateForm').listeners.submit({preventDefault(){},target:el('estimateForm')})};
}

for(const planStatus of eligible)for(const itemStatus of eligible){
    test('eligibility: '+planStatus+' / '+itemStatus+' shows Facturar on the correct item',()=>{
        const h=patientPage();h.state.plan.status=planStatus;h.state.plan.items[0].status=itemStatus;
        h.context.renderPlanPaciente();assert(h.container.innerHTML.includes('data-billing-plan-item="'+itemId+'"'));
        assert(h.container.innerHTML.includes('>Facturar</button>'));
    });
}
for(const status of ['DRAFT','PRESENTED','PROPOSED','REJECTED','POSTPONED','COMPLETED','CANCELLED']){
    test('eligibility: excluded plan/item status '+status,()=>{
        const h=patientPage();h.state.plan.status=status;h.context.renderPlanPaciente();
        assert(!h.container.innerHTML.includes('data-billing-plan-item'));
        h.state.plan.status='ACCEPTED';h.state.plan.items[0].status=status;h.context.renderPlanPaciente();
        assert(!h.container.innerHTML.includes('data-billing-plan-item'));
        h.context.facturarItemPlanPaciente(itemId);assert.equal(h.context.window.location.href,'');
    });
}
test('navigation: actual handler transports patient/item IDs, never procedure as item, no API',()=>{
    const h=patientPage();h.context.facturarItemPlanPaciente(itemId);
    const url=new URL(h.context.window.location.href,'https://example.invalid');
    assert.equal(url.pathname,'/facturacion.html');assert.equal(url.searchParams.get('paciente'),patientId);
    assert.equal(url.searchParams.get('treatmentPlanItemId'),itemId);assert.notEqual(url.searchParams.get('treatmentPlanItemId'),procedureId);
});
for(const change of [
    h=>{h.state.plan.items[0].id='bad';},h=>{h.state.plan.items[0].procedure_id=null;},
    h=>{h.state.plan.patient_id=id(99);},h=>{h.state.plan.items[0].treatment_plan_id=id(99);},
    h=>{h.state.patient=null;}
]){
    test('navigation: missing/incompatible required data cannot navigate',()=>{
        const h=patientPage();change(h);h.context.renderPlanPaciente();assert(!h.container.innerHTML.includes('data-billing-plan-item'));
        h.context.facturarItemPlanPaciente(itemId);assert.equal(h.context.window.location.href,'');
    });
}
test('navigation: busy guard and stale item status block action',()=>{
    const h=patientPage();h.state.busy=true;h.context.renderPlanPaciente();assert.match(h.container.innerHTML,/data-billing-plan-item="[^"]+" disabled/);
    h.context.facturarItemPlanPaciente(itemId);assert.equal(h.context.window.location.href,'');
    h.state.busy=false;h.state.plan.items[0].status='CANCELLED';h.context.facturarItemPlanPaciente(itemId);assert.equal(h.context.window.location.href,'');
});
test('functional: Plan Facturar -> URL -> billing init -> exact procedure and local linked line, no financial POST',async()=>{
    const origin=patientPage();origin.context.facturarItemPlanPaciente(itemId);
    const h=billingPage(new URL(origin.context.window.location.href,'https://example.invalid').search);
    await h.start();
    assert.equal(h.el('patientSelect').value,patientId);assert.equal(h.el('procedureSelect').value,procedureId);
    assert.equal(h.items().length,1);assert.equal(h.items()[0].treatmentPlanItemId,itemId);assert.equal(h.items()[0].procedureId,procedureId);
    assert.equal(h.items()[0].quantity,2);assert.equal(h.items()[0].unitPrice,500);
    assert.equal(h.el('paid').value,'0');assert(h.el('itemsList').innerHTML.includes('Plan de tratamiento'));
    assert.match(h.el('treatmentBillingContext').textContent,/Plan de prueba.*Paciente de prueba.*Procedimiento actual/);
    assert(!h.calls.some(c=>Array.isArray(c)&&c[0]==='create'));
    assert(h.calls.some(c=>Array.isArray(c)&&c[0]==='plans'&&c[1]===patientId));
    assert.equal(h.el('patientSelect').disabled,false);
});
test('billing: explicit save preserves linked ID; navigation itself does not save',async()=>{
    const h=billingPage();await h.start();assert(!h.calls.some(c=>c[0]==='create'));
    await h.submit();const saved=h.calls.find(c=>c[0]==='create');assert(saved);
    assert.equal(saved[1].patientId,patientId);assert.equal(saved[1].items[0].treatmentPlanItemId,itemId);assert.equal(saved[1].items[0].procedureId,procedureId);
    assert.equal(saved[1].paid,0);
});
test('billing: manual path makes no plan reads and addItem remains optional',async()=>{
    const h=billingPage('?paciente='+patientId);await h.start();
    assert(!h.calls.some(c=>Array.isArray(c)));assert.equal(h.items().length,0);
    h.el('procedureSelect').value=procedureId;h.el('unitPrice').value='500';h.el('quantity').value='1';h.el('toothNumber').value='';
    h.context.addItem();assert.equal(h.items()[0].treatmentPlanItemId,null);
    await h.submit();assert.equal(h.calls.find(c=>c[0]==='create')[1].items[0].treatmentPlanItemId,null);
});
for(const search of ['?paciente=bad&treatmentPlanItemId='+itemId,'?paciente='+patientId+'&treatmentPlanItemId=bad','?treatmentPlanItemId='+itemId,'?paciente='+patientId+'&treatmentPlanItemId=']){
    test('billing: malformed/missing context fails before plan reads '+search,async()=>{
        const h=billingPage(search);await h.start();assert.equal(h.items().length,0);assert(h.notifications.length);
        assert(!h.calls.some(c=>Array.isArray(c)));assert.equal(h.el('patientSelect').disabled,false);
    });
}
for(const [name,change] of [
    ['other patient',h=>{h.plan.patient_id=id(99);}],
    ['unknown item',h=>{h.plan.items[0].id=id(99);}],
    ['item from another plan',h=>{h.plan.items[0].treatment_plan_id=id(99);}],
    ['missing procedure',h=>{h.plan.items[0].procedure_id=null;}],
    ['unknown procedure with same name',h=>{h.plan.items[0].procedure_id=id(99);}],
    ['inactive procedure',h=>{h.procedures[1].active=false;}],
    ['ineligible plan',h=>{h.plan.status='COMPLETED';}],
    ['ineligible item',h=>{h.plan.items[0].status='REJECTED';}],
    ['invalid quantity',h=>{h.plan.items[0].quantity=0;}],
    ['missing price',h=>{h.procedures[1].base_price=null;}],
    ['unavailable patient',h=>{h.options.noPatient=true;}],
    ['API failure',h=>{h.options.failure=true;}]
]){
    test('billing: safely rejects '+name,async()=>{
        const h=billingPage();change(h);await h.start();assert.equal(h.items().length,0);assert(h.notifications.length);
        assert(!h.calls.some(c=>Array.isArray(c)&&c[0]==='create'));assert.equal(h.el('patientSelect').disabled,false);
    });
}
test('billing: repeated preparation does not append a duplicate draft line',async()=>{
    const h=billingPage();await h.start();await h.context.prepareTreatmentPlanBilling();assert.equal(h.items().length,1);
    assert.match(h.el('treatmentBillingContext').textContent,/ya preparado/);
});
test('billing: procedure/plan/patient labels are not rendered as raw HTML',async()=>{
    const h=billingPage();h.procedures[1].name='<script>bad</script>';h.plan.name='<img onerror=bad>';
    await h.start();assert(!h.el('itemsList').innerHTML.includes('<script>'));assert.match(h.el('treatmentBillingContext').textContent,/<img/);
});
