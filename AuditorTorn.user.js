// ==UserScript==
// @name         Torn Auditor
// @namespace    torn-pda-auditor
// @version      1.0.2
// @description  Auditor de precios, compra/venta e histórico para TornW3B.
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/Piero1111/AuditorTorn-/main/AuditorTorn.user.js
// @downloadURL  https://raw.githubusercontent.com/Piero1111/AuditorTorn-/main/AuditorTorn.user.js
// ==/UserScript==

(function () {
'use strict';

if (window.__TORN_AUDITOR_V102__) return;
window.__TORN_AUDITOR_V102__ = true;

const W3B='https://weav3r.dev/api', TORN='https://api.torn.com';
const K={api:'tbp_api',uid:'tbp_uid',items:'tbp_items',db:'tbp_db',history:'tbp_history',results:'tbp_results',queue:'tbp_queue'};
const REFRESH_MS=30*60*1000, DELAY_MS=1800, MAX_HISTORY=50, WATCH=.15, REVIEW=.30;

let apiKey='',userId='',items={},db={},history={},results={},queue=[],auditing=false;
let currentView='home', panelOpen=false, dragging=false, moved=false;
let btnX=0,btnY=0,startX=0,startY=0,origX=0,origY=0;

const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function get(k,f){try{return typeof GM_getValue==='function'?await GM_getValue(k,f):f}catch{return f}}
async function set(k,v){try{if(typeof GM_setValue==='function')await GM_setValue(k,v)}catch{}}
async function load(){
 apiKey=await get(K.api,'')||''; userId=await get(K.uid,'')||'';
 try{items=JSON.parse(await get(K.items,'{}'))||{}}catch{items={}}
 try{db=JSON.parse(await get(K.db,'{}'))||{}}catch{db={}}
 try{history=JSON.parse(await get(K.history,'{}'))||{}}catch{history={}}
 try{results=JSON.parse(await get(K.results,'{}'))||{}}catch{results={}}
 try{queue=JSON.parse(await get(K.queue,'[]'))||[]}catch{queue=[]}
}
const saveItems=()=>set(K.items,JSON.stringify(items));
const saveDb=()=>set(K.db,JSON.stringify(db));
const saveHistory=()=>set(K.history,JSON.stringify(history));
const saveResults=()=>set(K.results,JSON.stringify(results));
const saveQueue=()=>set(K.queue,JSON.stringify(queue));

async function http(url){
 if(typeof PDA_httpGet!=='function')throw Error('PDA_httpGet no está disponible en TornPDA');
 const r=await PDA_httpGet(url);
 if(!r||typeof r.responseText!=='string')throw Error('Respuesta vacía');
 const d=JSON.parse(r.responseText);
 if(d?.error)throw Error(d.message||d.error.error||d.error);
 return d;
}
const money=n=>'$'+Math.round(Number(n)||0).toLocaleString('en-US');
const pct=n=>(Number(n||0)*100).toFixed(1)+'%';

async function loadCatalog(){
 if(!apiKey||Object.keys(db).length)return;
 const d=await http(`${TORN}/torn/?selections=items&key=${encodeURIComponent(apiKey)}`);
 for(const [id,x] of Object.entries(d.items||{}))
  db[id]={name:x.name||'',mv:Number(x.market_value??x.marketValue??x.value??0)};
 await saveDb();
}
async function syncW3B(){
 if(!userId)throw Error('Falta tu Torn ID');
 const d=await http(`${W3B}/pricelist/${userId}`);
 if(!Array.isArray(d))throw Error('Respuesta W3B inesperada');
 for(const x of d){
  const id=String(x.itemId);
  items[id]={...(items[id]||{}),name:x.name||db[id]?.name||id,buy:Number(x.buyPrice)||0};
 }
 rebuildQueue(); await saveItems(); await saveQueue(); updateBadge(); renderCurrent();
}
function rebuildQueue(){
 const ids=Object.keys(items), known=new Set(queue);
 ids.sort((a,b)=>(history[a]?.at(-1)?.ts||0)-(history[b]?.at(-1)?.ts||0));
 queue=[...queue.filter(id=>items[id]),...ids.filter(id=>!known.has(id))];
}
async function marketplace(id){
 const d=await http(`${W3B}/marketplace/${id}`);
 const listings=Array.isArray(d.listings)?d.listings.map(x=>({price:Number(x.price),qty:Math.max(1,Number(x.quantity)||1)})).filter(x=>x.price>1):[];
 if(!listings.length)throw Error('Sin listings');
 return {listings,marketPrice:Number(d.market_price)||0,bazaarAverage:Number(d.bazaar_average)||0};
}
function realValue(listings){
 const s=[...listings].sort((a,b)=>a.price-b.price), p=s.map(x=>x.price);
 const q1=p[Math.floor((p.length-1)*.25)],q3=p[Math.floor((p.length-1)*.75)],iqr=q3-q1;
 let f=iqr>0?s.filter(x=>x.price>=q1-iqr*1.5&&x.price<=q3+iqr*1.5):s;
 if(!f.length)f=s;
 let qty=0,total=0;
 for(const x of f){const q=Math.min(x.qty,100);qty+=q;total+=x.price*q}
 const avg=total/qty,median=f[Math.floor(f.length/2)].price,value=Math.round(median*.65+avg*.35);
 const min=Math.min(...f.map(x=>x.price)),max=Math.max(...f.map(x=>x.price)),spread=value?(max-min)/value:1;
 let confidence='Baja';
 if(f.length>=30&&spread<=.35)confidence='Alta';else if(f.length>=10&&spread<=.60)confidence='Media';
 return {value,min,max,count:f.length,confidence};
}
function historicalAverage(id){
 const v=(history[id]||[]).map(x=>Number(x.value)).filter(Boolean);
 return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):0;
}
async function addHistory(id,r){
 if(!history[id])history[id]=[];
 history[id].push({ts:Date.now(),value:r.value,min:r.min,max:r.max,count:r.count,confidence:r.confidence});
 if(history[id].length>MAX_HISTORY)history[id]=history[id].slice(-MAX_HISTORY);
 await saveHistory();
}
async function analyze(id){
 const item=items[id]; if(!item)throw Error('Artículo no está en tu lista W3B');
 const m=await marketplace(id), real=realValue(m.listings), mv=Number(db[id]?.mv||0), w3bBuy=Number(item.buy||0);
 const effectivePct=mv>0&&w3bBuy>0?w3bBuy/mv:0;
 const buy=effectivePct?Math.round(real.value*effectivePct):0;
 const sell=effectivePct?Math.round(real.value*(1-(1-effectivePct)/2)):0;
 let status='normal';
 if(buy&&w3bBuy){const diff=Math.abs(w3bBuy-buy)/buy;if(diff>=REVIEW)status='review';else if(diff>=WATCH)status='watch'}
 const r={id,name:item.name||db[id]?.name||id,mv,w3bBuy,effectivePct,real,historical:historicalAverage(id),recommendedBuy:buy,recommendedSell:sell,bazaarAverage:m.bazaarAverage,marketPrice:m.marketPrice,status,ts:Date.now()};
 results[id]=r;await saveResults();await addHistory(id,real);return r;
}
async function auditOne(id){
 try{return await analyze(id)}
 catch(e){results[id]={...(results[id]||{}),id,name:items[id]?.name||db[id]?.name||id,status:'error',error:e.message,ts:Date.now()};await saveResults();return results[id]}
}
function fresh(id){return results[id]?.ts&&Date.now()-results[id].ts<REFRESH_MS}
function counts(){let review=0,watch=0,normal=0;for(const id of Object.keys(items)){const s=results[id]?.status;if(s==='review')review++;else if(s==='watch')watch++;else if(s==='normal')normal++}return{review,watch,normal}}

async function passiveAudit(){
 if(auditing||!apiKey||!Object.keys(items).length)return;
 auditing=true; updateBadge();
 try{
  rebuildQueue();
  while(queue.length&&apiKey){
   const id=queue.shift();await saveQueue();
   if(!items[id]||fresh(id))continue;
   await auditOne(id);updateBadge();
   // IMPORTANT: do not replace the user's current screen.
   await sleep(DELAY_MS);
  }
  rebuildQueue();await saveQueue();
 }finally{auditing=false;updateBadge();renderCurrent()}
}

function createUI(){
 if($('ta-float'))return;
 const btn=document.createElement('div');btn.id='ta-float';
 Object.assign(btn.style,{position:'fixed',right:'15px',bottom:'90px',width:'40px',height:'40px',borderRadius:'50%',background:'#1565c0',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px',cursor:'grab',zIndex:'2147483647',boxShadow:'0 3px 10px rgba(0,0,0,.5)',userSelect:'none',touchAction:'none'});
 btn.innerHTML='💰<span id="ta-badge" style="display:none;position:absolute;right:-5px;top:-5px;background:#d32f2f;border-radius:10px;min-width:16px;height:16px;font-size:9px;align-items:center;justify-content:center;"></span>';
 document.body.appendChild(btn);
 const panel=document.createElement('div');panel.id='ta-panel';
 Object.assign(panel.style,{position:'fixed',right:'12px',bottom:'138px',width:'275px',maxHeight:'75vh',overflowY:'auto',background:'#1e1e1e',color:'#fff',border:'1px solid #444',borderRadius:'10px',padding:'9px',fontFamily:'Arial,sans-serif',fontSize:'12px',zIndex:'2147483646',boxShadow:'0 5px 20px rgba(0,0,0,.6)',display:'none'});
 panel.innerHTML=`<div style="display:flex;gap:4px;align-items:center;margin-bottom:7px">
 <input id="ta-search" placeholder="Buscar artículo..." autocomplete="off" style="flex:1;min-width:0;background:#292929;color:#fff;border:1px solid #555;border-radius:5px;padding:6px;font-size:12px">
 <button id="ta-audit" title="Auditor" style="background:#455a64;color:#fff;border:0;border-radius:5px;padding:6px">🔍</button>
 <button id="ta-history" title="Historial" style="background:#455a64;color:#fff;border:0;border-radius:5px;padding:6px">📈</button>
 <button id="ta-settings" title="Configuración" style="background:#455a64;color:#fff;border:0;border-radius:5px;padding:6px">⚙️</button></div>
 <div id="ta-suggestions"></div><div id="ta-view"></div>`;
 document.body.appendChild(panel);

 function syncPos(){
  btn.style.left=btnX+'px';btn.style.top=btnY+'px';btn.style.right='auto';btn.style.bottom='auto';
  let left=btnX,top=btnY>innerHeight/2?btnY-148:btnY+48;
  left=Math.max(8,Math.min(left,innerWidth-287));top=Math.max(8,Math.min(top,innerHeight-100));
  panel.style.left=left+'px';panel.style.top=top+'px';panel.style.right='auto';panel.style.bottom='auto';
 }
 btnX=innerWidth-55;btnY=innerHeight-145;syncPos();
 function start(x,y){dragging=true;moved=false;startX=x;startY=y;origX=btnX;origY=btnY;btn.style.cursor='grabbing'}
 function move(x,y){if(!dragging)return;const dx=x-startX,dy=y-startY;if(Math.abs(dx)>4||Math.abs(dy)>4)moved=true;btnX=Math.max(4,Math.min(innerWidth-44,origX+dx));btnY=Math.max(4,Math.min(innerHeight-44,origY+dy));syncPos()}
 function end(){if(!dragging)return;dragging=false;btn.style.cursor='grab';if(!moved){panelOpen=!panelOpen;panel.style.display=panelOpen?'block':'none';if(panelOpen){currentView='home';renderCurrent()}}}
 btn.addEventListener('mousedown',e=>start(e.clientX,e.clientY));document.addEventListener('mousemove',e=>move(e.clientX,e.clientY));document.addEventListener('mouseup',end);
 btn.addEventListener('touchstart',e=>{const t=e.touches[0];start(t.clientX,t.clientY)},{passive:true});
 document.addEventListener('touchmove',e=>{if(dragging){const t=e.touches[0];move(t.clientX,t.clientY)}},{passive:true});document.addEventListener('touchend',end);
 addEventListener('resize',syncPos);

 $('ta-audit').onclick=()=>{currentView='audit';renderCurrent()};
 $('ta-history').onclick=()=>{currentView='history';renderCurrent()};
 $('ta-settings').onclick=()=>{currentView='settings';renderCurrent()};

 const search=$('ta-search');
 search.addEventListener('input',()=>{
  const q=search.value.trim().toLowerCase(),box=$('ta-suggestions');box.innerHTML='';
  if(q.length<2)return;
  Object.entries(items).filter(([id,x])=>(x.name||'').toLowerCase().includes(q)).slice(0,8).forEach(([id,x])=>{
   const b=document.createElement('button');b.textContent=x.name;
   Object.assign(b.style,{display:'block',width:'100%',textAlign:'left',padding:'5px',marginBottom:'2px',background:'#292929',color:'#fff',border:0,borderRadius:'4px'});
   b.onclick=()=>{search.value=x.name;box.innerHTML='';showItem(id)};box.appendChild(b);
  });
 });
 search.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;const q=search.value.trim().toLowerCase();
  const f=Object.entries(items).find(([id,x])=>(x.name||'').toLowerCase()===q);if(f){$('ta-suggestions').innerHTML='';showItem(f[0])}
 });
 updateBadge();
}

function homeHTML(){const c=counts();return `<div style="font-size:14px;font-weight:bold">Torn Auditor</div><div style="margin-top:5px;opacity:.75">${Object.keys(items).length} artículos sincronizados</div><div style="margin-top:7px">🔴 Revisar: <b>${c.review}</b><br>🟡 Vigilar: <b>${c.watch}</b><br>🟢 Normal: <b>${c.normal}</b></div><div style="font-size:10px;opacity:.5;margin-top:8px">${auditing?'⏳ Auditoría en curso...':'✓ Auditor pasivo activo'}</div>`}

function renderCurrent(){if(!$('ta-view')||!panelOpen)return;switch(currentView){case'settings':renderSettings();break;case'audit':renderAudit();break;case'history':renderHistory();break;default:$('ta-view').innerHTML=homeHTML()}}
function renderSettings(){
 $('ta-view').innerHTML=`<div style="font-size:14px;font-weight:bold;margin-bottom:8px">⚙️ Configuración</div>
 <label style="font-size:10px;opacity:.7">Torn API Key</label><input id="ta-api" type="text" value="${esc(apiKey)}" style="width:100%;box-sizing:border-box;margin:3px 0 7px;background:#292929;color:#fff;border:1px solid #555;border-radius:4px;padding:5px">
 <label style="font-size:10px;opacity:.7">Torn ID</label><input id="ta-uid" type="number" value="${esc(userId)}" style="width:100%;box-sizing:border-box;margin:3px 0 7px;background:#292929;color:#fff;border:1px solid #555;border-radius:4px;padding:5px">
 <button id="ta-save-settings" style="width:100%;padding:6px;background:#455a64;color:#fff;border:0;border-radius:5px">Guardar configuración</button>
 <button id="ta-sync-settings" style="width:100%;margin-top:5px;padding:6px;background:#6a1b9a;color:#fff;border:0;border-radius:5px">Sincronizar lista W3B</button>
 <div id="ta-settings-msg" style="font-size:10px;margin-top:6px"></div>`;
 $('ta-save-settings').onclick=async()=>{apiKey=$('ta-api').value.trim();userId=$('ta-uid').value.trim();await set(K.api,apiKey);await set(K.uid,userId);$('ta-settings-msg').innerHTML='<span style="color:#66bb6a">✓ Guardado</span>';try{await loadCatalog()}catch{}};
 $('ta-sync-settings').onclick=async()=>{const m=$('ta-settings-msg');m.textContent='Sincronizando...';try{await syncW3B();m.innerHTML=`<span style="color:#66bb6a">✓ ${Object.keys(items).length} artículos</span>`;setTimeout(()=>passiveAudit(),500)}catch(e){m.innerHTML=`<span style="color:#ff5252">${esc(e.message)}</span>`}};
}
function renderAudit(){
 const c=counts(),list=Object.values(results).filter(x=>x.status==='review'||x.status==='watch').sort((a,b)=>a.status==='review'?-1:1);
 $('ta-view').innerHTML=`<div style="font-size:14px;font-weight:bold">🔍 Auditor</div><div style="margin:5px 0">🔴 ${c.review} · 🟡 ${c.watch} · 🟢 ${c.normal}</div><div style="font-size:10px;opacity:.5;margin-bottom:7px">Resultados guardados. Abrir esta pantalla no vuelve a auditar.</div>${list.map(x=>`<button data-id="${x.id}" style="display:block;width:100%;text-align:left;margin:3px 0;padding:6px;background:#292929;color:#fff;border:0;border-radius:5px">${x.status==='review'?'🔴':'🟡'} ${esc(x.name)}<br><span style="font-size:10px;opacity:.65">W3B ${money(x.w3bBuy)} · Real ${money(x.real?.value)} · Compra ${money(x.recommendedBuy)}</span></button>`).join('')||'<div style="color:#66bb6a">✓ No hay alertas.</div>'}`;
 $('ta-view').querySelectorAll('button[data-id]').forEach(b=>b.onclick=()=>showItem(b.dataset.id));
}
function renderHistory(){
 const entries=Object.entries(history).map(([id,h])=>({id,name:items[id]?.name||db[id]?.name||id,h})).filter(x=>x.h.length).sort((a,b)=>(b.h.at(-1)?.ts||0)-(a.h.at(-1)?.ts||0)).slice(0,30);
 $('ta-view').innerHTML=`<div style="font-size:14px;font-weight:bold">📈 Historial</div><div style="font-size:10px;opacity:.5;margin:4px 0 8px">Observaciones construidas por el auditor.</div>${entries.map(x=>{const last=x.h.at(-1),avg=Math.round(x.h.reduce((s,v)=>s+Number(v.value||0),0)/x.h.length);return `<button data-id="${x.id}" style="display:block;width:100%;text-align:left;margin:3px 0;padding:6px;background:#292929;color:#fff;border:0;border-radius:5px"><b>${esc(x.name)}</b><br><span style="font-size:10px;opacity:.7">Actual ${money(last.value)} · Promedio ${money(avg)} · ${x.h.length} muestras</span></button>`}).join('')||'<div style="opacity:.6">Todavía no hay datos históricos.</div>'}`;
 $('ta-view').querySelectorAll('button[data-id]').forEach(b=>b.onclick=()=>showHistoryItem(b.dataset.id));
}
function showHistoryItem(id){
 const h=history[id]||[],name=items[id]?.name||db[id]?.name||id;
 $('ta-view').innerHTML=`<button id="ta-back-history" style="background:none;color:#aaa;border:0;padding:0">← Historial</button><div style="font-size:14px;font-weight:bold;margin-top:6px">${esc(name)}</div><div style="font-size:10px;opacity:.5;margin:4px 0 7px">${h.length} observaciones</div>${h.slice().reverse().map(x=>`<div style="border-top:1px solid #333;padding:5px 0"><b>${money(x.value)}</b> <span style="font-size:9px;opacity:.55">· ${new Date(x.ts).toLocaleString()}</span><br><span style="font-size:10px;opacity:.65">${money(x.min)} – ${money(x.max)} · ${x.count} listings · ${x.confidence}</span></div>`).join('')||'<div style="opacity:.6">Sin observaciones.</div>'}`;
 $('ta-back-history').onclick=()=>{currentView='history';renderHistory()};
}
async function showItem(id){
 const view=$('ta-view'),cached=results[id];
 currentView='item';
 if(cached&&cached.status!=='error'){renderItem(cached);if(!fresh(id))auditOne(id).then(r=>{if(currentView==='item')renderItem(r)});return}
 view.innerHTML=`<div style="font-weight:bold">${esc(items[id]?.name||id)}</div><div style="margin-top:6px;opacity:.65">Consultando mercado...</div>`;
 const r=await auditOne(id);if(currentView==='item')renderItem(r);updateBadge();
}
function renderItem(x){
 if(!x||x.status==='error'){$('ta-view').innerHTML=`<span style="color:#ff5252">${esc(x?.error||'Error')}</span>`;return}
 $('ta-view').innerHTML=`<div style="font-size:14px;font-weight:bold">${esc(x.name)}</div><div style="margin-top:6px">MV Torn: <b>${money(x.mv)}</b></div><div>W3B compra: <b>${money(x.w3bBuy)}</b></div><div>W3B efectivo: <b>${pct(x.effectivePct)}</b></div><hr style="border:0;border-top:1px solid #333"><div>Valor real estimado: <b>${money(x.real.value)}</b></div><div style="font-size:10px;opacity:.6">Rango ${money(x.real.min)} – ${money(x.real.max)} · ${x.real.count} listings</div><div style="margin-top:3px">Confianza: <b>${x.real.confidence}</b></div><div style="margin-top:8px;color:#66bb6a;font-size:16px;font-weight:bold">Compra recomendada ${money(x.recommendedBuy)}</div><button id="ta-copy-buy" style="padding:5px;background:#455a64;color:#fff;border:0;border-radius:4px">📋 Copiar compra</button><div style="margin-top:8px;color:#64b5f6;font-size:16px;font-weight:bold">Venta recomendada ${money(x.recommendedSell)}</div><button id="ta-copy-sell" style="padding:5px;background:#455a64;color:#fff;border:0;border-radius:4px">📋 Copiar venta</button><div style="margin-top:7px">Estado: ${statusText(x.status)}</div>${x.historical?`<div style="font-size:10px;opacity:.6;margin-top:4px">Histórico propio: ${money(x.historical)}</div>`:''}<div style="font-size:9px;opacity:.45;margin-top:6px">Actualizado ${new Date(x.ts).toLocaleString()}</div>`;
 $('ta-copy-buy').onclick=()=>copy(x.recommendedBuy);$('ta-copy-sell').onclick=()=>copy(x.recommendedSell);
}
function statusText(s){return s==='review'?'<span style="color:#ff5252">🔴 Revisar</span>':s==='watch'?'<span style="color:#ffb74d">🟡 Vigilar</span>':'<span style="color:#66bb6a">🟢 Normal</span>'}
function updateBadge(){const b=$('ta-badge');if(!b)return;const n=counts().review;if(n){b.textContent=n>99?'99+':n;b.style.display='flex'}else b.style.display='none'}
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}
async function copy(v){try{await navigator.clipboard.writeText(String(Math.round(v)));return}catch{}const t=document.createElement('textarea');t.value=String(Math.round(v));document.body.appendChild(t);t.select();try{document.execCommand('copy')}catch{}t.remove()}

async function start(){
 await load();createUI();
 if(apiKey)try{await loadCatalog()}catch{}
 rebuildQueue();await saveQueue();
 if(apiKey&&Object.keys(items).length)setTimeout(passiveAudit,4000);
 setInterval(passiveAudit,REFRESH_MS);setInterval(updateBadge,30000);
}
if(document.body)start();else document.addEventListener('DOMContentLoaded',start);
})();
