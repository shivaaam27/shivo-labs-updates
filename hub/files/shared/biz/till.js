// The till (phase 4c, pos/blueprint/03-selling.md §3.4): a fast sale screen on our own engine. Pick the till, open a
// shift with the money in the drawer, scan or tap products, take payment in one or more ways (cash shows the change),
// close the shift by counting. Each sale is an ordinary paid sale (posted at once); the till's settings (price list,
// payment methods, whether prices and discounts may change, credit, write-off limit) are checked again by the server.
import { esc, svg, I, modal, fmt, num, qty, debounce, errText } from './ui.js';
import { makeField } from './fields.js';
import { PRINT_ICON, printDoc } from './print.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const MANAGERS = ['owner', 'manager'];
const r2 = (n) => Math.round(n * 100) / 100;
const lineRate = (l) => (l.discount ? r2(l.rate * (1 - l.discount / 100)) : l.rate);
const keep = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

/** mountTill(el, kit) → leave() */
export function mountTill(el, kit) {
  let alive = true, tills = [], till = null, shift = null, products = [], stock = new Map(), methods = [], titles = {};
  let cart = [], customer = null, pays = new Map(), credit = false, totals = null, busy = false, clientId = uid();
  let paysAuto = true;   // the payment follows the total until the cashier changes it
  let writeOff = false, codes = new Map(), invoices = [];
  const manager = MANAGERS.includes(kit.user?.role);
  const $ = (q) => el.querySelector(q);
  /** The last sale made at this till on this computer: its receipt can be printed again. */
  const lastSale = () => (till ? keep.get(`biz-last-sale-${till.id}`) : null);
  el.innerHTML = '<div class="bz-loading"><span class="bz-spin"></span></div>';

  async function load() {
    const [start, sh, run] = await Promise.all([kit.api.tillStart(), kit.api.shifts().catch(() => ({ shifts: [] })), kit.api.run({}).catch(() => null)]);
    const me = kit.user?.id;
    tills = start?.tills || [];
    products = start?.products || [];
    methods = start?.methods || [];
    titles = run?.titles || {};
    invoices = run?.invoices || [];
    stock = new Map();
    for (const b of run?.balances || []) stock.set(`${b.item} ${b.warehouse}`, b.qty);
    const shifts = sh?.shifts || [];
    // this person's till: their own open shift, else the one they used last, else the one marked theirs, else the first
    const mine = shifts.find((s) => s.mine);
    const pick = mine?.till || keep.get('biz-till') || tills.find((x) => (x.users || []).some((u) => u.user === me && u.default))?.id;
    till = tills.find((x) => x.id === pick) || tills[0] || null;
    shift = till ? shifts.find((s) => s.till === till.id) || null : null;
  }

  // ---------- painting
  function paint() {
    if (!till) {
      el.innerHTML = `<div class="bz-empty card"><span class="bz-ic big">${svg(I.sell)}</span><b>No till yet</b>
        <p>${manager ? 'Add a till: its store, prices, payment methods and who may sell there.' : 'Ask a manager to add a till for you.'}</p>
        ${manager ? '<button class="btn sm" id="bzTNew">Add a till</button>' : ''}</div>`;
      $('#bzTNew')?.addEventListener('click', () => kit.nav('n/till'));
      return;
    }
    const needShift = till.needs_shift !== false;
    const ready = !needShift || (shift && (shift.mine || manager));
    el.innerHTML = `<div class="bz-till">
      <div class="bz-tbar card">
        ${tills.length > 1 ? `<select id="bzTPick" class="bz-in" aria-label="Till">${tills.map((x) => `<option value="${esc(x.id)}"${x.id === till.id ? ' selected' : ''}>${esc(x.title || x.name)}</option>`).join('')}</select>` : `<b class="bz-tname">${esc(till.title || till.name)}</b>`}
        <span class="bz-tshift">${!needShift ? '<span class="bz-st">No shifts at this till</span>'
          : shift ? `<span class="bz-st ok">Shift ${esc(shift.id)} · ${esc(shift.userTitle)} · since ${esc(shift.time?.slice(0, 5) || '')}</span>
            <small class="bz-muted">${qty(shift.totals?.sales || 0)} sales · ${fmt(shift.totals?.grandTotal || 0)}</small>`
          : '<span class="bz-st warn">No shift open</span>'}</span>
        <span class="bz-tacts">${ready ? `<button class="tbtn" id="bzTPrint"${lastSale() ? '' : ' disabled'} title="Print the receipt of the last sale here">${svg(PRINT_ICON)}Print receipt</button>` : ''}${ready ? '<button class="tbtn" id="bzTMoney">Money in / out</button>' : ''}${needShift && !shift ? '<button class="btn sm" id="bzTOpen">Open shift</button>' : ''}
          ${needShift && shift && (shift.mine || manager) ? '<button class="tbtn" id="bzTClose">Close shift</button>' : ''}</span>
      </div>
      ${!ready ? `<div class="bz-empty card"><b>${shift ? `The open shift here is ${esc(shift.userTitle)}'s` : 'Open a shift to start selling'}</b>
        <p>${shift ? 'They or a manager close it; then you can open yours.' : 'Count the money in the drawer and enter it; at the end you count again.'}</p></div>` : `
      <div class="bz-tgrid">
        <section class="bz-tleft">
          <div class="bz-tsearch"><span class="bz-ic">${svg(I.search)}</span>
            <input id="bzTQ" class="bz-in" placeholder="Scan a barcode or type a product" autocomplete="off" aria-label="Scan or search products"></div>
          <div class="bz-tiles" id="bzTTiles"></div>
        </section>
        <section class="bz-tcart card">
          <div id="bzTCust"></div>
          <div class="bz-tlines" id="bzTLines"></div>
          <div class="bz-ttot" id="bzTTot"></div>
          <div class="bz-tpay" id="bzTPay"></div>
          <div class="bz-formerr" id="bzTErr" role="alert" hidden></div>
          <button class="btn bz-tcharge" id="bzTGo" disabled>Charge</button>
        </section>
      </div>`}
    </div>`;
    $('#bzTPick')?.addEventListener('change', async (e) => { keep.set('biz-till', e.target.value); await reload(); });
    $('#bzTOpen')?.addEventListener('click', openShift);
    $('#bzTClose')?.addEventListener('click', closeShift);
    $('#bzTMoney')?.addEventListener('click', moneyInOut);
    $('#bzTPrint')?.addEventListener('click', () => { if (lastSale()) printDoc(kit, lastSale()); });
    if (!ready) return;
    // customer: the till's walk-in customer unless another is chosen
    customer = makeField({ key: 'customer', label: 'Customer', type: 'link', to: 'customer', required: true, filter: { active: true } }, till.customer || null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => { reprice(); } });
    $('#bzTCust').append(customer.el);
    const q = $('#bzTQ');
    q.addEventListener('input', debounce(() => tiles(q.value), 120));
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); scan(q.value); } });
    $('#bzTGo').addEventListener('click', charge);
    tiles('');
    drawCart();
    requestAnimationFrame(() => q.focus());
  }

  // products offered: by name, code or barcode; out-of-stock ones left out when the till says so
  const inStore = (p) => stock.get(`${p.id} ${till.store}`) ?? 0;
  const allStores = (p) => [...stock].filter(([k]) => k.startsWith(`${p.id} `)).reduce((a, [, v]) => a + v, 0);
  const nameOf = (p) => p.short_name || p.title;
  function offered() {
    const groups = till.productGroupsAll ? new Set(till.productGroupsAll) : null;
    return products.filter((p) => (!groups || groups.has(p.group)) && !(till.hide_out_of_stock === true && p.is_stock !== false && inStore(p) <= 0));
  }
  function matches(text) {
    const t = text.trim().toLowerCase();
    if (!t) return offered().slice(0, 60);
    return offered().filter((p) => [p.title, p.short_name, p.code, ...(p.barcodes || [])].some((v) => String(v ?? '').toLowerCase().includes(t))).slice(0, 60);
  }
  function tiles(text) {
    const box = $('#bzTTiles');
    if (!box) return;
    const list = matches(text);
    box.innerHTML = list.length ? list.map((p) => `<button class="bz-tile" data-p="${esc(p.id)}"><b>${esc(nameOf(p))}</b>
      <small>${esc(p.code || '')}${p.is_stock === false ? '' : ` · ${qty(inStore(p))} here · ${qty(allStores(p))} in all`}${p.needs_manager ? ' · <span class="bz-st warn">Manager</span>' : ''}</small></button>`).join('')
      : `<p class="bz-note">No product matches “${esc(text)}”.</p>`;
    box.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => add(products.find((p) => p.id === b.dataset.p))));
  }
  // Enter in the search: an exact barcode or code adds at once; one match adds it; otherwise the tiles show the choice
  function scan(text) {
    const t = text.trim().toLowerCase();
    if (!t) return;
    const exact = offered().find((p) => String(p.code ?? '').toLowerCase() === t || (p.barcodes || []).some((b) => String(b).toLowerCase() === t));
    const list = exact ? [exact] : matches(text);
    if (list.length === 1) { add(list[0]); $('#bzTQ').value = ''; tiles(''); }
    else if (!list.length) kit.toast(`Nothing found for “${text.trim()}”`);
  }

  // ---------- the cart
  async function add(p) {
    if (!p) return;
    const same = cart.find((l) => l.item === p.id && !l.touched);
    if (same) { same.qty += 1; await priceLine(same); drawCart(); return; }
    const l = { item: p.id, name: nameOf(p), qty: 1, rate: 0, discount: 0, base: null, rule: null, touched: false };
    cart.push(l);
    await priceLine(l);
    drawCart();
  }
  // the till's price (customer's list, else the till's) and its pricing rule, as the server will check it
  async function priceLine(l) {
    try {
      const r = await kit.api.price(l.item, customer?.get() || undefined, 'sell', undefined, l.qty, till.id);
      const base = r?.price?.rate;
      l.base = base ?? null;
      l.rate = base ?? (l.rate || 0);
      l.discount = 0; l.rule = null;
      const rule = r?.rule && !r.rule.error ? r.rule : null;
      if (r?.rule?.error) l.ruleError = r.rule.error; else delete l.ruleError;
      if (rule && base !== undefined) {
        if (rule.action === 'Fixed price') l.rate = rule.value;
        else if (rule.action === 'Discount %') l.discount = rule.value;
        else l.rate = Math.max(0, base - rule.value);
        l.rule = rule.title;
      }
    } catch {}
  }
  async function reprice() { for (const l of cart) if (!l.touched) await priceLine(l); drawCart(); }
  function drawCart() {
    const box = $('#bzTLines');
    if (!box) return;
    const editRate = till.allow_rate_change !== false, editDisc = till.allow_discount_change !== false;
    if (!cart.length) { pays = new Map(); paysAuto = true; credit = false; writeOff = false; codes = new Map(); }
    box.innerHTML = cart.length ? cart.map((l, i) => `<div class="bz-tl" data-i="${i}">
      <div class="bz-tln"><b>${esc(l.name)}</b>${l.rule ? `<small class="bz-muted">Pricing rule: ${esc(l.rule)}</small>` : ''}${l.ruleError ? `<small class="bz-ferr">${esc(l.ruleError)}</small>` : ''}
        ${l.base === null && !editRate ? '<small class="bz-ferr">No price at this till</small>' : ''}</div>
      <div class="bz-tlq"><button class="ibtn" data-a="-" aria-label="One less">${svg('<path d="M5 12h14"/>')}</button>
        <input class="bz-in n" data-a="q" value="${esc(qty(l.qty))}" inputmode="decimal" aria-label="Quantity of ${esc(l.name)}">
        <button class="ibtn" data-a="+" aria-label="One more">${svg(I.plus)}</button></div>
      <input class="bz-in n" data-a="r" value="${esc(fmt(l.rate))}" inputmode="decimal" aria-label="Price of ${esc(l.name)}"${editRate ? '' : ' readonly'}>
      ${editDisc ? `<input class="bz-in n bz-tld" data-a="d" value="${l.discount ? esc(qty(l.discount)) : ''}" placeholder="% off" inputmode="decimal" aria-label="Discount % on ${esc(l.name)}">` : l.discount ? `<span class="bz-muted">${qty(l.discount)}% off</span>` : '<span></span>'}
      <span class="n bz-tla">${fmt(lineRate(l) * l.qty)}</span>
      <button class="ibtn" data-a="x" aria-label="Remove ${esc(l.name)}">${svg(I.trash)}</button></div>`).join('')
      : '<p class="bz-note">Scan or tap a product to start the sale.</p>';
    box.querySelectorAll('.bz-tl').forEach((row) => {
      const l = cart[+row.dataset.i];
      row.querySelector('[data-a="-"]').onclick = async () => { if (l.qty > 1) { l.qty -= 1; if (!l.touched) await priceLine(l); drawCart(); } };
      row.querySelector('[data-a="+"]').onclick = async () => { l.qty += 1; if (!l.touched) await priceLine(l); drawCart(); };
      row.querySelector('[data-a="x"]').onclick = () => { cart.splice(cart.indexOf(l), 1); drawCart(); };
      row.querySelector('[data-a="q"]').onchange = async (e) => { l.qty = Math.max(0, num(e.target.value)) || 1; if (!l.touched) await priceLine(l); drawCart(); };
      row.querySelector('[data-a="r"]').onchange = (e) => { l.rate = Math.max(0, num(e.target.value)); l.touched = true; l.rule = null; drawCart(); };
      const d = row.querySelector('[data-a="d"]');
      if (d) d.onchange = (e) => { l.discount = Math.min(100, Math.max(0, num(e.target.value))); l.touched = true; drawCart(); };
    });
    preview();
  }

  // ---------- totals and payment
  const linesOut = () => cart.map((l) => ({ item: l.item, qty: l.qty, rate: l.rate, ...(l.discount ? { discount: l.discount } : {}) }));
  const tillMethods = () => {
    const rows = till.methods || [];
    const ids = rows.length ? rows.map((r) => r.method) : methods.map((m) => m.id);
    return ids.map((id) => methods.find((m) => m.id === id) || { id, title: titles[id] || id }).filter(Boolean);
  };
  const defaultMethod = () => (till.methods || []).find((r) => r.default)?.method || tillMethods().find((m) => m.type === 'Cash')?.id || tillMethods()[0]?.id;
  const preview = debounce(async () => {
    totals = null;
    if (!cart.length || !customer?.get()) { drawPay(); return; }
    try { totals = await kit.api.preview({ kind: 'sales_invoice', customer: customer.get(), warehouse: till.store, lines: linesOut() }); } catch (e) { totals = { error: errText(e) }; }
    if (alive) drawPay();
  }, 150);
  function drawPay() {
    const tot = $('#bzTTot'), box = $('#bzTPay'), go = $('#bzTGo');
    if (!tot || !box) return;
    if (!totals || totals.error) {
      tot.innerHTML = totals?.error ? `<p class="bz-ferr">${esc(totals.error)}</p>` : '';
      box.innerHTML = ''; go.disabled = true; go.textContent = 'Charge'; return;
    }
    const total = totals.roundedTotal;
    tot.innerHTML = `${totals.vat ? `<div class="bz-mrow"><span>VAT</span><span>${fmt(totals.vat)}</span></div>` : ''}
      <div class="bz-mrow big"><span>Total</span><span>TZS ${fmt(total)}</span></div>`;
    if (paysAuto) pays = new Map([[[...pays.keys()][0] || defaultMethod(), total]]);
    const ms = tillMethods();
    const paid = [...pays.values()].reduce((a, b) => a + b, 0);
    const cashId = ms.find((m) => m.type === 'Cash')?.id;
    const change = paid > total && cashId && pays.has(cashId) ? r2(paid - total) : 0;
    const left = r2(total - paid);
    box.innerHTML = `<div class="bz-tmeth">${ms.map((m) => `<button type="button" class="tbtn${pays.has(m.id) ? ' on' : ''}" data-m="${esc(m.id)}">${esc(m.title || m.name)}</button>`).join('')}</div>
      ${[...pays].map(([id, a]) => { const mm = ms.find((m) => m.id === id); return `<div class="bz-tpr${mm?.type && mm.type !== 'Cash' ? ' code' : ''}"><span>${esc(mm?.title || titles[id] || id)}</span>
        ${mm?.type && mm.type !== 'Cash' ? `<input class="bz-in" data-pc="${esc(id)}" value="${esc(codes.get(id) || '')}" placeholder="Code" maxlength="60" aria-label="${esc(mm.title)} code">` : ''}
        <input class="bz-in n" data-pm="${esc(id)}" value="${esc(fmt(a))}" inputmode="decimal" aria-label="Amount paid"></div>`; }).join('')}
      ${cashId && pays.has(cashId) ? `<div class="bz-tquick">${[...new Set([total, Math.ceil(total / 1000) * 1000, Math.ceil(total / 5000) * 5000, Math.ceil(total / 10000) * 10000])]
        .map((v) => `<button type="button" class="tbtn" data-q="${v}">${fmt(v)}</button>`).join('')}</div>` : ''}
      ${change ? `<div class="bz-mrow big bz-tchg"><span>Change</span><span>TZS ${fmt(change)}</span></div>` : ''}
      ${left > 0.004 ? `<div class="bz-mrow"><span>${writeOff && canWriteOff(left) ? 'Written off' : till.allow_credit === true && credit ? 'Customer owes' : 'Still to pay'}</span><span>${fmt(left)}</span></div>
        ${canWriteOff(left) ? `<label class="bz-tcred"><input type="checkbox" id="bzTWo"${writeOff ? ' checked' : ''}> Write off the small amount left (no change coins)</label>` : ''}
        ${till.allow_credit === true ? `<label class="bz-tcred"><input type="checkbox" id="bzTCred"${credit ? ' checked' : ''}> Leave it on their account (credit)</label>` : ''}` : ''}`;
    box.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.m;
      paysAuto = false;
      if (pays.has(id) && pays.size > 1) pays.delete(id);
      else if (!pays.has(id)) pays.set(id, Math.max(0, r2(total - [...pays.values()].reduce((a, c) => a + c, 0))));
      drawPay();
    }));
    box.querySelectorAll('[data-pm]').forEach((inp) => (inp.onchange = () => { paysAuto = false; pays.set(inp.dataset.pm, Math.max(0, num(inp.value))); drawPay(); }));
    box.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => { paysAuto = false; pays.set(cashId, Number(b.dataset.q)); drawPay(); }));
    box.querySelectorAll('[data-pc]').forEach((inp) => (inp.oninput = () => codes.set(inp.dataset.pc, inp.value.trim())));
    const c = $('#bzTCred');
    if (c) c.onchange = () => { credit = c.checked; if (credit) writeOff = false; drawPay(); };
    const wo = $('#bzTWo');
    if (wo) wo.onchange = () => { writeOff = wo.checked; if (writeOff) credit = false; drawPay(); };
    const ok = left <= 0.004 || (till.allow_credit === true && credit) || (writeOff && canWriteOff(left));
    go.disabled = !ok || busy;
    go.textContent = change ? `Charge · change ${fmt(change)}` : `Charge TZS ${fmt(total)}`;
  }

  // small change the cashier may leave unpaid: the till's limit (1,000 when none is set); a manager any amount, as long
  // as something was paid
  const canWriteOff = (left) => left > 0.004 && [...pays.values()].some((a) => a > 0) && (manager || left <= (till.write_off_limit ?? 1000));
  async function charge() {
    if (busy || !cart.length) return;
    const err = $('#bzTErr');
    err.hidden = true;
    if (!customer.get()) { customer.error('Choose the customer'); return customer.focus(); }
    busy = true; $('#bzTGo').disabled = true;
    const payments = [...pays].filter(([, a]) => a > 0).map(([method, amount]) => ({ method, amount, reference: codes.get(method) || undefined }));
    const total0 = totals?.roundedTotal ?? 0, left0 = r2(total0 - payments.reduce((a, p) => a + p.amount, 0));
    try {
      const r = await kit.api.addStep({ kind: 'sales_invoice', till: till.id, customer: customer.get(), warehouse: till.store, lines: linesOut(), payments,
        ...(writeOff && canWriteOff(left0) ? { write_off: true } : {}), client_id: clientId });
      const total = totals?.roundedTotal ?? 0, paid = payments.reduce((a, p) => a + p.amount, 0);
      kit.toast(`Sale ${r?.step?.id || ''} ✓${paid > total ? ` · change ${fmt(paid - total)}` : ''}`);
      // the receipt: printed at once when the till says so (ERPNext POS print_receipt_on_order_complete), else on request
      if (r?.step?.id) {
        keep.set(`biz-last-sale-${till.id}`, r.step.id);
        const pb = $('#bzTPrint'); if (pb) pb.disabled = false;
        if (till.print_receipt === true) printDoc(kit, r.step.id, { auto: true });
      }
      // what left the store (services keep no stock)
      for (const l of cart) { const k = `${l.item} ${till.store}`; if (stock.has(k) || products.find((p) => p.id === l.item)?.is_stock !== false) stock.set(k, (stock.get(k) ?? 0) - l.qty); }
      tiles($('#bzTQ')?.value || '');
      cart = []; pays = new Map(); paysAuto = true; credit = false; writeOff = false; codes = new Map(); totals = null; clientId = uid();
      invoices = (await kit.api.run({}).catch(() => null))?.invoices || invoices;
      customer.set?.(till.customer || null, titles[till.customer]);
      await refreshShift();
      drawCart();
      $('#bzTQ')?.focus();
    } catch (e) {
      err.textContent = errText(e); err.hidden = false;
    } finally { busy = false; drawPay(); }
  }

  async function refreshShift() {
    try {
      const sh = await kit.api.shifts();
      shift = (sh?.shifts || []).find((s) => s.till === till.id) || null;
      const box = el.querySelector('.bz-tshift small');
      if (box && shift) box.textContent = `${qty(shift.totals?.sales || 0)} sales · ${fmt(shift.totals?.grandTotal || 0)}`;
    } catch {}
  }

  // ---------- money in and out at the till (counted in the shift)
  function moneyInOut() {
    const ms = tillMethods();
    const rows = till.methods || [];
    const backOk = (id) => rows.find((r) => r.method === id)?.allow_in_returns !== false;
    const body = document.createElement('form');
    body.className = 'bz-grid c1';
    body.innerHTML = `<div class="seg" id="bzTDir"><button type="button" data-d="in" class="on">Customer pays what they owe</button><button type="button" data-d="out">Pay a customer back</button></div>
      <div id="bzTWho"></div>
      <div class="bz-tpr"><span>Paid by</span><select id="bzTPm" class="bz-in">${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.title || m.name)}</option>`).join('')}</select></div>
      <div class="bz-tpr"><span>Amount</span><input class="bz-in n" id="bzTAmt" inputmode="decimal"></div>
      <div class="bz-tpr"><span>Code</span><input class="bz-in" id="bzTRef" placeholder="M-Pesa code or slip number" maxlength="60"></div>
      <p class="bz-note" id="bzTOwe"></p><div class="bz-formerr" role="alert" hidden></div>`;
    const m = modal({ title: 'Money in / out', sub: `${till.title || till.name} · counted in this shift`, icon: I.money, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', pri: true, onClick: (_, btn) => save(btn) }] });
    let dir = 'in';
    const who = makeField({ key: 'party', label: 'Customer', type: 'link', to: 'customer', required: true, filter: { active: true } }, null,
      { api: kit.api, defs: kit.defs, titleOf: kit.titleOf, onPick: () => owe() });
    body.querySelector('#bzTWho').append(who.el);
    // what they owe (oldest first) or the credit they have from returns; the payment is linked to those
    const open = () => invoices.filter((i) => i.party === who.get() && (dir === 'in' ? i.outstanding > 0.004 : i.outstanding < -0.004));
    function owe() {
      const list = who.get() ? open() : [];
      const sum = list.reduce((a, i) => a + Math.abs(i.outstanding), 0);
      body.querySelector('#bzTOwe').textContent = !who.get() ? '' : dir === 'in' ? (sum ? `They owe ${fmt(sum)} on ${list.length} invoice${list.length > 1 ? 's' : ''}.` : 'They owe nothing: the money is kept as their credit.')
        : sum ? `Credit from returns: ${fmt(sum)}.` : 'No returns with credit left.';
      if (sum && !body.querySelector('#bzTAmt').value) body.querySelector('#bzTAmt').value = fmt(sum);
    }
    body.querySelectorAll('#bzTDir button').forEach((b) => (b.onclick = () => {
      dir = b.dataset.d;
      body.querySelectorAll('#bzTDir button').forEach((x) => x.classList.toggle('on', x === b));
      [...body.querySelectorAll('#bzTPm option')].forEach((o) => { o.disabled = dir === 'out' && !backOk(o.value); });
      body.querySelector('#bzTAmt').value = '';
      owe();
    }));
    const cid = uid();
    async function save(btn) {
      const er = body.querySelector('.bz-formerr');
      er.hidden = true;
      const amount = num(body.querySelector('#bzTAmt').value);
      if (!who.get()) { who.error('Choose the customer'); return who.focus(); }
      if (!(amount > 0)) { er.textContent = 'Enter the amount'; er.hidden = false; return; }
      let left = amount;
      const allocate = open().map((i) => { const a = Math.min(Math.abs(i.outstanding), left); left = r2(left - a); return { invoice: i.step, amount: r2(a) }; }).filter((a) => a.amount > 0);
      btn.disabled = true;
      try {
        await kit.api.addStep({ kind: 'payment', till: till.id, direction: dir, party: who.get(), method: body.querySelector('#bzTPm').value, amount, allocate,
          reference: body.querySelector('#bzTRef').value.trim() || undefined, client_id: cid });
        m.close(true);
        kit.toast(dir === 'in' ? 'Payment received ✓' : 'Paid back ✓');
        invoices = (await kit.api.run({}).catch(() => null))?.invoices || invoices;
        await refreshShift();
      } catch (e) { er.textContent = errText(e); er.hidden = false; btn.disabled = false; }
    }
  }

  // ---------- shifts
  function countRows(prefill) {
    return tillMethods().map((m) => `<div class="bz-tpr"><span>${esc(m.title || m.name)}</span>
      <input class="bz-in n" data-cm="${esc(m.id)}" inputmode="decimal" value="${prefill?.[m.id] !== undefined ? esc(fmt(prefill[m.id])) : ''}" placeholder="0" aria-label="${esc(m.title || m.name)}"></div>`).join('');
  }
  const counted = (m) => [...m.box.querySelectorAll('[data-cm]')].map((i) => ({ method: i.dataset.cm, amount: num(i.value) }));
  function openShift() {
    const body = document.createElement('form');
    body.className = 'bz-grid c1';
    body.innerHTML = `<p class="bz-note">Count what is in the drawer now (the float for change). Mobile money and bank usually start at 0.</p>${countRows()}<div class="bz-formerr" role="alert" hidden></div>`;
    const m = modal({ title: `Open a shift at ${till.title || till.name}`, icon: I.sell, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Open shift', pri: true, onClick: (_, btn) => save(btn) }] });
    requestAnimationFrame(() => body.querySelector('input')?.focus());
    const cid = uid();
    async function save(btn) {
      btn.disabled = true;
      try { await kit.api.addStep({ kind: 'shift_open', till: till.id, opening: counted(m), client_id: cid }); m.close(true); kit.toast('Shift open ✓'); await reload(); }
      catch (e) { const er = body.querySelector('.bz-formerr'); er.textContent = errText(e); er.hidden = false; btn.disabled = false; }
    }
  }
  function closeShift() {
    const blind = !shift.expected;   // the server leaves expected out for a blind count
    const exp = Object.fromEntries((shift.expected || []).map((x) => [x.method, x.amount]));
    const body = document.createElement('form');
    body.className = 'bz-grid c1';
    const t = shift.totals || {};
    body.innerHTML = `<div class="bz-docview">
        <div class="bz-mrow"><span>Sales</span><span>${qty(t.sales || 0)}</span></div>
        <div class="bz-mrow"><span>Takings (total of sales)</span><span>${fmt(t.grandTotal || 0)}</span></div>
        ${t.owed ? `<div class="bz-mrow"><span>Left on customers' accounts</span><span>${fmt(t.owed)}</span></div>` : ''}
        ${t.paidOut ? `<div class="bz-mrow"><span>Paid out</span><span>${fmt(t.paidOut)}</span></div>` : ''}</div>
      <p class="bz-note">${blind ? 'Count each kind of money and enter it. The expected amounts are shown after you save.' : 'Count each kind of money; the difference shows as you type.'}</p>
      <div class="bz-lines"><div class="bz-ln c bz-lh" role="row"><span>Payment method</span>${blind ? '' : '<span class="n">Expected</span>'}<span class="n">Counted</span>${blind ? '' : '<span class="n">Difference</span>'}</div>
      ${tillMethods().map((m) => `<div class="bz-ln c${blind ? ' blind' : ''}" role="row"><span>${esc(m.title || m.name)}</span>${blind ? '' : `<span class="n">${fmt(exp[m.id] || 0)}</span>`}
        <input class="bz-in n" data-cm="${esc(m.id)}" inputmode="decimal" placeholder="0" aria-label="Counted ${esc(m.title || m.name)}">${blind ? '' : `<span class="n" data-df="${esc(m.id)}"></span>`}</div>`).join('')}</div>
      <div class="bz-formerr" role="alert" hidden></div>`;
    const m = modal({ title: `Close shift ${shift.id}`, sub: `${shift.tillTitle} · ${shift.userTitle}`, icon: I.sell, wide: true, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Close shift', pri: true, onClick: (_, btn) => save(btn) }] });
    if (!blind) body.querySelectorAll('[data-cm]').forEach((inp) => (inp.oninput = () => {
      const d = r2(num(inp.value) - (exp[inp.dataset.cm] || 0));
      body.querySelector(`[data-df="${CSS.escape(inp.dataset.cm)}"]`).innerHTML = inp.value === '' ? '' : d ? `<span class="bz-st ${d < 0 ? 'bad' : 'warn'}">${d < 0 ? '−' : '+'}${fmt(Math.abs(d))}</span>` : '<span class="bz-st ok">0</span>';
    }));
    requestAnimationFrame(() => body.querySelector('input')?.focus());
    const cid = uid();
    async function save(btn) {
      btn.disabled = true;
      try {
        const r = await kit.api.addStep({ kind: 'shift_close', shift: shift.id, counted: counted(m), client_id: cid });
        m.close(true);
        result(r.step);
        await reload();
      } catch (e) { const er = body.querySelector('.bz-formerr'); er.textContent = errText(e); er.hidden = false; btn.disabled = false; }
    }
  }
  // the close, as saved: expected, counted and the difference per payment method
  function result(s) {
    const ms = tillMethods();
    const ids = [...new Set([...s.expected.map((x) => x.method), ...s.counted.map((x) => x.method)])];
    const name = (id) => ms.find((m) => m.id === id)?.title || titles[id] || id;
    const rows = ids.map((id) => {
      const e = s.expected.find((x) => x.method === id)?.amount || 0, c = s.counted.find((x) => x.method === id)?.amount || 0, d = r2(c - e);
      return `<div class="bz-ln c" role="row"><span>${esc(name(id))}</span><span class="n">${fmt(e)}</span><span class="n">${fmt(c)}</span>
        <span class="n">${d ? `<span class="bz-st ${d < 0 ? 'bad' : 'warn'}">${d < 0 ? '−' : '+'}${fmt(Math.abs(d))}</span>` : '<span class="bz-st ok">0</span>'}</span></div>`;
    }).join('');
    modal({ title: `Shift ${s.shift} closed`, icon: I.check, wide: true, body: `<div class="bz-docview">
      <div class="bz-mrow"><span>Sales</span><span>${qty(s.totals.sales)}</span></div><div class="bz-mrow"><span>Takings</span><span>${fmt(s.totals.grandTotal)}</span></div></div>
      <div class="bz-lines"><div class="bz-ln c bz-lh" role="row"><span>Payment method</span><span class="n">Expected</span><span class="n">Counted</span><span class="n">Difference</span></div>${rows}</div>`,
      actions: [{ label: 'Done', pri: true, value: true }] });
  }

  async function reload() {
    try { await load(); } catch (e) { if (alive) el.innerHTML = `<div class="bz-empty card"><b>Could not load the till</b><p>${esc(errText(e))}</p></div>`; return; }
    cart = []; pays = new Map(); paysAuto = true; credit = false; totals = null;
    if (alive) paint();
  }
  reload();
  return () => { alive = false; };
}
