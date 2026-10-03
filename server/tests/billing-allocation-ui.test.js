const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=uuid(1),estimateId=uuid(2),paymentId=uuid(3),itemId=uuid(4);
function fixture(){
    return {estimate:{id:estimateId,patient_name:'Fixture',status:'pagado',paid:'500.00',balance:'0.00'},
        payments:[{id:paymentId,amount:'500.00',allocated:'0.00',remaining:'500.00',method:'efectivo',paid_at:'2026-10-03'}],
        items:[{id:itemId,description:'Tratamiento manual',quantity:1,unit_price:'400.00',total:'400.00',allocated:'0.00',remaining:'400.00',treatment_plan_item_id:null},
            {id:uuid(5),description:'Tratamiento vinculado',quantity:1,unit_price:'300.00',total:'300.00',allocated:'0.00',remaining:'300.00',treatment_plan_item_id:uuid(6)}],
        allocations:[]};
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(){
    const elements=new Map(),calls=[],options={},data=fixture();
    let serial=0,inputs=[];
    const classes=()=>({add(){},remove(){},toggle(){}});
    function el(id){
        if(!elements.has(id)){
            const element={value:'',textContent:'',hidden:false,checked:false,disabled:false,dataset:{},classList:classes(),listeners:{},
                focus(){document.activeElement=this;},addEventListener(name,fn){this.listeners[name]=fn;},getClientRects:()=>[{}],
                querySelectorAll:selector=>selector.includes('data-application-amount')?inputs:[...elements.values()]};
            Object.defineProperty(element,'innerHTML',{get(){return this.html||'';},set(value){
                this.html=value;
                if(id==='applicationInputs')inputs=[...value.matchAll(/id="applicationAmount(\d+)"[^>]*value="([^"]*)"/g)].map(match=>{
                    const input=el('applicationAmount'+match[1]);input.value=match[2];input.dataset.applicationAmount=match[1];return input;
                });
            }});
            elements.set(id,element);
        }
        return elements.get(id);
    }
    const document={getElementById:el,querySelectorAll:()=>[],activeElement:null};
    const api={
        createBillingIdempotencyKey:()=>uuid(++serial+100),
        getBillingAllocations:async id=>{calls.push({kind:'read',id});if(options.readFailure)throw new Error('read failure');return clone(data);},
        allocateBillingPayment:async(id,payload,key)=>{
            calls.push({kind:'allocate',id,payload:clone(payload),key});
            if(options.allocateFailure)throw options.allocateFailure;
            if(options.failSecond&&calls.filter(c=>c.kind==='allocate').length===2)throw new Error('network');
            return {};
        },
        reverseBillingAllocation:async(id,reason,key)=>{
            calls.push({kind:'reverse',id,reason,key});if(options.reverseFailure)throw options.reverseFailure;
            const entry=data.allocations.find(a=>a.id===id);entry.reversal={id:uuid(50),reason,created_at:'2026-10-03'};
            return {};
        }
    };
    const context=vm.createContext({document,window:{location:{search:''}},URLSearchParams,Intl,Date,setTimeout:fn=>fn(),
        DentalApi:api,DentalRoles:{escapeHtml:escape,notify(){}}});
    const html=read('facturacion.html'),script=html.match(/<script type="text\/plain"[^>]*>([\s\S]*?)<\/script>/)[1];
    vm.runInContext(script.slice(0,script.lastIndexOf('        init();renderItems();')),context);
    return {context,el,calls,options,data,api,open:()=>context.openPaymentApplications(estimateId),input:(index,value)=>{el('applicationAmount'+index).value=value;}};
}
test('API: explicit safe allocation/reversal bodies and encoded paths through request()',async()=>{
    const source=read('api.js'),calls=[],ctx=vm.createContext({request:async(url,options)=>calls.push({url,...options})});
    vm.runInContext(source.slice(source.indexOf('    function getBillingAllocations('),source.indexOf('    function getAppointments()')),ctx);
    await ctx.getBillingAllocations('a/b');
    await ctx.allocateBillingPayment('p/b',{billingEstimateItemId:itemId,amount:'30.00',organization_id:'evil'},'key');
    await ctx.reverseBillingAllocation('a/b','Motivo','key2');
    assert.equal(calls[0].url,'/billing/estimates/a%2Fb/allocations');
    assert.equal(calls[1].url,'/billing/payments/p%2Fb/allocations');
    assert.deepEqual(JSON.parse(calls[1].body),{billingEstimateItemId:itemId,amount:'30.00',idempotencyKey:'key'});
    assert.deepEqual(JSON.parse(calls[2].body),{reason:'Motivo',idempotencyKey:'key2'});
    assert.equal(calls[1].method,'POST');assert.equal(calls[2].method,'POST');
});
test('UI: manual/linked treatments, human labels and payment balances',async()=>{
    const h=page();await h.open();
    assert.match(h.el('applicationItems').innerHTML,/Tratamiento manual/);
    assert.match(h.el('applicationItems').innerHTML,/Plan de tratamiento/);
    assert.match(h.el('applicationItems').innerHTML,/Cantidad:/);
    assert.match(h.el('applicationPaymentTotal').textContent,/500/);
    assert(!h.el('applicationItems').innerHTML.includes(itemId));
    assert.equal(h.calls.filter(c=>c.kind==='read').length,1);
});
test('UI: pending items only, preserves all items in summary',async()=>{
    const h=page();h.data.items[0].remaining='0.00';await h.open();
    assert(!h.el('applicationInputs').innerHTML.includes('Tratamiento manual'));
    assert(h.el('applicationItems').innerHTML.includes('Tratamiento manual'));
});
test('UI: no payments is a usable empty state',async()=>{
    const h=page();h.data.payments=[];await h.open();
    assert.match(h.el('applicationPayment').innerHTML,/Sin pagos registrados/);
    assert(h.el('applicationSubmit').disabled);assert.equal(h.calls.filter(c=>c.kind==='allocate').length,0);
});
for(const values of [['-1',''],['400.01',''],['300','201'],['1.001',''],['0','']]){
    test('UI: invalid amounts rejected before requests '+JSON.stringify(values),async()=>{
        const h=page();await h.open();values.forEach((v,i)=>h.input(i,v));
        await h.context.submitPaymentApplications();
        assert.equal(h.calls.filter(c=>c.kind==='allocate').length,0);assert(h.el('applicationsStatus').textContent);
    });
}
test('UI: one payment distributed across multiple items, live remaining, refresh once',async()=>{
    const h=page();await h.open();h.input(0,'300');h.input(1,'200');h.context.updateApplicationRemaining();
    assert.match(h.el('applicationRemaining').textContent,/0[.,]00/);
    await Promise.all([h.context.submitPaymentApplications(),h.context.submitPaymentApplications()]);
    const sends=h.calls.filter(c=>c.kind==='allocate');
    assert.equal(sends.length,2);assert.notEqual(sends[0].key,sends[1].key);
    assert.deepEqual(sends.map(c=>c.payload),[{billingEstimateItemId:itemId,amount:'300.00'},{billingEstimateItemId:uuid(5),amount:'200.00'}]);
    assert.equal(h.calls.filter(c=>c.kind==='read').length,2);
    assert.match(h.el('applicationsStatus').textContent,/Aplicado:/);
});
test('UI: partial success and network retry retain keys and skip confirmed items across close/reopen',async()=>{
    const h=page();await h.open();h.input(0,'300');h.input(1,'200');h.options.failSecond=true;
    await h.context.submitPaymentApplications();
    assert.match(h.el('applicationsStatus').textContent,/Aplicado: Tratamiento manual/);
    assert.match(h.el('applicationsStatus').textContent,/No se pudo confirmar: Tratamiento vinculado/);
    h.context.closePaymentApplications();await h.open();await h.context.submitPaymentApplications();
    const sends=h.calls.filter(c=>c.kind==='allocate');
    assert.equal(sends.length,3);assert.equal(sends[1].key,sends[2].key);assert.deepEqual(sends[1].payload,sends[2].payload);
    assert.equal(sends.filter(c=>c.payload.billingEstimateItemId===itemId).length,1);
});
test('UI: ambiguous retry survives balances already exhausted after lost response',async()=>{
    const h=page();await h.open();h.input(0,'300');h.options.allocateFailure=new Error('lost response');
    await h.context.submitPaymentApplications();const first=h.calls.find(c=>c.kind==='allocate');
    h.data.payments[0].remaining='0.00';h.data.items[0].remaining='0.00';delete h.options.allocateFailure;
    await h.context.reloadPaymentApplications();await h.context.submitPaymentApplications();
    const sends=h.calls.filter(c=>c.kind==='allocate');assert.equal(sends.length,2);assert.equal(sends[1].key,first.key);
});
for(const status of [400,404,409]){
    test('UI: controlled '+status+' reports failure, refreshes and permits a corrected new attempt',async()=>{
        const h=page();await h.open();h.input(0,'300');h.options.allocateFailure=Object.assign(new Error('API rejected'),{status});
        await h.context.submitPaymentApplications();assert.match(h.el('applicationsStatus').textContent,/No se aplicó/);
        delete h.options.allocateFailure;h.input(0,'200');await h.context.submitPaymentApplications();
        const sends=h.calls.filter(c=>c.kind==='allocate');assert.equal(sends.length,2);assert.notEqual(sends[0].key,sends[1].key);
    });
}
function withAllocation(h){
    h.data.allocations.push({id:uuid(40),payment_id:paymentId,billing_estimate_item_id:itemId,amount:'300.00',created_at:'2026-10-03',reversal:null});
}
test('UI: reversal needs reason and explicit confirmation, sends no amount, retains history',async()=>{
    const h=page();withAllocation(h);await h.open();h.context.openApplicationReversal(0);
    await h.context.submitApplicationReversal();assert.equal(h.calls.filter(c=>c.kind==='reverse').length,0);
    h.el('applicationReversalReason').value='Error de aplicación';await h.context.submitApplicationReversal();
    assert.equal(h.calls.filter(c=>c.kind==='reverse').length,0);
    h.el('applicationReversalConfirm').checked=true;await h.context.submitApplicationReversal();
    const call=h.calls.find(c=>c.kind==='reverse');assert.equal(call.reason,'Error de aplicación');assert(!('amount' in call));
    assert.match(h.el('applicationHistory').innerHTML,/Aplicación revertida/);assert.match(h.el('applicationHistory').innerHTML,/Tratamiento manual/);
    assert(!h.el('applicationHistory').innerHTML.includes('onclick="openApplicationReversal'));
    assert.equal(h.context.document.activeElement,h.el('applicationsReload'));
});
test('UI: cancelled reversal does not mutate; network retry uses same key/reason',async()=>{
    const h=page();withAllocation(h);await h.open();h.context.openApplicationReversal(0);h.context.cancelApplicationReversal();
    assert.equal(h.calls.filter(c=>c.kind==='reverse').length,0);
    h.context.openApplicationReversal(0);h.el('applicationReversalReason').value='Motivo';h.el('applicationReversalConfirm').checked=true;
    h.options.reverseFailure=new Error('network');await h.context.submitApplicationReversal();
    delete h.options.reverseFailure;await h.context.submitApplicationReversal();
    const calls=h.calls.filter(c=>c.kind==='reverse');assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);
});
test('UI: read failure prevents stale new applications',async()=>{
    const h=page();await h.open();h.options.readFailure=true;await h.context.reloadPaymentApplications();
    h.input(0,'100');await h.context.submitPaymentApplications();
    assert.equal(h.calls.filter(c=>c.kind==='allocate').length,0);assert(h.el('applicationSubmit').disabled);
});
test('UI: server-provided descriptions/reasons are escaped, dialog labels and responsive rules exist',async()=>{
    const h=page();h.data.items[0].description='<img onerror=bad>';withAllocation(h);
    h.data.allocations[0].reversal={reason:'<script>bad</script>',created_at:'2026-10-03'};await h.open();
    assert(!h.el('applicationItems').innerHTML.includes('<img'));assert(!h.el('applicationHistory').innerHTML.includes('<script>'));
    const html=read('facturacion.html');
    assert(html.includes('role="dialog" aria-modal="true" aria-labelledby="applicationsTitle"'));
    assert(html.includes('@media(max-width:700px)'));assert(html.includes('.application-line{grid-template-columns:1fr}'));
    assert(html.includes('event.key!=="Tab"'));assert(html.includes('applicationReturnFocus?.focus()'));
});

function reader(snapshot=fixture()){
    const routes=new Map(),calls=[];let absent=false;
    const router={use(){}};for(const verb of ['get','post','patch'])router[verb]=(route,fn)=>routes.set(verb+' '+route,fn);
    vm.runInNewContext(read('server/src/routes/billing.js'),{module:{exports:{}},require(name){
        if(name==='express')return {Router:()=>router};
        if(name==='../db')return {query:async(sql,params)=>{calls.push({sql,params});return {rows:absent?[]:[{...clone(snapshot.estimate),items:clone(snapshot.items),payments:clone(snapshot.payments),allocations:clone(snapshot.allocations)}]};}};
        if(name==='node:crypto')return require('node:crypto');
        if(name==='../utils/asyncHandler')return fn=>fn;
        if(name==='../middleware/auth')return {authenticate(){},allowRoles(){}};
        if(name==='../utils/audit')return {writeAuditLog(){throw Error('no audit on read');}};
        throw Error(name);
    }});
    return {calls,setAbsent:()=>{absent=true;},get:async(id=estimateId,user={})=>{
        const res={code:200,status(c){this.code=c;return this;},json(body){this.body=clone(body);return this;}};
        await routes.get('get /estimates/:id/allocations')({params:{id},user:{organizationId:org,...user}},res);return res;
    }};
}
test('read API: single scoped snapshot, effective balances exclude reversals and include all history',async()=>{
    const data=fixture();
    data.allocations=[{id:uuid(40),payment_id:paymentId,billing_estimate_item_id:itemId,amount:'100.25',reversal:null},
        {id:uuid(41),payment_id:paymentId,billing_estimate_item_id:itemId,amount:'200.00',reversal:{id:uuid(50)}}];
    const h=reader(data),r=await h.get();assert.equal(r.code,200);assert.equal(h.calls.length,1);
    assert.equal(r.body.items[0].allocated,'100.25');assert.equal(r.body.items[0].remaining,'299.75');assert.equal(r.body.payments[0].remaining,'399.75');
    assert.equal(r.body.allocations.length,2);assert.equal(r.body.items[0].treatment_plan_item_id,null);assert.equal(r.body.estimate.paid,'500.00');
    const {sql,params}=h.calls[0];assert(sql.includes('e.organization_id = $2'));assert.deepEqual(Array.from(params),[estimateId,org]);
    assert(sql.includes('p.organization_id = a.organization_id'));assert(sql.includes('i.estimate_id = p.estimate_id'));
    assert(sql.includes('a.organization_id = e.organization_id'));assert(sql.includes('r.organization_id = a.organization_id'));
    assert(!/\b(?:UPDATE|INSERT|DELETE FROM)\b/.test(sql));
});
test('read API: malformed UUID 400 without query, invisible estimate 404, doctor scoping retained',async()=>{
    const h=reader();assert.equal((await h.get('bad')).code,400);assert.equal(h.calls.length,0);
    h.setAbsent();assert.equal((await h.get()).code,404);
    await h.get(estimateId,{isDoctor:true,doctorId:uuid(99)});
    assert(h.calls.at(-1).sql.includes('p.doctor_id = $3'));assert(h.calls.at(-1).sql.includes('p.organization_id = $2'));
});
