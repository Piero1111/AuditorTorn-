// ==UserScript==
// @name         AuditorTorn
// @namespace    torn-pda-auditor
// @version      1.1.0
// @description  Auditor de precios Torn/W3B
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/Piero1111/AuditorTorn-/main/AuditorTorn.user.js
// @downloadURL  https://raw.githubusercontent.com/Piero1111/AuditorTorn-/main/AuditorTorn.user.js
// ==/UserScript==

(function(){
'use strict';

const BASE='https://weav3r.dev/api';
const FRESH=60*60*1000;
const PASSIVE=15*60*1000;

/*
 Identifica la metodología de cálculo usada.
 Subimos este número cada vez que cambia de
 forma relevante cómo se obtienen los datos
 o cómo se calcula el valor real, para que
 las auditorías guardadas con una versión
 anterior se traten como caducadas y se
 vuelvan a calcular en vez de reutilizarse.

 v5: el mercado ya no se lee de un agregador
 de terceros (weav3r), sino directo de la API
 oficial de Torn (/market/{id}?selections=
 itemmarket). Además, calculate() ahora usa
 la mediana del último día con histórico
 (hist[id].daily) en vez del snapshot crudo,
 cayendo al snapshot solo si todavía no hay
 suficiente histórico.
*/
const ALGO_VERSION=5;

const K={
 api:'at_api',
 uid:'at_uid',
 items:'at_items',
 hist:'at_hist',
 last:'at_last',
 pos:'at_pos'
};

let api='',uid='';
let items={},hist={},last={};
let homeSelected=null;
let auditSelected=null;
let busy=new Set();
let UI=null;

/*
 Última interacción del usuario (búsqueda o
 selección) en cualquiera de las dos pantallas.
 El auditor pasivo respeta esta marca para no
 competir por la API mientras el usuario está
 buscando activamente.
*/
let lastInteraction=0;

function touch(){
 lastInteraction=Date.now();
}

const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function get(k,d){
 try{return await GM_getValue(k,d)}catch{return d}
}

async function set(k,v){
 try{await GM_setValue(k,v)}catch{}
}

async function load(){
 api=await get(K.api,'');
 uid=await get(K.uid,'');
 try{items=JSON.parse(await get(K.items,'{}'))||{}}catch{items={}}
 try{hist=JSON.parse(await get(K.hist,'{}'))||{}}catch{hist={}}
 try{last=JSON.parse(await get(K.last,'{}'))||{}}catch{last={}}

 /*
  Migración: el formato viejo de hist[id] era
  un array plano de observaciones. El nuevo es
  {raw, daily, _rolledTo}. Si encontramos el
  formato viejo, lo envolvemos sin perder datos.
 */
 for(const id of Object.keys(hist)){
  if(Array.isArray(hist[id])){
   hist[id]={
    raw:hist[id],
    daily:[],
    _rolledTo:0
   };
  }
 }
}

async function save(){
 await set(K.items,JSON.stringify(items));
 await set(K.hist,JSON.stringify(hist));
 await set(K.last,JSON.stringify(last));
}

function money(n){
 return '$'+Math.round(Number(n)||0).toLocaleString('en-US');
}

function esc(s){
 return String(s??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;',
  '"':'&quot;',"'":'&#39;'
 }[c]));
}

function percent(n){
 return Number(n).toFixed(1)+'%';
}

async function request(url){
 if(typeof PDA_httpGet!=='function')
  throw Error('PDA_httpGet no está disponible');

 const r=await PDA_httpGet(url);

 if(!r||typeof r.responseText!=='string')
  throw Error('Respuesta vacía');

 return JSON.parse(r.responseText);
}

/* ---------- CATÁLOGO TORN ---------- */

/*
 catalog[id] = {name, mv}
 mv viene de market_value, que es el mismo
 valor oficial que Torn usa como "MV" del item.
*/
let catalog={};

async function loadCatalog(){
 if(Object.keys(catalog).length)return;

 if(!api)
  throw Error('Falta API Key');

 const d=await request(
  'https://api.torn.com/torn/?selections=items&key='+api
 );

 if(d.error)
  throw Error(d.error.error);

 for(const [id,x] of Object.entries(d.items||{}))
  catalog[id]={
   name:x.name,
   mv:Number(x.market_value||0)
  };
}

/*
 Devuelve todas las coincidencias (hasta 8),
 para poder mostrar una lista de sugerencias
 mientras el usuario escribe, en vez de exigir
 una coincidencia única.
*/
function collectMatches(q){

 q=q.trim().toLowerCase();

 if(!q)return [];

 const seen=new Set();
 const out=[];

 function add(id,name){
  if(seen.has(id))return;
  seen.add(id);
  out.push({id,name});
 }

 if(/^\d+$/.test(q)&&catalog[q])
  add(q,catalog[q].name);

 for(const [id,x] of Object.entries(items)){

  const name=String(x.name||'');

  if(name.toLowerCase().includes(q))
   add(id,name);
 }

 for(const [id,x] of Object.entries(catalog)){

  if(String(x.name).toLowerCase().includes(q))
   add(id,x.name);
 }

 return out.slice(0,8);
}

function renderSuggestions(container,matches,onPick){

 container.innerHTML=
  '<div class="suggestions">'+
  matches.map(m=>
   '<div class="suggestion" data-id="'+
   esc(m.id)+
   '" data-name="'+
   esc(m.name)+
   '">'+
   esc(m.name)+
   '</div>'
  ).join('')+
  '</div>';

 container.querySelectorAll(
  '.suggestion'
 ).forEach(row=>{

  row.onclick=()=>onPick(
   row.dataset.id,
   row.dataset.name
  );
 });
}

/* ---------- W3B ---------- */

async function syncW3B(){
 if(!uid)
  throw Error('Falta Torn ID');

 const d=await request(
  BASE+'/pricelist/'+uid
 );

 if(!Array.isArray(d))
  throw Error(d?.message||'Respuesta W3B inválida');

 let count=0;

 for(const x of d){
  const id=String(x.itemId);

  items[id]={
   ...(items[id]||{}),
   name:x.name,
   buyPrice:Number(x.buyPrice)
  };

  count++;
 }

 await save();

 return count;
}

/* ---------- MERCADO (API oficial de Torn) ---------- */

async function getMarket(id){

 if(!api)
  throw Error('Falta API Key');

 /*
  itemmarket solo existe en la API v2 de Torn,
  no en v1 (de ahí el error "This selection is
  only available in API v2" que tirar la v1).
 */
 const d=await request(
  'https://api.torn.com/v2/market/'+id+
  '/itemmarket?key='+api
 );

 if(d.error)
  throw Error(d.error.error);

 const im=d.itemmarket;

 if(!im||!Array.isArray(im.listings))
  throw Error('Mercado inválido');

 return im;
}

/* ---------- VALOR REAL ----------

No todos los listings pesan igual: uno con
433 unidades representa mucha más oferta real
que uno con 1. Por eso ponderamos por cantidad.

Pero un solo vendedor con stock masivo (una
empresa liquidando, un dump, etc.) tampoco
debería definir el precio él solo. Por eso
limitamos cuánto puede "pesar" cada listing
individual: como máximo, el 5% de la cantidad
total disponible en el mercado.

Método (mediana ponderada de toda la oferta):
 1) Ordenamos todos los precios de menor a
    mayor.
 2) Vamos acumulando cantidad, con el tope de
    5% por vendedor aplicado a cada listing.
 3) El "valor real" es el precio en el que la
    cantidad acumulada (ponderada) llega al
    50% del total ponderado.

A diferencia de un promedio simple, esto no se
deja arrastrar por un bloque grande y aislado
lejos del resto. Y a diferencia de tomar el
punto medio de una "zona barata" arbitraria (el
20% más barato), no depende de un corte que un
solo listing pueda desbalancear: usa toda la
oferta del mercado.
*/

function getRealValue(listings){

 const raw=listings
  .map(x=>({
   price:Number(x.price??x.cost),
   qty:Math.max(
    1,
    Number(
     x.quantity??
     x.qty??
     x.amount??
     x.stock??
     1
    )
   )
  }))
  .filter(x=>Number.isFinite(x.price)&&x.price>1)
  .sort((a,b)=>a.price-b.price);

 if(!raw.length)
  throw Error('Sin precios válidos');

 const totalQty=
  raw.reduce((s,x)=>s+x.qty,0);

 /*
  Tope por vendedor: ningún listing puede
  pesar más del 5% de la cantidad total
  disponible en el mercado.
 */
 const cap=
  Math.max(1,Math.round(totalQty*0.05));

 /*
  Cantidad ponderada total, ya con el tope
  aplicado a cada listing.
 */
 const weightedTotal=
  raw.reduce(
   (s,x)=>s+Math.min(x.qty,cap),
   0
  );

 const half=weightedTotal/2;

 let acc=0;
 let value=raw[0].price;
 let low=raw[0].price;
 let high=raw[0].price;
 let count=0;

 for(const item of raw){

  const weight=
   Math.min(item.qty,cap);

  acc+=weight;

  high=item.price;
  count++;

  /*
   El "valor real" es el precio en el que
   la cantidad acumulada ponderada cruza
   el 50% del total ponderado.
  */
  if(acc>=half){
   value=item.price;
   break;
  }
 }

 return {
  value:value,
  low:low,
  high:high,
  total:raw.length,
  zone:count
 };
}

function confidence(data){

 const spread=
  (data.high-data.low)/
  Math.max(data.value,1);

 /*
  Muchos listings no sirven de nada si
  la zona termina siendo demasiado ancha:
  eso significa que hizo falta subir mucho
  en precio para juntar suficiente cantidad.
 */
 if(data.zone>=8&&spread<=0.6)
  return 'Alta';

 if(data.zone>=4)
  return 'Media';

 return 'Baja';
}

/* ---------- HISTÓRICO / ROLLUP DIARIO ----------

hist[id] = {raw, daily, _rolledTo}

raw: cada observación cruda de auditoría
 (time, value, low, high).

daily: rollup por día (mediana de los "value"
 observados ese día), recalculado de forma
 perezosa: solo si raw creció desde la última
 vez que se armó daily (_rolledTo guarda el
 largo de raw en ese momento).
*/

function dayKey(ts){

 const d=new Date(ts);

 return d.getFullYear()+'-'+
  String(d.getMonth()+1).padStart(2,'0')+'-'+
  String(d.getDate()).padStart(2,'0');
}

function median(arr){

 const s=arr.slice().sort((a,b)=>a-b);
 const n=s.length;

 if(!n)return null;

 const mid=Math.floor(n/2);

 return n%2
  ?s[mid]
  :(s[mid-1]+s[mid])/2;
}

function ensureDaily(id){

 const h=hist[id];

 if(!h)return [];

 if(h._rolledTo===h.raw.length)
  return h.daily;

 const byDay={};

 for(const r of h.raw){
  const k=dayKey(r.time);
  (byDay[k]=byDay[k]||[]).push(r);
 }

 h.daily=Object.keys(byDay)
  .sort()
  .map(k=>{

   const rows=byDay[k];

   return {
    day:k,
    median:median(rows.map(x=>x.value)),
    low:Math.min(...rows.map(x=>x.low)),
    high:Math.max(...rows.map(x=>x.high)),
    count:rows.length
   };
  });

 h._rolledTo=h.raw.length;

 return h.daily;
}

function latestDaily(id){

 const daily=ensureDaily(id);

 return daily.length
  ?daily[daily.length-1]
  :null;
}

/*
 Dashboard de 5 ventanas para el historial:
 Hoy, 7 días, 30 días, 90 días y Todo.
*/
const WINDOWS=[
 {label:'Hoy',ms:24*60*60*1000},
 {label:'7 días',ms:7*24*60*60*1000},
 {label:'30 días',ms:30*24*60*60*1000},
 {label:'90 días',ms:90*24*60*60*1000},
 {label:'Todo',ms:Infinity}
];

function windowStats(id){

 const h=hist[id];

 if(!h)return [];

 const now=Date.now();

 return WINDOWS.map(w=>{

  const rows=h.raw.filter(r=>
   w.ms===Infinity||now-r.time<=w.ms
  );

  return {
   label:w.label,
   median:median(rows.map(x=>x.value)),
   count:rows.length
  };
 });
}

/* ---------- CÁLCULOS ---------- */

function statusFor(c){

 const diff=
  ((c.buy-c.recommendedBuy)/
   Math.max(c.recommendedBuy,1))*100;

 if(diff>20)return '🔴 Revisar';
 if(diff>8)return '🟡 Vigilar';

 return '🟢 Correcto';
}

function severity(s){

 if(s==='🔴 Revisar')return 2;
 if(s==='🟡 Vigilar')return 1;

 return 0;
}

/*
 refValue es el precio de referencia para
 compra y venta recomendadas: la mediana del
 último día con histórico si ya existe, o el
 snapshot crudo del mercado si todavía no hay
 suficiente histórico (primera auditoría del
 item, por ejemplo).
*/
function calculate(item,market,daily){

 const mv=Number(item.mv||0);
 const buy=Number(item.buyPrice||0);

 if(!mv||!buy)
  return null;

 const effective=buy/mv;

 const usingDaily=daily!=null;
 const refValue=usingDaily?daily.median:market.value;

 /*
  Compra:
  valor de referencia × porcentaje W3B
 */
 const recommendedBuy=
  Math.round(refValue*effective);

 /*
  Descuento de compra = 1-effective
  Descuento de venta = mitad
 */
 const sellDiscount=(1-effective)/2;

 const recommendedSell=
  Math.round(
   refValue*(1-sellDiscount)
  );

 return {
  mv,
  buy,
  effective,
  sellDiscount,
  refValue,
  usingDaily,
  recommendedBuy,
  recommendedSell
 };
}

/* ---------- AUDITORÍA ---------- */

async function audit(id,force=false){

 if(busy.has(id))
  return items[id]?.audit||null;

 const item=items[id];

 if(!item)
  throw Error('Artículo no encontrado');

 if(
  !force &&
  item.audit &&
  item.audit.algo===ALGO_VERSION &&
  Date.now()-Number(item.audit.time||0)<FRESH
 ){
  return item.audit;
 }

 busy.add(id);

 try{

  try{await loadCatalog()}catch{}

  const im=await getMarket(id);

  const market=getRealValue(im.listings);

  const cat=catalog[id];

  const updated={
   ...item,
   name:item.name||cat?.name||im.item?.name,
   mv:Number(
    cat?.mv||
    im.item?.average_price||
    item.mv||
    0
   )
  };

  if(!hist[id])
   hist[id]={raw:[],daily:[],_rolledTo:0};

  hist[id].raw.push({
   time:Date.now(),
   value:market.value,
   low:market.low,
   high:market.high
  });

  if(hist[id].raw.length>500)
   hist[id].raw=hist[id].raw.slice(-500);

  const daily=latestDaily(id);

  const calc=calculate(updated,market,daily);

  const status=calc?statusFor(calc):null;

  const prevStatus=item.audit?.status;

  const auditData={
   time:Date.now(),
   algo:ALGO_VERSION,
   value:calc?calc.refValue:market.value,
   snapshotValue:market.value,
   low:market.low,
   high:market.high,
   total:market.total,
   zone:market.zone,
   confidence:confidence(market),
   usingDaily:!!daily,
   calc:calc,
   status:status
  };

  items[id]={
   ...updated,
   audit:auditData
  };

  last[id]=Date.now();

  await save();

  /*
   Aviso automático cuando el status empeora,
   sin importar en qué pantalla esté el usuario
   ni si vino de una auditoría pasiva o manual.
  */
  if(
   status&&
   prevStatus&&
   severity(status)>severity(prevStatus)
  ){
   toast(
    '⚠️ '+(updated.name||id)+
    ': empeoró a '+status
   );
  }

  return auditData;

 }finally{
  busy.delete(id);
 }
}

/* ---------- RESET DE AUDITORÍAS ----------

Borra todo lo calculado (audit guardado por
item, histórico crudo y rollups diarios, y las
marcas de "última auditoría") para arrancar de
cero, como si el script nunca hubiera corrido.
No toca la API Key, el Torn ID de W3B, ni los
buyPrice/name sincronizados desde W3B.
*/

async function resetAudits(){

 for(const id of Object.keys(items)){

  const {audit,...rest}=items[id];

  items[id]=rest;
 }

 hist={};
 last={};

 homeSelected=null;
 auditSelected=null;

 await save();
}

/* ---------- COPIAR ---------- */

async function copyPrice(value){

 try{
  await navigator.clipboard.writeText(
   String(Math.round(value))
  );

  toast('Precio copiado');

 }catch{
  toast('No se pudo copiar');
 }
}

/* ---------- VISTA HOME (🏠, liviano) ----------

Home solo muestra:
 - Valor del item → MV oficial de Torn.
 - Precio de compra → buyPrice de W3B tal cual
   está guardado, sin corregir (la corrección
   real vive en Auditoría).
 - Venta recomendada → misma fórmula de
   siempre, asumiendo que el W3B ya está bien.
*/

function home(){

 UI.content.innerHTML=`
  <div class="nav">
   <button id="at-nav-audit">📊 Auditoría</button>
   <button id="at-settings">⚙️</button>
  </div>

  <div class="top">
   <input
    id="at-search"
    placeholder="Buscar artículo..."
    autocomplete="off">
  </div>

  <div id="at-result" class="result">
   Busca un artículo para consultar su precio.
  </div>

  <div class="buttons">
   <button id="at-history">
    📜 Historial
   </button>
  </div>
 `;

 const search=
  UI.content.querySelector('#at-search');

 search.addEventListener('input',()=>{

  touch();

  const r=
   UI.content.querySelector('#at-result');

  if(r&&search.value.trim())
   r.innerHTML=
    '<span class="muted">Buscando…</span>';

  homeSearch(search.value);
 });

 UI.content.querySelector(
  '#at-nav-audit'
 ).onclick=auditHome;

 UI.content.querySelector(
  '#at-settings'
 ).onclick=settings;

 UI.content.querySelector(
  '#at-history'
 ).onclick=()=>showHistory(homeSelected,home);

 /*
  Si ya había un artículo seleccionado en
  Home, conservamos el contexto.
 */
 if(homeSelected){

  search.value=
   homeSelected.name||'';

  renderHomeItem(
   homeSelected.id,
   items[homeSelected.id]?.audit
  );
 }
}

let homeSearchTimer=null;

async function homeSearch(text){

 clearTimeout(homeSearchTimer);

 text=text.trim();

 if(!text){
  homeSelected=null;

  const r=
   UI.content.querySelector('#at-result');

  if(r)
   r.innerHTML=
    'Busca un artículo para consultar su precio.';

  return;
 }

 homeSearchTimer=setTimeout(async()=>{

  try{
   await loadCatalog();
  }catch{}

  const matches=collectMatches(text);

  const result=
   UI.content.querySelector('#at-result');

  if(!result)
   return;

  if(!matches.length){

   result.innerHTML=
    '<span class="muted">Sin resultados.</span>';

   return;
  }

  if(matches.length===1){

   await selectHomeItem(
    matches[0].id,
    matches[0].name
   );

   return;
  }

  renderSuggestions(result,matches,(id,name)=>{

   const search=
    UI.content.querySelector('#at-search');

   if(search)
    search.value=name;

   selectHomeItem(id,name);
  });

 },350);
}

async function selectHomeItem(id,name){

 touch();

 homeSelected={
  id:id,
  ...(items[id]||{}),
  name:
   items[id]?.name||
   name||
   id
 };

 const result=
  UI.content.querySelector('#at-result');

 if(result)
  result.innerHTML=
   '<span class="muted">Consultando mercado…</span>';

 try{

  const data=await audit(id);

  homeSelected={
   id:id,
   ...(items[id]||{})
  };

  renderHomeItem(id,data);

 }catch(e){

  if(result)
   result.innerHTML=
    '<span class="error">'+
    esc(e.message)+
    '</span>';
 }
}

function renderHomeItem(id,a){

 const item=items[id]||{};
 const result=
  UI.content.querySelector('#at-result');

 if(!result)return;

 if(!a){

  result.innerHTML=
   '<span class="muted">'+
   'Aún no hay datos de mercado.'+
   '</span>';

  return;
 }

 const c=a.calc;

 if(!c){

  result.innerHTML=
   '<span class="error">'+
   'No se pudo calcular el precio.'+
   '</span>';

  return;
 }

 result.innerHTML=`

  <div class="title">
   ${esc(item.name||id)}
  </div>

  <div>
   Valor del item:
   <b>${money(c.mv)}</b>
  </div>

  <div>
   Precio de compra:
   <b>${money(c.buy)}</b>
  </div>

  <hr>

  <div class="recommend sell">
   Venta recomendada
   (${percent(c.sellDiscount*100)} desc.)
   <b>${money(c.recommendedSell)}</b>

   <button
    class="copy"
    data-copy="${c.recommendedSell}">
    📋
   </button>
  </div>

  ${
   !c.usingDaily
   ?'<div class="muted">Sin histórico suficiente todavía, usando snapshot actual.</div>'
   :''
  }

  <div class="muted">
   Actualizado:
   ${new Date(a.time).toLocaleString()}
  </div>
 `;

 result
  .querySelectorAll('[data-copy]')
  .forEach(button=>{

   button.onclick=()=>copyPrice(
    button.dataset.copy
   );
  });
}

/* ---------- VISTA AUDITORÍA (📊, nuevo) ----------

Auditoría tiene su propia búsqueda y su propia
selección (auditSelected), independiente de
Home. Muestra la vista enfocada en compra:
MV, W3B compra, Valor real, Compra recomendada
con %, Confianza y status.

Sin búsqueda activa, muestra la lista de items
con observaciones guardadas en estado 🟡/🔴.
*/

function auditHome(){

 UI.content.innerHTML=`

  <div class="nav">
   <button id="at-nav-home">🏠 Inicio</button>
  </div>

  <div class="title">
   📊 Auditoría
  </div>

  <div class="top">
   <input
    id="at-audit-search"
    placeholder="Buscar artículo..."
    autocomplete="off">
  </div>

  <div id="at-audit-result" class="result">
  </div>
 `;

 UI.content.querySelector(
  '#at-nav-home'
 ).onclick=home;

 const search=
  UI.content.querySelector('#at-audit-search');

 search.addEventListener('input',()=>{

  touch();

  const r=
   UI.content.querySelector('#at-audit-result');

  if(r&&search.value.trim())
   r.innerHTML=
    '<span class="muted">Buscando…</span>';

  auditSearch(search.value);
 });

 if(auditSelected){

  search.value=
   auditSelected.name||'';

  renderAuditItem(
   auditSelected.id,
   items[auditSelected.id]?.audit
  );

 }else{

  renderFlaggedList();
 }
}

/*
 Lista de items auditados cuyo último status
 guardado no es 🟢, para revisar de un vistazo
 qué está desalineado sin tener que buscar
 artículo por artículo.
*/
function renderFlaggedList(){

 const result=
  UI.content.querySelector('#at-audit-result');

 if(!result)return;

 const flagged=Object.entries(items)
  .filter(([id,it])=>
   it.audit&&
   it.audit.status&&
   it.audit.status!=='🟢 Correcto'
  )
  .sort((a,b)=>
   severity(b[1].audit.status)-
   severity(a[1].audit.status)
  );

 if(!flagged.length){

  result.innerHTML=
   '<span class="muted">'+
   'Sin observaciones guardadas. Todo en orden.'+
   '</span>';

  return;
 }

 result.innerHTML=
  '<div class="suggestions">'+
  flagged.map(([id,it])=>
   '<div class="suggestion" data-id="'+
   esc(id)+
   '" data-name="'+
   esc(it.name||id)+
   '">'+
   it.audit.status+' '+
   esc(it.name||id)+
   '</div>'
  ).join('')+
  '</div>';

 result.querySelectorAll(
  '.suggestion'
 ).forEach(row=>{

  row.onclick=()=>{

   const search=
    UI.content.querySelector('#at-audit-search');

   if(search)
    search.value=row.dataset.name;

   selectAuditItem(
    row.dataset.id,
    row.dataset.name
   );
  };
 });
}

let auditSearchTimer=null;

async function auditSearch(text){

 clearTimeout(auditSearchTimer);

 text=text.trim();

 if(!text){

  auditSelected=null;

  renderFlaggedList();

  return;
 }

 auditSearchTimer=setTimeout(async()=>{

  try{
   await loadCatalog();
  }catch{}

  const matches=collectMatches(text);

  const result=
   UI.content.querySelector('#at-audit-result');

  if(!result)
   return;

  if(!matches.length){

   result.innerHTML=
    '<span class="muted">Sin resultados.</span>';

   return;
  }

  if(matches.length===1){

   await selectAuditItem(
    matches[0].id,
    matches[0].name
   );

   return;
  }

  renderSuggestions(result,matches,(id,name)=>{

   const search=
    UI.content.querySelector('#at-audit-search');

   if(search)
    search.value=name;

   selectAuditItem(id,name);
  });

 },350);
}

async function selectAuditItem(id,name){

 touch();

 auditSelected={
  id:id,
  ...(items[id]||{}),
  name:
   items[id]?.name||
   name||
   id
 };

 const result=
  UI.content.querySelector('#at-audit-result');

 if(result)
  result.innerHTML=
   '<span class="muted">Consultando mercado…</span>';

 try{

  const data=await audit(id);

  auditSelected={
   id:id,
   ...(items[id]||{})
  };

  renderAuditItem(id,data);

 }catch(e){

  if(result)
   result.innerHTML=
    '<span class="error">'+
    esc(e.message)+
    '</span>';
 }
}

function renderAuditItem(id,a){

 const item=items[id]||{};
 const result=
  UI.content.querySelector('#at-audit-result');

 if(!result)return;

 if(!a){

  result.innerHTML=
   '<span class="muted">'+
   'Aún no hay datos de mercado.'+
   '</span>';

  return;
 }

 const c=a.calc;

 if(!c){

  result.innerHTML=
   '<span class="error">'+
   'No se pudo calcular el precio.'+
   '</span>';

  return;
 }

 result.innerHTML=`

  <div class="title">
   ${esc(item.name||id)}
  </div>

  <div>
   MV Torn:
   <b>${money(c.mv)}</b>
  </div>

  <div>
   W3B compra:
   <b>${money(c.buy)}</b>
  </div>

  <div>
   W3B efectivo:
   <b>${percent(c.effective*100)}</b>
  </div>

  <hr>

  <div>
   Valor real
   ${c.usingDaily?'(mediana del día)':'(snapshot)'}:
   <b>${money(c.refValue)}</b>
  </div>

  <div class="muted">
   Zona:
   ${money(a.low)}
   –
   ${money(a.high)}
   ·
   ${a.zone}/${a.total} listings
  </div>

  <div>
   Confianza:
   ${a.confidence}
  </div>

  ${
   !c.usingDaily
   ?'<div class="muted">Sin histórico suficiente todavía, usando snapshot actual.</div>'
   :''
  }

  <div class="recommend">
   Compra recomendada
   (${percent(c.effective*100)})
   <b>${money(c.recommendedBuy)}</b>

   <button
    class="copy"
    data-copy="${c.recommendedBuy}">
    📋
   </button>
  </div>

  <div class="status">
   ${a.status}
  </div>

  <div class="muted">
   Actualizado:
   ${new Date(a.time).toLocaleString()}
  </div>

  <div class="buttons">
   <button id="at-audit-history">
    📜 Historial
   </button>

   <button id="at-audit-refresh">
    🔄 Actualizar
   </button>
  </div>
 `;

 result
  .querySelectorAll('[data-copy]')
  .forEach(button=>{

   button.onclick=()=>copyPrice(
    button.dataset.copy
   );
  });

 result.querySelector(
  '#at-audit-history'
 ).onclick=()=>showHistory(auditSelected,auditHome);

 const refreshBtn=
  result.querySelector('#at-audit-refresh');

 if(refreshBtn)
  refreshBtn.onclick=async()=>{

   if(refreshBtn.disabled)
    return;

   refreshBtn.disabled=true;
   refreshBtn.textContent='Actualizando…';

   try{

    const data=await audit(id,true);

    renderAuditItem(id,data);

   }catch(e){

    toast(e.message);

    refreshBtn.disabled=false;
    refreshBtn.textContent='🔄 Actualizar';
   }
  };
}

/* ---------- HISTORIAL (compartido) ----------

Se usa desde Home (historial del último item
buscado en Home) y desde Auditoría (historial
del item enfocado en esa pantalla). backFn
decide a qué pantalla vuelve el botón "Volver".
*/

function showHistory(article,backFn){

 backFn=backFn||home;

 if(!article){

  backFn();

  toast(
   'Primero busca un artículo'
  );

  return;
 }

 const id=article.id;
 const name=
  items[id]?.name||
  article.name||
  id;

 const raw=(hist[id]&&hist[id].raw)||[];
 const windows=windowStats(id);

 const recent=raw
  .slice()
  .reverse()
  .slice(0,30);

 UI.content.innerHTML=`

  <div class="title">
   📜 Historial
  </div>

  <div class="subtitle">
   ${esc(name)}
  </div>

  <button id="at-back">
   ← Volver
  </button>

  <div class="windows">

   ${
    windows.map(w=>`
      <div class="historyRow">

       <b>
        ${w.median!=null?money(w.median):'—'}
       </b>

       <span>
        ${w.label} · ${w.count}
       </span>

      </div>
     `).join('')
   }

  </div>

  <hr>

  <div class="history">

   ${
    recent.length

    ?recent.map(x=>`
      <div class="historyRow">

       <b>
        ${money(x.value)}
       </b>

       <span>
        ${new Date(
         x.time
        ).toLocaleString()}
       </span>

      </div>
     `).join('')

    :'<span class="muted">'+
     'Sin histórico todavía.'+
     '</span>'
   }

  </div>
 `;

 UI.content.querySelector(
  '#at-back'
 ).onclick=backFn;
}

/* ---------- CONFIGURACIÓN ---------- */

function settings(){

 UI.content.innerHTML=`

  <div class="title">
   ⚙️ Configuración
  </div>

  <label>
   Torn API Key
  </label>

  <input
   id="at-api"
   type="text"
   value="${esc(api)}"
   placeholder="API Key">

  <label>
   Torn ID de W3B
  </label>

  <input
   id="at-uid"
   type="number"
   value="${esc(uid)}"
   placeholder="Torn ID">

  <button id="at-save">
   Guardar
  </button>

  <button id="at-back">
   ← Volver
  </button>

  <hr>

  <div>
   Precios W3B
  </div>

  <button id="at-sync">
   ↻ Sincronizar W3B
  </button>

  <hr>

  <div>
   Auditorías guardadas
  </div>

  <button id="at-reset">
   🗑️ Borrar auditorías
  </button>

  <div class="muted">
   Borra el valor calculado, el histórico y las
   marcas de status guardadas por artículo.
   No toca tu API Key, tu Torn ID ni los precios
   de W3B sincronizados.
  </div>

  <hr>

  <div class="muted">
   La auditoría continúa en segundo plano
   y no cambiará esta pantalla.
  </div>
 `;

 UI.content.querySelector(
  '#at-save'
 ).onclick=async()=>{

  const saveBtn=
   UI.content.querySelector('#at-save');

  const original=saveBtn.textContent;

  api=
   UI.content.querySelector(
    '#at-api'
   ).value.trim();

  uid=
   UI.content.querySelector(
    '#at-uid'
   ).value.trim();

  await set(K.api,api);
  await set(K.uid,uid);

  saveBtn.disabled=true;
  saveBtn.textContent='Guardado ✓';

  toast('Configuración guardada');

  setTimeout(()=>{
   saveBtn.textContent=original;
   saveBtn.disabled=false;
  },900);
 };

 UI.content.querySelector(
  '#at-sync'
 ).onclick=async()=>{

  const syncBtn=
   UI.content.querySelector('#at-sync');

  if(syncBtn.disabled)
   return;

  const original=syncBtn.textContent;

  syncBtn.disabled=true;
  syncBtn.textContent='Sincronizando…';

  try{

   const n=await syncW3B();

   toast(
    n+' precios sincronizados'
   );

  }catch(e){

   toast(e.message);

  }finally{

   syncBtn.textContent=original;
   syncBtn.disabled=false;
  }
 };

 UI.content.querySelector(
  '#at-reset'
 ).onclick=async()=>{

  const resetBtn=
   UI.content.querySelector('#at-reset');

  if(resetBtn.disabled)
   return;

  /*
   Doble toque para confirmar: la primera
   pulsación solo cambia el texto del botón,
   la segunda (dentro de los siguientes 4s)
   ejecuta el borrado. Así evitamos un borrado
   accidental de un solo toque.
  */
  if(resetBtn.dataset.confirm!=='1'){

   resetBtn.dataset.confirm='1';
   resetBtn.textContent='¿Seguro? Tocá de nuevo';

   setTimeout(()=>{
    if(resetBtn.dataset.confirm==='1'){
     resetBtn.dataset.confirm='';
     resetBtn.textContent='🗑️ Borrar auditorías';
    }
   },4000);

   return;
  }

  resetBtn.dataset.confirm='';
  resetBtn.disabled=true;
  resetBtn.textContent='Borrando…';

  await resetAudits();

  toast('Auditorías borradas');

  resetBtn.disabled=false;
  resetBtn.textContent='🗑️ Borrar auditorías';
 };

 UI.content.querySelector(
  '#at-back'
 ).onclick=home;
}

/* ---------- MENSAJE ---------- */

function toast(text){

 const t=
  document.createElement('div');

 t.className='at-toast';
 t.textContent=text;

 document.body.appendChild(t);

 setTimeout(
  ()=>t.remove(),
  1600
 );
}

/* ---------- INTERFAZ ---------- */

function createUI(){

 /*
  Evita que el botón se multiplique.
  Este era uno de los bugs de versiones anteriores.
 */
 if(document.getElementById('at-float'))
  return;

 const button=
  document.createElement('button');

 button.id='at-float';
 button.textContent='💰';

 const panel=
  document.createElement('div');

 panel.id='at-panel';

 const content=
  document.createElement('div');

 panel.appendChild(content);

 document.body.appendChild(button);
 document.body.appendChild(panel);

 UI={
  button,
  panel,
  content
 };

 /* ---------- ESTILOS ---------- */

 const style=
  document.createElement('style');

 style.textContent=`

 #at-float{
  position:fixed;
  width:42px;
  height:42px;
  right:18px;
  bottom:90px;
  border:0;
  border-radius:50%;
  background:#1565c0;
  color:white;
  font-size:18px;
  z-index:2147483647;
  box-shadow:0 3px 10px #0008;
  cursor:grab;
  touch-action:none;
  user-select:none;
 }

 #at-panel{
  display:none;
  position:fixed;
  width:270px;
  max-width:calc(100vw - 20px);
  max-height:75vh;
  overflow:auto;
  box-sizing:border-box;
  padding:10px;
  background:#1e1e1e;
  color:#eee;
  border:1px solid #444;
  border-radius:10px;
  z-index:2147483646;
  font:12px sans-serif;
  box-shadow:0 4px 14px #0009;
 }

 #at-panel input{
  width:100%;
  box-sizing:border-box;
  padding:6px;
  margin:3px 0 7px;
  background:#292929;
  color:#fff;
  border:1px solid #555;
  border-radius:5px;
 }

 #at-panel button{
  padding:6px 8px;
  margin:3px;
  border:0;
  border-radius:5px;
  background:#455a64;
  color:white;
  cursor:pointer;
  transition:background .15s,transform .08s;
 }

 #at-panel button:active{
  background:#37474f;
  transform:scale(.96);
 }

 #at-panel button:disabled{
  opacity:.55;
  cursor:default;
  transform:none;
 }

 #at-panel .nav{
  display:flex;
  justify-content:space-between;
  margin-bottom:6px;
 }

 #at-panel .suggestions{
  display:flex;
  flex-direction:column;
  gap:3px;
 }

 #at-panel .suggestion{
  padding:7px 8px;
  border-radius:5px;
  background:#252525;
  cursor:pointer;
  transition:background .1s;
 }

 #at-panel .suggestion:active{
  background:#37474f;
 }

 #at-panel .top{
  display:flex;
  gap:5px;
 }

 #at-panel .top input{
  flex:1;
 }

 #at-panel .result{
  line-height:1.55;
 }

 #at-panel .title{
  font-size:15px;
  font-weight:bold;
  margin-bottom:6px;
 }

 #at-panel .subtitle{
  opacity:.75;
  margin-bottom:8px;
 }

 #at-panel .muted{
  opacity:.65;
  font-size:11px;
 }

 #at-panel .error{
  color:#ff6b6b;
 }

 #at-panel .recommend{
  margin-top:9px;
  padding:7px;
  border-radius:6px;
  background:#252525;
  font-size:13px;
 }

 #at-panel .recommend b{
  display:block;
  font-size:16px;
  margin-top:2px;
 }

 #at-panel .recommend.sell{
  color:#81c784;
 }

 #at-panel .copy{
  float:right;
 }

 #at-panel .status{
  margin-top:8px;
  font-weight:bold;
 }

 #at-panel .buttons{
  margin-top:8px;
  display:flex;
  gap:5px;
 }

 #at-panel hr{
  border:0;
  border-top:1px solid #333;
  margin:8px 0;
 }

 #at-panel .historyRow{
  display:flex;
  justify-content:space-between;
  padding:7px 0;
  border-bottom:1px solid #333;
 }

 #at-panel .historyRow span{
  opacity:.6;
  font-size:10px;
 }

 .at-toast{
  position:fixed;
  left:50%;
  bottom:20px;
  transform:translateX(-50%);
  background:#222;
  color:white;
  padding:8px 12px;
  border-radius:6px;
  z-index:2147483647;
 }

 `;

 document.head.appendChild(style);

 /* ---------- POSICIÓN ---------- */

 let dragging=false;
 let moved=false;

 let startX=0;
 let startY=0;

 let originalX=0;
 let originalY=0;

 function placePanel(x,y){

  const width=270;

  let left=Math.max(
   10,
   Math.min(
    window.innerWidth-width-10,
    x
   )
  );

  panel.style.left=
   left+'px';

  panel.style.right='auto';

  if(y>window.innerHeight/2){

   panel.style.top='auto';

   panel.style.bottom=
    (window.innerHeight-y+8)+'px';

  }else{

   panel.style.bottom='auto';

   panel.style.top=
    (y+50)+'px';
  }
 }

 function startDrag(x,y){

  dragging=true;
  moved=false;

  startX=x;
  startY=y;

  const r=
   button.getBoundingClientRect();

  originalX=r.left;
  originalY=r.top;

  button.style.cursor=
   'grabbing';
 }

 function moveDrag(x,y){

  if(!dragging)
   return;

  const dx=x-startX;
  const dy=y-startY;

  /*
   Solo consideramos que es arrastre
   después de unos píxeles.
  */
  if(
   Math.abs(dx)>6||
   Math.abs(dy)>6
  ){
   moved=true;
  }

  if(!moved)
   return;

  const nx=Math.max(
   3,
   Math.min(
    window.innerWidth-45,
    originalX+dx
   )
  );

  const ny=Math.max(
   3,
   Math.min(
    window.innerHeight-45,
    originalY+dy
   )
  );

  button.style.left=
   nx+'px';

  button.style.top=
   ny+'px';

  button.style.right='auto';
  button.style.bottom='auto';

  placePanel(nx,ny);
 }

 function endDrag(){

  if(!dragging)
   return;

  dragging=false;

  button.style.cursor='grab';

  /*
   Si NO hubo movimiento,
   fue simplemente un toque.
  */
  if(!moved){

   const opening=
    panel.style.display!=='block';

   panel.style.display=
    opening?'block':'none';

   if(opening)
    home();
  }
 }

 /* ---------- EVENTOS (Pointer Events) ----------

 Usamos Pointer Events en lugar de mouse y touch
 por separado. Mezclarlos causaba el bug donde
 había que mantener presionado el botón: un toque
 dispara touchstart/touchend reales y, además, el
 navegador dispara mousedown/mouseup "fantasma"
 poco después, provocando un doble toggle (se
 abre y se cierra al instante). Con Pointer Events
 solo hay un evento por gesto.
 */

 button.addEventListener(
  'pointerdown',
  e=>{
   button.setPointerCapture(e.pointerId);

   startDrag(
    e.clientX,
    e.clientY
   );
  }
 );

 button.addEventListener(
  'pointermove',
  e=>{
   if(dragging)
    moveDrag(
     e.clientX,
     e.clientY
    );
  }
 );

 button.addEventListener(
  'pointerup',
  endDrag
 );

 button.addEventListener(
  'pointercancel',
  endDrag
 );

 /*
  Colocar panel inicialmente.
 */
 const rect=
  button.getBoundingClientRect();

 placePanel(
  rect.left,
  rect.top
 );
}

/* ---------- AUDITOR PASIVO ---------- */

let passiveRunning=false;

async function passiveAudit(){

 if(passiveRunning)
  return;

 if(!api)
  return;

 /*
  Prioridad de búsqueda: si el usuario tuvo
  actividad hace poco (búsqueda o selección
  en Home o en Auditoría), no competimos por
  la API con la auditoría pasiva en este ciclo.
 */
 if(Date.now()-lastInteraction<4000)
  return;

 passiveRunning=true;

 try{

  const ids=
   Object.keys(items);

  for(const id of ids){

   /*
    No tocar la interfaz.
    No cambiar de pantalla.
   */

   if(
    Date.now()-
    Number(last[id]||0)
    <PASSIVE
   )
    continue;

   if(busy.has(id))
    continue;

   try{

    await audit(id,false);

   }catch{}

   /*
    Solo un artículo por ciclo.
    Así evitamos bombardear la API.
   */

   break;
  }

 }finally{

  passiveRunning=false;
 }
}

/*
 Ejecutamos periódicamente la auditoría
 en segundo plano.
 */
setInterval(
 passiveAudit,
 5000
);

/* ---------- INICIO ---------- */

async function start(){

 await load();

 createUI();
}

/*
 Esperamos al DOM si es necesario.
 */
if(
 document.readyState===
 'loading'
){

 document.addEventListener(
  'DOMContentLoaded',
  start
 );

}else{

 start();
}

})();
