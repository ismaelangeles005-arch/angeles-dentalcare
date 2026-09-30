const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/routes/treatmentPlans.js'), 'utf8');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = uuid(1), patient = uuid(2), planId = uuid(3), itemId = uuid(4), proposalId = uuid(5), procedure = uuid(6);
const clone = value => JSON.parse(JSON.stringify(value));

// Executes real route handlers against a transactional SQL double; never imports pg.
function harness({ linked = false, evidence = false, planStatus = 'IN_PROGRESS', itemStatus = 'IN_PROGRESS' } = {}) {
  let state = {
    plan: { id: planId, organization_id: org, patient_id: patient, status: planStatus },
    items: [{ id: itemId, treatment_plan_id: planId, status: itemStatus, odontogram_entry_id: linked ? proposalId : null,
      procedure_id: procedure, tooth_id: 'PERMANENT_UPPER_RIGHT_CENTRAL_INCISOR', surface: null, final_amount: '100.00' }],
    entries: [], acceptances: [{ id: uuid(10), items_snapshot: [{ status: 'ACCEPTED' }], signature_data: 'UNCHANGED' }], audits: []
  };
  state.entries.push({ ...clone(state.items[0]), id: proposalId, organization_id: org, patient_id: patient, entry_type: 'PROPOSED_TREATMENT', status: 'RESOLVED' });
  if (evidence) state.entries.push({ ...clone(state.entries[0]), id: uuid(7), entry_type: 'COMPLETED_TREATMENT', status: 'ACTIVE', related_entry_id: proposalId });
  const routes = new Map(), calls = [], options = {};
  let saved;
  const query = async (sql, values = []) => {
    const q = sql.replace(/\s+/g, ' ').trim(); calls.push({ q, values: clone(values) });
    if (q === 'BEGIN') { saved = clone(state); return { rows: [] }; }
    if (q === 'ROLLBACK') { state = saved; return { rows: [] }; }
    if (q === 'COMMIT') return { rows: [] };
    if (q.startsWith('SELECT tp.*')) {
      assert(q.includes('p.organization_id = tp.organization_id') && q.includes('p.deleted_at IS NULL'));
      return { rows: values[0] === state.plan.id && values[1] === state.plan.organization_id ? [clone(state.plan)] : [] };
    }
    if (q.startsWith('SELECT * FROM treatment_plan_items')) {
      assert(q.includes('ORDER BY id FOR UPDATE'));
      return { rows: clone(state.items.filter(i => i.treatment_plan_id === values[0])) };
    }
    if (q.startsWith('SELECT i.*')) {
      assert(q.includes('tp.organization_id = $2'));
      return { rows: values[1] === org ? clone(state.items) : [] };
    }
    if (q.includes('FROM treatment_plan_acceptances')) return { rows: clone(state.acceptances) };
    if (q.startsWith('SELECT oe.id, oe.status')) {
      assert(q.includes('ORDER BY oe.id FOR SHARE OF oe'));
      return { rows: clone(state.entries.filter(e => values[0].includes(e.id) && e.organization_id === values[1] && e.patient_id === values[2] && e.entry_type === 'PROPOSED_TREATMENT')) };
    }
    if (q.startsWith('SELECT oe.id FROM odontogram_entries')) {
      assert(q.includes("oe.entry_type = 'COMPLETED_TREATMENT'"));
      assert(q.includes("oe.status NOT IN ('VOIDED', 'SUPERSEDED')"));
      assert(q.includes('oe.related_entry_id = $1 AND oe.organization_id = $2 AND oe.patient_id = $3'));
      assert(q.includes('oe.procedure_id IS NOT DISTINCT FROM $4::uuid'));
      assert(q.includes('oe.tooth_id IS NOT DISTINCT FROM $5::text'));
      assert(q.includes('oe.surface IS NOT DISTINCT FROM $6::text'));
      assert(q.includes('ORDER BY oe.id LIMIT 1 FOR SHARE OF oe'));
      return { rows: clone(state.entries.filter(e => e.related_entry_id === values[0] && e.organization_id === values[1] && e.patient_id === values[2] &&
        e.entry_type === 'COMPLETED_TREATMENT' && !['VOIDED', 'SUPERSEDED'].includes(e.status) &&
        [e.procedure_id, e.tooth_id, e.surface].every((v, i) => (v ?? null) === (values[i + 3] ?? null))).slice(0, 1)) };
    }
    if (q.startsWith('UPDATE treatment_plan_items')) {
      const item = state.items.find(i => i.id === values[0] && i.treatment_plan_id === values[1]);
      item.status = values[2]; return { rows: [clone(item)] };
    }
    if (q.startsWith('UPDATE treatment_plans')) {
      assert.equal(values[1], org); state.plan.status = values[2]; return { rows: [clone(state.plan)] };
    }
    throw Error('Unexpected SQL: ' + q);
  };
  const client = { query, release() {} };
  const router = { use() {}, get(p, fn) { routes.set('get ' + p, fn); }, post() {}, patch(p, fn) { routes.set('patch ' + p, fn); } };
  vm.runInNewContext(source, { Buffer, module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../db') return { query, pool: { connect: async () => client } };
    if (name === '../utils/asyncHandler') return fn => fn;
    if (name === '../middleware/auth') return { authenticate() {}, allowRoles: () => () => {} };
    if (name === '../utils/dentalTeeth') return require('../src/utils/dentalTeeth');
    if (name === '../utils/audit') return { writeAuditLog: async (req, action, entity, id, metadata, connection) => {
      assert.equal(connection, client); assert.equal(req.user.organizationId, org); assert.equal(req.user.id, uuid(8));
      state.audits.push({ action, entity, id, metadata: clone(metadata) });
      if (options.failAudit === state.audits.length) throw Error('Audit failure');
    } };
    throw Error(name);
  } });
  return { state: () => state, calls, options, async run(operation, overrides = {}) {
    const route = operation === 'plan' ? 'patch /:planId/execution' : operation === 'detail' ? 'get /:planId' : 'patch /:planId/items/:itemId/execution';
    const req = { params: { planId, itemId, ...overrides.params }, user: { id: uuid(8), organizationId: org, ...overrides.user }, body: { status: operation === 'complete' ? 'COMPLETED' : 'IN_PROGRESS', ...overrides.body } };
    const res = { code: 200, json(body) { this.body = clone(body); } };
    try { await routes.get(route)(req, res); } catch (error) { res.code = error.status || 500; res.body = { message: error.message, code: error.code }; }
    return res;
  } };
}

test('plan start requires accepted work and eligible acceptance state; no automatic item start; repeat safe', async () => {
  const h = harness({ planStatus: 'ACCEPTED', itemStatus: 'ACCEPTED', linked: true });
  assert.equal((await h.run('plan')).code, 200);
  assert.equal(h.state().plan.status, 'IN_PROGRESS'); assert.equal(h.state().items[0].status, 'ACCEPTED');
  assert.equal((await h.run('plan')).code, 200); assert.equal(h.state().audits.length, 1);
  for (const planStatus of ['DRAFT', 'PRESENTED', 'REJECTED', 'POSTPONED', 'COMPLETED', 'CANCELLED']) {
    assert.equal((await harness({ planStatus, itemStatus: 'ACCEPTED' }).run('plan')).code, 409);
  }
  const none = harness({ planStatus: 'ACCEPTED', itemStatus: 'REJECTED' });
  assert.equal((await none.run('plan')).code, 409);
  none.state().items = []; assert.equal((await none.run('plan')).code, 409);
  assert.equal((await harness({ planStatus: 'PARTIALLY_ACCEPTED', itemStatus: 'ACCEPTED' }).run('plan')).code, 200);
});

test('accepted item starts only in executing plan; repeated start is idempotent', async () => {
  const h = harness({ itemStatus: 'ACCEPTED' });
  assert.equal((await h.run('start')).code, 200); assert.equal(h.state().items[0].status, 'IN_PROGRESS');
  assert.equal((await h.run('start')).code, 200); assert.equal(h.state().audits.length, 1);
  assert.equal((await harness({ planStatus: 'ACCEPTED', itemStatus: 'ACCEPTED' }).run('start')).code, 409);
});

for (const itemStatus of ['REJECTED', 'POSTPONED', 'PROPOSED', 'COMPLETED']) test(`${itemStatus} cannot start`, async () => {
  const h = harness({ itemStatus }); const before = clone(h.state());
  assert.equal((await h.run('start')).code, 409); assert.deepEqual(h.state(), before);
});

test('accepted cannot jump directly to completed', async () => {
  assert.equal((await harness({ itemStatus: 'ACCEPTED' }).run('complete')).code, 409);
});

test('unlinked explicit completion, automatic plan completion, snapshots and idempotence', async () => {
  const h = harness(); const signed = clone(h.state().acceptances);
  const res = await h.run('complete'); assert.equal(res.code, 200);
  assert.equal(res.body.plan_status, 'COMPLETED'); assert.equal(h.state().items[0].status, 'COMPLETED');
  assert.deepEqual(res.body.progress, { total: 1, completed: 1, in_progress: 0, pending: 0, percent: 100 });
  assert.equal(h.state().audits.length, 2); assert.deepEqual(h.state().acceptances, signed);
  assert(!h.calls.some(c => c.q.includes('odontogram_entries')));
  assert.equal((await h.run('complete')).code, 200); assert.equal(h.state().audits.length, 2);
  assert.equal((await h.run('plan')).code, 409);
});

test('RESOLVED alone is not completion evidence and never changes the item', async () => {
  const h = harness({ linked: true }); const before = clone(h.state());
  const res = await h.run('complete'); assert.equal(res.code, 409); assert.match(res.body.message, /Odontograma/);
  assert.deepEqual(h.state(), before);
});

test('valid linked evidence allows completion without clinical writes, audit retains evidence ID', async () => {
  const h = harness({ linked: true, evidence: true }); const entries = clone(h.state().entries);
  assert.equal((await h.run('complete')).code, 200);
  assert.equal(h.state().audits[0].metadata.completed_treatment_id, uuid(7));
  assert.deepEqual(h.state().entries, entries);
  assert(!h.calls.some(c => /^(INSERT|UPDATE|DELETE).*odontogram_entries/.test(c.q)));
});

for (const field of ['organization_id', 'patient_id', 'procedure_id', 'tooth_id', 'surface', 'related_entry_id', 'entry_type', 'VOIDED', 'SUPERSEDED']) {
  test(`evidence ${field} mismatch is rejected`, async () => {
    const h = harness({ linked: true, evidence: true }); const e = h.state().entries[1];
    if (['VOIDED', 'SUPERSEDED'].includes(field)) e.status = field;
    else e[field] = field.endsWith('_id') ? uuid(99) : 'OTHER';
    const before = clone(h.state()); assert.equal((await h.run('complete')).code, 409); assert.deepEqual(h.state(), before);
  });
}

test('all execution transitions preserve reference hardening', async () => {
  for (const op of ['plan', 'start', 'complete']) for (const status of ['VOIDED', 'SUPERSEDED']) {
    const h = harness({ linked: true, evidence: true, planStatus: op === 'plan' ? 'ACCEPTED' : 'IN_PROGRESS', itemStatus: op === 'complete' ? 'IN_PROGRESS' : 'ACCEPTED' });
    h.state().entries[0].status = status;
    const res = await h.run(op); assert.equal(res.code, 409); assert.equal(res.body.code, 'TREATMENT_PLAN_CLINICAL_REFERENCE_INVALID');
  }
});

test('partial completion stays in progress; rejected/postponed/proposed do not block final completion', async () => {
  const h = harness();
  for (const [n, status] of ['ACCEPTED', 'REJECTED', 'POSTPONED', 'PROPOSED'].entries()) h.state().items.push({ ...clone(h.state().items[0]), id: uuid(20 + n), status });
  const first = await h.run('complete'); assert.equal(first.body.plan_status, 'IN_PROGRESS');
  assert.deepEqual(first.body.progress, { total: 2, completed: 1, in_progress: 0, pending: 1, percent: 50 });
  assert.equal((await h.run('start', { params: { itemId: uuid(20) } })).code, 200);
  const last = await h.run('complete', { params: { itemId: uuid(20) } }); assert.equal(last.body.plan_status, 'COMPLETED');
  assert.equal(last.body.progress.percent, 100);
});

test('GET progress is deterministic and zero-safe; totals preserve executed accepted work and signed snapshots', async () => {
  const h = harness();
  h.state().items[0].status = 'COMPLETED';
  for (const [n, status] of ['ACCEPTED', 'IN_PROGRESS', 'REJECTED', 'POSTPONED', 'PROPOSED'].entries()) h.state().items.push({ ...clone(h.state().items[0]), id: uuid(20 + n), status });
  const res = await h.run('detail'); assert.equal(res.code, 200);
  assert.deepEqual(res.body.progress, { total: 3, completed: 1, in_progress: 1, pending: 1, percent: 33 });
  assert.equal(res.body.total, '600.00'); assert.equal(res.body.accepted_total, '300.00');
  assert.deepEqual(res.body.acceptances, h.state().acceptances);
  h.state().items = []; assert.deepEqual((await h.run('detail')).body.progress, { total: 0, completed: 0, in_progress: 0, pending: 0, percent: 0 });
});

test('tenant/plan/item isolation and UUID/status validation', async () => {
  for (const op of ['plan', 'start', 'complete', 'detail']) {
    const h = harness(); assert.equal((await h.run(op, { user: { organizationId: uuid(99) } })).code, 404);
    assert(!h.calls.some(c => c.q.includes('FROM treatment_plan_items')));
    assert.equal((await h.run(op, { params: { planId: 'invalid' } })).code, 400);
  }
  const h = harness(); assert.equal((await h.run('complete', { params: { itemId: uuid(99) } })).code, 404);
  assert.equal((await h.run('start', { body: { status: 'ACCEPTED' } })).code, 400);
});

test('audit failure rolls back item, parent and audit mutations at each stage', async () => {
  for (const [op, failAudit] of [['plan', 1], ['start', 1], ['complete', 1], ['complete', 2]]) {
    const h = harness({ planStatus: op === 'plan' ? 'ACCEPTED' : 'IN_PROGRESS', itemStatus: op === 'complete' ? 'IN_PROGRESS' : 'ACCEPTED' });
    h.options.failAudit = failAudit; const before = clone(h.state());
    assert.equal((await h.run(op)).code, 500); assert.deepEqual(h.state(), before);
    assert(h.calls.some(c => c.q === 'ROLLBACK')); assert(!h.calls.some(c => c.q === 'COMMIT'));
  }
});

test('mutations lock scoped plan before deterministic items, references and evidence; no clinical/snapshot writes', async () => {
  const h = harness({ linked: true, evidence: true }); await h.run('complete');
  const queries = h.calls.map(c => c.q);
  assert(queries[1].includes('FOR UPDATE OF tp'));
  assert(queries[2].includes('ORDER BY id FOR UPDATE'));
  assert(queries[3].includes('FOR SHARE OF oe')); assert(queries[4].includes('FOR SHARE OF oe'));
  assert(!queries.some(q => /^(UPDATE|INSERT|DELETE).*?(odontogram_entries|treatment_plan_acceptances)/.test(q)));
  assert.match(source, /router.use\(authenticate, allowRoles\("head_admin", "admin", "doctor"\)\)/);
});

const html = fs.readFileSync(path.join(__dirname, '../../pacientes.html'), 'utf8');
function frontend() {
  const container = { innerHTML: '', querySelectorAll: () => [] };
  const calls = [], notifications = [];
  const state = { busy: false, patient: { id: patient }, plan: { id: planId, name: 'Plan', status: 'IN_PROGRESS', items: [
    { id: itemId, status: 'ACCEPTED', procedure_name_snapshot: 'Test' }
  ], progress: { completed: 0, total: 1, percent: 0 } } };
  const context = { treatmentPlanState: state, document: { getElementById: () => container },
    odontogramCurrent: { teeth: {} }, odontogramLoaded: true, ODONTOGRAM_SURFACES: [{ value: '', label: 'Pieza completa' }],
    piezaPlanPaciente: () => '1.1', DentalRoles: { escapeHtml: v => String(v ?? ''), notify: (...args) => notifications.push(args) },
    cargarPlanesPaciente: () => calls.push('list'), DentalApi: {
      startTreatmentPlanExecution: async id => calls.push(['start', id]),
      updateTreatmentPlanItemExecution: async (...args) => calls.push(['item', ...args]),
      getTreatmentPlan: async id => { calls.push(['reload', id]); return { ...state.plan, status: 'COMPLETED', items: [{ ...state.plan.items[0], status: 'COMPLETED' }], progress: { total: 1, completed: 1, percent: 100 } }; }
    } };
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('        function renderPlanPaciente()'), html.indexOf('        function formalizarAceptacionPlan()')), context);
  return { context, state, container, calls, notifications };
}

test('UI exposes execution only in eligible states, renders backend progress and preserves busy guard', () => {
  const h = frontend(); const { context: c, state, container } = h;
  state.plan.status = 'ACCEPTED'; c.renderPlanPaciente(); assert.match(container.innerHTML, /Iniciar tratamiento/);
  state.plan.status = 'IN_PROGRESS'; c.renderPlanPaciente(); assert.match(container.innerHTML, /data-execution-status="IN_PROGRESS"/);
  state.plan.items[0].status = 'IN_PROGRESS'; c.renderPlanPaciente(); assert.match(container.innerHTML, /data-execution-status="COMPLETED"/);
  state.busy = true; c.renderPlanPaciente(); assert.match(container.innerHTML, /data-execution-status="COMPLETED" disabled/);
  state.plan.status = 'COMPLETED'; state.plan.items[0].status = 'COMPLETED'; c.renderPlanPaciente();
  assert.match(container.innerHTML, /Tratamiento completado/); assert(!container.innerHTML.includes('data-execution-item'));
  assert.match(container.innerHTML, /0 de 1 completados/);
});

test('UI prevents duplicate submission, reloads only plan/list, displays clinical failure and releases busy', async () => {
  const h = frontend(); const c = h.context;
  const operation = c.ejecutarPlanPaciente(itemId, 'COMPLETED');
  await c.ejecutarPlanPaciente(itemId, 'COMPLETED'); await operation;
  assert.deepEqual(h.calls, [['item', planId, itemId, 'COMPLETED'], ['reload', planId], 'list']);
  assert.equal(h.state.busy, false); assert.equal(h.state.plan.status, 'COMPLETED');
  c.DentalApi.updateTreatmentPlanItemExecution = async () => { throw Error('Primero registra el tratamiento en el Odontograma'); };
  await c.ejecutarPlanPaciente(itemId, 'COMPLETED');
  assert(h.notifications.some(([message, type]) => type === 'error' && message.includes('Odontograma')));
  assert.equal(h.state.busy, false);
});

test('API execution helpers encode identifiers and send only explicit PATCH status', async () => {
  const api = fs.readFileSync(path.join(__dirname, '../../api.js'), 'utf8');
  const calls = [];
  const c = { request: (...args) => calls.push(args) }; vm.createContext(c);
  vm.runInContext(api.slice(api.indexOf('    function startTreatmentPlanExecution('), api.indexOf('    function createProcedure(')), c);
  c.startTreatmentPlanExecution('id/unsafe'); c.updateTreatmentPlanItemExecution('plan', 'item/unsafe', 'COMPLETED');
  assert.equal(calls[0][0], '/treatment-plans/id%2Funsafe/execution');
  assert.equal(calls[1][0], '/treatment-plans/plan/items/item%2Funsafe/execution');
  for (const [index, status] of ['IN_PROGRESS', 'COMPLETED'].entries()) {
    assert.equal(calls[index][1].method, 'PATCH'); assert.deepEqual(JSON.parse(calls[index][1].body), { status });
  }
  assert.match(api, /startTreatmentPlanExecution,\s+updateTreatmentPlanItemExecution,/);
});
