// Money screens (phase 3), one file for the Sell, Buy and Money modules: new sale (on credit or paid at the till),
// return, supplier bill, receive payment, pay supplier, move money; lists of sales, bills and payments; who owes
// us and who we owe. Documents are engine steps kept by the server (/steps); totals come from the server's own
// VAT rules (/preview), so the screen and the books always agree. Same parts as every other screen.
import { enhanceSelects } from '../select.js';
import { esc, svg, I, modal, busy, errText, fmt, qty, num, debounce, confirmBox } from './ui.js';
const cents = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
import { makeField } from './fields.js';

const ACTIONS = {
  sale: { label: 'New sale', hint: 'On credit or paid now', icon: I.sell, mod: 'sell', words: 'sale sell invoice till customer' },
  return: { label: 'Return', hint: 'Goods back from a customer', icon: I.undo, mod: 'sell', words: 'return credit note refund' },
  bill: { label: 'Supplier bill', hint: 'For goods or expenses', icon: I.arrived, mod: 'buy', words: 'bill supplier purchase invoice expense' },
  receive: { label: 'Receive payment', hint: 'From a customer', icon: I.money, mod: 'money', words: 'receive payment collect customer pays' },
  pay: { label: 'Pay supplier', hint: 'Money out to a supplier', icon: I.money, mod: 'money', words: 'pay supplier payment out' },
  move: { label: 'Move money', hint: 'Cash to bank, and back', icon: I.move, mod: 'money', words: 'move transfer deposit cash bank' },
};
export const MONEY_ACTIONS = Object.entries(ACTIONS).map(([kind, a]) => ({ kind, ...a }));
const TABS = {
  sell: [['sales', 'Sales and returns']],
  buy: [['bills', 'Supplier bills']],
  money: [['owe_us', 'Who owes us'], ['we_owe', 'Who we owe'], ['payments', 'Payments']],
};
const tzs = (n) => 'TZS ' + fmt(n);
const day = (s) => { const d = new Date(`${s}T00:00:00`); return isNaN(d) ? s || '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const STATUS_TONE = { Paid: 'ok', Return: 'ok', 'Credit Note Issued': 'ok', 'Partly Paid': 'warn', Unpaid: 'warn', Overdue: 'bad', Cancelled: '' };

/** mountMoney(el, kit, { module, action, records(el) }) → leave() */
export function mountMoney(el, kit, { module = 'money', action = null, records = null } = {}) {
  let alive = true, tab = TABS[module][0][0], steps = [], result = null, titles = {}, methods = [], stores = [];
  const rights = kit.stepRights || { read: true, write: true, undo: true };
  const acts = MONEY_ACTIONS.filter((a) => a.mod === module);
  const name = (id) => titles[id] ?? kit.titleOf?.(id) ?? id;

  el.innerHTML = `<div class="bz-stock">
    <div class="bz-quick">${acts.map((a, i) => `<button class="bz-act" data-k="${a.kind}" style="--i:${i}"${rights.write ? '' : ' disabled title="Your role can only look"'}><span class="bz-ic">${svg(a.icon)}</span><span><b>${a.label}</b><small>${a.hint}</small></span></button>`).join('')}</div>
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
  const partyType = (id) => (steps.some((s) => s.kind === 'purchase_invoice' && s.supplier === id) ? 'supplier' : 'customer');

  // ---------- painting
  function paint() {
    const v = $('#bzMView');
    if (!v) return;
    if (tab === 'sales') v.innerHTML = docTable(invoices().filter((i) => ['sales_invoice', 'credit_note'].includes(kindOf(i.step))), 'Customer', 'No sales yet. Record one with New sale.');
    else if (tab === 'bills') v.innerHTML = docTable(invoices().filter((i) => kindOf(i.step) === 'purchase_invoice'), 'Supplier', 'No supplier bills yet.');
    else if (tab === 'payments') v.innerHTML = paymentTable();
    else v.innerHTML = balanceTable(tab === 'owe_us' ? 'customer' : 'supplier');
    v.querySelectorAll('[data-doc]').forEach((r) => (r.onclick = () => showDoc(r.dataset.doc)));
    v.querySelectorAll('[data-party]').forEach((r) => (r.onclick = () => showParty(r.dataset.party, r.dataset.side)));
  }
  const rowsOrEmpty = (rows, empty) => (rows.length ? rows.join('') : `<div class="bz-empty-row">${esc(empty)}</div>`);

  function docTable(list, who, empty) {
    const rows = [...list].reverse().map((i) => {
      const s = stepOf(i.step);
      const tone = STATUS_TONE[i.status] ?? '';
      return `<button class="bz-tr" role="row" data-doc="${esc(i.step)}"><span class="bz-t1" data-l="Number">${esc(i.step)}${s?.kind === 'credit_note' ? ' <small class="bz-muted">return</small>' : ''}</span>
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
      <span data-l="What">${s.kind === 'money_transfer' ? `Moved ${esc(accName(s.from))} → ${esc(accName(s.to))}` : `${s.direction === 'in' ? 'From' : 'To'} ${esc(name(s.party))}`}</span>
      <span data-l="Account">${esc(s.kind === 'payment' ? accName(s.account) : '')}</span><span class="n" data-l="Amount">${fmt(s.amount)}</span></button>`);
    return `<section class="card bz-table" style="--cols:minmax(7rem,1fr) 7rem minmax(10rem,2fr) 8rem 8rem">
      <div class="bz-tr bz-th" role="row"><span>Number</span><span>Date</span><span>What</span><span>Account</span><span class="n">Amount</span></div>
      ${rowsOrEmpty(rows, 'No payments yet.')}</section>`;
  }
  const accName = (a) => ({ cash: 'Cash', bank: 'Bank', mobile_money: 'Mobile money' }[a] || a || '');

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
    const lines = (s.lines || []).map((l) => `<div class="bz-mrow"><span>${qty(l.qty)} × ${esc(name(l.item))}</span><span>${fmt(l.rate * l.qty)}</span></div>`).join('');
    const paidBy = (s.payments || []).map((p) => `<div class="bz-mrow"><span>Paid · ${esc(accName(p.account))}</span><span>${fmt(p.amount)}</span></div>`).join('');
    const body = `<div class="bz-docview">
      <div class="bz-mrow"><span>Date</span><span>${esc(day(s.date))}</span></div>
      ${s.customer || s.supplier || s.party ? `<div class="bz-mrow"><span>${s.supplier || s.direction === 'out' ? 'Supplier' : 'Customer'}</span><span>${esc(name(s.customer || s.supplier || s.party))}</span></div>` : ''}
      ${s.dueDate && s.kind !== 'credit_note' ? `<div class="bz-mrow"><span>Due</span><span>${esc(day(s.dueDate))}</span></div>` : ''}
      ${s.against ? `<div class="bz-mrow"><span>Returns</span><span>${esc(s.against)}</span></div>` : ''}
      ${lines ? `<hr>${lines}` : ''}
      ${inv ? `<hr><div class="bz-mrow"><span>Before VAT</span><span>${cents(inv.netTotal)}</span></div><div class="bz-mrow"><span>VAT</span><span>${cents(inv.vat)}</span></div>
        <div class="bz-mrow big"><span>Total</span><span>${tzs(inv.roundedTotal)}</span></div>${paidBy}
        <div class="bz-mrow"><span>Still owed</span><span>${fmt(inv.outstanding)}</span></div><div class="bz-mrow"><span>Status</span><span class="bz-st ${STATUS_TONE[inv.status] ?? ''}">${esc(inv.status)}</span></div>` : ''}
      ${s.kind === 'payment' ? `<hr><div class="bz-mrow"><span>${esc(accName(s.account))}</span><span>${tzs(s.amount)}</span></div>${(s.allocate || []).map((a) => `<div class="bz-mrow"><span>For ${esc(a.invoice)}</span><span>${fmt(a.amount)}</span></div>`).join('')}` : ''}
    </div>`;
    const canUndo = rights.undo && !s.undone && s.kind !== 'cancel';
    const m = modal({ title: `${s.label || s.kind} ${id}`, icon: (ACTIONS[{ sales_invoice: 'sale', credit_note: 'return', purchase_invoice: 'bill', payment: s.direction === 'out' ? 'pay' : 'receive', money_transfer: 'move' }[s.kind]] || {}).icon || I.file, body,
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
    const m = modal({ title: name(party), sub: side === 'customer' ? 'Open invoices' : 'Open bills', icon: I.money, body,
      actions: [{ label: 'Close', value: false }, ...(rights.write && open.length ? [{ label: side === 'customer' ? 'Receive payment' : 'Pay', pri: true, value: 'pay' }] : [])] });
    m.done.then((v) => { if (v === 'pay') open2(side === 'customer' ? 'receive' : 'pay', { party }); });
  }

  // ---------- dialogs
  function open(kind) { return open2(kind, {}); }
  function open2(kind, pre) {
    if (!rights.write) return kit.toast('Your role can only look');
    if (kind === 'sale' || kind === 'bill') return docDialog(kind, pre);
    if (kind === 'return') return returnDialog(pre);
    if (kind === 'receive' || kind === 'pay') return payDialog(kind, pre);
    if (kind === 'move') return moveDialog();
  }
  const methodSel = (id, label, value) => `<div class="bz-fld"><label class="bz-lbl" for="${id}">${label}</label><select id="${id}">${methods.map((m) => `<option value="${esc(m.id)}"${m.id === value ? ' selected' : ''}>${esc(m.title || m.name)}</option>`).join('')}</select></div>`;
  const storeSel = (id, label) => `<div class="bz-fld"><label class="bz-lbl" for="${id}">${label}</label><select id="${id}">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.title || s.name)}</option>`).join('')}</select></div>`;
  async function save(step, m, btn) {
    await busy(btn, async () => {
      try {
        const r = await kit.api.addStep(step);
        kit.toast(`${r?.step?.label || ACTIONS[m.kind]?.label || 'Saved'} ${r?.step?.id || ''} ✓`.trim());
        m.close(true);
        reload();
      } catch (e) { m.box.querySelector('.bz-formerr').hidden = false; m.box.querySelector('.bz-formerr').textContent = errText(e); }
    });
  }

  /** A sale (customer) or a supplier bill: who, lines, VAT, live totals; a sale may be paid now. */
  function docDialog(kind, pre) {
    const sale = kind === 'sale';
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money';
    body.noValidate = true;
    const party = makeField({ key: 'party', label: sale ? 'Customer' : 'Supplier', type: 'link', to: sale ? 'customer' : 'supplier', required: true, filter: { active: true } }, pre.party ?? null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { priceAll(); preview(); } });
    body.append(party.el);
    const receipts = sale ? [] : steps.filter((s) => s.kind === 'purchase_receipt' && !s.undone && !steps.some((b) => b.kind === 'purchase_invoice' && b.receipt === s.id && !b.undone));
    body.insertAdjacentHTML('beforeend', `
      ${sale ? storeSel('bzMStore', 'Goods leave from') : `<div class="bz-fld"><label class="bz-lbl" for="bzMRcpt">What is it for?</label><select id="bzMRcpt"><option value="">Expenses or services</option>${receipts.map((r) => `<option value="${esc(r.id)}">Goods arrived ${esc(r.id)} · ${esc(day(r.date))}</option>`).join('')}</select></div>`}
      <div class="bz-chk wide"><span class="bz-lbl">${sale ? 'Prices include VAT' : 'VAT on this bill'}</span><button type="button" class="sw${sale ? ' on' : ''}" role="switch" id="bzMVat" aria-checked="${sale}"></button></div>
      <div class="bz-lines wide" id="bzMLines" role="table"><div class="bz-ln bz-lh" role="row"><span>Product</span><span class="n">Qty</span><span class="n">Price</span><span class="n">Amount</span><span></span></div></div>
      <button type="button" class="tbtn wide bz-addln" id="bzMAdd">${svg(I.plus)}Add a product</button>
      <div class="bz-totals wide" id="bzMTot"></div>
      ${sale ? `<div class="wide"><div class="seg" id="bzMPayMode"><button type="button" data-p="credit" class="on">On credit</button><button type="button" data-p="paid">Paid now</button></div></div>
        <div class="wide" id="bzMPays" hidden></div>` : ''}
      <div class="bz-formerr wide" role="alert" hidden></div>`);
    const m = modal({ title: ACTIONS[kind].label, sub: sale ? 'Totals use your VAT setup; goods leave the store you choose' : 'Bill from a supplier', icon: ACTIONS[kind].icon, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: sale ? 'Save sale' : 'Save bill', pri: true, id: 'bzMSave', onClick: (_, btn) => go(btn) }] });
    m.kind = kind;
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    const vat = $d('#bzMVat');
    vat.onclick = () => { const on = vat.getAttribute('aria-checked') !== 'true'; vat.classList.toggle('on', on); vat.setAttribute('aria-checked', String(on)); preview(); };
    const lines = [];
    function addLine(item = null, q = 1, rate = '') {
      const row = document.createElement('div');
      row.className = 'bz-ln'; row.setAttribute('role', 'row');
      const prod = makeField({ key: 'item', label: 'Product', type: 'link', to: 'product', required: true, filter: { active: true } }, item, {
        api: kit.api, defs: kit.defs, titleOf: kit.titleOf, compact: true, onPick: () => { priceOf(line); preview(); } });
      row.append(prod.el);
      row.insertAdjacentHTML('beforeend', `<input class="bz-in n" aria-label="Quantity" inputmode="decimal" value="${esc(q)}"><input class="bz-in n" aria-label="Price" inputmode="decimal" value="${esc(rate)}"><span class="n bz-lamt"></span>
        <button type="button" class="ibtn" aria-label="Remove">${svg(I.trash)}</button>`);
      const [qi, ri] = row.querySelectorAll('input.bz-in.n');
      const line = { row, prod, qi, ri };
      qi.oninput = ri.oninput = () => preview();
      row.querySelector('.ibtn').onclick = () => { lines.splice(lines.indexOf(line), 1); row.remove(); preview(); };
      $d('#bzMLines').append(row);
      lines.push(line);
      return line;
    }
    $d('#bzMAdd').onclick = () => addLine().prod.focus();
    if (!sale) $d('#bzMRcpt').addEventListener('change', () => {
      const r = stepOf($d('#bzMRcpt').value);
      if (!r) return;
      lines.splice(0).forEach((l) => l.row.remove());
      r.lines.forEach((l) => addLine(l.item, l.qty, l.rate));
      preview();
    });
    addLine();
    queueMicrotask(() => drawTotals());   // after the rest of this dialog is set up (totals, payments)
    requestAnimationFrame(() => party.focus());

    // price from the customer's price list (or any selling list), else the product's last price; bills: buying lists
    async function priceOf(line) {
      const item = line.prod.get();
      if (!item || line.ri.value) return;
      try {
        const cust = sale && party.get() ? await kit.api.doc('customer', party.get()).then((d) => d?.doc).catch(() => null) : null;
        const rows = (await kit.api.list('item_price', { filters: { product: item }, limit: 50 }))?.rows || [];
        const lists = new Set(((await kit.api.options('price_list', '', { type: sale ? 'Selling' : 'Buying' })) || []).map((x) => x.id));
        const hit = (cust?.price_list && rows.find((r) => r.price_list === cust.price_list)) || rows.find((r) => lists.has(r.price_list));
        if (hit && !line.ri.value) { line.ri.value = fmt(hit.rate); preview(); }
      } catch {}
    }
    const priceAll = () => lines.forEach(priceOf);
    function draft() {
      const ls = lines.map((l) => ({ item: l.prod.get(), qty: num(l.qi.value), rate: num(l.ri.value) })).filter((l) => l.item);
      const base = { kind: sale ? 'sales_invoice' : 'purchase_invoice', lines: ls };
      const vatOn = vat.getAttribute('aria-checked') === 'true';
      if (sale) return { ...base, customer: party.get(), warehouse: $d('#bzMStore').value, prices_include_vat: vatOn };
      const rc = $d('#bzMRcpt').value;
      return { ...base, supplier: party.get(), vat: vatOn, prices_include_vat: false, ...(rc ? { receipt: rc } : {}) };
    }
    let totals = null, seq = 0;
    const preview = debounce(async () => {
      const d = draft();
      lines.forEach((l) => { const a = num(l.qi.value) * num(l.ri.value); l.row.querySelector('.bz-lamt').textContent = a ? fmt(a) : ''; });
      const my = ++seq;
      if (!d.lines.length || d.lines.some((l) => !(l.qty > 0) || !(l.rate >= 0)) || !(d.customer || d.supplier)) { totals = null; drawTotals(); return; }
      try { const t = await kit.api.preview(d); if (my === seq) { totals = t; drawTotals(); } } catch { if (my === seq) { totals = null; drawTotals(); } }
    }, 200);
    function drawTotals() {
      const t = totals;
      $d('#bzMTot').innerHTML = t ? `<div class="bz-mrow"><span>Before VAT</span><span>${cents(t.netTotal)}</span></div><div class="bz-mrow"><span>VAT</span><span>${cents(t.vat)}</span></div>
        <div class="bz-mrow big"><span>Total</span><span>${tzs(t.roundedTotal)}</span></div>` : '<p class="bz-note">Choose who and add products to see the total.</p>';
      if (sale) drawChange();
    }
    // paid now: one or more methods; cash above the total is change
    const pays = [];
    if (sale) {
      $d('#bzMPayMode').querySelectorAll('button').forEach((b) => (b.onclick = () => {
        $d('#bzMPayMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        $d('#bzMPays').hidden = b.dataset.p !== 'paid';
        if (b.dataset.p === 'paid' && !pays.length) addPay();
      }));
    }
    function addPay() {
      const i = pays.length;
      const row = document.createElement('div');
      row.className = 'bz-payrow';
      row.innerHTML = `${methodSel(`bzMPm${i}`, i ? 'And' : 'Paid with', methods.find((m) => m.type === 'Cash')?.id)}<div class="bz-fld"><label class="bz-lbl" for="bzMPa${i}">Amount</label><input class="bz-in n" id="bzMPa${i}" inputmode="decimal"></div>`;
      $d('#bzMPays').append(row);
      enhanceSelects(row);
      const p = { row, sel: row.querySelector('select'), amt: row.querySelector('input') };
      if (!i && totals) p.amt.value = fmt(totals.roundedTotal);
      p.amt.oninput = drawChange;
      p.sel.addEventListener('change', drawChange);
      pays.push(p);
      if (!$d('#bzMAddPay')) {
        $d('#bzMPays').insertAdjacentHTML('beforeend', '<button type="button" class="tbtn" id="bzMAddPay">+ Another method</button><p class="bz-note" id="bzMChange"></p>');
        $d('#bzMAddPay').onclick = () => { addPay(); $d('#bzMPays').append($d('#bzMAddPay'), $d('#bzMChange')); };
      }
      drawChange();
    }
    function drawChange() {
      const c = $d('#bzMChange');
      if (!c || !totals) return;
      const paid = pays.reduce((s, p) => s + num(p.amt.value), 0);
      const cash = pays.some((p) => methods.find((m) => m.id === p.sel.value)?.type === 'Cash');
      c.textContent = paid > totals.roundedTotal ? (cash ? `Change: ${tzs(paid - totals.roundedTotal)}` : 'More than the total: only cash can give change') : paid < totals.roundedTotal ? `Still owed after this: ${tzs(totals.roundedTotal - paid)}` : 'Paid in full';
    }
    function go(btn) {
      const d = draft();
      const err = $d('.bz-formerr'); err.hidden = true;
      if (!(d.customer || d.supplier)) { party.error(`Choose the ${sale ? 'customer' : 'supplier'}`); return party.focus(); }
      if (!d.lines.length) { err.hidden = false; err.textContent = 'Add at least one product'; return; }
      if (sale && !$d('#bzMPays').hidden) d.payments = pays.map((p) => ({ method: p.sel.value, amount: num(p.amt.value) })).filter((p) => p.amount > 0);
      save({ ...d, client_id: clientId }, m, btn);
    }
  }

  function returnDialog(pre) {
    const sales = invoices().filter((i) => kindOf(i.step) === 'sales_invoice' && i.status !== 'Cancelled');
    if (!sales.length) return kit.toast('No sales to return yet');
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `<div class="bz-fld wide"><label class="bz-lbl" for="bzMSale">Which sale?</label><select id="bzMSale">${[...sales].reverse().map((i) => `<option value="${esc(i.step)}"${i.step === pre.against ? ' selected' : ''}>${esc(i.step)} · ${esc(name(i.party))} · ${fmt(i.roundedTotal)}</option>`).join('')}</select></div>
      <div class="bz-lines wide" id="bzMRLines"></div>
      <div class="bz-chk wide"><span class="bz-lbl">The goods come back into the store</span><button type="button" class="sw on" role="switch" id="bzMBack" aria-checked="true"></button></div>
      <div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Return', sub: 'The customer gets credit for what comes back', icon: I.undo, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save return', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'return';
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    const back = $d('#bzMBack');
    back.onclick = () => { const on = back.getAttribute('aria-checked') !== 'true'; back.classList.toggle('on', on); back.setAttribute('aria-checked', String(on)); };
    function fill() {
      const s = stepOf($d('#bzMSale').value);
      back.disabled = !s?.updateStock;
      $d('#bzMRLines').innerHTML = `<div class="bz-ln r bz-lh" role="row"><span>Product</span><span class="n">Sold</span><span class="n">Coming back</span></div>` +
        (s?.lines || []).map((l, i) => `<div class="bz-ln r" role="row"><span>${esc(name(l.item))}</span><span class="n">${qty(l.qty)}</span><input class="bz-in n" data-i="${i}" inputmode="decimal" value="${esc(l.qty)}" aria-label="Quantity coming back"></div>`).join('');
    }
    $d('#bzMSale').addEventListener('change', fill);
    fill();
    function go(btn) {
      const s = stepOf($d('#bzMSale').value);
      const lines = [...m.box.querySelectorAll('#bzMRLines input')].map((inp) => ({ ...s.lines[+inp.dataset.i], qty: num(inp.value) })).filter((l) => l.qty > 0);
      if (!lines.length) { const e = $d('.bz-formerr'); e.hidden = false; e.textContent = 'Nothing is coming back'; return; }
      save({ kind: 'credit_note', against: s.id, lines, update_stock: !!s.updateStock && back.getAttribute('aria-checked') === 'true', client_id: clientId }, m, btn);
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
    body.insertAdjacentHTML('beforeend', `${methodSel('bzMPm', into ? 'Received by' : 'Paid by', methods.find((x) => x.type === 'Mobile money')?.id)}
      <div class="bz-fld"><label class="bz-lbl" for="bzMAmt">Amount (TZS)</label><input class="bz-in n" id="bzMAmt" inputmode="decimal"></div>
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
        ? `<div class="bz-lines"><div class="bz-ln p bz-lh" role="row"><span>Invoice</span><span>Due</span><span class="n">Owed</span><span class="n">This payment</span></div>${open.map((i, k) => `<div class="bz-ln p" role="row"><span>${esc(i.step)}</span><span>${esc(day(stepOf(i.step)?.dueDate))}</span><span class="n">${fmt(i.outstanding)}</span><input class="bz-in n" data-k="${k}" inputmode="decimal" aria-label="Amount for ${esc(i.step)}"></div>`).join('')}</div>`
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
      const err = $d('.bz-formerr'); err.hidden = true;
      if (!party.get()) { party.error(`Choose the ${into ? 'customer' : 'supplier'}`); return party.focus(); }
      if (!(amount > 0)) { err.hidden = false; err.textContent = 'Enter the amount'; return; }
      const allocate = [...m.box.querySelectorAll('#bzMOpen input')].map((inp) => ({ invoice: open[+inp.dataset.k].step, amount: num(inp.value) })).filter((a) => a.amount > 0);
      save({ kind: 'payment', direction: into ? 'in' : 'out', party: party.get(), method: $d('#bzMPm').value, amount, allocate, client_id: clientId }, m, btn);
    }
  }

  function moveDialog() {
    const clientId = uid();
    const body = document.createElement('form');
    body.className = 'bz-grid c2 bz-money'; body.noValidate = true;
    body.innerHTML = `${methodSel('bzMFrom', 'From', methods.find((x) => x.type === 'Cash')?.id)}${methodSel('bzMTo', 'To', methods.find((x) => x.type === 'Bank')?.id)}
      <div class="bz-fld"><label class="bz-lbl" for="bzMAmt">Amount (TZS)</label><input class="bz-in n" id="bzMAmt" inputmode="decimal"></div><div class="bz-formerr wide" role="alert" hidden></div>`;
    const m = modal({ title: 'Move money', sub: 'Between your own cash, bank and mobile money', icon: I.move, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', pri: true, onClick: (_, btn) => go(btn) }] });
    m.kind = 'move';
    const $d = (s) => m.box.querySelector(s);
    enhanceSelects(body);
    function go(btn) {
      const amount = num($d('#bzMAmt').value), err = $d('.bz-formerr');
      if (!(amount > 0)) { err.hidden = false; err.textContent = 'Enter the amount'; return; }
      save({ kind: 'money_transfer', from: $d('#bzMFrom').value, to: $d('#bzMTo').value, amount, client_id: clientId }, m, btn);
    }
  }

  return () => { alive = false; recLeave?.(); };
}
