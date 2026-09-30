const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.resolve(__dirname,'../../citas.html'),'utf8');
function extract(name){const start=html.indexOf('        function '+name+'(');const end=/\n        (?:async )?function /.exec(html.slice(start+1));return html.slice(start,start+1+end.index);}
const source=['estadoClase','estadoValor','estadoEtiqueta','minutosDesdeHora','sumarMinutosHora','rangoHorarioCita','verDetalleCita'].map(extract).join('\n');
function render(cita){
 let element;const close={addEventListener(){},focus(){}},content={focus(){}};
 const ctx=vm.createContext({citas:[cita],estadosCita:{pendiente:'Pendiente'},DentalRoles:{normalizeText:v=>String(v||'').toLowerCase(),escapeHtml:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')},document:{activeElement:null,querySelector:()=>null,createElement:()=>element={innerHTML:'',querySelector:s=>s==='[data-detail-close]'?close:content,addEventListener(){}},body:{appendChild(){}}}});
 vm.runInContext(source,ctx);ctx.verDetalleCita(0);return element?.innerHTML||'';
}
const sample={paciente:'Paciente QA',doctor:'Doctor QA',estado:'pendiente',dental_area:'Operatoria',categoria_procedimiento:'caries',procedimiento:'Procedimiento separado',detalle_clinico:'Motivo independiente',motivo:'Fallback antiguo',fecha:'2026-09-29',hora:'23:26',hora_fin:'00:11',tooth_selections:[{displayCode:'1.8'}]};
test('appointment detail preserves every field, distinct reason/procedure and original time',()=>{
 const out=render(sample);for(const value of ['Paciente QA','Doctor QA','Pendiente','Operatoria','caries','Procedimiento separado','Motivo independiente','2026-09-29','23:26 - 00:11','1.8','Pieza dental'])assert(out.includes(value),value);
 assert(!out.includes('Fallback antiguo'));assert(out.includes('class="estado pendiente"'));
 assert.equal(render(null),'');
});
test('detail retains legacy fallbacks, repeated values and plural/neutral labels',()=>{
 const out=render({...sample,procedimiento:'',detalle_clinico:''});assert.equal(out.split('Fallback antiguo').length-1,2);
 assert(render({...sample,tooth_selections:[{displayCode:'1.8'},{displayCode:'2.1'}]}).includes('Piezas dentales'));
 const legacy=render({...sample,tooth_selections:[],pieza_dental:'18'});assert(legacy.includes('Pieza(s) dental(es)'));assert(legacy.includes('>18</dd>'));
});
test('detail escapes all dynamic values and preserves scoped accessible close handling',()=>{
 const out=render({...sample,paciente:'<img>',doctor:'<script>',detalle_clinico:'<b>',estado:'" onclick="bad',tooth_selections:[{displayCode:'<svg>'}]});
 for(const tag of ['<img>','<script>','<b>','<svg>'])assert(!out.includes(tag));
 assert(out.includes('aria-modal="true"'));assert(out.includes('aria-labelledby="detailTitle"'));
 for(const code of ['previousFocus.focus()', 'event.target === backdrop', 'event.key === "Escape"', 'event.key === "Tab"', 'closeButton.focus()'])assert(source.includes(code));
});
module.exports={source,sample,html};
