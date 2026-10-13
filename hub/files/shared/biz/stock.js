// Stock module page: record stock movements (goods arrived, sell, move, count, damaged/own use) and see what
// the engine (business/core) makes of them: stock per product and store, every movement with undo, and the
// accounts it wrote. Products and stores come from the database; movements are kept by the server (/steps).
import { enhanceSelects } from '../select.js';
import { esc, svg, I, modal, busy, errText, fmt, qty, num, debounce } from './ui.js';
import { makeField } from './fields.js';

export const STOCK_ACTIONS = [
  { kind: 'purchase_receipt', label: 'Goods arrived', hint: 'From a supplier, at cost', icon: I.arrived, words: 'receive purchase goods arrived in delivery from supplier' },
  { kind: 'delivery', label: 'Sell', hint: 'Goods out to a customer', icon: I.sell, words: 'sale sell out customer delivery' },
  { kind: 'transfer', label: 'Move stock', hint: 'Between stores and vans', icon: I.move, words: 'move transfer van store' },
  { kind: 'count', label: 'Stock count', hint: 'Set what is really on the shelf', icon: I.count, words: 'count stocktake reconcile shelf' },
  { kind: 'issue', label: 'Damaged or own use', hint: 'Stock out, not sold', icon: I.damaged, words: 'damaged broken expired own use write off issue' },
];
const ACT = Object.fromEntries(STOCK_ACTIONS.map((a) => [a.kind, a]));
const UNDONE = { label: 'Undone', icon: I.undo };
const ROLE_NAMES = { stock: 'Stock (asset)', cost_of_goods_sold: 'Cost of goods sold', stock_adjustment: 'Stock adjustments', stock_received_not_billed: 'Goods received, bill not yet in', expenses_in_valuation: 'Extra costs added to stock', other: 'Other' };
const tzs = (n) => 'TZS ' + fmt(n);
// '2026-10-13' + '15:43:10' → '13 Oct, 15:43'
const stamp = (s) => { const d = new Date(`${s.date}T00:00:00`); return isNaN(d) ? `${s.date || ''} ${String(s.time || '').slice(0, 5)}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${String(s.time || '').slice(0, 5)}`; };

/** mountStock(el, kit, { action, tab, records(el) }) → leave() */
export function mountStock(el, kit, { action = null, tab: tab0 = null, records = null } = {}) {
  let alive = true, tab = tab0 || 'stock', steps = [], result = null, products = [], stores = [], q = '';
  const rights = kit.stepRights || { read: true, write: true, undo: true };
  const canWrite = !!rights.write, canUndo = !!rights.undo;
  const pName = new Map(), sName = new Map(), names = new Map();
  let total = 0;
  const itemTitle = (id) => pName.get(id) ?? names.get(id) ?? id;
  const storeTitle = (id) => sName.get(id) ?? names.get(id) ?? id;

  el.innerHTML = `<div class="bz-stock">
    <div class="bz-quick" id="bzActs">${STOCK_ACTIONS.map((a, i) => `<button class="bz-act" data-k="${a.kind}" style="--i:${i}"${canWrite ? '' : ' disabled title="Your role can only look"'}><span class="bz-ic">${svg(a.icon)}</span><span><b>${a.label}</b><small>${a.hint}</small></span></button>`).join('')}</div>
    <div class="bz-bar"><div class="seg" id="bzTabs" role="tablist">${[['stock', 'Stock'], ['activity', 'Activity'], ['books', 'Books']].map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="bz-src"><span class="dot"></span>Our own engine</span><span class="bz-grow"></span>
      <label class="bz-search sm" id="bzStockQ"><span class="bz-sr">Filter products</span>${svg(I.search)}<input type="search" placeholder="Filter products…" autocomplete="off"></label></div>
    <div id="bzStockView"><div class="bz-loading"><span class="bz-spin"></span></div></div>
    <div id="bzStockRec"></div>
  </div>`;
  const $ = (s) => el.querySelector(s);
  el.querySelectorAll('.bz-act').forEach((b) => (b.onclick = () => dialog(b.dataset.k)));
  el.querySelectorAll('#bzTabs button').forEach((b) => (b.onclick = () => {
    tab = b.dataset.t;
    el.querySelectorAll('#bzTabs button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    paint();
  }));
  $('#bzStockQ input').addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 120));
  const recLeave = records ? records($('#bzStockRec')) : null;

  async function loadMasters() {
    const all = async (type, filters) => {
      const out = [];
      for (let off = 0; off < 5000; off += 500) {
        const r = await kit.api.list(type, { limit: 500, offset: off, filters, sort: 'title' });
        out.push(...(r?.rows || []));
        if (out.length >= (r?.total ?? 0) || !(r?.rows || []).length) break;
      }
      return out;
    };
    const [p, s] = await Promise.all([all('product'), all('store')]);
    products = p; stores = s;
    products.forEach((x) => pName.set(x.id, x.title || x.name || x.id));
    stores.forEach((x) => sName.set(x.id, x.title || x.name || x.id));
  }
  // movements come newest first, with who made them and whether they were undone
  async function loadSteps() {
    const [r, res] = await Promise.all([kit.api.steps(1000), kit.api.run({})]);
    steps = Array.isArray(r) ? r : r?.steps || [];
    total = r?.total ?? steps.length;
    result = res;
    for (const [id, t] of Object.entries({ ...(r?.titles || {}), ...(res?.titles || {}) })) { names.set(id, t); }
  }
  async function refresh() {
    try { await Promise.all([loadMasters(), loadSteps()]); }
    catch (e) {
      if (!alive) return;
      $('#bzStockView').innerHTML = `<div class="bz-empty card"><b>Could not load stock</b><p>${esc(errText(e))}</p><button class="btn sm" id="bzRetry">Try again</button></div>`;
      $('#bzRetry').onclick = refresh;
      return;
    }
    if (alive) paint();
  }
  // ---------- dialogs
  function dialog(kind) {
    const a = ACT[kind];
    if (!canWrite) return kit.toast('Your role can only look at stock');
    if (!stores.length) return kit.toast('Add a store first (Setup → Stores and vans)');
    if (!products.length) return kit.toast('Add a product first');
    const needsPrice = ['purchase_receipt', 'delivery', 'count'].includes(kind);
    const priceLabel = kind === 'delivery' ? 'Selling price' : 'Cost per unit';
    const storeSel = (id, label) => `<div class="bz-fld"><label class="bz-lbl" for="${id}">${label}</label><select id="${id}">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}${s.type && s.type !== 'Store' ? ` (${esc(s.type)})` : ''}</option>`).join('')}</select></div>`;
    const body = document.createElement('form');
    body.className = 'bz-grid c2';
    body.noValidate = true;
    body.innerHTML = kind === 'transfer' ? `${storeSel('bzFrom', 'From')}${storeSel('bzTo', 'To')}`
      : storeSel('bzWh', kind === 'delivery' ? 'Sold from' : kind === 'count' ? 'Counted in' : kind === 'issue' ? 'Taken from' : 'Into');
    const prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: { is_stock: true } }, null, {
      api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => fill(),
    });
    prod.el.classList.add('wide');
    body.append(prod.el);
    body.insertAdjacentHTML('beforeend', `<div class="bz-fld"><label class="bz-lbl" for="bzQty">${kind === 'count' ? 'Counted quantity' : 'Quantity'}</label><input class="bz-in n" id="bzQty" inputmode="decimal" placeholder="0" autocomplete="off"><small class="bz-ferr" role="alert"></small></div>
      ${needsPrice ? `<div class="bz-fld"><label class="bz-lbl" for="bzRate">${priceLabel}</label><div class="bz-inw adorned"><span class="bz-adorn">TZS</span><input class="bz-in n" id="bzRate" inputmode="decimal" autocomplete="off"></div><small class="bz-ferr" role="alert"></small></div>` : ''}
      <p class="bz-note wide" id="bzNote"></p><button type="submit" hidden></button>`);
    const m = modal({ title: a.label, sub: a.hint, icon: a.icon, body, actions: [{ label: 'Cancel', value: false }, { label: 'Save', pri: true, id: 'bzStepOk', onClick: (_, btn) => save(btn) }] });
    const $d = (s) => m.box.querySelector(s);
    if (kind === 'transfer' && stores[1]) $d('#bzTo').value = stores[1].id;
    enhanceSelects(body);
    body.querySelectorAll('select').forEach((s) => s.addEventListener('change', fill));
    body.onsubmit = (e) => { e.preventDefault(); save($d('#bzStepOk')); };
    requestAnimationFrame(() => prod.focus());
    let priceSeq = 0;
    // one id per dialog: if a save times out but did reach the server, pressing Save again returns that
    // movement instead of recording it twice (the server keeps each id once)
    const clientId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    async function fill() {
      const item = prod.get();
      const wh = $d('#bzWh')?.value || $d('#bzFrom').value;
      if (!item) { $d('#bzNote').textContent = ''; return; }
      const b = result?.balances?.find((x) => x.item === item && x.warehouse === wh);
      $d('#bzNote').textContent = `${storeTitle(wh)} has ${qty(b?.qty || 0)} now${b?.qty ? ` · average cost ${tzs(b.valuationRate)}` : ''}`;
      if (!$d('#bzRate')) return;
      if (kind !== 'delivery' && b?.valuationRate) { $d('#bzRate').value = fmt(b.valuationRate); return; }
      const my = ++priceSeq;
      const p = await priceOf(item, kind === 'delivery' ? 'Selling' : 'Buying').catch(() => null);
      if (my === priceSeq && p !== null && m.el.isConnected) $d('#bzRate').value = fmt(p);
      else if (my === priceSeq && kind !== 'delivery') $d('#bzRate').value = '';
    }
    async function save(btn) {
      const item = prod.get();
      const qv = num($d('#bzQty').value), rv = needsPrice ? num($d('#bzRate').value) : null;
      const errQ = $d('#bzQty').parentElement.querySelector('.bz-ferr'), errR = $d('#bzRate')?.closest('.bz-fld').querySelector('.bz-ferr');
      prod.error(''); errQ.textContent = ''; if (errR) errR.textContent = '';
      if (!item) { prod.error('Choose a product'); return prod.focus(); }
      if (!(qv > 0) && !(kind === 'count' && qv === 0)) { errQ.textContent = 'Enter a quantity'; return $d('#bzQty').focus(); }
      if (needsPrice && !(rv > 0)) { errR.textContent = 'Enter a price'; return $d('#bzRate').focus(); }
      const line = { item, qty: qv, ...(needsPrice ? { rate: rv } : {}) };
      let step;
      if (kind === 'transfer') {
        if ($d('#bzFrom').value === $d('#bzTo').value) return kit.toast('Choose two different places');
        step = { kind, from: $d('#bzFrom').value, to: $d('#bzTo').value, lines: [line], client_id: clientId };
      } else step = { kind, warehouse: $d('#bzWh').value, lines: [line], client_id: clientId };
      await busy(btn, async () => {
        const ok = await add(step);
        if (ok) m.close(true);
      });
    }
  }
  /** Price of a product from the price lists of a kind (Selling/Buying): the stock-unit price, else none. */
  async function priceOf(item, kind) {
    const [rows, lists] = await Promise.all([
      kit.api.list('item_price', { filters: { product: item }, limit: 50 }).then((r) => r?.rows || []),
      kit.api.options('price_list', '', { type: kind }).then((r) => new Set((Array.isArray(r) ? r : []).map((x) => x.id))),
    ]);
    const hit = rows.find((r) => lists.has(r.price_list) && !r.unit) || rows.find((r) => lists.has(r.price_list));
    return hit ? Number(hit.rate) : null;
  }

  /** Send a step; a refused one is explained in plain words. Returns true when it was kept. */
  async function add(step) {
    try {
      await kit.api.addStep(step);
      kit.toast(`${ACT[step.kind]?.label || 'Done'} ✓`);
      await loadSteps().catch(() => {});
      if (alive) paint();
      return true;
    } catch (e) {
      kit.toast(plain(errText(e)));
      return false;
    }
  }
  // "12 units of Sugar needed in Stores on …" → "Not enough Sugar in Stores: 12 short"
  function plain(msg) {
    const s = /(\d[\d.,]*) units? of (.+?) needed in (.+?)(?: on|$)/.exec(msg);
    return s ? `Not enough ${itemTitle(s[2])} in ${storeTitle(s[3])}: ${s[1]} short` : msg.startsWith('Not ') ? msg : `Not done: ${msg}`;
  }
  async function undo(id, btn) {
    await busy(btn, async () => {
      try {
        await kit.api.undoStep(id);
        kit.toast('Undone ✓');
        await loadSteps();
        if (alive) paint();
      } catch (e) { kit.toast(plain(errText(e))); }
    });
  }

  // ---------- painting
  function paint() {
    const v = $('#bzStockView');
    $('#bzStockQ').hidden = tab !== 'stock';
    if (!products.length || !stores.length) {
      v.innerHTML = `<div class="bz-empty card"><span class="bz-ic big">${svg(I.stock)}</span><b>${!stores.length ? 'Add a store first' : 'Add your products first'}</b>
        <p>${!stores.length ? 'Stock is kept per store or van.' : 'Stock movements are recorded for products. Add them one by one or import a CSV.'}</p>
        <button class="btn pri sm" data-go="${!stores.length ? 'n/store' : 'n/product'}">${svg(I.plus)}${!stores.length ? 'New store' : 'New product'}</button></div>`;
      v.querySelector('[data-go]').onclick = (e) => kit.nav(e.currentTarget.dataset.go);
      return;
    }
    if (!steps.length) {
      v.innerHTML = `<div class="bz-empty card"><span class="bz-ic big">${svg(I.arrived)}</span><b>No stock yet</b><p>Start with <i>Goods arrived</i> to bring stock in, or a <i>Stock count</i> to set what is on the shelves today.</p>
        ${canWrite ? `<div class="bz-acts2"><button class="btn pri sm" data-k="purchase_receipt">${svg(I.arrived)}Goods arrived</button><button class="btn sm" data-k="count">${svg(I.count)}Stock count</button></div>` : ''}</div>`;
      v.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => dialog(b.dataset.k)));
      return;
    }
    v.innerHTML = tab === 'stock' ? stockView() : tab === 'activity' ? activityView() : booksView();
    v.querySelectorAll('[data-undo]').forEach((b) => (b.onclick = () => undo(b.dataset.undo, b)));
    v.querySelectorAll('[data-prod]').forEach((b) => (b.onclick = () => kit.nav(`d/product/${b.dataset.prod}`)));
  }

  function stockView() {
    const bal = result?.balances || [];
    const ids = [...new Set(bal.map((b) => b.item))];
    const list = ids.map((id) => ({ id, title: itemTitle(id) })).filter((x) => !q || x.title.toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title));
    const without = products.filter((p) => !ids.includes(p.id)).length;
    if (!list.length) return `<div class="bz-empty card"><b>No product matches “${esc(q)}”</b></div>`;
    return `<div class="bz-sgrid">${list.map((it, i) => {
      const b = bal.filter((x) => x.item === it.id);
      const qn = b.reduce((s, x) => s + x.qty, 0), vn = b.reduce((s, x) => s + x.value, 0);
      return `<button class="card bz-sitem" style="--i:${Math.min(i, 14)}" data-prod="${esc(it.id)}"><span class="bz-sih"><span class="bz-ic sm bz-let">${esc((it.title[0] || '?').toUpperCase())}</span></span>
        <b class="bz-sname">${esc(it.title)}</b>
        <span class="bz-sq${qn <= 0 ? ' out' : ''}">${qty(qn)} <small>in stock</small></span>
        <span class="bz-swh">${b.filter((x) => x.qty !== 0 || b.length === 1).map((x) => `<span>${esc(storeTitle(x.warehouse))} <b>${qty(x.qty)}</b></span>`).join('')}</span>
        <span class="bz-siv"><span>Value ${tzs(vn)}</span><span>${qn ? 'Avg ' + tzs(vn / qn) : ''}</span></span></button>`;
    }).join('')}</div>${without && !q ? `<p class="bz-note">${qty(without)} other product${without === 1 ? ' has' : 's have'} no stock movements yet.</p>` : ''}`;
  }

  function activityView() {
    const rows = result?.stock || [];
    const cancelled = new Set(steps.filter((s) => s.undone).map((s) => s.id).concat(steps.filter((s) => s.kind === 'cancel').map((s) => s.target)));
    return `<section class="card bz-alist">${steps.map((s) => {
      const err = result?.errors?.find((e) => e.step === s.id);
      const target = s.kind === 'cancel' ? steps.find((x) => x.id === s.target) : null;
      const a = ACT[s.kind] || UNDONE;
      const my = rows.filter((r) => r.step === s.id);
      const where = s.kind === 'transfer' ? `${storeTitle(s.from)} → ${storeTitle(s.to)}` : s.warehouse ? storeTitle(s.warehouse) : '';
      const lines = s.lines ? s.lines.map((l) => `${qty(l.qty)} × ${esc(itemTitle(l.item))}${l.rate && s.kind !== 'count' ? ` @ ${fmt(l.rate)}` : ''}`).join(', ')
        : `${esc(ACT[target?.kind]?.label || 'Movement')}${target ? ` of ${esc(stamp(target))}` : ''}`;
      const gone = cancelled.has(s.id);
      return `<div class="bz-arow${err ? ' bad' : ''}${gone ? ' gone' : ''}"><span class="bz-ic sm">${svg(a.icon)}</span>
        <div class="bz-am"><b>${esc(a.label)}</b> <small>${[where, s.by ? names.get(s.by) : ''].filter(Boolean).map(esc).join(' · ')}</small><div>${lines}</div>
          ${err ? `<div class="bz-err">${esc(plain(err.message))}</div>` : my.length ? `<div class="bz-asl">${my.map((r) => `<span>${esc(itemTitle(r.item))} @ ${esc(storeTitle(r.warehouse))}: ${r.qty > 0 ? '+' : ''}${qty(r.qty)} → ${qty(r.qtyAfter)} · ${r.valueChange >= 0 ? '+' : '−'}${fmt(Math.abs(r.valueChange))}</span>`).join('')}</div>` : ''}</div>
        <div class="bz-ar"><small>${esc(stamp(s))}</small>${s.kind !== 'cancel' && !err && !gone && canUndo ? `<button class="tbtn" data-undo="${esc(s.id)}">${svg(I.undo)}Undo</button>` : gone ? '<small>undone</small>' : ''}</div></div>`;
    }).join('')}</section>${total > steps.length ? `<p class="bz-note">Showing the latest ${qty(steps.length)} of ${qty(total)} movements.</p>` : ''}`;
  }

  function booksView() {
    const led = result?.ledger || [], bal = result?.balances || [];
    const sum = (role) => led.filter((l) => l.role === role).reduce((s, l) => s + (l.debit - l.credit), 0);
    const stockValue = bal.reduce((s, b) => s + b.value, 0);
    const cancelled = new Set(steps.filter((s) => s.undone).map((s) => s.id));
    const sold = steps.filter((s) => s.kind === 'delivery' && !cancelled.has(s.id) && !result?.errors?.some((e) => e.step === s.id))
      .reduce((s, st) => s + st.lines.reduce((x, l) => x + l.qty * (l.rate || 0), 0), 0);
    const cogs = sum('cost_of_goods_sold');
    const margin = sold - cogs;
    const roles = Object.keys(ROLE_NAMES).filter((r) => led.some((l) => l.role === r));
    return `<div class="bz-kpis">
        <section class="card bz-k"><small>Stock value now</small><b>${tzs(stockValue)}</b></section>
        <section class="card bz-k"><small>Sales (at selling price)</small><b>${tzs(sold)}</b></section>
        <section class="card bz-k"><small>Cost of what was sold</small><b>${tzs(cogs)}</b></section>
        <section class="card bz-k"><small>Gross profit</small><b class="${margin >= 0 ? 'ok' : 'bad'}">${tzs(margin)}</b></section></div>
      <section class="card bz-sec"><h3>Accounts the engine wrote</h3>
        <div class="bz-books"><div class="bz-br bz-bh"><span>Account</span><span>Debit</span><span>Credit</span><span>Balance</span></div>
        ${roles.map((r) => { const d = led.filter((l) => l.role === r).reduce((s, l) => s + l.debit, 0), c = led.filter((l) => l.role === r).reduce((s, l) => s + l.credit, 0); return `<div class="bz-br"><span>${ROLE_NAMES[r]}</span><span data-l="Debit">${fmt(d)}</span><span data-l="Credit">${fmt(c)}</span><span data-l="Balance"><b>${fmt(d - c)}</b></span></div>`; }).join('')}</div>
        <p class="bz-note">Debits equal credits for every movement. Sales money, customers owing and VAT come with the Money module (phase 3).</p></section>`;
  }

  refresh().then(() => { if (alive && action && ACT[action]) dialog(action); });
  return () => { alive = false; recLeave?.(); };
}
