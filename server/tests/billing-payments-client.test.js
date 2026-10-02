const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname,'../..');
const read = name => fs.readFileSync(path.join(root,name),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

test('Billing API helpers send caller-owned UUID in JSON for every path without new CORS headers', async () => {
  const calls=[], source=read('api.js');
  const context=vm.createContext({ window:{crypto:webcrypto}, request:async (url,options)=>{calls.push({url,...options});return{};} });
  vm.runInContext(source.slice(source.indexOf('    function getBillingEstimates()'),source.indexOf('    function getAppointments()')),context);
  const key=context.createBillingIdempotencyKey();
  assert.match(key,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(key,context.createBillingIdempotencyKey());
  await context.createBillingEstimate({paid:200},key);
  await context.addBillingPayment('estimate',{amount:200},key);
  await context.updateBillingEstimateStatus('estimate','pagado',key);
  await context.addBillingPayment('estimate',{amount:200},key);
  for (const call of calls) { assert.equal(JSON.parse(call.body).idempotencyKey,key); assert.equal(call.headers,undefined); }
  assert.deepEqual(calls.map(c=>c.method),['POST','POST','PATCH','POST']);
  assert.equal(calls[1].body,calls[3].body);
});

function page() {
  const elements=new Map(), calls=[], notifications=[], options={};
  let sequence=0;
  function el(id) {
    if (!elements.has(id)) elements.set(id, {value:'0',innerHTML:'',textContent:'',selectedOptions:[{value:'patient',dataset:{name:'Patient'}}],
      classList:{add(){},remove(){}},listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},focus(){},reset(){} });
    return elements.get(id);
  }
  const estimate={id:'estimate',total:1000,paid:0,balance:1000,status:'en_deuda',patient_name:'Patient',created_at:'2026-01-01'};
  async function mutation(kind,payload,key) {
    calls.push({kind,payload:plain(payload),key});
    if(options.failure) throw options.failure;
    return {...estimate,paid:1000,balance:0,status:'pagado'};
  }
  const context=vm.createContext({ document:{getElementById:el,querySelectorAll:()=>[]},window:{location:{search:''}},URLSearchParams,
    setTimeout:fn=>fn(),DentalRoles:{notify:(...args)=>notifications.push(args),escapeHtml:String},
    DentalApi:{createBillingIdempotencyKey:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
      getBillingEstimates:async()=>[estimate],getBillingEstimate:async()=>estimate,
      createBillingEstimate:(body,key)=>mutation('create',body,key),
      addBillingPayment:(id,body,key)=>mutation('payment',{id,...body},key),
      updateBillingEstimateStatus:(id,status,key)=>mutation('settle',{id,status},key)} });
  const script=read('facturacion.html').match(/<script type="text\/plain"[^>]*>([\s\S]*?)<\/script>/)[1];
  // Skip only startup fetching, then invoke the actual DOM handlers below.
  vm.runInContext(script.slice(0,script.lastIndexOf('        init();renderItems();')),context);
  el('paymentMethod').value='efectivo';el('paymentNote').value='';
  el('initialPaymentMethod').value='efectivo';el('notes').value='';
  vm.runInContext('items = [{ description: "Fixture", quantity: 1, unitPrice: 1000, grossTotal: 1000, discount: 0, total: 1000 }];',context);
  const submitEstimate=()=>el('estimateForm').listeners.submit({preventDefault(){},target:el('estimateForm')});
  return {context,el,calls,notifications,options,estimate,submitEstimate};
}
for(const route of ['create','payment','settle']) {
  test(route+': network retry retains key; double click sends a single request',async()=>{
    const h=page(); await h.context.openPayment('estimate');
    const send=route==='create'?h.submitEstimate:route==='payment'?()=>h.context.submitPayment():()=>h.context.changeEstimateStatus('estimate','pagado');
    h.options.failure=new Error('network timeout');
    await Promise.all([send(),send()]); assert.equal(h.calls.length,1);
    delete h.options.failure; await send(); assert.equal(h.calls.length,2);
    assert.equal(h.calls[0].key,h.calls[1].key);assert.deepEqual(h.calls[0].payload,h.calls[1].payload);
  });
}
test('payment retry survives modal close/reopen even if first commit exhausted balance',async()=>{
  const h=page();await h.context.openPayment('estimate');h.options.failure=new Error('lost response');
  await h.context.submitPayment(); h.context.closePaymentModal();h.estimate.balance=0;
  await h.context.openPayment('estimate'); assert.equal(Number(h.el('paymentAmount').value),1000);
  delete h.options.failure;await h.context.submitPayment();
  assert.equal(h.calls.length,2);assert.equal(h.calls[0].key,h.calls[1].key);
});
test('unresolved payment cannot silently become a different amount or method',async()=>{
  const h=page();await h.context.openPayment('estimate');h.options.failure=new Error('timeout');await h.context.submitPayment();
  h.el('paymentAmount').value=500;await h.context.submitPayment();
  assert.equal(h.calls.length,1);assert.match(h.notifications.at(-1)[0],/mismos datos/);
});
test('confirmed rejection permits a new corrected attempt, with a new key',async()=>{
  const h=page();await h.context.openPayment('estimate');h.options.failure=Object.assign(new Error('balance'),{status:400});
  await h.context.submitPayment();delete h.options.failure;h.el('paymentAmount').value=500;await h.context.submitPayment();
  assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].key,h.calls[1].key);
});
test('success clears attempt before list refresh errors, and a new payment gets a fresh key',async()=>{
  const h=page();await h.context.openPayment('estimate');
  h.context.DentalApi.getBillingEstimates=async()=>{throw new Error('refresh failed');};
  await h.context.submitPayment();await h.context.openPayment('estimate');await h.context.submitPayment();
  assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].key,h.calls[1].key);
});
