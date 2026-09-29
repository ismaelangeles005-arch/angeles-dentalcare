const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../citas.html'), 'utf8');
const names = ['fechaMananaLocal', 'setQuickFilter', 'updateQuickFilterUi', 'citasVisibles', 'estadoClase', 'estadoValor', 'estadoEtiqueta', 'minutosDesdeHora', 'sumarMinutosHora', 'rangoHorarioCita', 'renderCitas'];
function extract(name) {
    const start = html.indexOf('        function ' + name + '(');
    assert(start >= 0, name);
    const end = /\n        (?:async )?function /.exec(html.slice(start + 1));
    return html.slice(start, start + 1 + end.index);
}
const source = names.map(extract).join('\n');
const states = ['pendiente', 'confirmada', 'en_consulta', 'completada', 'cancelada', 'no_asistio', 'reprogramada'];
const labels = ['Pendiente', 'Confirmada', 'En consulta', 'Completada', 'Cancelada', 'No asistió', 'Reprogramada'];
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function fixture(role = 'admin', appointments, api = true) {
    const nodes = { listaCitas: { innerHTML: '' }, busquedaCita: { value: '' }, estadoFiltro: { value: '' }, quickFilterCount: {} };
    const ctx = vm.createContext({
        document: { getElementById: id => nodes[id], querySelectorAll: () => [] },
        rol: role, apiActiva: api, doctorActual: 'Doctor QA', quickFilter: 'todas', filtrosUrl: new URLSearchParams(),
        citas: appointments || states.map((estado, index) => ({ id: 'id-' + index, patient_id: 'patient', paciente: 'Paciente ' + index, estado, fecha: '2026-09-29', hora: '23:26', hora_fin: '00:11', doctor: 'Doctor QA', pieza_dental: '1.8', procedimiento: 'Control' })),
        estadosCita: Object.fromEntries(states.map((s, i) => [s, labels[i]])), fechaHoyLocal: () => '2026-09-29',
        DentalRoles: { escapeHtml, normalizeText: v => String(v || '').toLowerCase(), sameDoctor: (a, b) => a === b }
    });
    vm.runInContext(source, ctx);
    ctx.renderCitas();
    return { ctx, nodes, render: () => { ctx.renderCitas(); return nodes.listaCitas.innerHTML; } };
}
test('all seven states and roles retain exactly the permitted existing handlers', () => {
    for (const role of ['admin', 'doctor', 'recepcion']) {
        const { nodes } = fixture(role);
        const cards = nodes.listaCitas.innerHTML.split('<article class="cita">').slice(1);
        assert.equal(cards.length, 7);
        cards.forEach((card, i) => {
            const state = states[i], closed = i >= 3;
            const expected = {
                verDetalleCita: true, confirmarCita: role !== 'doctor' && state === 'pendiente',
                iniciarConsulta: role !== 'recepcion' && i < 2, completarCita: role !== 'recepcion' && i < 3,
                abrirEvolucionClinica: role !== 'recepcion' && i < 4,
                cancelarCita: role !== 'doctor' && !closed, marcarNoAsistio: role !== 'doctor' && i < 2,
                marcarReprogramada: role !== 'doctor' && !closed, eliminarCita: role !== 'doctor'
            };
            for (const [handler, allowed] of Object.entries(expected)) assert.equal(card.split(`${handler}(${i})`).length - 1, allowed ? 1 : 0, `${role}/${state}/${handler}`);
            for (const text of [labels[i], '2026-09-29', '23:26 - 00:11', 'Doctor QA', '1.8', 'Control']) assert(card.includes(text));
        });
    }
});
test('contextual primaries never remove direct transitions or evolution', () => {
    const cards = fixture().nodes.listaCitas.innerHTML.split('<article class="cita">').slice(1);
    for (const [i, primary] of [[0, 'confirmarCita'], [1, 'iniciarConsulta'], [2, 'completarCita'], [3, 'abrirEvolucionClinica']]) {
        const [front, menu] = cards[i].split('<details');
        assert(front.includes(primary + '(' + i + ')'));
        assert(front.includes('verDetalleCita('));
        assert(menu.includes('eliminarCita('));
    }
    assert(cards[0].split('<details')[1].includes('completarCita(0)'));
    assert(cards[0].split('<details')[1].includes('iniciarConsulta(0)'));
    assert(cards[2].split('<details')[0].includes('abrirEvolucionClinica(2)'));
    assert(!fixture('admin', undefined, false).nodes.listaCitas.innerHTML.includes('abrirEvolucionClinica('));
});
test('search, all quick filters, state filter, count and original indices remain coherent', () => {
    const f = fixture();
    f.ctx.citas[1].fecha = '2026-09-30';
    for (const [filter, count] of [['todas', 7], ['hoy', 6], ['manana', 1], ['pendientes', 1], ['confirmadas', 1]]) {
        f.ctx.setQuickFilter(filter);
        assert.equal(f.nodes.quickFilterCount.textContent, `${count} ${count === 1 ? 'resultado' : 'resultados'}`);
    }
    f.nodes.busquedaCita.value = 'Paciente 1';
    assert(f.render().includes('verDetalleCita(1)'));
    f.nodes.estadoFiltro.value = 'pendiente';
    assert(f.render().includes('No hay citas que coincidan'));
    f.ctx.quickFilter = 'todas'; f.nodes.estadoFiltro.value = ''; f.nodes.busquedaCita.value = '';
    f.ctx.filtrosUrl.set('fecha', 'hoy');
    assert(!f.render().includes('verDetalleCita(1)'));
    const doc = fixture('doctor'); doc.ctx.citas[0].doctor = 'Other';
    assert(!doc.render().includes('verDetalleCita(0)'));
});
test('safe dynamic text and native independent disclosures retain accessible action closing', () => {
    const f = fixture(); f.ctx.citas[0].paciente = '<img src=x onerror="bad()">';
    const result = f.render();
    assert(!result.includes('<img')); assert(result.includes('&lt;img'));
    assert.equal((result.match(/<details class="appointment-more"/g) || []).length, 7);
    assert(result.includes('aria-label="Más acciones de la cita de'));
    assert(result.includes("event.key === 'Escape'"));
    assert(result.includes("this.closest('details').open = false"));
    assert(html.includes('.appointment-more summary:focus-visible'));
    assert(html.includes('.appointment-menu .delete-btn { border-top:'));
});
module.exports = { source, fixture, html };
