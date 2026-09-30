const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/routes/treatmentPlans.js'), 'utf8');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = uuid(1), patient = uuid(2), planId = uuid(3), itemId = uuid(4), entryId = uuid(5), procedure = uuid(6);
const tooth = 'PERMANENT_UPPER_RIGHT_CENTRAL_INCISOR';
const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

// Real handlers, in-memory SQL/transaction double. No pg import, filesystem writes or network.
function harness(status = 'ACTIVE') {
  let state = {
    plan: { id: planId, organization_id: org, patient_id: patient, status: 'DRAFT', updated_at: '2026-09-29T00:00:00.000Z' },
    entries: [{ id: entryId, organization_id: org, patient_id: patient, entry_type: 'PROPOSED_TREATMENT', status, procedure_id: procedure, tooth_id: tooth, surface: 'PALATAL' }],
    items: [{ id: itemId, treatment_plan_id: planId, odontogram_entry_id: entryId, procedure_id: procedure, tooth_id: tooth, surface: 'PALATAL', status: 'PROPOSED', procedure_name_snapshot: 'Original', unit_price_snapshot: '100.00', quantity: 1, discount_amount: '0.00', final_amount: '100.00' }],
    acceptances: [{ id: uuid(9), signature_data: 'HISTORICAL', items_snapshot: [{ status: 'ACCEPTED', procedure_name_snapshot: 'Historical' }], total_snapshot: '50.00' }], audits: []
  };
  const calls = [], routes = [], errors = [], options = {};
  let saved, lockTail = Promise.resolve(), releaseLock, acquired = false;
  async function acquire() {
    const previous = lockTail, gate = deferred(); lockTail = gate.promise;
    await previous; return gate.resolve;
  }
  const query = async (sql, values = []) => {
    const q = sql.replace(/\s+/g, ' ').trim(); calls.push({ q, values: clone(values) });
    if (q === 'BEGIN') { saved = clone(state); return { rows: [] }; }
    if (q === 'ROLLBACK') { const entries = state.entries; state = saved; state.entries = entries; return { rows: [] }; }
    if (q === 'COMMIT') return { rows: [] };
    if (q.includes('SELECT tp.*')) {
      assert(q.includes('p.organization_id = tp.organization_id'));
      return { rows: values[0] === state.plan.id && values[1] === state.plan.organization_id ? [clone(state.plan)] : [] };
    }
    if (q.startsWith('SELECT * FROM treatment_plan_items')) return { rows: clone(state.items.filter(i => i.treatment_plan_id === values[0])) };
    if (q.startsWith('SELECT oe.id, oe.status')) {
      assert(q.includes('oe.organization_id = $2 AND oe.patient_id = $3'));
      assert(q.includes("oe.entry_type = 'PROPOSED_TREATMENT'"));
      assert(q.includes('ORDER BY oe.id FOR SHARE OF oe'));
      releaseLock = await acquire(); acquired = true;
      const rows = state.entries.filter(e => values[0].includes(e.id) && e.organization_id === values[1] && e.patient_id === values[2] && e.entry_type === 'PROPOSED_TREATMENT');
      if (options.afterLock) await options.afterLock();
      return { rows: clone(rows) };
    }
    if (q.startsWith('SELECT tooth_id, surface')) {
      assert(q.includes("status = 'ACTIVE'") && q.includes('FOR SHARE'));
      return { rows: clone(state.entries.filter(e => e.id === values[0] && e.organization_id === values[1] && e.patient_id === values[2] && e.entry_type === 'PROPOSED_TREATMENT' && e.status === 'ACTIVE')) };
    }
    if (q.startsWith('SELECT id FROM treatment_plan_items')) return { rows: state.items.filter(i => i.treatment_plan_id === values[0] && i.odontogram_entry_id === values[1]).map(i => ({ id: i.id })) };
    if (q.includes('FROM procedure_catalog')) return { rows: [{ id: procedure, name: 'Catalog', category_name: 'Operatoria', base_price: '100.00' }] };
    if (q.startsWith('INSERT INTO treatment_plan_items')) {
      const row = { id: itemId, treatment_plan_id: values[0], procedure_id: values[1], odontogram_entry_id: values[2], tooth_id: values[3], surface: values[4], status: 'PROPOSED' };
      state.items.push(row); return { rows: [clone(row)] };
    }
    if (q.startsWith('UPDATE treatment_plan_items')) {
      const item = state.items.find(i => i.id === values[0] && i.treatment_plan_id === values[1]);
      item.status = values[2]; return { rows: [clone(item)] };
    }
    if (q.startsWith('UPDATE treatment_plans')) {
      state.plan.status = q.includes("status = 'PRESENTED'") ? 'PRESENTED' : (values[2] || state.plan.status);
      return { rows: [clone(state.plan)] };
    }
    if (q.startsWith('INSERT INTO treatment_plan_acceptances')) {
      const row = { id: uuid(10 + state.acceptances.length), organization_id: values[0], treatment_plan_id: values[1], patient_id: values[2], accepted_by_name: values[3], signature_data: values[4], created_by: values[5], plan_status_snapshot: values[6], total_snapshot: values[7], accepted_total_snapshot: values[8], items_snapshot: JSON.parse(values[9]) };
      state.acceptances.push(row); return { rows: [clone(row)] };
    }
    throw Error('Unexpected SQL: ' + q);
  };
  const client = { query, release() { if (acquired) { acquired = false; releaseLock(); } } };
  const router = { use(...handlers) { errors.push(...handlers.filter(h => h.length === 4)); }, get(p, ...h) { routes.push({ method: 'get', p, h }); }, post(p, ...h) { routes.push({ method: 'post', p, h }); }, patch(p, ...h) { routes.push({ method: 'patch', p, h }); } };
  vm.runInNewContext(source, { Buffer, module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../db') return { query, pool: { connect: async () => client } };
    if (name === '../utils/asyncHandler') return fn => fn;
    if (name === '../middleware/auth') return { authenticate() {}, allowRoles: () => () => {} };
    if (name === '../utils/dentalTeeth') return require('../src/utils/dentalTeeth');
    if (name === '../utils/audit') return { writeAuditLog: async (...args) => { state.audits.push(clone(args.slice(1, 5))); if (options.failAudit) throw Error('Audit failure'); } };
    throw Error(name);
  }});
  return {
    state: () => state, calls, options,
    async invalidate(nextStatus, beforeRelease) {
      const release = await acquire();
      try { if (beforeRelease) await beforeRelease(); state.entries[0].status = nextStatus; }
      finally { release(); }
    },
    async run(operation, overrides = {}) {
      const config = {
        present: ['patch', '/:planId/status', { status: 'PRESENTED' }],
        decide: ['patch', '/:planId/items/:itemId/status', { status: 'ACCEPTED' }],
        sign: ['post', '/:planId/acceptance', { accepted_by_name: 'QA simulated', signature_data: signature }],
        add: ['post', '/:planId/items', { procedure_id: procedure, odontogram_entry_id: entryId }]
      }[operation];
      const req = { params: { planId, itemId, ...overrides.params }, body: { ...config[2], ...overrides.body }, user: { id: uuid(8), organizationId: org, ...overrides.user } };
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = clone(body); return this; } };
      try { await routes.find(r => r.method === config[0] && r.p === config[1]).h.at(-1)(req, res); }
      catch (error) { errors[0](error, req, res, e => { res.code = e.status || 500; res.body = { message: e.message }; }); }
      return res;
    }
  };
}
function prepare(h, op) {
  if (op !== 'present' && op !== 'add') h.state().plan.status = 'PRESENTED';
  if (op === 'sign') h.state().items[0].status = 'ACCEPTED';
}

for (const status of ['ACTIVE', 'RESOLVED', 'VOIDED', 'SUPERSEDED']) {
  for (const op of ['present', 'decide', 'sign']) test(`${status}: ${op} preserves items/history and enforces clinical validity`, async () => {
    const h = harness(status); prepare(h, op);
    const before = clone(h.state()); const res = await h.run(op);
    if (['ACTIVE', 'RESOLVED'].includes(status)) {
      assert.equal(res.code, op === 'sign' ? 201 : 200);
      assert(h.calls.some(c => c.q === 'COMMIT'));
      assert.equal(h.state().items.length, 1);
      assert.notEqual(h.state().items[0].status, 'COMPLETED');
      assert.deepEqual(h.state().acceptances[0], before.acceptances[0]);
      assert.equal(h.state().entries[0].status, status);
    } else {
      assert.equal(res.code, 409); assert.equal(res.body.code, 'TREATMENT_PLAN_CLINICAL_REFERENCE_INVALID');
      assert.equal(res.body.item_id, itemId);
      assert.deepEqual(h.state(), before); assert(h.calls.some(c => c.q === 'ROLLBACK'));
      assert(!h.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.q)));
    }
  });
}
test('new incorporation remains ACTIVE-only, with original snapshot/duplicate rules', async () => {
  for (const status of ['ACTIVE', 'RESOLVED', 'VOIDED', 'SUPERSEDED']) {
    const h = harness(status); h.state().items = [];
    assert.equal((await h.run('add')).code, status === 'ACTIVE' ? 201 : 400);
    assert.equal(h.state().items.length, status === 'ACTIVE' ? 1 : 0);
  }
  assert.equal((await harness().run('add')).code, 409);
});
for (const mismatch of ['organization_id', 'patient_id', 'entry_type', 'procedure_id', 'tooth_id', 'surface', 'missing']) {
  test(`reference ${mismatch} mismatch: scoped conflict and rollback in all mutations`, async () => {
    for (const op of ['present','decide','sign']) {
      const h = harness(); prepare(h, op);
      if (mismatch === 'missing') h.state().entries = [];
      else h.state().entries[0][mismatch] = mismatch.endsWith('_id') ? uuid(99) : 'OTHER';
      const before = clone(h.state()); const res = await h.run(op);
      assert.equal(res.code,409); assert.equal(res.body.item_id,itemId);
      assert(!JSON.stringify(res.body).includes(uuid(99))); assert.deepEqual(h.state(),before);
    }
  });
}
test('cross-tenant plan rejected before loading its items or references', async () => {
  const h=harness();const res=await h.run('present',{user:{organizationId:uuid(99)}});
  assert.equal(res.code,404);assert(!h.calls.some(c=>c.q.includes('FROM treatment_plan_items')));
});
test('unlinked items remain valid; nullable procedure reference preserved when both sides are null', async () => {
  for(const op of ['present','decide','sign']) {
    const h=harness();prepare(h,op);h.state().items[0].odontogram_entry_id=null;
    assert((await h.run(op)).code<300);assert(!h.calls.some(c=>c.q.includes('FROM odontogram_entries')));
    const nullable=harness();prepare(nullable,op);nullable.state().items[0].procedure_id=null;nullable.state().entries[0].procedure_id=null;
    assert((await nullable.run(op)).code<300);
  }
});
test('decisions validate target only; signature validates every snapshot item including rejected', async () => {
  const h=harness();prepare(h,'decide');h.state().items.push({...clone(h.state().items[0]),id:uuid(20),odontogram_entry_id:uuid(21),status:'REJECTED'});
  assert.equal((await h.run('decide')).code,200);
  const before=clone(h.state());assert.equal((await h.run('sign')).code,409);assert.deepEqual(h.state(),before);
});
test('audit failure rolls back updates/new signature and leaves historical acceptance intact', async () => {
  for(const op of ['present','decide','sign']){const h=harness();prepare(h,op);h.options.failAudit=true;const before=clone(h.state());assert.equal((await h.run(op)).code,500);assert.deepEqual(h.state(),before);assert(h.calls.some(c=>c.q==='ROLLBACK'));}
});
test('later clinical changes never rewrite stored signed snapshots', async () => {
  const h=harness('RESOLVED');prepare(h,'sign');assert.equal((await h.run('sign')).code,201);
  const signed=clone(h.state().acceptances);await h.invalidate('VOIDED');h.state().entries[0].condition_label='Changed';
  assert.equal((await h.run('sign')).code,409);assert.deepEqual(h.state().acceptances,signed);
});
test('proposal locks are ordered/deduplicated and held through commit: simulated concurrent invalidation waits', async () => {
  const h=harness();const entered=deferred(),resume=deferred();
  h.options.afterLock=async()=>{entered.resolve();await resume.promise;};
  const operation=h.run('present');await entered.promise;
  let invalidated=false;const writer=h.invalidate('VOIDED').then(()=>{invalidated=true;});
  await Promise.resolve();assert.equal(invalidated,false);
  resume.resolve();assert.equal((await operation).code,200);await writer;
  assert.equal(h.state().entries[0].status,'VOIDED');assert.equal(h.state().plan.status,'PRESENTED');
  assert.equal((await h.run('decide')).code,409);
});
test('invalidation winning the lock is observed before plan mutation', async () => {
  const h=harness();const entered=deferred(),resume=deferred();
  const writer=h.invalidate('SUPERSEDED',async()=>{entered.resolve();await resume.promise;});await entered.promise;
  const operation=h.run('present');await Promise.resolve();resume.resolve();await writer;
  assert.equal((await operation).code,409);assert(!h.calls.some(c=>c.q.startsWith('UPDATE treatment_plans')));
  assert.equal(h.state().entries[0].status,'SUPERSEDED');
});

test('accept/reject/postpone and repeated decisions all enforce the reference policy', async () => {
  for(const clinical of ['ACTIVE','RESOLVED','VOIDED','SUPERSEDED']) for(const decision of ['ACCEPTED','REJECTED','POSTPONED']) {
    const h=harness(clinical);prepare(h,'decide');
    const allowed=['ACTIVE','RESOLVED'].includes(clinical);
    assert.equal((await h.run('decide',{body:{status:decision}})).code,allowed?200:409);
    const before=clone(h.state());assert.equal((await h.run('decide',{body:{status:decision}})).code,allowed?200:409);
    assert.deepEqual(h.state(),before);
  }
});
test('multiple proposal locks use one sorted distinct ID set independent of item order', async () => {
  const h=harness();const second={...clone(h.state().entries[0]),id:uuid(30)};h.state().entries.push(second);
  h.state().items.unshift({...clone(h.state().items[0]),id:uuid(31),odontogram_entry_id:second.id});
  h.state().items.push({...clone(h.state().items[1]),id:uuid(32)});
  assert.equal((await h.run('present')).code,200);
  const reads=h.calls.filter(c=>c.q.startsWith('SELECT oe.id, oe.status'));
  assert.equal(reads.length,1);assert.deepEqual(reads[0].values[0],[entryId,second.id]);
});
