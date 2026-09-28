const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');

// Shared DOM harness for the two page-local list renderers; no network or database.
function page(admin = false, initial) {
  let records = initial || (admin ? [
    { id: 'self', fullName: 'Maria Lopez', username: 'mlopez', active: true },
    { id: 'other', fullName: 'Juan Perez', username: 'jperez', active: false }
  ] : [
    { id: 'a', name: 'Dental Norte', organizationType: 'CLINIC', active: true },
    { id: 'b', name: 'Dental Sur', organizationType: 'INDEPENDENT', active: false },
    { id: 'c', name: 'Centro', organizationType: 'CLINIC', active: false }
  ]);
  records = records.map(item => Object.freeze({ ...item }));
  const elements = new Map(), calls = [];
  const node = () => ({ children: [], value: '', textContent: '', dataset: {}, hidden: false,
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; },
    addEventListener() {}, reset() {}, reportValidity: () => true, close() {}, showModal() {} });
  const el = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const status = { organizations: { total_organizations: 3, active_organizations: 1, inactive_organizations: 2, clinics: 2, independent: 1 }, platformAdmins: 2 };
  const list = async () => { calls.push('list'); return admin ? { admins: records } : { organizations: records }; };
  const toggle = async (id, active) => { calls.push('status'); records = records.map(item => item.id === id ? Object.freeze({ ...item, active }) : item); };
  const context = {
    document: { getElementById: el, createElement: node, addEventListener() {} },
    window: { addEventListener() {}, confirm: () => true, location: { replace() {} } },
    DentalApi: {
      getCurrentUser: async () => ({ id: 'self', role: 'PLATFORM_SUPER_ADMIN', scope: 'PLATFORM', organizationId: null }),
      getPlatformStatus: async () => status,
      getPlatformOrganizations: list, getPlatformAdmins: list,
      setPlatformOrganizationStatus: toggle, setPlatformAdminStatus: toggle
    }
  };
  vm.runInNewContext(read(admin ? 'platform-admins.js' : 'platform-ui.js'), context);
  return { el, calls, run: () => admin ? context.startPlatformAdmins() : context.startPlatform(),
    rows: () => el(admin ? 'adminRows' : 'organizations').children,
    input(id, value) { el(id).value = value; (el(id).oninput || el(id).onchange)(); },
    records: () => records };
}

test('organization partial/case/trim search, types, statuses, AND filtering and counts stay local', async () => {
  const h = page(); await h.run();
  const metrics = h.el('metrics').children;
  h.input('organizationSearch', '  dEnTaL ');
  assert.equal(h.el('organizationResults').textContent, '2 de 3 organizaciones');
  h.input('organizationTypeFilter', 'CLINIC');
  assert.equal(h.rows()[0].children[0].textContent, 'Dental Norte');
  h.input('organizationStatusFilter', 'ACTIVE'); assert.equal(h.rows().length, 1);
  h.input('organizationTypeFilter', 'INDEPENDENT');
  assert.equal(h.rows()[0].children[0].textContent, 'No hay organizaciones que coincidan con los filtros.');
  h.input('organizationStatusFilter', 'INACTIVE');
  assert.equal(h.rows()[0].children[0].textContent, 'Dental Sur');
  assert.equal(h.el('organizationResults').textContent, '1 de 3 organizaciones');
  assert.equal(h.el('metrics').children, metrics);
  assert.equal(metrics[0].children[0].textContent, 3);
  assert.deepEqual(h.calls, ['list']);
  assert(h.records().every(Object.isFrozen));
});

test('organization true empty differs from filtered empty', async () => {
  const h = page(false, []); await h.run();
  h.input('organizationSearch', 'nothing');
  assert.equal(h.rows()[0].children[0].textContent, 'Sin organizaciones registradas');
  assert.equal(h.el('organizationResults').textContent, '0 de 0 organizaciones');
});

test('organization actions fetch fresh data and preserve all filter selections', async () => {
  const h = page(); await h.run();
  h.input('organizationSearch', 'Norte'); h.input('organizationTypeFilter', 'CLINIC'); h.input('organizationStatusFilter', 'ACTIVE');
  const actions = h.rows()[0].children.at(-1).children;
  assert.equal(actions[0].textContent, 'Ver detalle');
  await actions[2].onclick();
  assert.deepEqual(h.calls, ['list', 'status', 'list']);
  assert.equal(h.el('organizationSearch').value, 'Norte');
  assert.equal(h.el('organizationTypeFilter').value, 'CLINIC');
  assert.equal(h.el('organizationStatusFilter').value, 'ACTIVE');
  assert.equal(h.el('organizationResults').textContent, '0 de 3 organizaciones');
});

test('admin name/username search, statuses, current marker and actions survive filtering', async () => {
  const h = page(true); await h.run();
  h.input('adminSearch', '  MARIA ');
  assert.equal(h.rows()[0].children[0].textContent, 'Maria Lopez · Tú');
  assert.deepEqual(h.rows()[0].children.at(-1).children.map(b => b.textContent), ['Forzar cambio de contraseña']);
  h.input('adminSearch', 'JPERE');
  assert.equal(h.rows()[0].children[0].textContent, 'Juan Perez');
  assert.equal(h.rows()[0].children.at(-1).children.length, 3);
  h.input('adminStatusFilter', 'ACTIVE');
  assert.equal(h.rows().length, 0);
  assert.equal(h.el('adminEmpty').textContent, 'No hay Super Admins que coincidan con los filtros.');
  h.input('adminStatusFilter', 'INACTIVE'); assert.equal(h.rows().length, 1);
  assert.equal(h.el('adminResults').textContent, '1 de 2 Super Admins');
  assert.deepEqual(h.calls, ['list']);
});

test('admin mutation reload preserves filters and true empty is distinct', async () => {
  const h = page(true); await h.run();
  h.input('adminSearch', 'jperez'); h.input('adminStatusFilter', 'INACTIVE');
  await h.rows()[0].children.at(-1).children[0].onclick();
  assert.deepEqual(h.calls, ['list', 'status', 'list']);
  assert.equal(h.el('adminSearch').value, 'jperez');
  assert.equal(h.el('adminStatusFilter').value, 'INACTIVE');
  assert.equal(h.rows().length, 0);
  assert.equal(h.el('message').textContent, 'Cambio guardado.');
  const empty = page(true, []); await empty.run();
  assert.equal(empty.el('adminEmpty').textContent, 'Sin Super Admins registrados.');
});

test('filters have labels, live counts and wrapping/full-width mobile controls without storage or new API calls', () => {
  for (const [htmlFile, jsFile, ids] of [
    ['platform.html', 'platform-ui.js', ['organizationSearch', 'organizationTypeFilter', 'organizationStatusFilter']],
    ['platform-admins.html', 'platform-admins.js', ['adminSearch', 'adminStatusFilter']]
  ]) {
    const html = read(htmlFile), js = read(jsFile);
    for (const id of ids) { assert(html.includes('for="' + id + '"')); assert(html.includes('id="' + id + '"')); }
    assert(html.includes('.list-filters{display:flex;flex-wrap:wrap'));
    assert(html.includes('@media(max-width:699px){.list-filters{flex-direction:column;align-items:stretch}'));
    assert(html.includes('flex:none;width:100%'));
    assert(html.includes('class="result-count" role="status" aria-live="polite"'));
    assert(!/localStorage|sessionStorage|innerHTML|fetch\(/.test(js));
  }
});
