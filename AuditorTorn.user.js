// ==UserScript==
// @name         AuditorTorn
// @namespace    torn-pda-auditor
// @version      1.0.3
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
let selected=null;
let busy=new Set();
let UI=null;

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
  catalog[id]=x.name;
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
  add(q,catalog[q]);

 for(const [id,x] of Object.entries(items)){

  const name=String(x.name||'');

  if(name.toLowerCase().includes(q))
   add(id,name);
 }

 for(const [id,n] of Object.entries(catalog)){

  if(String(n).toLowerCase().includes(q))
   add(id,n);
 }

 return out.slice(0,8);
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

/* ---------- MERCADO ---------- */

async function getMarket(id){
 const d=await request(
  BASE+'/marketplace/'+id+'?limit=100'
 );

 if(!d||!Array.isArray(d.listings))
  throw Error(d?.message||'Mercado inválido');

 return d;
}

/* ---------- VALOR REAL ----------

Usamos el 10% de los listings con menor
precio para estimar el valor real de un
artículo. Son los que realmente compiten
por la venta; el resto del mercado (precios
inflados, listados abandonados) no debería
influir en el cálculo.
*/

function getRealValue(listings){

 const prices=listings
  .map(x=>Number(x.price))
  .filter(x=>Number.isFinite(x)&&x>1)
  .sort((a,b)=>a-b);

 if(!prices.length)
  throw Error('Sin precios válidos');

 const count=
  Math.max(1,Math.ceil(prices.length*0.10));

 const zone=prices.slice(0,count);

 const value=
  zone[Math.floor(zone.length/2)];

 return {
  value:value,
  low:zone[0],
  high:zone[zone.length-1],
  total:prices.length,
  zone:zone.length
 };
}

function confidence(data){

 if(data.zone>=10)
  return 'Alta';

 if(data.zone>=4)
  return 'Media';

 return 'Baja';
}

/* ---------- CÁLCULOS ---------- */

function calculate(item,market){

 const mv=Number(item.mv||0);
 const buy=Number(item.buyPrice||0);

 if(!mv||!buy)
  return null;

 const effective=buy/mv;

 /*
  Compra:
  valor real × porcentaje W3B
 */
 const recommendedBuy=
  Math.round(market.value*effective);

 /*
  Descuento de compra = 1-effective
  Descuento de venta = mitad
 */
 const sellDiscount=(1-effective)/2;

 const recommendedSell=
  Math.round(
   market.value*(1-sellDiscount)
  );

 return {
  mv,
  buy,
  effective,
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
  Date.now()-Number(item.audit.time||0)<FRESH
 ){
  return item.audit;
 }

 busy.add(id);

 try{

  const data=await getMarket(id);

  const market=getRealValue(data.listings);

  const updated={
   ...item,
   name:item.name||data.item_name,
   mv:Number(
    data.market_price||
    item.mv||
    0
   ),
   bazaarAverage:Number(
    data.bazaar_average||0
   )
  };

  const calc=calculate(
   updated,
   market
  );

  const auditData={
   time:Date.now(),
   value:market.value,
   low:market.low,
   high:market.high,
   total:market.total,
   zone:market.zone,
   confidence:confidence(market),
   calc:calc
  };

  items[id]={
   ...updated,
   audit:auditData
  };

  if(!hist[id])
   hist[id]=[];

  /*
   Guardamos solamente observaciones
   obtenidas con esta metodología.
  */
  hist[id].push({
   time:auditData.time,
   value:auditData.value,
   low:auditData.low,
   high:auditData.high
  });

  if(hist[id].length>100)
   hist[id]=hist[id].slice(-100);

  last[id]=Date.now();

  await save();

  return auditData;

 }finally{
  busy.delete(id);
 }
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

/* ---------- VISTA PRINCIPAL ---------- */

function home(){

 UI.content.innerHTML=`
  <div class="top">
   <input
    id="at-search"
    placeholder="Buscar artículo..."
    autocomplete="off">
   <button id="at-settings">⚙️</button>
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

  const r=
   UI.content.querySelector('#at-result');

  if(r&&search.value.trim())
   r.innerHTML=
    '<span class="muted">Buscando…</span>';

  searchItem(search.value);
 });

 UI.content.querySelector(
  '#at-settings'
 ).onclick=settings;

 UI.content.querySelector(
  '#at-history'
 ).onclick=()=>showHistory(selected);

 /*
  Si ya había un artículo seleccionado,
  conservamos el contexto.
 */
 if(selected){

  search.value=
   selected.name||'';

  renderItem(
   selected.id,
   items[selected.id]?.audit
  );
 }
}

/* ---------- BÚSQUEDA ---------- */

let searchTimer=null;

async function searchItem(text){

 clearTimeout(searchTimer);

 text=text.trim();

 if(!text){
  selected=null;

  const r=
   UI.content.querySelector('#at-result');

  if(r)
   r.innerHTML=
    'Busca un artículo para consultar su precio.';

  return;
 }

 /*
  Esperamos un poco para no auditar
  con cada letra escrita.
 */
 searchTimer=setTimeout(async()=>{

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

  /*
   Coincidencia única: se consulta
   directamente, sin mostrar lista.
  */
  if(matches.length===1){

   await selectItem(
    matches[0].id,
    matches[0].name
   );

   return;
  }

  /*
   Varias coincidencias: mostramos
   una lista de sugerencias clicable.
  */
  result.innerHTML=
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

  result.querySelectorAll(
   '.suggestion'
  ).forEach(row=>{

   row.onclick=()=>{

    const search=
     UI.content.querySelector('#at-search');

    if(search)
     search.value=row.dataset.name;

    selectItem(
     row.dataset.id,
     row.dataset.name
    );
   };
  });

 },350);
}

/*
 Selecciona un artículo concreto
 (desde una sugerencia o coincidencia
 única) y dispara la auditoría.
*/
async function selectItem(id,name){

 selected={
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

  /*
   Si no hay auditoría reciente,
   el artículo se consulta automáticamente.
  */
  const data=await audit(id);

  selected={
   id:id,
   ...(items[id]||{})
  };

  renderItem(id,data);

 }catch(e){

  if(result)
   result.innerHTML=
    '<span class="error">'+
    esc(e.message)+
    '</span>';
 }
}

/* ---------- RESULTADO ---------- */

function renderItem(id,a){

 const item=items[id]||{};
 const result=
  UI.content.querySelector('#at-result');

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

 /*
  Diferencia entre el precio W3B
  y el precio recomendado.
 */
 const difference=
  ((c.buy-c.recommendedBuy)/
   Math.max(c.recommendedBuy,1))*100;

 let status='🟢 Correcto';

 if(difference>20)
  status='🔴 Revisar';

 else if(difference>8)
  status='🟡 Vigilar';

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
   Valor real estimado:
   <b>${money(a.value)}</b>
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

  <div class="recommend">
   Compra recomendada
   <b>${money(c.recommendedBuy)}</b>

   <button
    class="copy"
    data-copy="${c.recommendedBuy}">
    📋
   </button>
  </div>

  <div class="recommend sell">
   Venta recomendada
   <b>${money(c.recommendedSell)}</b>

   <button
    class="copy"
    data-copy="${c.recommendedSell}">
    📋
   </button>
  </div>

  <div class="status">
   ${status}
  </div>

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

/* ---------- HISTORIAL ---------- */

function showHistory(article){

 if(!article){

  home();

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

 const data=
  (hist[id]||[])
  .slice()
  .reverse();

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

  <div class="history">

   ${
    data.length

    ?data.map(x=>`
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
 ).onclick=home;
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
  '#at-back'
 ).onclick=home;
}

/* ---------- MENSAJE ---------- */

function toast(text){

 const t=
  document.createElement('div');

 t.className='toast';
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
