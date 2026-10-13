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
  { kind: 'receipt', label: 'Stock in', hint: 'Found or returned stock, no supplier', icon: I.plus, words: 'stock in found extra receipt no supplier' },
  { kind: 'landed_cost', label: 'Landed cost', hint: 'Transport, clearing, duty on goods', icon: I.arrived, words: 'landed cost transport freight clearing duty extra cost' },
];
const ACT = Object.fromEntries(STOCK_ACTIONS.map((a) => [a.kind, a]));
const UNDONE = { label: 'Undone', icon: I.undo };
const ROLE_NAMES = { stock: 'Stock (asset)', cost_of_goods_sold: 'Cost of goods sold', stock_adjustment: 'Stock adjustments', stock_received_not_billed: 'Goods received, bill not yet in', expenses_in_valuation: 'Extra costs added to stock', other: 'Other' };
const tzs = (n) => 'TZS ' + fmt(n);
// '2026-10-13' + '15:43:10' → '13 Oct, 15:43'
const stamp = (s) => { const d = new Date(`${s.date}T00:00:00`); return isNaN(d) ? `${s.date || ''} ${String(s.time || '').slice(0, 5)}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${String(s.time || '').slice(0, 5)}`; };

/** mountStock(el, kit, { action, tab, records(el) }) → leave() */
export function mountStock(el, kit, { action = null, tab: tab0 = null, records = null } = {}) {
  let alive = true, tab = tab0 || 'stock', steps = [], result = null, products = [], stores = [], q = '', mainStore = null;
  const rights = kit.stepRights || { read: true, write: true, undo: true };
  const canWrite = rights.kinds ? !!rights.kinds.receipt : !!rights.write, canUndo = !!rights.undo;   // stock movements: manager and storekeeper
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
    const [p, s, co] = await Promise.all([all('product'), all('store'), kit.api.doc('company', '').then((r) => r?.doc).catch(() => null)]);
    products = p; stores = s.filter((x) => x.active !== false);
    mainStore = co?.default_store ?? null;   // the company's main store comes first in every movement
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
  const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Dar es Salaam
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const storeSel = (id, label) => `<div class="bz-fld"><label class="bz-lbl" for="${id}">${label}</label><select id="${id}">${stores.map((s) => `<option value="${esc(s.id)}"${s.id === mainStore ? ' selected' : ''}>${esc(s.title)}${s.type && s.type !== 'Store' ? ` (${esc(s.type)})` : ''}</option>`).join('')}</select></div>`;
  const field = (id, label, input, cls = '') => `<div class="bz-fld${cls ? ' ' + cls : ''}"><label class="bz-lbl" for="${id}">${label}</label>${input}</div>`;
  const dateIn = () => field('bzDate', 'Date', `<input class="bz-in" type="date" id="bzDate" value="${today()}" max="${today()}">`);

  /** A movement with one or more products: where, when, the lines (product, quantity, price where needed), a note. */
  function dialog(kind) {
    const a = ACT[kind];
    if (!canWrite) return kit.toast('Your role can only look at stock');
    if (!stores.length) return kit.toast('Add a store first (Setup → Stores and vans)');
    if (kind === 'landed_cost') return landedDialog();
    if (!products.length) return kit.toast('Add a product first');
    const needsPrice = ['purchase_receipt', 'delivery', 'count', 'receipt'].includes(kind);
    const priceLabel = kind === 'delivery' ? 'Selling price' : kind === 'count' ? 'Cost' : 'Cost per unit';
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money';
    body.noValidate = true;
    body.innerHTML = `${kind === 'transfer' ? `${storeSel('bzFrom', 'From')}${storeSel('bzTo', 'To')}`
      : storeSel('bzWh', kind === 'delivery' ? 'Sold from' : kind === 'count' ? 'Counted in' : kind === 'issue' ? 'Taken from' : 'Into')}
      ${dateIn()}
      ${kind === 'count' ? `<div class="bz-chk wide"><span class="bz-lbl">Opening stock (the first count when you start: booked to Opening balances, not to profit)</span><button type="button" class="sw" role="switch" id="bzOpen" aria-checked="false"></button></div>` : ''}
      <div class="bz-lines wide" id="bzLines" role="table"><div class="bz-ln s${needsPrice ? '' : ' np'} bz-lh" role="row"><span>Product</span><span class="n">${kind === 'count' ? 'Counted' : 'Qty'}</span>${needsPrice ? `<span class="n">${priceLabel}</span>` : ''}<span class="n">Has now</span><span></span></div></div>
      <button type="button" class="tbtn wide bz-addln" id="bzAddLn">${svg(I.plus)}Add a product</button>
      ${field('bzRemarks', 'Note', `<input class="bz-in" id="bzRemarks" autocomplete="off" placeholder="${kind === 'issue' ? 'Why: damaged, expired, own use' : 'Optional'}">`, 'wide')}
      <div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: a.label, sub: a.hint, icon: a.icon, wide: true, body, actions: [{ label: 'Cancel', value: false }, { label: 'Save', pri: true, id: 'bzStepOk', onClick: (_, btn) => save(btn) }] });
    const $d = (s) => m.box.querySelector(s);
    if (kind === 'transfer') { const other = stores.find((x) => x.id !== $d('#bzFrom').value); if (other) $d('#bzTo').value = other.id; }
    enhanceSelects(body);
    const open = $d('#bzOpen');
    if (open) open.onclick = () => { const on = open.getAttribute('aria-checked') !== 'true'; open.classList.toggle('on', on); open.setAttribute('aria-checked', String(on)); };
    const wh = () => $d('#bzWh')?.value || $d('#bzFrom').value;
    const lines = [];
    function addLine() {
      const row = document.createElement('div');
      row.className = `bz-ln s${needsPrice ? '' : ' np'}`; row.setAttribute('role', 'row');
      const ln = { row, seq: 0 };
      ln.prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: { is_stock: true, active: true } }, null, {
        api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => fillLine(ln) });
      row.append(ln.prod.el);
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Quantity" inputmode="decimal" placeholder="0">${needsPrice ? '<input class="bz-in n" aria-label="Price" inputmode="decimal">' : ''}<span class="n bz-lamt"></span><button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      [ln.qi, ln.ri] = row.querySelectorAll('input.bz-in.n');
      row.querySelector('.ibtn').onclick = () => { lines.splice(lines.indexOf(ln), 1); row.remove(); };
      $d('#bzLines').append(row);
      lines.push(ln);
      return ln;
    }
    // what the store has now, and a starting price: the average cost for stock in and counts, else the price rules
    async function fillLine(ln) {
      const item = ln.prod.get();
      const b = item ? result?.balances?.find((x) => x.item === item && x.warehouse === wh()) : null;
      ln.row.querySelector('.bz-lamt').textContent = item ? qty(b?.qty || 0) : '';
      if (!item || !ln.ri) return;
      if (kind !== 'delivery' && b?.valuationRate) { ln.ri.value = fmt(b.valuationRate); return; }
      const my = ++ln.seq;
      const p = await kit.api.price(item, undefined, kind === 'delivery' ? 'sell' : 'buy', $d('#bzDate').value).catch(() => null);
      if (my === ln.seq && p?.price && m.el.isConnected) ln.ri.value = fmt(p.price.rate);
    }
    body.querySelectorAll('select').forEach((x) => x.addEventListener('change', () => lines.forEach(fillLine)));
    $d('#bzAddLn').onclick = () => addLine().prod.focus();
    addLine();
    requestAnimationFrame(() => lines[0].prod.focus());
    // one id per dialog: if a save times out but did reach the server, pressing Save again returns that
    // movement instead of recording it twice (the server keeps each id once)
    const clientId = uid();
    async function save(btn) {
      const err = (t) => { const e = $d('.bz-formerr'); e.hidden = !t; e.textContent = t || ''; };
      err('');
      const out = [];
      for (const [i, ln] of lines.entries()) {
        const item = ln.prod.get(), qv = num(ln.qi.value), rv = ln.ri ? num(ln.ri.value) : null;
        if (!item && !ln.qi.value) continue;
        if (!item) return err(`Line ${i + 1}: choose a product`);
        if (!(qv > 0) && !(kind === 'count' && ln.qi.value.trim() !== '' && qv === 0)) return err(`Line ${i + 1}: enter a quantity`);
        if (needsPrice && !(rv >= 0 && ln.ri.value.trim() !== '')) return err(`Line ${i + 1}: enter the ${priceLabel.toLowerCase()}`);
        out.push({ item, qty: qv, ...(needsPrice ? { rate: rv } : {}) });
      }
      if (!out.length) return err('Add at least one product');
      const base = { kind, date: $d('#bzDate').value, lines: out, remarks: $d('#bzRemarks').value.trim() || undefined, client_id: clientId };
      let step;
      if (kind === 'transfer') {
        if ($d('#bzFrom').value === $d('#bzTo').value) return err('Choose two different places');
        step = { ...base, from: $d('#bzFrom').value, to: $d('#bzTo').value };
      } else step = { ...base, warehouse: $d('#bzWh').value, ...(open?.getAttribute('aria-checked') === 'true' ? { opening: true } : {}) };
      await busy(btn, async () => {
        const ok = await add(step, err);
        if (ok) m.close(true);
      });
    }
  }

  /** Landed cost: an extra cost (transport, clearing, duty) spread over goods that arrived, or over a bill that brought them. */
  function landedDialog() {
    const live = (s) => !s.undone && !steps.some((x) => x.kind === 'cancel' && x.target === s.id);
    const targets = steps.filter((s) => live(s) && (s.kind === 'purchase_receipt' || (s.kind === 'purchase_invoice' && s.updateStock)));
    if (!targets.length) return kit.toast('First record goods arriving (Goods arrived, or a bill that brings goods in)');
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${field('bzLcT', 'On which goods?', `<select id="bzLcT">${targets.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} · ${t.kind === 'purchase_receipt' ? 'Goods arrived' : 'Bill'} · ${esc(stamp(t))} · ${esc((t.lines || []).map((l) => itemTitle(l.item)).join(', ').slice(0, 60))}</option>`).join('')}</select>`, 'wide')}
      ${field('bzLcA', 'Extra cost (TZS)', '<input class="bz-in n" id="bzLcA" inputmode="decimal">')}
      ${field('bzLcD', 'Spread by', '<select id="bzLcD"><option value="amount">Value of each line</option><option value="qty">Quantity of each line</option></select>')}
      ${dateIn()}${field('bzRemarks', 'Note', '<input class="bz-in" id="bzRemarks" autocomplete="off" placeholder="e.g. transport, clearing">')}
      <p class="bz-note wide">The cost goes into the value of those goods; what was already sold gets its share in cost of goods sold.</p>
      <div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Landed cost', sub: 'Transport, clearing or duty on goods that arrived', icon: I.arrived, body, actions: [{ label: 'Cancel', value: false }, { label: 'Save', pri: true, onClick: (_, btn) => go(btn) }] });
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    const clientId = uid();
    async function go(btn) {
      const err = (t) => { const e = $d('.bz-formerr'); e.hidden = !t; e.textContent = t || ''; };
      const amount = num($d('#bzLcA').value);
      if (!(amount > 0)) return err('Enter the extra cost');
      await busy(btn, async () => {
        const ok = await add({ kind: 'landed_cost', receipt: $d('#bzLcT').value, amount, distribute: $d('#bzLcD').value, date: $d('#bzDate').value,
          remarks: $d('#bzRemarks').value.trim() || undefined, client_id: clientId }, err);
        if (ok) m.close(true);
      });
    }
  }

  /** Send a step; a refused one is explained in plain words. Returns true when it was kept. */
  async function add(step, showErr) {
    try {
      await kit.api.addStep(step);
      kit.toast(`${ACT[step.kind]?.label || 'Done'} ✓`);
      await loadSteps().catch(() => {});
      if (alive) paint();
      return true;
    } catch (e) {
      if (showErr) showErr(plain(errText(e))); else kit.toast(plain(errText(e)));
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
        <p class="bz-note">Debits equal credits for every movement. The books per account (cash, M-Pesa, sales, VAT) are in Money, Accounts.</p></section>`;
  }

  refresh().then(() => { if (alive && action && ACT[action]) dialog(action); });
  return () => { alive = false; recLeave?.(); };
}
