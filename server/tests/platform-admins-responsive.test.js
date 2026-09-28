const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Super Admin responsive table preserves readable columns and labeled mobile cards', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../platform-admins.html'), 'utf8');
  assert(html.includes('white-space:nowrap;word-break:normal;overflow-wrap:normal'));
  assert(html.includes('min-width:1100px'));
  assert(html.includes('overflow-x:auto'));
  const cards = html.split('/* MAELVEN RESPONSIVE ADMINS CARDS */')[1].split('</style>')[0];
  assert(cards.includes('@media(max-width:560px)'));
  assert(cards.includes('thead{display:none}'));
  assert(cards.includes('table{display:block;min-width:0'));
  assert(cards.includes('#adminRows tr{display:block;min-width:0'));
  for (const [index, label] of ['Nombre', 'Usuario', 'Estado', 'Último acceso', 'Cambio obligatorio', 'Creado', 'Acciones'].entries()) {
    assert(cards.includes(`#adminRows td:nth-child(${index + 1})::before{content:"${label}"}`));
    assert(html.includes(`<th>${label}</th>`));
  }
  assert(cards.includes('#adminRows td button{display:block;width:100%'));
  assert(html.includes('width:min(520px,calc(100% - 24px))'));
});
