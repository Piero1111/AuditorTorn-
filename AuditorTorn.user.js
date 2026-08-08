// ==UserScript==
// @name         Torn Auditor
// @namespace    torn-pda-auditor
// @version      1.0.0
// @description  Auditor de precios y calculadora de compra/venta para Torn.
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/Piero1111/AuditorTorn-/main/AuditorTorn.user.js
// @downloadURL  https://raw.githubusercontent.com/Piero1111/AuditorTorn-/main/AuditorTorn.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Evita duplicados cuando Torn/PDA reinicializa el userscript.
    if (window.__TBP_V1__) return;
    window.__TBP_V1__ = true;

    const W3B = 'https://weav3r.dev/api';
    const TORN = 'https://api.torn.com';

    const KEY = {
        api: 'tbp_api',
        uid: 'tbp_uid',
        items: 'tbp_items',
        db: 'tbp_db',
        history: 'tbp_history',
        results: 'tbp_results',
        queue: 'tbp_queue',
        pos: 'tbp_pos',
        lastAudit: 'tbp_last_audit'
    };

    const CHECK_AFTER = 1000 * 60 * 30; // 30 min
    const ITEM_DELAY = 1800;
    const MAX_HISTORY = 30;
    const WATCH_DIFF = 0.15;
    const REVIEW_DIFF = 0.30;

    let apiKey = '';
    let userId = '';
    let myItems = {};
    let db = {};
    let history = {};
    let results = {};
    let auditQueue = [];
    let auditing = false;

    function $(id) {
        return document.getElementById(id);
    }

    async function gmGet(key, fallback = null) {
        try {
            return typeof GM_getValue === 'function'
                ? await GM_getValue(key, fallback)
                : fallback;
        } catch {
            return fallback;
        }
    }

    async function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') {
                await GM_setValue(key, value);
            }
        } catch {}
    }

    async function loadStorage() {
        apiKey = await gmGet(KEY.api, '') || '';
        userId = await gmGet(KEY.uid, '') || '';

        try { myItems = JSON.parse(await gmGet(KEY.items, '{}')) || {}; }
        catch { myItems = {}; }

        try { db = JSON.parse(await gmGet(KEY.db, '{}')) || {}; }
        catch { db = {}; }

        try { history = JSON.parse(await gmGet(KEY.history, '{}')) || {}; }
        catch { history = {}; }

        try { results = JSON.parse(await gmGet(KEY.results, '{}')) || {}; }
        catch { results = {}; }

        try { auditQueue = JSON.parse(await gmGet(KEY.queue, '[]')) || []; }
        catch { auditQueue = []; }
    }

    async function saveItems() { await gmSet(KEY.items, JSON.stringify(myItems)); }
    async function saveDb() { await gmSet(KEY.db, JSON.stringify(db)); }
    async function saveHistory() { await gmSet(KEY.history, JSON.stringify(history)); }
    async function saveResults() { await gmSet(KEY.results, JSON.stringify(results)); }
    async function saveQueue() { await gmSet(KEY.queue, JSON.stringify(auditQueue)); }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function httpGet(url) {
        if (typeof PDA_httpGet !== 'function') {
            throw new Error('PDA_httpGet no está disponible');
        }

        const response = await PDA_httpGet(url);

        if (!response || typeof response.responseText !== 'string') {
            throw new Error('Respuesta vacía');
        }

        const data = JSON.parse(response.responseText);

        if (data && data.error) {
            throw new Error(data.message || data.error.error || data.error);
        }

        return data;
    }

    function money(value) {
        return '$' + Math.round(Number(value) || 0).toLocaleString('en-US');
    }

    function pct(value) {
        return (Number(value || 0) * 100).toFixed(1) + '%';
    }

    async function loadTornCatalog() {
        if (!apiKey) return;

        if (Object.keys(db).length) return;

        const data = await httpGet(
            `${TORN}/torn/?selections=items&key=${encodeURIComponent(apiKey)}`
        );

        for (const [id, item] of Object.entries(data.items || {})) {
            db[id] = {
                name: item.name || '',
                mv: Number(
                    item.market_value ??
                    item.marketValue ??
                    item.value ??
                    0
                )
            };
        }

        await saveDb();
    }

    async function syncW3B() {
        if (!userId) throw new Error('Falta Torn ID');

        const data = await httpGet(`${W3B}/pricelist/${userId}`);

        if (!Array.isArray(data)) {
            throw new Error('Respuesta W3B inesperada');
        }

        for (const entry of data) {
            const id = String(entry.itemId);
            const old = myItems[id] || {};

            myItems[id] = {
                ...old,
                name: entry.name || db[id]?.name || '',
                buy: Number(entry.buyPrice) || 0
            };
        }

        rebuildQueue();
        await saveItems();
        await saveQueue();
    }

    function rebuildQueue() {
        const ids = Object.keys(myItems);

        ids.sort((a, b) => {
            const ta = history[a]?.at(-1)?.ts || 0;
            const tb = history[b]?.at(-1)?.ts || 0;
            return ta - tb;
        });

        const existing = new Set(auditQueue);
        auditQueue = [
            ...auditQueue.filter(id => myItems[id]),
            ...ids.filter(id => !existing.has(id))
        ];
    }

    async function getMarketplace(itemId) {
        const data = await httpGet(`${W3B}/marketplace/${itemId}`);

        const listings = Array.isArray(data.listings)
            ? data.listings
                .map(x => ({
                    price: Number(x.price),
                    qty: Math.max(1, Number(x.quantity) || 1)
                }))
                .filter(x => x.price > 1)
            : [];

        if (!listings.length) {
            throw new Error('Sin listings');
        }

        return {
            listings,
            marketPrice: Number(data.market_price) || 0,
            bazaarAverage: Number(data.bazaar_average) || 0
        };
    }

    function calculateRealValue(listings) {
        const sorted = [...listings].sort((a, b) => a.price - b.price);
        const prices = sorted.map(x => x.price);

        const q1 = prices[Math.floor((prices.length - 1) * 0.25)];
        const q3 = prices[Math.floor((prices.length - 1) * 0.75)];
        const iqr = q3 - q1;

        let filtered = sorted;

        if (iqr > 0) {
            const low = q1 - iqr * 1.5;
            const high = q3 + iqr * 1.5;
            filtered = sorted.filter(x => x.price >= low && x.price <= high);
        }

        if (!filtered.length) filtered = sorted;

        let totalQty = 0;
        let weightedTotal = 0;

        for (const x of filtered) {
            const qty = Math.min(x.qty, 100);
            totalQty += qty;
            weightedTotal += x.price * qty;
        }

        const weightedAverage = weightedTotal / totalQty;
        const median = filtered[Math.floor(filtered.length / 2)].price;

        // Combinamos mediana y promedio ponderado para reducir
        // el efecto de un único bazar muy grande o muy barato.
        const value = Math.round((median * 0.65) + (weightedAverage * 0.35));

        const min = Math.min(...filtered.map(x => x.price));
        const max = Math.max(...filtered.map(x => x.price));

        const spread = value > 0 ? (max - min) / value : 1;

        let confidence = 'Baja';

        if (filtered.length >= 30 && spread <= 0.35) confidence = 'Alta';
        else if (filtered.length >= 10 && spread <= 0.60) confidence = 'Media';

        return {
            value,
            min,
            max,
            count: filtered.length,
            confidence
        };
    }

    function getHistoricalAverage(itemId) {
        const h = history[itemId] || [];

        const values = h
            .map(x => Number(x.value))
            .filter(x => x > 0);

        if (!values.length) return 0;

        return Math.round(
            values.reduce((a, b) => a + b, 0) / values.length
        );
    }

    async function saveObservation(itemId, real) {
        if (!history[itemId]) history[itemId] = [];

        history[itemId].push({
            ts: Date.now(),
            value: real.value,
            min: real.min,
            max: real.max,
            count: real.count,
            confidence: real.confidence
        });

        if (history[itemId].length > MAX_HISTORY) {
            history[itemId] = history[itemId].slice(-MAX_HISTORY);
        }

        await saveHistory();
    }

    async function analyze(itemId) {
        const item = myItems[itemId];

        if (!item) throw new Error('Artículo no encontrado');

        const market = await getMarketplace(itemId);
        const real = calculateRealValue(market.listings);

        const mv = Number(db[itemId]?.mv || 0);
        const w3bBuy = Number(item.buy || 0);

        // El porcentaje se obtiene comparando el precio W3B
        // con el MV de Torn. No usamos un porcentaje global.
        const effectivePct = mv > 0 && w3bBuy > 0
            ? w3bBuy / mv
            : 0;

        // Si W3B propone comprar al X% del MV,
        // aplicamos ese mismo porcentaje al valor real estimado.
        const recommendedBuy = effectivePct > 0
            ? Math.round(real.value * effectivePct)
            : 0;

        // La mitad del descuento de compra se usa para venta.
        const discount = 1 - effectivePct;

        const recommendedSell = effectivePct > 0
            ? Math.round(real.value * (1 - discount / 2))
            : 0;

        const historical = getHistoricalAverage(itemId);

        let status = 'normal';

        if (recommendedBuy > 0 && w3bBuy > 0) {
            const difference =
                Math.abs(w3bBuy - recommendedBuy) / recommendedBuy;

            if (difference >= REVIEW_DIFF) status = 'review';
            else if (difference >= WATCH_DIFF) status = 'watch';
        }

        const result = {
            id: itemId,
            name: item.name || db[itemId]?.name || itemId,
            mv,
            w3bBuy,
            effectivePct,
            real,
            historical,
            recommendedBuy,
            recommendedSell,
            bazaarAverage: market.bazaarAverage,
            marketPrice: market.marketPrice,
            status,
            ts: Date.now()
        };

        results[itemId] = result;
        await saveResults();

        return result;
    }

    async function auditOne(itemId) {
        try {
            const result = await analyze(itemId);
            await saveObservation(itemId, result.real);
            return result;
        } catch (error) {
            results[itemId] = {
                ...(results[itemId] || {}),
                id: itemId,
                name: myItems[itemId]?.name || db[itemId]?.name || itemId,
                status: 'error',
                error: error.message,
                ts: Date.now()
            };

            await saveResults();
            return results[itemId];
        }
    }

    function needsRefresh(itemId) {
        const last = results[itemId]?.ts || 0;
        return Date.now() - last >= CHECK_AFTER;
    }

    async function passiveAudit() {
        if (auditing || !apiKey || !Object.keys(myItems).length) return;

        auditing = true;

        try {
            rebuildQueue();

            while (auditQueue.length && apiKey) {
                const id = auditQueue.shift();
                await saveQueue();

                if (!myItems[id]) continue;

                // Si ya hay información reciente, no hacemos otra petición.
                if (!needsRefresh(id)) continue;

                await auditOne(id);

                updateBadge();
                updateStatus();

                await sleep(ITEM_DELAY);
            }

            // Nueva ronda: solo cuando corresponda por antigüedad.
            rebuildQueue();
            await saveQueue();
            await gmSet(KEY.lastAudit, String(Date.now()));

        } finally {
            auditing = false;
            updateBadge();
            updateStatus();
        }
    }

    function getCounts() {
        let review = 0;
        let watch = 0;
        let normal = 0;

        for (const id of Object.keys(myItems)) {
            const r = results[id];
            if (!r) continue;

            if (r.status === 'review') review++;
            else if (r.status === 'watch') watch++;
            else if (r.status === 'normal') normal++;
        }

        return { review, watch, normal };
    }

    function createUI() {
        if ($('tbp-floating') || $('tbp-panel')) return;

        const button = document.createElement('div');
        button.id = 'tbp-floating';
        button.textContent = '💰';

        Object.assign(button.style, {
            position: 'fixed',
            right: '16px',
            bottom: '90px',
            width: '38px',
            height: '38px',
            borderRadius: '50%',
            background: '#1565c0',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '17px',
            cursor: 'pointer',
            zIndex: '2147483647',
            boxShadow: '0 3px 10px rgba(0,0,0,.5)',
            userSelect: 'none'
        });

        const badge = document.createElement('span');
        badge.id = 'tbp-badge';

        Object.assign(badge.style, {
            position: 'absolute',
            right: '-5px',
            top: '-5px',
            background: '#d32f2f',
            color: '#fff',
            borderRadius: '10px',
            minWidth: '15px',
            height: '15px',
            padding: '0 2px',
            fontSize: '9px',
            display: 'none',
            alignItems: 'center',
            justifyContent: 'center'
        });

        button.appendChild(badge);
        document.body.appendChild(button);

        const panel = document.createElement('div');
        panel.id = 'tbp-panel';

        Object.assign(panel.style, {
            position: 'fixed',
            right: '14px',
            bottom: '136px',
            width: '260px',
            maxHeight: '72vh',
            overflowY: 'auto',
            background: '#1e1e1e',
            color: '#fff',
            border: '1px solid #444',
            borderRadius: '10px',
            padding: '9px',
            fontFamily: 'Arial,sans-serif',
            fontSize: '12px',
            zIndex: '2147483646',
            boxShadow: '0 5px 20px rgba(0,0,0,.6)',
            display: 'none'
        });

        panel.innerHTML = `
            <div style="display:flex;gap:5px;margin-bottom:7px;">
                <input id="tbp-search"
                    placeholder="Buscar artículo..."
                    autocomplete="off"
                    style="flex:1;background:#292929;color:#fff;border:1px solid #555;border-radius:5px;padding:6px;font-size:12px;">
                <button id="tbp-audit"
                    style="background:#455a64;color:#fff;border:0;border-radius:5px;padding:5px 7px;cursor:pointer;">
                    🔍
                </button>
            </div>

            <div id="tbp-suggestions"></div>
            <div id="tbp-content"></div>

            <div id="tbp-home">
                <b>Auditor pasivo</b>
                <div id="tbp-status" style="margin-top:4px;opacity:.7;">
                    Preparando...
                </div>

                <button id="tbp-sync"
                    style="width:100%;margin-top:8px;padding:6px;background:#6a1b9a;color:#fff;border:0;border-radius:5px;cursor:pointer;">
                    Sincronizar W3B
                </button>

                <div style="font-size:10px;opacity:.55;margin-top:7px;">
                    La auditoría continúa automáticamente en segundo plano.
                </div>
            </div>

            <div style="margin-top:8px;border-top:1px solid #333;padding-top:7px;">
                <label style="font-size:10px;opacity:.7;">Torn API Key</label>
                <input id="tbp-api" type="text"
                    style="width:100%;box-sizing:border-box;background:#292929;color:#fff;border:1px solid #555;border-radius:4px;padding:4px;">

                <label style="font-size:10px;opacity:.7;">Torn ID</label>
                <input id="tbp-uid" type="number"
                    style="width:100%;box-sizing:border-box;background:#292929;color:#fff;border:1px solid #555;border-radius:4px;padding:4px;">
            </div>
        `;

        document.body.appendChild(panel);

        $('tbp-api').value = apiKey;
        $('tbp-uid').value = userId;

        button.addEventListener('click', () => {
            panel.style.display =
                panel.style.display === 'none' ? 'block' : 'none';

            if (panel.style.display === 'block') {
                showAudit(false);
            }
        });

        $('tbp-audit').addEventListener('click', () => {
            // IMPORTANTE: esto solo muestra resultados guardados.
            // NO vuelve a ejecutar el auditor.
            showAudit(false);
        });

        $('tbp-sync').addEventListener('click', async () => {
            $('tbp-status').textContent = 'Sincronizando W3B...';

            try {
                await syncW3B();

                $('tbp-status').textContent =
                    `✓ ${Object.keys(myItems).length} artículos sincronizados`;

                updateBadge();
            } catch (e) {
                $('tbp-status').innerHTML =
                    `<span style="color:#ff5252">${e.message}</span>`;
            }
        });

        $('tbp-api').addEventListener('change', async e => {
            apiKey = e.target.value.trim();
            await gmSet(KEY.api, apiKey);
        });

        $('tbp-uid').addEventListener('change', async e => {
            userId = e.target.value.trim();
            await gmSet(KEY.uid, userId);
        });

        const search = $('tbp-search');

        search.addEventListener('input', () => {
            const query = search.value.trim().toLowerCase();
            const box = $('tbp-suggestions');

            box.innerHTML = '';

            // No mostrar sugerencias al simplemente tocar la caja.
            if (query.length < 2) return;

            const matches = Object.entries(myItems)
                .filter(([id, item]) =>
                    (item.name || '').toLowerCase().includes(query)
                )
                .slice(0, 8);

            for (const [id, item] of matches) {
                const suggestion = document.createElement('button');

                suggestion.textContent = item.name;

                Object.assign(suggestion.style, {
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '5px',
                    marginBottom: '2px',
                    background: '#292929',
                    color: '#fff',
                    border: '0',
                    borderRadius: '4px',
                    cursor: 'pointer'
                });

                suggestion.onclick = () => {
                    box.innerHTML = '';
                    search.value = item.name;
                    showItem(id);
                };

                box.appendChild(suggestion);
            }
        });

        updateBadge();
        updateStatus();
    }

    function showItem(id) {
        const item = results[id];

        $('tbp-home').style.display = 'none';
        $('tbp-content').innerHTML = '';

        if (!item) {
            $('tbp-content').innerHTML =
                '<div style="opacity:.6">Este artículo todavía no ha sido auditado.</div>';
            return;
        }

        if (item.status === 'error') {
            $('tbp-content').innerHTML =
                `<span style="color:#ff5252">${item.error}</span>`;
            return;
        }

        const content = $('tbp-content');

        content.innerHTML = `
            <div style="font-size:14px;font-weight:bold;">
                ${item.name}
            </div>

            <div style="margin-top:6px;">
                MV Torn:
                <b>${money(item.mv)}</b>
            </div>

            <div>
                W3B compra:
                <b>${money(item.w3bBuy)}</b>
            </div>

            <div>
                W3B efectivo:
                <b>${pct(item.effectivePct)}</b>
            </div>

            <hr style="border:0;border-top:1px solid #333;">

            <div>
                Valor real estimado:
                <b>${money(item.real.value)}</b>
            </div>

            <div style="font-size:10px;opacity:.6;">
                Rango ${money(item.real.min)}
                – ${money(item.real.max)}
                · ${item.real.count} listings
            </div>

            <div style="margin-top:3px;">
                Confianza:
                <b>${item.real.confidence}</b>
            </div>

            <div style="margin-top:7px;color:#66bb6a;font-size:16px;font-weight:bold;">
                Compra recomendada ${money(item.recommendedBuy)}
            </div>

            <button id="tbp-copy-buy"
                style="margin-top:4px;padding:5px;background:#455a64;color:#fff;border:0;border-radius:4px;cursor:pointer;">
                📋 Copiar compra
            </button>

            <div style="margin-top:8px;color:#64b5f6;font-size:16px;font-weight:bold;">
                Venta recomendada ${money(item.recommendedSell)}
            </div>

            <button id="tbp-copy-sell"
                style="margin-top:4px;padding:5px;background:#455a64;color:#fff;border:0;border-radius:4px;cursor:pointer;">
                📋 Copiar venta
            </button>

            <div style="margin-top:8px;">
                Estado:
                ${statusText(item.status)}
            </div>

            ${item.historical ? `
                <div style="font-size:10px;opacity:.6;margin-top:3px;">
                    Histórico propio: ${money(item.historical)}
                </div>
            ` : ''}

            <div style="font-size:9px;opacity:.45;margin-top:6px;">
                Actualizado: ${new Date(item.ts).toLocaleString()}
            </div>
        `;

        $('tbp-copy-buy').onclick =
            () => copy(item.recommendedBuy);

        $('tbp-copy-sell').onclick =
            () => copy(item.recommendedSell);
    }

    function showAudit() {
        $('tbp-home').style.display = 'none';

        const content = $('tbp-content');
        const counts = getCounts();

        const ordered = Object.values(results)
            .filter(x => x.status === 'review' || x.status === 'watch')
            .sort((a, b) => {
                const priority = { review: 0, watch: 1 };
                return priority[a.status] - priority[b.status];
            });

        content.innerHTML = `
            <div style="font-size:14px;font-weight:bold;margin-bottom:7px;">
                🔍 Auditor
            </div>

            <div>
                🔴 Revisar:
                <b>${counts.review}</b>
            </div>

            <div>
                🟡 Vigilar:
                <b>${counts.watch}</b>
            </div>

            <div>
                🟢 Normal:
                <b>${counts.normal}</b>
            </div>

            <div style="font-size:10px;opacity:.5;margin-top:4px;">
                Solo se muestran resultados ya analizados.
            </div>

            <hr style="border:0;border-top:1px solid #333;">

            ${ordered.map(x => `
                <button
                    data-id="${x.id}"
                    style="display:block;width:100%;text-align:left;margin:4px 0;padding:6px;background:#292929;color:#fff;border:0;border-radius:5px;cursor:pointer;">
                    ${x.status === 'review' ? '🔴' : '🟡'}
                    ${x.name}
                    <br>
                    <span style="font-size:10px;opacity:.65;">
                        W3B ${money(x.w3bBuy)}
                        · Real ${money(x.real?.value || 0)}
                        · Compra ${money(x.recommendedBuy)}
                    </span>
                </button>
            `).join('')}

            ${ordered.length === 0 ? `
                <div style="color:#66bb6a;margin-top:6px;">
                    ✓ No hay alertas.
                </div>
            ` : ''}
        `;

        content.querySelectorAll('button[data-id]').forEach(button => {
            button.onclick = () => showItem(button.dataset.id);
        });
    }

    function getCounts() {
        let review = 0;
        let watch = 0;
        let normal = 0;

        for (const id of Object.keys(myItems)) {
            const r = results[id];
            if (!r) continue;

            if (r.status === 'review') review++;
            else if (r.status === 'watch') watch++;
            else if (r.status === 'normal') normal++;
        }

        return { review, watch, normal };
    }

    function statusText(status) {
        if (status === 'review')
            return '<span style="color:#ff5252">🔴 Revisar</span>';

        if (status === 'watch')
            return '<span style="color:#ffb74d">🟡 Vigilar</span>';

        return '<span style="color:#66bb6a">🟢 Normal</span>';
    }

    function updateBadge() {
        const badge = $('tbp-badge');
        if (!badge) return;

        const { review } = getCounts();

        if (review > 0) {
            badge.textContent = review > 99 ? '99+' : review;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }

    function updateStatus() {
        const status = $('tbp-status');
        if (!status) return;

        const count = Object.keys(myItems).length;

        if (!count) {
            status.textContent = 'Sin artículos sincronizados.';
            return;
        }

        const pending = auditQueue.filter(id => myItems[id]).length;

        status.textContent =
            `${count} artículos · ${pending} pendientes · ` +
            (auditing ? 'auditando...' : 'auditor activo');
    }

    async function copy(value) {
        const text = String(Math.round(value));

        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {}

        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();

        try { document.execCommand('copy'); } catch {}

        textarea.remove();
    }

    async function start() {
        await loadStorage();
        createUI();

        if (apiKey) {
            try {
                await loadTornCatalog();
            } catch (e) {
                console.warn('[TBP] Catálogo:', e.message);
            }
        }

        rebuildQueue();
        await saveQueue();

        // Arranca el auditor una sola vez después de cargar la interfaz.
        if (apiKey && Object.keys(myItems).length) {
            setTimeout(passiveAudit, 5000);
        }

        // El intervalo solo comprueba si hay trabajo pendiente.
        setInterval(() => {
            if (apiKey && Object.keys(myItems).length) {
                passiveAudit();
            }
        }, CHECK_AFTER);

        setInterval(updateBadge, 30000);
        setInterval(updateStatus, 30000);
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);

})();
