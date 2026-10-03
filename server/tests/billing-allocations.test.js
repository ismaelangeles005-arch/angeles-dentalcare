const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), actor = id(2), estimateId = id(3), paymentId = id(4), itemId = id(5), key = id(6);
const cents = value => Math.round(Number(value) * 100);
const amount = value => (value / 100).toFixed(2);

// Real handlers + audit helper; deterministic READ COMMITTED simulation with blocking
// key/row locks and transaction-local writes. No database or network is used.
function harness() {
  const state = { estimates: [], payments: [], items: [], allocations: [], reversals: [], audits: [], receipts: new Map() };
  const routes = new Map(), mutexes = new Map(), calls = [], clients = [], options = {};
  let sequence = 100;
  state.estimates.push({ id: estimateId, organization_id: org, total: '1000.00', paid: '1000.00', balance: '0.00', status: 'pagado', deleted_at: null });
  state.payments.push({ id: paymentId, estimate_id: estimateId, organization_id: org, amount: '1000.00', deleted_at: null });
  state.items.push({ id: itemId, estimate_id: estimateId, total: '1000.00', treatment_plan_item_id: null });
  async function lock(client, name) {
    if (client.held.has(name)) return;
    const previous = mutexes.get(name) || Promise.resolve();
    let release;
    mutexes.set(name, new Promise(resolve => { release = resolve; }));
    await previous;
    client.held.set(name, release);
  }
  function end(client) {
    client.active = false;
    for (const release of client.held.values()) release();
    client.held.clear();
  }
  async function query(client, sql, values = []) {
    const q = sql.replace(/\s+/g, ' ').trim(), rows = entries => ({ rows: clone(entries) });
    calls.push({ client: client?.id, q, values: clone(values) });
    if (!client) assert(q.startsWith('SELECT'), 'pool cannot mutate');
    else {
      if (q === 'BEGIN') { client.active = true; return rows([]); }
      assert(client.active, 'dedicated transaction required');
      if (q === 'ROLLBACK') { end(client); return rows([]); }
      if (options.fail && q.startsWith(options.fail)) throw new Error('injected failure');
      if (q === 'COMMIT') {
        for (const field of ['allocations', 'reversals', 'audits']) state[field].push(...clone(client[field]));
        for (const [k, receipt] of client.receipts) state.receipts.set(k, clone(receipt));
        end(client); return rows([]);
      }
    }
    if (q.startsWith('INSERT INTO billing_allocation_operations')) {
      assert(q.includes('ON CONFLICT (organization_id, idempotency_key) DO NOTHING'));
      const k = values[0] + ':' + values[1].toLowerCase();
      await lock(client, 'key:' + k);
      if (state.receipts.has(k)) return rows([]);
      client.receipts.set(k, { request_hash: values[2] });
      return rows([{ idempotency_key: values[1] }]);
    }
    if (q.startsWith('SELECT request_hash')) {
      assert(q.includes('FROM billing_allocation_operations WHERE organization_id = $1 AND idempotency_key = $2'));
      const receipt = state.receipts.get(values[0] + ':' + values[1].toLowerCase());
      return rows(receipt ? [receipt] : []);
    }
    if (q.startsWith('UPDATE billing_allocation_operations')) {
      const k = values[0] + ':' + values[1].toLowerCase();
      assert(client.receipts.has(k));
      Object.assign(client.receipts.get(k), { estimate_id: values[2], response_status: values[3], response_body: JSON.parse(values[4]) });
      return rows([]);
    }
    if (q.startsWith('SELECT estimate_id FROM billing_payments')) {
      assert(q.includes('organization_id = $2 AND deleted_at IS NULL'));
      return rows(state.payments.filter(p => p.id === values[0] && p.organization_id === values[1] && !p.deleted_at));
    }
    if (q.startsWith('SELECT e.*')) {
      assert(q.includes('e.organization_id = $2') && q.includes('e.deleted_at IS NULL'));
      if (client) { assert(q.includes('FOR UPDATE')); await lock(client, 'estimate:' + values[0]); }
      if (values.length > 2) assert(q.includes('p.organization_id = $2') && q.includes('p.doctor_id = $3'));
      return rows(state.estimates.filter(e => e.id === values[0] && e.organization_id === values[1] && !e.deleted_at && !options.denyDoctor));
    }
    if (q.startsWith('SELECT bp.*')) {
      if (!client) {
        assert(q.includes('bp.organization_id = $2') && q.includes('bp.deleted_at IS NULL'));
        return rows(state.payments.filter(p => p.estimate_id === values[0] && p.organization_id === values[1] && !p.deleted_at));
      }
      assert(q.includes('bp.organization_id = $2 AND bp.estimate_id = $3') && q.includes('FOR UPDATE'));
      assert(client.held.has('estimate:' + values[2]));
      await lock(client, 'payment:' + values[0]);
      return rows(state.payments.filter(p => p.id === values[0] && p.organization_id === values[1] && p.estimate_id === values[2] && !p.deleted_at));
    }
    if (q.startsWith('SELECT i.*')) {
      assert(q.includes('JOIN billing_estimates e ON e.id = i.estimate_id'));
      assert(q.includes('e.organization_id = $2 AND e.deleted_at IS NULL FOR UPDATE OF i'));
      assert([...client.held.keys()].some(k => k.startsWith('payment:')));
      await lock(client, 'item:' + values[0]);
      return rows(state.items.filter(i => i.id === values[0] && state.estimates.some(e => e.id === i.estimate_id && e.organization_id === values[1] && !e.deleted_at)));
    }
    if (q.startsWith('SELECT COALESCE(SUM(a.amount)')) {
      assert(client.held.has('payment:' + values[1]) && client.held.has('item:' + values[2]));
      assert(q.includes('a.organization_id = $1') && q.includes('NOT EXISTS'));
      assert(q.includes('r.allocation_id = a.id AND r.organization_id = a.organization_id'));
      const reversals = [...state.reversals, ...client.reversals];
      const active = [...state.allocations, ...client.allocations].filter(a => a.organization_id === values[0] && !reversals.some(r => r.allocation_id === a.id && r.organization_id === a.organization_id));
      return rows([{
        payment_allocated: amount(active.filter(a => a.payment_id === values[1]).reduce((s, a) => s + cents(a.amount), 0)),
        item_allocated: amount(active.filter(a => a.billing_estimate_item_id === values[2]).reduce((s, a) => s + cents(a.amount), 0))
      }]);
    }
    if (q.startsWith('INSERT INTO billing_payment_allocations')) {
      assert(client.held.has('payment:' + values[1]) && client.held.has('item:' + values[2]));
      const row = { id: id(sequence++), organization_id: values[0], payment_id: values[1], billing_estimate_item_id: values[2], amount: values[3], created_at: '2026-10-02T00:00:00Z' };
      client.allocations.push(row); return rows([row]);
    }
    if (q.startsWith('SELECT a.*')) {
      assert(q.includes('a.id = $1 AND a.organization_id = $2'));
      return rows(state.allocations.filter(a => a.id === values[0] && a.organization_id === values[1]));
    }
    if (q.startsWith('SELECT id FROM billing_payment_allocation_reversals')) {
      assert(q.includes('allocation_id = $1 AND organization_id = $2'));
      return rows(state.reversals.filter(r => r.allocation_id === values[0] && r.organization_id === values[1]));
    }
    if (q.startsWith('INSERT INTO billing_payment_allocation_reversals')) {
      const a = state.allocations.find(a => a.id === values[1]);
      assert(client.held.has('payment:' + a.payment_id) && client.held.has('item:' + a.billing_estimate_item_id));
      assert(!state.reversals.some(r => r.allocation_id === a.id));
      const row = { id: id(sequence++), organization_id: values[0], allocation_id: values[1], reason: values[2], created_at: '2026-10-02T00:00:00Z' };
      client.reversals.push(row); return rows([row]);
    }
    if (q.startsWith('INSERT INTO audit_logs')) {
      client.audits.push({ organization: values[0], actor: values[1], action: values[2], entity: values[3], entityId: values[4], payload: values[5] });
      return rows([]);
    }
    if (q.startsWith('SELECT * FROM billing_estimate_items')) return rows(state.items.filter(i => i.estimate_id === values[0]));
    throw new Error('Unexpected SQL: ' + q);
  }
  const db = { query: (sql, values) => query(null, sql, values), pool: { connect: async () => {
    const client = { id: clients.length + 1, active: false, held: new Map(), receipts: new Map(), allocations: [], reversals: [], audits: [] };
    client.query = (sql, values) => query(client, sql, values);
    client.release = () => { assert(!client.active); client.released = true; };
    clients.push(client); return client;
  } } };
  const audit = { module: { exports: {} }, require: () => db };
  vm.runInNewContext(read('server/src/utils/audit.js'), audit);
  const router = { use() {} };
  for (const verb of ['get', 'post', 'patch']) router[verb] = (route, fn) => routes.set(verb + ' ' + route, fn);
  vm.runInNewContext(read('server/src/routes/billing.js'), { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../db') return db;
    if (name === 'node:crypto') return crypto;
    if (name === '../utils/asyncHandler') return fn => fn;
    if (name === '../middleware/auth') return { authenticate() {}, allowRoles() {} };
    if (name === '../utils/audit') return audit.module.exports;
    throw new Error(name);
  } });
  async function request(route, body, params, user = {}, verb = 'post') {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.body = clone(data); return this; } };
    await routes.get(verb + ' ' + route)({ body, params, user: { id: actor, organizationId: org, ...user } }, res);
    return res;
  }
  return { state, calls, clients, options,
    allocate: (body = {}, payment = paymentId, user) => request('/payments/:paymentId/allocations', { billingEstimateItemId: itemId, amount: 300, idempotencyKey: key, ...body }, { paymentId: payment }, user),
    reverse: (allocation, body = {}, user) => request('/allocations/:allocationId/reverse', { reason: 'Correccion de distribucion', idempotencyKey: id(7), ...body }, { allocationId: allocation }, user),
    get: () => request('/estimates/:id', {}, { id: estimateId }, {}, 'get')
  };
}

function invariant(h) {
  const active = h.state.allocations.filter(a => !h.state.reversals.some(r => r.allocation_id === a.id));
  for (const p of h.state.payments) assert(active.filter(a => a.payment_id === p.id).reduce((s, a) => s + cents(a.amount), 0) <= cents(p.amount));
  for (const i of h.state.items) assert(active.filter(a => a.billing_estimate_item_id === i.id).reduce((s, a) => s + cents(a.amount), 0) <= cents(i.total));
  assert(h.clients.every(c => c.released));
}
function noWrites(h) {
  assert.equal(h.state.allocations.length, 0); assert.equal(h.state.reversals.length, 0);
  assert.equal(h.state.audits.length, 0); assert.equal(h.state.receipts.size, 0); invariant(h);
}

test('allocation: valid partial payment, balances, audit and same dedicated client', async () => {
  const h = harness(); h.state.payments[0].amount = '300.00';
  const r = await h.allocate();
  assert.equal(r.code, 201); assert.equal(r.body.allocation.amount, '300.00');
  assert.equal(r.body.payment.remaining, '0.00'); assert.equal(r.body.item.remaining, '700.00');
  assert.equal(h.state.audits.length, 1); assert.equal(h.state.audits[0].actor, actor); assert.equal(h.state.audits[0].organization, org);
  assert.deepEqual(h.state.audits[0].payload, { allocationId: r.body.allocation.id, paymentId, estimateId, billingEstimateItemId: itemId, amount: '300.00' });
  assert(h.calls.every(c => c.client === 1)); assert.equal(h.calls[0].q, 'BEGIN'); assert.equal(h.calls.at(-1).q, 'COMMIT'); invariant(h);
});
for (const invalid of [0, -1, '0.00', null, true, {}, 'bad', '1.001', 'Infinity', '1e2', '10000000000.00']) {
  test('allocation: rejects invalid amount ' + JSON.stringify(invalid), async () => {
    const h = harness(); assert.equal((await h.allocate({ amount: invalid })).code, 400); noWrites(h);
  });
}
for (const [name, body, target] of [
  ['item UUID', { billingEstimateItemId: 'bad' }, paymentId], ['key', { idempotencyKey: 'bad' }, paymentId],
  ['missing key', { idempotencyKey: undefined }, paymentId], ['payment UUID', {}, 'bad'],
  ['untrusted organization', { organization_id: id(99) }, paymentId]
]) test('allocation: rejects ' + name, async () => {
  const h = harness(); assert.equal((await h.allocate(body, target)).code, 400); assert.equal(h.clients.length, 0); noWrites(h);
});
test('allocation: decimal cents are exact without rounding input', async () => {
  const h = harness(); h.state.payments[0].amount = '0.30'; h.state.items[0].total = '0.30';
  await h.allocate({ amount: 0.1 }); const r = await h.allocate({ amount: 0.2, idempotencyKey: id(8) });
  assert.equal(r.code, 201); assert.equal(r.body.item.remaining, '0.00'); assert.equal(r.body.payment.remaining, '0.00'); invariant(h);
});
for (const [name, setup, body, target, user, expected] of [
  ['missing payment', () => {}, {}, id(99), {}, 404],
  ['missing item', () => {}, { billingEstimateItemId: id(99) }, paymentId, {}, 404],
  ['session organization', () => {}, {}, paymentId, { organizationId: id(99) }, 404],
  ['payment organization', h => { h.state.payments[0].organization_id = id(99); }, {}, paymentId, {}, 404],
  ['estimate organization', h => { h.state.estimates[0].organization_id = id(99); }, {}, paymentId, {}, 404],
  ['deleted payment', h => { h.state.payments[0].deleted_at = 'now'; }, {}, paymentId, {}, 404],
  ['deleted estimate', h => { h.state.estimates[0].deleted_at = 'now'; }, {}, paymentId, {}, 404],
  ['cancelled estimate', h => { h.state.estimates[0].status = 'cancelado'; }, {}, paymentId, {}, 409],
  ['doctor access', h => { h.options.denyDoctor = true; }, {}, paymentId, { isDoctor: true, doctorId: id(90) }, 404]
]) test('allocation: ' + name, async () => {
  const h = harness(); setup(h); assert.equal((await h.allocate(body, target, user)).code, expected); noWrites(h);
});
for (const foreign of [false, true]) test('allocation: item of another ' + (foreign ? 'organization' : 'estimate') + ' rejected', async () => {
  const h = harness(); h.state.estimates.push({ ...h.state.estimates[0], id: id(20), organization_id: foreign ? id(21) : org });
  h.state.items[0].estimate_id = id(20);
  assert.equal((await h.allocate()).code, foreign ? 404 : 409); noWrites(h);
});
for (const field of ['payments', 'items']) test('allocation: cannot exceed remaining ' + field, async () => {
  const h = harness(); h.state[field][0][field === 'payments' ? 'amount' : 'total'] = '400.00';
  await h.allocate(); assert.equal((await h.allocate({ amount: 101, idempotencyKey: id(8) })).code, 409);
  assert.equal(h.state.allocations.length, 1); assert.equal(h.state.audits.length, 1); invariant(h);
});
test('allocation: repeated legitimate rows, exact exhaustion then rejection', async () => {
  const h = harness(); await h.allocate();
  const r = await h.allocate({ amount: 700, idempotencyKey: id(8) });
  assert.equal(r.body.payment.remaining, '0.00'); assert.equal(r.body.item.remaining, '0.00');
  assert.equal((await h.allocate({ amount: 0.01, idempotencyKey: id(9) })).code, 409);
  assert.equal(h.state.allocations.length, 2); invariant(h);
});
test('allocation: multiple partial payments for one item reach zero', async () => {
  const h = harness();
  for (const [n, value] of [[4, 300], [8, 200], [9, 500]]) {
    if (n === 4) h.state.payments[0].amount = String(value);
    else h.state.payments.push({ ...h.state.payments[0], id: id(n), amount: String(value) });
    const r = await h.allocate({ amount: value, idempotencyKey: id(n + 30) }, id(n)); assert.equal(r.code, 201);
  }
  h.state.payments.push({ ...h.state.payments[0], id: id(10), amount: '1.00' });
  assert.equal((await h.allocate({ amount: 1, idempotencyKey: id(40) }, id(10))).code, 409);
  assert.equal(h.state.allocations.length, 3); invariant(h);
});
test('allocation: one payment split across items, partial then exact exhaustion', async () => {
  const h = harness(); h.state.items = [];
  for (const [n, value] of [[5, 400], [8, 350], [9, 250]]) {
    h.state.items.push({ id: id(n), estimate_id: estimateId, total: String(value), treatment_plan_item_id: null });
    const r = await h.allocate({ billingEstimateItemId: id(n), amount: value, idempotencyKey: id(n + 30) });
    assert.equal(r.code, 201); assert.equal(r.body.item.remaining, '0.00');
  }
  h.state.items.push({ id: id(10), estimate_id: estimateId, total: '1.00' });
  assert.equal((await h.allocate({ billingEstimateItemId: id(10), amount: 1, idempotencyKey: id(40) })).code, 409);
  assert.equal(h.state.allocations.length, 3); invariant(h);
});
for (const link of [null, id(80)]) test('allocation: manual/clinical link preserved ' + link, async () => {
  const h = harness(); h.state.items[0].treatment_plan_item_id = link;
  const before = clone(h.state.items); assert.equal((await h.allocate()).code, 201);
  assert.deepEqual(h.state.items, before); assert(!h.calls.some(c => c.q.includes('FROM treatment_plan'))); invariant(h);
});
test('allocation: historical payments readable without invented allocations', async () => {
  const h = harness(), before = clone(h.state.payments), r = await h.get();
  assert.deepEqual(r.body.payments, before); assert.deepEqual(h.state.payments, before); noWrites(h);
});
test('allocation/reversal: never double-count or mutate payment, estimate or item', async () => {
  const h = harness(), before = clone({ payments: h.state.payments, estimates: h.state.estimates, items: h.state.items });
  const a = await h.allocate(); await h.reverse(a.body.allocation.id);
  assert.deepEqual({ payments: h.state.payments, estimates: h.state.estimates, items: h.state.items }, before);
  assert(!h.calls.some(c => /^(UPDATE|DELETE|INSERT) (?:INTO |FROM )?billing_(payments|estimates|estimate_items)\b/.test(c.q))); invariant(h);
});
test('reversal: total immutable event returns both capacities and permits reapplication', async () => {
  const h = harness(), a = await h.allocate({ amount: 1000 }), original = clone(a.body.allocation);
  const r = await h.reverse(original.id);
  assert.equal(r.code, 201); assert.equal(r.body.payment.remaining, '1000.00'); assert.equal(r.body.item.remaining, '1000.00');
  assert.deepEqual(h.state.allocations, [original]); assert.equal(h.state.payments[0].amount, '1000.00');
  assert.equal(r.body.reversal.allocation_id, original.id); assert.equal(h.state.audits[1].action, 'reverse_payment_allocation');
  assert.equal(h.state.audits[1].payload.reason, 'Correccion de distribucion'); assert.equal(h.state.audits[1].payload.amount, '1000.00');
  assert.equal((await h.allocate({ amount: 1000, idempotencyKey: id(9) })).code, 201); invariant(h);
});
test('reversal: second key cannot reverse the same allocation twice', async () => {
  const h = harness(), a = await h.allocate(); await h.reverse(a.body.allocation.id);
  assert.equal((await h.reverse(a.body.allocation.id, { idempotencyKey: id(9) })).code, 409);
  assert.equal(h.state.reversals.length, 1); assert.equal(h.state.audits.length, 2); invariant(h);
});
for (const body of [{ amount: 100 }, { amount: 300 }, { amount: null }, { reason: '' }, { reason: ' ' }, { reason: 'x'.repeat(1001) }, { idempotencyKey: 'bad' }]) {
  test('reversal: rejects partial amount/invalid payload ' + JSON.stringify(body).slice(0, 65), async () => {
    const h = harness(), a = await h.allocate();
    assert.equal((await h.reverse(a.body.allocation.id, body)).code, 400);
    assert.equal(h.state.reversals.length, 0); assert.equal(h.state.audits.length, 1); invariant(h);
  });
}
test('reversal: missing/malformed allocation rejected', async () => {
  const h = harness(); assert.equal((await h.reverse(id(99))).code, 404); assert.equal((await h.reverse('bad')).code, 400); noWrites(h);
});
test('reversal: cross-organization denied without disclosure', async () => {
  const h = harness(), a = await h.allocate();
  assert.equal((await h.reverse(a.body.allocation.id, {}, { organizationId: id(99) })).code, 404);
  assert.equal(h.state.reversals.length, 0); assert.equal(h.state.audits.length, 1); invariant(h);
});
test('reversal: revalidates payment, estimate, item and doctor access', async () => {
  for (const change of [h => { h.state.payments[0].organization_id = id(99); }, h => { h.state.items[0].estimate_id = id(99); }, h => { h.options.denyDoctor = true; }]) {
    const h = harness(), a = await h.allocate(); change(h);
    assert.equal((await h.reverse(a.body.allocation.id, {}, { isDoctor: true, doctorId: id(98) })).code, 404);
    assert.equal(h.state.reversals.length, 0); assert.equal(h.state.audits.length, 1); invariant(h);
  }
});
for (const route of ['allocate', 'reverse']) {
  test(route + ': exact retry replays original response, no duplicate event/audit', async () => {
    const h = harness(), a = route === 'reverse' ? await h.allocate() : null;
    const send = () => a ? h.reverse(a.body.allocation.id) : h.allocate();
    const first = await send(); assert.deepEqual((await send()).body, first.body);
    assert.equal(h.state.allocations.length, 1); assert.equal(h.state.reversals.length, a ? 1 : 0);
    assert.equal(h.state.audits.length, a ? 2 : 1); invariant(h);
  });
  test(route + ': same key different payload conflicts', async () => {
    const h = harness(), a = route === 'reverse' ? await h.allocate() : null;
    if (a) { await h.reverse(a.body.allocation.id); assert.equal((await h.reverse(a.body.allocation.id, { reason: 'Different' })).code, 409); }
    else { await h.allocate(); assert.equal((await h.allocate({ amount: 301 })).code, 409); }
    assert.equal(h.state.audits.length, a ? 2 : 1); invariant(h);
  });
  test(route + ': concurrent exact retries commit exactly once', async () => {
    const h = harness(), a = route === 'reverse' ? await h.allocate() : null;
    const send = () => a ? h.reverse(a.body.allocation.id) : h.allocate();
    const [first, second] = await Promise.all([send(), send()]);
    assert.equal(first.code, 201); assert.deepEqual(first.body, second.body);
    assert.equal(h.state.allocations.length, 1); assert.equal(h.state.reversals.length, a ? 1 : 0);
    assert.equal(h.state.audits.length, a ? 2 : 1); invariant(h);
  });
  for (const failure of [route === 'allocate' ? 'INSERT INTO billing_payment_allocations' : 'INSERT INTO billing_payment_allocation_reversals', 'INSERT INTO audit_logs', 'UPDATE billing_allocation_operations', 'COMMIT']) {
    test(route + ': rollback on ' + failure + ', retry works', async () => {
      const h = harness(), a = route === 'reverse' ? await h.allocate() : null;
      const before = clone({ allocations: h.state.allocations, reversals: h.state.reversals, audits: h.state.audits, receipts: [...h.state.receipts] });
      const send = () => a ? h.reverse(a.body.allocation.id) : h.allocate();
      h.options.fail = failure; await assert.rejects(send(), /injected failure/);
      assert.deepEqual({ allocations: h.state.allocations, reversals: h.state.reversals, audits: h.state.audits, receipts: [...h.state.receipts] }, before);
      assert(h.calls.some(c => c.q === 'ROLLBACK')); invariant(h);
      delete h.options.fail; assert.equal((await send()).code, 201); invariant(h);
    });
  }
}
test('allocation: response replay persists after later reversal and rechecks access', async () => {
  const h = harness(), a = await h.allocate(); await h.reverse(a.body.allocation.id);
  assert.deepEqual((await h.allocate()).body, a.body);
  h.options.denyDoctor = true;
  assert.equal((await h.allocate({}, paymentId, { isDoctor: true, doctorId: id(90) })).code, 404);
  assert.equal(h.state.audits.length, 2); invariant(h);
});
test('idempotency: different operation, target or actor conflicts', async () => {
  const h = harness(), a = await h.allocate();
  assert.equal((await h.reverse(a.body.allocation.id, { idempotencyKey: key })).code, 409);
  assert.equal((await h.allocate({}, id(99))).code, 409);
  assert.equal((await h.allocate({}, paymentId, { id: id(99) })).code, 409);
  await h.reverse(a.body.allocation.id);
  assert.equal((await h.reverse(id(99))).code, 409); invariant(h);
});
test('idempotency: keys are organization-scoped and separate from payment receipts', async () => {
  const h = harness(); await h.allocate();
  const other = id(90), p = id(91), i = id(92), e = id(93);
  h.state.estimates.push({ ...h.state.estimates[0], id: e, organization_id: other });
  h.state.payments.push({ ...h.state.payments[0], id: p, estimate_id: e, organization_id: other });
  h.state.items.push({ ...h.state.items[0], id: i, estimate_id: e });
  assert.equal((await h.allocate({ billingEstimateItemId: i }, p, { organizationId: other })).code, 201);
  assert.equal(h.state.receipts.size, 2);
  assert(!h.calls.some(c => /\bbilling_payment_operations\b/.test(c.q))); invariant(h);
});
for (const mode of ['same payment and item', 'same payment different items', 'different payments same item']) {
  test('concurrency: ' + mode + ' cannot overspend', async () => {
    const h = harness(); let p = paymentId, i = itemId;
    if (mode === 'same payment different items') { i = id(8); h.state.items.push({ ...h.state.items[0], id: i }); }
    if (mode === 'different payments same item') { p = id(8); h.state.payments.push({ ...h.state.payments[0], id: p }); }
    const results = await Promise.all([h.allocate({ amount: 700 }), h.allocate({ amount: 700, billingEstimateItemId: i, idempotencyKey: id(9) }, p)]);
    assert.deepEqual(results.map(r => r.code).sort(), [201, 409]);
    assert.equal(h.state.allocations.length, 1); assert.equal(h.state.audits.length, 1); assert.equal(h.state.receipts.size, 1); invariant(h);
  });
}
test('concurrency: sufficient capacity permits both legitimate allocations', async () => {
  const h = harness(); const results = await Promise.all([h.allocate({ amount: 700 }), h.allocate({ amount: 300, idempotencyKey: id(9) })]);
  assert(results.every(r => r.code === 201)); assert.equal(h.state.allocations.length, 2); invariant(h);
});
test('concurrency: two reversal keys cannot restore capacity twice', async () => {
  const h = harness(), a = await h.allocate();
  const results = await Promise.all([h.reverse(a.body.allocation.id), h.reverse(a.body.allocation.id, { idempotencyKey: id(9) })]);
  assert.deepEqual(results.map(r => r.code).sort(), [201, 409]); assert.equal(h.state.reversals.length, 1); assert.equal(h.state.audits.length, 2); invariant(h);
});
test('concurrency: reversal and allocation share lock order and preserve limits', async () => {
  const h = harness(), a = await h.allocate({ amount: 1000 });
  const results = await Promise.all([h.reverse(a.body.allocation.id), h.allocate({ amount: 1000, idempotencyKey: id(9) })]);
  assert.equal(results[0].code, 201); assert([201, 409].includes(results[1].code)); invariant(h);
});
test('migration: isolated additive DDL, exact money, restrictive FKs, indexes, immutable reversal and independent receipts', () => {
  const sql = read('server/database/migration_billing_payment_allocations.sql');
  assert.match(sql, /^BEGIN;/); assert.match(sql, /COMMIT;\s*$/);
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
  assert.match(sql, /amount NUMERIC\(12,2\) NOT NULL CHECK \(amount > 0\)/);
  for (const table of ['billing_payments', 'billing_estimate_items', 'organizations', 'billing_payment_allocations']) assert(sql.includes(`REFERENCES ${table}(id) ON DELETE RESTRICT`));
  assert.match(sql, /allocation_id UUID NOT NULL UNIQUE REFERENCES billing_payment_allocations/);
  assert.match(sql, /PRIMARY KEY \(organization_id, idempotency_key\)/);
  assert.match(sql, /ON billing_payment_allocations \(organization_id, payment_id\)/);
  assert.match(sql, /ON billing_payment_allocations \(organization_id, billing_estimate_item_id\)/);
  assert(!/UNIQUE\s*\(\s*payment_id/i.test(sql));
  assert(!/\b(?:UPDATE|INSERT INTO|DELETE FROM|DROP|ALTER)\b/i.test(sql));
  const manifest = JSON.parse(read('server/database/migrations.json'));
  assert.equal(manifest.at(-1), 'migration_billing_payment_allocations.sql');
  assert.equal(manifest.filter(n => n === manifest.at(-1)).length, 1);
  assert.equal(manifest.at(-2), 'migration_treatment_plan_billing_link.sql');
});
