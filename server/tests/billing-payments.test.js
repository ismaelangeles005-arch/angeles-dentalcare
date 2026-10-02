const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = uuid(1), actor = uuid(2), patient = uuid(3), estimateId = uuid(4), key = uuid(5);
const paymentBody = (amount = 300, idempotencyKey = key) => ({ amount, method: 'efectivo', note: '', idempotencyKey });
const initialBody = () => ({ patientId: patient, patientName: 'Billing fixture', items: [
  { description: 'Procedure fixture', quantity: 1, unitPrice: 1000 }
], paid: 200, paymentMethod: 'efectivo', idempotencyKey: key });

// Real route and audit code, simulated READ COMMITTED transactions and key/row locks.
// No network, PostgreSQL, data files, Docker or real financial records are used.
function harness() {
  const state = { estimates: new Map(), receipts: new Map(), payments: [], items: [], audits: [] };
  const calls = [], clients = [], routes = new Map(), locks = new Map(), options = {};
  let sequence = 100;
  function seed(id = estimateId, organization = org) {
    const row = { id, organization_id: organization, patient_id: patient, patient_name: 'Fixture',
      total: 1000, paid: 0, balance: 1000, status: 'en_deuda', deleted_at: null };
    state.estimates.set(id, row); return row;
  }
  seed();
  async function lock(client, name) {
    if (client.held.has(name)) return;
    const previous = locks.get(name) || Promise.resolve();
    let release;
    locks.set(name, new Promise(resolve => { release = resolve; }));
    await previous;
    client.held.set(name, release);
  }
  function end(client) {
    client.active = false;
    for (const release of client.held.values()) release();
    client.held.clear();
  }
  async function query(client, sql, values = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    calls.push({ client: client?.id || 'pool', q, values: clone(values) });
    const rows = data => ({ rows: clone(data) });
    if (client) {
      if (q === 'BEGIN') { client.active = true; return rows([]); }
      assert(client.active, 'all transaction queries must use an active dedicated client');
      if (q === 'ROLLBACK') { end(client); return rows([]); }
      if (options.fail && q.startsWith(options.fail)) throw new Error('injected failure');
      if (q === 'COMMIT') {
        for (const [id, value] of client.estimates) state.estimates.set(id, clone(value));
        for (const [id, value] of client.receipts) state.receipts.set(id, clone(value));
        for (const field of ['payments', 'items', 'audits']) state[field].push(...clone(client[field]));
        end(client); return rows([]);
      }
    } else assert(q.startsWith('SELECT'), 'pool.query cannot write or manage a transaction');
    if (q.startsWith('INSERT INTO billing_payment_operations')) {
      assert(q.includes('ON CONFLICT (organization_id, idempotency_key) DO NOTHING'));
      const id = values[0] + ':' + values[1].toLowerCase();
      await lock(client, 'key:' + id);
      if (state.receipts.has(id)) return rows([]);
      client.receipts.set(id, { request_hash: values[2] });
      return rows([{ idempotency_key: values[1] }]);
    }
    if (q.startsWith('SELECT request_hash')) {
      assert(q.includes('organization_id = $1 AND idempotency_key = $2'));
      const receipt = state.receipts.get(values[0] + ':' + values[1].toLowerCase());
      return rows(receipt ? [receipt] : []);
    }
    if (q.startsWith('UPDATE billing_payment_operations')) {
      const id = values[0] + ':' + values[1].toLowerCase();
      assert(client.receipts.has(id));
      Object.assign(client.receipts.get(id), { estimate_id: values[2], response_status: values[3], response_body: JSON.parse(values[4]) });
      return rows([]);
    }
    if (q.startsWith('SELECT id, full_name FROM patients')) {
      assert(client && q.includes('organization_id = $2'));
      return rows(values[0] === patient && values[1] === org && !options.denyPatient ? [{ id: patient }] : []);
    }
    if (q.startsWith('SELECT e.*')) {
      assert(q.includes('e.organization_id = $2') && q.includes('e.deleted_at IS NULL'));
      if (client) { assert(q.includes('FOR UPDATE')); await lock(client, 'estimate:' + values[0]); }
      const row = client?.estimates.get(values[0]) || state.estimates.get(values[0]);
      if (values.length > 2) assert(q.includes('p.organization_id = $2') && q.includes('p.doctor_id = $3'));
      return rows(row && row.organization_id === values[1] && !row.deleted_at && !options.denyDoctor ? [row] : []);
    }
    if (q.startsWith('INSERT INTO billing_estimates')) {
      const row = Object.fromEntries(['organization_id','patient_id','patient_name','status','subtotal','discount','total','paid','balance','notes','created_by'].map((name, i) => [name, values[i]]));
      row.id = uuid(sequence++); client.estimates.set(row.id, row); return rows([row]);
    }
    if (q.startsWith('INSERT INTO billing_estimate_items')) { client.items.push({ estimate_id: values[0] }); return rows([]); }
    if (q.startsWith('INSERT INTO billing_payments')) {
      const estimate = client.estimates.get(values[1]) || state.estimates.get(values[1]);
      assert.equal(estimate.organization_id, values[0]); assert(values[2] > 0);
      assert(client.estimates.has(values[1]) || client.held.has('estimate:' + values[1]));
      client.payments.push({ id: uuid(sequence++), organization_id: values[0], estimate_id: values[1], amount: values[2], method: q.includes("'saldo_total'") ? 'saldo_total' : values[3] });
      return rows([]);
    }
    if (q.startsWith('UPDATE billing_estimates')) {
      assert(client.held.has('estimate:' + values[0]));
      const row = clone(client.estimates.get(values[0]) || state.estimates.get(values[0]));
      if (q.includes('SET paid = $2')) {
        assert.equal(row.organization_id, values[4]); Object.assign(row, { paid: values[1], balance: values[2], status: values[3] });
      } else {
        assert.equal(row.organization_id, values[2]); row.status = values[1];
        if (q.includes('paid = total')) { row.paid = row.total; row.balance = 0; }
        if (q.includes('GREATEST')) row.balance = Math.max(0, row.total - row.paid);
      }
      assert(row.balance >= 0); client.estimates.set(row.id, row); return rows([row]);
    }
    if (q.startsWith('INSERT INTO audit_logs')) { client.audits.push({ organization: values[0], actor: values[1], action: values[2], payload: values[5] }); return rows([]); }
    if (q.startsWith('SELECT * FROM billing_estimate_items')) return rows(state.items.filter(item => item.estimate_id === values[0]));
    if (q.startsWith('SELECT bp.*')) {
      assert(q.includes('bp.organization_id = $2') && q.includes('bp.deleted_at IS NULL'));
      return rows(state.payments.filter(p => p.estimate_id === values[0] && p.organization_id === values[1] && !p.deleted_at));
    }
    throw new Error('Unexpected SQL: ' + q);
  }
  const db = { query: (sql, values) => query(null, sql, values), pool: { connect: async () => {
    const client = { id: clients.length + 1, active: false, held: new Map(), estimates: new Map(), receipts: new Map(), payments: [], items: [], audits: [], released: false };
    client.query = (sql, values) => query(client, sql, values);
    client.release = () => { assert(!client.active); client.released = true; };
    clients.push(client); return client;
  } } };
  const audit = { module: { exports: {} }, require: name => { assert.equal(name, '../db'); return db; } };
  vm.runInNewContext(read('server/src/utils/audit.js'), audit);
  const router = { use() {} };
  for (const verb of ['get','post','patch']) router[verb] = (route, fn) => routes.set(verb + ' ' + route, fn);
  vm.runInNewContext(read('server/src/routes/billing.js'), { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../db') return db;
    if (name === 'node:crypto') return crypto;
    if (name === '../utils/asyncHandler') return fn => fn;
    if (name === '../middleware/auth') return { authenticate() {}, allowRoles() {} };
    if (name === '../utils/audit') return audit.module.exports;
    throw new Error(name);
  } });
  async function request(verb, route, body, id = estimateId, user = {}) {
    const res = { code: 200, body: null, status(code) { this.code = code; return this; }, json(data) { this.body = clone(data); return this; } };
    await routes.get(verb + ' ' + route)({ body, params: { id: route === '/estimates' ? undefined : id }, user: { id: actor, organizationId: org, ...user } }, res);
    return res;
  }
  return { state, calls, clients, options, seed, request,
    pay: (body = paymentBody(), id, user) => request('post','/estimates/:id/payments',body,id,user),
    create: (body = initialBody(), user) => request('post','/estimates',body,undefined,user),
    settle: (idempotencyKey = key, id, user) => request('patch','/estimates/:id/status',{ status: 'pagado', idempotencyKey },id,user) };
}

test('initial payment: exact retry returns first response without duplicate estimate, item, payment or audit', async () => {
  const h = harness(), a = await h.create(), b = await h.create();
  assert.equal(a.code,201); assert.deepEqual(a.body,b.body); assert.equal(b.code,201);
  assert.equal(h.state.estimates.size,2); assert.equal(h.state.items.length,1);
  assert.equal(h.state.payments.length,1); assert.equal(h.state.audits.length,1);
  assert.equal(a.body.paid,200); assert.equal(a.body.balance,800);
});
test('estimate without initial payment is also idempotent', async () => {
  const h = harness(), body = { ...initialBody(), paid: 0 };
  assert.equal((await h.create(body)).code,201); await h.create(body);
  assert.equal(h.state.estimates.size,2); assert.equal(h.state.payments.length,0);
});
test('normal payment: first snapshot survives later payments and exact retry', async () => {
  const h = harness(), first = await h.pay();
  await h.pay(paymentBody(200,uuid(6)));
  const retry = await h.pay(); assert.deepEqual(retry.body,first.body);
  assert.equal(h.state.payments.length,2); assert.equal(h.state.audits.length,2);
  assert.equal(h.state.estimates.get(estimateId).balance,500);
});
for (const [name, change] of [['amount',{amount:400}],['method',{method:'tarjeta'}],['note',{note:'different'}]]) {
  test('same key with different ' + name + ' conflicts', async () => {
    const h = harness(); await h.pay();
    assert.equal((await h.pay({...paymentBody(),...change})).code,409);
    assert.equal(h.state.payments.length,1);
  });
}
test('same key with different estimate or operation conflicts', async () => {
  const h = harness(); h.seed(uuid(7)); await h.pay();
  assert.equal((await h.pay(paymentBody(),uuid(7))).code,409);
  assert.equal((await h.settle()).code,409); assert.equal((await h.create()).code,409);
  assert.equal(h.state.payments.length,1);
});
test('initial retry with changed material or items conflicts', async () => {
  const h = harness(); await h.create();
  assert.equal((await h.create({...initialBody(),paid:300})).code,409);
  assert.equal((await h.create({...initialBody(),items:[{description:'Changed',unitPrice:1000}]})).code,409);
  assert.equal(h.state.estimates.size,2);
});
test('key scope is organization, cross-tenant access is denied', async () => {
  const h = harness(); h.seed(uuid(7),uuid(8)); await h.pay();
  assert.equal((await h.pay(paymentBody(),uuid(7),{organizationId:uuid(8)})).code,200);
  assert.equal((await h.pay(paymentBody(100,uuid(9)),uuid(7))).code,404);
  assert.equal(h.state.receipts.size,2); assert.equal(h.state.payments.length,2);
});
test('doctor and patient access is enforced inside transaction and on replay', async () => {
  const h = harness(); await h.pay(); h.options.denyDoctor = true;
  assert.equal((await h.pay(paymentBody(),estimateId,{isDoctor:true,doctorId:uuid(9)})).code,404);
  h.options.denyPatient = true;
  assert.equal((await h.create({...initialBody(),idempotencyKey:uuid(10)})).code,403);
  assert.equal(h.state.estimates.size,1);
});
for (const route of ['create','pay','settle']) {
  for (const failure of ['INSERT INTO audit_logs','UPDATE billing_payment_operations','COMMIT']) {
    test(route + ': ' + failure + ' failure rolls back all writes and retry succeeds', async () => {
      const h = harness(); h.options.fail = failure;
      await assert.rejects(h[route](),/injected failure/);
      assert.equal(h.state.receipts.size,0); assert.equal(h.state.payments.length,0);
      assert.equal(h.state.audits.length,0); assert.equal(h.state.items.length,0);
      assert.equal(h.state.estimates.size,1); assert.equal(h.state.estimates.get(estimateId).balance,1000);
      assert(h.clients.every(c=>c.released)); assert(h.calls.some(c=>c.q==='ROLLBACK'));
      delete h.options.fail;
      assert([200,201].includes((await h[route]()).code)); assert.equal(h.state.payments.length,1);
    });
  }
}
for (const route of ['create','pay','settle']) {
  test(route + ': concurrent same key makes exactly one payment and one audit', async () => {
    const h = harness(); const [a,b] = await Promise.all([h[route](),h[route]()]);
    assert.deepEqual(a.body,b.body); assert.equal(h.state.payments.length,1);
    assert.equal(h.state.audits.length,1); assert.equal(h.state.receipts.size,1);
    assert.equal(h.clients.length,2); assert(h.clients.every(c=>c.released));
  });
}
test('concurrent different keys serialize on estimate and reject overspend', async () => {
  const h = harness(); const results = await Promise.all([h.pay(paymentBody(700)),h.pay(paymentBody(700,uuid(6)))]);
  assert.deepEqual(results.map(r=>r.code).sort(),[200,400]);
  assert.equal(h.state.payments.length,1); assert.equal(h.state.receipts.size,1);
  assert.equal(h.state.estimates.get(estimateId).paid,700); assert.equal(h.state.estimates.get(estimateId).balance,300);
});
test('different keys with sufficient balance both succeed', async () => {
  const h = harness(); await Promise.all([h.pay(paymentBody(700)),h.pay(paymentBody(300,uuid(6)))]);
  assert.equal(h.state.payments.length,2); assert.equal(h.state.estimates.get(estimateId).balance,0);
  assert.equal(h.state.estimates.get(estimateId).status,'pagado');
});
test('Pagado locks before reading remaining balance; retry creates no second payment', async () => {
  const h = harness(); await h.pay(paymentBody(300,uuid(6)));
  const first = await h.settle(); assert.equal(first.body.balance,0);
  assert.equal(h.state.payments[1].amount,700); assert.equal(h.state.payments[1].method,'saldo_total');
  assert.deepEqual((await h.settle()).body,first.body); assert.equal(h.state.payments.length,2);
});
test('Pagado concurrent with a normal payment cannot consume stale balance', async () => {
  const h = harness(); const results = await Promise.all([h.pay(paymentBody(700)),h.settle(uuid(6))]);
  assert(results.every(r=>[200,400].includes(r.code)));
  assert.equal(h.state.payments.reduce((s,p)=>s+p.amount,0),1000);
  assert.equal(h.state.estimates.get(estimateId).balance,0);
});
test('two Pagado keys cannot pay the same remaining balance twice', async () => {
  const h = harness(); await Promise.all([h.settle(),h.settle(uuid(6))]);
  assert.equal(h.state.payments.length,1); assert.equal(h.state.estimates.get(estimateId).balance,0);
});
test('cancelled estimate rejects normal payment and Pagado without consuming keys', async () => {
  const h = harness(); h.state.estimates.get(estimateId).status='cancelado';
  assert.equal((await h.pay()).code,400); assert.equal((await h.settle()).code,400);
  assert.equal(h.state.payments.length,0); assert.equal(h.state.receipts.size,0);
});
for (const amount of [0,-1,1001]) test('invalid/overbalance amount rejected: '+amount, async () => {
  const h = harness(); assert.equal((await h.pay(paymentBody(amount))).code,400);
  assert.equal(h.state.payments.length,0); assert.equal(h.state.receipts.size,0);
});
test('missing or malformed key fails closed, no pool connection', async () => {
  const h = harness(); for (const idempotencyKey of [undefined,'invalid']) {
    assert.equal((await h.pay({...paymentBody(),idempotencyKey})).code,400);
  }
  assert.equal(h.clients.length,0);
});
test('historical payments without keys remain readable and unchanged', async () => {
  const h = harness(), historic = {id:uuid(90),estimate_id:estimateId,organization_id:org,amount:100,method:'registro_inicial'};
  h.state.payments.push(historic);
  const response = await h.request('get','/estimates/:id',{});
  assert.deepEqual(response.body.payments,[historic]); assert.deepEqual(h.state.payments,[historic]);
});
test('all mutation queries, audit and receipt use one client, released after commit', async () => {
  const h = harness(); await h.pay();
  assert(h.calls.every(c=>c.client===1)); assert.equal(h.calls[0].q,'BEGIN');
  assert.equal(h.calls.at(-1).q,'COMMIT'); assert(h.clients[0].released);
  assert.equal(h.state.audits[0].actor,actor); assert.equal(h.state.audits[0].organization,org);
  const lockIndex=h.calls.findIndex(c=>c.q.includes('FOR UPDATE'));
  assert(lockIndex>0 && lockIndex<h.calls.findIndex(c=>c.q.startsWith('INSERT INTO billing_payments')));
});
test('non-payment status changes retain contract with dedicated transaction and audit', async () => {
  const h = harness(); const r=await h.request('patch','/estimates/:id/status',{status:'pendiente'});
  assert.equal(r.code,200); assert.equal(r.body.status,'pendiente');
  assert.equal(h.state.receipts.size,0); assert.equal(h.state.payments.length,0); assert.equal(h.state.audits.length,1);
});
test('migration adds only organization-scoped receipt uniqueness; no historical writes', () => {
  const sql=read('server/database/migration_billing_payment_idempotency.sql');
  assert.match(sql,/PRIMARY KEY \(organization_id, idempotency_key\)/);
  assert.match(sql,/organization_id UUID NOT NULL REFERENCES organizations\(id\)/);
  assert.match(sql,/estimate_id UUID REFERENCES billing_estimates\(id\)/);
  assert(!/\b(?:UPDATE|DELETE|ALTER|INSERT)\b/i.test(sql));
  const manifest=JSON.parse(read('server/database/migrations.json'));
  assert.equal(manifest.length,28); assert.equal(manifest.at(-1),'migration_billing_payment_idempotency.sql');
});
