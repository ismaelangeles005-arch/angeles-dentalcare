const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Super Admin table on desktop and labeled cards below 1100px without horizontal scrolling', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../platform-admins.html'), 'utf8');
  assert(html.includes('table-layout:fixed;width:100%'));
  assert(html.includes('word-break:normal;overflow-wrap:break-word'));
  assert(!html.includes('overflow-x:auto'));
  assert(!html.includes('min-width:1100px'));
  const cards = html.split('/* MAELVEN RESPONSIVE ADMINS CARDS */')[1].split('</style>')[0];
  assert(cards.includes('@media(max-width:1099px)'));
  assert(cards.includes('@media(max-width:699px)'));
  assert(cards.includes('thead{display:none}'));
  assert(cards.includes('table{display:block;min-width:0'));
  assert(cards.includes('#adminRows tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'));
  assert(cards.includes('grid-template-areas:"name name status" "username username username" "login change created" "actions actions actions"'));
  assert(cards.includes('grid-template-areas:"name" "username" "status" "login" "change" "created" "actions"'));
  for (const [index, label] of ['Nombre', 'Usuario', 'Estado', 'Último acceso', 'Cambio obligatorio', 'Creado', 'Acciones'].entries()) {
    assert(cards.includes(`#adminRows td:nth-child(${index + 1})::before{content:"${label}"}`));
    assert(html.includes(`<th>${label}</th>`));
  }
  assert(cards.includes('#adminRows td button{width:100%;margin:0;min-width:0'));
  assert(cards.includes('#adminRows td:nth-child(7){grid-template-columns:minmax(0,1fr)}'));
  const js = fs.readFileSync(path.join(__dirname, '../../platform-admins.js'), 'utf8');
  assert(js.includes("'admin-current'")); assert(js.includes("'admin-active' : 'admin-inactive'"));
  assert(html.includes('width:min(520px,calc(100% - 24px))'));
});
