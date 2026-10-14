// Money documents on the database (phase 3): sales and purchase invoices, payments, credit notes, transfers between
// own accounts, journals and opening balances. Like stock movements they are engine steps (core/contract.ts
// MoneyStep) kept in the steps table: the screen sends what was sold or paid, to whom and how; this file checks it
// against the records (customer and its group, products, payment methods, accounts, the company's VAT) and gives the
// engine ids and amounts it can trust.
import type { AccountRole, MoneyAccount, MoneyLine, Scenario, Step, TaxSpec } from '../core/contract.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { lineSources, salesmanOf } from './sell.ts';
import { buySources, checkBuyRate } from './buy.ts';
import { partyFx } from './fx.ts';

const bad = (message: string): never => fail(422, message);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };

/** The engine item every opening balance is booked on (never stock, never on a product list). */
export const OPENING_ITEM = '__opening';

/** Roles that may sell over a customer's credit limit, write off any amount and bring in opening balances. */
const MANAGERS = new Set(['owner', 'manager']);
const OPENING_ROLES = new Set(['owner', 'manager', 'accountant']);
/** What anyone at the till may write off (small change); managers any amount. */
export const TILL_WRITE_OFF = 1000;

export function record(db: DB, type: string, id: unknown, what: string): { id: string; data: Data; title: string } {
  if (typeof id !== 'string' || !id) bad(`Choose the ${what}`);
  const r = db.prepare('SELECT data, title FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id as string) as { data: string; title: string } | undefined;
  if (!r) bad(`That ${what} does not exist (it may have been deleted)`);
  const data = parse(r!.data);
  if (data.active === false) bad(`${r!.title} is not active`);
  return { id: id as string, data, title: r!.title };
}
function dataOf(db: DB, type: string, id: unknown): Data | null {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare('SELECT data FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
}
const given = (v: unknown) => v !== undefined && v !== null && v !== '';

/** The company's VAT rate: the first active VAT in Setup that is not waiting for TRA's confirmation (the 16 %
 *  electronic-payment rate stays unused until it is cleared, as Setup promises). null: no VAT is set up (a business
 *  not registered for VAT sells without it). */
export function vatRate(db: DB): number | null {
  const rows = db.prepare("SELECT data FROM docs WHERE type = 'tax' AND deleted = 0 ORDER BY rowid").all() as { data: string }[];
  for (const r of rows) {
    const d = parse(r.data);
    if (d.active !== false && d.type !== 'Withholding' && d.to_confirm !== true && Number.isFinite(Number(d.rate))) return Number(d.rate);
  }
  return null;
}

/** Payment method -> the kind of account the engine books it to (cards are paid into the bank) and the method's own
 *  account of the chart (store/books.ts puts the money there, so M-Pesa and Airtel Money keep separate balances). */
function methodOf(db: DB, method: unknown): { account: MoneyAccount; ref?: string } {
  const m = record(db, 'payment_method', method, 'payment method');
  const t = String(m.data.type ?? 'Cash');
  const account: MoneyAccount = t === 'Mobile money' ? 'mobile_money' : t === 'Cash' ? 'cash' : 'bank';
  return typeof m.data.account === 'string' && m.data.account ? { account, ref: m.data.account } : { account };
}

/** One of our accounts that a document may post to directly (a leaf, active); `root` limits its main group. */
function postable(db: DB, id: unknown, what: string, root?: string): { id: string; data: Data; title: string } {
  const a = record(db, 'account', id, what);
  if (a.data.is_group === true) bad(`${a.title} is a group; choose an account under it`);
  if (root && a.data.root_type !== root) bad(`${a.title} is not an ${root.toLowerCase()} account`);
  return a;
}

function amount(v: unknown, what: string, zeroOk = false): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!zeroOk && n === 0)) bad(`${what} must be ${zeroOk ? '0 or more' : 'above 0'}`);
  if (n > 1e12) bad(`${what} is too big`);
  return Math.round(n * 100) / 100;
}

export function text(v: unknown, what: string, max = 500): string | undefined {
  if (!given(v)) return undefined;
  const s = String(v).trim();
  if (s.length > max) bad(`${what}: at most ${max} characters`);
  return s || undefined;
}

function realDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
export function dateOf(v: unknown, what: string): string | undefined {
  if (!given(v)) return undefined;
  const s = String(v);
  if (!realDate(s)) bad(`${what} must be a real date like 2026-10-13`);
  return s;
}

function moneyLines(db: DB, input: unknown, side: 'sell' | 'buy'): MoneyLine[] {
  const lines = moneyLinesOnly(db, input, side);
  if (side === 'buy') (input as Data[]).forEach((l, i) => {
    const p = dataOf(db, 'product', l.item);
    const acc = given(l.account) ? l.account : p?.is_stock === false ? p?.expense_account : undefined;
    if (given(acc)) lines[i].account = postable(db, acc, `expense account on line ${i + 1}`, 'Expense').id;
  });
  return lines;
}

/** Lines of a buying document: bought products (`buying`), or any product (a request to move stock between stores);
 *  a request may leave the price empty (0). */
export function cleanBuyLines(db: DB, input: unknown, buying: boolean): MoneyLine[] {
  const rows = Array.isArray(input) ? (input as Data[]).map((l) => (l && typeof l === 'object' && !given(l.rate) ? { ...l, rate: 0 } : l)) : input;
  return buying ? moneyLines(db, rows, 'buy') : moneyLinesOnly(db, rows, 'any');
}
/** VAT on a buying document: only when asked for (a supplier's bill shows it), at the company's rate. */
export function buyTax(db: DB, input: Data): TaxSpec | undefined {
  const rate = vatRate(db);
  return input.vat === true && rate !== null ? { rate, inclusive: input.prices_include_vat === true } : undefined;
}
/** A supplier's payment terms as instalments (theirs, their group's, the company's). */
export const scheduleFor = (db: DB, input: Data, supplier: Data, date: string) => scheduleOf(db, input, supplier, 'supplier_group', date);

function moneyLinesOnly(db: DB, input: unknown, side: 'sell' | 'buy' | 'any'): MoneyLine[] {
  if (!Array.isArray(input) || !input.length) bad('Add at least one product');
  if ((input as unknown[]).length > 500) bad('At most 500 lines in one document');
  return (input as Data[]).map((l, i) => {
    if (!l || typeof l !== 'object') bad(`Line ${i + 1} is empty`);
    const p = record(db, 'product', l.item, 'product');
    if (side === 'sell' && p.data.can_sell === false) bad(`${p.title} is not for sale`);
    if (side === 'buy' && p.data.can_buy === false) bad(`${p.title} is not bought`);
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) bad(`${p.title}: quantity must be above 0`);
    const unit = dataOf(db, 'unit', p.data.stock_unit);
    if (unit?.whole_number === true && !Number.isInteger(qty)) bad(`${p.title} is counted in whole ${String(p.data.stock_unit)}: whole numbers only`);
    const line: MoneyLine = { item: p.id, qty, rate: amount(l.rate, `${p.title}: price`, true) };
    if (given(l.discount)) {
      const d = Number(l.discount);
      if (!Number.isFinite(d) || d < 0 || d > 100) bad(`${p.title}: discount must be between 0 and 100 %`);
      if (d) line.discount = Math.round(d * 1000) / 1000;
    }
    // exempt and zero-rated goods carry no VAT (01 §5.3 G)
    const cat = String(p.data.vat_category ?? 'Standard rate (18%)');
    if (cat === 'Exempt' || cat === 'Zero-rated') line.vatRate = 0;
    return line;
  });
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Payment terms → instalments with dates (03 §5.3): days after the invoice date, days after the end of the invoice
 *  month, or months after the end of the invoice month (to the last day of that month). The party's own terms, else
 *  its group's, else none; an invoice may name terms of its own. */
function scheduleOf(db: DB, input: Data, party: Data, groupType: 'customer_group' | 'supplier_group', date: string): { dueDate: string; portion: number }[] | undefined {
  // the document's, else the party's own, else its group's, else the company's (04 §1: party → group → company)
  const id = [input.payment_terms, party.payment_terms, dataOf(db, groupType, party.group)?.payment_terms, companyData(db).payment_terms].find(given);
  if (!given(id)) return undefined;
  const t = record(db, 'payment_terms', id, 'payment terms');
  const rows = (t.data.rows as Data[] | undefined) ?? [];
  if (!rows.length) bad(`${t.title} has no instalments`);
  const endOfMonth = (d: Date, plus = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 + plus, 0));
  const base = new Date(`${date}T00:00:00Z`);
  return rows.map((r) => {
    const n = Math.max(0, Number(r.days) || 0);
    let d: Date;
    if (r.basis === 'Months after the end of the invoice month') d = endOfMonth(base, n);
    else if (r.basis === 'Days after the end of the invoice month') { d = endOfMonth(base); d.setUTCDate(d.getUTCDate() + n); }
    else { d = new Date(base); d.setUTCDate(d.getUTCDate() + n); }
    return { dueDate: d.toISOString().slice(0, 10), portion: Number(r.portion) };
  });
}

function companyData(db: DB): Data {
  const r = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
  return r ? parse(r.data) : {};
}

/** Keep the price through the sale (Selling Settings maintain_same_sales_rate, action Stop): when the company asks for
 *  it, a line made from an earlier document keeps that line's price after discount; the owner or a manager may change
 *  it (ERPNext's role allowed to override). ERPNext checks order ← quotation, delivery ← order, invoice ← order or
 *  delivery (probed 14 Oct). */
export function checkSameRate(db: DB, lines: MoneyLine[], role: string): void {
  if (companyData(db).keep_same_rate !== true || MANAGERS.has(role)) return;
  const eff = (l: { rate: number; discount?: number }) => Math.round((l.discount ? l.rate * (1 - l.discount / 100) : l.rate) * 100) / 100;
  lines.forEach((l, i) => {
    if (!l.from) return;
    const r = db.prepare('SELECT data FROM steps WHERE id = ?').get(l.from.step) as { data: string } | undefined;
    const src = r ? ((parse(r.data).lines as MoneyLine[] | undefined) ?? [])[l.from.line] : undefined;
    if (src && Math.abs(eff(l) - eff(src)) > 0.005) bad(`Line ${i + 1}: the price must stay ${eff(src).toLocaleString('en-US')} as on ${l.from.step}; only a manager may change it`);
  });
}

/** Days to pay: the party's own, else its group's (03 §1.2), else 0. */
function daysToPay(db: DB, party: Data, groupType: 'customer_group' | 'supplier_group', key: 'credit_days' | 'payment_days'): number {
  if (given(party[key])) return Math.max(0, Number(party[key]) || 0);
  const g = dataOf(db, groupType, party.group);
  return g && given(g[key]) ? Math.max(0, Number(g[key]) || 0) : 0;
}

function taxOf(db: DB, input: Data, exempt = false): TaxSpec | undefined {
  // without VAT: asked for on this document, a customer (or its group) that buys without VAT unless VAT is asked for
  // anyway, or no VAT set up at all
  if (input.vat === false || (exempt && input.vat !== true)) return undefined;
  const rate = vatRate(db);
  return rate === null ? undefined : { rate, inclusive: input.prices_include_vat !== false };
}
/** Selling lines checked against the records (quotations, orders, delivery notes use the sale's rules). */
export const cleanSellLines = (db: DB, input: unknown): MoneyLine[] => moneyLines(db, input, 'sell');
/** VAT for a selling document of this customer (exempt customers and groups, no VAT set up). */
export const customerTax = (db: DB, input: Data, customer: Data): TaxSpec | undefined => taxOf(db, input, vatExempt(db, customer));
export const textInput = text;

/** The discount on the whole document: as typed, or, for a document made from discounted ones, their share of it by
 *  the amount of the lines taken (ERPNext copies the whole discount onto every part; ours gives each part its share,
 *  referee P06). */
export function wholeDiscount(db: DB, input: Data, lines: MoneyLine[]): number | undefined {
  if (given(input.discount_amount)) { const d = amount(input.discount_amount, 'The discount', true); return d > 0 ? d : undefined; }
  let share = 0;
  const bySource = new Map<string, MoneyLine[]>();
  for (const l of lines) if (l.from) bySource.set(l.from.step, [...(bySource.get(l.from.step) ?? []), l]);
  for (const [src, mine] of bySource) {
    const r = db.prepare('SELECT data FROM steps WHERE id = ?').get(src) as { data: string } | undefined;
    const d = r ? parse(r.data) : {};
    const disc = Number(d.discountAmount) || 0;
    if (!disc) continue;
    const gross = ((d.lines as MoneyLine[]) ?? []).reduce((s, l) => s + Math.round((l.discount ? l.rate * (1 - l.discount / 100) : l.rate) * l.qty * 100) / 100, 0);
    const taken = mine.reduce((s, l) => s + Math.round((l.discount ? l.rate * (1 - l.discount / 100) : l.rate) * l.qty * 100) / 100, 0);
    if (gross > 0) share += (disc * taken) / gross;
  }
  return share > 0 ? Math.round(share * 100) / 100 : undefined;
}
export const checkSellDiscounts = (db: DB, lines: MoneyLine[], role: string): void => checkDiscounts(db, lines, role);
export const dateInput = dateOf;

/** A customer that buys without VAT (exports, VAT relief): marked on the customer or its group. */
function vatExempt(db: DB, customer: Data): boolean {
  return customer.vat_exempt === true || dataOf(db, 'customer_group', customer.group)?.vat_exempt === true;
}

/** An opening balance: one line on the opening item, no VAT, no stock (Opening Invoice Creation Tool, referee M17). */
function openingLines(input: Data): MoneyLine[] {
  return [{ item: OPENING_ITEM, qty: 1, rate: amount(input.amount, 'The opening balance') }];
}

/** A supplier's bill number may be used once per supplier (input VAT is claimed by it). */
function checkBillNo(db: DB, supplier: string, billNo: string): void {
  const rows = db.prepare("SELECT id, data FROM steps WHERE kind = 'purchase_invoice'").all() as { id: string; data: string }[];
  const cancelled = new Set((db.prepare("SELECT data FROM steps WHERE kind = 'cancel'").all() as { data: string }[]).map((r) => String(parse(r.data).target)));
  for (const r of rows) {
    const d = parse(r.data);
    if (d.supplier === supplier && String(d.billNo ?? '').toLowerCase() === billNo.toLowerCase() && !cancelled.has(r.id)) {
      bad(`Bill number ${billNo} of this supplier is already entered (${r.id})`);
    }
  }
}

/** Account -> the engine's role for a journal row (what the account is used for, else its main group). */
const ROLE_OF_TYPE: Record<string, AccountRole> = {
  'Cash': 'cash', 'Bank': 'bank', 'Mobile Money': 'mobile_money', 'Receivable': 'receivable', 'Payable': 'payable', 'Tax': 'vat',
  'Stock': 'stock', 'Cost of Goods Sold': 'cost_of_goods_sold', 'Stock Received But Not Billed': 'stock_received_not_billed',
  'Stock Adjustment': 'stock_adjustment', 'Expenses Included In Valuation': 'expenses_in_valuation', 'Round Off': 'round_off',
  'Equity': 'capital', 'Temporary': 'temporary_opening', 'Income Account': 'income', 'Expense Account': 'expense', 'Exchange Gain/Loss': 'exchange_gain_loss',
};
function journalRole(acc: Data): AccountRole {
  const t = String(acc.account_type ?? '');
  if (ROLE_OF_TYPE[t]) return ROLE_OF_TYPE[t];
  const root = String(acc.root_type ?? '');
  return root === 'Income' ? 'income' : root === 'Expense' ? 'expense' : root === 'Equity' ? 'capital' : 'other';
}

/** Check a money document from a screen and give it the engine's shape. `role` is the signed-in person's role. */
export function cleanMoneyStep(db: DB, input: Data, kind: string, id: string, date: string, time: string, role = ''): Step {
  const remarks = text(input.remarks, 'Remarks');
  const withNotes = <T extends Step>(s: T): T => (remarks ? { ...s, remarks } : s);

  if (kind === 'sales_invoice') {
    const c = record(db, 'customer', input.customer, 'customer');
    const opening = input.opening === true;
    if (opening && !OPENING_ROLES.has(role)) bad('Only the owner, a manager or the accountant may enter opening balances');
    const lines = opening ? openingLines(input) : moneyLines(db, input.lines, 'sell');
    const due = dateOf(input.due_date, 'Due date') ?? addDays(date, daysToPay(db, c.data, 'customer_group', 'credit_days'));
    const step: Step = { id, kind, date, time, customer: c.id, dueDate: due, lines, tax: opening ? undefined : taxOf(db, input, vatExempt(db, c.data)) };
    if (opening) step.opening = true;
    else {
      // paid in full at the till: no instalments (ERPNext skips the schedule for till sales)
      const paidNow = Array.isArray(input.payments) && (input.payments as Data[]).some((p) => Number(p?.amount) > 0);
      const sched = paidNow ? undefined : scheduleOf(db, input, c.data, 'customer_group', date);
      if (sched) step.schedule = sched;
      lineSources(db, 'sales_invoice', input.lines, lines);
      checkSameRate(db, lines, role);
      Object.assign(step, salesmanOf(db, input, c.data));
      const fromDelivery = lines.some((l) => l.from && (db.prepare('SELECT kind FROM steps WHERE id = ?').get(l.from.step) as { kind: string } | undefined)?.kind === 'delivery_note');
      const disc = wholeDiscount(db, input, lines);
      if (disc) step.discountAmount = disc;
      const gross = lines.reduce((s2, l) => s2 + l.rate * l.qty, 0);
      checkDiscounts(db, lines, role, gross > 0 ? ((step.discountAmount ?? 0) / gross) * 100 : 0);
      if (input.update_stock !== false && !fromDelivery) { step.updateStock = true; step.warehouse = record(db, 'store', input.warehouse, 'store').id; }
      if (Array.isArray(input.payments)) {
        // each payment may carry its M-Pesa code, card slip or cheque number
        step.payments = (input.payments as Data[]).filter((p) => Number(p?.amount) > 0).map((p) => {
          const reference = text(p.reference, 'Payment code', 60);
          return { ...methodOf(db, p.method), method: String(p.method), amount: amount(p.amount, 'Payment'), ...(reference ? { reference } : {}) };
        });
      }
      if (input.write_off === true) step.writeOff = true;
      if (input.allow_over_limit === true) {
        if (!MANAGERS.has(role)) bad('Only the owner or a manager may sell over a customer\'s credit limit');
        step.creditOk = true;
      }
    }
    return withNotes(step);
  }
  if (kind === 'purchase_invoice') {
    const s = record(db, 'supplier', input.supplier, 'supplier');
    const opening = input.opening === true;
    if (opening && !OPENING_ROLES.has(role)) bad('Only the owner, a manager or the accountant may enter opening balances');
    const lines = opening ? openingLines(input) : moneyLines(db, input.lines, 'buy');
    const due = dateOf(input.due_date, 'Due date') ?? addDays(date, daysToPay(db, s.data, 'supplier_group', 'payment_days'));
    const rate = vatRate(db);
    const step: Step = { id, kind, date, time, supplier: s.id, dueDate: due, lines,
      tax: !opening && input.vat === true && rate !== null ? { rate, inclusive: input.prices_include_vat === true } : undefined };
    if (opening) step.opening = true;
    else {
      const sched = Array.isArray(input.payments) && (input.payments as Data[]).some((p) => Number(p?.amount) > 0) ? undefined : scheduleOf(db, input, s.data, 'supplier_group', date);
      if (sched) step.schedule = sched;
      if (given(input.discount_amount) && Number(input.discount_amount) > 0) step.discountAmount = amount(input.discount_amount, 'The discount');
      // paid at once (a cash purchase): one payment from a method's account
      if (Array.isArray(input.payments)) {
        const pays = (input.payments as Data[]).filter((p) => Number(p?.amount) > 0);
        if (pays.length > 1) bad('A bill paid at once takes one payment; record more as payments');
        if (pays.length) step.payments = pays.map((p) => ({ ...methodOf(db, p.method), amount: amount(p.amount, 'Paid now') }));
      }
      if (typeof input.receipt === 'string' && input.receipt) step.receipt = input.receipt;
      else if (input.update_stock === true) { step.updateStock = true; step.warehouse = record(db, 'store', input.warehouse, 'store').id; }
      // lines may bill a purchase order line or a goods-arrived line (phase 5)
      buySources(db, 'purchase_invoice', input.lines, lines);
      checkBuyRate(db, lines, role);
      // earlier payments set against this bill (advances)
      if (Array.isArray(input.advances)) {
        const adv = (input.advances as Data[]).filter((a) => Number(a?.amount) > 0).map((a, i) => {
          const from = String(a.from ?? '');
          if (!db.prepare("SELECT 1 FROM steps WHERE id = ? AND kind IN ('payment', 'journal')").get(from)) bad(`Advance ${i + 1}: ${from} is not a payment or journal`);
          return { from, amount: amount(a.amount, `Advance ${i + 1}`) };
        });
        if (adv.length) step.advances = adv;
      }
      if (given(input.write_off) && Number(input.write_off) > 0) {
        if (!MANAGERS.has(role) && role !== 'accountant') bad('Only the owner, a manager or the accountant may write off part of a bill');
        step.writeOff = amount(input.write_off, 'The write-off');
      }
      // hold the bill: no payment until the date (or until released)
      if (input.hold === true) {
        step.hold = true;
        const until = dateOf(input.hold_until, 'On hold until');
        if (until) step.holdUntil = until;
      }
    }
    const billNo = text(input.bill_no, 'Supplier\'s bill number', 60);
    if (billNo) { checkBillNo(db, s.id, billNo); step.billNo = billNo; }
    const billDate = dateOf(input.bill_date, 'Supplier\'s bill date');
    if (billDate) step.billDate = billDate;
    return withNotes(step);
  }
  if (kind === 'payment') {
    const dir = input.direction === 'out' ? 'out' : 'in';
    // usually a customer pays in and we pay a supplier; paying a customer back or a supplier paying us back is the
    // other way round (ERPNext Pay to a Customer / Receive from a Supplier, referee M29)
    const pt = typeof input.party === 'string' ? (db.prepare("SELECT type FROM docs WHERE id = ? AND type IN ('customer', 'supplier') AND deleted = 0").get(input.party) as { type: string } | undefined)?.type : undefined;
    const ptype = pt ?? (dir === 'in' ? 'customer' : 'supplier');
    const p = record(db, ptype, input.party, ptype);
    const allocate = Array.isArray(input.allocate)
      ? (input.allocate as Data[]).filter((a) => Number(a?.amount) > 0).map((a) => ({ invoice: String(a.invoice ?? ''), amount: amount(a.amount, 'Allocated amount') }))
      : undefined;
    const via = methodOf(db, input.method);
    const step: Step = { id, kind, date, time, direction: dir, party: p.id, account: via.account, amount: amount(input.amount, 'The amount'), allocate, ...(via.ref ? { ref: via.ref } : {}),
      method: String(input.method) };
    // charges taken off (bank or mobile-money charges, small differences): each on an expense (or income) account
    if (Array.isArray(input.deductions)) {
      const ded = (input.deductions as Data[]).filter((d) => Number(d?.amount) > 0).map((d, i) => {
        const a = postable(db, d.account, `account of charge ${i + 1}`);
        if (a.data.root_type !== 'Expense' && a.data.root_type !== 'Income') bad(`${a.title}: charges go to an expense or income account`);
        return { role: journalRole(a.data), amount: amount(d.amount, `Charge ${i + 1}`), ref: a.id };
      });
      if (ded.length) step.deductions = ded;
    }
    // an advance against a purchase order or a sales order (it stays credit until set against a bill)
    if (Array.isArray(input.advance_for)) {
      const adv = (input.advance_for as Data[]).filter((a) => Number(a?.amount) > 0).map((a, i) => {
        const order = String(a.order ?? '');
        if (!db.prepare("SELECT 1 FROM steps WHERE id = ? AND kind IN ('purchase_order', 'sales_order')").get(order)) bad(`Advance ${i + 1}: ${order} is not an order`);
        return { order, amount: amount(a.amount, `Advance ${i + 1}`) };
      });
      if (adv.length) step.advanceFor = adv;
    }
    const ref = text(input.reference, 'Reference', 80);
    if (ref) step.reference = ref;
    return withNotes(step);
  }
  if (kind === 'debit_note') {
    // goods or charges going back on a supplier's bill: what we owe falls (off the bill, or as credit with them)
    const against = String(input.against ?? '');
    const orig = db.prepare("SELECT data FROM steps WHERE id = ? AND kind = 'purchase_invoice'").get(against) as { data: string } | undefined;
    if (!orig) bad('Choose the supplier bill');
    const bill = parse(orig!.data);
    const step: Step = { id, kind, date, time, against, updateStock: input.update_stock !== false && bill.updateStock === true };
    if (input.reduce_invoice === true) step.reduceInvoice = true;
    if (Array.isArray(input.lines)) {
      // a returned line keeps the price and discount it was billed at (never what the screen says)
      const billed: MoneyLine[] = (bill.lines as MoneyLine[]) ?? [];
      // the price is the bill's, so a line may come without one
      const rows = (input.lines as Data[]).map((l) => (l && typeof l === 'object' && !given(l.rate) ? { ...l, rate: 0 } : l));
      step.lines = moneyLines(db, rows, 'buy').map((l) => {
        const o = billed.find((x) => x.item === l.item);
        return o ? { ...l, rate: o.rate, ...(o.discount ? { discount: o.discount } : {}), ...(o.vatRate !== undefined ? { vatRate: o.vatRate } : {}), ...(o.account ? { account: o.account } : {}) } : l;
      });
    }
    const billNo = text(input.bill_no, 'Supplier\'s credit note number', 60);
    if (billNo) step.billNo = billNo;
    return withNotes(step);
  }
  if (kind === 'credit_note') {
    const against = String(input.against ?? '');
    const step: Step = { id, kind, date, time, against, updateStock: input.update_stock !== false };
    if (input.reduce_invoice === true) step.reduceInvoice = true;
    if (Array.isArray(input.lines)) {
      // a returned line keeps the price and discount it was sold at (never what the screen says)
      const orig = db.prepare("SELECT data FROM steps WHERE id = ? AND kind = 'sales_invoice'").get(against) as { data: string } | undefined;
      const sold: MoneyLine[] = orig ? (parse(orig.data).lines as MoneyLine[] ?? []) : [];
      step.lines = moneyLines(db, input.lines, 'sell').map((l) => {
        const o = sold.find((x) => x.item === l.item);
        return o ? { ...l, rate: o.rate, ...(o.discount ? { discount: o.discount } : {}), ...(o.vatRate !== undefined ? { vatRate: o.vatRate } : {}) } : l;
      });
    }
    return withNotes(step);
  }
  if (kind === 'money_transfer') {
    const from = methodOf(db, input.from), to = methodOf(db, input.to);
    const step: Step = { id, kind, date, time, from: from.account, to: to.account, amount: amount(input.amount, 'The amount'),
      ...(from.ref ? { fromRef: from.ref } : {}), ...(to.ref ? { toRef: to.ref } : {}) };
    const ref = text(input.reference, 'Reference', 80);
    if (ref) step.reference = ref;
    return withNotes(step);
  }
  if (kind === 'reconcile') {
    // match a customer's or supplier's credit (payment, return, journal) to their open invoices
    const t = db.prepare("SELECT type FROM docs WHERE id = ? AND type IN ('customer', 'supplier') AND deleted = 0").get(String(input.party ?? '')) as { type: string } | undefined;
    if (!t) bad('Choose the customer or supplier');
    const p = record(db, t!.type, input.party, t!.type);
    if (!Array.isArray(input.allocations) || !input.allocations.length) bad('Choose what to match');
    if ((input.allocations as unknown[]).length > 200) bad('At most 200 matches at once');
    const allocations = (input.allocations as Data[]).map((a, i) => {
      const from = String(a?.from ?? ''), invoice = String(a?.invoice ?? '');
      if (!db.prepare('SELECT 1 FROM steps WHERE id = ?').get(from)) bad(`Match ${i + 1}: ${from} does not exist`);
      if (!db.prepare("SELECT 1 FROM steps WHERE id = ? AND kind IN ('sales_invoice', 'purchase_invoice')").get(invoice)) bad(`Match ${i + 1}: ${invoice} is not an invoice or bill`);
      return { from, invoice, amount: amount(a.amount, `Match ${i + 1}: amount`) };
    });
    return withNotes({ id, kind, date, time, party: p.id, allocations });
  }
  if (kind === 'journal') {
    if (!['owner', 'manager', 'accountant'].includes(role)) bad('Only the owner, a manager or the accountant may enter journals');
    if (!Array.isArray(input.rows) || input.rows.length < 2) bad('A journal needs at least two rows');
    if ((input.rows as unknown[]).length > 100) bad('At most 100 rows in one journal');
    const rows = (input.rows as Data[]).map((r, i) => {
      const acc = record(db, 'account', r?.account, `account on row ${i + 1}`);
      if (acc.data.is_group === true) bad(`${acc.title} is a group; choose an account under it`);
      const debit = amount(r.debit ?? 0, `Row ${i + 1}: debit`, true), credit = amount(r.credit ?? 0, `Row ${i + 1}: credit`, true);
      if ((debit > 0) === (credit > 0)) bad(`Row ${i + 1}: put the amount either in debit or in credit`);
      const roleOf = journalRole(acc.data);
      const row: { role: AccountRole; account: string; debit?: number; credit?: number; party?: string } = { role: roleOf, account: acc.id };
      if (debit) row.debit = debit; else row.credit = credit;
      if (roleOf === 'receivable' || roleOf === 'payable') {
        row.party = record(db, roleOf === 'receivable' ? 'customer' : 'supplier', r.party, roleOf === 'receivable' ? `customer on row ${i + 1}` : `supplier on row ${i + 1}`).id;
        // the invoice this row settles (e.g. a bad debt written off); else it stays as the party's credit or debt
        if (given(r.invoice)) {
          const inv = db.prepare("SELECT kind FROM steps WHERE id = ?").get(String(r.invoice)) as { kind: string } | undefined;
          if (!inv || !['sales_invoice', 'purchase_invoice'].includes(inv.kind)) bad(`Row ${i + 1}: ${String(r.invoice)} is not an invoice or bill`);
          (row as { invoice?: string }).invoice = String(r.invoice);
        }
      }
      return row;
    });
    const step: Step = { id, kind, date, time, rows };
    if (input.allow_over_limit === true) {
      if (!MANAGERS.has(role)) bad('Only the owner or a manager may go over a customer\'s credit limit');
      step.creditOk = true;
    }
    const ref = text(input.reference, 'Reference', 80);
    if (ref) step.reference = ref;
    return withNotes(step);
  }
  return bad(`Unknown kind of document "${kind}"`);
}

/** The customers and suppliers named by these steps, for the engine's scenario, with each customer's credit limit
 *  (its own, else its group's, else the company's; 0 or empty = no limit, as in ERPNext, 03 §5.1) and whether it is
 *  checked at the invoice instead of at the order. */
export function partiesOf(db: DB, steps: Step[]): NonNullable<Scenario['parties']> {
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.kind === 'sales_invoice') ids.add(s.customer);
    if (s.kind === 'purchase_invoice') ids.add(s.supplier);
    if (s.kind === 'payment') ids.add(s.party);
    if (s.kind === 'journal') for (const r of s.rows) if (r.party) ids.add(r.party);
    if (s.kind === 'quotation' || s.kind === 'sales_order' || s.kind === 'delivery_note') ids.add(s.customer);
    if (s.kind === 'reconcile') ids.add(s.party);
    if ((s.kind === 'purchase_order' || s.kind === 'supplier_quotation' || s.kind === 'purchase_receipt') && s.supplier) ids.add(s.supplier);
  }
  const out: NonNullable<Scenario['parties']> = [];
  const companyLimit = Number(companyData(db).credit_limit) || 0;
  for (const id of ids) {
    const r = db.prepare("SELECT type, data FROM docs WHERE id = ? AND type IN ('customer', 'supplier')").get(id) as { type: 'customer' | 'supplier'; data: string } | undefined;
    if (!r) continue;
    // fx: a party kept in another currency, with its debtors / creditors account in it (store/fx.ts)
    const p: NonNullable<Scenario['parties']>[number] = { key: id, type: r.type, ...partyFx(db, r.type, parse(r.data)) };
    if (r.type === 'supplier') {
      // on hold (bills, payments or all) until the release date; let off "order needed" / "goods arrived first"
      const d = parse(r.data);
      if (d.on_hold === true) p.hold = { type: d.hold_type === 'Bills' ? 'invoices' : d.hold_type === 'Payments' ? 'payments' : 'all', ...(typeof d.release_date === 'string' && d.release_date ? { until: d.release_date } : {}) };
      if (d.bill_without_order === true) p.billWithoutOrder = true;
      if (d.bill_without_receipt === true) p.billWithoutReceipt = true;
    }
    if (r.type === 'customer') {
      const d = parse(r.data);
      const limit = Number(d.credit_limit) || Number(dataOf(db, 'customer_group', d.group)?.credit_limit) || companyLimit;
      if (limit) p.creditLimit = limit;
      if (d.credit_at_invoice === true) p.creditAtInvoice = true;
    }
    out.push(p);
  }
  return out;
}

/** The price of a product for a customer or supplier on a date (03 §2.3): the price list is the party's own, else its
 *  group's, else the company's default for that side; the price row must be for the stock unit (or no unit) and valid
 *  on the date; the newest "valid from" wins. null when there is none (the screen then asks for a price). */
export function priceFor(db: DB, q: { item: unknown; party?: unknown; side?: unknown; date?: unknown; till?: unknown }): { rate: number; price_list: string | null; last?: { date: string; step: string } } | null {
  const side = q.side === 'buy' ? 'buy' : 'sell';
  const product = dataOf(db, 'product', q.item);
  if (!product) bad('That product does not exist');
  const date = typeof q.date === 'string' && realDate(q.date) ? q.date : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const party = dataOf(db, side === 'sell' ? 'customer' : 'supplier', q.party);
  const company = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
  const c = company ? parse(company.data) : {};
  const group = party ? dataOf(db, side === 'sell' ? 'customer_group' : 'supplier_group', party.group) : null;
  // at a till (ERPNext's POS path, 03 §2.3): the customer's own list, else the till's; their group's list is not used
  const till = side === 'sell' ? dataOf(db, 'till', q.till) : null;
  const lists = (till ? [party?.price_list, till.price_list, c.selling_price_list] : [party?.price_list, group?.price_list, side === 'sell' ? c.selling_price_list : c.buying_price_list])
    .filter((x): x is string => typeof x === 'string' && !!x);
  const rows = (db.prepare("SELECT data FROM docs WHERE type = 'item_price' AND deleted = 0").all() as { data: string }[]).map((r) => parse(r.data))
    .filter((p) => p.product === q.item && (!given(p.unit) || p.unit === product!.stock_unit)
      && (!given(p.valid_from) || String(p.valid_from) <= date) && (!given(p.valid_to) || String(p.valid_to) >= date)
      && (!given(p.customer) || (side === 'sell' && p.customer === q.party))
      && (!given(p.supplier) || (side === 'buy' && p.supplier === q.party)));
  for (const list of lists) {
    const pl = dataOf(db, 'price_list', list);
    if (!pl || pl.active === false) continue;
    // a price for this customer (or from this supplier) first, then the list price (03 §2.3 step 3, 04 §4); newest
    // valid-from wins
    const own = (p: Data) => Number(!!(p.customer || p.supplier));
    const inList = rows.filter((p) => p.price_list === list).sort((a, b) => own(b) - own(a) || String(b.valid_from ?? '').localeCompare(String(a.valid_from ?? '')));
    const hit = inList[0];
    if (hit) return { rate: Number(hit.rate) || 0, price_list: list, ...(hit.customer ? { customer: true } : {}), ...(hit.supplier ? { supplier: true } : {}) };
  }
  // buying with no price on any list: the last price paid to this supplier, else to anyone (04 §4 rule a)
  if (side === 'buy') {
    const last = (given(q.party) ? lastPurchase(db, q.item as string, q.party as string) : null) ?? lastPurchase(db, q.item as string);
    if (last) return { rate: last.rate, price_list: null, last };
  }
  return null;
}

/** The pricing rule for a sale line (03 §2.4): rules for the product first, then its group (and the groups above),
 *  then its brand; the first level with a fitting rule decides; among those the highest priority wins, and two at the
 *  same top priority are refused ("Multiple Price Rules exists"). null when none fits. */
export function ruleFor(db: DB, q: { item: unknown; party?: unknown; qty?: unknown; date?: unknown; price_list?: unknown; till?: unknown; side?: unknown; currency?: unknown }):
  { action: string; value: number; rule: string; title: string } | { error: string } | null {
  const product = dataOf(db, 'product', q.item);
  if (!product) return null;
  if (dataOf(db, 'till', q.till)?.ignore_price_rules === true) return null;   // a till set to use no pricing rules
  const date = typeof q.date === 'string' && realDate(q.date) ? q.date : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const qty = Number(q.qty) || 0;
  // buying (04 §4, supplier quantity discounts): rules for any supplier, a supplier or a supplier group
  const buying = q.side === 'buy';
  const cust = buying ? null : dataOf(db, 'customer', q.party);
  const supp = buying ? dataOf(db, 'supplier', q.party) : null;
  const BUY_FOR = ['Any supplier', 'Supplier', 'Supplier group'];
  const groupsUp = (type: string, id: unknown): string[] => {
    const out: string[] = [];
    for (let g = typeof id === 'string' ? id : null, n = 0; g && n < 20; n++) { out.push(g); g = (dataOf(db, type, g)?.parent as string | undefined) ?? null; }
    return out;
  };
  const productGroups = groupsUp('product_group', product.group), customerGroups = groupsUp('customer_group', cust?.group), routes = groupsUp('route', cust?.route);
  const rules = (db.prepare("SELECT id, title, data FROM docs WHERE type = 'price_rule' AND deleted = 0").all() as { id: string; title: string; data: string }[])
    .map((r) => ({ id: r.id, title: r.title, d: parse(r.data) }))
    .filter(({ d }) => d.active !== false && (!given(d.valid_from) || String(d.valid_from) <= date) && (!given(d.valid_to) || String(d.valid_to) >= date)
      && (!given(d.price_list) || d.price_list === q.price_list) && String(d.currency || 'TZS') === String(q.currency || 'TZS') && qty >= (Number(d.min_qty) || 0) && (!given(d.max_qty) || Number(d.max_qty) === 0 || qty <= Number(d.max_qty))
      && BUY_FOR.includes(String(d.for ?? '')) === buying
      && (d.for === 'Customer' ? d.customer === q.party : d.for === 'Customer group' ? customerGroups.includes(String(d.customer_group))
        : d.for === 'Route' ? routes.includes(String(d.route)) : d.for === 'Supplier' ? d.supplier === q.party
        : d.for === 'Supplier group' ? groupsUp('supplier_group', supp?.group).includes(String(d.supplier_group)) : true));
  const levels = [
    rules.filter(({ d }) => d.applies_to === 'Product' && d.product === q.item),
    rules.filter(({ d }) => d.applies_to === 'Product group' && productGroups.includes(String(d.product_group))),
    rules.filter(({ d }) => d.applies_to === 'Brand' && given(product.brand) && d.brand === product.brand),
  ];
  for (const level of levels) {
    if (!level.length) continue;
    const top = Math.max(...level.map(({ d }) => Number(d.priority) || 0));
    const best = level.filter(({ d }) => (Number(d.priority) || 0) === top);
    if (best.length > 1) return { error: `More than one pricing rule fits: ${best.map((b) => b.title).join(', ')}. Give one a higher priority.` };
    const r = best[0];
    return { action: String(r.d.action), value: Number(r.d.value) || 0, rule: r.id, title: r.title };
  }
  return null;
}

/** Discount limits: a product's own maximum (ERPNext Item max discount) for everyone, and the company's "needs a
 *  manager above" for cashiers and salesmen (ERPNext Authorization Rule, the simple kind). */
function checkDiscounts(db: DB, lines: MoneyLine[], role: string, wholeShare = 0): void {
  const co = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
  const limit = co ? Number(parse(co.data).discount_needs_manager) : NaN;
  const manager = MANAGERS.has(role);
  for (const l of lines) {
    const p = dataOf(db, 'product', l.item);
    const max = Number(p?.max_discount);
    const d = l.discount ?? 0;
    if (given(p?.max_discount) && max >= 0 && d > max) bad(`The most discount on ${String(p?.name ?? l.item)} is ${max} %`);
    if (!manager && Number.isFinite(limit) && limit >= 0 && co && given(parse(co.data).discount_needs_manager) && d > limit) bad(`A discount above ${limit} % needs a manager`);
  }
  if (!manager && Number.isFinite(limit) && co && given(parse(co.data).discount_needs_manager) && wholeShare > limit) bad(`A discount above ${limit} % needs a manager`);
}

/** The last price paid for a product: the newest purchase order, goods arrived or supplier bill line (not undone, not
 *  a return), per stock unit; `supplier`: from that supplier only. */
export function lastPurchase(db: DB, item: string, supplier?: string): { rate: number; date: string; step: string; supplier?: string } | null {
  const undone = new Set((db.prepare("SELECT data FROM steps WHERE kind = 'cancel'").all() as { data: string }[]).map((r) => String(parse(r.data).target)));
  const rows = (db.prepare("SELECT id, data FROM steps WHERE kind IN ('purchase_order', 'purchase_receipt', 'purchase_invoice') ORDER BY seq DESC").all() as { id: string; data: string }[])
    .filter((r) => { const d = parse(r.data); return !d.returnOf && (!supplier || d.supplier === supplier); });
  let best: { rate: number; date: string; step: string; supplier?: string } | null = null;
  for (const r of rows) {
    if (undone.has(r.id)) continue;
    const d = parse(r.data);
    if (d.opening === true) continue;
    const l = ((d.lines as Data[]) ?? []).find((x) => x.item === item);
    if (!l) continue;
    const rate = l.discount ? Math.round(Number(l.rate) * (1 - Number(l.discount) / 100) * 100) / 100 : Number(l.rate);
    const date = String(d.date ?? '');
    if (!best || date > best.date) best = { rate, date, step: r.id, ...(d.supplier ? { supplier: String(d.supplier) } : {}) };
  }
  return best;
}
