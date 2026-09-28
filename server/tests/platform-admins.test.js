const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const actor = id => ({ id, role: 'PLATFORM_SUPER_ADMIN', scope: 'PLATFORM', organizationId: null });
const account = id => ({ id, username: id === A ? 'actor' : 'second', full_name: 'Admin', role: 'PLATFORM_SUPER_ADMIN', organization_id: null, active: true, deleted_at: null, password_hash: 'SECRET', must_change_password: false });
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function backend(options = {}) {
  const routes = {}, guards = [], params = {}, calls = [], state = { users: [account(A), { ...account(B), ...options.target }], audits: [] };
  let queue = Promise.resolve();
  const eligible = u => u.role === 'PLATFORM_SUPER_ADMIN' && u.organization_id === null && !u.deleted_at;
  const connection = () => {
    let snapshot, unlock;
    return { release() { calls.push('RELEASE'); }, async query(sql, values = []) {
      const q = sql.replace(/\s+/g, ' ').trim(); calls.push(q);
      if (q.includes('pg_advisory_xact_lock') && !unlock) {
        assert.equal(values[0], 'maelven-platform-admin-provision'); const prior = queue; queue = new Promise(resolve => { unlock = resolve; });
        await prior; snapshot = structuredClone(state);
      }
      if (q === 'ROLLBACK') Object.assign(state, snapshot);
      if (q === 'COMMIT' || q === 'ROLLBACK') { unlock?.(); return { rows: [] }; }
      if (q.startsWith('SELECT id, username, full_name')) {
        assert(q.includes("role = 'PLATFORM_SUPER_ADMIN'")); assert(q.includes('organization_id IS NULL')); assert(q.includes('deleted_at IS NULL')); assert(!q.includes('hash'));
        return { rows: state.users.filter(eligible) };
      }
      if (q.startsWith('SELECT id FROM users WHERE LOWER')) return { rows: state.users.filter(u => u.username.toLowerCase() === values[0]) };
      if (q.startsWith('SELECT id FROM users WHERE id') || q.startsWith('SELECT id, active')) {
        assert(q.includes('FOR UPDATE')); assert(q.includes('organization_id IS NULL')); assert(q.includes('deleted_at IS NULL'));
        return { rows: state.users.filter(u => u.id === values[0] && eligible(u) && (!q.includes('active = true') || u.active)).map(u => ({ ...u })) };
      }
      if (q.startsWith('SELECT COUNT')) return { rows: [{ total: options.lastCount ?? state.users.filter(u => eligible(u) && u.active).length }] };
      if (q.startsWith('INSERT INTO users')) {
        assert(q.includes("VALUES (NULL, 'PLATFORM_SUPER_ADMIN'")); assert(q.includes('true, true)')); assert(!q.includes('doctor_id')); assert(!q.includes('pin_'));
        const u = { ...account('new'), username: values[0], full_name: values[1], password_hash: values[2], must_change_password: true }; state.users.push(u); return { rows: [{ ...u }] };
      }
      if (q.startsWith('UPDATE users')) {
        const u = state.users.find(u => u.id === values[0]);
        if (q.includes('SET active')) u.active = values[1];
        else { u.must_change_password = true; if (q.includes('password_hash')) u.password_hash = values[1]; }
      }
      if (q.startsWith('INSERT INTO audit_logs')) {
        assert(q.includes("VALUES (NULL, $1, $2, 'users', $3, $4)"));
        if (options.auditFail) throw new Error('audit failed'); state.audits.push(values);
      }
      return { rows: [] };
    }};
  };
  const router = { use(fn) { guards.push(fn); }, param(key, fn) { params[key] = fn; } };
  for (const method of ['get', 'post', 'patch']) router[method] = (url, fn) => { routes[method + url] = fn; };
  vm.runInNewContext(read('server/src/routes/platform.js'), { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../db') return { pool: { connect: async () => connection() }, query: (...args) => connection().query(...args) };
    if (name === '../middleware/auth') return { authenticate() {} };
    if (name === '../utils/asyncHandler') return fn => fn;
    if (name === '../utils/passwordPolicy') return require('../src/utils/passwordPolicy');
    if (name === 'bcryptjs') return { hash: async (_, cost) => { assert.equal(cost, 12); return 'HASHED'; } };
    throw new Error(name);
  }});
  return { state, calls, params, async call(method, suffix = '', body = {}, who = actor(A), target = B) {
    const r = response(); let ok = false; guards[1]({ user: who }, r, () => { ok = true; });
    if (ok) await routes[method + '/admins' + suffix]({ body, user: who, params: { userId: target } }, r);
    return r;
  }};
}
const payload = { username: 'New.Admin', fullName: 'New Admin', password: 'Temporary123' };
test('admin listing safe and platform-only; guards deny tenant/malformed actor', async () => {
  const h = backend(); h.state.users.push({ ...account('tenant'), organization_id: 'org' }, { ...account('deleted'), deleted_at: 'yesterday' }, { ...account('wrong'), role: 'admin' });
  const r = await h.call('get'); assert.equal(r.body.admins.length, 2); assert(!JSON.stringify(r.body).match(/SECRET|hash|pin_/));
  for (const who of [{ ...actor(A), role: 'admin' }, { ...actor(A), organizationId: 'org' }, { ...actor(A), scope: 'ORGANIZATION' }]) assert.equal((await h.call('get', '', {}, who)).code, 403);
  const bad = response(); h.params.userId({}, bad, () => assert.fail(), 'bad'); assert.equal(bad.code, 400);
});
test('create global admin: invariant fields, lowercase username, mandatory password change, audit', async () => {
  const h = backend(), r = await h.call('post', '', payload); assert.equal(r.code, 201);
  const u = h.state.users.at(-1); assert.equal(u.role, 'PLATFORM_SUPER_ADMIN'); assert.equal(u.organization_id, null); assert(u.active && u.must_change_password); assert.equal(u.username, 'new.admin');
  assert.equal(h.state.audits[0][1], 'platform_create_admin'); assert(!JSON.stringify([r.body, h.state.audits]).match(/Temporary123|HASHED|SECRET/));
});
test('global tenant username conflict and password validation fail closed', async () => {
  const h = backend(); h.state.users.push({ ...account('tenant'), username: 'new.admin', organization_id: 'org', role: 'admin' });
  assert.equal((await h.call('post', '', payload)).code, 409); assert.equal(h.state.audits.length, 0);
  assert.equal((await h.call('post', '', { ...payload, password: 'bad' })).code, 400);
});
test('status transitions and no-op; self and last active protection', async () => {
  const h = backend(); for (const active of [false, false, true]) assert.equal((await h.call('patch', '/:userId/status', { active })).code, 200);
  assert.equal(h.state.audits.length, 2);
  assert.equal((await h.call('patch', '/:userId/status', { active: false }, actor(A), A)).code, 409);
  assert.equal((await backend({ lastCount: 1 }).call('patch', '/:userId/status', { active: false })).code, 409);
});
test('concurrent mutual deactivation serializes; stale actor denied and one admin remains', async () => {
  const h = backend();
  const first = h.call('patch', '/:userId/status', { active: false }, actor(A), B);
  const second = h.call('patch', '/:userId/status', { active: false }, actor(B), A);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(r => r.code).sort(), [200, 403]); assert.equal(h.state.users.filter(u => u.active).length, 1); assert.equal(h.state.audits.length, 1);
  assert(h.calls.indexOf('SELECT pg_advisory_xact_lock(hashtext($1))') < h.calls.findIndex(q => q.includes('FOR UPDATE')));
});
test('password reset/force preserve safe response and forbid self reset or clearing requirement', async () => {
  const h = backend(); assert.equal((await h.call('patch', '/:userId/password', { password: 'Temporary123' }, actor(A), A)).code, 409);
  const r = await h.call('patch', '/:userId/password', { password: 'Temporary123' }); assert.equal(r.code, 200); assert(h.state.users[1].must_change_password);
  assert(!JSON.stringify([r.body, h.state.audits]).match(/Temporary123|HASHED|SECRET/));
  assert.equal((await h.call('patch', '/:userId/password/force-change', { required: false })).code, 400);
  assert.equal((await h.call('patch', '/:userId/password/force-change', { required: true })).code, 200); assert.equal(h.state.users[1].password_hash, 'HASHED');
});
for (const suffix of ['/status', '/password', '/password/force-change']) test(`admin target boundary ${suffix}`, async () => {
  for (const target of [{ deleted_at: 'date' }, { role: 'admin' }, { organization_id: 'org' }]) {
    const h = backend({ target }); assert.equal((await h.call('patch', '/:userId' + suffix, { active: false, password: 'Temporary123', required: true })).code, 404); assert.equal(h.state.audits.length, 0);
  }
});
for (const suffix of ['', '/:userId/status', '/:userId/password', '/:userId/password/force-change']) test(`atomic admin audit failure ${suffix}`, async () => {
  const h = backend({ auditFail: true }), before = JSON.stringify(h.state);
  assert.equal((await h.call(suffix ? 'patch' : 'post', suffix, { ...payload, active: false, required: true })).code, 500); assert.equal(JSON.stringify(h.state), before); assert(!h.calls.includes('COMMIT'));
});

const { provision } = require('../scripts/provision-platform-admin');
test('bootstrap existing username idempotent with additional admins; conflicts fail without touching users', async () => {
  for (const kind of ['valid', 'tenant', 'malformed', 'missing']) {
    const calls = []; const configured = { ...account(A), ...(kind === 'tenant' ? { role: 'admin', organization_id: 'org' } : kind === 'malformed' ? { organization_id: 'org' } : {}) };
    const client = { release() {}, async query(sql) { const q = sql.replace(/\s+/g, ' ').trim(); calls.push(q);
      if (q.includes('WHERE LOWER(username)')) return { rows: kind === 'missing' ? [] : [configured] };
      if (q.includes("WHERE role = 'PLATFORM_SUPER_ADMIN'")) return { rows: [configured, account(B)] };
      assert(!q.match(/INSERT|UPDATE|DELETE/)); return { rows: [] };
    }};
    const run = () => provision({ username: 'actor', password: 'NotUsed123!' }, { connect: async () => client }, () => assert.fail());
    if (kind === 'valid') { assert.equal((await run()).created, false); assert(calls.includes('COMMIT')); }
    else { await assert.rejects(run); assert(calls.includes('ROLLBACK')); }
  }
});
test('global audit join is explicit, tenant join retained, public assets and labels registered', () => {
  const route = read('server/src/routes/platform.js');
  assert(route.includes("l.organization_id IS NULL AND target.organization_id IS NULL AND target.role = 'PLATFORM_SUPER_ADMIN'")); assert(route.includes('target.organization_id = l.organization_id'));
  const files = require('../src/config/public-web-files'); for (const f of ['platform-admins.html', 'platform-admins.js']) assert(files.includes(f));
  assert(read('platform-admins.html').includes('MAELVEN RESPONSIVE ADMINS V1')); assert(read('platform.html').includes('href="platform-admins.html"'));
  assert(!read('platform-admins.js').match(/localStorage|sessionStorage|innerHTML/));
  for (const a of ['create_admin', 'activate_admin', 'deactivate_admin', 'reset_admin_password', 'force_admin_password_change']) { assert(read('platform-audit.html').includes('platform_' + a)); assert(read('platform-audit.js').includes('platform_' + a)); }
});

function ui(options = {}) {
  const elements = new Map(), calls = [], redirects = [];
  const element = () => ({ children: [], textContent: '', value: '', hidden: true, disabled: false, dataset: {},
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, showModal() { this.open = true; }, close() { this.open = false; }, reportValidity() { return true; } });
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  el('adminForm').reset = () => { for (const name of ['password', 'username', 'fullName']) el(name).value = ''; };
  const context = { document: { getElementById: el, createElement: element, addEventListener() {} }, window: { addEventListener() {}, confirm: () => true, location: { replace: url => redirects.push(url) } }, DentalApi: {
    getCurrentUser: async () => { calls.push('me'); if (options.authError) throw options.authError; return options.actor || actor(A); },
    getPlatformAdmins: async () => { calls.push('list'); if (options.listError) throw options.listError; return { admins: [{ id: A, username: 'actor', fullName: '<script>name</script>', active: true }, { id: B, username: 'other', fullName: 'Other', active: true }] }; },
    createPlatformAdmin: async payload => { calls.push(['create', { ...payload }]); if (options.saveError) throw options.saveError; },
    resetPlatformAdminPassword: async (id, password) => { calls.push(['reset', id, password]); if (options.saveError) throw options.saveError; },
    forcePlatformAdminPasswordChange: async id => { calls.push(['force', id]); },
    setPlatformAdminStatus: async (id, active) => { calls.push(['status', id, active]); }
  }};
  vm.runInNewContext(read('platform-admins.js'), context);
  return { el, calls, redirects, run: () => context.startPlatformAdmins(), buttons(index) { return el('adminRows').children[index].children.at(-1).children; } };
}
test('admin UI verifies session before data, tenant/malformed/password-change redirects', async () => {
  for (const [user, destination] of [[{ ...actor(A), role: 'admin', scope: 'ORGANIZATION', organizationId: 'org' }, 'dashboard.html'], [{ ...actor(A), organizationId: 'org' }, 'index.html'], [{ ...actor(A), mustChangePassword: true }, 'cambiar-password.html']]) {
    const h = ui({ actor: user }); await h.run(); assert.deepEqual(h.calls, ['me']); assert.equal(h.redirects[0], destination);
  }
  const h = ui({ authError: { status: 401 } }); await h.run(); assert.deepEqual(h.calls, ['me']); assert.equal(h.redirects[0], 'index.html');
});
test('admin UI safe text, current marker/self protections, create/reset/force and cleanup', async () => {
  const h = ui(); await h.run(); assert.deepEqual(h.calls, ['me', 'list']);
  assert.equal(h.el('adminRows').children[0].children[0].textContent, '<script>name</script> · Tú');
  assert.deepEqual(h.buttons(0).map(b => b.textContent), ['Forzar cambio de contraseña']);
  h.el('createAdmin').onclick(); assert.equal(h.el('adminDialog').open, true); h.el('fullName').value = 'New'; h.el('username').value = 'new'; h.el('password').value = 'Temporary123';
  await h.el('adminForm').onsubmit({ preventDefault() {} }); assert(h.calls.some(c => c[0] === 'create')); assert.equal(h.el('password').value, ''); assert.equal(h.el('adminDialog').open, false);
  h.buttons(1).find(b => b.textContent === 'Resetear contraseña').onclick(); assert(h.el('fullName').disabled); h.el('password').value = 'Temporary456';
  await h.el('adminForm').onsubmit({ preventDefault() {} }); assert(h.calls.some(c => c[0] === 'reset' && c[1] === B)); assert.equal(h.el('password').value, '');
  await h.buttons(1).find(b => b.textContent === 'Forzar cambio de contraseña').onclick(); assert(h.calls.some(c => c[0] === 'force' && c[1] === B));
  await h.buttons(0)[0].onclick(); assert.equal(h.redirects.at(-1), 'cambiar-password.html');
});
test('admin UI safe errors, reset failure and cancellation clear temporary password', async () => {
  const h = ui({ saveError: { status: 500, message: 'SECRET SQL' } }); await h.run(); h.buttons(1).find(b => b.textContent === 'Resetear contraseña').onclick(); h.el('password').value = 'Temporary123';
  await h.el('adminForm').onsubmit({ preventDefault() {} }); assert.equal(h.el('password').value, ''); assert(!h.el('formError').textContent.includes('SECRET'));
  h.el('password').value = 'new'; h.el('cancelAdmin').onclick(); assert.equal(h.el('password').value, ''); assert.equal(h.el('adminDialog').open, false);
  const failed = ui({ listError: new Error('SECRET SQL') }); await failed.run(); assert(!failed.el('message').textContent.includes('SECRET')); assert.equal(failed.el('refresh').disabled, false);
});
