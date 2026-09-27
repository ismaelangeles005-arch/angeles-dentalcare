const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/routes/platform.js'), 'utf8');
const orgId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const actor = { id: 'actor', role: 'PLATFORM_SUPER_ADMIN', scope: 'PLATFORM', organizationId: null };
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const payload = role => ({ username: 'Test.User', fullName: 'Test User', password: 'Temporary123', role, doctorSpecialty: 'General' });

function harness(options = {}) {
  const routes = {}, guards = [], params = {}, calls = [];
  const state = { org: { id: orgId, organization_type: options.type || 'CLINIC', active: options.active !== false, owner_user_id: options.owner ? userId : 'owner' }, users: [], doctors: [], audits: [] };
  if (options.user) state.users.push({ id: userId, organization_id: orgId, username: 'existing', role: 'admin', active: true, ...options.user });
  let snapshot;
  const client = { release() { calls.push('RELEASE'); }, async query(sql, values = []) {
    const q = sql.replace(/\s+/g, ' ').trim(); calls.push(q);
    if (q === 'BEGIN') snapshot = structuredClone(state);
    if (q === 'ROLLBACK') Object.assign(state, snapshot);
    if (options.fail && q.startsWith(options.fail)) throw new Error('simulated');
    if (q.includes('FROM organizations WHERE')) return { rows: values[0] === orgId ? [state.org] : [] };
    if (q.includes('FROM users u LEFT JOIN doctors')) {
      assert(q.includes('u.organization_id = $1')); assert(q.includes('u.deleted_at IS NULL')); assert(q.includes("u.role <> 'PLATFORM_SUPER_ADMIN'"));
      return { rows: state.users.filter(u => u.organization_id === values[0] && !u.deleted_at && u.role !== 'PLATFORM_SUPER_ADMIN') };
    }
    if (q.startsWith('SELECT id FROM users WHERE LOWER')) return { rows: options.duplicate ? [{ id: 'duplicate' }] : [] };
    if (q.startsWith('SELECT id, username')) {
      assert(q.includes('FOR UPDATE')); assert(q.includes('organization_id = $2')); assert(q.includes('deleted_at IS NULL'));
      return { rows: state.users.filter(u => u.id === values[0] && u.organization_id === values[1] && !u.deleted_at && u.role !== 'PLATFORM_SUPER_ADMIN') };
    }
    if (q.startsWith('SELECT id FROM doctors')) return { rows: options.badDoctor ? [] : [{ id: 'doctor' }] };
    if (q.startsWith('SELECT id FROM users WHERE doctor_id')) return { rows: options.sharedDoctor ? [{ id: 'other' }] : [] };
    if (q.startsWith('INSERT INTO doctors')) { state.doctors.push({ id: 'doctor', organization_id: values[0] }); return { rows: [{ id: 'doctor' }] }; }
    if (q.startsWith('INSERT INTO users')) {
      assert(q.includes('must_change_password')); assert(q.includes('$6, true)'));
      state.users.push({ id: userId, organization_id: values[0], username: values[1], role: values[4], doctor_id: values[5] }); return { rows: [{ id: userId }] };
    }
    if (q.startsWith('UPDATE users')) {
      assert(q.includes('organization_id = $3')); const u = state.users.find(u => u.id === values[1] && u.organization_id === values[2]);
      if (q.includes('password_hash')) { assert(q.includes('must_change_password = true')); u.must_change_password = true; u.password_hash = values[0]; }
      else u.active = values[0];
    }
    if (q.startsWith('INSERT INTO audit_logs')) state.audits.push(values);
    return { rows: [] };
  }};
  const router = { use(fn) { guards.push(fn); }, param(name, fn) { params[name] = fn; } };
  for (const method of ['get', 'post', 'patch']) router[method] = (url, fn) => { routes[method + ' ' + url] = fn; };
  vm.runInNewContext(source, { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../db') return { query: client.query, pool: { connect: async () => client } };
    if (name === '../middleware/auth') return { authenticate() {} };
    if (name === '../utils/asyncHandler') return fn => fn;
    if (name === '../utils/passwordPolicy') return require('../src/utils/passwordPolicy');
    if (name === 'bcryptjs') return { hash: async (_, cost) => { assert.equal(cost, 12); return 'fake-hash'; } };
    throw new Error(name);
  }});
  return { state, calls, params, async call(method, suffix = '', body = {}, user = actor, id = orgId) {
    const res = response(); let allowed = false; guards[1]({ user }, res, () => { allowed = true; });
    if (allowed) await routes[`${method} /organizations/:id/users${suffix}`]({ body, user, params: { id, userId } }, res);
    return res;
  }};
}

test('platform user list: scoped, deleted/platform excluded, safe fields only', async () => {
  const h = harness({ user: { password_hash: 'secret', pin_hash: 'secret', pin_lookup_hash: 'secret', pin_configured: true, pin_enabled: true } });
  h.state.users.push({ organization_id: 'other' }, { organization_id: orgId, deleted_at: 'yesterday' }, { organization_id: orgId, role: 'PLATFORM_SUPER_ADMIN' });
  const r = await h.call('get'); assert.equal(r.code, 200); assert.equal(r.body.users.length, 1);
  assert.equal(r.body.users[0].pinConfigured, true); assert(!JSON.stringify(r.body).includes('secret'));
  assert(!JSON.stringify(r.body).match(/password_hash|pin_hash|pin_lookup_hash/));
  assert.equal((await h.call('get', '', {}, { ...actor, scope: 'ORGANIZATION', role: 'admin', organizationId: orgId })).code, 403);
  assert.equal((await h.call('get', '', {}, actor, 'missing')).code, 404);
});
test('both route identifiers reject malformed UUIDs', () => {
  const h = harness(); for (const key of ['id', 'userId']) { const r = response(); h.params[key]({}, r, () => assert.fail(), 'invalid'); assert.equal(r.code, 400); }
});
for (const [type, role] of [['CLINIC', 'admin'], ['CLINIC', 'doctor'], ['INDEPENDENT', 'owner_doctor'], ['INDEPENDENT', 'independent_assistant']]) test(`create ${type} ${role} atomically with audited session actor`, async () => {
  const h = harness({ type }), r = await h.call('post', '', payload(role));
  assert.equal(r.code, 201); assert.equal(r.body.username, 'test.user'); assert.equal(r.body.mustChangePassword, true);
  assert.equal(h.state.users[0].organization_id, orgId); assert.equal(h.state.doctors.length, ['doctor', 'owner_doctor'].includes(role) ? 1 : 0);
  if (h.state.doctors.length) assert.equal(h.state.doctors[0].organization_id, orgId);
  assert.equal(h.state.audits[0][0], orgId); assert.equal(h.state.audits[0][1], actor.id); assert.equal(h.state.audits[0][2], 'platform_create_user');
  assert(!JSON.stringify([r.body, h.state.audits]).includes('Temporary123')); assert(!JSON.stringify(r.body).includes('hash'));
  assert.equal(h.calls.at(-2), 'COMMIT'); assert.equal(h.calls.at(-1), 'RELEASE');
});
test('organization-specific policy, PLATFORM, inactive org, duplicate and invalid input rejected', async () => {
  for (const [options, role, code] of [[{}, 'owner_doctor', 400], [{ type: 'INDEPENDENT' }, 'admin', 400], [{}, 'PLATFORM_SUPER_ADMIN', 400], [{ active: false }, 'admin', 409], [{ duplicate: true }, 'doctor', 409]]) {
    const h = harness(options); assert.equal((await h.call('post', '', payload(role))).code, code); assert.equal(h.state.users.length, 0); assert.equal(h.state.doctors.length, 0); assert.equal(h.state.audits.length, 0); assert(h.calls.includes('ROLLBACK'));
  }
  for (const change of [{ password: 'bad' }, { username: 'bad user' }, { doctorSpecialty: '' }]) {
    const h = harness(); assert.equal((await h.call('post', '', { ...payload('doctor'), ...change })).code, 400); assert.equal(h.calls.length, 0);
  }
});
for (const table of ['doctors', 'users', 'audit_logs']) test(`create failure at ${table} rolls back doctor, user and audit`, async () => {
  const h = harness({ fail: `INSERT INTO ${table}` }); assert.equal((await h.call('post', '', payload('doctor'))).code, 500);
  assert.equal(h.state.users.length, 0); assert.equal(h.state.doctors.length, 0); assert.equal(h.state.audits.length, 0); assert(h.calls.includes('ROLLBACK'));
});
test('status transitions and no-op; owner cannot be deactivated', async () => {
  const h = harness({ user: {} }); for (const active of [false, false, true]) assert.equal((await h.call('patch', '/:userId/status', { active })).code, 200);
  assert.equal(h.state.users[0].active, true); assert.equal(h.state.audits.length, 2);
  assert.equal(h.state.audits[0][2], 'platform_deactivate_user'); assert.equal(h.state.audits[1][2], 'platform_activate_user');
  const owner = harness({ owner: true, user: {} }); assert.equal((await owner.call('patch', '/:userId/status', { active: false })).code, 409); assert.equal(owner.state.users[0].active, true); assert.equal(owner.state.audits.length, 0);
});
for (const suffix of ['status', 'password']) test(`${suffix}: cross-tenant/deleted/platform denied; audit failure rolls back`, async () => {
  const body = suffix === 'status' ? { active: false } : { password: 'Temporary123' };
  for (const user of [{ organization_id: 'other' }, { deleted_at: 'yesterday' }, { role: 'PLATFORM_SUPER_ADMIN' }]) {
    const h = harness({ user }); assert.equal((await h.call('patch', `/:userId/${suffix}`, body)).code, 404); assert.equal(h.state.audits.length, 0);
  }
  const h = harness({ user: {}, fail: 'INSERT INTO audit_logs' }); const before = JSON.stringify(h.state);
  assert.equal((await h.call('patch', `/:userId/${suffix}`, body)).code, 500); assert.equal(JSON.stringify(h.state), before);
});
test('reset forces password change, returns no credentials and never audits password', async () => {
  const h = harness({ user: {} }), r = await h.call('patch', '/:userId/password', { password: 'Temporary123' });
  assert.equal(r.code, 200); assert.equal(h.state.users[0].must_change_password, true); assert.equal(r.body.mustChangePassword, true);
  assert.equal(h.state.audits[0][2], 'platform_reset_user_password'); assert(!JSON.stringify([r.body, h.state.audits]).match(/Temporary123|fake-hash|password_hash/));
  assert.equal((await h.call('patch', '/:userId/password', { password: 'bad' })).code, 400);
});
test('doctor status scoped and shared/broken profile fails safely', async () => {
  const h = harness({ user: { role: 'doctor', doctor_id: 'doctor' } }); assert.equal((await h.call('patch', '/:userId/status', { active: false })).code, 200);
  assert(h.calls.some(q => q.startsWith('UPDATE doctors') && q.includes('organization_id = $3')));
  for (const flag of ['sharedDoctor', 'badDoctor']) {
    const h = harness({ [flag]: true, user: { role: 'doctor', doctor_id: 'doctor' } }); assert.equal((await h.call('patch', '/:userId/status', { active: false })).code, 409); assert.equal(h.state.users[0].active, true);
  }
});
test('user UI uses allowedRoles from API, safe DOM, no PIN mutations or clinical APIs', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../../platform-users.js'), 'utf8');
  assert(ui.includes('allowedRoles')); assert(!ui.includes('innerHTML')); assert(!ui.includes('localStorage'));
  for (const forbidden of ['getPatients', 'getAppointments', 'setUserPin', 'deleteUser']) assert(!ui.includes(forbidden));
});
