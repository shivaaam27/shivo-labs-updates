// Money screens, one file for the Sell, Buy and Money modules: new sale (on credit or paid at the till), return,
// supplier bill, receive payment, pay supplier, move money, journal, opening balances; lists of sales, bills,
// payments and journals; who owes us and who we owe. Documents are engine steps kept by the server (/steps); totals
// come from the server's own VAT and discount rules (/preview) and prices from its price rules (/price), so the
// screen and the books always agree. Same parts as every other screen.
import { enhanceSelects } from '../select.js';
import { esc, svg, I, modal, busy, errText, fmt, qty, num, debounce, confirmBox } from './ui.js';
import { makeField } from './fields.js';

const cents = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const OPENING = '__opening';   // the engine item an opening balance is booked on (store/money.ts OPENING_ITEM)

const ACTIONS = {
  sale: { label: 'New sale', hint: 'On credit or paid now', icon: I.sell, mod: 'sell', words: 'sale sell invoice till customer discount' },
  return: { label: 'Return', hint: 'Goods back from a customer', icon: I.undo, mod: 'sell', words: 'return credit note refund' },
  bill: { label: 'Supplier bill', hint: 'For goods or expenses', icon: I.arrived, mod: 'buy', words: 'bill supplier purchase invoice expense' },
  receive: { label: 'Receive payment', hint: 'From a customer', icon: I.money, mod: 'money', words: 'receive payment collect customer pays mpesa' },
  pay: { label: 'Pay supplier', hint: 'Money out to a supplier', icon: I.money, mod: 'money', words: 'pay supplier payment out' },
  move: { label: 'Move money', hint: 'Cash to bank, and back', icon: I.move, mod: 'money', words: 'move transfer deposit cash bank' },
  journal: { label: 'Journal', hint: 'Any entry between accounts', icon: I.file, mod: 'money', words: 'journal entry accounts rent salary adjust correction' },
  opening: { label: 'Opening balances', hint: 'What was owed before you started', icon: I.key, mod: 'money', words: 'opening balance old books start debtors creditors' },
};
/** The kind of document each action records (who may record it comes from the server, per kind). */
const KIND_OF = { sale: 'sales_invoice', return: 'credit_note', bill: 'purchase_invoice', receive: 'payment', pay: 'payment', move: 'money_transfer', journal: 'journal', opening: 'journal' };
export const MONEY_ACTIONS = Object.entries(ACTIONS).map(([kind, a]) => ({ kind, ...a }));
/** May this person use this money action? (Older servers without per-kind rights: the general write right.) */
export const mayDo = (kit, action) => { const r = kit.stepRights; return !r || (r.kinds ? !!r.kinds[KIND_OF[action]] : !!r.write); };
const TABS = {
  sell: [['sales', 'Sales and returns']],
  buy: [['bills', 'Supplier bills']],
  money: [['owe_us', 'Who owes us'], ['we_owe', 'Who we owe'], ['payments', 'Payments'], ['journals', 'Journals']],
};
const tzs = (n) => 'TZS ' + fmt(n);
const day = (s) => { const d = new Date(`${s}T00:00:00`); return isNaN(d) ? s || '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Dar es Salaam
const STATUS_TONE = { Paid: 'ok', Return: 'ok', 'Credit Note Issued': 'ok', 'Partly Paid': 'warn', Unpaid: 'warn', Overdue: 'bad', Cancelled: '' };
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
  let alive = true, tab = TABS[module][0][0], steps = [], result = null, titles = {}, methods = [], stores = [];
  const rights = kit.stepRights || { read: true, write: true, undo: true };
  const acts = MONEY_ACTIONS.filter((a) => a.mod === module);
  const name = (id) => (id === OPENING ? 'Opening balance' : titles[id] ?? kit.titleOf?.(id) ?? id);

  el.innerHTML = `<div class="bz-stock">
    <div class="bz-quick">${acts.map((a, i) => `<button class="bz-act" data-k="${a.kind}" style="--i:${i}"${mayDo(kit, a.kind) ? '' : ' disabled title="Your role cannot record this"'}><span class="bz-ic">${svg(a.icon)}</span><span><b>${a.label}</b><small>${a.hint}</small></span></button>`).join('')}</div>
    <div class="bz-bar"><div class="seg" id="bzMTabs" role="tablist">${TABS[module].map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
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
    const [r, run, pm, st] = await Promise.all([
      kit.api.steps(1000), kit.api.run({}),
      kit.api.list('payment_method', { limit: 100, sort: 'title' }).catch(() => ({ rows: [] })),
      kit.api.list('store', { limit: 200, sort: 'title' }).catch(() => ({ rows: [] })),
    ]);
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
  const partyType = (id) => (steps.some((s) => s.kind === 'purchase_invoice' && s.supplier === id) || steps.some((s) => s.kind === 'payment' && s.direction === 'out' && s.party === id) ? 'supplier' : 'customer');

  // ---------- painting
  function paint() {
    const v = $('#bzMView');
    if (!v) return;
    if (tab === 'sales') v.innerHTML = docTable(invoices().filter((i) => ['sales_invoice', 'credit_note'].includes(kindOf(i.step))), 'Customer', 'No sales yet. Record one with New sale.');
    else if (tab === 'bills') v.innerHTML = docTable(invoices().filter((i) => kindOf(i.step) === 'purchase_invoice'), 'Supplier', 'No supplier bills yet.');
    else if (tab === 'payments') v.innerHTML = paymentTable();
    else if (tab === 'journals') v.innerHTML = journalTable();
    else v.innerHTML = balanceTable(tab === 'owe_us' ? 'customer' : 'supplier');
    v.querySelectorAll('[data-doc]').forEach((r) => (r.onclick = () => showDoc(r.dataset.doc)));
    v.querySelectorAll('[data-party]').forEach((r) => (r.onclick = () => showParty(r.dataset.party, r.dataset.side)));
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
    const pays = steps.filter((s) => s.kind === 'payment' || s.kind === 'money_transfer');
    const rows = pays.map((s) => `<button class="bz-tr" role="row" data-doc="${esc(s.id)}"><span class="bz-t1" data-l="Number">${esc(s.id)}${s.undone ? ' <small class="bz-muted">undone</small>' : ''}</span>
      <span data-l="Date">${esc(day(s.date))}</span>
      <span data-l="What">${s.kind === 'money_transfer' ? `Moved ${esc(accName(s.from))} → ${esc(accName(s.to))}` : `${s.direction === 'in' ? 'From' : 'To'} ${esc(name(s.party))}`}${s.reference ? ` <small class="bz-muted">· ${esc(s.reference)}</small>` : ''}</span>
      <span data-l="Account">${esc(s.kind === 'payment' ? accName(s.account) : '')}</span><span class="n" data-l="Amount">${fmt(s.amount)}</span></button>`);
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
    const inv = invoices().find((i) => i.step === id);
    const row = (a, b) => `<div class="bz-mrow"><span>${a}</span><span>${b}</span></div>`;
    const lines = (s.lines || []).map((l) => row(l.item === OPENING ? 'Opening balance' : `${qty(l.qty)} × ${esc(name(l.item))}${l.discount ? ` <small class="bz-muted">${qty(l.discount)}% off ${fmt(l.rate)}</small>` : ''}`, fmt(lineRate(l) * l.qty))).join('');
    const paidBy = (s.payments || []).map((p) => row(`Paid · ${esc(accName(p.account))}`, fmt(p.amount))).join('');
    const jrows = (s.rows || []).map((r) => row(`${esc(name(r.account) || r.role)}${r.party ? ` · ${esc(name(r.party))}` : ''}`, r.debit ? `Dr ${fmt(r.debit)}` : `Cr ${fmt(r.credit)}`)).join('');
    const body = `<div class="bz-docview">
      ${row('Date', esc(day(s.date)))}
      ${s.customer || s.supplier || s.party ? row(s.supplier || s.direction === 'out' ? 'Supplier' : 'Customer', esc(name(s.customer || s.supplier || s.party))) : ''}
      ${s.billNo ? row('Their bill number', `${esc(s.billNo)}${s.billDate ? ` · ${esc(day(s.billDate))}` : ''}`) : ''}
      ${s.dueDate && s.kind !== 'credit_note' ? row('Due', esc(day(s.dueDate))) : ''}
      ${s.against ? row('Returns', `${esc(s.against)}${s.reduceInvoice ? ' · taken off that sale' : ' · kept as credit'}`) : ''}
      ${s.reference ? row('Reference', esc(s.reference)) : ''}
      ${lines ? `<hr>${lines}` : ''}${jrows ? `<hr>${jrows}` : ''}
      ${inv ? `<hr>${s.discountAmount ? row('Discount on the whole', `− ${fmt(s.discountAmount)}`) : ''}${row('Before VAT', cents(inv.netTotal))}${row('VAT', cents(inv.vat))}
        <div class="bz-mrow big"><span>Total</span><span>${tzs(inv.roundedTotal)}</span></div>${paidBy}${s.writeOff ? row('Small amount written off', 'yes') : ''}
        ${row('Still owed', fmt(inv.outstanding))}${row('Status', `<span class="bz-st ${STATUS_TONE[inv.status] ?? ''}">${esc(inv.status)}</span>`)}` : ''}
      ${s.kind === 'payment' ? `<hr>${row(esc(accName(s.account)), tzs(s.amount))}${(s.allocate || []).map((a) => row(`For ${esc(a.invoice)}`, fmt(a.amount))).join('')}` : ''}
      ${s.remarks ? `<hr><p class="bz-note">${esc(s.remarks)}</p>` : ''}
    </div>`;
    const canUndo = rights.undo && !s.undone && s.kind !== 'cancel';
    const act = s.opening ? 'opening' : { sales_invoice: 'sale', credit_note: 'return', purchase_invoice: 'bill', payment: s.direction === 'out' ? 'pay' : 'receive', money_transfer: 'move', journal: 'journal' }[s.kind];
    const m = modal({ title: `${s.label || s.kind} ${id}`, icon: (ACTIONS[act] || {}).icon || I.file, body,
      actions: [...(canUndo ? [{ label: 'Undo', danger: true, value: 'undo' }] : []), { label: 'Close', pri: true, value: false }] });
    m.done.then(async (v) => {
      if (v !== 'undo') return;
      if (!(await confirmBox({ title: `Undo ${id}?`, text: 'It stays in the history, marked undone; its money and stock are taken back.', ok: 'Undo', danger: true }))) return;
      try { await kit.api.undoStep(id); kit.toast('Undone ✓'); reload(); } catch (e) { kit.toast(errText(e)); }
    });
  }

  function showParty(party, side) {
    const open = openOf(party);
    const body = `<div class="bz-docview">${open.length ? open.map((i) => `<div class="bz-mrow"><span>${esc(i.step)} · due ${esc(day(stepOf(i.step)?.dueDate))} <span class="bz-st ${STATUS_TONE[i.status] ?? ''}">${esc(i.status)}</span></span><span>${fmt(i.outstanding)}</span></div>`).join('') : '<p class="bz-note">No open invoices.</p>'}</div>`;
    const act = side === 'customer' ? 'receive' : 'pay';
    const m = modal({ title: name(party), sub: side === 'customer' ? 'Open invoices' : 'Open bills', icon: I.money, body,
      actions: [{ label: 'Close', value: false }, ...(mayDo(kit, act) && open.length ? [{ label: side === 'customer' ? 'Receive payment' : 'Pay', pri: true, value: 'pay' }] : [])] });
    m.done.then((v) => { if (v === 'pay') open2(act, { party }); });
  }

  // ---------- dialogs
  function open(kind) { return open2(kind, {}); }
  function open2(kind, pre) {
    if (!mayDo(kit, kind)) return kit.toast('Your role cannot record this');
    if (kind === 'sale' || kind === 'bill') return docDialog(kind, pre);
    if (kind === 'return') return returnDialog(pre);
    if (kind === 'receive' || kind === 'pay') return payDialog(kind, pre);
    if (kind === 'move') return moveDialog();
    if (kind === 'journal') return journalDialog();
    if (kind === 'opening') return openingDialog();
  }
  const methodSel = (id, label, value) => field(id, label, `<select id="${id}">${methods.map((m) => `<option value="${esc(m.id)}"${m.id === value ? ' selected' : ''}>${esc(m.title || m.name)}</option>`).join('')}</select>`);
  const storeSel = (id, label) => field(id, label, `<select id="${id}">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.title || s.name)}</option>`).join('')}</select>`);
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
    const sale = kind === 'sale';
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money';
    body.noValidate = true;
    const party = makeField({ key: 'party', label: sale ? 'Customer' : 'Supplier', type: 'link', to: sale ? 'customer' : 'supplier', required: true, filter: { active: true } }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { priceAll(true); preview(); } });
    body.append(party.el);
    const receipts = sale ? [] : steps.filter((s) => s.kind === 'purchase_receipt' && !s.undone && !steps.some((b) => b.kind === 'purchase_invoice' && b.receipt === s.id && !b.undone));
    body.insertAdjacentHTML('beforeend', `
      ${dateIn('bzMDate')}
      ${sale ? storeSel('bzMStore', 'Goods leave from') : field('bzMRcpt', 'What is it for?', `<select id="bzMRcpt"><option value="">Services, or goods still to arrive</option><option value="now">Goods arriving with this bill</option>${receipts.map((r) => `<option value="${esc(r.id)}">Goods arrived ${esc(r.id)} · ${esc(day(r.date))}</option>`).join('')}</select>`)}
      ${sale ? '' : `<div id="bzMStoreWrap" hidden>${storeSel('bzMStore', 'Goods go into')}</div>`}
      ${sale ? '' : `${textIn('bzMBillNo', 'Their bill number', '', 'As printed on the bill')}${dateIn('bzMBillDate', 'Their bill date', '')}`}
      ${sw('bzMVat', sale ? 'Prices include VAT' : 'VAT on this bill', sale, sale ? 'wide' : '')}
      ${sale ? '' : sw('bzMIncl', 'Bill prices include VAT', false, '')}
      <div class="bz-lines wide" id="bzMLines" role="table"><div class="bz-ln bz-lh" role="row"><span>Product</span><span class="n">Qty</span><span class="n">Price</span><span class="n">Off %</span><span class="n">Amount</span><span></span></div></div>
      <button type="button" class="tbtn wide bz-addln" id="bzMAdd">${svg(I.plus)}Add a product</button>
      ${field('bzMDisc', `Discount on the whole ${sale ? 'sale' : 'bill'} (TZS)`, '<input class="bz-in n" id="bzMDisc" inputmode="decimal" placeholder="0">')}
      ${textIn('bzMNote', 'Note', '', sale ? 'e.g. their order number' : '')}
      <div class="bz-totals wide" id="bzMTot"></div>
      ${sale ? `<div class="wide"><div class="seg" id="bzMPayMode"><button type="button" data-p="credit" class="on">On credit</button><button type="button" data-p="paid">Paid now</button></div></div>
        <div class="wide" id="bzMPays" hidden></div>` : ''}
      <div class="bz-formerr wide" role="alert" hidden></div>`);
    const m = modal({ title: ACTIONS[kind].label, sub: sale ? 'Totals use your VAT setup; goods leave the store you choose' : 'Bill from a supplier', icon: ACTIONS[kind].icon, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: sale ? 'Save sale' : 'Save bill', pri: true, id: 'bzMSave', onClick: (_, btn) => go(btn) }] });
    m.kind = kind;
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    const vatOn = wireSwitch($d('#bzMVat'), (on) => { if (!sale) $d('#bzMIncl').disabled = !on; preview(); });
    const inclOn = sale ? vatOn : wireSwitch($d('#bzMIncl'), () => preview());
    if (!sale) $d('#bzMIncl').disabled = true;
    $d('#bzMDisc').oninput = () => preview();
    $d('#bzMDate').onchange = () => { priceAll(true); preview(); };
    const lines = [];
    function addLine(item = null, q = 1, rate = '', disc = '') {
      const row = document.createElement('div');
      row.className = 'bz-ln'; row.setAttribute('role', 'row');
      const prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: sale ? { active: true, can_sell: true } : { active: true, can_buy: true } }, item, {
        api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => { line.ri.value = ''; priceOf(line); preview(); } });
      row.append(prod.el);
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Quantity" inputmode="decimal" value="${esc(q)}"><input class="bz-in n" aria-label="Price" inputmode="decimal" value="${esc(rate)}"><input class="bz-in n" aria-label="Discount %" inputmode="decimal" value="${esc(disc)}" placeholder="0"><span class="n bz-lamt"></span>
        <button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      const [qi, ri, di] = row.querySelectorAll('input.bz-in.n');
      const line = { row, prod, qi, ri, di, auto: false };
      qi.oninput = di.oninput = () => preview();
      ri.oninput = () => { line.auto = false; preview(); };
      row.querySelector('.ibtn').onclick = () => { lines.splice(lines.indexOf(line), 1); row.remove(); preview(); };
      $d('#bzMLines').append(row);
      lines.push(line);
      return line;
    }
    $d('#bzMAdd').onclick = () => addLine().prod.focus();
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
      if (!item || (line.ri.value && !(refresh && line.auto))) return;
      try {
        const r = await kit.api.price(item, party.get() || undefined, sale ? 'sell' : 'buy', $d('#bzMDate').value || undefined);
        if (r?.price && (!line.ri.value || line.auto)) { line.ri.value = fmt(r.price.rate); line.auto = true; preview(); }
      } catch {}
    }
    const priceAll = (refresh) => lines.forEach((l) => priceOf(l, refresh));
    function draft() {
      const ls = lines.map((l) => ({ item: l.prod.get(), qty: num(l.qi.value), rate: num(l.ri.value), ...(num(l.di.value) ? { discount: num(l.di.value) } : {}) })).filter((l) => l.item);
      const base = { kind: sale ? 'sales_invoice' : 'purchase_invoice', lines: ls, date: $d('#bzMDate').value, discount_amount: num($d('#bzMDisc').value) || undefined, remarks: $d('#bzMNote').value.trim() || undefined };
      if (sale) return { ...base, customer: party.get(), warehouse: $d('#bzMStore').value, prices_include_vat: vatOn() };
      const rc = $d('#bzMRcpt').value;
      return { ...base, supplier: party.get(), vat: vatOn(), prices_include_vat: vatOn() && inclOn(), bill_no: $d('#bzMBillNo').value.trim() || undefined, bill_date: $d('#bzMBillDate').value || undefined,
        ...(rc === 'now' ? { update_stock: true, warehouse: $d('#bzMStore').value } : rc ? { receipt: rc } : {}) };
    }
    let totals = null, seq = 0;
    const preview = debounce(async () => {
      const d = draft();
      lines.forEach((l) => { const a = num(l.qi.value) * lineRate({ rate: num(l.ri.value), discount: num(l.di.value) }); l.row.querySelector('.bz-lamt').textContent = a ? fmt(a) : ''; });
      const my = ++seq;
      if (!d.lines.length || d.lines.some((l) => !(l.qty > 0) || !(l.rate >= 0)) || !(d.customer || d.supplier)) { totals = null; drawTotals(); return; }
      try { const t = await kit.api.preview(d); if (my === seq) { totals = t; drawTotals(); } } catch (e) { if (my === seq) { totals = null; drawTotals(errText(e)); } }
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
      if (sale) drawChange();
    }
    // paid now: one or more methods; cash above the total is change; a small amount short can be written off
    const pays = [];
    const paidNow = () => (sale && !$d('#bzMPays').hidden ? pays.reduce((s, p) => s + num(p.amt.value), 0) : 0);
    if (sale) {
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
      row.innerHTML = `${methodSel(`bzMPm${i}`, i ? 'And' : 'Paid with', methods.find((m) => m.type === 'Cash')?.id)}${field(`bzMPa${i}`, 'Amount', `<input class="bz-in n" id="bzMPa${i}" inputmode="decimal">`)}`;
      $d('#bzMPays').append(row);
      enhanceSelects(row);
      const p = { row, sel: row.querySelector('select'), amt: row.querySelector('input') };
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
      if (sale && !$d('#bzMPays').hidden) {
        d.payments = pays.map((p) => ({ method: p.sel.value, amount: num(p.amt.value) })).filter((p) => p.amount > 0);
        if (writeOff() && !$d('#bzMWo').hidden) d.write_off = true;
      }
      if (allowOver) d.allow_over_limit = true;
      save({ ...d, client_id: clientId }, m, btn, {
        onError: (e) => {
          // over the credit limit: a manager may allow it on purpose
          if (sale && !allowOver && isManager(kit) && /Credit limit crossed/.test(errText(e))) {
            const err = $d('.bz-formerr');
            err.insertAdjacentHTML('beforeend', ' <button type="button" class="tbtn" id="bzMOver">Allow this sale over the limit</button>');
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
      <div class="wide" id="bzMOpen"></div><div class="bz-formerr wide" role="alert" hidden></div>`);
    const m = modal({ title: ACTIONS[kind].label, sub: 'It settles the oldest invoices first; what is left stays as credit', icon: ACTIONS[kind].icon, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save payment', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = kind;
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    $d('#bzMAmt').oninput = () => spread();
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
      let left = num($d('#bzMAmt').value);
      m.box.querySelectorAll('#bzMOpen input').forEach((inp) => { const o = open[+inp.dataset.k].outstanding; const a = Math.min(o, Math.max(0, left)); inp.value = a ? fmt(a) : ''; left -= a; });
    }
    drawOpen(true);
    function go(btn) {
      const amount = num($d('#bzMAmt').value);
      showErr(m, '');
      if (!party.get()) { party.error(`Choose the ${into ? 'customer' : 'supplier'}`); return party.focus(); }
      if (!(amount > 0)) return showErr(m, 'Enter the amount');
      const allocate = [...m.box.querySelectorAll('#bzMOpen input')].map((inp) => ({ invoice: open[+inp.dataset.k].step, amount: num(inp.value) })).filter((a) => a.amount > 0);
      save({ kind: 'payment', direction: into ? 'in' : 'out', party: party.get(), method: $d('#bzMPm').value, amount, allocate, date: $d('#bzMDate').value,
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
      r.party = makeField({ key: 'party', label: t === 'customer' ? 'Customer' : 'Supplier', type: 'link', to: t, required: true }, null, { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true });
      r.slot.append(r.party.el);
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
    function go(btn) {
      showErr(m, '');
      const out = [];
      for (const [i, r] of rows.entries()) {
        const account = r.acc.get(), debit = num(r.dr.value), credit = num(r.cr.value);
        if (!account && !debit && !credit) continue;
        if (!account) return showErr(m, `Row ${i + 1}: choose the account`);
        if (r.type && !r.party?.get()) return showErr(m, `Row ${i + 1}: choose the ${r.type}`);
        out.push({ account, ...(debit ? { debit } : { credit }), ...(r.party?.get() ? { party: r.party.get() } : {}) });
      }
      if (out.length < 2) return showErr(m, 'A journal needs at least two rows');
      save({ kind: 'journal', date: $d('#bzMDate').value, rows: out, reference: $d('#bzMRef').value.trim() || undefined, remarks: $d('#bzMNote').value.trim() || undefined, client_id: clientId }, m, btn);
    }
  }

  /** Opening balances: what each customer owed and what was owed to each supplier on the day the books started
   *  (ERPNext's Opening Invoice Creation Tool). Each row becomes one opening invoice, paid off like any other. */
  function openingDialog() {
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `<div class="wide"><div class="seg" id="bzMSide"><button type="button" data-s="customer" class="on">Customers owed us</button><button type="button" data-s="supplier">We owed suppliers</button></div></div>
      ${dateIn('bzMDate', 'Balances as on')}
      <div class="bz-lines wide" id="bzMO" role="table"><div class="bz-ln o bz-lh" role="row"><span id="bzMWho">Customer</span><span class="n">Amount (TZS)</span><span>Due</span><span></span></div></div>
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
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Amount" inputmode="decimal"><input class="bz-in" type="date" aria-label="Due date"><button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      r.amt = row.querySelector('input.bz-in.n'); r.due = row.querySelector('input[type=date]');
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
            await kit.api.addStep({ ...step, amount: num(r.amt.value), date: $d('#bzMDate').value, due_date: r.due.value || undefined, client_id: r.cid });
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
