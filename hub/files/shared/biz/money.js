// Money screens, one file for the Sell, Buy and Money modules: new sale (on credit or paid at the till), return,
// supplier bill, receive payment, pay supplier, move money, journal, opening balances; lists of sales, bills,
// payments and journals; who owes us and who we owe. Documents are engine steps kept by the server (/steps); totals
// come from the server's own VAT and discount rules (/preview) and prices from its price rules (/price), so the
// screen and the books always agree. Same parts as every other screen.
import { enhanceSelects } from '../select.js';
import { esc, svg, I, modal, busy, errText, fmt, qty, num, debounce, confirmBox } from './ui.js';
import { makeField } from './fields.js';
import { PRINTABLE, printDoc, printFrom, printOptions } from './print.js';

const cents = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const OPENING = '__opening';   // the engine item an opening balance is booked on (store/money.ts OPENING_ITEM)

const ACTIONS = {
  sale: { label: 'New sale', hint: 'On credit or paid now', icon: I.sell, mod: 'sell', words: 'sale sell invoice till customer discount' },
  order: { label: 'New order', hint: 'From WhatsApp, phone or a salesman', icon: I.file, mod: 'sell', words: 'order sales order whatsapp phone salesman wholesale' },
  till: { label: 'Till', hint: 'Fast sales, scanning, shifts and the cash count', icon: I.sell, mod: 'sell', words: 'till pos counter cashier shift cash drawer scan barcode' },
  quote: { label: 'New quotation', hint: 'Prices offered to a customer', icon: I.file, mod: 'sell', words: 'quotation quote offer proforma estimate' },
  trip: { label: 'New delivery trip', hint: 'A driver and van take deliveries out', icon: I.move, mod: 'sell', words: 'trip delivery route driver vehicle van dispatch' },
  dnote: { label: 'New delivery', hint: 'Goods out to a customer, bill later', icon: I.move, mod: 'sell', words: 'delivery note deliver goods out customer bill later' },
  return: { label: 'Return', hint: 'Goods back from a customer', icon: I.undo, mod: 'sell', words: 'return credit note refund' },
  bill: { label: 'Supplier bill', hint: 'For goods or expenses', icon: I.arrived, mod: 'buy', words: 'bill supplier purchase invoice expense' },
  receive: { label: 'Receive payment', hint: 'From a customer', icon: I.money, mod: 'money', words: 'receive payment collect customer pays mpesa' },
  pay: { label: 'Pay supplier', hint: 'Money out to a supplier', icon: I.money, mod: 'money', words: 'pay supplier payment out' },
  payback: { label: 'Pay back', hint: 'Credit back to a customer, or a supplier pays us back', icon: I.undo, mod: 'money', words: 'refund pay back return money customer credit supplier refund advance' },
  move: { label: 'Move money', hint: 'Cash to bank, and back', icon: I.move, mod: 'money', words: 'move transfer deposit cash bank' },
  match: { label: 'Match credit', hint: 'Credit or advance to open invoices', icon: I.link, mod: 'money', words: 'match reconcile allocate credit advance payment invoice unreconcile' },
  journal: { label: 'Journal', hint: 'Any entry between accounts', icon: I.file, mod: 'money', words: 'journal entry accounts rent salary adjust correction' },
  opening: { label: 'Opening balances', hint: 'What was owed before you started', icon: I.key, mod: 'money', words: 'opening balance old books start debtors creditors' },
};
/** The kind of document each action records (who may record it comes from the server, per kind). */
const KIND_OF = { trip: 'delivery_trip', till: 'shift_open', dnote: 'delivery_note', match: 'reconcile', quote: 'quotation', order: 'sales_order', sale: 'sales_invoice', return: 'credit_note', bill: 'purchase_invoice', receive: 'payment', pay: 'payment', payback: 'payment', move: 'money_transfer', journal: 'journal', opening: 'journal' };
export const MONEY_ACTIONS = Object.entries(ACTIONS).map(([kind, a]) => ({ kind, ...a }));
/** May this person use this money action? (Older servers without per-kind rights: the general write right.) */
export const mayDo = (kit, action) => { const r = kit.stepRights; return !r || (r.kinds ? !!r.kinds[KIND_OF[action]] : !!r.write); };
const TABS = {
  sell: [['sales', 'Sales and returns'], ['orders', 'Orders'], ['picks', 'Pick lists'], ['deliveries', 'Deliveries'], ['trips', 'Trips'], ['quotes', 'Quotations'], ['shifts', 'Till shifts']],
  buy: [['bills', 'Supplier bills']],
  money: [['owe_us', 'Who owes us'], ['we_owe', 'Who we owe'], ['payments', 'Payments'], ['journals', 'Journals'], ['accounts', 'Accounts']],
};
const tzs = (n) => 'TZS ' + fmt(n);
const day = (s) => { const d = new Date(`${s}T00:00:00`); return isNaN(d) ? s || '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Dar es Salaam
const STATUS_TONE = { Paid: 'ok', Return: 'ok', 'Credit Note Issued': 'ok', 'Partly Paid': 'warn', Unpaid: 'warn', Overdue: 'bad', Cancelled: '',
  Completed: 'ok', Ordered: 'ok', 'To Deliver and Bill': 'warn', 'To Bill': 'warn', 'To Deliver': 'warn', 'Partially Billed': 'warn', 'Partially Ordered': 'warn',
  Open: 'warn', 'On Hold': 'bad', Closed: '', Lost: '', Expired: '' };
const lineRate = (l) => (l.discount ? Math.round(l.rate * (1 - l.discount / 100) * 100) / 100 : l.rate);
const isManager = (kit) => ['owner', 'manager'].includes(kit.user?.role);
const field = (id, label, input, cls = '') => `<div class="bz-fld${cls ? ' ' + cls : ''}"><label class="bz-lbl" for="${id}">${label}</label>${input}</div>`;
const sw = (id, label, on, cls = 'wide') => `<div class="bz-chk ${cls}"><span class="bz-lbl">${label}</span><button type="button" class="sw${on ? ' on' : ''}" role="switch" id="${id}" aria-checked="${!!on}"></button></div>`;
function wireSwitch(el, onChange) {
  el.onclick = () => { if (el.disabled) return; const on = el.getAttribute('aria-checked') !== 'true'; el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); onChange?.(on); };
  return () => el.getAttribute('aria-checked') === 'true';
}

/** mountMoney(el, kit, { module, action, records(el) }) → leave() */
export function mountMoney(el, kit, { module = 'money', action = null, records = null } = {}) {
  let alive = true, tab = TABS[module][0][0], steps = [], result = null, titles = {}, methods = [], stores = [], mainStore = null, books = null, company = {};
  const seeBooks = ['owner', 'manager', 'accountant'].includes(kit.user?.role);   // like the server's BOOK_ROLES
  const rights = kit.stepRights || { read: true, write: true, undo: true };
  const acts = MONEY_ACTIONS.filter((a) => a.mod === module);
  const name = (id) => (id === OPENING ? 'Opening balance' : titles[id] ?? kit.titleOf?.(id) ?? id);

  el.innerHTML = `<div class="bz-stock">
    <div class="bz-quick">${acts.map((a, i) => `<button class="bz-act" data-k="${a.kind}" style="--i:${i}"${mayDo(kit, a.kind) ? '' : ' disabled title="Your role cannot record this"'}><span class="bz-ic">${svg(a.icon)}</span><span><b>${a.label}</b><small>${a.hint}</small></span></button>`).join('')}</div>
    <div class="bz-bar"><div class="seg" id="bzMTabs" role="tablist">${TABS[module].filter(([k]) => k !== 'accounts' || seeBooks).map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="bz-src"><span class="dot"></span>Our own engine</span></div>
    <div id="bzMView"><div class="bz-loading"><span class="bz-spin"></span></div></div>
    <div id="bzMRec"></div></div>`;
  const $ = (s) => el.querySelector(s);
  el.querySelectorAll('.bz-act').forEach((b) => (b.onclick = () => open(b.dataset.k)));
  el.querySelectorAll('#bzMTabs button').forEach((b) => (b.onclick = () => {
    tab = b.dataset.t;
    el.querySelectorAll('#bzMTabs button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    paint();
  }));
  const recLeave = records ? records($('#bzMRec')) : null;

  async function load() {
    const [r, run, pm, st, co, bk] = await Promise.all([
      kit.api.steps(1000), kit.api.run({}),
      kit.api.list('payment_method', { limit: 100, sort: 'title' }).catch(() => ({ rows: [] })),
      kit.api.list('store', { limit: 200, sort: 'title' }).catch(() => ({ rows: [] })),
      kit.api.doc('company', '').then((x) => x?.doc).catch(() => null),
      module === 'money' && seeBooks ? kit.api.books().catch(() => null) : null,
    ]);
    mainStore = co?.default_store ?? null;
    company = co || {};
    books = bk;
    steps = r?.steps || [];
    titles = { ...(r?.titles || {}), ...(run?.titles || {}) };
    result = run;
    methods = (pm?.rows || []).filter((m) => m.active !== false);
    stores = (st?.rows || []).filter((s) => s.active !== false);
  }
  (async () => {
    try { await load(); } catch (e) { if (alive) $('#bzMView').innerHTML = `<div class="bz-empty card"><b>Could not load</b><p>${esc(errText(e))}</p></div>`; return; }
    if (!alive) return;
    paint();
    if (action && ACTIONS[action]) open(action);
  })();
  async function reload() { try { await load(); } catch {} if (alive) paint(); }

  // ---------- data helpers
  const invoices = () => result?.invoices || [];
  const stepOf = (id) => steps.find((s) => s.id === id);
  const kindOf = (id) => stepOf(id)?.kind;
  const openOf = (party) => invoices().filter((i) => i.party === party && i.outstanding > 0.004 && kindOf(i.step) !== 'credit_note')
    .sort((a, b) => (stepOf(a.step)?.dueDate || '').localeCompare(stepOf(b.step)?.dueDate || ''));
  // a customer or a supplier: from the documents that name them (a payment out may also be paying a customer back)
  const partyType = (id) => (steps.some((s) => s.customer === id) ? 'customer' : steps.some((s) => s.supplier === id) ? 'supplier'
    : steps.some((s) => s.kind === 'payment' && s.direction === 'out' && s.party === id) ? 'supplier' : 'customer');

  // ---------- painting
  function paint() {
    const v = $('#bzMView');
    if (!v) return;
    if (tab === 'sales') v.innerHTML = docTable(invoices().filter((i) => ['sales_invoice', 'credit_note'].includes(kindOf(i.step))), 'Customer', 'No sales yet. Record one with New sale.');
    else if (tab === 'bills') v.innerHTML = docTable(invoices().filter((i) => kindOf(i.step) === 'purchase_invoice'), 'Supplier', 'No supplier bills yet.');
    else if (tab === 'payments') v.innerHTML = paymentTable();
    else if (tab === 'journals') v.innerHTML = journalTable();
    else if (tab === 'orders') v.innerHTML = sellTable('sales_order', 'No orders yet. Record one with New order.');
    else if (tab === 'deliveries') v.innerHTML = sellTable('delivery_note', 'No deliveries yet. Make one from an order.');
    else if (tab === 'quotes') v.innerHTML = sellTable('quotation', 'No quotations yet.');
    else if (tab === 'shifts') v.innerHTML = shiftTable();
    else if (tab === 'picks') v.innerHTML = sellTable('pick_list', 'No pick lists yet. Open an order and choose Pick.');
    else if (tab === 'trips') v.innerHTML = tripTable();
    else if (tab === 'accounts') v.innerHTML = accountsTable();
    else v.innerHTML = balanceTable(tab === 'owe_us' ? 'customer' : 'supplier');
    v.querySelectorAll('[data-doc]').forEach((r) => (r.onclick = () => showDoc(r.dataset.doc)));
    v.querySelectorAll('[data-party]').forEach((r) => (r.onclick = () => showParty(r.dataset.party, r.dataset.side)));
    v.querySelectorAll('[data-acc]').forEach((r) => (r.onclick = () => showAccount(r.dataset.acc)));
  }
  const rowsOrEmpty = (rows, empty) => (rows.length ? rows.join('') : `<div class="bz-empty-row">${esc(empty)}</div>`);
  const tagOf = (s) => (s?.kind === 'credit_note' ? 'return' : s?.opening ? 'opening' : '');

  function docTable(list, who, empty) {
    const rows = [...list].reverse().map((i) => {
      const s = stepOf(i.step);
      const tone = STATUS_TONE[i.status] ?? '';
      const tag = tagOf(s);
      return `<button class="bz-tr" role="row" data-doc="${esc(i.step)}"><span class="bz-t1" data-l="Number">${esc(i.step)}${tag ? ` <small class="bz-muted">${tag}</small>` : ''}${s?.billNo ? ` <small class="bz-muted">· ${esc(s.billNo)}</small>` : ''}</span>
        <span data-l="Date">${esc(day(s?.date))}</span><span data-l="${who}">${esc(name(i.party))}</span>
        <span class="n" data-l="Total">${fmt(i.roundedTotal)}</span><span class="n" data-l="Still owed">${fmt(i.outstanding)}</span>
        <span data-l="Status"><span class="bz-st ${tone}">${esc(i.status)}</span></span></button>`;
    });
    return `<section class="card bz-table" style="--cols:minmax(7rem,1fr) 7rem minmax(9rem,2fr) 7rem 7rem 8rem">
      <div class="bz-tr bz-th" role="row"><span>Number</span><span>Date</span><span>${who}</span><span class="n">Total</span><span class="n">Still owed</span><span>Status</span></div>
      ${rowsOrEmpty(rows, empty)}</section>`;
  }

  function paymentTable() {
    const pays = steps.filter((s) => s.kind === 'payment' || s.kind === 'money_transfer' || s.kind === 'reconcile');
    const what = (s) => (s.kind === 'money_transfer' ? `Moved ${esc(accName(s.from))} → ${esc(accName(s.to))}`
      : s.kind === 'reconcile' ? `Credit matched · ${esc(name(s.party))}` : `${s.direction === 'in' ? 'From' : 'To'} ${esc(name(s.party))}`);
    const amt = (s) => (s.kind === 'reconcile' ? (s.allocations || []).reduce((a, x) => a + x.amount, 0) : s.amount);
    const rows = pays.map((s) => `<button class="bz-tr" role="row" data-doc="${esc(s.id)}"><span class="bz-t1" data-l="Number">${esc(s.id)}${s.undone ? ' <small class="bz-muted">undone</small>' : ''}</span>
      <span data-l="Date">${esc(day(s.date))}</span>
      <span data-l="What">${what(s)}${s.reference ? ` <small class="bz-muted">· ${esc(s.reference)}</small>` : ''}</span>
      <span data-l="Account">${esc(s.kind === 'payment' ? accName(s.account) : '')}</span><span class="n" data-l="Amount">${fmt(amt(s))}</span></button>`);
    return `<section class="card bz-table" style="--cols:minmax(7rem,1fr) 7rem minmax(10rem,2fr) 8rem 8rem">
      <div class="bz-tr bz-th" role="row"><span>Number</span><span>Date</span><span>What</span><span>Account</span><span class="n">Amount</span></div>
      ${rowsOrEmpty(rows, 'No payments yet.')}</section>`;
  }
  const accName = (a) => ({ cash: 'Cash', bank: 'Bank', mobile_money: 'Mobile money' }[a] || a || '');

  function journalTable() {
    const js = steps.filter((s) => s.kind === 'journal');
    const rows = js.map((s) => {
      const total = (s.rows || []).reduce((a, r) => a + (r.debit || 0), 0);
      return `<button class="bz-tr" role="row" data-doc="${esc(s.id)}"><span class="bz-t1" data-l="Number">${esc(s.id)}${s.undone ? ' <small class="bz-muted">undone</small>' : ''}</span>
        <span data-l="Date">${esc(day(s.date))}</span><span data-l="What">${esc(s.reference || s.remarks || (s.rows || []).map((r) => name(r.account)).join(' · '))}</span>
        <span class="n" data-l="Amount">${fmt(total)}</span></button>`;
    });
    return `<section class="card bz-table" style="--cols:minmax(7rem,1fr) 7rem minmax(10rem,3fr) 8rem">
      <div class="bz-tr bz-th" role="row"><span>Number</span><span>Date</span><span>What</span><span class="n">Amount</span></div>
      ${rowsOrEmpty(rows, 'No journals yet.')}</section>`;
  }

  // ---------- delivery transport: driver, vehicle, transport company and its receipt (a delivery's own; a trip sets its own)
  const opts = (list, sel) => `<option value="">—</option>${list.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}`;
  function transportFields() {
    return `<details class="wide bz-more"><summary>Transport (driver, vehicle, transport company)</summary><div class="bz-grid c2">
      ${field('bzMDrv', 'Driver', `<select id="bzMDrv">${opts(fleet.drivers)}</select>`)}${field('bzMVeh', 'Vehicle', `<select id="bzMVeh">${opts(fleet.vehicles)}</select>`)}
      ${field('bzMTr', 'Transport company', `<select id="bzMTr">${opts(fleet.transporters)}</select>`)}${textIn('bzMLr', 'Their receipt number', '', 'Waybill or LR number')}
      ${dateIn('bzMLrD', 'Their receipt date', '')}</div></details>`;
  }
  const transportOut = ($d) => {
    const v = (id) => $d(id)?.value || undefined;
    return { driver: v('#bzMDrv'), vehicle: v('#bzMVeh'), transporter: v('#bzMTr'), lr_no: $d('#bzMLr')?.value.trim() || undefined, lr_date: v('#bzMLrD') };
  };
  let fleet = { drivers: [], vehicles: [], transporters: [] };
  const loadFleet = async () => {
    const [d, v, t] = await Promise.all(['driver', 'vehicle', 'supplier'].map((x) => kit.api.list(x, { limit: 500, sort: 'title' }).catch(() => ({ rows: [] }))));
    fleet = { drivers: (d.rows || []).filter((x) => x.active !== false), vehicles: (v.rows || []).filter((x) => x.active !== false), transporters: (t.rows || []).filter((x) => x.active !== false) };
  };
  if (module === 'sell') loadFleet();

  // ---------- delivery trips: a driver and a vehicle take deliveries out; stops are marked visited
  const tripOf = (dn) => steps.find((t) => t.kind === 'delivery_trip' && !t.undone && (t.stops || []).some((x) => x.delivery_note === dn));
  const visitsOf = (t) => { const v = (t.stops || []).map(() => false); for (const x of [...steps].reverse()) if (x.kind === 'trip_visit' && !x.undone && x.trip === t.id) v[x.stop] = x.visited; return v; };
  const tripStatus = (t) => { if (t.undone) return 'Cancelled'; const v = visitsOf(t); return v.length && v.every(Boolean) ? 'Completed' : v.some(Boolean) ? 'In Transit' : 'Scheduled'; };
  const TRIP_TONE = { Scheduled: 'warn', 'In Transit': 'warn', Completed: 'ok', Cancelled: '' };
  function tripRow(s) {
    if (s.kind !== 'delivery_note' || s.returnOf) return '';
    const t = tripOf(s.id);
    if (!t) return '';
    const i = t.stops.findIndex((x) => x.delivery_note === s.id);
    return `<div class="bz-mrow"><span>Trip</span><span>${esc(t.id)} · stop ${i + 1} · ${visitsOf(t)[i] ? 'delivered' : 'on the way'}</span></div>`;
  }
  function tripTable() {
    const trips = steps.filter((x) => x.kind === 'delivery_trip').reverse();
    const rows = trips.map((t) => { const st = tripStatus(t), v = visitsOf(t);
      return `<button class="bz-tr" role="row" data-doc="${esc(t.id)}"><span class="bz-t1" data-l="Trip">${esc(t.id)}</span><span data-l="Date">${esc(day(t.date))} ${esc(t.time?.slice(0, 5) || '')}</span>
        <span data-l="Driver · vehicle">${esc(name(t.driver))} · ${esc(name(t.vehicle))}</span><span class="n" data-l="Stops">${v.filter(Boolean).length} / ${t.stops.length}</span>
        <span data-l="Status"><span class="bz-st ${TRIP_TONE[st] ?? ''}">${esc(st)}</span></span></button>`; });
    return `<section class="card bz-table" style="--cols:minmax(6rem,1fr) 9rem minmax(10rem,2fr) 5rem 8rem">
      <div class="bz-tr bz-th" role="row"><span>Trip</span><span>Leaves</span><span>Driver · vehicle</span><span class="n">Stops</span><span>Status</span></div>
      ${rowsOrEmpty(rows, 'No delivery trips yet. Make deliveries, then a New delivery trip.')}</section>`;
  }
  async function tripDialog() {
    if (!fleet.drivers.length) await loadFleet();
    // deliveries not on a live trip (and not returns)
    const free = sellDocs().filter((x) => x.kind === 'delivery_note' && x.status !== 'Cancelled' && !stepOf(x.step)?.returnOf && !tripOf(x.step)).map((x) => stepOf(x.step)).filter(Boolean);
    if (!free.length) return kit.toast('No deliveries waiting for a trip');
    if (!fleet.drivers.length || !fleet.vehicles.length) return kit.toast('Add a driver and a vehicle first (Sell > Drivers, Vehicles)');
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${field('bzTVeh', 'Vehicle', `<select id="bzTVeh">${opts(fleet.vehicles)}</select>`)}${field('bzTDrv', 'Driver', `<select id="bzTDrv">${opts(fleet.drivers)}</select>`)}
      ${field('bzMDate', 'Leaves on', `<input class="bz-in" type="date" id="bzMDate" value="${esc(today())}">`)}${field('bzTTime', 'At', '<input class="bz-in" type="time" id="bzTTime">')}
      <div class="wide"><p class="bz-note">Tick the deliveries for this trip, in the order the van stops.</p><div class="bz-lines" id="bzTStops">${free.map((d) =>
        `<div class="bz-ln t" role="row"><input type="checkbox" data-dn="${esc(d.id)}" aria-label="On this trip"><span>${esc(d.id)} · ${esc(name(d.customer))} <small class="bz-muted">${esc(day(d.date))}</small></span>
          <input class="bz-in" data-note="${esc(d.id)}" placeholder="Note for the driver" maxlength="200" aria-label="Note for the driver"></div>`).join('')}</div></div>
      ${field('bzTKm', 'Distance (km)', '<input class="bz-in n" id="bzTKm" inputmode="decimal" placeholder="Optional">')}
      ${textIn('bzMNote', 'Note', 'wide')}<div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'New delivery trip', sub: 'A trip books nothing; the deliveries already moved the goods', icon: I.move, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save trip', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'trip';
    const $d = (q) => m.box.querySelector(q);
    enhanceSelects(body);
    // the vehicle's usual driver
    $d('#bzTVeh').onchange = () => { const v = fleet.vehicles.find((x) => x.id === $d('#bzTVeh').value); if (v?.driver && !$d('#bzTDrv').value) $d('#bzTDrv').value = v.driver; };
    function go(btn) {
      const stops = [...m.box.querySelectorAll('#bzTStops input:checked')].map((c) => ({ delivery_note: c.dataset.dn,
        note: m.box.querySelector(`[data-note="${CSS.escape(c.dataset.dn)}"]`)?.value.trim() || undefined }));
      if (!$d('#bzTVeh').value || !$d('#bzTDrv').value) return showErr(m, 'Choose the vehicle and the driver');
      if (!stops.length) return showErr(m, 'Tick at least one delivery');
      const t = $d('#bzTTime').value;
      save({ kind: 'delivery_trip', vehicle: $d('#bzTVeh').value, driver: $d('#bzTDrv').value, date: $d('#bzMDate').value, ...(t ? { time: `${t}:00` } : {}), stops,
        ...(num($d('#bzTKm').value) > 0 ? { distance: num($d('#bzTKm').value) } : {}), remarks: $d('#bzMNote').value.trim() || undefined, client_id: clientId }, m, btn);
    }
  }
  function showTrip(t) {
    const v = visitsOf(t), st = tripStatus(t);
    const live = !t.undone;
    const body = document.createElement('div');
    body.innerHTML = `<div class="bz-docview"><div class="bz-mrow"><span>Driver · vehicle</span><span>${esc(name(t.driver))} · ${esc(name(t.vehicle))}</span></div>
      <div class="bz-mrow"><span>Leaves</span><span>${esc(day(t.date))} ${esc(t.time?.slice(0, 5) || '')}</span></div>
      ${t.distance ? `<div class="bz-mrow"><span>Distance</span><span>${qty(t.distance)} km</span></div>` : ''}
      <div class="bz-mrow"><span>Status</span><span><span class="bz-st ${TRIP_TONE[st] ?? ''}">${esc(st)}</span></span></div><hr>
      ${t.stops.map((x, i) => `<div class="bz-mrow"><span>${i + 1}. ${esc(x.delivery_note)} · ${esc(name(x.customer))}${x.total !== undefined ? ` · ${fmt(x.total)}` : ''}
        ${x.address ? `<br><small class="bz-muted">${esc(x.address)}</small>` : ''}${x.contact ? `<br><small class="bz-muted">Call ${esc(x.contact)}</small>` : ''}${x.note ? `<br><small class="bz-muted">${esc(x.note)}</small>` : ''}</span>
        <span>${live && mayDo(kit, 'trip') || live && kit.stepRights?.kinds?.trip_visit ? `<button type="button" class="tbtn" data-stop="${i}">${v[i] ? '✓ Delivered · undo' : 'Mark delivered'}</button>` : v[i] ? 'Delivered' : 'On the way'}</span></div>`).join('')}
      ${t.remarks ? `<hr><p class="bz-note">${esc(t.remarks)}</p>` : ''}</div>`;
    const m = modal({ title: `Delivery trip ${t.id}`, icon: I.move, wide: true, body,
      actions: [...(live && rights.undo && !v.some(Boolean) ? [{ label: 'Undo trip', danger: true, value: 'undo' }] : []), { label: 'Close', pri: true, value: false }] });
    body.querySelectorAll('[data-stop]').forEach((b) => (b.onclick = async () => {
      const i = +b.dataset.stop;
      try { await kit.api.addStep({ kind: 'trip_visit', trip: t.id, stop: i, visited: !v[i], client_id: uid() }); m.close(false); await reload(); showTrip(stepOf(t.id)); }
      catch (e) { kit.toast(errText(e)); }
    }));
    m.done.then(async (val) => {
      if (val !== 'undo') return;
      try { await kit.api.undoStep(t.id); kit.toast('Undone ✓'); reload(); } catch (e) { kit.toast(errText(e)); }
    });
  }

  // ---------- till shifts: opened with a float, closed with a count (expected and difference per payment method)
  const closeOf = (open) => steps.find((c) => c.kind === 'shift_close' && !c.undone && c.shift === open.id);
  const diffOf = (c) => (c ? c.counted.reduce((a, x) => a + x.amount, 0) - c.expected.reduce((a, x) => a + x.amount, 0) : null);
  function shiftTable() {
    const opens = steps.filter((x) => x.kind === 'shift_open');
    const rows = opens.map((o) => {
      const c = closeOf(o), d = diffOf(c);
      return `<button class="bz-tr" role="row" data-doc="${esc(c ? c.id : o.id)}"><span class="bz-t1" data-l="Shift">${esc(o.id)}${o.undone ? ' <small class="bz-muted">undone</small>' : ''}</span>
        <span data-l="Till">${esc(name(o.till))}</span><span data-l="Cashier">${esc(name(o.user))}</span>
        <span data-l="Opened">${esc(day(o.date))} ${esc(o.time?.slice(0, 5) || '')}</span>
        <span class="n" data-l="Takings">${c ? fmt(c.totals.grandTotal) : ''}</span>
        <span data-l="Count">${o.undone ? '' : !c ? '<span class="bz-st warn">Open</span>' : Math.abs(d) < 0.005 ? '<span class="bz-st ok">Balanced</span>'
          : `<span class="bz-st ${d < 0 ? 'bad' : 'warn'}">${d < 0 ? 'Short' : 'Over'} ${fmt(Math.abs(d))}</span>`}</span></button>`;
    }).reverse();
    return `<section class="card bz-table" style="--cols:minmax(6rem,1fr) minmax(7rem,1.4fr) minmax(7rem,1.4fr) 9rem 7rem 8rem">
      <div class="bz-tr bz-th" role="row"><span>Shift</span><span>Till</span><span>Cashier</span><span>Opened</span><span class="n">Takings</span><span>Count</span></div>
      ${rowsOrEmpty(rows, 'No till shifts yet. Open one on the Till.')}</section>`;
  }
  function showShift(s) {
    const open = s.kind === 'shift_open' ? s : stepOf(s.shift);
    const close = s.kind === 'shift_close' ? s : closeOf(s);
    const row = (a, b) => `<div class="bz-mrow"><span>${a}</span><span>${b}</span></div>`;
    const ids = [...new Set([...(open?.opening || []).map((x) => x.method), ...(close ? [...close.expected, ...close.counted].map((x) => x.method) : [])])];
    const amt = (list, id) => (list || []).find((x) => x.method === id)?.amount || 0;
    const body = `<div class="bz-docview">
      ${row('Till', esc(name(open?.till)))}${row('Cashier', esc(name(open?.user)))}
      ${row('Opened', `${esc(day(open?.date))} ${esc(open?.time?.slice(0, 5) || '')}`)}${close ? row('Closed', `${esc(day(close.date))} ${esc(close.time?.slice(0, 5) || '')}`) : row('Status', '<span class="bz-st warn">Open</span>')}
      ${close ? `<hr>${row('Sales', qty(close.totals.sales))}${row('Takings', fmt(close.totals.grandTotal))}${row('VAT in it', fmt(close.totals.vat))}
        ${close.totals.owed ? row('Left on customers\' accounts', fmt(close.totals.owed)) : ''}${close.totals.paidOut ? row('Paid out', fmt(close.totals.paidOut)) : ''}` : ''}
      </div>
      <div class="bz-lines"><div class="bz-ln c bz-lh" role="row"><span>Payment method</span><span class="n">${close ? 'Expected' : 'Opening'}</span><span class="n">${close ? 'Counted' : ''}</span><span class="n">${close ? 'Difference' : ''}</span></div>
      ${ids.map((id) => {
        if (!close) return `<div class="bz-ln c" role="row"><span>${esc(name(id))}</span><span class="n">${fmt(amt(open?.opening, id))}</span><span></span><span></span></div>`;
        const e = amt(close.expected, id), c = amt(close.counted, id), d = Math.round((c - e) * 100) / 100;
        return `<div class="bz-ln c" role="row"><span>${esc(name(id))}</span><span class="n">${fmt(e)}</span><span class="n">${fmt(c)}</span>
          <span class="n">${d ? `<span class="bz-st ${d < 0 ? 'bad' : 'warn'}">${d < 0 ? '−' : '+'}${fmt(Math.abs(d))}</span>` : '<span class="bz-st ok">0</span>'}</span></div>`;
      }).join('')}</div>`;
    // undo: a close opens the shift again; an opening only while nothing was sold in it (the server checks)
    const target = close && !close.undone ? close : open && !open.undone && !close ? open : null;
    const m = modal({ title: `Shift ${open?.id || s.id}`, sub: close ? 'Closed' : 'Open', icon: I.sell, wide: true, body,
      actions: [...(target && rights.undo ? [{ label: close ? 'Undo the close' : 'Undo the opening', danger: true, value: 'undo' }] : []), { label: 'Close', pri: true, value: false }] });
    m.done.then(async (v) => {
      if (v !== 'undo') return;
      if (!(await confirmBox({ title: `Undo ${target.id}?`, text: close ? 'The shift opens again so it can be counted again.' : 'Only while nothing was sold in it.', ok: 'Undo', danger: true }))) return;
      try { await kit.api.undoStep(target.id); kit.toast('Undone ✓'); reload(); } catch (e) { kit.toast(errText(e)); }
    });
  }

  // ---------- selling documents (quotations, orders, delivery notes)
  const sellDocs = () => result?.documents || [];
  const docOf = (id) => sellDocs().find((x) => x.step === id);
  const lineAmt = (l) => lineRate(l) * l.qty;
  function sellTable(kind, empty) {
    const list = sellDocs().filter((x) => x.kind === kind).reverse();
    const rows = list.map((x) => {
      const s = stepOf(x.step);
      const total = x.totals?.roundedTotal ?? (s?.lines || []).reduce((a, l) => a + lineAmt(l), 0);
      const prog = kind === 'sales_order' ? `${Math.round(x.perDelivered ?? 0)}% · ${Math.round(x.perBilled ?? 0)}%` : kind === 'delivery_note' ? `${Math.round(x.perBilled ?? 0)}%`
        : kind === 'pick_list' ? `${Math.round(x.perDelivered ?? 0)}%` : '';
      return `<button class="bz-tr" role="row" data-doc="${esc(x.step)}"><span class="bz-t1" data-l="Number">${esc(x.step)}</span>
        <span data-l="Date">${esc(day(s?.date))}</span><span data-l="Customer">${esc(name(s?.customer))}</span>
        <span class="n" data-l="Amount">${fmt(total)}</span><span class="n" data-l="${kind === 'sales_order' ? 'Delivered · billed' : kind === 'delivery_note' ? 'Billed' : kind === 'pick_list' ? 'Delivered' : ''}">${prog}</span>
        <span data-l="Status"><span class="bz-st ${STATUS_TONE[x.status] ?? ''}">${esc(x.status)}</span></span></button>`;
    });
    return `<section class="card bz-table" style="--cols:minmax(7rem,1fr) 7rem minmax(9rem,2fr) 7rem 7rem 9rem">
      <div class="bz-tr bz-th" role="row"><span>Number</span><span>Date</span><span>Customer</span><span class="n">Amount</span><span class="n">${kind === 'sales_order' ? 'Delivered · billed' : kind === 'delivery_note' ? 'Billed' : kind === 'pick_list' ? 'Delivered' : ''}</span><span>Status</span></div>
      ${rowsOrEmpty(rows, empty)}</section>`;
  }

  /** What is left on each line of a source for the next document: quotation → order (qty), order → delivery (qty),
   *  order or delivery → invoice (amount, shown as qty at the line's price). */
  function leftOn(src, target) {
    const s = stepOf(src), d = docOf(src);
    return (s?.lines || []).map((l, i) => {
      const done = d?.lines?.[i] || {};
      const left = target === 'sales_order' ? l.qty - (done.ordered || 0)
        : target === 'pick_list' ? l.qty - Math.max(done.picked || 0, done.delivered || 0)
        : target === 'return' ? l.qty - (done.returned || 0)
        : target === 'delivery_note' ? l.qty - (done.delivered || 0)
        : (lineAmt(l) - (done.billed || 0)) / (lineRate(l) || 1);
      return { l, i, left: Math.max(0, Math.round(left * 1000) / 1000) };
    });
  }

  /** Make the next document from a quotation, order or delivery note: the lines still open, quantities editable. */
  function makeFrom(src, target) {
    const s = stepOf(src);
    if (!s) return;
    const open = leftOn(src, target).filter((x) => x.left > 0);
    if (!open.length) return kit.toast('Nothing is left to ' + ({ sales_order: 'order', delivery_note: 'deliver', pick_list: 'pick', return: 'bring back' }[target] || 'bill'));
    const clientId = uid();
    const LABEL = { sales_order: 'Make order', delivery_note: 'Deliver', sales_invoice: 'Invoice', pick_list: 'Pick', return: 'Goods back' };
    const viaPick = s.kind === 'pick_list';   // delivering what a pick list picked
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${dateIn('bzMDate')}${target !== 'sales_invoice' || s.kind === 'sales_order' ? storeSel('bzMStore', target === 'sales_order' ? 'Deliver from' : target === 'return' ? 'Goods come back into' : target === 'pick_list' ? 'Picked from' : 'Goods leave from', s.warehouse) : ''}
      ${target === 'delivery_note' ? transportFields() : ''}
      ${target === 'sales_order' ? field('bzMDeliv', 'Deliver by', '<input class="bz-in" type="date" id="bzMDeliv">') : ''}
      ${target === 'sales_invoice' && s.kind === 'sales_order' ? sw('bzMMove', 'The goods leave the store with this invoice (not delivered yet)', true) : ''}
      <div class="bz-lines wide" id="bzMF"><div class="bz-ln r bz-lh" role="row"><span>Product</span><span class="n">${target === 'return' ? 'Can come back' : 'Still open'}</span><span class="n">${{ sales_invoice: 'Bill now', delivery_note: 'Deliver now', pick_list: 'Pick now', return: 'Back now' }[target] || 'Order now'}</span></div>
      ${open.map((x) => `<div class="bz-ln r" role="row"><span>${esc(name(x.l.item))} <small class="bz-muted">@ ${fmt(lineRate(x.l))}</small></span><span class="n">${qty(x.left)}</span>
        <input class="bz-in n" data-i="${x.i}" inputmode="decimal" value="${esc(x.left)}" aria-label="Quantity"></div>`).join('')}</div>
      ${textIn('bzMNote', 'Note', 'wide')}<div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: `${LABEL[target]} · ${src}`, sub: target === 'return' ? `${name(s.customer)}: goods back before the invoice; for invoiced goods use Return on the invoice` : `${name(s.customer)}: only what is still open`, icon: ACTIONS[target === 'sales_invoice' ? 'sale' : 'order'].icon, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: LABEL[target], pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = target === 'sales_invoice' ? 'sale' : 'order';
    const $d = (q) => m.box.querySelector(q);
    enhanceSelects(body);
    const moveOn = $d('#bzMMove') ? wireSwitch($d('#bzMMove')) : () => false;
    function go(btn, allowOver = false) {
      const lines = [...m.box.querySelectorAll('#bzMF input')].map((inp) => {
        const l = s.lines[+inp.dataset.i];
        // a pick list's line points at the order line it picked; the delivery is made from that order line
        return { item: l.item, qty: num(inp.value), rate: l.rate, ...(l.discount ? { discount: l.discount } : {}), from: viaPick ? l.from : { step: src, line: +inp.dataset.i } };
      }).filter((l) => l.qty > 0);
      if (!lines.length) return showErr(m, 'Nothing to ' + LABEL[target].toLowerCase());
      const vat = s.tax ? { vat: true, prices_include_vat: !!s.tax.inclusive } : { vat: false };
      const step = { kind: target === 'return' ? 'delivery_note' : target, customer: s.customer, date: $d('#bzMDate').value, lines, ...vat, remarks: $d('#bzMNote').value.trim() || undefined, client_id: clientId,
        ...(target === 'return' ? { return_against: src } : {}), ...(viaPick ? { pick_list: src } : {}),
        ...(target === 'delivery_note' ? transportOut($d) : {}),
        ...($d('#bzMStore') ? { warehouse: $d('#bzMStore').value } : {}),
        ...(target === 'sales_order' ? { delivery_date: $d('#bzMDeliv').value || undefined } : {}),
        ...(target === 'sales_invoice' ? { update_stock: s.kind === 'sales_order' && moveOn() } : {}),
        ...(allowOver ? { allow_over_limit: true } : {}), ...printFrom(s) };
      save(step, m, btn, { onError: (e) => {
        if (!allowOver && isManager(kit) && /Credit limit crossed/.test(errText(e))) {
          $d('.bz-formerr').insertAdjacentHTML('beforeend', ' <button type="button" class="tbtn" id="bzMOver">Allow it over the limit</button>');
          $d('#bzMOver').onclick = (ev) => go(ev.currentTarget, true);
        }
      } });
    }
  }

  async function setStatus(target, status) {
    let remarks;
    if (status === 'Lost') {
      const body = document.createElement('form'); body.className = 'bz-grid c2';
      body.innerHTML = field('bzMWhy', 'Why was it lost?', '<input class="bz-in" id="bzMWhy" placeholder="Price, delivery time, went to a competitor…">', 'wide');
      const m = modal({ title: `Mark ${target} lost`, icon: I.file, body, actions: [{ label: 'Cancel', value: false }, { label: 'Mark lost', pri: true, value: 'ok' }] });
      requestAnimationFrame(() => body.querySelector('input').focus());
      m.beforeClose = (v) => (v !== 'ok' || body.querySelector('input').value.trim() ? true : (kit.toast('Say why it was lost'), false));
      if ((await m.done) !== 'ok') return;
      remarks = body.querySelector('input').value.trim();
    }
    try { await kit.api.addStep({ kind: 'set_status', target, status, remarks, client_id: `${target}-${status}-${Date.now()}` }); kit.toast(`${target}: ${status === 'Open' ? 'reopened' : status.toLowerCase()} ✓`); reload(); }
    catch (e) { kit.toast(errText(e)); }
  }

  /** The books per account (trial balance): every account with entries, its debits, credits and balance. */
  function accountsTable() {
    if (!books) return '<div class="bz-empty card"><b>Could not load the books</b></div>';
    const groups = ['Asset', 'Liability', 'Equity', 'Income', 'Expense', ''];
    const label = { Asset: 'Assets', Liability: 'Liabilities', Equity: 'Equity', Income: 'Income', Expense: 'Expenses', '': 'Not set up' };
    const rows = groups.flatMap((g) => {
      const list = books.accounts.filter((a) => (a.root_type || '') === g);
      if (!list.length) return [];
      return [`<div class="bz-tr bz-tg" role="row"><span>${label[g]}</span></div>`, ...list.map((a) => `<button class="bz-tr" role="row" data-acc="${esc(a.id)}">
        <span class="bz-t1" data-l="Account">${a.number ? `<small class="bz-muted">${esc(a.number)}</small> ` : ''}${esc(a.title)}</span>
        <span class="n" data-l="Debit">${fmt(a.debit)}</span><span class="n" data-l="Credit">${fmt(a.credit)}</span>
        <span class="n" data-l="Balance"><b>${a.balance < 0 ? `${fmt(-a.balance)} Cr` : `${fmt(a.balance)} Dr`}</b></span></button>`)];
    });
    return `${books.unset?.length ? `<div class="bz-empty card"><b>Some kinds of account are not set up</b><p>Choose them in Setup &gt; Company (Default accounts).</p></div>` : ''}
      <div class="bz-kpis"><section class="card bz-k"><small>Debits</small><b>${tzs(books.debit)}</b></section><section class="card bz-k"><small>Credits</small><b>${tzs(books.credit)}</b></section>
      <section class="card bz-k"><small>Difference</small><b class="${Math.abs(books.debit - books.credit) < 0.01 ? 'ok' : 'bad'}">${Math.abs(books.debit - books.credit) < 0.01 ? 'Balanced' : tzs(books.debit - books.credit)}</b></section></div>
      <section class="card bz-table" style="--cols:minmax(12rem,3fr) 8rem 8rem 9rem">
      <div class="bz-tr bz-th" role="row"><span>Account</span><span class="n">Debit</span><span class="n">Credit</span><span class="n">Balance</span></div>
      ${rowsOrEmpty(rows, 'Nothing booked yet.')}</section>`;
  }

  async function showAccount(id) {
    let led;
    try { led = await kit.api.books(id); } catch (e) { return kit.toast(errText(e)); }
    const body = `<div class="bz-docview">${led.rows.length ? led.rows.map((r) => `<div class="bz-mrow"><span>${esc(day(r.date))} · ${esc(r.step)} ${esc(r.label)}${r.partyTitle ? ` · ${esc(r.partyTitle)}` : ''}</span>
      <span>${r.debit ? `Dr ${fmt(r.debit)}` : `Cr ${fmt(r.credit)}`} <small class="bz-muted">= ${r.balance < 0 ? `${fmt(-r.balance)} Cr` : fmt(r.balance)}</small></span></div>`).join('') : '<p class="bz-note">No entries.</p>'}</div>`;
    const m = modal({ title: led.title, sub: 'Every entry, oldest first, with the balance after it', icon: I.money, wide: true, body, actions: [{ label: 'Close', pri: true, value: false }] });
    m.box.querySelectorAll('.bz-mrow').forEach((row, i) => (row.style.cursor = 'pointer', row.onclick = () => { m.close(false); showDoc(led.rows[i].step); }));
  }

  function balanceTable(side) {
    const owed = (result?.parties || []).filter((p) => partyType(p.party) === side && Math.abs(p.balance) > 0.004).sort((a, b) => b.balance - a.balance);
    const total = owed.reduce((s, p) => s + p.balance, 0);
    const rows = owed.map((p) => {
      const open = openOf(p.party), oldest = open[0] ? stepOf(open[0].step)?.dueDate : '';
      const late = open.filter((i) => i.status === 'Overdue').length;
      return `<button class="bz-tr" role="row" data-party="${esc(p.party)}" data-side="${side}"><span class="bz-t1" data-l="${side === 'customer' ? 'Customer' : 'Supplier'}">${esc(name(p.party))}</span>
        <span class="n" data-l="Open invoices">${open.length}</span><span data-l="Oldest due">${esc(day(oldest))}${late ? ` <span class="bz-st bad">${late} late</span>` : ''}</span>
        <span class="n" data-l="${p.balance < 0 ? 'Credit' : 'Owed'}">${p.balance < 0 ? `${fmt(-p.balance)} credit` : fmt(p.balance)}</span></button>`;
    });
    return `<div class="bz-kpis"><section class="card bz-k"><small>${side === 'customer' ? 'Customers owe us' : 'We owe suppliers'}</small><b>${tzs(total)}</b></section></div>
      <section class="card bz-table" style="--cols:minmax(10rem,2fr) 7rem 10rem 9rem">
      <div class="bz-tr bz-th" role="row"><span>${side === 'customer' ? 'Customer' : 'Supplier'}</span><span class="n">Open invoices</span><span>Oldest due</span><span class="n">Balance</span></div>
      ${rowsOrEmpty(rows, side === 'customer' ? 'Nobody owes you anything.' : 'You owe no supplier anything.')}</section>`;
  }

  // ---------- details
  function showDoc(id) {
    const s = stepOf(id);
    if (!s) return;
    if (['quotation', 'sales_order', 'delivery_note', 'pick_list'].includes(s.kind)) return showSellDoc(s);
    if (s.kind === 'shift_open' || s.kind === 'shift_close') return showShift(s);
    if (s.kind === 'delivery_trip') return showTrip(s);
    if (s.kind === 'pick_list') return showSellDoc(s);
    const inv = invoices().find((i) => i.step === id);
    const row = (a, b) => `<div class="bz-mrow"><span>${a}</span><span>${b}</span></div>`;
    const lines = (s.lines || []).map((l) => row(l.item === OPENING ? 'Opening balance' : `${qty(l.qty)} × ${esc(name(l.item))}${l.discount ? ` <small class="bz-muted">${qty(l.discount)}% off ${fmt(l.rate)}</small>` : ''}`, fmt(lineRate(l) * l.qty))).join('');
    const paidBy = (s.payments || []).map((p) => row(`Paid · ${esc(p.method ? name(p.method) : accName(p.account))}${p.reference ? ` <small class="bz-muted">${esc(p.reference)}</small>` : ''}`, fmt(p.amount))).join('');
    const jrows = (s.rows || []).map((r) => row(`${esc(name(r.account) || r.role)}${r.party ? ` · ${esc(name(r.party))}` : ''}`, r.debit ? `Dr ${fmt(r.debit)}` : `Cr ${fmt(r.credit)}`)).join('');
    const body = `<div class="bz-docview">
      ${row('Date', esc(day(s.date)))}
      ${s.customer || s.supplier || s.party ? row(s.supplier || s.direction === 'out' ? 'Supplier' : 'Customer', esc(name(s.customer || s.supplier || s.party))) : ''}
      ${s.billNo ? row('Their bill number', `${esc(s.billNo)}${s.billDate ? ` · ${esc(day(s.billDate))}` : ''}`) : ''}
      ${s.dueDate && s.kind !== 'credit_note' ? row('Due', esc(day(s.dueDate))) : ''}
      ${s.against ? row('Returns', `${esc(s.against)}${s.reduceInvoice ? ' · taken off that sale' : ' · kept as credit'}`) : ''}
      ${s.reference ? row('Reference', esc(s.reference)) : ''}
      ${s.schedule?.length ? row('Instalments', s.schedule.map((x) => `${qty(x.portion)}% by ${esc(day(x.dueDate))}`).join(' · ')) : ''}
      ${lines ? `<hr>${lines}` : ''}${jrows ? `<hr>${jrows}` : ''}
      ${inv ? `<hr>${s.discountAmount ? row('Discount on the whole', `− ${fmt(s.discountAmount)}`) : ''}${row('Before VAT', cents(inv.netTotal))}${row('VAT', cents(inv.vat))}
        <div class="bz-mrow big"><span>Total</span><span>${tzs(inv.roundedTotal)}</span></div>${paidBy}${s.writeOff ? row('Small amount written off', 'yes') : ''}
        ${row('Still owed', fmt(inv.outstanding))}${row('Status', `<span class="bz-st ${STATUS_TONE[inv.status] ?? ''}">${esc(inv.status)}</span>`)}` : ''}
      ${s.kind === 'payment' ? `<hr>${row(esc(accName(s.account)), tzs(s.amount))}${(s.allocate || []).map((a) => row(`For ${esc(a.invoice)}`, fmt(a.amount))).join('')}
        ${steps.filter((x) => x.kind === 'reconcile' && !x.undone).flatMap((x) => (x.allocations || []).filter((a) => a.from === s.id).map((a) => row(`Matched to ${esc(a.invoice)} <small class="bz-muted">(${esc(x.id)})</small>`, fmt(a.amount)))).join('')}` : ''}
      ${s.kind === 'reconcile' ? `<hr>${(s.allocations || []).map((a) => row(`${esc(a.from)} → ${esc(a.invoice)}`, fmt(a.amount))).join('')}
        <p class="bz-note">Undo takes the match back: the credit is free again and the invoices owe as before.</p>` : ''}
      ${s.remarks ? `<hr><p class="bz-note">${esc(s.remarks)}</p>` : ''}
    </div>`;
    const canUndo = rights.undo && !s.undone && s.kind !== 'cancel';
    const act = s.opening ? 'opening' : { sales_invoice: 'sale', credit_note: 'return', purchase_invoice: 'bill', payment: s.direction === 'out' ? 'pay' : 'receive', money_transfer: 'move', journal: 'journal', reconcile: 'match' }[s.kind];
    const m = modal({ title: `${s.label || s.kind} ${id}`, icon: (ACTIONS[act] || {}).icon || I.file, body,
      actions: [...(canUndo ? [{ label: 'Undo', danger: true, value: 'undo' }] : []), ...(PRINTABLE.has(s.kind) ? [{ label: 'Print', value: 'print' }] : []), { label: 'Close', pri: true, value: false }] });
    m.done.then(async (v) => {
      if (v === 'print') return printDoc(kit, id);
      if (v !== 'undo') return;
      if (!(await confirmBox({ title: `Undo ${id}?`, text: 'It stays in the history, marked undone; its money and stock are taken back.', ok: 'Undo', danger: true }))) return;
      try { await kit.api.undoStep(id); kit.toast('Undone ✓'); reload(); } catch (e) { kit.toast(errText(e)); }
    });
  }

  function showSellDoc(s) {
    const d = docOf(s.id) || { status: s.undone ? 'Cancelled' : '' };
    const row = (a, b) => `<div class="bz-mrow"><span>${a}</span><span>${b}</span></div>`;
    const lines = s.lines.map((l, i) => {
      const p = d.lines?.[i] || {};
      const done = s.kind === 'quotation' ? `ordered ${qty(p.ordered || 0)}`
        : s.kind === 'sales_order' ? `picked ${qty(p.picked || 0)} · delivered ${qty(p.delivered || 0)} · billed ${fmt(p.billed || 0)}${p.returned ? ` · came back ${qty(p.returned)}` : ''}${p.held !== undefined ? ` · held ${qty(p.held)}` : ''}`
        : s.kind === 'pick_list' ? `delivered ${qty(p.delivered || 0)}`
        : s.returnOf ? 'back in the store' : `billed ${fmt(p.billed || 0)}${p.returned ? ` · came back ${qty(p.returned)}` : ''}`;
      return row(`${qty(l.qty)} × ${esc(name(l.item))} <small class="bz-muted">@ ${fmt(lineRate(l))} · ${done}</small>`, fmt(lineAmt(l)));
    }).join('');
    const live = !s.undone && d.status !== 'Cancelled';
    const may = (k) => mayDo(kit, k);
    const mayKind = (k) => { const r = kit.stepRights; return !r?.kinds || !!r.kinds[k]; };
    const acts = [];
    if (live && s.kind === 'quotation' && !['Lost', 'Ordered', 'Expired'].includes(d.status)) {
      if (may('order')) acts.push({ label: 'Make order', pri: true, value: 'sales_order' });
      acts.push({ label: 'Mark lost', value: 'Lost' });
    }
    if (live && s.kind === 'sales_order' && !['Closed', 'On Hold', 'Completed'].includes(d.status)) {
      if (mayKind('delivery_note') && (d.perDelivered ?? 0) < 100) acts.push({ label: 'Deliver', pri: true, value: 'delivery_note' });
      if (may('sale') && (d.perBilled ?? 0) < 100) acts.push({ label: 'Invoice', value: 'sales_invoice' });
    }
    if (live && s.kind === 'delivery_note' && !s.returnOf && !['Closed', 'Completed', 'Return Issued'].includes(d.status) && may('sale')) acts.push({ label: 'Invoice', pri: true, value: 'sales_invoice' });
    if (live && s.kind === 'delivery_note' && !s.returnOf && d.status !== 'Return Issued' && mayKind('delivery_note')) acts.push({ label: 'Goods back', value: 'return' });
    if (live && s.kind === 'sales_order' && !['Closed', 'On Hold', 'Completed'].includes(d.status) && mayKind('pick_list') && (d.perPicked ?? 0) < 100 && !(d.lines || []).some((x) => x.held)) acts.push({ label: 'Pick', value: 'pick_list' });
    if (live && s.kind === 'pick_list' && d.status !== 'Completed' && mayKind('delivery_note')) acts.push({ label: 'Deliver', pri: true, value: 'delivery_note' });
    if (live && isManager(kit) && s.kind === 'sales_order' && d.status === 'On Hold') acts.push({ label: 'Resume', value: 'Open' });
    if (live && isManager(kit) && s.kind === 'sales_order' && !['On Hold', 'Closed', 'Completed'].includes(d.status)) acts.push({ label: 'Hold', value: 'On Hold' });
    if (live && isManager(kit) && s.kind !== 'quotation' && d.status === 'Closed') acts.push({ label: 'Reopen', value: 'Open' });
    if (live && isManager(kit) && s.kind !== 'quotation' && !['Closed', 'Completed'].includes(d.status)) acts.push({ label: 'Close', value: 'Closed' });
    acts.push({ label: 'Print', value: 'print' });
    if (live && rights.undo) acts.push({ label: 'Undo', danger: true, value: 'undo' });
    const body = `<div class="bz-docview">${row('Date', esc(day(s.date)))}${row('Customer', esc(name(s.customer)))}
      ${s.validTill ? row('Valid till', esc(day(s.validTill))) : ''}${s.deliveryDate ? row('Deliver by', esc(day(s.deliveryDate))) : ''}
      ${s.warehouse ? row('Store', esc(name(s.warehouse))) : ''}${s.salesman ? row('Salesman', esc(name(s.salesman))) : ''}
      ${s.returnOf ? row('Goods back from', esc(s.returnOf)) : ''}${s.reserve ? row('Stock', 'held firmly for this order') : ''}
      ${s.driver || s.vehicle ? row('Transport', esc([s.driver && name(s.driver), s.vehicle && name(s.vehicle)].filter(Boolean).join(' · '))) : ''}
      ${s.transporter || s.lrNo ? row(s.transporter ? 'Transport company' : 'Waybill', `${s.transporter ? esc(name(s.transporter)) : ''}${s.lrNo ? `${s.transporter ? ' · receipt ' : ''}${esc(s.lrNo)}` : ''}${s.lrDate ? ` · ${esc(day(s.lrDate))}` : ''}`) : ''}
      ${tripRow(s)}
      ${s.lines.some((l) => l.from) ? row('Made from', esc([...new Set(s.lines.filter((l) => l.from).map((l) => l.from.step))].join(', '))) : ''}
      <hr>${lines}<hr>
      ${d.totals && s.kind !== 'pick_list' ? `${d.totals.discount ? row('Discount on the whole', `− ${fmt(d.totals.discount)}`) : ''}${row('Before VAT', cents(d.totals.netTotal))}${row('VAT', cents(d.totals.vat))}
        <div class="bz-mrow big"><span>Total</span><span>${tzs(d.totals.roundedTotal)}</span></div><hr>` : ''}
      ${s.kind === 'sales_order' ? row('Picked · delivered · billed', `${Math.round(d.perPicked ?? 0)}% · ${Math.round(d.perDelivered ?? 0)}% · ${Math.round(d.perBilled ?? 0)}%`)
        : s.kind === 'delivery_note' && !s.returnOf ? row('Billed · came back', `${Math.round(d.perBilled ?? 0)}% · ${Math.round(d.perReturned ?? 0)}%`)
        : s.kind === 'pick_list' ? row('Delivered', `${Math.round(d.perDelivered ?? 0)}%`) : ''}
      ${row('Status', `<span class="bz-st ${STATUS_TONE[d.status] ?? ''}">${esc(d.status)}</span>`)}
      ${s.remarks ? `<hr><p class="bz-note">${esc(s.remarks)}</p>` : ''}</div>`;
    const LBL = { quotation: 'Quotation', sales_order: 'Sales order', delivery_note: s.returnOf ? 'Delivery return' : 'Delivery note', pick_list: 'Pick list' };
    const m = modal({ title: `${LBL[s.kind]} ${s.id}`, icon: I.file, wide: true, body, actions: [...acts, { label: 'Close window', value: false }] });
    m.done.then(async (v) => {
      if (!v) return;
      if (v === 'print') return printDoc(kit, s.id);
      if (['sales_order', 'delivery_note', 'sales_invoice', 'pick_list', 'return'].includes(v)) return makeFrom(s.id, v);
      if (v === 'undo') {
        if (!(await confirmBox({ title: `Undo ${s.id}?`, text: 'Refused while something made from it is still live; undo that first.', ok: 'Undo', danger: true }))) return;
        try { await kit.api.undoStep(s.id); kit.toast('Undone ✓'); reload(); } catch (e) { kit.toast(errText(e)); }
        return;
      }
      setStatus(s.id, v);
    });
  }

  function showParty(party, side) {
    const open = openOf(party);
    const body = `<div class="bz-docview">${open.length ? open.map((i) => `<div class="bz-mrow"><span>${esc(i.step)} · due ${esc(day(stepOf(i.step)?.dueDate))} <span class="bz-st ${STATUS_TONE[i.status] ?? ''}">${esc(i.status)}</span></span><span>${fmt(i.outstanding)}</span></div>`).join('') : '<p class="bz-note">No open invoices.</p>'}</div>`;
    const act = side === 'customer' ? 'receive' : 'pay';
    const m = modal({ title: name(party), sub: side === 'customer' ? 'Open invoices' : 'Open bills', icon: I.money, body,
      actions: [{ label: 'Close', value: false }, ...(mayDo(kit, 'match') && open.length && creditsOf(party).length ? [{ label: 'Match credit', value: 'match' }] : []),
        ...(mayDo(kit, 'payback') && !open.length && creditsOf(party).length ? [{ label: side === 'customer' ? 'Pay them back' : 'They pay us back', value: 'payback' }] : []),
        ...(mayDo(kit, act) && open.length ? [{ label: side === 'customer' ? 'Receive payment' : 'Pay', pri: true, value: 'pay' }] : [])] });
    m.done.then((v) => { if (v === 'pay') open2(act, { party }); if (v === 'match') open2('match', { party, side }); if (v === 'payback') open2('payback', { party, side }); });
  }

  /** Credit a party has: payments, returns or journals whose amount is not linked to an invoice (negative rows against
   *  themselves). From the steps and the invoices the engine reports. */
  function creditsOf(party) {
    const out = [];
    for (const s of steps) {
      if (s.undone || s.kind === 'cancel') continue;
      const inv = invoices().find((i) => i.step === s.id);
      if (s.kind === 'credit_note' && inv && inv.party === party && inv.outstanding < -0.004) out.push({ step: s.id, left: -inv.outstanding, label: 'Return' });
      if (s.kind === 'payment' && s.party === party && (s.direction === 'in') === (partyType(party) === 'customer')) {
        const linked = (s.allocate || []).reduce((a, x) => a + x.amount, 0) + steps.filter((m) => m.kind === 'reconcile' && !m.undone && m.party === party)
          .flatMap((m) => m.allocations).filter((a) => a.from === s.id).reduce((a, x) => a + x.amount, 0);
        const ded = (s.deductions || []).reduce((a, d) => a + d.amount, 0);
        const left = s.amount + (s.direction === 'in' ? ded : -ded) - linked;
        if (left > 0.004) out.push({ step: s.id, left, label: 'Payment' });
      }
      if (s.kind === 'journal') {
        // credit to a customer (Cr Debtors) or an advance to a supplier (Dr Creditors), on rows that name no invoice
        const own = (s.rows || []).filter((r) => r.party === party && !r.invoice);
        const credit = own.reduce((a, r) => a + (r.role === 'payable' ? (r.debit || 0) - (r.credit || 0) : (r.credit || 0) - (r.debit || 0)), 0);
        const linked = steps.filter((m) => m.kind === 'reconcile' && !m.undone && m.party === party).flatMap((m) => m.allocations).filter((a) => a.from === s.id).reduce((a, x) => a + x.amount, 0);
        if (credit - linked > 0.004) out.push({ step: s.id, left: Math.round((credit - linked) * 100) / 100, label: 'Journal' });
      }
    }
    // money paid back without naming a return uses up their credit, oldest first
    let back = steps.filter((s) => !s.undone && s.kind === 'payment' && s.party === party && (s.direction === 'in') !== (partyType(party) === 'customer'))
      .reduce((a, s) => a + s.amount - (s.allocate || []).reduce((b, x) => b + x.amount, 0), 0);
    for (const c of out) { const u = Math.min(c.left, back); c.left = Math.round((c.left - u) * 100) / 100; back -= u; }
    return out.filter((c) => c.left > 0.004);
  }

  /** Match credit (payments or returns not linked to an invoice) to the party's open invoices, oldest first. */
  function matchDialog(pre) {
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    const side = pre.side || 'customer';
    const party = makeField({ key: 'party', label: side === 'customer' ? 'Customer' : 'Supplier', type: 'link', to: side, required: true }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => draw() });
    body.append(party.el);
    body.insertAdjacentHTML('beforeend', `${dateIn('bzMDate')}<div class="wide" id="bzMMatch"></div><div class="bz-formerr wide" role="alert" hidden></div>`);
    const m = modal({ title: 'Match credit', sub: 'Money they paid ahead, or a return, comes off their open invoices; nothing is booked again', icon: I.link, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Match', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'match';
    const $d = (q) => m.box.querySelector(q);
    let credits = [], open = [];
    function draw() {
      const p = party.get();
      credits = p ? creditsOf(p) : []; open = p ? openOf(p) : [];
      if (!p) { $d('#bzMMatch').innerHTML = ''; return; }
      if (!credits.length || !open.length) { $d('#bzMMatch').innerHTML = `<p class="bz-note">${!credits.length ? 'They have no credit to match.' : 'They have no open invoices.'}</p>`; return; }
      // oldest credit to oldest invoice
      const pairs = [];
      const left = credits.map((c) => ({ ...c })), owed = open.map((i) => ({ step: i.step, left: i.outstanding }));
      for (const c of left) for (const i of owed) {
        const a = Math.min(c.left, i.left);
        if (a > 0.004) { pairs.push({ from: c.step, invoice: i.step, amount: Math.round(a * 100) / 100 }); c.left -= a; i.left -= a; }
      }
      $d('#bzMMatch').innerHTML = `<div class="bz-lines"><div class="bz-ln p bz-lh" role="row"><span>Credit</span><span>Invoice</span><span class="n">Owed</span><span class="n">Match</span></div>
        ${pairs.map((x, k) => `<div class="bz-ln p" role="row"><span>${esc(x.from)} <small class="bz-muted">${esc(credits.find((c) => c.step === x.from).label)} · ${fmt(credits.find((c) => c.step === x.from).left)}</small></span>
          <span>${esc(x.invoice)}</span><span class="n">${fmt(open.find((i) => i.step === x.invoice).outstanding)}</span>
          <input class="bz-in n" data-k="${k}" data-from="${esc(x.from)}" data-inv="${esc(x.invoice)}" inputmode="decimal" value="${esc(x.amount)}" aria-label="Amount to match"></div>`).join('')}</div>`;
    }
    draw();
    function go(btn) {
      if (!party.get()) { party.error('Choose who'); return party.focus(); }
      const allocations = [...m.box.querySelectorAll('#bzMMatch input')].map((inp) => ({ from: inp.dataset.from, invoice: inp.dataset.inv, amount: num(inp.value) })).filter((a) => a.amount > 0);
      if (!allocations.length) return showErr(m, 'Nothing to match');
      save({ kind: 'reconcile', party: party.get(), date: $d('#bzMDate').value, allocations, client_id: clientId }, m, btn);
    }
  }

  // ---------- dialogs
  function open(kind) { return open2(kind, {}); }
  function open2(kind, pre) {
    if (!mayDo(kit, kind)) return kit.toast('Your role cannot record this');
    if (kind === 'till') return kit.nav('till');
    if (kind === 'sale' || kind === 'bill' || kind === 'quote' || kind === 'order' || kind === 'dnote') return docDialog(kind, pre);
    if (kind === 'return') return returnDialog(pre);
    if (kind === 'receive' || kind === 'pay') return payDialog(kind, pre);
    if (kind === 'payback') return paybackDialog(pre);
    if (kind === 'trip') return tripDialog();
    if (kind === 'move') return moveDialog();
    if (kind === 'journal') return journalDialog();
    if (kind === 'match') return matchDialog(pre);
    if (kind === 'opening') return openingDialog();
  }
  const methodSel = (id, label, value) => field(id, label, `<select id="${id}">${methods.map((m) => `<option value="${esc(m.id)}"${m.id === value ? ' selected' : ''}>${esc(m.title || m.name)}</option>`).join('')}</select>`);
  const storeSel = (id, label, pick) => field(id, label, `<select id="${id}">${stores.map((s) => `<option value="${esc(s.id)}"${s.id === (pick || mainStore) ? ' selected' : ''}>${esc(s.title || s.name)}</option>`).join('')}</select>`);
  const dateIn = (id, label = 'Date', value = today()) => field(id, label, `<input class="bz-in" type="date" id="${id}" value="${esc(value)}" max="${today()}">`);
  const textIn = (id, label, cls = '', ph = '') => field(id, label, `<input class="bz-in" id="${id}" autocomplete="off"${ph ? ` placeholder="${esc(ph)}"` : ''}>`, cls);
  const showErr = (m, text) => { const e = m.box.querySelector('.bz-formerr'); e.hidden = !text; e.textContent = text || ''; };
  async function save(step, m, btn, { onError } = {}) {
    await busy(btn, async () => {
      try {
        const r = await kit.api.addStep(step);
        kit.toast(`${r?.step?.label || ACTIONS[m.kind]?.label || 'Saved'} ${r?.step?.id || ''} ✓`.trim());
        m.close(true);
        reload();
      } catch (e) { showErr(m, errText(e)); onError?.(e); }
    });
  }

  /** A sale (customer) or a supplier bill: who, lines with discounts, VAT, live totals; a sale may be paid now. */
  function docDialog(kind, pre) {
    // the selling form serves a sale, a quotation and an order; only a sale is paid at once
    const sale = kind === 'sale' || kind === 'quote' || kind === 'order' || kind === 'dnote', paying = kind === 'sale';
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money';
    body.noValidate = true;
    // selling documents: heading, letter head and terms for the printed page (print.js)
    const printing = sale ? printOptions(kit, kind) : null;
    const party = makeField({ key: 'party', label: sale ? 'Customer' : 'Supplier', type: 'link', to: sale ? 'customer' : 'supplier', required: true, filter: { active: true } }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { priceAll(true); if (sale) exemptOf(); printing?.forCustomer(party.get()); preview(); } });
    body.append(party.el);
    const receipts = sale ? [] : steps.filter((s) => s.kind === 'purchase_receipt' && !s.undone && !steps.some((b) => b.kind === 'purchase_invoice' && b.receipt === s.id && !b.undone));
    body.insertAdjacentHTML('beforeend', `
      ${dateIn('bzMDate')}
      ${kind === 'quote' ? field('bzMValid', 'Valid till', '<input class="bz-in" type="date" id="bzMValid">') : kind === 'order' ? field('bzMDeliv', 'Deliver by', '<input class="bz-in" type="date" id="bzMDeliv">') : ''}
      ${sale ? `<div id="bzMSm"></div>` : ''}
      ${kind === 'order' && company.stock_reservation === true ? sw('bzMHold', 'Hold the stock firmly for this order', false, '') : ''}
      ${kind === 'dnote' ? transportFields() : ''}
      ${kind === 'quote' ? '' : sale ? storeSel('bzMStore', kind === 'order' ? 'Deliver from' : 'Goods leave from') : field('bzMRcpt', 'What is it for?', `<select id="bzMRcpt"><option value="">Services, or goods still to arrive</option><option value="now">Goods arriving with this bill</option>${receipts.map((r) => `<option value="${esc(r.id)}">Goods arrived ${esc(r.id)} · ${esc(day(r.date))}</option>`).join('')}</select>`)}
      ${sale ? '' : `<div id="bzMStoreWrap" hidden>${storeSel('bzMStore', 'Goods go into')}</div>`}
      ${sale ? '' : `${textIn('bzMBillNo', 'Their bill number', '', 'As printed on the bill')}${dateIn('bzMBillDate', 'Their bill date', '')}`}
      ${sw('bzMVat', sale ? 'Prices include VAT' : 'VAT on this bill', sale, sale ? '' : '')}
      ${sale ? sw('bzMNoVat', 'Sell without VAT (exempt customer, export)', false, '') : ''}
      ${sale ? '' : sw('bzMIncl', 'Bill prices include VAT', false, '')}
      ${sale ? `<div class="bz-fld wide bz-scan"><input class="bz-in" id="bzMScan" autocomplete="off" placeholder="Scan a barcode or type a product code, then Enter" aria-label="Scan a barcode or product code"></div>` : ''}
      <div class="bz-lines wide" id="bzMLines" role="table"><div class="bz-ln bz-lh" role="row"><span>Product</span><span class="n">Qty</span><span class="n">Price</span><span class="n">Off %</span><span class="n">Amount</span><span></span></div></div>
      <button type="button" class="tbtn wide bz-addln" id="bzMAdd">${svg(I.plus)}Add a product</button>
      ${field('bzMDisc', `Discount on the whole ${sale ? 'sale' : 'bill'} (TZS)`, '<input class="bz-in n" id="bzMDisc" inputmode="decimal" placeholder="0">')}
      ${textIn('bzMNote', 'Note', '', sale ? 'e.g. their order number' : '')}
      <div class="bz-totals wide" id="bzMTot"></div>
      ${paying ? `<div class="wide"><div class="seg" id="bzMPayMode"><button type="button" data-p="credit" class="on">On credit</button><button type="button" data-p="paid">Paid now</button></div></div>
        <div class="wide" id="bzMPays" hidden></div>` : sale ? '' : `${sw('bzMPaidNow', 'Paid now (a cash purchase)', false)}
        <div class="bz-payrow wide" id="bzMBillPay" hidden>${methodSel('bzMBpm', 'Paid with', methods.find((x) => x.type === 'Cash')?.id)}${field('bzMBpa', 'Amount', '<input class="bz-in n" id="bzMBpa" inputmode="decimal">')}</div>`}
      <div class="bz-formerr wide" role="alert" hidden></div>`);
    const SUB = { sale: 'Totals use your VAT setup; goods leave the store you choose', quote: 'Prices offered to a customer; nothing moves until it is ordered',
      order: 'Goods are held for the customer until delivered', dnote: 'Goods leave now; the invoice follows later', bill: 'Bill from a supplier' };
    const SAVE = { sale: 'Save sale', quote: 'Save quotation', order: 'Save order', dnote: 'Save delivery', bill: 'Save bill' };
    const m = modal({ title: ACTIONS[kind].label, sub: SUB[kind], icon: ACTIONS[kind].icon, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: SAVE[kind], pri: true, id: 'bzMSave', onClick: (_, btn) => go(btn) }] });
    m.kind = kind;
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    if (printing) { body.querySelector('.bz-formerr').before(printing.el); if (pre.party) printing.forCustomer(pre.party); }
    const vatOn = wireSwitch($d('#bzMVat'), (on) => { if (!sale) $d('#bzMIncl').disabled = !on; preview(); });
    const holdOn = $d('#bzMHold') ? wireSwitch($d('#bzMHold')) : () => false;
    const salesman = sale ? makeField({ key: 'salesman', label: 'Salesman', type: 'link', to: 'salesman', filter: { active: true }, help: 'Empty: the customer\'s own salesman.' }, null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf }) : null;
    if (salesman) $d('#bzMSm').append(salesman.el);
    const noVat = sale ? wireSwitch($d('#bzMNoVat'), (on) => { $d('#bzMVat').disabled = on; preview(); }) : () => false;
    const paidNowOn = sale ? () => false : wireSwitch($d('#bzMPaidNow'), (on) => { $d('#bzMBillPay').hidden = !on; if (on && totals && !$d('#bzMBpa').value) $d('#bzMBpa').value = fmt(totals.roundedTotal); });
    // a customer marked "buys without VAT" (or their group) starts with VAT off
    async function exemptOf() {
      const c = party.get() ? await kit.api.doc('customer', party.get()).then((x) => x?.doc).catch(() => null) : null;
      let ex = c?.vat_exempt === true;
      if (!ex && c?.group) ex = (await kit.api.doc('customer_group', c.group).then((x) => x?.doc).catch(() => null))?.vat_exempt === true;
      const el = $d('#bzMNoVat');
      if (el && el.getAttribute('aria-checked') !== String(ex)) el.click();
    }
    const inclOn = sale ? vatOn : wireSwitch($d('#bzMIncl'), () => preview());
    if (!sale) $d('#bzMIncl').disabled = true;
    $d('#bzMDisc').oninput = () => preview();
    $d('#bzMDate').onchange = () => { priceAll(true); preview(); };
    const lines = [];
    function addLine(item = null, q = 1, rate = '', disc = '') {
      const row = document.createElement('div');
      row.className = 'bz-ln'; row.setAttribute('role', 'row');
      const prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: sale ? { active: true, can_sell: true } : { active: true, can_buy: true } }, item, {
        api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => { line.ri.value = ''; priceOf(line); accountFor(line); stockOf(line); preview(); } });
      row.append(prod.el);
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Quantity" inputmode="decimal" value="${esc(q)}"><input class="bz-in n" aria-label="Price" inputmode="decimal" value="${esc(rate)}"><input class="bz-in n" aria-label="Discount %" inputmode="decimal" value="${esc(disc)}" placeholder="0"><span class="n bz-lamt"></span>
        <button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      const [qi, ri, di] = row.querySelectorAll('input.bz-in.n');
      const line = { row, prod, qi, ri, di, auto: false, acc: null };
      di.oninput = () => preview();
      qi.oninput = () => { preview(); if (sale && line.auto) ruleAgain(line); };
      ri.oninput = () => { line.auto = false; preview(); };
      row.querySelector('.ibtn').onclick = () => { lines.splice(lines.indexOf(line), 1); row.remove(); preview(); };
      $d('#bzMLines').append(row);
      lines.push(line);
      return line;
    }
    $d('#bzMAdd').onclick = () => addLine().prod.focus();
    // what is in stock for a selling line: in the store the goods leave from, in all stores, and free after open orders
    async function stockOf(line) {
      line.row.querySelector('.bz-lstock')?.remove();
      const item = sale && line.prod.get();
      if (!item) return;
      // services keep no stock
      if ((await kit.api.doc('product', item).then((x) => x?.doc).catch(() => null))?.is_stock === false || line.prod.get() !== item) return;
      line.row.querySelector('.bz-lstock')?.remove();
      const bal = (result?.balances || []).filter((b) => b.item === item);
      const store = $d('#bzMStore')?.value;
      const all = bal.reduce((a, b) => a + b.qty, 0);
      const held = (result?.reserved || []).filter((r) => r.item === item && (!store || r.warehouse === store)).reduce((a, r) => a + r.qty, 0);
      const here = store ? bal.filter((b) => b.warehouse === store).reduce((a, b) => a + b.qty, 0) : all;
      line.row.insertAdjacentHTML('beforeend', `<small class="bz-lstock bz-muted">${store ? `In ${esc(stores.find((x) => x.id === store)?.title || 'this store')}: ${qty(here)} · ` : ''}All stores: ${qty(all)}${held ? ` · Free after open orders: ${qty(here - held)}` : ''}</small>`);
    }
    $d('#bzMStore')?.addEventListener('change', () => lines.forEach(stockOf));
    // scanning: an exact barcode or code adds the product (one more if it is already on a line)
    $d('#bzMScan')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = e.target.value.trim();
      if (!code) return;
      const found = await kit.api.options('product', code, { active: true, can_sell: true }).catch(() => []);
      const hit = found.length === 1 ? found[0] : found.find((o) => String(o.subtitle ?? '').toLowerCase() === code.toLowerCase());
      if (!hit) return kit.toast(found.length ? `${found.length} products match “${code}”: pick one in a line` : `Nothing found for “${code}”`);
      e.target.value = '';
      const same = lines.find((l) => l.prod.get() === hit.id);
      if (same) { same.qi.value = String(num(same.qi.value) + 1); if (same.auto) ruleAgain(same); preview(); return; }
      const empty = lines.find((l) => !l.prod.get());
      const line = empty || addLine();
      line.prod.set(hit.id);
      line.ri.value = '';
      await priceOf(line);
      stockOf(line);
      preview();
    });
    // a service on a bill (rent, transport, fuel) is booked to an expense account: the product's own, which can be changed here
    async function accountFor(line) {
      if (sale) return;
      line.row.querySelector('.bz-lacc')?.remove(); line.acc = null;
      const p = line.prod.get() ? await kit.api.doc('product', line.prod.get()).then((x) => x?.doc).catch(() => null) : null;
      if (!p || p.is_stock !== false) return;
      const wrap = document.createElement('div'); wrap.className = 'bz-lacc';
      line.acc = makeField({ key: 'account', label: 'Booked to', type: 'link', to: 'account', filter: { is_group: false, root_type: 'Expense' } }, p.expense_account ?? null,
        { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true });
      wrap.append(line.acc.el);
      line.row.append(wrap);
    }
    if (!sale) $d('#bzMRcpt').addEventListener('change', () => {
      $d('#bzMStoreWrap').hidden = $d('#bzMRcpt').value !== 'now';
      const r = stepOf($d('#bzMRcpt').value);
      if (!r) return;
      lines.splice(0).forEach((l) => l.row.remove());
      r.lines.forEach((l) => addLine(l.item, l.qty, l.rate));
      preview();
    });
    addLine();
    queueMicrotask(() => drawTotals());   // after the rest of this dialog is set up (totals, payments)
    requestAnimationFrame(() => party.focus());

    // the price the server's rules give (03 §2.3: the party's list, its group's, the company default; valid on the date).
    // A price typed by hand is kept; one filled in here is refreshed when the customer or date changes.
    async function priceOf(line, refresh = false) {
      const item = line.prod.get();
      if (!item) return;
      const fillPrice = !line.ri.value || (refresh && line.auto);
      try {
        const r = await kit.api.price(item, party.get() || undefined, sale ? 'sell' : 'buy', $d('#bzMDate').value || undefined, num(line.qi.value) || 1);
        if (r?.price && fillPrice) { line.ri.value = fmt(r.price.rate); line.auto = true; line.base = r.price.rate; }
        line.ri.title = r?.price?.last ? `Last paid ${fmt(r.price.last.rate ?? r.price.rate)} on ${day(r.price.last.date)} (${r.price.last.step})` : '';
        // a pricing rule that fits this line; only on lines priced here (a price typed by hand is kept)
        const rule = r?.rule;
        line.row.querySelector('.bz-rule')?.remove();
        if (sale && rule?.error) line.row.insertAdjacentHTML('beforeend', `<small class="bz-rule bz-ferr">${esc(rule.error)}</small>`);
        if (sale && line.auto && rule && !rule.error) {
          const base = line.base ?? num(line.ri.value);
          if (rule.action === 'Fixed price') { line.ri.value = fmt(rule.value); line.di.value = ''; }
          else if (rule.action === 'Discount %') { line.ri.value = fmt(base); line.di.value = String(rule.value); }
          else { line.ri.value = fmt(Math.max(0, base - rule.value)); line.di.value = ''; }
          line.rule = rule.rule;
          line.row.insertAdjacentHTML('beforeend', `<small class="bz-rule bz-muted">Pricing rule: ${esc(rule.title)}</small>`);
        } else if (sale && line.auto && line.rule && !rule) { line.ri.value = fmt(line.base ?? num(line.ri.value)); line.di.value = ''; line.rule = null; }
        preview();
      } catch {}
    }
    const priceAll = (refresh) => lines.forEach((l) => priceOf(l, refresh));
    const ruleAgain = debounce((line) => priceOf(line, true), 350);
    function draft() {
      const ls = lines.map((l) => ({ item: l.prod.get(), qty: num(l.qi.value), rate: num(l.ri.value), ...(num(l.di.value) ? { discount: num(l.di.value) } : {}),
        ...(l.acc?.get() ? { account: l.acc.get() } : {}) })).filter((l) => l.item);
      const base = { kind: { sale: 'sales_invoice', quote: 'quotation', order: 'sales_order', dnote: 'delivery_note', bill: 'purchase_invoice' }[kind], lines: ls, date: $d('#bzMDate').value, discount_amount: num($d('#bzMDisc').value) || undefined, remarks: $d('#bzMNote').value.trim() || undefined, ...(printing ? printing.get() : {}) };
      const sm = salesman?.get() ? { salesman: salesman.get() } : {};
      if (kind === 'quote') return { ...base, ...sm, customer: party.get(), prices_include_vat: vatOn(), vat: !noVat(), valid_till: $d('#bzMValid').value || undefined };
      if (kind === 'order') return { ...base, ...sm, customer: party.get(), warehouse: $d('#bzMStore').value, prices_include_vat: vatOn(), vat: !noVat(), delivery_date: $d('#bzMDeliv').value || undefined,
        ...(holdOn() ? { reserve_stock: true } : {}) };
      if (kind === 'dnote') return { ...base, ...sm, ...transportOut($d), customer: party.get(), warehouse: $d('#bzMStore').value, prices_include_vat: vatOn(), vat: !noVat() };
      if (sale) return { ...base, ...sm, customer: party.get(), warehouse: $d('#bzMStore').value, prices_include_vat: vatOn(), vat: !noVat() };
      const rc = $d('#bzMRcpt').value;
      return { ...base, supplier: party.get(), vat: vatOn(), prices_include_vat: vatOn() && inclOn(), bill_no: $d('#bzMBillNo').value.trim() || undefined, bill_date: $d('#bzMBillDate').value || undefined,
        ...(rc === 'now' ? { update_stock: true, warehouse: $d('#bzMStore').value } : rc ? { receipt: rc } : {}),
        ...(paidNowOn() && num($d('#bzMBpa').value) > 0 ? { payments: [{ method: $d('#bzMBpm').value, amount: num($d('#bzMBpa').value) }] } : {}) };
    }
    let totals = null, seq = 0;
    const preview = debounce(async () => {
      const d = draft();
      lines.forEach((l) => { const a = num(l.qi.value) * lineRate({ rate: num(l.ri.value), discount: num(l.di.value) }); l.row.querySelector('.bz-lamt').textContent = a ? fmt(a) : ''; });
      const my = ++seq;
      if (!d.lines.length || d.lines.some((l) => !(l.qty > 0) || !(l.rate >= 0)) || !(d.customer || d.supplier)) { totals = null; drawTotals(); return; }
      const pv = sale && !paying ? { ...d, kind: 'sales_invoice', update_stock: false } : d;
      try { const t = await kit.api.preview(pv); if (my === seq) { totals = t; drawTotals(); } } catch (e) { if (my === seq) { totals = null; drawTotals(errText(e)); } }
    }, 200);
    function drawTotals(problem) {
      const t = totals;
      const credit = t?.credit && t.credit.limit > 0 ? t.credit : null;
      const after = credit ? credit.owed + t.roundedTotal - paidNow() : 0;
      $d('#bzMTot').innerHTML = t ? `${t.discount ? `<div class="bz-mrow"><span>Discount on the whole</span><span>− ${cents(t.discount)}</span></div>` : ''}
        <div class="bz-mrow"><span>Before VAT</span><span>${cents(t.netTotal)}</span></div><div class="bz-mrow"><span>VAT</span><span>${cents(t.vat)}</span></div>
        <div class="bz-mrow big"><span>Total</span><span>${tzs(t.roundedTotal)}</span></div>
        ${credit ? `<div class="bz-mrow"><span>Owes now · credit limit</span><span>${fmt(credit.owed)} · ${fmt(credit.limit)}${after > credit.limit + 0.004 && t.roundedTotal - paidNow() > 0.004 ? ' <span class="bz-st bad">over the limit</span>' : ''}</span></div>` : ''}`
        : `<p class="bz-note">${esc(problem || 'Choose who and add products to see the total.')}</p>`;
      if (paying) drawChange();
    }
    // paid now: one or more methods; cash above the total is change; a small amount short can be written off
    const pays = [];
    const paidNow = () => (paying && !$d('#bzMPays').hidden ? pays.reduce((s, p) => s + num(p.amt.value), 0) : 0);
    if (paying) {
      $d('#bzMPayMode').querySelectorAll('button').forEach((b) => (b.onclick = () => {
        $d('#bzMPayMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        $d('#bzMPays').hidden = b.dataset.p !== 'paid';
        if (b.dataset.p === 'paid' && !pays.length) addPay();
        drawTotals();
      }));
    }
    let writeOff = () => false;
    function addPay() {
      const i = pays.length;
      const row = document.createElement('div');
      row.className = 'bz-payrow';
      row.innerHTML = `${methodSel(`bzMPm${i}`, i ? 'And' : 'Paid with', methods.find((m) => m.type === 'Cash')?.id)}${field(`bzMPa${i}`, 'Amount', `<input class="bz-in n" id="bzMPa${i}" inputmode="decimal">`)}
        ${field(`bzMPr${i}`, 'Code', `<input class="bz-in" id="bzMPr${i}" placeholder="M-Pesa code or slip number" maxlength="60">`)}`;
      $d('#bzMPays').append(row);
      enhanceSelects(row);
      const p = { row, sel: row.querySelector('select'), amt: row.querySelector(`#bzMPa${i}`), ref: row.querySelector(`#bzMPr${i}`) };
      if (!i && totals) p.amt.value = fmt(totals.roundedTotal);
      p.amt.oninput = () => drawTotals();
      p.sel.addEventListener('change', drawChange);
      pays.push(p);
      if (!$d('#bzMAddPay')) {
        $d('#bzMPays').insertAdjacentHTML('beforeend', `<button type="button" class="tbtn" id="bzMAddPay">+ Another method</button><p class="bz-note" id="bzMChange"></p>
          <div id="bzMWo" hidden>${sw('bzMWriteOff', 'Write off the small amount left (e.g. no change coins)', false, '')}</div>`);
        $d('#bzMAddPay').onclick = () => { addPay(); $d('#bzMPays').append($d('#bzMAddPay'), $d('#bzMChange'), $d('#bzMWo')); };
        writeOff = wireSwitch($d('#bzMWriteOff'), drawChange);
      }
      drawChange();
    }
    function drawChange() {
      const c = $d('#bzMChange');
      if (!c || !totals) return;
      const paid = pays.reduce((s, p) => s + num(p.amt.value), 0);
      const cash = pays.some((p) => methods.find((m) => m.id === p.sel.value)?.type === 'Cash');
      const short = totals.roundedTotal - paid;
      $d('#bzMWo').hidden = !(short > 0.004 && paid > 0 && (short <= 1000 || isManager(kit)));
      c.textContent = paid > totals.roundedTotal ? (cash ? `Change: ${tzs(paid - totals.roundedTotal)}` : 'More than the total: only cash can give change')
        : short > 0.004 ? (writeOff() && !$d('#bzMWo').hidden ? `${tzs(short)} written off; nothing owed` : `Still owed after this: ${tzs(short)}`) : 'Paid in full';
    }
    function go(btn, allowOver = false) {
      const d = draft();
      showErr(m, '');
      if (!(d.customer || d.supplier)) { party.error(`Choose the ${sale ? 'customer' : 'supplier'}`); return party.focus(); }
      if (!d.lines.length) return showErr(m, 'Add at least one product');
      if (paying && !$d('#bzMPays').hidden) {
        d.payments = pays.map((p) => ({ method: p.sel.value, amount: num(p.amt.value), reference: p.ref.value.trim() || undefined })).filter((p) => p.amount > 0);
        if (writeOff() && !$d('#bzMWo').hidden) d.write_off = true;
      }
      if (allowOver) d.allow_over_limit = true;
      save({ ...d, client_id: clientId }, m, btn, {
        onError: (e) => {
          // over the credit limit: a manager may allow it on purpose
          if (sale && !allowOver && isManager(kit) && /Credit limit crossed/.test(errText(e))) {
            const err = $d('.bz-formerr');
            err.insertAdjacentHTML('beforeend', ` <button type="button" class="tbtn" id="bzMOver">Allow this ${kind === 'order' ? 'order' : 'sale'} over the limit</button>`);
            $d('#bzMOver').onclick = (ev) => go(ev.currentTarget, true);
          }
        },
      });
    }
  }

  function returnDialog(pre) {
    const sales = invoices().filter((i) => kindOf(i.step) === 'sales_invoice' && i.status !== 'Cancelled' && !stepOf(i.step)?.opening);
    if (!sales.length) return kit.toast('No sales to return yet');
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${field('bzMSale', 'Which sale?', `<select id="bzMSale">${[...sales].reverse().map((i) => `<option value="${esc(i.step)}"${i.step === pre.against ? ' selected' : ''}>${esc(i.step)} · ${esc(name(i.party))} · ${fmt(i.roundedTotal)}</option>`).join('')}</select>`, 'wide')}
      ${dateIn('bzMDate')}
      <div class="bz-lines wide" id="bzMRLines"></div>
      ${sw('bzMBack', 'The goods come back into the store', true)}
      <div id="bzMRedWrap" class="wide">${sw('bzMReduce', 'Take it off what they still owe on this sale', true, '')}<p class="bz-note" id="bzMRedNote"></p></div>
      ${textIn('bzMNote', 'Note', 'wide', 'Why it came back')}
      <div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Return', sub: 'The customer gets back what they paid for these goods', icon: I.undo, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save return', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'return';
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    const backOn = wireSwitch($d('#bzMBack'));
    const reduceOn = wireSwitch($d('#bzMReduce'), () => note());
    const note = () => { $d('#bzMRedNote').textContent = reduceOn() ? 'The sale shows less owed.' : 'It is kept as credit for their next purchase (or paid back).'; };
    function fill() {
      const s = stepOf($d('#bzMSale').value);
      const inv = invoices().find((i) => i.step === s?.id);
      $d('#bzMBack').disabled = !s?.updateStock;
      const owed = (inv?.outstanding || 0) > 0.004;
      $d('#bzMRedWrap').hidden = !owed;
      $d('#bzMReduce').classList.toggle('on', owed); $d('#bzMReduce').setAttribute('aria-checked', String(owed));
      note();
      $d('#bzMRLines').innerHTML = `<div class="bz-ln r bz-lh" role="row"><span>Product</span><span class="n">Sold</span><span class="n">Coming back</span></div>` +
        (s?.lines || []).map((l, i) => `<div class="bz-ln r" role="row"><span>${esc(name(l.item))}${l.discount ? ` <small class="bz-muted">${qty(l.discount)}% off</small>` : ''}</span><span class="n">${qty(l.qty)}</span><input class="bz-in n" data-i="${i}" inputmode="decimal" value="${esc(l.qty)}" aria-label="Quantity coming back"></div>`).join('');
    }
    $d('#bzMSale').addEventListener('change', fill);
    fill();
    function go(btn) {
      const s = stepOf($d('#bzMSale').value);
      const inputs = [...m.box.querySelectorAll('#bzMRLines input')];
      const lines = inputs.map((inp) => ({ ...s.lines[+inp.dataset.i], qty: num(inp.value) })).filter((l) => l.qty > 0);
      if (!lines.length) return showErr(m, 'Nothing is coming back');
      const all = inputs.every((inp) => num(inp.value) === s.lines[+inp.dataset.i].qty);
      save({ kind: 'credit_note', against: s.id, date: $d('#bzMDate').value, ...(all ? {} : { lines }), update_stock: !!s.updateStock && backOn(),
        reduce_invoice: !$d('#bzMRedWrap').hidden && reduceOn(), remarks: $d('#bzMNote').value.trim() || undefined, client_id: clientId }, m, btn);
    }
  }

  /** Receive from a customer or pay a supplier; the amount settles their oldest open invoices first. */
  function payDialog(kind, pre) {
    const into = kind === 'receive';
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    const party = makeField({ key: 'party', label: into ? 'Customer' : 'Supplier', type: 'link', to: into ? 'customer' : 'supplier', required: true }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => drawOpen(true) });
    body.append(party.el);
    body.insertAdjacentHTML('beforeend', `${dateIn('bzMDate')}${methodSel('bzMPm', into ? 'Received by' : 'Paid by', (methods.find((x) => x.name === 'M-Pesa') || methods.find((x) => x.type === 'Mobile money'))?.id)}
      ${field('bzMAmt', 'Amount (TZS)', '<input class="bz-in n" id="bzMAmt" inputmode="decimal">')}
      ${textIn('bzMRef', 'Reference', '', 'M-Pesa code, cheque or bank slip number')}${textIn('bzMNote', 'Note')}
      ${field('bzMChg', into ? 'Charges taken off (TZS)' : 'Charges paid on top (TZS)', '<input class="bz-in n" id="bzMChg" inputmode="decimal" placeholder="0">')}<div id="bzMChgAcc"></div>
      <div class="wide" id="bzMOpen"></div><div class="bz-formerr wide" role="alert" hidden></div>`);
    const m = modal({ title: ACTIONS[kind].label, sub: 'It settles the oldest invoices first; what is left stays as credit', icon: ACTIONS[kind].icon, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save payment', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = kind;
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    $d('#bzMAmt').oninput = () => spread();
    $d('#bzMChg').oninput = () => spread();
    // bank or mobile-money charges: booked to an expense account (Bank and Mobile Money Charges in the Tanzania template)
    const chgAcc = makeField({ key: 'account', label: 'Charges booked to', type: 'link', to: 'account', filter: { is_group: false, root_type: 'Expense' } }, null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf });
    $d('#bzMChgAcc').append(chgAcc.el);
    kit.api.options('account', 'Charges', { is_group: false, root_type: 'Expense' }).then((o) => { if (o?.[0] && !chgAcc.get()) chgAcc.set?.(o[0].id, o[0].title); }).catch(() => {});
    let open = [];
    function drawOpen(fillAmount) {
      open = party.get() ? openOf(party.get()) : [];
      $d('#bzMOpen').innerHTML = !party.get() ? '' : open.length
        ? `<div class="bz-lines"><div class="bz-ln p bz-lh" role="row"><span>Invoice</span><span>Due</span><span class="n">Owed</span><span class="n">This payment</span></div>${open.map((i, k) => `<div class="bz-ln p" role="row"><span>${esc(i.step)}${stepOf(i.step)?.billNo ? ` <small class="bz-muted">${esc(stepOf(i.step).billNo)}</small>` : ''}</span><span>${esc(day(stepOf(i.step)?.dueDate))}</span><span class="n">${fmt(i.outstanding)}</span><input class="bz-in n" data-k="${k}" inputmode="decimal" aria-label="Amount for ${esc(i.step)}"></div>`).join('')}</div>`
        : '<p class="bz-note">No open invoices: the whole amount is kept as credit.</p>';
      if (fillAmount && open.length && !$d('#bzMAmt').value) $d('#bzMAmt').value = fmt(open.reduce((s, i) => s + i.outstanding, 0));
      spread();
    }
    function spread() {
      // what settles the invoices: money in plus the charges kept back; money out less the charges paid on top
      let left = num($d('#bzMAmt').value) + (into ? 1 : -1) * num($d('#bzMChg').value);
      m.box.querySelectorAll('#bzMOpen input').forEach((inp) => { const o = open[+inp.dataset.k].outstanding; const a = Math.min(o, Math.max(0, left)); inp.value = a ? fmt(a) : ''; left -= a; });
    }
    drawOpen(true);
    function go(btn) {
      const amount = num($d('#bzMAmt').value);
      showErr(m, '');
      if (!party.get()) { party.error(`Choose the ${into ? 'customer' : 'supplier'}`); return party.focus(); }
      if (!(amount > 0)) return showErr(m, 'Enter the amount');
      if (amount + (into ? 1 : -1) * num($d('#bzMChg').value) <= 0) return showErr(m, 'The charges are more than the payment');
      const allocate = [...m.box.querySelectorAll('#bzMOpen input')].map((inp) => ({ invoice: open[+inp.dataset.k].step, amount: num(inp.value) })).filter((a) => a.amount > 0);
      const chg = num($d('#bzMChg').value);
      if (chg > 0 && !chgAcc.get()) return showErr(m, 'Choose the account the charges are booked to');
      save({ kind: 'payment', direction: into ? 'in' : 'out', party: party.get(), method: $d('#bzMPm').value, amount, allocate, date: $d('#bzMDate').value,
        ...(chg > 0 ? { deductions: [{ account: chgAcc.get(), amount: chg }] } : {}),
        reference: $d('#bzMRef').value.trim() || undefined, remarks: $d('#bzMNote').value.trim() || undefined, client_id: clientId }, m, btn);
    }
  }

  /** Paying a customer back (their credit from a return, or money paid twice) or a supplier paying us back (an
   *  advance they return). A customer's returns with credit left are settled oldest first. */
  function paybackDialog(pre) {
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    let side = pre.side === 'supplier' ? 'supplier' : 'customer';
    body.innerHTML = `${field('bzMSide', 'Who', `<select id="bzMSide"><option value="customer"${side === 'customer' ? ' selected' : ''}>We pay a customer back</option><option value="supplier"${side === 'supplier' ? ' selected' : ''}>A supplier pays us back</option></select>`)}
      ${dateIn('bzMDate')}<div id="bzMWho"></div>${methodSel('bzMPm', 'Paid by', methods.find((x) => x.type === 'Cash')?.id)}
      ${field('bzMAmt', 'Amount (TZS)', '<input class="bz-in n" id="bzMAmt" inputmode="decimal">')}${textIn('bzMRef', 'Reference', '', 'M-Pesa code, cheque or bank slip number')}
      ${textIn('bzMNote', 'Note', 'wide')}<div class="wide" id="bzMCred"></div><div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Pay back', sub: 'Money back for credit they have: a return, an advance, a payment made twice', icon: I.undo, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'payback';
    const $d = (q) => m.box.querySelector(q);
    enhanceSelects(body);
    let party, returns = [];
    function who() {
      side = $d('#bzMSide').value;
      $d('#bzMWho').innerHTML = '';
      party = makeField({ key: 'party', label: side === 'customer' ? 'Customer' : 'Supplier', type: 'link', to: side, required: true }, pre.party && pre.side === side ? pre.party : null,
        { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => draw(true) });
      $d('#bzMWho').append(party.el);
      draw(true);
    }
    function draw(fill) {
      const p = party.get();
      const credit = p ? creditsOf(p).reduce((a, c) => a + c.left, 0) : 0;
      returns = p && side === 'customer' ? invoices().filter((i) => i.party === p && i.outstanding < -0.004) : [];
      $d('#bzMCred').innerHTML = !p ? '' : `<p class="bz-note">${credit > 0.004 ? `${side === 'customer' ? 'Their credit with us' : 'What they hold of ours'}: <b>${fmt(credit)}</b>` : 'No credit on record; the amount is still recorded.'}</p>
        ${returns.length ? `<div class="bz-lines"><div class="bz-ln p bz-lh" role="row"><span>Return</span><span>Date</span><span class="n">Credit</span><span class="n">Paid back now</span></div>
          ${returns.map((i, k) => `<div class="bz-ln p" role="row"><span>${esc(i.step)}</span><span>${esc(day(stepOf(i.step)?.date))}</span><span class="n">${fmt(-i.outstanding)}</span><input class="bz-in n" data-k="${k}" inputmode="decimal" aria-label="Paid back for ${esc(i.step)}"></div>`).join('')}</div>` : ''}`;
      if (fill && credit > 0.004 && !$d('#bzMAmt').value) $d('#bzMAmt').value = fmt(credit);
      spread();
    }
    function spread() {
      let left = num($d('#bzMAmt').value);
      m.box.querySelectorAll('#bzMCred input').forEach((inp) => { const c = -returns[+inp.dataset.k].outstanding; const a = Math.min(c, Math.max(0, left)); inp.value = a ? fmt(a) : ''; left -= a; });
    }
    $d('#bzMSide').onchange = () => { $d('#bzMAmt').value = ''; who(); };
    $d('#bzMAmt').oninput = () => spread();
    who();
    function go(btn) {
      showErr(m, '');
      const amount = num($d('#bzMAmt').value);
      if (!party.get()) { party.error(`Choose the ${side}`); return party.focus(); }
      if (!(amount > 0)) return showErr(m, 'Enter the amount');
      const allocate = [...m.box.querySelectorAll('#bzMCred input')].map((inp) => ({ invoice: returns[+inp.dataset.k].step, amount: num(inp.value) })).filter((a) => a.amount > 0);
      save({ kind: 'payment', direction: side === 'customer' ? 'out' : 'in', party: party.get(), method: $d('#bzMPm').value, amount, allocate, date: $d('#bzMDate').value,
        reference: $d('#bzMRef').value.trim() || undefined, remarks: $d('#bzMNote').value.trim() || undefined, client_id: clientId }, m, btn);
    }
  }

  function moveDialog() {
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${methodSel('bzMFrom', 'From', methods.find((x) => x.type === 'Cash')?.id)}${methodSel('bzMTo', 'To', methods.find((x) => x.type === 'Bank')?.id)}
      ${field('bzMAmt', 'Amount (TZS)', '<input class="bz-in n" id="bzMAmt" inputmode="decimal">')}${dateIn('bzMDate')}
      ${textIn('bzMRef', 'Reference', 'wide', 'Deposit slip number')}<div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Move money', sub: 'Between your own cash, bank and mobile money', icon: I.move, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'move';
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    function go(btn) {
      const amount = num($d('#bzMAmt').value);
      if (!(amount > 0)) return showErr(m, 'Enter the amount');
      save({ kind: 'money_transfer', from: $d('#bzMFrom').value, to: $d('#bzMTo').value, amount, date: $d('#bzMDate').value, reference: $d('#bzMRef').value.trim() || undefined, client_id: clientId }, m, btn);
    }
  }

  /** A journal: rows on accounts, each a debit or a credit; customer or supplier rows name who. Must balance. */
  function journalDialog() {
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${dateIn('bzMDate')}${textIn('bzMRef', 'Reference', '', 'e.g. October rent')}
      <div class="bz-lines wide" id="bzMJ" role="table"><div class="bz-ln j bz-lh" role="row"><span>Account</span><span>Customer or supplier</span><span class="n">Debit</span><span class="n">Credit</span><span></span></div></div>
      <button type="button" class="tbtn wide bz-addln" id="bzMAddRow">${svg(I.plus)}Add a row</button>
      <div class="bz-totals wide" id="bzMJTot"></div>
      ${textIn('bzMNote', 'Note', 'wide')}<div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Journal', sub: 'Debits must equal credits. Customer and supplier accounts need a name on the row.', icon: I.file, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save journal', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'journal';
    const $d = (s) => m.box.querySelector(s);
    const rows = [];
    function addRow() {
      const row = document.createElement('div');
      row.className = 'bz-ln j'; row.setAttribute('role', 'row');
      const r = { row, type: '' };
      r.acc = makeField({ key: 'account', label: 'Account', type: 'link', to: 'account', required: true, filter: { is_group: false } }, null,
        { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => partyFor(r) });
      row.append(r.acc.el);
      const slot = document.createElement('div'); slot.className = 'bz-jparty'; row.append(slot);
      r.slot = slot;
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Debit" inputmode="decimal"><input class="bz-in n" aria-label="Credit" inputmode="decimal"><button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      [r.dr, r.cr] = row.querySelectorAll('input.bz-in.n');
      r.dr.oninput = () => { if (num(r.dr.value)) r.cr.value = ''; sums(); };
      r.cr.oninput = () => { if (num(r.cr.value)) r.dr.value = ''; sums(); };
      row.querySelector('.ibtn').onclick = () => { rows.splice(rows.indexOf(r), 1); row.remove(); sums(); };
      $d('#bzMJ').append(row);
      rows.push(r);
      return r;
    }
    // a customer or supplier account needs to know whose money it is
    async function partyFor(r) {
      r.slot.innerHTML = ''; r.party = null; r.type = '';
      const id = r.acc.get();
      if (!id) return;
      const a = (await kit.api.doc('account', id).catch(() => null))?.doc;
      const t = a?.account_type === 'Receivable' ? 'customer' : a?.account_type === 'Payable' ? 'supplier' : '';
      r.type = t;
      if (!t) { r.slot.innerHTML = '<span class="bz-muted">—</span>'; return; }
      r.party = makeField({ key: 'party', label: t === 'customer' ? 'Customer' : 'Supplier', type: 'link', to: t, required: true }, null,
        { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => invoicesOf(r) });
      r.slot.append(r.party.el);
      r.slot.insertAdjacentHTML('beforeend', '<select class="bz-jinv" aria-label="Invoice it settles" hidden></select>');
    }
    // the party's open invoices: a row may settle one of them (e.g. a bad debt written off), else it is their credit or debt
    function invoicesOf(r) {
      const sel = r.slot.querySelector('.bz-jinv');
      const open = r.party?.get() ? openOf(r.party.get()) : [];
      sel.innerHTML = `<option value="">No invoice: their balance</option>${open.map((i) => `<option value="${esc(i.step)}">${esc(i.step)} · owes ${fmt(i.outstanding)}</option>`).join('')}`;
      sel.hidden = !open.length;
    }
    function sums() {
      const d = rows.reduce((s, r) => s + num(r.dr.value), 0), c = rows.reduce((s, r) => s + num(r.cr.value), 0);
      const diff = Math.round((d - c) * 100) / 100;
      $d('#bzMJTot').innerHTML = `<div class="bz-mrow"><span>Debits · credits</span><span>${cents(d)} · ${cents(c)}</span></div>
        <div class="bz-mrow"><span>Difference</span><span>${diff ? `<span class="bz-st bad">${cents(Math.abs(diff))} ${diff > 0 ? 'more debit' : 'more credit'}</span>` : '<span class="bz-st ok">Balanced</span>'}</span></div>`;
    }
    $d('#bzMAddRow').onclick = () => addRow().acc.focus();
    addRow(); addRow(); sums();
    requestAnimationFrame(() => rows[0].acc.focus());
    function go(btn, allowOver = false) {
      showErr(m, '');
      const out = [];
      for (const [i, r] of rows.entries()) {
        const account = r.acc.get(), debit = num(r.dr.value), credit = num(r.cr.value);
        if (!account && !debit && !credit) continue;
        if (!account) return showErr(m, `Row ${i + 1}: choose the account`);
        if (r.type && !r.party?.get()) return showErr(m, `Row ${i + 1}: choose the ${r.type}`);
        const inv = r.slot.querySelector('.bz-jinv')?.value;
        out.push({ account, ...(debit ? { debit } : { credit }), ...(r.party?.get() ? { party: r.party.get() } : {}), ...(inv ? { invoice: inv } : {}) });
      }
      if (out.length < 2) return showErr(m, 'A journal needs at least two rows');
      save({ kind: 'journal', date: $d('#bzMDate').value, rows: out, reference: $d('#bzMRef').value.trim() || undefined, remarks: $d('#bzMNote').value.trim() || undefined,
        ...(allowOver ? { allow_over_limit: true } : {}), client_id: clientId }, m, btn, { onError: (e) => {
        if (!allowOver && isManager(kit) && /Credit limit crossed/.test(errText(e))) {
          $d('.bz-formerr').insertAdjacentHTML('beforeend', ' <button type="button" class="tbtn" id="bzMOver">Allow it over the limit</button>');
          $d('#bzMOver').onclick = (ev) => go(ev.currentTarget, true);
        }
      } });
    }
  }

  /** Opening balances: what each customer owed and what was owed to each supplier on the day the books started
   *  (ERPNext's Opening Invoice Creation Tool). Each row becomes one opening invoice, paid off like any other. */
  function openingDialog() {
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `<div class="wide"><div class="seg" id="bzMSide"><button type="button" data-s="customer" class="on">Customers owed us</button><button type="button" data-s="supplier">We owed suppliers</button></div></div>
      ${dateIn('bzMDate', 'Balances as on')}
      <div class="bz-lines wide" id="bzMO" role="table"><div class="bz-ln o bz-lh" role="row"><span id="bzMWho">Customer</span><span class="n">Amount (TZS)</span><span>Due</span><span>Old invoice no.</span><span></span></div></div>
      <button type="button" class="tbtn wide bz-addln" id="bzMAddO">${svg(I.plus)}Add a row</button>
      <p class="bz-note wide">No VAT and no stock: these only bring in what was owed. Each row can then be paid off with Receive payment or Pay supplier.</p>
      <div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Opening balances', sub: 'From your old books, once, when you start', icon: I.key, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save balances', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'opening';
    const $d = (s) => m.box.querySelector(s);
    let side = 'customer';
    const rows = [];
    function addRow() {
      const row = document.createElement('div');
      row.className = 'bz-ln o'; row.setAttribute('role', 'row');
      const r = { row, cid: uid() };
      r.party = makeField({ key: 'party', label: side === 'customer' ? 'Customer' : 'Supplier', type: 'link', to: side, required: true, filter: { active: true } }, null, { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true });
      row.append(r.party.el);
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Amount" inputmode="decimal"><input class="bz-in" type="date" aria-label="Due date"><input class="bz-in" aria-label="Old invoice number" placeholder="Optional"><button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      r.amt = row.querySelector('input.bz-in.n'); r.due = row.querySelector('input[type=date]'); r.no = row.querySelector('input[aria-label="Old invoice number"]');
      row.querySelector('.ibtn').onclick = () => { rows.splice(rows.indexOf(r), 1); row.remove(); };
      $d('#bzMO').append(row);
      rows.push(r);
      return r;
    }
    $d('#bzMSide').querySelectorAll('button').forEach((b) => (b.onclick = () => {
      if (b.dataset.s === side) return;
      side = b.dataset.s;
      $d('#bzMSide').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      $d('#bzMWho').textContent = side === 'customer' ? 'Customer' : 'Supplier';
      rows.splice(0).forEach((r) => r.row.remove());
      addRow();
    }));
    $d('#bzMAddO').onclick = () => addRow().party.focus();
    addRow();
    async function go(btn) {
      showErr(m, '');
      const todo = rows.filter((r) => r.party.get() || num(r.amt.value));
      if (!todo.length) return showErr(m, 'Add at least one row');
      for (const [i, r] of todo.entries()) {
        if (!r.party.get()) return showErr(m, `Row ${i + 1}: choose the ${side}`);
        if (!(num(r.amt.value) > 0)) return showErr(m, `Row ${i + 1}: enter the amount`);
      }
      await busy(btn, async () => {
        let done = 0;
        for (const r of todo) {
          const step = side === 'customer'
            ? { kind: 'sales_invoice', customer: r.party.get(), opening: true }
            : { kind: 'purchase_invoice', supplier: r.party.get(), opening: true };
          try {
            await kit.api.addStep({ ...step, amount: num(r.amt.value), date: $d('#bzMDate').value, due_date: r.due.value || undefined,
              remarks: r.no.value.trim() ? `Old invoice no. ${r.no.value.trim()}` : undefined, client_id: r.cid });
            r.row.remove(); rows.splice(rows.indexOf(r), 1); done++;
          } catch (e) { showErr(m, `${done ? `${done} saved. ` : ''}${r.party.title?.() || 'A row'}: ${errText(e)}`); reload(); return; }
        }
        kit.toast(`${done} opening balance${done === 1 ? '' : 's'} saved ✓`);
        m.close(true);
        reload();
      });
    }
  }

  return () => { alive = false; recLeave?.(); };
}
