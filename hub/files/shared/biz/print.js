// Printed pages (phase 4e): sales and invoices, returns, quotations, sales orders, delivery notes (with or without
// amounts), payment receipts and vouchers, journal vouchers, 58/80 mm till receipts, and (phase 5) stock requests,
// supplier quotations, purchase orders, goods received notes (refused units, with or without prices), goods returned
// to suppliers, supplier bills and debit notes. The server works out
// everything a page shows (GET /print/:id, business/store/print.ts: the engine's totals, VAT per rate, the amount in
// words, payments, change, what is still owed, instalments, letter head, terms); this file only lays it out, in
// English or Swahili (the customer's print language). A preview opens over the screen; Print uses the browser's own
// print window, with @media print in biz.css showing only the paper (A4 for documents, the roll width for receipts).
import { esc, svg, errText } from './ui.js';
import { makeField } from './fields.js';

export const PRINT_ICON = '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>';
/** The step kinds that have a printed page (store/print.ts PRINTED). */
export const PRINTABLE = new Set(['sales_invoice', 'credit_note', 'quotation', 'sales_order', 'delivery_note', 'payment', 'journal',
  'material_request', 'supplier_quotation', 'purchase_order', 'purchase_receipt', 'purchase_invoice', 'debit_note']);
const BUYING = new Set(['material_request', 'supplier_quotation', 'purchase_order', 'purchase_receipt', 'purchase_invoice', 'debit_note']);

const WORDS = {
  English: {
    invoice: 'Invoice', taxInvoice: 'Tax invoice', receipt: 'Receipt', opening: 'Opening balance', creditNote: 'Credit note', quotation: 'Quotation',
    order: 'Sales order', delivery: 'Delivery note', payIn: 'Payment receipt', payOut: 'Payment voucher', journal: 'Journal voucher',
    no: 'No.', date: 'Date', due: 'Due', validTill: 'Valid till', deliverBy: 'Deliver by', customer: 'Customer', supplier: 'Supplier', deliverTo: 'Deliver to',
    from: 'Goods from', transport: 'Transport', salesman: 'Salesman', trip: 'Trip', waybill: 'Waybill', attn: 'Attention', phone: 'Phone', email: 'Email', item: 'Product', code: 'Code', qty: 'Qty', unit: 'Unit', price: 'Price', off: 'Off',
    amount: 'Amount', linesTotal: 'Total of the lines', discount: 'Discount', discountNet: 'Discount (before VAT)', beforeVat: 'Before VAT', vat: 'VAT',
    vatIncl: 'Prices include VAT', rounding: 'Rounding', total: 'Total', totalQty: 'Total quantity', words: 'Amount in words', paid: 'Paid', change: 'Change',
    writtenOff: 'Written off', owed: 'Still owed', instalments: 'Instalments', share: 'Share', terms: 'Terms and conditions', notes: 'Notes',
    receivedBy: 'Received by', signature: 'Signature', cashier: 'Served by', till: 'Till', ref: 'Reference', returns: 'Return of', madeFrom: 'From',
    rate: 'VAT rate', net: 'Before VAT', thanks: 'Thank you', cancelled: 'CANCELLED', receivedFrom: 'Received from', paidTo: 'Paid to', method: 'Paid by',
    forInvoice: 'For', charges: 'Charges', account: 'Account', debit: 'Debit', credit: 'Credit', preparedBy: 'Prepared by', approvedBy: 'Approved by',
    exempt: 'Exempt', page: 'Page',
    purchaseOrder: 'Purchase order', supplierQuotation: 'Supplier quotation', stockRequest: 'Stock request', moveRequest: 'Stock move request',
    goodsArrived: 'Goods received note', goodsBack: 'Goods returned to supplier', bill: 'Supplier bill', debitNote: 'Debit note',
    requiredBy: 'Required by', theirNote: 'Supplier delivery note', theirBill: 'Their bill no.', theirCode: 'Their code', accepted: 'Accepted', refused: 'Refused',
    refusedTo: 'Refused goods kept in', receivedInto: 'Received into', forStore: 'For store', fromStore: 'From store', advance: 'Advance', advancePaid: 'Advance paid',
    advanceFor: 'Advance for', onHold: 'On hold until', totalRefused: 'Total refused', returnOf2: 'Goods back from', ordersBy: 'Ordered by',
  },
  Swahili: {
    invoice: 'Ankara', taxInvoice: 'Ankara ya kodi', receipt: 'Risiti', opening: 'Salio la mwanzo', creditNote: 'Hati ya marejesho', quotation: 'Nukuu ya bei',
    order: 'Agizo la mauzo', delivery: 'Hati ya uwasilishaji', payIn: 'Risiti ya malipo', payOut: 'Hati ya malipo', journal: 'Hati ya jarida',
    no: 'Na.', date: 'Tarehe', due: 'Tarehe ya kulipa', validTill: 'Inatumika hadi', deliverBy: 'Peleka kabla ya', customer: 'Mteja', supplier: 'Msambazaji',
    deliverTo: 'Peleka kwa', from: 'Mzigo kutoka', transport: 'Usafiri', salesman: 'Muuzaji', trip: 'Safari', waybill: 'Hati ya usafirishaji', attn: 'Kwa', phone: 'Simu', email: 'Barua pepe', item: 'Bidhaa', code: 'Namba', qty: 'Idadi', unit: 'Kipimo',
    price: 'Bei', off: 'Punguzo', amount: 'Kiasi', linesTotal: 'Jumla ya bidhaa', discount: 'Punguzo', discountNet: 'Punguzo (kabla ya VAT)', beforeVat: 'Kabla ya VAT',
    vat: 'VAT', vatIncl: 'Bei zinajumuisha VAT', rounding: 'Marekebisho', total: 'Jumla', totalQty: 'Jumla ya idadi', words: 'Kiasi kwa maneno', paid: 'Imelipwa',
    change: 'Chenji', writtenOff: 'Imesamehewa', owed: 'Kiasi kinachodaiwa', instalments: 'Malipo kwa awamu', share: 'Sehemu', terms: 'Masharti', notes: 'Maelezo',
    receivedBy: 'Imepokelewa na', signature: 'Sahihi', cashier: 'Mhudumu', till: 'Kaunta', ref: 'Kumbukumbu', returns: 'Marejesho ya', madeFrom: 'Kutoka',
    rate: 'Kiwango cha VAT', net: 'Kabla ya VAT', thanks: 'Asante', cancelled: 'IMEFUTWA', receivedFrom: 'Tumepokea kutoka kwa', paidTo: 'Imelipwa kwa',
    method: 'Njia ya malipo', forInvoice: 'Kwa', charges: 'Makato', account: 'Akaunti', debit: 'Debit', credit: 'Credit', preparedBy: 'Imeandaliwa na',
    approvedBy: 'Imeidhinishwa na', exempt: 'Msamaha', page: 'Ukurasa',
    purchaseOrder: 'Agizo la ununuzi', supplierQuotation: 'Nukuu ya bei ya msambazaji', stockRequest: 'Ombi la bidhaa', moveRequest: 'Ombi la kuhamisha bidhaa',
    goodsArrived: 'Hati ya kupokea bidhaa', goodsBack: 'Hati ya kurudisha bidhaa', bill: 'Ankara ya msambazaji', debitNote: 'Hati ya debiti',
    requiredBy: 'Inahitajika kabla ya', theirNote: 'Hati ya msambazaji', theirBill: 'Namba ya ankara yao', theirCode: 'Namba yao', accepted: 'Zimepokelewa', refused: 'Zimekataliwa',
    refusedTo: 'Zilizokataliwa ziko', receivedInto: 'Zimepokelewa ghala', forStore: 'Kwa ghala', fromStore: 'Kutoka ghala', advance: 'Malipo ya awali', advancePaid: 'Malipo ya awali',
    advanceFor: 'Malipo ya awali kwa', onHold: 'Imesimamishwa hadi', totalRefused: 'Jumla zilizokataliwa', returnOf2: 'Zimerudishwa kutoka', ordersBy: 'Imeagizwa na',
  },
};

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const day = (s) => { const d = new Date(`${s}T00:00:00`); return !s || isNaN(d) ? s || '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const lines = (s) => esc(s || '').replace(/\n/g, '<br>');

/** The title printed at the top when the document names no print heading of its own. */
export function titleOf(p, w = WORDS[p.language] || WORDS.English) {
  if (p.kind === 'sales_invoice') {
    if (p.opening) return w.opening;
    if (p.till) return w.receipt;
    return p.totals?.vatCharged && p.company?.vrn ? w.taxInvoice : w.invoice;
  }
  if (p.kind === 'purchase_receipt') return p.returnOf ? w.goodsBack : w.goodsArrived;
  if (p.kind === 'material_request') return p.purpose === 'transfer' ? w.moveRequest : w.stockRequest;
  return { credit_note: w.creditNote, quotation: w.quotation, sales_order: w.order, delivery_note: w.delivery, journal: w.journal,
    supplier_quotation: w.supplierQuotation, purchase_order: w.purchaseOrder, purchase_invoice: w.bill, debit_note: w.debitNote }[p.kind]
    ?? (p.payment?.direction === 'out' ? w.payOut : w.payIn);
}

/** The page's HTML: an A4 document, or a till receipt ('80 mm' / '58 mm'). opts.withoutAmount for delivery notes. */
export function printHtml(p, { paper = 'A4', withoutAmount = p.withoutAmount } = {}) {
  const w = WORDS[p.language] || WORDS.English;
  const cur = (n) => (p.settings?.hideCurrency ? '' : (p.currency || 'TZS') + ' ') + nf2.format(Number(n) || 0);
  const m2 = (n) => nf2.format(Number(n) || 0);
  const head = p.heading || titleOf(p, w);
  return paper === 'A4' ? a4(p, w, head, cur, m2, withoutAmount) : receipt(p, w, head, cur, m2, paper);
}

function companyBlock(p, w, cls) {
  const c = p.company || {};
  if (p.letterHead && p.letterHead.show_company === false) return '';
  return `<div class="${cls}"><b class="bz-pname">${esc(c.name)}</b>${c.legal_name && c.legal_name !== c.name ? `<span>${esc(c.legal_name)}</span>` : ''}
    ${c.address ? `<span>${lines(c.address)}${c.city ? `, ${esc(c.city)}` : ''}</span>` : c.city ? `<span>${esc(c.city)}</span>` : ''}
    ${c.phone || c.email ? `<span>${[c.phone && `${w.phone}: ${esc(c.phone)}`, c.email && esc(c.email)].filter(Boolean).join(' · ')}</span>` : ''}
    ${c.tin || c.vrn ? `<span>${[c.tin && `TIN: ${esc(c.tin)}`, c.vrn && `VRN: ${esc(c.vrn)}`].filter(Boolean).join(' · ')}</span>` : ''}</div>`;
}
function footerBlock(p, w) {
  const c = p.company || {};
  const bits = [p.letterHead?.footer && `<p>${lines(p.letterHead.footer)}</p>`, c.sales_contact && `<p>${esc(c.sales_contact)}</p>`,
    c.website && `<p>${esc(c.website)}</p>`, c.registration_details && `<p class="bz-preg">${lines(c.registration_details)}</p>`].filter(Boolean);
  return bits.length ? `<footer class="bz-pfoot">${bits.join('')}</footer>` : '';
}
const meta = (rows) => `<dl class="bz-pmeta">${rows.filter((r) => r && r[1]).map(([a, b]) => `<dt>${esc(a)}</dt><dd>${b}</dd>`).join('')}</dl>`;

const storeLine = (s) => `${esc(s.name)}${s.address ? `, ${lines(s.address)}` : ''}${s.phone ? ` · ${esc(s.phone)}` : ''}`;
const transportLines = (p, w) => (p.transport ? `<small>${w.transport}</small><span>${[p.transport.driver, p.transport.vehicle, p.transport.transporter].filter(Boolean).map(esc).join(' · ')}</span>
  ${p.transport.waybill ? `<span>${w.waybill}: ${esc(p.transport.waybill)}${p.transport.waybillDate ? ` · ${esc(day(p.transport.waybillDate))}` : ''}</span>` : ''}${p.transport.trip ? `<span>${w.trip}: ${esc(p.transport.trip)}</span>` : ''}` : '');

/** Buying documents: where the goods go (a purchase order: the store or the address given; goods arrived: the store
 *  they came into, where refused goods are kept, how they came), or a stock request's stores. */
function buyingSide(p, w) {
  if (p.kind === 'material_request') {
    return p.store || p.fromStore ? `<div>${p.store ? `<small>${w.forStore}</small><span>${storeLine(p.store)}</span>` : ''}
      ${p.fromStore ? `<small>${w.fromStore}</small><span>${storeLine(p.fromStore)}</span>` : ''}</div>` : '';
  }
  if (p.kind === 'purchase_order') {
    return p.shipTo || p.store ? `<div><small>${w.deliverTo}</small><span>${p.shipTo ? lines(p.shipTo) : storeLine(p.store)}</span></div>` : '';
  }
  if (p.kind === 'purchase_receipt' || (p.kind === 'purchase_invoice' && p.store)) {
    return `<div>${p.store ? `<small>${w.receivedInto}</small><span>${storeLine(p.store)}</span>` : ''}
      ${p.rejectedStore ? `<small>${w.refusedTo}</small><span>${esc(p.rejectedStore)}</span>` : ''}
      ${p.supplierNote ? `<small>${w.theirNote}</small><span>${esc(p.supplierNote)}</span>` : ''}${transportLines(p, w)}</div>`;
  }
  return '';
}

function partyBlock(p, w) {
  const x = p.party;
  if (!x) { const side = BUYING.has(p.kind) ? buyingSide(p, w) : ''; return side ? `<section class="bz-pparty">${side}<div></div></section>` : ''; }
  const who = x.type === 'supplier' ? w.supplier : p.kind === 'payment' ? (p.payment?.direction === 'out' ? w.paidTo : w.receivedFrom) : w.customer;
  const left = `<div><small>${esc(who)}</small><b>${esc(x.name)}</b>${x.address ? `<span>${lines(x.address)}</span>` : x.area ? `<span>${esc(x.area)}</span>` : ''}
    ${x.phone ? `<span>${w.phone}: ${esc(x.phone)}</span>` : ''}${x.email ? `<span>${esc(x.email)}</span>` : ''}
    ${x.tin || x.vrn ? `<span>${[x.tin && `TIN: ${esc(x.tin)}`, x.vrn && `VRN: ${esc(x.vrn)}`].filter(Boolean).join(' · ')}</span>` : ''}
    ${p.contact ? `<span>${w.attn}: ${esc(p.contact.name)}${p.contact.role ? ` (${esc(p.contact.role)})` : ''}${p.contact.phone ? ` · ${esc(p.contact.phone)}` : ''}</span>` : ''}</div>`;
  if (BUYING.has(p.kind)) return `<section class="bz-pparty">${left}${buyingSide(p, w)}</section>`;
  // where the goods go and leave from (orders, deliveries and invoices that move goods)
  const goods = ['sales_order', 'delivery_note', 'sales_invoice'].includes(p.kind) && !p.till;
  const to = p.shipTo || (p.kind === 'delivery_note' ? x.address : null);
  const right = goods && (to || p.store) ? `<div>${to ? `<small>${w.deliverTo}</small><span>${lines(to)}</span>` : ''}
    ${p.store ? `<small>${w.from}</small><span>${esc(p.store.name)}${p.store.address ? `, ${lines(p.store.address)}` : ''}</span>` : ''}
    ${p.transport ? `<small>${w.transport}</small><span>${[p.transport.driver, p.transport.vehicle, p.transport.transporter].filter(Boolean).map(esc).join(' · ')}</span>
      ${p.transport.waybill ? `<span>${w.waybill}: ${esc(p.transport.waybill)}${p.transport.waybillDate ? ` · ${esc(p.transport.waybillDate)}` : ''}</span>` : ''}${p.transport.trip ? `<span>${w.trip}: ${esc(p.transport.trip)}</span>` : ''}` : ''}
    ${p.salesman ? `<small>${w.salesman}</small><span>${esc(p.salesman)}</span>` : ''}</div>` : '';
  return `<section class="bz-pparty">${left}${right}</section>`;
}

function totalsRows(p, w, cur, m2) {
  const t = p.totals;
  const rows = [];
  if (t.discount) rows.push([w.linesTotal, m2(t.lines)], [t.linesBeforeVat ? w.discountNet : w.discount, `− ${m2(t.discount)}`]);
  if (t.vatCharged || t.vat) {
    rows.push([w.beforeVat, m2(t.netTotal)]);
    if (!(p.settings?.vatTable && p.vatTable?.length > 1)) rows.push([`${w.vat}${p.vatTable?.length === 1 ? ` ${nf3.format(p.vatTable[0].rate)}%` : ''}`, m2(t.vat)]);
    else for (const g of p.vatTable) rows.push([`${w.vat} ${nf3.format(g.rate)}%`, m2(g.vat)]);
  }
  if (t.rounding) rows.push([w.rounding, m2(t.rounding)]);
  // another currency (phase 5b): its exchange rate and the total and VAT in TZS (the books' and TRA's currency)
  const fx = p.currency && p.currency !== 'TZS' && p.exchangeRate
    ? `<tr><th>1 ${esc(p.currency)} = TZS ${nf3.format(p.exchangeRate)}</th><td>TZS ${m2(t.roundedTotal * p.exchangeRate)}</td></tr>`
      + (t.vat ? `<tr><th>${w.vat} (TZS)</th><td>TZS ${m2(t.vat * p.exchangeRate)}</td></tr>` : '') : '';
  return `<table class="bz-ptot">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${b}</td></tr>`).join('')}
    <tr class="big"><th>${w.total}</th><td>${cur(t.roundedTotal)}</td></tr>${fx}</table>`;
}

function moneyAfter(p, w, cur) {
  if (p.kind === 'purchase_order') return p.advancePaid ? `<table class="bz-ptot bz-ppaid"><tr><th>${w.advancePaid}</th><td>${cur(p.advancePaid)}</td></tr></table>` : '';
  if (p.kind !== 'sales_invoice' && p.kind !== 'purchase_invoice') return '';
  const rows = [...(p.payments || []).map((x) => [`${w.paid} · ${esc(x.method)}${x.reference ? ` <small>${esc(x.reference)}</small>` : ''}`, cur(x.amount)]),
    ...(p.advances || []).map((x) => [`${w.advance} · ${esc(x.from)}`, cur(x.amount)])];
  if (p.change) rows.push([w.change, cur(p.change)]);
  if (p.writtenOff) rows.push([w.writtenOff, cur(p.writtenOff)]);
  if (p.owed) rows.push([`${w.owed}${p.dueDate ? ` · ${w.due} ${esc(day(p.dueDate))}` : ''}`, cur(p.owed)]);
  if (p.holdUntil !== null && p.holdUntil !== undefined) rows.push([w.onHold, p.holdUntil ? esc(day(p.holdUntil)) : '—']);
  return rows.length ? `<table class="bz-ptot bz-ppaid">${rows.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join('')}</table>` : '';
}

function a4(p, w, head, cur, m2, withoutAmount) {
  const docMeta = meta([
    [w.no, esc(p.id)], [w.date, esc(day(p.date))],
    p.dueDate && (p.kind === 'sales_invoice' || p.kind === 'purchase_invoice') ? [w.due, esc(day(p.dueDate))] : null,
    p.validTill ? [w.validTill, esc(day(p.validTill))] : null, p.deliveryDate ? [w.deliverBy, esc(day(p.deliveryDate))] : null,
    p.requiredBy ? [w.requiredBy, esc(day(p.requiredBy))] : null,
    p.incoterm ? ['Incoterm', `${esc(p.incoterm)}${p.namedPlace ? ` ${esc(p.namedPlace)}` : ''}`] : null,
    p.billNo ? [w.theirBill, `${esc(p.billNo)}${p.billDate ? ` · ${esc(day(p.billDate))}` : ''}`] : null,
    p.against ? [w.returns, esc(p.against)] : null, p.returnOf ? [w.returnOf2, esc(p.returnOf)] : null,
    p.from?.length ? [w.madeFrom, esc(p.from.join(', '))] : null,
    p.reference && p.kind !== 'payment' ? [w.ref, esc(p.reference)] : null,
  ]);
  let body = '';
  if (p.kind === 'payment') body = paymentBody(p, w, cur, m2);
  else if (p.kind === 'journal') body = journalBody(p, w, cur, m2);
  else body = linesBody(p, w, cur, m2, withoutAmount);
  const sign = p.kind === 'delivery_note' || p.kind === 'purchase_receipt' || (p.kind === 'payment' && p.payment?.direction === 'in')
    ? `<div class="bz-psign"><span>${w.receivedBy}</span><span>${w.signature}</span><span>${w.date}</span></div>`
    : ['purchase_order', 'material_request'].includes(p.kind)
      ? `<div class="bz-psign"><span>${w.preparedBy}</span><span>${w.approvedBy}</span><span>${w.date}</span></div>`
    : p.kind === 'journal' || (p.kind === 'payment' && p.payment?.direction === 'out')
      ? `<div class="bz-psign"><span>${w.preparedBy}</span><span>${w.approvedBy}</span><span>${w.receivedBy}</span></div>` : '';
  return `<article class="bz-sheet a4${p.undone ? ' undone' : ''}" lang="${p.language === 'Swahili' ? 'sw' : 'en'}">
    ${p.undone ? `<div class="bz-pvoid">${w.cancelled}</div>` : ''}
    <header class="bz-ph">${companyBlock(p, w, 'bz-pco')}<div class="bz-ptitle"><h1>${esc(head)}</h1>${docMeta}</div></header>
    ${p.letterHead?.header ? `<p class="bz-plh">${lines(p.letterHead.header)}</p>` : ''}
    ${partyBlock(p, w)}
    ${body}
    ${p.terms ? `<section class="bz-pterms"><h4>${w.terms}</h4><p>${lines(p.terms)}</p></section>` : ''}
    ${p.remarks ? `<section class="bz-pterms"><h4>${w.notes}</h4><p>${lines(p.remarks)}</p></section>` : ''}
    ${sign}
    ${footerBlock(p, w)}
  </article>`;
}

function linesBody(p, w, cur, m2, withoutAmount) {
  const disc = !withoutAmount && (p.lines || []).some((l) => l.discount);
  const anyCode = (p.lines || []).some((l) => l.code);
  // buying: the supplier's own code for the product; goods arrived: units refused next to those accepted
  const theirs = (p.lines || []).some((l) => l.supplierCode);
  const refused = (p.lines || []).some((l) => l.rejected);
  const rows = (p.lines || []).map((l, i) => `<tr><td class="n">${i + 1}</td><td>${esc(l.name)}${l.vatRate === 0 && p.totals?.vatCharged ? ` <small>(${w.exempt})</small>` : ''}</td>
    ${anyCode ? `<td>${esc(l.code || '')}</td>` : ''}${theirs ? `<td>${esc(l.supplierCode || '')}</td>` : ''}<td class="n">${nf3.format(l.qty)}${l.unit ? ` <small>${esc(l.unit)}</small>` : ''}</td>
    ${refused ? `<td class="n">${l.rejected ? nf3.format(l.rejected) : ''}</td>` : ''}
    ${withoutAmount ? '' : `<td class="n">${m2(disc ? l.listRate : l.rate)}</td>${disc ? `<td class="n">${l.discount ? `${nf3.format(l.discount)}%` : ''}</td>` : ''}<td class="n">${m2(l.amount)}</td>`}</tr>`).join('');
  const table = `<table class="bz-plines"><thead><tr><th class="n">#</th><th>${w.item}</th>${anyCode ? `<th>${w.code}</th>` : ''}${theirs ? `<th>${w.theirCode}</th>` : ''}<th class="n">${refused ? w.accepted : w.qty}</th>
    ${refused ? `<th class="n">${w.refused}</th>` : ''}${withoutAmount ? '' : `<th class="n">${w.price}</th>${disc ? `<th class="n">${w.off}</th>` : ''}<th class="n">${w.amount}</th>`}</tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td></td><td>${w.totalQty}</td>${anyCode ? '<td></td>' : ''}${theirs ? '<td></td>' : ''}<td class="n">${nf3.format(p.totalQty || 0)}</td>${refused ? `<td class="n">${nf3.format(p.totalRejected || 0)}</td>` : ''}${withoutAmount ? '' : `<td></td>${disc ? '<td></td>' : ''}<td></td>`}</tr></tfoot></table>`;
  if (withoutAmount) return table;
  const t = p.totals;
  const vatTable = p.settings?.vatTable && p.vatTable?.length ? `<table class="bz-pvat"><thead><tr><th>${w.rate}</th><th class="n">${w.net}</th><th class="n">${w.vat}</th></tr></thead>
    <tbody>${p.vatTable.map((g) => `<tr><td>${g.rate ? `${nf3.format(g.rate)}%` : `0% · ${w.exempt}`}</td><td class="n">${m2(g.net)}</td><td class="n">${m2(g.vat)}</td></tr>`).join('')}</tbody></table>` : '';
  const sched = p.schedule?.length ? `<table class="bz-pvat"><thead><tr><th>${w.instalments}</th><th class="n">${w.share}</th><th class="n">${w.amount}</th></tr></thead>
    <tbody>${p.schedule.map((x) => `<tr><td>${esc(day(x.dueDate))}</td><td class="n">${nf3.format(x.portion)}%</td><td class="n">${m2(x.amount)}</td></tr>`).join('')}</tbody></table>` : '';
  return `${table}<section class="bz-psum"><div>${p.words ? `<p class="bz-pwords"><small>${w.words}</small>${esc(p.words)}</p>` : ''}
      ${t.pricesIncludeVat && !t.linesBeforeVat && t.vat ? `<p class="bz-pnote">${w.vatIncl}</p>` : ''}${vatTable}${sched}</div>
    <div>${totalsRows(p, w, cur, m2)}${moneyAfter(p, w, cur)}</div></section>`;
}

function paymentBody(p, w, cur, m2) {
  const x = p.payment || {};
  const rows = [[w.method, esc(x.method || '')], x.reference ? [w.ref, esc(x.reference)] : null,
    ...(x.allocations || []).map((a) => [`${w.forInvoice} ${esc(a.invoice)}`, m2(a.amount)]),
    ...(x.advanceFor || []).map((a) => [`${w.advanceFor} ${esc(a.order)}`, m2(a.amount)]),
    ...(x.deductions || []).map((d) => [`${w.charges} · ${esc(d.account)}`, m2(d.amount)])].filter(Boolean);
  return `<section class="bz-psum"><div>${p.words ? `<p class="bz-pwords"><small>${w.words}</small>${esc(p.words)}</p>` : ''}</div>
    <div><table class="bz-ptot">${rows.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join('')}<tr class="big"><th>${w.amount}</th><td>${cur(x.amount)}</td></tr></table></div></section>`;
}

function journalBody(p, w, cur, m2) {
  const rows = (p.rows || []).map((r) => `<tr><td>${esc(r.account)}${r.party ? ` <small>· ${esc(r.party)}</small>` : ''}${r.invoice ? ` <small>· ${esc(r.invoice)}</small>` : ''}</td>
    <td class="n">${r.debit ? m2(r.debit) : ''}</td><td class="n">${r.credit ? m2(r.credit) : ''}</td></tr>`).join('');
  return `<table class="bz-plines"><thead><tr><th>${w.account}</th><th class="n">${w.debit}</th><th class="n">${w.credit}</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td>${w.total}</td><td class="n">${m2(p.total)}</td><td class="n">${m2(p.total)}</td></tr></tfoot></table>
    ${p.words ? `<p class="bz-pwords"><small>${w.words}</small>${esc(p.words)}</p>` : ''}`;
}

/** A till receipt on a roll of paper: everything stacked, amounts on the right. */
function receipt(p, w, head, cur, m2, paper) {
  const c = p.company || {};
  const t = p.totals || {};
  const row = (a, b, cls = '') => `<div class="bz-rr${cls ? ' ' + cls : ''}"><span>${a}</span><span>${b}</span></div>`;
  const phone = p.store?.phone || c.phone;
  const items = (p.lines || []).map((l) => `<div class="bz-rl"><span>${esc(l.short || l.name)}</span>${row(`${nf3.format(l.qty)} × ${m2(l.rate)}${l.discount ? ` <small>(−${nf3.format(l.discount)}%)</small>` : ''}`, m2(l.amount))}</div>`).join('');
  const vat = t.vat ? (p.settings?.vatTable && p.vatTable?.length > 1 ? p.vatTable.map((g) => row(`${w.vat} ${nf3.format(g.rate)}%`, m2(g.vat))).join('')
    : row(`${w.vat}${p.vatTable?.length === 1 ? ` ${nf3.format(p.vatTable[0].rate)}%` : ''}`, m2(t.vat))) : '';
  return `<article class="bz-sheet roll ${paper === '58 mm' ? 'r58' : 'r80'}${p.undone ? ' undone' : ''}" lang="${p.language === 'Swahili' ? 'sw' : 'en'}">
    ${p.undone ? `<div class="bz-pvoid">${w.cancelled}</div>` : ''}
    ${p.letterHead && p.letterHead.show_company === false ? '' : `<div class="bz-rhead"><b>${esc(c.name)}</b>${c.address ? `<span>${lines(c.address)}${c.city ? `, ${esc(c.city)}` : ''}</span>` : ''}
      ${phone ? `<span>${w.phone}: ${esc(phone)}</span>` : ''}${c.tin ? `<span>TIN: ${esc(c.tin)}</span>` : ''}${c.vrn ? `<span>VRN: ${esc(c.vrn)}</span>` : ''}</div>`}
    ${p.letterHead?.header ? `<p class="bz-rcenter">${lines(p.letterHead.header)}</p>` : ''}
    <h1 class="bz-rtitle">${esc(head)}</h1>
    ${row(w.no, esc(p.id))}${row(w.date, `${esc(day(p.date))} ${esc((p.time || '').slice(0, 5))}`)}
    ${p.by ? row(w.cashier, esc(p.by)) : ''}${p.till ? row(w.till, esc(p.till.name)) : ''}
    ${p.party ? row(w.customer, esc(p.party.name)) : ''}${p.party?.tin ? row('TIN', esc(p.party.tin)) : ''}${p.party?.vrn ? row('VRN', esc(p.party.vrn)) : ''}
    <hr>${items}<hr>
    ${t.discount ? row(w.discount, `− ${m2(t.discount)}`) : ''}${t.vat ? row(w.beforeVat, m2(t.netTotal)) : ''}${vat}${t.rounding ? row(w.rounding, m2(t.rounding)) : ''}
    ${row(w.total, cur(t.roundedTotal), 'big')}
    ${(p.payments || []).map((x) => row(`${w.paid} · ${esc(x.method)}${x.reference ? ` ${esc(x.reference)}` : ''}`, m2(x.amount))).join('')}
    ${p.change ? row(w.change, m2(p.change), 'big') : ''}${p.writtenOff ? row(w.writtenOff, m2(p.writtenOff)) : ''}${p.owed ? row(w.owed, m2(p.owed)) : ''}
    ${p.words ? `<p class="bz-rcenter small">${esc(p.words)}</p>` : ''}
    ${p.terms ? `<p class="bz-rcenter small">${lines(p.terms)}</p>` : ''}
    ${p.letterHead?.footer ? `<p class="bz-rcenter small">${lines(p.letterHead.footer)}</p>` : ''}
    ${c.website ? `<p class="bz-rcenter small">${esc(c.website)}</p>` : ''}
    <p class="bz-rcenter">${w.thanks}</p>
  </article>`;
}

/** What the next document takes over from the one it is made from (an order from a quotation, a delivery or invoice
 *  from an order): letter head, terms as printed, language, contact person and where the goods go (not the heading). */
export const printFrom = (s) => ({
  ...(s.letterHead ? { letter_head: s.letterHead } : {}),
  ...(s.terms || s.termsText ? { terms: s.terms || '', terms_text: s.termsText || '' } : {}),
  ...(s.language ? { language: s.language } : {}), ...(s.contact ? { contact: s.contact } : {}), ...(s.shipTo ? { ship_to: s.shipTo } : {}),
});

// ---------- the "Printing" part of the selling forms (money.js), closed until opened

/** printOptions(kit, kind) → { el, get(), forCustomer(id) }. Print heading, letter head, terms (the company's filled in,
 *  the text editable for this document), print language and contact person (from the customer), where the goods go,
 *  "group same items" and, for a delivery ('dnote'), printing without prices. get() gives the step inputs; terms are
 *  sent only when changed here, so otherwise the server fills in the company's own (store/print.ts). */
export function printOptions(kit, kind) {
  // buying documents (buy.js: 'mr' stock request, 'sq' supplier quotation, 'po' purchase order, 'gr' goods arrived,
  // 'bill'): buying terms, the supplier's language and contact people; a stock request has neither
  const buying = ['mr', 'sq', 'po', 'gr', 'bill'].includes(kind);
  const box = document.createElement('details');
  box.className = 'bz-printopts wide';
  box.innerHTML = '<summary>Printing: heading, letter head, terms</summary><div class="bz-grid c2"></div>';
  const grid = box.querySelector('.bz-grid');
  const ctx = { api: kit.api, defs: kit.defs, titleOf: kit.titleOf };
  let termsTouched = false, customer = null;
  const put = (w, wide = false) => { if (wide) w.el.classList.add('wide'); grid.append(w.el); return w; };
  const heading = put(makeField({ key: 'print_heading', label: 'Print heading', type: 'link', to: 'print_heading',
    help: buying ? 'Empty: the usual title (Purchase order, Goods received note…).' : 'Empty: the usual title (Invoice, Quotation, Delivery note…).' }, null, ctx));
  const lh = put(makeField({ key: 'letter_head', label: 'Letter head', type: 'link', to: 'letter_head', filter: { active: true }, help: 'Empty: the company’s.' }, null, ctx));
  // language and contact person follow the customer (or supplier): redrawn when they change
  const langSlot = document.createElement('div'), contactSlot = document.createElement('div');
  langSlot.className = contactSlot.className = 'bz-slot';
  langSlot.style.display = contactSlot.style.display = 'contents';
  grid.append(langSlot, contactSlot);
  let lang = null, contact = null;
  const drawCustomer = (c) => {
    if (kind === 'mr') return;
    lang = makeField({ key: 'language', label: 'Print in', type: 'select', options: ['English', 'Swahili'], required: true }, c?.language || 'English', ctx);
    langSlot.replaceChildren(lang.el);
    const people = (c?.contacts || []).map((p) => String(p?.name || '').trim()).filter(Boolean);
    contact = people.length ? makeField({ key: 'contact', label: 'For the attention of', type: 'select', options: people, help: `One of the ${buying ? 'supplier' : 'customer'}’s contact people.` }, null, ctx) : null;
    contactSlot.replaceChildren(...(contact ? [contact.el] : []));
  };
  drawCustomer(null);
  const side = buying ? { buying: true, active: true } : { selling: true, active: true };
  const terms = put(makeField({ key: 'terms', label: 'Terms and conditions', type: 'link', to: 'terms', filter: side }, null,
    { ...ctx, onPick: () => { termsTouched = true; fillText(); }, onChange: () => { termsTouched = true; fillText(); } }));
  const ship = !buying || kind === 'po' ? put(makeField({ key: 'ship_to', label: 'Deliver to', type: 'longtext',
    help: buying ? 'Where the supplier delivers. Empty: the store’s own address.' : 'Empty: the customer’s own address.' }, null, ctx)) : null;
  const text = put(makeField({ key: 'terms_text', label: 'Terms as printed', type: 'longtext', help: 'Change them for this document only, if needed.' }, null,
    { ...ctx, onChange: () => { termsTouched = true; } }), true);
  const group = put(makeField({ key: 'group_same_items', label: 'Print the same product at the same price as one line', type: 'check' }, false, ctx), true);
  const without = kind === 'dnote' || kind === 'gr' ? put(makeField({ key: 'print_without_amount', label: 'Print without prices', type: 'check' }, false, ctx), true) : null;
  async function fillText() {
    const id = terms.get();
    if (!id) { text.set(''); return; }
    const t = await kit.api.doc('terms', id).then((x) => x?.doc).catch(() => null);
    if (terms.get() === id) text.set(t?.text || '');
  }
  // the company's terms, as the server would fill them in
  kit.api.doc('company', '').then(async (x) => {
    const id = x?.doc?.[buying ? 'buying_terms' : 'selling_terms'];
    if (!id || termsTouched) return;
    const t = await kit.api.doc('terms', id).then((r) => r?.doc).catch(() => null);
    if (t && t.active !== false && (!buying || t.buying === true) && !termsTouched) { terms.set(id, t.title || t.name); text.set(t.text || ''); }
  }).catch(() => {});
  const forParty = async (id) => {
    customer = id ? await kit.api.doc(buying ? 'supplier' : 'customer', id).then((x) => x?.doc).catch(() => null) : null;
    drawCustomer(customer);
  };
  return {
    el: box,
    forCustomer: forParty,
    forParty,
    get() {
      const o = {};
      if (heading.get()) o.print_heading = heading.get();
      if (lh.get()) o.letter_head = lh.get();
      if (lang?.get()) o.language = lang.get();
      if (contact?.get()) o.contact = contact.get();
      if (ship?.get()) o.ship_to = ship.get().trim();
      if (termsTouched) { o.terms = terms.get() || ''; o.terms_text = text.get() || ''; }
      if (group.get()) o.group_same_items = true;
      if (without?.get()) o.print_without_amount = true;
      return o;
    },
  };
}

// ---------- the preview over the screen, and the browser's print window

let openSheet = null;

/** printDoc(kit, id, { paper, auto }): load the printed page of a document and show it; auto opens the print window at once. */
export async function printDoc(kit, id, opts = {}) {
  let p;
  try { p = await kit.api.print(id); } catch (e) { kit.toast?.(errText(e)); return; }
  showSheet(p, opts);
}

function showSheet(p, { paper, auto = false } = {}) {
  openSheet?.close();
  const roll = p.kind === 'sales_invoice' && p.till && p.till.paper !== 'A4';
  let size = paper || (roll ? p.till.paper : 'A4');
  let without = !!p.withoutAmount;
  const back = document.activeElement;
  const wrap = document.createElement('div');
  wrap.id = 'bzPrint';
  wrap.className = 'bz-veil bz-printwrap';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', 'Print preview');
  const sizes = p.kind === 'sales_invoice' ? ['80 mm', '58 mm', 'A4'] : null;
  wrap.innerHTML = `<div class="bz-pbar">
      <b>${esc(p.heading || titleOf(p))} ${esc(p.id)}</b>
      ${sizes ? `<div class="seg" role="group" aria-label="Paper">${sizes.map((s) => `<button type="button" data-size="${s}" class="${s === size ? 'on' : ''}">${s === 'A4' ? 'A4' : `Receipt ${s}`}</button>`).join('')}</div>` : ''}
      ${p.kind === 'delivery_note' || p.kind === 'purchase_receipt' ? `<label class="bz-pchk"><input type="checkbox" id="bzPWithout"${without ? ' checked' : ''}> Without prices</label>` : ''}
      <span class="bz-pgrow"></span>
      <button type="button" class="btn sm" id="bzPClose">Close</button>
      <button type="button" class="btn pri sm" id="bzPGo">${svg(PRINT_ICON)}Print</button>
    </div><div class="bz-pscroll" id="bzPPage"></div>`;
  document.body.append(wrap);
  const draw = () => { wrap.querySelector('#bzPPage').innerHTML = printHtml(p, { paper: size, withoutAmount: without }); };
  draw();
  wrap.querySelectorAll('[data-size]').forEach((b) => (b.onclick = () => {
    size = b.dataset.size;
    wrap.querySelectorAll('[data-size]').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  }));
  const wo = wrap.querySelector('#bzPWithout');
  if (wo) wo.onchange = () => { without = wo.checked; draw(); };
  let done = () => {};
  const close = () => {
    done();
    wrap.remove();
    window.removeEventListener('keydown', onKey, true);
    if (openSheet === handle) openSheet = null;
    back?.focus?.();
  };
  const go = () => {
    // only the paper is printed; the page size follows the paper chosen
    const style = document.createElement('style');
    style.id = 'bzPrintPage';
    // a roll has no fixed page height: the printer's own paper size decides, the receipt is as wide as the roll
    style.textContent = size === 'A4' ? '@page{size:A4;margin:12mm}' : '@page{margin:0}';
    done();
    document.head.append(style);
    document.documentElement.classList.add('bz-printing');
    done = () => { document.documentElement.classList.remove('bz-printing'); style.remove(); window.removeEventListener('afterprint', done); done = () => {}; };
    window.addEventListener('afterprint', done);
    window.print();
  };
  // the keyboard belongs to the preview while it is open: nothing behind it (a dialog, the till, Ctrl+K) reacts
  function onKey(e) {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') {
      const f = [...wrap.querySelectorAll('button, input')].filter((x) => !x.disabled);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1]?.focus(); } else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0]?.focus(); }
    }
  }
  window.addEventListener('keydown', onKey, true);
  wrap.querySelector('#bzPClose').onclick = close;
  wrap.querySelector('#bzPGo').onclick = go;
  wrap.querySelector('#bzPGo').focus();
  const handle = { close };
  openSheet = handle;
  if (auto) setTimeout(go, 60);
  return handle;
}
