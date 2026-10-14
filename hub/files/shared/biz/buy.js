// Buy module (phase 5, pos/blueprint/04-buying.md): stock requests, supplier quotations, purchase orders, goods
// arrived (refused units kept apart, from orders), supplier bills (from orders or goods arrived, with advances, a
// write-off, a hold), paying suppliers (bills, or an advance on an order), goods sent back and debit notes, what to
// reorder and comparing supplier prices. Same parts and look as the Sell screens (money.js): quick actions, tabs,
// tables, one dialog per document, "make from" buttons that propose what is still open, status actions, printing.
// Documents are engine steps kept by the server (/steps); the counters per line (ordered, received, refused, billed,
// returned) and every status come from the engine's run, totals from the server's own VAT and discount rules
// (/preview) and prices from its price lists and buying pricing rules (/price), so the screen and the books agree.
import { enhanceSelects } from '../select.js';
import { esc, svg, I, modal, busy, errText, fmt, price, qty, num, debounce, confirmBox } from './ui.js';
import { makeField } from './fields.js';
import { printDoc, printFrom, printOptions } from './print.js';
import { fxBox } from './money.js';

/** The Buy module's quick actions; `step` is the kind of document each records (who may record it: the server). */
export const BUY_ACTIONS = [
  { kind: 'po', label: 'New purchase order', hint: 'Order goods from a supplier', icon: I.file, step: 'purchase_order', words: 'purchase order po lpo order supplier buy' },
  { kind: 'gr', label: 'Goods arrived', hint: 'From a supplier; refused goods kept apart', icon: I.arrived, step: 'purchase_receipt', words: 'goods arrived received grn receive supplier refused rejected delivery note' },
  { kind: 'bill', label: 'Supplier bill', hint: 'For goods or expenses', icon: I.arrived, step: 'purchase_invoice', words: 'bill supplier purchase invoice expense' },
  { kind: 'pay', label: 'Pay supplier', hint: 'Bills, or an advance on an order', icon: I.money, step: 'payment', words: 'pay supplier payment advance out' },
  { kind: 'mr', label: 'Stock request', hint: 'To buy, or to move from another store', icon: I.file, step: 'material_request', words: 'stock request material request indent need branch' },
  { kind: 'sq', label: 'Supplier quotation', hint: 'Prices a supplier offers', icon: I.file, step: 'supplier_quotation', words: 'supplier quotation quote prices offer' },
  { kind: 'back', label: 'Send goods back', hint: 'To the supplier, or a debit note on a bill', icon: I.undo, step: 'purchase_receipt', words: 'return send back supplier debit note refused damaged' },
];
const ACT = Object.fromEntries(BUY_ACTIONS.map((a) => [a.kind, a]));
/** May this person use this Buy action? (Older servers without per-kind rights: the general write right.) */
export const mayBuy = (kit, kind) => {
  const r = kit.stepRights;
  if (!r) return true;
  if (!r.kinds) return !!r.write;
  if (kind === 'back') return !!(r.kinds.purchase_receipt || r.kinds.debit_note);
  return !!r.kinds[ACT[kind]?.step];
};
const TABS = [['orders', 'Purchase orders'], ['arrived', 'Goods arrived'], ['bills', 'Bills'], ['requests', 'Stock requests'], ['quotes', 'Supplier quotations'],
  ['reorder', 'Reorder'], ['returns', 'Returns']];
const STATUS_TONE = { Completed: 'ok', Received: 'ok', Transferred: 'ok', Ordered: 'ok', Submitted: 'ok', Paid: 'ok', Return: '', 'Debit Note Issued': 'ok',
  Pending: 'warn', 'Partially Ordered': 'warn', 'Partially Received': 'warn', 'To Receive and Bill': 'warn', 'To Receive': 'warn', 'To Bill': 'warn', 'Partly Billed': 'warn',
  Unpaid: 'warn', 'Partly Paid': 'warn', Overdue: 'bad', 'On Hold': 'bad', Closed: '', Stopped: '', Expired: '', 'Return Issued': '', Cancelled: '' };
const LABEL = { material_request: 'Stock request', supplier_quotation: 'Supplier quotation', purchase_order: 'Purchase order', purchase_receipt: 'Goods arrived',
  purchase_invoice: 'Supplier bill', debit_note: 'Debit note', payment: 'Payment', transfer: 'Stock moved' };

const cents = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A document's amount in its own currency (a USD supplier's documents are in USD), and in TZS beside it. */
const foreign = (s) => !!s.currency && s.currency !== 'TZS';
const docAmt = (s, n) => (foreign(s) ? `${s.currency} ${cents(n)}` : tzs(n));
const inTzs = (s, n) => (foreign(s) && s.exchangeRate ? `<div class="bz-mrow"><span>In TZS (1 ${s.currency} = ${fmt(s.exchangeRate)})</span><span>${tzs(Math.round(n * s.exchangeRate))}</span></div>` : '');
const tzs = (n) => 'TZS ' + fmt(n);
const day = (s) => { const d = new Date(`${s}T00:00:00`); return !s || isNaN(d) ? s || '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Dar es Salaam
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const lineRate = (l) => (l.discount ? r2(l.rate * (1 - l.discount / 100)) : l.rate);
const lineAmt = (l) => r2(lineRate(l) * l.qty);
const pct = (n) => `${Math.round(n ?? 0)}%`;
const field = (id, label, input, cls = '') => `<div class="bz-fld${cls ? ' ' + cls : ''}"><label class="bz-lbl" for="${id}">${label}</label>${input}</div>`;
const sw = (id, label, on, cls = 'wide') => `<div class="bz-chk ${cls}"><span class="bz-lbl">${label}</span><button type="button" class="sw${on ? ' on' : ''}" role="switch" id="${id}" aria-checked="${!!on}"></button></div>`;
function wireSwitch(el, onChange) {
  el.onclick = () => { if (el.disabled) return; const on = el.getAttribute('aria-checked') !== 'true'; el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); onChange?.(on); };
  return () => el.getAttribute('aria-checked') === 'true';
}
const setSwitch = (el, on) => { el.classList.toggle('on', !!on); el.setAttribute('aria-checked', String(!!on)); };
const dateIn = (id, label = 'Date', value = today(), past = true) => field(id, label, `<input class="bz-in" type="date" id="${id}" value="${esc(value)}"${past ? ` max="${today()}"` : ''}>`);
const textIn = (id, label, cls = '', ph = '', max = 60) => field(id, label, `<input class="bz-in" id="${id}" autocomplete="off" maxlength="${max}"${ph ? ` placeholder="${esc(ph)}"` : ''}>`, cls);
const showErr = (m, text) => { const e = m.box.querySelector('.bz-formerr'); e.hidden = !text; e.textContent = text || ''; };

/** mountBuy(el, kit, { action, records(el) }) → leave() */
export function mountBuy(el, kit, { action = null, records = null } = {}) {
  let alive = true, tab = TABS[0][0], steps = [], result = null, titles = {}, methods = [], stores = [], refusedStores = new Set(), company = {}, reorder = null;
  const rights = kit.stepRights || { read: true, write: true, undo: true };
  const role = () => String(kit.user?.role || '').toLowerCase();
  const mayKind = (k) => { const r = kit.stepRights; return !r?.kinds || !!r.kinds[k]; };
  // status actions: the server's set_status right and the store's own rule (store/buy.ts cleanBuyStatus)
  const mayStatus = (kind) => role() === 'owner' || (mayKind('set_status') && (kind === 'material_request' ? ['manager', 'storekeeper'] : ['manager', 'accountant']).includes(role()));
  const name = (id) => titles[id] ?? id ?? '';

  el.innerHTML = `<div class="bz-stock">
    <div class="bz-quick">${BUY_ACTIONS.map((a, i) => `<button class="bz-act" data-k="${a.kind}" style="--i:${i}"${mayBuy(kit, a.kind) ? '' : ' disabled title="Your role cannot record this"'}><span class="bz-ic">${svg(a.icon)}</span><span><b>${a.label}</b><small>${a.hint}</small></span></button>`).join('')}</div>
    <div class="bz-bar"><div class="seg" id="bzBTabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="bz-src"><span class="dot"></span>Our own engine</span></div>
    <div id="bzBView"><div class="bz-loading"><span class="bz-spin"></span></div></div>
    <div id="bzBRec"></div></div>`;
  const $ = (s) => el.querySelector(s);
  el.querySelectorAll('.bz-act').forEach((b) => (b.onclick = () => open(b.dataset.k)));
  el.querySelectorAll('#bzBTabs button').forEach((b) => (b.onclick = () => {
    tab = b.dataset.t;
    el.querySelectorAll('#bzBTabs button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    paint();
  }));
  const recLeave = records ? records($('#bzBRec')) : null;

  async function load() {
    const [r, run, pm, st, rej, co] = await Promise.all([
      kit.api.steps(1000), kit.api.run({}),
      kit.api.list('payment_method', { limit: 100, sort: 'title' }).catch(() => ({ rows: [] })),
      kit.api.list('store', { limit: 200, sort: 'title' }).catch(() => ({ rows: [] })),
      kit.api.list('store', { limit: 200, filters: { rejected: true } }).catch(() => ({ rows: [] })),
      kit.api.doc('company', '').then((x) => x?.doc).catch(() => null),
    ]);
    company = co || {};
    steps = r?.steps || [];
    result = run;
    methods = (pm?.rows || []).filter((m) => m.active !== false);
    stores = (st?.rows || []).filter((s) => s.active !== false);
    refusedStores = new Set((rej?.rows || []).map((s) => s.id));
    titles = { ...titles, ...(r?.titles || {}), ...(run?.titles || {}) };
    for (const x of [...stores, ...methods]) titles[x.id] = x.title || x.name || x.id;
    reorder = null;
  }
  (async () => {
    try { await load(); } catch (e) { if (alive) $('#bzBView').innerHTML = `<div class="bz-empty card"><b>Could not load</b><p>${esc(errText(e))}</p></div>`; return; }
    if (!alive) return;
    paint();
    if (action && ACT[action]) open(action);
  })();
  async function reload() { try { await load(); } catch {} if (alive) paint(); }

  // ---------- data helpers
  const stepOf = (id) => steps.find((s) => s.id === id);
  const docs = () => result?.documents || [];
  const docOf = (id) => docs().find((x) => x.step === id);
  const invoices = () => result?.invoices || [];
  const invOf = (id) => invoices().find((i) => i.step === id);
  const live = (s) => !!s && !s.undone && docOf(s.id)?.status !== 'Cancelled';
  // a bill on hold: until its date, unless released (a live set_status Open on it)
  const released = (id) => steps.some((x) => x.kind === 'set_status' && x.target === id && x.status === 'Open' && !x.undone);
  const heldNow = (s) => s?.hold === true && (!s.holdUntil || s.holdUntil > today()) && !released(s.id);

  /** What is left on each line of a source for the next document (04 §3.2: from the engine's counters). */
  function leftOn(src, target) {
    const s = stepOf(src), d = docOf(src);
    if (!s) return [];
    const debited = (item) => steps.filter((x) => x.kind === 'debit_note' && x.against === src && !x.undone)
      .reduce((a, x) => a + (x.lines || stepOf(src).lines).filter((l) => l.item === item).reduce((b, l) => b + l.qty, 0), 0);
    return (s.lines || []).map((l, i) => {
      const done = d?.lines?.[i] || {};
      let left;
      if (s.kind === 'material_request' || s.kind === 'supplier_quotation') left = l.qty - (done.ordered || 0);
      else if (s.kind === 'purchase_order') left = target === 'gr' ? l.qty - (done.received || 0) : (lineAmt(l) - (done.billed || 0)) / (lineRate(l) || 1);
      else if (s.kind === 'purchase_receipt') left = target === 'back' ? l.qty - (done.returned || 0) : (r2(l.rate * (l.qty - (done.returned || 0))) - (done.billed || 0)) / (l.rate || 1);
      else if (s.kind === 'purchase_invoice') left = l.qty - debited(l.item);
      else left = l.qty;
      return { l, i, left: Math.max(0, r3(left)) };
    });
  }
  /** The whole discount of a source shared over the lines taken from it (as the server does when none is given). */
  function discountShare(s, taken) {
    if (!s?.discountAmount) return 0;
    const gross = (s.lines || []).reduce((a, l) => a + lineAmt(l), 0);
    const mine = taken.reduce((a, x) => a + r2(lineRate(x.l) * x.qty), 0);
    return gross > 0 ? r2((s.discountAmount * mine) / gross) : 0;
  }
  /** Money a supplier has with us to set against a bill: payments out not yet linked to a bill (advances), journals
   *  that debited them; less what other live bills already took (advances) or a match took. */
  function creditsOf(party) {
    const used = (id) => steps.filter((b) => !b.undone && b.kind === 'purchase_invoice').flatMap((b) => b.advances || []).filter((a) => a.from === id).reduce((a, x) => a + x.amount, 0)
      + steps.filter((m) => m.kind === 'reconcile' && !m.undone).flatMap((m) => m.allocations || []).filter((a) => a.from === id).reduce((a, x) => a + x.amount, 0);
    const out = [];
    for (const s of steps) {
      if (s.undone || s.kind === 'cancel') continue;
      if (s.kind === 'payment' && s.direction === 'out' && s.party === party) {
        const ded = (s.deductions || []).reduce((a, d) => a + d.amount, 0);
        const left = r2(s.amount - ded - (s.allocate || []).reduce((a, x) => a + x.amount, 0) - used(s.id));
        if (left > 0.004) out.push({ step: s.id, left, date: s.date, orders: (s.advanceFor || []).map((a) => a.order) });
      }
      if (s.kind === 'journal') {
        const own = (s.rows || []).filter((r) => r.party === party && !r.invoice && r.role === 'payable');
        const left = r2(own.reduce((a, r) => a + (r.debit || 0) - (r.credit || 0), 0) - used(s.id));
        if (left > 0.004) out.push({ step: s.id, left, date: s.date, orders: [] });
      }
    }
    return out;
  }
  const openBills = (party) => invoices().filter((i) => i.party === party && i.outstanding > 0.004 && stepOf(i.step)?.kind === 'purchase_invoice')
    .sort((a, b) => (stepOf(a.step)?.dueDate || '').localeCompare(stepOf(b.step)?.dueDate || ''));
  const openOrders = (party) => docs().filter((x) => x.kind === 'purchase_order' && stepOf(x.step)?.supplier === party && !['Closed', 'Completed', 'Cancelled'].includes(x.status));

  // ---------- painting
  function paint() {
    const v = $('#bzBView');
    if (!v) return;
    if (tab === 'orders') v.innerHTML = orderTable();
    else if (tab === 'arrived') v.innerHTML = arrivedTable();
    else if (tab === 'bills') v.innerHTML = billTable();
    else if (tab === 'requests') v.innerHTML = requestTable();
    else if (tab === 'quotes') v.innerHTML = quoteTable();
    else if (tab === 'returns') v.innerHTML = returnTable();
    else return paintReorder(v);
    v.querySelectorAll('[data-doc]').forEach((r) => (r.onclick = () => showDoc(r.dataset.doc)));
  }
  const rowsOrEmpty = (rows, empty) => (rows.length ? rows.join('') : `<div class="bz-empty-row">${esc(empty)}</div>`);
  const table = (cols, head, rows, empty) => `<section class="card bz-table" style="--cols:${cols}">
    <div class="bz-tr bz-th" role="row">${head.map((h) => `<span${h.startsWith('#') ? ' class="n"' : ''}>${esc(h.replace(/^#/, ''))}</span>`).join('')}</div>${rowsOrEmpty(rows, empty)}</section>`;
  const st = (status) => `<span class="bz-st ${STATUS_TONE[status] ?? ''}">${esc(status || '')}</span>`;
  const docsOf = (kind, f = () => true) => docs().filter((x) => x.kind === kind && f(stepOf(x.step))).reverse();

  function orderTable() {
    const rows = docsOf('purchase_order').map((x) => {
      const s = stepOf(x.step);
      return `<button class="bz-tr" role="row" data-doc="${esc(x.step)}"><span class="bz-t1" data-l="Number">${esc(x.step)}</span><span data-l="Date">${esc(day(s?.date))}</span>
        <span data-l="Supplier">${esc(name(s?.supplier))}</span><span class="n" data-l="Amount">${fmt(x.totals?.roundedTotal)}</span>
        <span class="n" data-l="Received · billed">${pct(x.perReceived)} · ${pct(x.perBilled)}</span><span data-l="Status">${st(x.status)}</span></button>`;
    });
    return table('minmax(7rem,1fr) 7rem minmax(9rem,2fr) 8rem 8rem 10rem', ['Number', 'Date', 'Supplier', '#Amount', '#Received · billed', 'Status'], rows,
      'No purchase orders yet. Make one with New purchase order, or from Reorder.');
  }
  function arrivedTable() {
    const rows = docsOf('purchase_receipt', (s) => !s?.returnOf).map((x) => {
      const s = stepOf(x.step);
      const got = (s?.lines || []).reduce((a, l) => a + l.qty, 0), refused = (s?.lines || []).reduce((a, l) => a + (l.rejected || 0), 0);
      return `<button class="bz-tr" role="row" data-doc="${esc(x.step)}"><span class="bz-t1" data-l="Number">${esc(x.step)}${s?.supplierNote ? ` <small class="bz-muted">· ${esc(s.supplierNote)}</small>` : ''}</span>
        <span data-l="Date">${esc(day(s?.date))}</span><span data-l="Supplier">${esc(s?.supplier ? name(s.supplier) : '—')}</span>
        <span class="n" data-l="Kept · refused">${qty(got)}${refused ? ` · ${qty(refused)}` : ''}</span><span class="n" data-l="Billed">${pct(x.perBilled)}</span><span data-l="Status">${st(x.status)}</span></button>`;
    });
    return table('minmax(7rem,1.2fr) 7rem minmax(9rem,2fr) 7rem 5rem 9rem', ['Number', 'Date', 'Supplier', '#Kept · refused', '#Billed', 'Status'], rows,
      'No goods arrived yet. Record them with Goods arrived, or from a purchase order.');
  }
  function billTable() {
    const rows = [...invoices().filter((i) => stepOf(i.step)?.kind === 'purchase_invoice')].reverse().map((i) => {
      const s = stepOf(i.step);
      return `<button class="bz-tr" role="row" data-doc="${esc(i.step)}"><span class="bz-t1" data-l="Number">${esc(i.step)}${s?.opening ? ' <small class="bz-muted">opening</small>' : ''}${s?.billNo ? ` <small class="bz-muted">· ${esc(s.billNo)}</small>` : ''}</span>
        <span data-l="Date">${esc(day(s?.date))}</span><span data-l="Supplier">${esc(name(i.party))}</span>
        <span class="n" data-l="Total">${fmt(i.roundedTotal)}</span><span class="n" data-l="Still owed">${fmt(i.outstanding)}</span>
        <span data-l="Status">${st(i.status)}${heldNow(s) && i.outstanding > 0.004 ? ' <span class="bz-st bad">On hold</span>' : ''}</span></button>`;
    });
    return table('minmax(7rem,1.2fr) 7rem minmax(9rem,2fr) 7rem 7rem 10rem', ['Number', 'Date', 'Supplier', '#Total', '#Still owed', 'Status'], rows, 'No supplier bills yet.');
  }
  function requestTable() {
    const rows = docsOf('material_request').map((x) => {
      const s = stepOf(x.step);
      return `<button class="bz-tr" role="row" data-doc="${esc(x.step)}"><span class="bz-t1" data-l="Number">${esc(x.step)}</span><span data-l="Date">${esc(day(s?.date))}</span>
        <span data-l="For">${esc(name(s?.warehouse))}${s?.purpose === 'transfer' ? ` <small class="bz-muted">from ${esc(name(s.from))}</small>` : ' <small class="bz-muted">to buy</small>'}</span>
        <span data-l="Needed by">${esc(day(s?.requiredBy))}</span><span class="n" data-l="${s?.purpose === 'transfer' ? 'Moved' : 'Ordered'}">${pct(x.perOrdered)}</span><span data-l="Status">${st(x.status)}</span></button>`;
    });
    return table('minmax(7rem,1fr) 7rem minmax(10rem,2fr) 7rem 5rem 10rem', ['Number', 'Date', 'For store', 'Needed by', '#Done', 'Status'], rows,
      'No stock requests yet. A branch or the store asks for goods with Stock request; Reorder makes them too.');
  }
  function quoteTable() {
    const rows = docsOf('supplier_quotation').map((x) => {
      const s = stepOf(x.step);
      return `<button class="bz-tr" role="row" data-doc="${esc(x.step)}"><span class="bz-t1" data-l="Number">${esc(x.step)}</span><span data-l="Date">${esc(day(s?.date))}</span>
        <span data-l="Supplier">${esc(name(s?.supplier))}</span><span class="n" data-l="Amount">${fmt(x.totals?.roundedTotal)}</span>
        <span data-l="Valid till">${esc(day(s?.validTill))}</span><span data-l="Status">${st(x.status)}</span></button>`;
    });
    return table('minmax(7rem,1fr) 7rem minmax(9rem,2fr) 8rem 7rem 8rem', ['Number', 'Date', 'Supplier', '#Amount', 'Valid till', 'Status'], rows,
      'No supplier quotations yet. Record the prices a supplier gives with Supplier quotation.');
  }
  function returnTable() {
    const list = steps.filter((s) => (s.kind === 'purchase_receipt' && s.returnOf) || s.kind === 'debit_note');
    const rows = list.map((s) => {
      const bill = s.kind === 'debit_note' ? stepOf(s.against) : null;
      const amount = s.kind === 'debit_note' ? Math.abs(invOf(s.id)?.roundedTotal ?? 0) : docOf(s.id)?.totals?.roundedTotal ?? (s.lines || []).reduce((a, l) => a + lineAmt(l), 0);
      return `<button class="bz-tr" role="row" data-doc="${esc(s.id)}"><span class="bz-t1" data-l="Number">${esc(s.id)}${s.undone ? ' <small class="bz-muted">undone</small>' : ''}</span>
        <span data-l="Date">${esc(day(s.date))}</span><span data-l="Supplier">${esc(name(s.supplier || bill?.supplier))}</span>
        <span data-l="What">${s.kind === 'debit_note' ? `Debit note on ${esc(s.against)}${s.billNo ? ` · ${esc(s.billNo)}` : ''}` : `Goods sent back from ${esc(s.returnOf)}`}</span>
        <span class="n" data-l="Amount">${fmt(amount)}</span></button>`;
    });
    return table('minmax(7rem,1fr) 7rem minmax(8rem,1.5fr) minmax(10rem,2fr) 8rem', ['Number', 'Date', 'Supplier', 'What', '#Amount'], rows,
      'Nothing sent back yet. Send goods back from goods arrived, or make a debit note on a bill.');
  }

  // ---------- what to reorder (store/reorder.ts): grouped by usual supplier and store, one purchase order each
  async function paintReorder(v) {
    if (!reorder) {
      v.innerHTML = '<div class="bz-loading"><span class="bz-spin"></span></div>';
      try { reorder = await kit.api.reorder(); titles = { ...titles, ...(reorder?.titles || {}) }; }
      catch (e) { if (tab === 'reorder' && alive) v.innerHTML = `<div class="bz-empty card"><b>Could not load what to reorder</b><p>${esc(errText(e))}</p></div>`; return; }
      if (tab !== 'reorder' || !alive) return;
    }
    const list = reorder.suggestions || [];
    const groups = new Map();
    for (const s of list) {
      const k = `${s.type}|${s.supplier || ''}|${s.store}`;
      if (!groups.has(k)) groups.set(k, { type: s.type, supplier: s.supplier, store: s.store, rows: [] });
      groups.get(k).rows.push(s);
    }
    const cols = 'minmax(9rem,2fr) 5rem 5rem 5rem 5rem 5.5rem 5rem 6rem 7rem 7rem';
    const head = `<div class="bz-tr bz-th" role="row"><span>Product</span><span class="n">In stock</span><span class="n">On order</span><span class="n">Asked for</span><span class="n">Held</span>
      <span class="n">Projected</span><span class="n">Level</span><span class="n">To order</span><span>Needed by</span><span></span></div>`;
    v.innerHTML = `<div class="bz-rbar"><p class="bz-note">Products whose stock, with what is on order and asked for, less what is held for customers, is at or below the reorder level (set on each product, per store).</p>
      ${mayKind('supplier_quotation') ? `<button class="tbtn" id="bzBCmp">${svg(I.search)}Compare supplier prices</button>` : ''}</div>
      ${!list.length ? '<div class="bz-empty card"><b>Nothing to reorder</b><p>Every product with a reorder level has enough, counting what is on order and asked for.</p></div>' : ''}
      ${[...groups.values()].map((g, gi) => `<section class="card bz-table bz-rgroup" style="--cols:${cols}">
        <div class="bz-rgh"><div><b>${g.type === 'Transfer' ? 'Move from another store' : g.supplier ? esc(name(g.supplier)) : 'No usual supplier'}</b><small class="bz-muted"> · for ${esc(name(g.store))}</small></div>
          <div class="bz-acts2">${g.type === 'Purchase' && mayBuy(kit, 'po') ? `<button class="btn pri sm" data-po="${gi}">${svg(I.file)}Make purchase order</button>` : ''}
            ${mayBuy(kit, 'mr') ? `<button class="btn sm" data-mr="${gi}">${svg(I.file)}Make stock request</button>` : ''}</div></div>
        ${head}${g.rows.map((s) => `<div class="bz-tr" role="row"><span class="bz-t1" data-l="Product">${esc(name(s.product))}</span><span class="n" data-l="In stock">${qty(s.inStock)}</span>
          <span class="n" data-l="On order">${qty(s.ordered)}</span><span class="n" data-l="Asked for">${qty(s.requested)}</span><span class="n" data-l="Held">${qty(s.reserved)}</span>
          <span class="n" data-l="Projected">${qty(s.projected)}</span><span class="n" data-l="Level">${qty(s.level)}</span><span class="n" data-l="To order"><b>${qty(s.qty)}</b></span>
          <span data-l="Needed by">${esc(day(s.requiredBy))}</span><span>${mayKind('supplier_quotation') ? `<button class="tbtn" data-cmp="${esc(s.product)}">Compare</button>` : ''}</span></div>`).join('')}
      </section>`).join('')}`;
    const gs = [...groups.values()];
    const lastDay = (g) => g.rows.map((s) => s.requiredBy).sort().at(-1);
    v.querySelectorAll('[data-po]').forEach((b) => (b.onclick = () => { const g = gs[+b.dataset.po];
      docDialog('po', { party: g.supplier, store: g.store, requiredBy: lastDay(g), lines: g.rows.map((s) => ({ item: s.product, qty: s.qty })) }); }));
    v.querySelectorAll('[data-mr]').forEach((b) => (b.onclick = () => { const g = gs[+b.dataset.mr];
      docDialog('mr', { purpose: g.type === 'Transfer' ? 'transfer' : 'purchase', store: g.store, requiredBy: lastDay(g), lines: g.rows.map((s) => ({ item: s.product, qty: s.qty })) }); }));
    v.querySelectorAll('[data-cmp]').forEach((b) => (b.onclick = () => compareDialog(b.dataset.cmp)));
    v.querySelector('#bzBCmp')?.addEventListener('click', pickAndCompare);
  }

  /** Pick a product, then compare what every supplier charges for it. */
  function pickAndCompare() {
    const body = document.createElement('form');
    body.className = 'bz-grid c2'; body.noValidate = true;
    const prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: { active: true, can_buy: true } }, null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { const id = prod.get(); if (id) { titles[id] = prod.title?.() || titles[id]; m.close(false); compareDialog(id); } } });
    prod.el.classList.add('wide');
    body.append(prod.el);
    const m = modal({ title: 'Compare supplier prices', sub: 'Choose the product', icon: I.search, body, actions: [{ label: 'Cancel', value: false }] });
    requestAnimationFrame(() => prod.focus());
  }

  /** Compare supplier prices for one product (store/reorder.ts comparePrices): cheapest first, their code, list price,
   *  quotation, the last price paid them, days to arrive. onUse({supplier, rate}) takes a price into a line; without
   *  it, "Order from them" starts a purchase order. */
  async function compareDialog(product, { onUse = null } = {}) {
    let c;
    try { c = await kit.api.compare(product); } catch (e) { return kit.toast(errText(e)); }
    titles = { ...titles, ...(c.titles || {}) };
    const best = (x) => (x.quoted !== undefined && (!x.validTill || x.validTill >= today()) ? { rate: x.quoted, how: 'quotation' } : x.listPrice !== undefined ? { rate: x.listPrice, how: 'list price' } : x.lastPaid !== undefined ? { rate: x.lastPaid, how: 'last paid' } : null);
    const body = document.createElement('div');
    body.innerHTML = c.suppliers.length ? `<div class="bz-cmp">${c.suppliers.map((x, i) => {
      const b = best(x);
      return `<div class="bz-cmprow"><div class="bz-cmpn"><b>${esc(name(x.supplier))}</b>${x.usual ? ' <span class="bz-st ok">Usual</span>' : ''}${x.code ? ` <small class="bz-muted">their code ${esc(x.code)}</small>` : ''}</div>
        <div class="bz-cmpv">${x.listPrice !== undefined ? `<span>List <b>${fmt(x.listPrice)}</b></span>` : ''}
          ${x.quoted !== undefined ? `<span>Quoted <b>${fmt(x.quoted)}</b> <small class="bz-muted">${esc(x.quote || '')}${x.validTill ? ` · till ${esc(day(x.validTill))}` : ''}${x.validTill && x.validTill < today() ? ' · expired' : ''}</small></span>` : ''}
          ${x.lastPaid !== undefined ? `<span>Last paid <b>${fmt(x.lastPaid)}</b> <small class="bz-muted">${esc(day(x.lastOn))}</small></span>` : ''}
          ${x.leadDays !== undefined ? `<span>${qty(x.leadDays)} days to arrive</span>` : ''}${!b ? '<span class="bz-muted">No price yet</span>' : ''}</div>
        ${b ? `<button type="button" class="tbtn" data-use="${i}">${onUse ? `Use ${price(b.rate)}` : `Order at ${price(b.rate)}`}</button>` : ''}</div>`;
    }).join('')}</div>` : '<p class="bz-note">No supplier has a price for it yet: no buying price, quotation or earlier purchase. Add the product\'s suppliers on the product, or record a supplier quotation.</p>';
    const m = modal({ title: `Prices for ${name(product)}`, sub: 'Cheapest first: a valid quotation, else their list price, else the last price paid', icon: I.search, wide: true, body,
      actions: [{ label: 'Close', pri: true, value: false }] });
    body.querySelectorAll('[data-use]').forEach((btn) => (btn.onclick = () => {
      const x = c.suppliers[+btn.dataset.use], b = best(x);
      m.close(false);
      if (onUse) onUse({ supplier: x.supplier, rate: b.rate });
      else docDialog('po', { party: x.supplier, lines: [{ item: product, qty: 1, rate: b.rate }] });
    }));
  }

  // ---------- details
  function showDoc(id) {
    const s = stepOf(id);
    if (!s) return;
    if (s.kind === 'purchase_invoice') return showBill(s);
    if (['material_request', 'supplier_quotation', 'purchase_order', 'purchase_receipt'].includes(s.kind)) return showBuyDoc(s);
    return showOther(s);
  }
  const row = (a, b) => `<div class="bz-mrow"><span>${a}</span><span>${b}</span></div>`;
  async function undo(s) {
    if (!(await confirmBox({ title: `Undo ${s.id}?`, text: 'It stays in the history, marked undone. Refused while something made from it is still live; undo that first.', ok: 'Undo', danger: true }))) return;
    try { await kit.api.undoStep(s.id); kit.toast('Undone ✓'); reload(); } catch (e) { kit.toast(errText(e)); }
  }
  async function setStatus(target, status) {
    try { await kit.api.addStep({ kind: 'set_status', target, status, client_id: `${target}-${status}-${Date.now()}` }); kit.toast(`${target}: ${status === 'Open' ? 'reopened' : status.toLowerCase()} ✓`); reload(); }
    catch (e) { kit.toast(errText(e)); }
  }
  const transportRow = (s) => (s.transporter || s.lrNo || s.vehicle ? row('Transport', esc([s.transporter && name(s.transporter), s.vehicle, s.lrNo && `waybill ${s.lrNo}`, s.lrDate && day(s.lrDate)].filter(Boolean).join(' · '))) : '');

  function showBuyDoc(s) {
    const d = docOf(s.id) || { status: s.undone ? 'Cancelled' : '' };
    const isLive = !s.undone && d.status !== 'Cancelled';
    const lines = s.lines.map((l, i) => {
      const p = d.lines?.[i] || {};
      const done = s.kind === 'material_request' ? `${s.purpose === 'transfer' ? 'moved' : 'ordered'} ${qty(p.ordered || 0)}${s.purpose !== 'transfer' ? ` · received ${qty(p.received || 0)}` : ''}`
        : s.kind === 'supplier_quotation' ? `ordered ${qty(p.ordered || 0)}`
        : s.kind === 'purchase_order' ? `received ${qty(p.received || 0)}${p.rejected ? ` (refused ${qty(p.rejected)})` : ''} · billed ${fmt(p.billed || 0)}${p.returned ? ` · sent back ${qty(p.returned)}` : ''}`
        : s.returnOf ? 'sent back' : `${l.rejected ? `refused ${qty(l.rejected)} · ` : ''}billed ${fmt(p.billed || 0)}${p.returned ? ` · sent back ${qty(p.returned)}` : ''}`;
      const at = s.kind === 'material_request' && !l.rate ? '' : ` @ ${price(lineRate(l))}`;
      return row(`${qty(l.qty)} × ${esc(name(l.item))} <small class="bz-muted">${at}${at ? ' · ' : ''}${done}</small>`, s.kind === 'material_request' && !l.rate ? '' : foreign(s) ? cents(lineAmt(l)) : fmt(lineAmt(l)));
    }).join('');
    const acts = [];
    const open = isLive && !['Closed', 'On Hold', 'Stopped', 'Completed'].includes(d.status);
    if (s.kind === 'material_request' && open && !['Received', 'Transferred'].includes(d.status) && (d.perOrdered ?? 0) < 100) {
      if (s.purpose === 'transfer') { if (mayKind('transfer')) acts.push({ label: 'Move stock', pri: true, value: 'move' }); }
      else {
        if (mayBuy(kit, 'po')) acts.push({ label: 'Make order', pri: true, value: 'po' });
        if (mayBuy(kit, 'sq')) acts.push({ label: 'Supplier quotation', value: 'sq' });
      }
    }
    if (s.kind === 'supplier_quotation' && isLive && d.status === 'Submitted' && mayBuy(kit, 'po') && leftOn(s.id, 'po').some((x) => x.left > 0)) acts.push({ label: 'Make order', pri: true, value: 'po' });
    if (s.kind === 'purchase_order' && open) {
      if (mayBuy(kit, 'gr') && (d.perReceived ?? 0) < 100) acts.push({ label: 'Goods arrived', pri: true, value: 'gr' });
      if (mayBuy(kit, 'bill') && (d.perBilled ?? 0) < 100) acts.push({ label: 'Bill', value: 'bill' });
      if (mayKind('payment')) acts.push({ label: 'Pay advance', value: 'pay' });
    }
    if (s.kind === 'purchase_receipt' && !s.returnOf && isLive) {
      if (d.status !== 'Closed' && (d.perBilled ?? 0) < 100 && d.status !== 'Return Issued' && mayBuy(kit, 'bill')) acts.push({ label: 'Bill', pri: true, value: 'bill' });
      if (d.status !== 'Return Issued' && mayKind('purchase_receipt')) acts.push({ label: 'Send back', value: 'back' });
    }
    if (isLive && mayStatus(s.kind)) {
      if (s.kind === 'purchase_order' && d.status === 'On Hold') acts.push({ label: 'Resume', value: 'Open' });
      if (s.kind === 'purchase_order' && !['On Hold', 'Closed', 'Completed'].includes(d.status)) acts.push({ label: 'Hold', value: 'On Hold' });
      if (s.kind === 'material_request' && d.status === 'Stopped') acts.push({ label: 'Reopen', value: 'Open' });
      if (s.kind === 'material_request' && !['Stopped', 'Received', 'Transferred'].includes(d.status)) acts.push({ label: 'Stop', value: 'Stopped' });
      if ((s.kind === 'purchase_order' || (s.kind === 'purchase_receipt' && !s.returnOf)) && d.status === 'Closed') acts.push({ label: 'Reopen', value: 'Open' });
      if ((s.kind === 'purchase_order' || (s.kind === 'purchase_receipt' && !s.returnOf)) && !['Closed', 'Completed', 'Return Issued'].includes(d.status)) acts.push({ label: 'Close', value: 'Closed' });
    }
    acts.push({ label: 'Print', value: 'print' });
    if (isLive && rights.undo) acts.push({ label: 'Undo', danger: true, value: 'undo' });
    const t = d.totals;
    const totalQty = s.lines.reduce((a, l) => a + l.qty, 0), refused = s.lines.reduce((a, l) => a + (l.rejected || 0), 0);
    const body = `<div class="bz-docview">${row('Date', esc(day(s.date)))}
      ${s.supplier ? row('Supplier', esc(name(s.supplier))) : ''}
      ${s.kind === 'material_request' ? row('Asks for', s.purpose === 'transfer' ? `a move from ${esc(name(s.from))} to ${esc(name(s.warehouse))}` : `goods to buy for ${esc(name(s.warehouse))}`)
        : s.warehouse ? row(s.kind === 'purchase_order' ? 'Goods go to' : s.returnOf ? 'Sent back from' : 'Received into', esc(name(s.warehouse))) : ''}
      ${s.requiredBy ? row('Needed by', esc(day(s.requiredBy))) : ''}${s.validTill ? row('Valid till', esc(day(s.validTill))) : ''}
      ${s.incoterm ? row('Trade terms', `${esc(name(s.incoterm))}${s.namedPlace ? ` ${esc(s.namedPlace)}` : ''}`) : ''}${s.currency && s.currency !== 'TZS' ? row('Currency', `${esc(s.currency)}${s.exchangeRate ? ` · 1 = TZS ${fmt(s.exchangeRate)}` : ''}`) : ''}
      ${s.rejectedWarehouse ? row('Refused goods kept in', esc(name(s.rejectedWarehouse))) : ''}
      ${s.supplierNote ? row('Supplier\'s delivery note', esc(s.supplierNote)) : ''}${transportRow(s)}
      ${s.returnOf ? row('Goods back from', esc(s.returnOf)) : ''}
      ${s.lines.some((l) => l.from) && !s.returnOf ? row('Made from', esc([...new Set(s.lines.filter((l) => l.from).map((l) => l.from.step))].join(', '))) : ''}
      ${s.schedule?.length ? row('Instalments', s.schedule.map((x) => `${qty(x.portion)}% by ${esc(day(x.dueDate))}`).join(' · ')) : ''}
      <hr>${lines}<hr>
      ${row('Total quantity', `${qty(totalQty)}${refused ? ` <small class="bz-muted">· refused ${qty(refused)}</small>` : ''}`)}
      ${t && s.kind !== 'material_request' ? `${t.discount ? row('Discount on the whole', `− ${fmt(t.discount)}`) : ''}${t.vat ? `${row('Before VAT', cents(t.netTotal))}${row('VAT', cents(t.vat))}` : ''}
        <div class="bz-mrow big"><span>Total</span><span>${docAmt(s, t.roundedTotal)}</span></div>${inTzs(s, t.roundedTotal)}<hr>` : ''}
      ${s.kind === 'purchase_order' ? row('Received · billed', `${pct(d.perReceived)} · ${pct(d.perBilled)}`) + (d.advancePaid ? row('Advance paid', fmt(d.advancePaid)) : '')
        : s.kind === 'material_request' ? row(s.purpose === 'transfer' ? 'Moved' : 'Ordered · received', s.purpose === 'transfer' ? pct(d.perOrdered) : `${pct(d.perOrdered)} · ${pct(d.perReceived)}`)
        : s.kind === 'purchase_receipt' && !s.returnOf ? row('Billed · sent back', `${pct(d.perBilled)} · ${pct(d.perReturned)}`) : ''}
      ${row('Status', st(d.status))}
      ${s.remarks ? `<hr><p class="bz-note">${esc(s.remarks)}</p>` : ''}</div>`;
    const title = s.kind === 'purchase_receipt' && s.returnOf ? 'Goods sent back' : LABEL[s.kind];
    const m = modal({ title: `${title} ${s.id}`, icon: s.kind === 'purchase_receipt' ? I.arrived : I.file, wide: true, body, actions: [...acts, { label: 'Close window', value: false }] });
    m.done.then((v) => {
      if (!v) return;
      if (v === 'print') return printDoc(kit, s.id);
      if (v === 'undo') return undo(s);
      if (['po', 'sq', 'gr', 'bill', 'back', 'pay', 'move'].includes(v)) return makeFrom(s.id, v);
      setStatus(s.id, v);
    });
  }

  function showBill(s) {
    const inv = invOf(s.id) || {};
    const isLive = !s.undone && inv.status !== 'Cancelled';
    const lines = (s.lines || []).map((l) => row(`${qty(l.qty)} × ${esc(name(l.item))} <small class="bz-muted">@ ${price(lineRate(l))}${l.discount ? ` (${qty(l.discount)}% off ${price(l.rate)})` : ''}${l.from ? ` · from ${esc(l.from.step)}` : ''}</small>`, (foreign(s) ? cents(lineAmt(l)) : fmt(lineAmt(l))))).join('');
    const debits = steps.filter((x) => x.kind === 'debit_note' && x.against === s.id && !x.undone);
    const acts = [];
    if (isLive && inv.outstanding > 0.004 && !heldNow(s) && mayKind('payment')) acts.push({ label: 'Pay', pri: true, value: 'pay' });
    if (isLive && heldNow(s) && inv.outstanding > 0.004 && mayStatus('purchase_invoice')) acts.push({ label: 'Release', value: 'release' });
    if (isLive && !s.opening && mayKind('debit_note') && leftOn(s.id, 'debit').some((x) => x.left > 0)) acts.push({ label: 'Debit note', value: 'debit' });
    acts.push({ label: 'Print', value: 'print' });
    if (isLive && rights.undo) acts.push({ label: 'Undo', danger: true, value: 'undo' });
    const body = `<div class="bz-docview">${row('Date', esc(day(s.date)))}${row('Supplier', esc(name(s.supplier)))}
      ${s.billNo ? row('Their bill number', `${esc(s.billNo)}${s.billDate ? ` · ${esc(day(s.billDate))}` : ''}`) : ''}
      ${s.dueDate ? row('Due', esc(day(s.dueDate))) : ''}
      ${s.updateStock ? row('Goods came in with it', esc(name(s.warehouse))) : s.receipt ? row('Bills goods arrived', esc(s.receipt)) : ''}
      ${s.schedule?.length ? row('Instalments', s.schedule.map((x) => `${qty(x.portion)}% by ${esc(day(x.dueDate))}`).join(' · ')) : ''}
      ${s.hold ? row('On hold', released(s.id) ? 'released' : s.holdUntil ? `until ${esc(day(s.holdUntil))}` : 'until released') : ''}
      <hr>${lines}<hr>${row('Total quantity', qty((s.lines || []).reduce((a, l) => a + (l.item === '__opening' ? 0 : l.qty), 0)))}
      ${s.discountAmount ? row('Discount on the whole', `− ${fmt(s.discountAmount)}`) : ''}${row('Before VAT', cents(inv.netTotal))}${row('VAT', cents(inv.vat))}
      <div class="bz-mrow big"><span>Total</span><span>${docAmt(s, inv.roundedTotal)}</span></div>${inTzs(s, inv.roundedTotal)}
      ${(s.payments || []).map((p) => row('Paid at once', fmt(p.amount))).join('')}
      ${(s.advances || []).map((a) => row(`Advance ${esc(a.from)}`, fmt(a.amount))).join('')}
      ${s.writeOff ? row('Written off', fmt(s.writeOff)) : ''}
      ${debits.map((x) => row(`Debit note ${esc(x.id)}`, `− ${fmt(Math.abs(invOf(x.id)?.roundedTotal ?? 0))}`)).join('')}
      ${row('Still owed', fmt(inv.outstanding))}${row('Status', st(inv.status) + (heldNow(s) && inv.outstanding > 0.004 ? ' <span class="bz-st bad">On hold</span>' : ''))}
      ${s.remarks ? `<hr><p class="bz-note">${esc(s.remarks)}</p>` : ''}</div>`;
    const m = modal({ title: `Supplier bill ${s.id}`, icon: I.arrived, wide: true, body, actions: [...acts, { label: 'Close window', value: false }] });
    m.done.then((v) => {
      if (v === 'print') return printDoc(kit, s.id);
      if (v === 'undo') return undo(s);
      if (v === 'pay') return payDialog({ party: s.supplier, bill: s.id });
      if (v === 'debit') return debitDialog(s.id);
      if (v === 'release') return setStatus(s.id, 'Open');
    });
  }

  function showOther(s) {
    const inv = invOf(s.id);
    const body = `<div class="bz-docview">${row('Date', esc(day(s.date)))}
      ${s.kind === 'debit_note' ? `${row('Supplier', esc(name(stepOf(s.against)?.supplier)))}${row('Returns', `${esc(s.against)}${s.reduceInvoice ? ' · taken off that bill' : ' · kept as credit with them'}`)}
        ${s.billNo ? row('Their credit note', esc(s.billNo)) : ''}<hr>${(s.lines || stepOf(s.against)?.lines || []).map((l) => row(`${qty(l.qty)} × ${esc(name(l.item))}`, (foreign(s) ? cents(lineAmt(l)) : fmt(lineAmt(l))))).join('')}
        ${inv ? `<hr><div class="bz-mrow big"><span>Total</span><span>${tzs(Math.abs(inv.roundedTotal))}</span></div>` : ''}` : ''}
      ${s.kind === 'payment' ? `${row('Supplier', esc(name(s.party)))}${row('Amount', tzs(s.amount))}${(s.allocate || []).map((a) => row(`For ${esc(a.invoice)}`, fmt(a.amount))).join('')}
        ${(s.advanceFor || []).map((a) => row(`Advance on ${esc(a.order)}`, fmt(a.amount))).join('')}${s.reference ? row('Reference', esc(s.reference)) : ''}` : ''}
      ${s.remarks ? `<hr><p class="bz-note">${esc(s.remarks)}</p>` : ''}</div>`;
    const m = modal({ title: `${s.label || LABEL[s.kind] || s.kind} ${s.id}`, icon: I.file, wide: true, body,
      actions: [...(!s.undone && rights.undo ? [{ label: 'Undo', danger: true, value: 'undo' }] : []), { label: 'Print', value: 'print' }, { label: 'Close', pri: true, value: false }] });
    m.done.then((v) => { if (v === 'print') printDoc(kit, s.id); if (v === 'undo') undo(s); });
  }

  // ---------- making the next document: only what is still open, quantities proposed as what is left
  function makeFrom(src, target) {
    const s = stepOf(src);
    if (!s) return;
    if (target === 'back') return backGoods(src);
    if (target === 'move') return moveDialog(src);
    if (target === 'pay') return payDialog({ party: s.supplier, order: src, mode: 'advance' });
    const open = leftOn(src, target).filter((x) => x.left > 0);
    if (!open.length) return kit.toast(`Nothing is left to ${{ po: 'order', sq: 'quote', gr: 'receive', bill: 'bill' }[target] || 'do'} on ${src}`);
    const pre = linesFrom(s, open, target);
    if (target === 'gr') return grDialog(pre);
    return docDialog(target, pre);
  }
  /** The dialog's starting values from a source and its open lines. */
  function linesFrom(s, open, target) {
    const po = s.kind === 'purchase_receipt' ? stepOf(s.lines.find((l) => l.from)?.from?.step) : null;   // the order goods arrived came from
    const tax = s.tax || po?.tax;
    const pre = {
      party: s.supplier, store: s.kind === 'material_request' ? s.warehouse : s.warehouse, requiredBy: s.requiredBy, src: s.id,
      vat: tax ? { on: true, incl: !!tax.inclusive } : null, print: printFrom(s), incoterm: s.incoterm || po?.incoterm, namedPlace: s.namedPlace || po?.namedPlace,
      lines: open.map((x) => ({ item: x.l.item, qty: x.left, left: x.left, rate: target === 'gr' ? lineRate(x.l) : x.l.rate || '', discount: target === 'gr' ? 0 : x.l.discount || 0,
        from: { step: s.id, line: x.i } })),
    };
    if (target === 'bill') pre.billFor = s.id;
    const share = discountShare(s, open.map((x) => ({ l: x.l, qty: x.left })));
    if (share && target !== 'gr') pre.discount = share;
    return pre;
  }

  // ---------- dialogs
  function open(kind, pre = {}) {
    if (!mayBuy(kit, kind)) return kit.toast('Your role cannot record this');
    if (kind === 'gr') return grDialog(pre);
    if (kind === 'pay') return payDialog(pre);
    if (kind === 'back') return backChooser();
    return docDialog(kind, pre);
  }
  const storeOpts = (pick, list = stores) => list.map((s) => `<option value="${esc(s.id)}"${s.id === pick ? ' selected' : ''}>${esc(s.title || s.name)}${refusedStores.has(s.id) ? ' (refused goods)' : ''}</option>`).join('');
  const storeSel = (id, label, pick) => field(id, label, `<select id="${id}">${storeOpts(pick || company.default_store || stores.find((s) => !refusedStores.has(s.id))?.id)}</select>`);
  const methodSel = (id, label, value) => field(id, label, `<select id="${id}">${methods.map((m) => `<option value="${esc(m.id)}"${m.id === value ? ' selected' : ''}>${esc(m.title || m.name)}</option>`).join('')}</select>`);
  async function save(step, m, btn, label) {
    await busy(btn, async () => {
      try {
        const r = await kit.api.addStep(step);
        kit.toast(`${r?.step?.label || label || 'Saved'} ${r?.step?.id || ''} ✓`.trim());
        m.close(true);
        reload();
      } catch (e) { showErr(m, errText(e)); }
    });
  }

  /** A purchase order ('po'), supplier quotation ('sq'), stock request ('mr') or supplier bill ('bill'): who, lines
   *  (from a source or typed), prices from the supplier's lists and buying pricing rules, VAT, totals from the server. */
  function docDialog(kind, pre = {}) {
    const isBill = kind === 'bill', isMr = kind === 'mr', priced = !isMr;
    const clientId = uid();
    let totals = null, seq = 0;   // the server's totals of what is typed (preview below)
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    const printing = printOptions(kit, kind);
    const party = isMr ? null : makeField({ key: 'party', label: 'Supplier', type: 'link', to: 'supplier', required: true, filter: { active: true } }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { titles[party.get()] = party.title?.() || titles[party.get()]; fx?.refresh(); printing.forParty(party.get()); drawFor(); drawAdvances(); } });
    if (party) body.append(party.el);
    if (pre.party && party) party.set(pre.party, titles[pre.party]);
    const fromSource = !!pre.src;
    body.insertAdjacentHTML('beforeend', `${dateIn('bzBDate')}${priced ? '<div class="wide" id="bzBFx" hidden></div>' : ''}
      ${isMr ? `<div class="wide"><div class="seg" id="bzBPurp"><button type="button" data-p="purchase" class="${pre.purpose !== 'transfer' ? 'on' : ''}">To buy</button><button type="button" data-p="transfer" class="${pre.purpose === 'transfer' ? 'on' : ''}">Move from another store</button></div></div>
        ${storeSel('bzBStore', 'Store that needs the goods', pre.store)}<div id="bzBFromW"${pre.purpose === 'transfer' ? '' : ' hidden'}>${storeSel('bzBFrom', 'Goods come from', stores.find((s) => s.id !== (pre.store || company.default_store))?.id)}</div>` : ''}
      ${kind === 'po' ? storeSel('bzBStore', 'Goods go to', pre.store) : ''}
      ${kind === 'po' || isMr ? field('bzBReq', 'Needed by', `<input class="bz-in" type="date" id="bzBReq" value="${esc(pre.requiredBy || '')}">`) : ''}
      ${kind === 'sq' ? field('bzBValid', 'Valid till', '<input class="bz-in" type="date" id="bzBValid">') : ''}
      ${isBill ? `${textIn('bzBBillNo', 'Their bill number', '', 'As printed on the bill')}${dateIn('bzBBillDate', 'Their bill date', '')}
        ${fromSource ? '' : field('bzBFor', 'What is it for?', '<select id="bzBFor"></select>', 'wide')}<div id="bzBStoreW" hidden>${storeSel('bzBStore', 'Goods go into')}</div>` : ''}
      ${priced ? `${sw('bzBVat', `VAT on this ${isBill ? 'bill' : kind === 'po' ? 'order' : 'quotation'}`, pre.vat ? pre.vat.on : isBill, '')}${sw('bzBIncl', 'Prices include VAT', !!pre.vat?.incl, '')}` : ''}
      <div class="bz-lines wide" id="bzBLines" role="table"><div class="bz-ln${isMr ? ' s' : ''} bz-lh" role="row"><span>Product</span><span class="n">Qty</span><span class="n">${isMr ? 'Price (if known)' : 'Price'}</span>${isMr ? '' : '<span class="n">Off %</span>'}<span class="n">Amount</span><span></span></div></div>
      ${fromSource ? '' : `<button type="button" class="tbtn wide bz-addln" id="bzBAdd">${svg(I.plus)}Add a product</button>`}
      ${priced ? field('bzBDisc', `Discount on the whole ${isBill ? 'bill' : kind === 'po' ? 'order' : 'quotation'} (TZS)`, `<input class="bz-in n" id="bzBDisc" inputmode="decimal" placeholder="0" value="${pre.discount ? esc(pre.discount) : ''}">`) : ''}
      ${kind === 'po' || isBill ? '<div id="bzBTerms"></div>' : ''}
      ${priced ? `<details class="wide bz-more"><summary>Trade terms (imports): incoterm and place</summary><div class="bz-grid c2"><div id="bzBInco"></div>${textIn('bzBPlace', 'Named place', '', 'e.g. Mombasa port', 140)}</div></details>` : ''}
      ${textIn('bzBNote', 'Note', 'wide', '', 500)}
      <div class="bz-totals wide" id="bzBTot"></div>
      ${isBill ? `<div class="wide" id="bzBAdv"></div>
        <details class="wide bz-more"><summary>Write off, hold, paid now</summary><div class="bz-grid c2">
          ${['owner', 'manager', 'accountant'].includes(role()) ? field('bzBWo', 'Small amount not to be paid (written off, TZS)', '<input class="bz-in n" id="bzBWo" inputmode="decimal" placeholder="0">') : ''}
          ${sw('bzBHold', 'Hold this bill: no payment until a date (e.g. a dispute)', false)}<div id="bzBHoldW" hidden>${field('bzBHoldD', 'On hold until', '<input class="bz-in" type="date" id="bzBHoldD">')}</div>
          ${sw('bzBPaid', 'Paid now (a cash purchase)', false)}
          <div class="bz-payrow wide" id="bzBPayW" hidden>${methodSel('bzBPm', 'Paid with', methods.find((x) => x.type === 'Cash')?.id)}${field('bzBPa', 'Amount', '<input class="bz-in n" id="bzBPa" inputmode="decimal">')}</div>
        </div></details>` : ''}
      <div class="bz-formerr wide" role="alert" hidden></div>`);
    body.querySelector('.bz-formerr').before(printing.el);
    const TITLE = { po: 'New purchase order', sq: 'Supplier quotation', mr: 'Stock request', bill: 'Supplier bill' };
    const SUB = { po: 'Goods are on order until they arrive; nothing is booked yet', sq: 'Prices a supplier offers; nothing is booked',
      mr: 'What a store needs: bought from a supplier or moved from another store', bill: 'From a supplier, for goods or expenses' };
    const m = modal({ title: pre.src ? `${TITLE[kind]} · from ${pre.src}` : TITLE[kind], sub: SUB[kind], icon: ACT[kind].icon, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: { po: 'Save order', sq: 'Save quotation', mr: 'Save request', bill: 'Save bill' }[kind], pri: true, onClick: (_, btn) => go(btn) }] });
    const $d = (q) => m.box.querySelector(q);
    enhanceSelects(body);
    if (pre.party) printing.forParty(pre.party);
    // a supplier kept in USD (or another currency): the document is in it, at its rate (money.js fxBox); prices again
    const fx = priced ? fxBox(kit, $d('#bzBFx'), () => party.get(), 'buy', () => $d('#bzBDate').value, () => {
      const c = fx.currency();
      $d('label[for="bzBDisc"]').textContent = `Discount on the whole ${isBill ? 'bill' : kind === 'po' ? 'order' : 'quotation'} (${c})`;
      priceAll(true); preview();
    }) : null;
    if (pre.party) fx?.refresh();
    // payment terms: the supplier's own unless chosen
    let terms = null;
    if ($d('#bzBTerms')) {
      terms = makeField({ key: 'payment_terms', label: 'Payment terms', type: 'link', to: 'payment_terms', help: 'Paying in parts. Empty: the supplier\'s own terms.' }, null, { api: kit.api, defs: kit.defs, titleOf: kit.titleOf });
      $d('#bzBTerms').append(terms.el);
    }
    // trade terms (an import's incoterm, e.g. FOB, and its named place; kept on the document and printed)
    const inco = priced ? makeField({ key: 'incoterm', label: 'Incoterm', type: 'link', to: 'incoterm', help: 'Who pays transport and insurance up to where.' }, pre.incoterm ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf }) : null;
    if (inco) $d('#bzBInco').replaceWith(inco.el);
    if (pre.namedPlace && $d('#bzBPlace')) $d('#bzBPlace').value = pre.namedPlace;
    let purpose = pre.purpose === 'transfer' ? 'transfer' : 'purchase';
    $d('#bzBPurp')?.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      purpose = b.dataset.p;
      $d('#bzBPurp').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      $d('#bzBFromW').hidden = purpose !== 'transfer';
    }));
    const vatOn = priced ? wireSwitch($d('#bzBVat'), (on) => { $d('#bzBIncl').disabled = !on; preview(); }) : () => false;
    const inclOn = priced ? wireSwitch($d('#bzBIncl'), () => preview()) : () => false;
    if (priced) $d('#bzBIncl').disabled = !vatOn();
    $d('#bzBDisc')?.addEventListener('input', () => preview());
    $d('#bzBDate').onchange = () => { if (fx) fx.refresh(); else priceAll(true); };
    const holdOn = isBill ? wireSwitch($d('#bzBHold'), (on) => { $d('#bzBHoldW').hidden = !on; }) : () => false;
    const paidOn = isBill ? wireSwitch($d('#bzBPaid'), (on) => { $d('#bzBPayW').hidden = !on; if (on && totals && !$d('#bzBPa').value) $d('#bzBPa').value = fmt(totals.roundedTotal); }) : () => false;
    $d('#bzBWo')?.addEventListener('input', () => drawTotals());

    // ---- lines
    const lines = [];
    function addLine(l = {}) {
      const row = document.createElement('div');
      row.className = `bz-ln${isMr ? ' s' : ''}`; row.setAttribute('role', 'row');
      const line = { row, auto: false, from: l.from || null, acc: null };
      if (l.from) {
        // a line made from a source keeps its product (the link names that line)
        row.insertAdjacentHTML('beforeend', `<span class="bz-lsrc"><b>${esc(name(l.item))}</b><small class="bz-muted">${esc(l.from.step)} · open ${qty(l.left)}</small></span>`);
        line.prod = { get: () => l.item, focus: () => {} };
      } else {
        line.prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: { active: true, can_buy: true } }, l.item ?? null, {
          api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => { line.ri.value = ''; line.di && (line.di.value = ''); priceOf(line); accountFor(line); preview(); } });
        if (l.item) line.prod.set(l.item, titles[l.item]);
        row.append(line.prod.el);
      }
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Quantity" inputmode="decimal" value="${esc(l.qty ?? 1)}"><input class="bz-in n" aria-label="Price" inputmode="decimal" value="${esc(l.rate === '' || l.rate === undefined ? '' : price(l.rate))}">
        ${isMr ? '' : `<input class="bz-in n" aria-label="Discount %" inputmode="decimal" value="${l.discount ? esc(l.discount) : ''}" placeholder="0">`}<span class="n bz-lamt"></span>
        <button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      [line.qi, line.ri, line.di] = row.querySelectorAll('input.bz-in.n');
      line.qi.oninput = () => { preview(); if (line.auto) ruleAgain(line); };
      line.ri.oninput = () => { line.auto = false; preview(); };
      if (line.di) line.di.oninput = () => preview();
      row.querySelector('.ibtn').onclick = () => { lines.splice(lines.indexOf(line), 1); row.remove(); preview(); };
      // compare what every supplier charges for it, and take a price
      if (priced && mayKind('supplier_quotation')) {
        row.insertAdjacentHTML('beforeend', '<small class="bz-lstock"><button type="button" class="bz-lnk bz-cmpbtn">Compare supplier prices</button></small>');
        row.querySelector('.bz-cmpbtn').onclick = () => { const item = line.prod.get(); if (!item) return kit.toast('Choose the product first'); compareDialog(item, { onUse: ({ supplier, rate }) => {
          line.ri.value = price(rate); line.auto = false;
          if (party && !party.get() && supplier) { party.set(supplier, titles[supplier]); printing.forParty(supplier); drawFor(); drawAdvances(); }
          else if (party && supplier !== party.get()) kit.toast(`${name(supplier)}'s price used; the supplier stays ${name(party.get())}`);
          preview();
        } }); };
      }
      $d('#bzBLines').append(row);
      lines.push(line);
      if (l.item && !l.from && (l.rate === undefined || l.rate === '')) priceOf(line);
      if (l.item && !l.from) accountFor(line);
      return line;
    }
    $d('#bzBAdd')?.addEventListener('click', () => addLine().prod.focus());
    // a service on a bill (rent, transport) is booked to an expense account: the product's own, which can be changed here
    async function accountFor(line) {
      if (!isBill) return;
      line.row.querySelector('.bz-lacc')?.remove(); line.acc = null;
      const p = line.prod.get() ? await kit.api.doc('product', line.prod.get()).then((x) => x?.doc).catch(() => null) : null;
      if (!p || p.is_stock !== false) return;
      const wrap = document.createElement('div'); wrap.className = 'bz-lacc';
      line.acc = makeField({ key: 'account', label: 'Booked to', type: 'link', to: 'account', filter: { is_group: false, root_type: 'Expense' } }, p.expense_account ?? null,
        { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true });
      wrap.append(line.acc.el);
      line.row.append(wrap);
    }
    // the supplier's price (their own row on a buying list first, then the list's), then a buying pricing rule
    async function priceOf(line, refresh = false) {
      const item = line.prod.get();
      if (!item || line.from) return;
      const fill = !line.ri.value || (refresh && line.auto);
      try {
        const f = fx?.get() || {};
        const r = await kit.api.price(item, party?.get() || undefined, 'buy', $d('#bzBDate').value || undefined, num(line.qi.value) || 1, undefined, f.currency, f.exchange_rate);
        if (r?.price && fill) { line.ri.value = price(r.price.rate); line.auto = true; line.base = r.price.rate; }
        line.ri.title = r?.price?.last ? `Last paid ${price(r.price.last.rate ?? r.price.rate)} on ${day(r.price.last.date)} (${r.price.last.step})` : '';
        const rule = priced ? r?.rule : null;
        line.row.querySelector('.bz-rule')?.remove();
        if (rule?.error) line.row.insertAdjacentHTML('beforeend', `<small class="bz-rule bz-ferr">${esc(rule.error)}</small>`);
        if (line.auto && rule && !rule.error) {
          const base = line.base ?? num(line.ri.value);
          if (rule.action === 'Fixed price') { line.ri.value = price(rule.value); line.di.value = ''; }
          else if (rule.action === 'Discount %') { line.ri.value = price(base); line.di.value = String(rule.value); }
          else { line.ri.value = price(Math.max(0, base - rule.value)); line.di.value = ''; }
          line.rule = rule.rule;
          line.row.insertAdjacentHTML('beforeend', `<small class="bz-rule bz-muted">Pricing rule: ${esc(rule.title)}</small>`);
        } else if (line.auto && line.rule && !rule) { line.ri.value = price(line.base ?? num(line.ri.value)); if (line.di) line.di.value = ''; line.rule = null; }
        preview();
      } catch {}
    }
    const priceAll = (refresh) => lines.forEach((l) => priceOf(l, refresh));
    const ruleAgain = debounce((line) => priceOf(line, true), 350);
    for (const l of pre.lines || []) addLine(l);
    if (!lines.length) addLine();

    // ---- a bill: what it is for (services, goods arriving now, goods that arrived, an order), and advances
    function drawFor() {
      const sel = $d('#bzBFor');
      if (!sel) return;
      const p = party?.get();
      const prs = p ? docs().filter((x) => x.kind === 'purchase_receipt' && !stepOf(x.step)?.returnOf && stepOf(x.step)?.supplier === p && ['To Bill', 'Partly Billed'].includes(x.status)) : [];
      const pos = p ? docs().filter((x) => x.kind === 'purchase_order' && stepOf(x.step)?.supplier === p && !['Closed', 'On Hold', 'Completed', 'Cancelled'].includes(x.status) && (x.perBilled ?? 0) < 100) : [];
      const was = sel.value;
      sel.innerHTML = `<option value="">Services, or goods still to arrive</option><option value="now">Goods arriving with this bill</option>
        ${prs.length ? `<optgroup label="Goods that arrived">${prs.map((x) => `<option value="${esc(x.step)}">${esc(x.step)} · ${esc(day(stepOf(x.step)?.date))}</option>`).join('')}</optgroup>` : ''}
        ${pos.length ? `<optgroup label="Purchase orders">${pos.map((x) => `<option value="${esc(x.step)}">${esc(x.step)} · ${fmt(x.totals?.roundedTotal)}</option>`).join('')}</optgroup>` : ''}`;
      sel.value = [...sel.options].some((o) => o.value === was) ? was : '';
      enhanceSelects(sel.parentElement);
    }
    $d('#bzBFor')?.addEventListener('change', () => {
      const v = $d('#bzBFor').value;
      $d('#bzBStoreW').hidden = v !== 'now';
      if (!v || v === 'now') return preview();
      const s = stepOf(v);
      const open = leftOn(v, 'bill').filter((x) => x.left > 0);
      const p2 = linesFrom(s, open, 'bill');
      lines.splice(0).forEach((l) => l.row.remove());
      p2.lines.forEach((l) => addLine(l));
      if (p2.vat) { setSwitch($d('#bzBVat'), p2.vat.on); setSwitch($d('#bzBIncl'), p2.vat.incl); $d('#bzBIncl').disabled = !p2.vat.on; }
      if (p2.discount) $d('#bzBDisc').value = p2.discount;
      drawAdvances();
      preview();
    });
    if (isBill && pre.storeNow) { $d('#bzBFor').value = 'now'; $d('#bzBStoreW').hidden = false; }
    drawFor();
    let credits = [];
    function drawAdvances() {
      const box = $d('#bzBAdv');
      if (!box) return;
      const p = party?.get();
      credits = p ? creditsOf(p) : [];
      if (!credits.length) { box.innerHTML = ''; return; }
      // an advance paid on the order this bill is made from is set against it at once
      const orders = new Set(lines.map((l) => l.from?.step).filter(Boolean).flatMap((id) => { const x = stepOf(id); return x?.kind === 'purchase_order' ? [id] : (x?.lines || []).map((y) => y.from?.step).filter(Boolean); }));
      box.innerHTML = `<p class="bz-note">Money already paid to ${esc(name(p))} that can be set against this bill:</p><div class="bz-lines"><div class="bz-ln p bz-lh" role="row"><span>Payment</span><span>Date</span><span class="n">Free</span><span class="n">Set against this bill</span></div>
        ${credits.map((c, k) => `<div class="bz-ln p" role="row"><span>${esc(c.step)}${c.orders.length ? ` <small class="bz-muted">advance on ${esc(c.orders.join(', '))}</small>` : ''}</span><span>${esc(day(c.date))}</span>
          <span class="n">${fmt(c.left)}</span><input class="bz-in n" data-k="${k}" inputmode="decimal" aria-label="Amount of ${esc(c.step)}" value="${c.orders.some((o) => orders.has(o)) ? esc(c.left) : ''}"></div>`).join('')}</div>`;
      box.querySelectorAll('input').forEach((i) => (i.oninput = () => drawTotals()));
      drawTotals();
    }
    drawAdvances();
    queueMicrotask(() => drawTotals());
    requestAnimationFrame(() => (party && !party.get() ? party.focus() : lines[0]?.prod.focus()));

    // ---- totals (the server's own VAT and discount rules)
    function draftLines() {
      return lines.map((l) => ({ item: l.prod.get(), qty: num(l.qi.value), ...(l.ri.value.trim() !== '' || priced ? { rate: num(l.ri.value) } : {}),
        ...(l.di && num(l.di.value) ? { discount: num(l.di.value) } : {}), ...(l.from ? { from: l.from } : {}), ...(l.acc?.get() ? { account: l.acc.get() } : {}) })).filter((l) => l.item);
    }
    const preview = debounce(async () => {
      lines.forEach((l) => { const a = num(l.qi.value) * lineRate({ rate: num(l.ri.value), discount: l.di ? num(l.di.value) : 0 }); l.row.querySelector('.bz-lamt').textContent = a ? fmt(a) : ''; });
      const ls = draftLines();
      const my = ++seq;
      if (!priced || !ls.length || ls.some((l) => !(l.qty > 0) || !(l.rate >= 0)) || !party?.get()) { totals = null; drawTotals(); return; }
      const pv = { kind: 'purchase_invoice', supplier: party.get(), lines: isBill ? ls : ls.map(({ from, ...l }) => l), vat: vatOn(), prices_include_vat: vatOn() && inclOn(),
        discount_amount: num($d('#bzBDisc').value) || undefined, ...fx.get() };
      try { const t = await kit.api.preview(pv); if (my === seq) { totals = t; drawTotals(); } }
      catch (e) {
        if (my !== seq) return;
        // someone who may not record bills (a storekeeper on a quotation) still sees the lines added up
        if (e.status === 403) { const n = r2(ls.reduce((a, l) => a + lineAmt(l), 0) - (num($d('#bzBDisc').value) || 0)); totals = { netTotal: n, vat: 0, roundedTotal: n, local: true }; drawTotals(); }
        else { totals = null; drawTotals(errText(e)); }
      }
    }, 200);
    function drawTotals(problem) {
      const t = totals;
      const tq = lines.reduce((a, l) => a + (l.prod.get() ? num(l.qi.value) || 0 : 0), 0);
      const adv = [...m.box.querySelectorAll('#bzBAdv input')].reduce((a, i) => a + num(i.value), 0);
      const wo = num($d('#bzBWo')?.value) || 0;
      $d('#bzBTot').innerHTML = `<div class="bz-mrow"><span>Total quantity</span><span>${qty(tq)}</span></div>` + (t ? `${t.discount ? `<div class="bz-mrow"><span>Discount on the whole</span><span>− ${cents(t.discount)}</span></div>` : ''}
        ${t.local ? '' : `<div class="bz-mrow"><span>Before VAT</span><span>${cents(t.netTotal)}</span></div><div class="bz-mrow"><span>VAT</span><span>${cents(t.vat)}</span></div>`}
        <div class="bz-mrow big"><span>Total${t.local ? ' (before VAT)' : ''}</span><span>${t.currency ? `${esc(t.currency.code)} ${cents(t.roundedTotal)}` : fx && fx.currency() !== 'TZS' ? `${esc(fx.currency())} ${cents(t.roundedTotal)}` : tzs(t.roundedTotal)}</span></div>
        ${t.currency ? `<div class="bz-mrow"><span>In TZS (1 ${esc(t.currency.code)} = ${fmt(t.currency.rate)})</span><span>${tzs(t.currency.roundedTotal)}</span></div>` : ''}
        ${adv || wo ? `<div class="bz-mrow"><span>Advances set against it${wo ? ' · written off' : ''}</span><span>− ${fmt(adv + wo)}</span></div><div class="bz-mrow"><span>Still owed after this</span><span>${tzs(Math.max(0, t.roundedTotal - adv - wo))}</span></div>` : ''}`
        : priced ? `<p class="bz-note">${esc(problem || 'Choose the supplier and add products to see the total.')}</p>` : '');
    }
    preview();

    async function go(btn) {
      showErr(m, '');
      const ls = draftLines();
      if (party && !party.get()) { party.error('Choose the supplier'); return party.focus(); }
      if (!ls.length) return showErr(m, 'Add at least one product');
      const bad = ls.findIndex((l) => !(l.qty > 0));
      if (bad >= 0) return showErr(m, `Line ${bad + 1}: enter a quantity`);
      // a line at price 0 is usually a price not typed (04: rate-0 guard); free goods are allowed on purpose
      const free = priced ? ls.findIndex((l) => !(l.rate > 0)) : -1;
      if (free >= 0 && !(await confirmBox({ title: `Line ${free + 1} has no price`, text: 'Save it at 0 (free goods)? Otherwise type the price.', ok: 'Save at 0', cancel: 'Type the price' }))) return;
      const base = { date: $d('#bzBDate').value, lines: ls, remarks: $d('#bzBNote').value.trim() || undefined, client_id: clientId, ...(pre.print || {}), ...printing.get() };
      const money = priced ? { vat: vatOn(), prices_include_vat: vatOn() && inclOn(), discount_amount: num($d('#bzBDisc').value) || undefined, ...fx.get(),
        ...(inco?.get() ? { incoterm: inco.get(), named_place: $d('#bzBPlace').value.trim() || undefined } : {}) } : {};
      let step;
      if (kind === 'mr') {
        if (purpose === 'transfer' && $d('#bzBFrom').value === $d('#bzBStore').value) return showErr(m, 'Choose another store for the goods to come from');
        step = { ...base, kind: 'material_request', purpose, warehouse: $d('#bzBStore').value, ...(purpose === 'transfer' ? { from: $d('#bzBFrom').value } : {}), required_by: $d('#bzBReq').value || undefined };
      } else if (kind === 'sq') step = { ...base, ...money, kind: 'supplier_quotation', supplier: party.get(), valid_till: $d('#bzBValid').value || undefined };
      else if (kind === 'po') step = { ...base, ...money, kind: 'purchase_order', supplier: party.get(), warehouse: $d('#bzBStore').value, required_by: $d('#bzBReq').value || undefined,
        ...(terms?.get() ? { payment_terms: terms.get() } : {}) };
      else {
        const f = $d('#bzBFor')?.value;
        const advances = [...m.box.querySelectorAll('#bzBAdv input')].map((i) => ({ from: credits[+i.dataset.k].step, amount: num(i.value) })).filter((a) => a.amount > 0);
        step = { ...base, ...money, kind: 'purchase_invoice', supplier: party.get(), bill_no: $d('#bzBBillNo').value.trim() || undefined, bill_date: $d('#bzBBillDate').value || undefined,
          ...(f === 'now' ? { update_stock: true, warehouse: $d('#bzBStore').value } : {}), ...(terms?.get() ? { payment_terms: terms.get() } : {}),
          ...(advances.length ? { advances } : {}), ...(num($d('#bzBWo')?.value) > 0 ? { write_off: num($d('#bzBWo').value) } : {}),
          ...(holdOn() ? { hold: true, hold_until: $d('#bzBHoldD').value || undefined } : {}),
          ...(paidOn() && num($d('#bzBPa').value) > 0 ? { payments: [{ method: $d('#bzBPm').value, amount: num($d('#bzBPa').value) }] } : {}) };
      }
      save(step, m, btn, TITLE[kind]);
    }
  }

  /** Goods arrived from a supplier (or from an order): accepted and refused per line, the store for refused goods, the
   *  supplier's delivery note number and how the goods came. */
  async function grDialog(pre = {}) {
    if (!stores.length) return kit.toast('Add a store first (Setup > Stores and vans)');
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    const printing = printOptions(kit, 'gr');
    const party = makeField({ key: 'party', label: 'Supplier', type: 'link', to: 'supplier', required: true, filter: { active: true } }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { printing.forParty(party.get()); fx.refresh(); } });
    body.append(party.el);
    if (pre.party) party.set(pre.party, titles[pre.party]);
    // refused goods only go to a store marked "For refused goods" (the server refuses any other)
    const refusedFirst = stores.filter((s) => refusedStores.has(s.id));
    body.insertAdjacentHTML('beforeend', `${dateIn('bzBDate')}<div class="wide" id="bzBFx" hidden></div>${storeSel('bzBStore', 'Goods go into', pre.store)}
      ${textIn('bzBNoteNo', 'Supplier\'s delivery note number', '', 'As on their paper')}
      ${refusedFirst.length ? field('bzBRej', 'Refused goods go to', `<select id="bzBRej"><option value="">—</option>${storeOpts(refusedFirst[0].id, refusedFirst)}</select>`)
        : '<p class="bz-note">To refuse goods on arrival, first mark a store "For refused goods" (Setup &gt; Stores and vans).</p>'}
      <details class="wide bz-more"><summary>Transport (transport company, waybill, vehicle)</summary><div class="bz-grid c2"><div id="bzBTrW"></div>
        ${textIn('bzBLr', 'Waybill number', '', 'Their waybill or LR number')}${dateIn('bzBLrD', 'Waybill date', '')}${textIn('bzBVeh', 'Vehicle', '', 'e.g. T 123 ABC', 40)}</div></details>
      <div class="bz-lines wide" id="bzBLines" role="table"><div class="bz-ln g bz-lh" role="row"><span>Product</span><span class="n">Kept</span><span class="n">Refused</span><span class="n">Cost per unit</span><span></span></div></div>
      ${pre.src ? '' : `<button type="button" class="tbtn wide bz-addln" id="bzBAdd">${svg(I.plus)}Add a product</button>`}
      ${textIn('bzBNote', 'Note', 'wide', 'e.g. 10 bags torn', 500)}
      <div class="bz-totals wide" id="bzBTot"></div><div class="bz-formerr wide" role="alert" hidden></div>`);
    body.querySelector('.bz-formerr').before(printing.el);
    const transporter = makeField({ key: 'transporter', label: 'Transport company', type: 'link', to: 'supplier', filter: { active: true } }, null, { api: kit.api, defs: kit.defs, titleOf: kit.titleOf });
    body.querySelector('#bzBTrW').replaceWith(transporter.el);
    const m = modal({ title: pre.src ? `Goods arrived · from ${pre.src}` : 'Goods arrived', sub: 'Count what came: what you keep goes into stock at cost; refused goods are kept apart at no value',
      icon: I.arrived, wide: true, body, actions: [{ label: 'Cancel', value: false }, { label: 'Save goods arrived', pri: true, onClick: (_, btn) => go(btn) }] });
    const $d = (q) => m.box.querySelector(q);
    enhanceSelects(body);
    if (pre.party) printing.forParty(pre.party);
    // a supplier kept in another currency: costs are in it, at the rate (money.js fxBox)
    const fx = fxBox(kit, $d('#bzBFx'), () => party.get(), 'buy', () => $d('#bzBDate').value, () => {});
    if (pre.party) fx.refresh();
    $d('#bzBDate').addEventListener('change', () => fx.refresh());
    const lines = [];
    function addLine(l = {}) {
      const row = document.createElement('div');
      row.className = 'bz-ln g'; row.setAttribute('role', 'row');
      const line = { row, from: l.from || null };
      if (l.from) {
        row.insertAdjacentHTML('beforeend', `<span class="bz-lsrc"><b>${esc(name(l.item))}</b><small class="bz-muted">${esc(l.from.step)} · still to come ${qty(l.left)}</small></span>`);
        line.prod = { get: () => l.item, focus: () => {} };
      } else {
        line.prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: { is_stock: true, active: true } }, null,
          { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => costOf(line) });
        row.append(line.prod.el);
      }
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Kept" inputmode="decimal" value="${esc(l.qty ?? '')}" placeholder="0"><input class="bz-in n" aria-label="Refused" inputmode="decimal" placeholder="0">
        <input class="bz-in n" aria-label="Cost per unit" inputmode="decimal" value="${l.rate === undefined || l.rate === '' ? '' : esc(price(l.rate))}"><button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      [line.qi, line.xi, line.ri] = row.querySelectorAll('input.bz-in.n');
      [line.qi, line.xi, line.ri].forEach((i) => (i.oninput = sums));
      line.xi.addEventListener('input', () => { if (num(line.xi.value) > 0 && $d('#bzBRej') && !$d('#bzBRej').value && refusedFirst[0]) { $d('#bzBRej').value = refusedFirst[0].id; enhanceSelects($d('#bzBRej').parentElement); } });
      row.querySelector('.ibtn').onclick = () => { lines.splice(lines.indexOf(line), 1); row.remove(); sums(); };
      $d('#bzBLines').append(row);
      lines.push(line);
      return line;
    }
    // a starting cost: the supplier's buying price, else what it is valued at now
    async function costOf(line) {
      const item = line.prod.get();
      if (!item || line.ri.value) return;
      const f = fx.get();
      const p = await kit.api.price(item, party.get() || undefined, 'buy', $d('#bzBDate').value, undefined, undefined, f.currency, f.exchange_rate).catch(() => null);
      if (p?.price && !line.ri.value) { line.ri.value = price(p.price.rate); sums(); }
    }
    function sums() {
      const kept = lines.reduce((a, l) => a + (num(l.qi.value) || 0), 0), refused = lines.reduce((a, l) => a + (num(l.xi.value) || 0), 0);
      const value = lines.reduce((a, l) => a + (num(l.qi.value) || 0) * (num(l.ri.value) || 0), 0);
      $d('#bzBTot').innerHTML = `<div class="bz-mrow"><span>Total kept · refused</span><span>${qty(kept)} · ${qty(refused)}</span></div><div class="bz-mrow big"><span>Value of what is kept</span><span>${tzs(value)}</span></div>`;
    }
    $d('#bzBAdd')?.addEventListener('click', () => addLine().prod.focus());
    for (const l of pre.lines || []) addLine(l);
    if (!lines.length) addLine();
    sums();
    requestAnimationFrame(() => (!party.get() ? party.focus() : lines[0]?.qi.focus()));
    function go(btn) {
      showErr(m, '');
      if (!party.get()) { party.error('Choose the supplier'); return party.focus(); }
      const out = [];
      for (const [i, l] of lines.entries()) {
        const item = l.prod.get(), q = num(l.qi.value) || 0, x = num(l.xi.value) || 0;
        if (!item && !q && !x) continue;
        if (!item) return showErr(m, `Line ${i + 1}: choose a product`);
        if (!(q > 0) && !(x > 0)) continue;
        if (l.ri.value.trim() === '' || !(num(l.ri.value) >= 0)) return showErr(m, `Line ${i + 1}: enter the cost per unit`);
        out.push({ item, qty: q, rate: num(l.ri.value), ...(x > 0 ? { rejected: x } : {}), ...(l.from ? { from: l.from } : {}) });
      }
      if (!out.length) return showErr(m, 'Enter what arrived');
      if (out.some((l) => !(l.qty > 0))) return showErr(m, 'A line where everything was refused: keep at least one, or leave the line out');
      if (out.some((l) => l.rejected) && !$d('#bzBRej')?.value) return showErr(m, 'Choose the store for refused goods (mark one "For refused goods" in Setup > Stores)');
      save({ kind: 'purchase_receipt', supplier: party.get(), warehouse: $d('#bzBStore').value, date: $d('#bzBDate').value, lines: out, ...fx.get(),
        ...(out.some((l) => l.rejected) ? { rejected_warehouse: $d('#bzBRej').value } : {}),
        supplier_note: $d('#bzBNoteNo').value.trim() || undefined, transporter: transporter.get() || undefined, lr_no: $d('#bzBLr').value.trim() || undefined,
        lr_date: $d('#bzBLrD').value || undefined, vehicle: $d('#bzBVeh').value.trim() || undefined, remarks: $d('#bzBNote').value.trim() || undefined,
        client_id: clientId, ...(pre.print || {}), ...printing.get() }, m, btn, 'Goods arrived');
    }
  }

  /** Send goods back: from goods arrived (they leave the store at the cost they came in) or a debit note on a bill. */
  function backChooser() {
    const grs = docs().filter((x) => x.kind === 'purchase_receipt' && !stepOf(x.step)?.returnOf && !['Return Issued', 'Cancelled'].includes(x.status)).reverse();
    const bills = invoices().filter((i) => stepOf(i.step)?.kind === 'purchase_invoice' && i.status !== 'Cancelled' && !stepOf(i.step)?.opening).reverse();
    const mayGr = mayKind('purchase_receipt'), mayDn = mayKind('debit_note');
    if (!(mayGr && grs.length) && !(mayDn && bills.length)) return kit.toast('Nothing to send back yet');
    const body = document.createElement('form');
    body.className = 'bz-grid c2'; body.noValidate = true;
    body.innerHTML = `${mayGr && grs.length ? field('bzBBackGr', 'Goods that arrived (not billed yet, or billed: then also a debit note)', `<select id="bzBBackGr"><option value="">—</option>${grs.map((x) => `<option value="${esc(x.step)}">${esc(x.step)} · ${esc(name(stepOf(x.step)?.supplier))} · ${esc(day(stepOf(x.step)?.date))}</option>`).join('')}</select>`, 'wide') : ''}
      ${mayDn && bills.length ? field('bzBBackBill', 'Or a supplier bill (debit note)', `<select id="bzBBackBill"><option value="">—</option>${bills.map((i) => `<option value="${esc(i.step)}">${esc(i.step)} · ${esc(name(i.party))} · ${fmt(i.roundedTotal)}</option>`).join('')}</select>`, 'wide') : ''}`;
    const m = modal({ title: 'Send goods back', sub: 'Choose what they came on', icon: I.undo, body, actions: [{ label: 'Cancel', value: false }, { label: 'Next', pri: true, value: 'next' }] });
    enhanceSelects(body);
    m.done.then((v) => {
      if (v !== 'next') return;
      const gr = body.querySelector('#bzBBackGr')?.value, bill = body.querySelector('#bzBBackBill')?.value;
      if (gr) backGoods(gr); else if (bill) debitDialog(bill); else kit.toast('Choose goods arrived or a bill');
    });
  }
  function backGoods(grId) {
    const s = stepOf(grId);
    const open = leftOn(grId, 'back').filter((x) => x.left > 0);
    if (!s || !open.length) return kit.toast(`Nothing left to send back on ${grId}`);
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${dateIn('bzBDate')}<div class="bz-fld"><span class="bz-lbl">From</span><span>${esc(name(s.warehouse))}</span></div>
      <div class="bz-lines wide" id="bzBLines"><div class="bz-ln r bz-lh" role="row"><span>Product</span><span class="n">Can go back</span><span class="n">Back now</span></div>
      ${open.map((x) => `<div class="bz-ln r" role="row"><span>${esc(name(x.l.item))} <small class="bz-muted">@ ${price(x.l.rate)}</small></span><span class="n">${qty(x.left)}</span>
        <input class="bz-in n" data-i="${x.i}" inputmode="decimal" value="${esc(x.left)}" aria-label="Quantity going back"></div>`).join('')}</div>
      <p class="bz-note wide">They leave the store at the cost they came in. If the supplier already billed them, also make a debit note on that bill.</p>
      ${textIn('bzBNote', 'Why they go back', 'wide', 'e.g. torn bags, wrong product', 500)}<div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: `Send back · ${grId}`, sub: name(s.supplier), icon: I.undo, wide: true, body, actions: [{ label: 'Cancel', value: false }, { label: 'Send back', pri: true, onClick: (_, btn) => go(btn) }] });
    const $d = (q) => m.box.querySelector(q);
    function go(btn) {
      const lines = [...m.box.querySelectorAll('#bzBLines input')].map((i) => { const l = s.lines[+i.dataset.i]; return { item: l.item, qty: num(i.value), rate: l.rate, from: { step: grId, line: +i.dataset.i } }; }).filter((l) => l.qty > 0);
      if (!lines.length) return showErr(m, 'Nothing is going back');
      save({ kind: 'purchase_receipt', supplier: s.supplier, warehouse: s.warehouse, return_against: grId, date: $d('#bzBDate').value, lines,
        remarks: $d('#bzBNote').value.trim() || undefined, client_id: clientId }, m, btn, 'Goods sent back');
    }
  }
  /** A debit note on a supplier bill: goods or charges going back; what we owe falls (off the bill, or as credit with them). */
  function debitDialog(billId) {
    const s = stepOf(billId), inv = invOf(billId);
    if (!s) return;
    const open = leftOn(billId, 'debit').filter((x) => x.left > 0);
    if (!open.length) return kit.toast(`Nothing left to return on ${billId}`);
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${dateIn('bzBDate')}${textIn('bzBCn', 'Their credit note number', '', 'If they sent one')}
      <div class="bz-lines wide" id="bzBLines"><div class="bz-ln r bz-lh" role="row"><span>Product</span><span class="n">Billed</span><span class="n">Back now</span></div>
      ${open.map((x) => `<div class="bz-ln r" role="row"><span>${esc(name(x.l.item))} <small class="bz-muted">@ ${fmt(lineRate(x.l))}</small></span><span class="n">${qty(x.left)}</span>
        <input class="bz-in n" data-i="${x.i}" inputmode="decimal" value="${esc(x.left)}" aria-label="Quantity going back"></div>`).join('')}</div>
      ${s.updateStock ? sw('bzBOut', 'The goods leave the store with this note', true) : '<p class="bz-note wide">This bill brought no goods in itself: send goods that arrived back from Goods arrived.</p>'}
      ${(inv?.outstanding || 0) > 0.004 ? sw('bzBRed', 'Take it off what we still owe on this bill', true) : '<p class="bz-note wide">The bill is paid: it is kept as credit with them (set it against their next bill, or they pay it back).</p>'}
      ${textIn('bzBNote', 'Why', 'wide', '', 500)}<div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: `Debit note · ${billId}`, sub: name(s.supplier), icon: I.undo, wide: true, body, actions: [{ label: 'Cancel', value: false }, { label: 'Save debit note', pri: true, onClick: (_, btn) => go(btn) }] });
    const $d = (q) => m.box.querySelector(q);
    const outOn = $d('#bzBOut') ? wireSwitch($d('#bzBOut')) : () => false;
    const redOn = $d('#bzBRed') ? wireSwitch($d('#bzBRed')) : () => false;
    function go(btn) {
      const inputs = [...m.box.querySelectorAll('#bzBLines input')];
      const lines = inputs.map((i) => ({ item: s.lines[+i.dataset.i].item, qty: num(i.value) })).filter((l) => l.qty > 0);
      if (!lines.length) return showErr(m, 'Nothing is going back');
      const all = open.length === s.lines.length && inputs.every((i) => num(i.value) === s.lines[+i.dataset.i].qty);
      save({ kind: 'debit_note', against: billId, date: $d('#bzBDate').value, ...(all ? {} : { lines }), update_stock: outOn(), reduce_invoice: redOn(),
        bill_no: $d('#bzBCn').value.trim() || undefined, remarks: $d('#bzBNote').value.trim() || undefined, client_id: clientId }, m, btn, 'Debit note');
    }
  }

  /** Move goods a transfer request asks for: from the other store into the store that needs them. */
  function moveDialog(mrId) {
    const s = stepOf(mrId);
    const open = leftOn(mrId, 'move').filter((x) => x.left > 0);
    if (!s || !open.length) return kit.toast(`Nothing left to move on ${mrId}`);
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${dateIn('bzBDate')}<div class="bz-fld"><span class="bz-lbl">From · to</span><span>${esc(name(s.from))} → ${esc(name(s.warehouse))}</span></div>
      <div class="bz-lines wide" id="bzBLines"><div class="bz-ln r bz-lh" role="row"><span>Product</span><span class="n">Still asked for</span><span class="n">Move now</span></div>
      ${open.map((x) => `<div class="bz-ln r" role="row"><span>${esc(name(x.l.item))}</span><span class="n">${qty(x.left)}</span><input class="bz-in n" data-i="${x.i}" inputmode="decimal" value="${esc(x.left)}" aria-label="Quantity to move"></div>`).join('')}</div>
      ${textIn('bzBNote', 'Note', 'wide', '', 500)}<div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: `Move stock · ${mrId}`, sub: 'The goods move between your stores at their cost', icon: I.move, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Move', pri: true, onClick: (_, btn) => go(btn) }] });
    const $d = (q) => m.box.querySelector(q);
    function go(btn) {
      const lines = [...m.box.querySelectorAll('#bzBLines input')].map((i) => ({ item: s.lines[+i.dataset.i].item, qty: num(i.value), from: { step: mrId, line: +i.dataset.i } })).filter((l) => l.qty > 0);
      if (!lines.length) return showErr(m, 'Nothing to move');
      save({ kind: 'transfer', from: s.from, to: s.warehouse, date: $d('#bzBDate').value, lines, remarks: $d('#bzBNote').value.trim() || undefined, client_id: clientId }, m, btn, 'Stock moved');
    }
  }

  /** Pay a supplier: their open bills (oldest first; bills on hold are left alone), or an advance on a purchase order. */
  function payDialog(pre = {}) {
    if (!mayKind('payment')) return kit.toast('Your role cannot record payments');
    const clientId = uid();
    let mode = pre.mode === 'advance' ? 'advance' : 'bills';
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    const party = makeField({ key: 'party', label: 'Supplier', type: 'link', to: 'supplier', required: true }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { fx.refresh(); draw(true); } });
    body.innerHTML = `<div class="wide"><div class="seg" id="bzBMode"><button type="button" data-m="bills" class="${mode === 'bills' ? 'on' : ''}">Pay bills</button><button type="button" data-m="advance" class="${mode === 'advance' ? 'on' : ''}">Advance on an order</button></div></div>`;
    body.append(party.el);
    if (pre.party) party.set(pre.party, titles[pre.party]);
    body.insertAdjacentHTML('beforeend', `${dateIn('bzBDate')}<div class="wide" id="bzBFx" hidden></div>${methodSel('bzBPm', 'Paid by', (methods.find((x) => x.type === 'Bank') || methods[0])?.id)}
      ${field('bzBAmt', 'Amount (TZS)', '<input class="bz-in n" id="bzBAmt" inputmode="decimal">')}${textIn('bzBRef', 'Reference', '', 'Cheque, transfer or M-Pesa code', 80)}
      ${textIn('bzBNote', 'Note', 'wide', '', 500)}<div class="wide" id="bzBOpen"></div><div class="bz-formerr wide" role="alert" hidden></div>`);
    const m = modal({ title: 'Pay supplier', sub: 'What is not set against a bill or an order stays as credit with them', icon: I.money, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save payment', pri: true, onClick: (_, btn) => go(btn) }] });
    const $d = (q) => m.box.querySelector(q);
    enhanceSelects(body);
    // a supplier kept in another currency: the amount is in it, at the rate (money.js fxBox)
    const fx = fxBox(kit, $d('#bzBFx'), () => party.get(), 'buy', () => $d('#bzBDate').value, () => {
      $d('label[for="bzBAmt"]').textContent = `Amount (${fx.currency()})`;
    });
    if (pre.party) fx.refresh();
    $d('#bzBDate').addEventListener('change', () => fx.refresh());
    $d('#bzBMode').querySelectorAll('button').forEach((b) => (b.onclick = () => {
      mode = b.dataset.m;
      $d('#bzBMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      $d('#bzBAmt').value = '';
      draw(true);
    }));
    $d('#bzBAmt').oninput = () => spread();
    let bills = [], orders = [];
    function draw(fill) {
      const p = party.get();
      const box = $d('#bzBOpen');
      if (!p) { box.innerHTML = ''; return; }
      if (mode === 'advance') {
        orders = openOrders(p);
        box.innerHTML = orders.length ? field('bzBOrder', 'For order', `<select id="bzBOrder">${orders.map((x) => `<option value="${esc(x.step)}"${x.step === pre.order ? ' selected' : ''}>${esc(x.step)} · ${fmt(x.totals?.roundedTotal)}${x.advancePaid ? ` · advance paid ${fmt(x.advancePaid)}` : ''}</option>`).join('')}</select>`)
          : '<p class="bz-note">They have no open purchase order: the amount is kept as credit with them.</p>';
        enhanceSelects(box);
        const o = () => orders.find((x) => x.step === $d('#bzBOrder')?.value);
        $d('#bzBOrder')?.addEventListener('change', () => { $d('#bzBAmt').value = fmt(Math.max(0, (o()?.totals?.roundedTotal || 0) - (o()?.advancePaid || 0))); });
        if (fill && o() && !$d('#bzBAmt').value) $d('#bzBAmt').value = fmt(Math.max(0, (o().totals?.roundedTotal || 0) - (o().advancePaid || 0)));
        return;
      }
      bills = openBills(p);
      box.innerHTML = bills.length ? `<div class="bz-lines"><div class="bz-ln p bz-lh" role="row"><span>Bill</span><span>Due</span><span class="n">Owed</span><span class="n">This payment</span></div>
        ${bills.map((i, k) => { const s = stepOf(i.step); return `<div class="bz-ln p" role="row"><span>${esc(i.step)}${s?.billNo ? ` <small class="bz-muted">${esc(s.billNo)}</small>` : ''}${heldNow(s) ? ' <span class="bz-st bad">On hold</span>' : ''}</span>
          <span>${esc(day(s?.dueDate))}</span><span class="n">${fmt(i.outstanding)}</span><input class="bz-in n" data-k="${k}" inputmode="decimal" aria-label="Amount for ${esc(i.step)}"${heldNow(s) ? ' disabled' : ''}></div>`; }).join('')}</div>`
        : '<p class="bz-note">No open bills: the whole amount is kept as credit with them.</p>';
      if (fill && !$d('#bzBAmt').value) {
        const due = pre.bill ? bills.filter((i) => i.step === pre.bill) : bills.filter((i) => !heldNow(stepOf(i.step)));
        const sum = due.reduce((a, i) => a + i.outstanding, 0);
        if (sum > 0) $d('#bzBAmt').value = fmt(sum);
      }
      spread();
    }
    function spread() {
      if (mode !== 'bills') return;
      let left = num($d('#bzBAmt').value);
      // the bill being paid first, then the oldest; bills on hold get nothing
      const order = bills.map((b, k) => k).sort((a, b) => (bills[b].step === pre.bill) - (bills[a].step === pre.bill));
      for (const k of order) {
        const inp = m.box.querySelector(`#bzBOpen input[data-k="${k}"]`);
        if (!inp || inp.disabled) continue;
        const a = Math.min(bills[k].outstanding, Math.max(0, left));
        inp.value = a ? fmt(a) : ''; left -= a;
      }
    }
    draw(true);
    function go(btn) {
      showErr(m, '');
      const amount = num($d('#bzBAmt').value);
      if (!party.get()) { party.error('Choose the supplier'); return party.focus(); }
      if (!(amount > 0)) return showErr(m, 'Enter the amount');
      const extra = mode === 'advance'
        ? ($d('#bzBOrder')?.value ? { advance_for: [{ order: $d('#bzBOrder').value, amount }] } : {})
        : { allocate: [...m.box.querySelectorAll('#bzBOpen input')].map((i) => ({ invoice: bills[+i.dataset.k].step, amount: num(i.value) })).filter((a) => a.amount > 0) };
      save({ kind: 'payment', direction: 'out', party: party.get(), method: $d('#bzBPm').value, amount, date: $d('#bzBDate').value, ...extra, ...fx.get(),
        reference: $d('#bzBRef').value.trim() || undefined, remarks: $d('#bzBNote').value.trim() || undefined, client_id: clientId }, m, btn, 'Payment');
    }
  }

  return () => { alive = false; recLeave?.(); };
}
