const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const orgId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const actor = { id: 'actor', role: 'PLATFORM_SUPER_ADMIN', scope: 'PLATFORM', organizationId: null };
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function backend(options = {}) {
  const calls = [], routes = {}, guards = [];
  const state = { org: { id: orgId, organization_type: options.type || 'CLINIC', owner_user_id: options.owner ?? null },
    user: { id: userId, organization_id: orgId, role: 'admin', active: true, full_name: 'Candidate', username: 'candidate', password_hash: 'SECRET', ...options.user }, audits: [] };
  let snapshot;
  const client = { release() { calls.push('RELEASE'); }, async query(sql, args = []) {
    const q = sql.replace(/\s+/g, ' ').trim(); calls.push(q);
    if (q === 'BEGIN') snapshot = structuredClone(state);
    if (q === 'ROLLBACK') Object.assign(state, snapshot);
    if (q.includes('FROM organizations')) { assert(q.includes('FOR UPDATE')); return { rows: options.missing ? [] : [{ ...state.org }] }; }
    if (q.includes('FROM users')) {
      assert(q.includes('organization_id = $2')); assert(q.includes('deleted_at IS NULL')); assert(q.includes('active = true')); assert(q.includes("role <> 'PLATFORM_SUPER_ADMIN'")); assert(q.includes('FOR UPDATE'));
      const u = state.user; return { rows: u.id === args[0] && u.organization_id === args[1] && u.active && !u.deleted_at && u.role !== 'PLATFORM_SUPER_ADMIN' ? [u] : [] };
    }
    if (q.startsWith('UPDATE organizations')) { assert(q.includes('updated_at = NOW()')); assert.equal(args[0], orgId); state.org.owner_user_id = args[1]; }
    if (q.startsWith('INSERT INTO audit_logs')) { if (options.auditFail) throw new Error('failure'); state.audits.push(args); }
    return { rows: [] };
  }};
  const router = { use(fn) { guards.push(fn); }, param() {} };
  for (const method of ['get', 'post', 'patch']) router[method] = (url, handler) => { routes[method + url] = handler; };
  vm.runInNewContext(read('server/src/routes/platform.js'), { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../db') return { pool: { connect: async () => client } };
    if (name === '../middleware/auth') return { authenticate() {} };
    if (name === '../utils/asyncHandler') return fn => fn;
    if (name === 'bcryptjs' || name === '../utils/passwordPolicy') return {};
    throw new Error(name);
  }});
  return { state, calls, async call(target = userId, user = actor) {
    const r = response(); let allowed = false; guards[1]({ user }, r, () => { allowed = true; });
    if (allowed) await routes['patch/organizations/:id/owner']({ body: { userId: target }, params: { id: orgId }, user }, r);
    return r;
  }};
}
for (const owner of [null, 'previous-owner', 'unavailable-reference']) test(`owner assignment/replacement repairs ${owner}`, async () => {
  const h = backend({ owner }); const beforeUser = JSON.stringify(h.state.user); const r = await h.call();
  assert.equal(r.code, 200); assert.equal(h.state.org.owner_user_id, userId); assert.equal(JSON.stringify(h.state.user), beforeUser);
  assert.equal(h.state.audits.length, 1); const a = h.state.audits[0]; assert.equal(a[0], orgId); assert.equal(a[1], actor.id); assert.equal(a[2], 'platform_change_organization_owner');
  assert.equal(JSON.stringify(a[3]), JSON.stringify({ previousOwnerUserId: owner, targetUserId: userId }));
  assert.equal(r.body.owner.id, userId); assert(!JSON.stringify(r.body).match(/SECRET|hash|password/)); assert.equal(h.calls.at(-2), 'COMMIT');
});
test('same owner is validated but no mutation or duplicate audit', async () => {
  const h = backend({ owner: userId }); assert.equal((await h.call()).code, 200); assert.equal(h.state.audits.length, 0); assert(!h.calls.some(q => q.startsWith('UPDATE')));
});
for (const user of [{ organization_id: 'other' }, { active: false }, { deleted_at: 'date' }, { role: 'PLATFORM_SUPER_ADMIN' }]) test(`ineligible scoped owner rejected: ${JSON.stringify(user)}`, async () => {
  const h = backend({ user }); const before = JSON.stringify(h.state); assert.equal((await h.call()).code, 404); assert.equal(JSON.stringify(h.state), before);
});
test('invalid UUID, null, missing org, and tenant actor fail safely', async () => {
  for (const value of ['bad', null, 123]) { const h = backend(); assert.equal((await h.call(value)).code, 400); assert.equal(h.calls.length, 0); }
  assert.equal((await backend({ missing: true }).call()).code, 404);
  const h = backend(); assert.equal((await h.call(userId, { ...actor, role: 'admin', scope: 'ORGANIZATION', organizationId: orgId })).code, 403); assert.equal(h.calls.length, 0);
});
test('exact owner role policy for CLINIC and INDEPENDENT', async () => {
  const roles = ['head_admin', 'admin', 'clinic_admin', 'doctor', 'recepcion', 'receptionist', 'assistant', 'cashier', 'owner_doctor', 'independent_assistant'];
  for (const type of ['CLINIC', 'INDEPENDENT']) for (const role of roles) {
    const allowed = (type === 'CLINIC' ? ['head_admin', 'admin', 'clinic_admin'] : ['owner_doctor']).includes(role);
    const h = backend({ type, user: { role } }); assert.equal((await h.call()).code, allowed ? 200 : 409, `${type}/${role}`);
    if (!allowed) assert.equal(h.state.org.owner_user_id, null);
  }
});
test('audit failure restores old owner and leaves no audit or user mutation', async () => {
  const h = backend({ owner: 'old', auditFail: true }), before = JSON.stringify(h.state);
  assert.equal((await h.call()).code, 500); assert.equal(JSON.stringify(h.state), before); assert(h.calls.includes('ROLLBACK')); assert(!h.calls.includes('COMMIT'));
});

function ui(options = {}) {
  const elements = new Map(), calls = [], destinations = [];
  const element = () => ({ hidden: true, textContent: '', value: '', dataset: {}, children: [], disabled: false,
    replaceChildren() { this.children = []; this.value = ''; }, append(option) { this.children.push(option); if (!this.value) this.value = option.value; }, showModal() { this.open = true; }, close() { this.open = false; } });
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const current = { id: 'old', fullName: 'Old', role: 'admin', active: true };
  const detail = { id: orgId, name: 'Org', organizationType: options.type || 'CLINIC', active: true, summary: {}, owner: options.owner === undefined ? current : options.owner, ownerState: options.ownerState || 'AVAILABLE' };
  const users = options.users || [{ id: userId, fullName: 'Candidate', username: 'candidate', role: 'admin', active: true }, current,
    { id: 'inactive', role: 'admin', active: false }, { id: 'doctor', role: 'doctor', active: true }, { id: 'platform', role: 'PLATFORM_SUPER_ADMIN', active: true }];
  const context = { URLSearchParams, document: { getElementById: el, createElement: element, addEventListener() {} },
    window: { location: { search: `?id=${orgId}`, replace: url => destinations.push(url) }, addEventListener() {}, confirm: () => options.confirm !== false },
    initializePlatformUsers() { calls.push('users-refresh'); }, DentalApi: {
      getCurrentUser: async () => { calls.push('me'); return actor; },
      getPlatformOrganization: async () => { calls.push('detail'); return detail; },
      getPlatformOrganizationUsers: async () => { calls.push('candidates'); if (options.loadError) throw options.loadError; return { users, ownerUserId: detail.owner?.id }; },
      setPlatformOrganizationOwner: async (id, target) => { calls.push('save'); assert.equal(id, orgId); assert.equal(target, userId); if (options.saveError) throw options.saveError; detail.owner = users.find(u => u.id === target); }
    }};
  vm.runInNewContext(read('platform-organization.js'), context);
  return { el, calls, destinations, run: () => context.startPlatformOrganization() };
}
test('owner UI states, candidate filtering, confirmation and refreshed detail/users', async () => {
  const h = ui(); await h.run(); assert.equal(h.el('changeOwner').textContent, 'Cambiar propietario');
  await h.el('changeOwner').onclick(); assert.equal(h.el('ownerDialog').open, true); assert.equal(h.el('ownerCandidate').children.length, 1);
  assert(h.el('ownerCandidate').children[0].textContent.includes('Candidate (candidate)')); assert.equal(h.el('saveOwner').disabled, false);
  await h.el('ownerForm').onsubmit({ preventDefault() {} }); assert.equal(h.el('ownerDialog').open, false); assert.equal(h.el('ownerName').textContent, 'Candidate');
  assert.deepEqual(h.calls, ['me', 'detail', 'users-refresh', 'candidates', 'save', 'detail', 'users-refresh']);
  assert.equal(h.el('message').textContent, 'Propietario actualizado correctamente.');
});
test('unassigned/unavailable UI, independent filtering and empty state', async () => {
  for (const ownerState of ['UNASSIGNED', 'UNAVAILABLE']) {
    const h = ui({ owner: null, ownerState, type: 'INDEPENDENT' }); await h.run(); assert.equal(h.el('changeOwner').textContent, 'Asignar propietario');
    await h.el('changeOwner').onclick(); assert.equal(h.el('saveOwner').disabled, true); assert(h.el('ownerDialogMessage').textContent.includes('No hay usuarios'));
  }
  const h = ui({ type: 'INDEPENDENT', users: [{ id: userId, fullName: 'Doctor', username: 'doctor', role: 'owner_doctor', active: true }] });
  await h.run(); await h.el('changeOwner').onclick(); assert.equal(h.el('ownerCandidate').children.length, 1);
});
test('cancel, rejected confirmation and tampered selection cannot mutate owner', async () => {
  const h = ui({ confirm: false }); await h.run(); await h.el('changeOwner').onclick(); await h.el('ownerForm').onsubmit({ preventDefault() {} }); assert(!h.calls.includes('save'));
  h.el('cancelOwner').onclick(); assert.equal(h.el('ownerDialog').open, false);
  const h2 = ui(); await h2.run(); await h2.el('changeOwner').onclick(); h2.el('ownerCandidate').value = 'other-tenant'; await h2.el('ownerForm').onsubmit({ preventDefault() {} }); assert(!h2.calls.includes('save'));
});
test('owner UI errors are safe, keep old owner, and preserve auth redirects', async () => {
  for (const error of [{ status: 409, message: 'SECRET' }, { status: 500, message: 'SECRET' }]) {
    const h = ui({ saveError: error }); await h.run(); await h.el('changeOwner').onclick(); await h.el('ownerForm').onsubmit({ preventDefault() {} });
    assert.equal(h.el('ownerName').textContent, 'Old'); assert(!h.el('ownerDialogMessage').textContent.includes('SECRET'));
  }
  const h = ui({ loadError: new Error('SECRET') }); await h.run(); await h.el('changeOwner').onclick(); assert.equal(h.el('saveOwner').disabled, true); assert(!h.el('ownerDialogMessage').textContent.includes('SECRET'));
  const expired = ui({ loadError: { status: 401 } }); await expired.run(); await expired.el('changeOwner').onclick(); assert.deepEqual(expired.destinations, ['index.html']);
});
test('audit option/projection compatible; no storage authority or responsive removal', () => {
  assert(read('platform-audit.html').includes('value="platform_change_organization_owner"'));
  assert(read('platform-audit.js').includes('platform_change_organization_owner: "Cambiar propietario"'));
  assert(read('server/src/routes/platform.js').includes("target.id::text = l.payload ->> 'targetUserId'"));
  assert(!read('platform-organization.js').match(/localStorage|sessionStorage/));
  assert(read('platform-organization.html').includes('MAELVEN RESPONSIVE ORGANIZATION V1'));
});
