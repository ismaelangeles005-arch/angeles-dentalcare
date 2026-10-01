const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const org = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const id = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const actor = { id: 'platform-actor', role: 'PLATFORM_SUPER_ADMIN', scope: 'PLATFORM', organizationId: null };
const res = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} });

function harness(options = {}) {
  const calls = [], modules = {}, routes = {}, guards = {}, params = {};
  const state = { users: [{ id, organization_id: org, role: 'head_admin', username: 'owner', active: true, deleted_at: null,
    pin_hash: null, pin_lookup_hash: null, pin_enabled: false, failed_pin_attempts: 3, pin_locked_until: null,
    password_hash: 'unchanged-password', must_change_password: false, ...options.user }], audits: [] };
  let snapshot;
  const query = async (sql, values = []) => {
    const q = sql.replace(/\s+/g, ' ').trim(); calls.push(q);
    if (q === 'BEGIN') snapshot = structuredClone(state);
    if (q === 'ROLLBACK') Object.assign(state, snapshot);
    if (q.includes('FROM organizations WHERE')) return { rows: values[0] === org ? [{ id: org, active: true, owner_user_id: id }] : [] };
    if (q.startsWith('SELECT id, username')) {
      assert(q.includes('organization_id = $2')); assert(q.includes('FOR UPDATE'));
      assert(q.includes("role <> 'PLATFORM_SUPER_ADMIN'")); assert(q.includes('deleted_at IS NULL'));
      return { rows: state.users.filter(u => u.id === values[0] && u.organization_id === values[1] && !u.deleted_at && u.role !== 'PLATFORM_SUPER_ADMIN') };
    }
    if (q.startsWith('SELECT id FROM users WHERE organization_id')) {
      assert(q.includes('active = true')); assert(q.includes('deleted_at IS NULL'));
      return { rows: state.users.filter(u => u.organization_id === values[0] && u.pin_lookup_hash === values[1] && u.id !== values[2] && u.active && !u.deleted_at) };
    }
    if (q.startsWith('SELECT (pin_hash')) {
      const u = state.users.find(u => u.id === values[0] && u.organization_id === values[1]);
      return { rows: u ? [{ configured: !!u.pin_hash && !!u.pin_lookup_hash }] : [] };
    }
    if (q.includes('FROM users u') && q.includes('u.pin_lookup_hash = $2')) {
      assert(q.includes('o.active = true')); assert(q.includes('u.pin_enabled = true')); assert(q.includes('u.active = true')); assert(q.includes('u.deleted_at IS NULL'));
      return { rows: state.users.filter(u => u.organization_id === values[0] && u.pin_lookup_hash === values[1] && u.pin_enabled && u.active && !u.deleted_at) };
    }
    if (q.startsWith('UPDATE users')) {
      if (options.conflict && (q.includes('SET pin_hash') || q.includes('SET pin_enabled'))) throw Object.assign(new Error('unique'), { code: '23505' });
      if (q.includes('SET pin_hash')) {
        assert(q.includes('organization_id = $5'));
        const u = state.users.find(u => u.id === values[3] && u.organization_id === values[4]);
        Object.assign(u, { pin_hash: values[0], pin_lookup_hash: values[1], pin_enabled: values[2], failed_pin_attempts: 0, pin_locked_until: null });
      } else if (q.includes('SET pin_enabled')) {
        assert(q.includes('organization_id = $3'));
        state.users.find(u => u.id === values[1] && u.organization_id === values[2]).pin_enabled = values[0];
      } else if (q.includes('SET password_hash')) {
        assert(q.includes('organization_id = $3'));
        Object.assign(state.users.find(u => u.id === values[1] && u.organization_id === values[2]), { password_hash: values[0], must_change_password: true });
      } else {
        const u = state.users.find(u => u.id === values[0]);
        if (q.includes('organization_id')) assert.equal(u.organization_id, values[1]);
        if (q.includes('SET must_change_password')) u.must_change_password = true;
        else if (q.includes('failed_pin_attempts = $2')) { u.failed_pin_attempts = values[1]; u.pin_locked_until = values[2] ? new Date(Date.now() + 30000).toISOString() : null; }
        else { u.failed_pin_attempts = 0; u.pin_locked_until = null; }
      }
    }
    if (q.startsWith('INSERT INTO audit_logs')) {
      if (options.auditFail) throw new Error('audit failure');
      assert.equal(values[0], org); assert.equal(values[1], actor.id); state.audits.push(values);
    }
    return { rows: [] };
  };
  const client = { query, release() { calls.push('RELEASE'); } };
  function load(name) {
    if (modules[name]) return modules[name];
    const router = { use(fn) { guards[name].push(fn); }, param(key, fn) { params[key] = fn; } };
    routes[name] = {}; guards[name] = [];
    for (const method of ['get', 'post', 'patch']) router[method] = (url, ...handlers) => { routes[name][method + ' ' + url] = handlers.at(-1); };
    const module = { exports: {} };
    vm.runInNewContext(read(`server/src/routes/${name}.js`), { module, process: { env: { JWT_SECRET: 'test-only-secret' } }, require(dependency) {
      if (dependency === 'express') return { Router: () => router };
      if (dependency === '../db') return { query, pool: { connect: async () => client } };
      if (dependency === '../middleware/auth') return { authenticate() {}, deriveScope: (role, orgId) => role === 'PLATFORM_SUPER_ADMIN' ? (orgId === null ? 'PLATFORM' : null) : (orgId ? 'ORGANIZATION' : null) };
      if (dependency === '../utils/asyncHandler') return fn => fn;
      if (dependency === '../utils/passwordPolicy') return require('../src/utils/passwordPolicy');
      if (dependency === '../utils/audit') return { writeAuditLog() { assert.fail('Nontransactional audit'); } };
      if (dependency === 'bcryptjs') return { hash: async (value, cost) => { assert.equal(cost, 12); return `mock-bcrypt:${value}`; }, compare: async (value, hash) => hash === `mock-bcrypt:${value}` };
      if (dependency === 'crypto') return crypto;
      if (dependency === 'jsonwebtoken') return { sign: () => 'mock-session' };
      if (dependency === 'express-rate-limit') return { rateLimit: () => () => {} };
      if (dependency === '../config/client-ip') return { clientIpRateLimitOptions: () => ({}) };
      if (dependency === './auth') return load('auth');
      throw new Error(dependency);
    }});
    modules[name] = module.exports; return module.exports;
  }
  load('platform'); const auth = load('auth');
  return { state, calls, auth, params,
    async call(suffix, body = {}, user = actor) {
      const r = res(); let allowed = false; guards.platform[1]({ user }, r, () => { allowed = true; });
      if (allowed) await routes.platform[`${suffix === 'pin/unlock' ? 'post' : 'patch'} /organizations/:id/users/:userId/${suffix}`]({ body, user, params: { id: org, userId: id } }, r);
      return r;
    }, async login(pin) { const r = res(); await routes.auth['post /pin-login']({ body: { pin, organizationId: org } }, r); return r; }
  };
}

test('PIN assignment reuses tenant HMAC, bcrypt12, clears lock and audits owner safely', async () => {
  const h = harness({ user: { pin_locked_until: new Date(Date.now() + 60000).toISOString() } });
  const r = await h.call('pin', { pin: '4826' }); assert.equal(r.code, 200);
  const u = h.state.users[0]; assert.equal(u.pin_lookup_hash, h.auth.pinLookupHash('4826', org)); assert.equal(u.pin_hash, 'mock-bcrypt:4826');
  assert.equal(u.pin_enabled, true); assert.equal(u.failed_pin_attempts, 0); assert.equal(u.pin_locked_until, null);
  assert.equal(h.state.audits[0][2], 'platform_set_user_pin'); assert.equal(h.state.audits[0][3].targetUserId, id);
  assert(!JSON.stringify([r.body, h.state.audits]).match(/4826|mock-bcrypt|pin_hash|pin_lookup_hash|password_hash/));
  assert.equal(h.calls.at(-2), 'COMMIT'); assert.equal(h.calls.at(-1), 'RELEASE');
});
test('PIN validation rejects malformed input and invalid enabled state without writes', async () => {
  for (const pin of ['123', '12345', 'abcd', 1234, null, '12 4']) {
    const h = harness(); assert.equal((await h.call('pin', { pin })).code, 400); assert.equal(h.calls.length, 0);
  }
  assert.equal((await harness().call('pin', { pin: '4826', enabled: 'true' })).code, 400);
});
for (const suffix of ['pin', 'pin/status', 'pin/unlock', 'password/force-change']) test(`${suffix}: tenant callers and cross-tenant/deleted/PLATFORM targets denied`, async () => {
  const body = { pin: '4826', enabled: true, required: true };
  const h = harness(); assert.equal((await h.call(suffix, body, { ...actor, role: 'admin', organizationId: org, scope: 'ORGANIZATION' })).code, 403); assert.equal(h.calls.length, 0);
  for (const user of [{ organization_id: 'other' }, { deleted_at: 'yesterday' }, { role: 'PLATFORM_SUPER_ADMIN', organization_id: null }]) {
    const h = harness({ user }); const before = JSON.stringify(h.state); assert.equal((await h.call(suffix, body)).code, 404); assert.equal(JSON.stringify(h.state), before);
  }
});
test('duplicate active-user PIN rejected even when disabled; other organizations remain independent', async () => {
  const h = harness(); h.state.users.push({ id: 'other', organization_id: org, pin_lookup_hash: h.auth.pinLookupHash('4826', org), active: true, pin_enabled: false });
  assert.equal((await h.call('pin', { pin: '4826' })).code, 409); assert.equal(h.state.users[0].pin_hash, null);
  h.state.users[1].organization_id = 'other-org'; assert.equal((await h.call('pin', { pin: '4826' })).code, 200);
});
test('unique index conflicts are safe 409 and rolled back', async () => {
  for (const suffix of ['pin', 'pin/status']) {
    const h = harness({ conflict: true, user: { pin_hash: 'existing', pin_lookup_hash: 'existing' } }); const before = JSON.stringify(h.state);
    assert.equal((await h.call(suffix, { pin: '4826', enabled: true })).code, 409); assert.equal(JSON.stringify(h.state), before);
  }
});
test('replace invalidates old PIN; enabled login succeeds, disabled login fails', async () => {
  const h = harness(); await h.call('pin', { pin: '4826' }); assert.equal((await h.login('4826')).code, 200);
  await h.call('pin', { pin: '5937' }); assert.equal((await h.login('4826')).code, 401); assert.equal((await h.login('5937')).code, 200);
  await h.call('pin/status', { enabled: false }); assert.equal((await h.login('5937')).code, 401);
  await h.call('pin/status', { enabled: true }); assert.equal((await h.login('5937')).code, 200);
});
test('enable needs configured PIN; disable preserves credentials and lock; unlock preserves disabled state', async () => {
  const h = harness(); assert.equal((await h.call('pin/status', { enabled: true })).code, 409);
  await h.call('pin', { pin: '4826' }); let u = h.state.users[0]; u.pin_locked_until = new Date(Date.now() + 60000).toISOString(); u.failed_pin_attempts = 2;
  const hash = u.pin_hash, lookup = u.pin_lookup_hash, lock = u.pin_locked_until;
  assert.equal((await h.login('4826')).code, 423); await h.call('pin/status', { enabled: false });
  assert.equal(u.pin_hash, hash); assert.equal(u.pin_lookup_hash, lookup); assert.equal(u.pin_locked_until, lock);
  await h.call('pin/unlock'); assert.equal(u.failed_pin_attempts, 0); assert.equal(u.pin_locked_until, null); assert.equal(u.pin_enabled, false); assert.equal(u.pin_hash, hash);
  await h.call('pin/status', { enabled: true }); assert.equal((await h.login('4826')).code, 200);
});
test('failed bcrypt attempts retain existing lock semantics and expired lock can authenticate', async () => {
  const h = harness(); await h.call('pin', { pin: '4826' }); const u = h.state.users[0];
  u.pin_hash = 'mismatched-hash'; u.failed_pin_attempts = 4;
  assert.equal((await h.login('4826')).code, 401); assert.equal(u.failed_pin_attempts, 0); assert(u.pin_locked_until);
  assert.equal((await h.login('4826')).code, 423);
  u.pin_locked_until = new Date(Date.now() - 1000).toISOString(); u.pin_hash = 'mock-bcrypt:4826'; assert.equal((await h.login('4826')).code, 200);
});
test('PLATFORM with null organization never matches tenant PIN login', async () => {
  const h = harness({ user: { role: 'PLATFORM_SUPER_ADMIN', organization_id: null, pin_enabled: true, pin_hash: 'mock-bcrypt:4826' } });
  h.state.users[0].pin_lookup_hash = h.auth.pinLookupHash('4826', org); assert.equal((await h.login('4826')).code, 401);
});
test('force change preserves password; false rejected; existing password reset retained', async () => {
  const h = harness(); assert.equal((await h.call('password/force-change', { required: false })).code, 400);
  assert.equal((await h.call('password/force-change')).code, 200); assert.equal(h.state.users[0].must_change_password, true); assert.equal(h.state.users[0].password_hash, 'unchanged-password');
  const r = await h.call('password', { password: 'Temporary123' }); assert.equal(r.code, 200); assert.equal(h.state.users[0].must_change_password, true);
  assert(!JSON.stringify([r.body, h.state.audits]).match(/Temporary123|unchanged-password|mock-bcrypt|password_hash/));
});
for (const suffix of ['pin', 'pin/status', 'pin/unlock', 'password/force-change']) test(`${suffix}: audit failure rolls back entire mutation`, async () => {
  const h = harness({ auditFail: true, user: { pin_hash: 'existing', pin_lookup_hash: 'existing', pin_enabled: true } }); const before = JSON.stringify(h.state);
  assert.equal((await h.call(suffix, { pin: '4826', enabled: false, required: true })).code, 500);
  assert.equal(JSON.stringify(h.state), before); assert(h.calls.includes('ROLLBACK')); assert(!h.calls.includes('COMMIT'));
});
test('safe status projection and masked UI do not expose or persist credentials', () => {
  const route = read('server/src/routes/platform.js'); assert(route.includes('AS pin_locked')); assert(route.includes('failedPinAttempts: u.failed_pin_attempts'));
  const ui = read('platform-users.js'), html = read('platform-organization.html');
  assert(!ui.match(/localStorage|sessionStorage|console\./)); assert(!ui.match(/pin_hash|pin_lookup_hash/));
  assert(html.includes('name="pin" type="password" inputmode="numeric"')); assert(ui.includes('pin.value !== confirmation.value'));
  assert(ui.includes('pin.value = ""; confirmation.value = ""')); assert(ui.includes('user.pinLocked'));
});

test('security UI: conditional actions, PIN confirmation, cancellation and secret cleanup', async () => {
  const elements = new Map(), requests = [];
  const element = () => ({ children: [], value: '', disabled: false, hidden: false, textContent: '',
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
    setAttribute() {}, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; },
    reportValidity() { return true; }, reset() { for (const field of this.fields?.values() || []) field.value = ''; }
  });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  for (const id of ['userForm', 'resetForm', 'pinForm']) {
    const form = get(id); form.fields = new Map(); form.elements = { namedItem(name) { if (!form.fields.has(name)) form.fields.set(name, element()); return form.fields.get(name); } };
  }
  let user = { id, fullName: 'Owner', username: 'owner', role: 'head_admin', active: true, pinConfigured: false, pinEnabled: false, pinLocked: false };
  const context = { document: { getElementById: get, createElement: element }, window: { confirm: () => true }, DentalApi: {
    getPlatformOrganizationUsers: async () => ({ users: [user], allowedRoles: ['admin'], ownerUserId: id, organizationActive: true }),
    setPlatformOrganizationUserPin: async (...args) => { requests.push(args); user = { ...user, pinConfigured: true, pinEnabled: true }; },
    setPlatformOrganizationUserPinStatus: async (...args) => { requests.push(args); },
    unlockPlatformOrganizationUserPin: async (...args) => { requests.push(args); },
    forcePlatformOrganizationUserPasswordChange: async (...args) => { requests.push(args); }
  }};
  vm.runInNewContext(read('platform-users.js') + '\nglobalThis.initialize = initializePlatformUsers;', context);
  context.initialize({ id: org }); get('usersTab').onclick(); await new Promise(resolve => setImmediate(resolve));
  const buttons = () => get('usersRows').children[0].children.at(-1).children.filter(x => typeof x === 'object');
  const action = label => buttons().find(b => b.textContent === label);
  assert(action('Asignar PIN')); assert(!action('Activar PIN')); assert(action('Desactivar').disabled);
  action('Asignar PIN').onclick(); const pin = get('pinForm').elements.namedItem('pin'), confirmation = get('pinForm').elements.namedItem('confirmPin');
  pin.value = '4826'; confirmation.value = '1111'; await get('pinForm').onsubmit({ preventDefault() {} }); assert.equal(requests.length, 0);
  get('cancelPin').onclick(); assert.equal(pin.value, ''); assert.equal(confirmation.value, ''); assert.equal(get('pinDialog').open, false);
  action('Asignar PIN').onclick(); pin.value = confirmation.value = '4826'; await get('pinForm').onsubmit({ preventDefault() {} });
  assert.deepEqual(requests[0], [org, id, '4826', true]); assert.equal(pin.value, ''); assert.equal(confirmation.value, '');
  assert(action('Cambiar PIN')); assert(action('Desactivar PIN')); assert(!action('Desbloquear PIN'));
  user.pinLocked = true; await get('refreshUsers').onclick(); assert(action('Desbloquear PIN'));
  await action('Desbloquear PIN').onclick(); await action('Forzar cambio de contraseña').onclick(); assert.equal(requests.length, 3);
  context.DentalApi.setPlatformOrganizationUserPin = async () => { throw new Error('Simulated failure'); };
  action('Cambiar PIN').onclick(); pin.value = confirmation.value = '4826'; await get('pinForm').onsubmit({ preventDefault() {} });
  assert.equal(pin.value, ''); assert.equal(confirmation.value, ''); assert.equal(get('pinError').textContent, 'Simulated failure');
});

test('PIN login preserves mandatory password change state', async () => {
  const h = harness({ user: { must_change_password: true } });

  assert.equal((await h.call('pin', { pin: '4826' })).code, 200);

  const r = await h.login('4826');

  assert.equal(r.code, 200);
  assert.equal(r.body.user.mustChangePassword, true);
});
