// Money documents on the database (phase 3): sales and purchase invoices, payments, credit notes, transfers between
// own accounts, journals and opening balances. Like stock movements they are engine steps (core/contract.ts
// MoneyStep) kept in the steps table: the screen sends what was sold or paid, to whom and how; this file checks it
// against the records (customer and its group, products, payment methods, accounts, the company's VAT) and gives the
// engine ids and amounts it can trust.
import type { AccountRole, MoneyAccount, MoneyLine, Step, TaxSpec } from '../core/contract.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';

const bad = (message: string): never => fail(422, message);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };

/** The engine item every opening balance is booked on (never stock, never on a product list). */
export const OPENING_ITEM = '__opening';

/** Roles that may sell over a customer's credit limit, write off any amount and bring in opening balances. */
const MANAGERS = new Set(['owner', 'manager']);
const OPENING_ROLES = new Set(['owner', 'manager', 'accountant']);
/** What anyone at the till may write off (small change); managers any amount. */
export const TILL_WRITE_OFF = 1000;

function record(db: DB, type: string, id: unknown, what: string): { id: string; data: Data; title: string } {
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

function text(v: unknown, what: string, max = 500): string | undefined {
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
function dateOf(v: unknown, what: string): string | undefined {
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

function moneyLinesOnly(db: DB, input: unknown, side: 'sell' | 'buy'): MoneyLine[] {
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
  'Equity': 'capital', 'Temporary': 'temporary_opening', 'Income Account': 'income', 'Expense Account': 'expense',
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
      if (given(input.discount_amount) && Number(input.discount_amount) > 0) step.discountAmount = amount(input.discount_amount, 'The discount');
      if (input.update_stock !== false) { step.updateStock = true; step.warehouse = record(db, 'store', input.warehouse, 'store').id; }
      if (Array.isArray(input.payments)) {
        step.payments = (input.payments as Data[]).filter((p) => Number(p?.amount) > 0).map((p) => ({ ...methodOf(db, p.method), amount: amount(p.amount, 'Payment') }));
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
      if (given(input.discount_amount) && Number(input.discount_amount) > 0) step.discountAmount = amount(input.discount_amount, 'The discount');
      // paid at once (a cash purchase): one payment from a method's account
      if (Array.isArray(input.payments)) {
        const pays = (input.payments as Data[]).filter((p) => Number(p?.amount) > 0);
        if (pays.length > 1) bad('A bill paid at once takes one payment; record more as payments');
        if (pays.length) step.payments = pays.map((p) => ({ ...methodOf(db, p.method), amount: amount(p.amount, 'Paid now') }));
      }
      if (typeof input.receipt === 'string' && input.receipt) step.receipt = input.receipt;
      else if (input.update_stock === true) { step.updateStock = true; step.warehouse = record(db, 'store', input.warehouse, 'store').id; }
    }
    const billNo = text(input.bill_no, 'Supplier\'s bill number', 60);
    if (billNo) { checkBillNo(db, s.id, billNo); step.billNo = billNo; }
    const billDate = dateOf(input.bill_date, 'Supplier\'s bill date');
    if (billDate) step.billDate = billDate;
    return withNotes(step);
  }
  if (kind === 'payment') {
    const dir = input.direction === 'out' ? 'out' : 'in';
    const p = record(db, dir === 'in' ? 'customer' : 'supplier', input.party, dir === 'in' ? 'customer' : 'supplier');
    const allocate = Array.isArray(input.allocate)
      ? (input.allocate as Data[]).filter((a) => Number(a?.amount) > 0).map((a) => ({ invoice: String(a.invoice ?? ''), amount: amount(a.amount, 'Allocated amount') }))
      : undefined;
    const via = methodOf(db, input.method);
    const step: Step = { id, kind, date, time, direction: dir, party: p.id, account: via.account, amount: amount(input.amount, 'The amount'), allocate, ...(via.ref ? { ref: via.ref } : {}) };
    // charges taken off (bank or mobile-money charges, small differences): each on an expense (or income) account
    if (Array.isArray(input.deductions)) {
      const ded = (input.deductions as Data[]).filter((d) => Number(d?.amount) > 0).map((d, i) => {
        const a = postable(db, d.account, `account of charge ${i + 1}`);
        if (a.data.root_type !== 'Expense' && a.data.root_type !== 'Income') bad(`${a.title}: charges go to an expense or income account`);
        return { role: journalRole(a.data), amount: amount(d.amount, `Charge ${i + 1}`), ref: a.id };
      });
      if (ded.length) step.deductions = ded;
    }
    const ref = text(input.reference, 'Reference', 80);
    if (ref) step.reference = ref;
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
      }
      return row;
    });
    const step: Step = { id, kind, date, time, rows };
    const ref = text(input.reference, 'Reference', 80);
    if (ref) step.reference = ref;
    return withNotes(step);
  }
  return bad(`Unknown kind of document "${kind}"`);
}

/** The customers and suppliers named by these steps, for the engine's scenario, with each customer's credit limit
 *  (its own, else its group's; 0 or empty = no limit, as in ERPNext). */
export function partiesOf(db: DB, steps: Step[]): { key: string; type: 'customer' | 'supplier'; creditLimit?: number }[] {
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.kind === 'sales_invoice') ids.add(s.customer);
    if (s.kind === 'purchase_invoice') ids.add(s.supplier);
    if (s.kind === 'payment') ids.add(s.party);
    if (s.kind === 'journal') for (const r of s.rows) if (r.party) ids.add(r.party);
  }
  const out: { key: string; type: 'customer' | 'supplier'; creditLimit?: number }[] = [];
  for (const id of ids) {
    const r = db.prepare("SELECT type, data FROM docs WHERE id = ? AND type IN ('customer', 'supplier')").get(id) as { type: 'customer' | 'supplier'; data: string } | undefined;
    if (!r) continue;
    const p: { key: string; type: 'customer' | 'supplier'; creditLimit?: number } = { key: id, type: r.type };
    if (r.type === 'customer') {
      const d = parse(r.data);
      const own = Number(d.credit_limit) || 0;
      const group = own ? 0 : Number(dataOf(db, 'customer_group', d.group)?.credit_limit) || 0;
      if (own || group) p.creditLimit = own || group;
    }
    out.push(p);
  }
  return out;
}

/** The price of a product for a customer or supplier on a date (03 §2.3): the price list is the party's own, else its
 *  group's, else the company's default for that side; the price row must be for the stock unit (or no unit) and valid
 *  on the date; the newest "valid from" wins. null when there is none (the screen then asks for a price). */
export function priceFor(db: DB, q: { item: unknown; party?: unknown; side?: unknown; date?: unknown }): { rate: number; price_list: string | null; last?: { date: string; step: string } } | null {
  const side = q.side === 'buy' ? 'buy' : 'sell';
  const product = dataOf(db, 'product', q.item);
  if (!product) bad('That product does not exist');
  const date = typeof q.date === 'string' && realDate(q.date) ? q.date : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const party = dataOf(db, side === 'sell' ? 'customer' : 'supplier', q.party);
  const company = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
  const c = company ? parse(company.data) : {};
  const group = party ? dataOf(db, side === 'sell' ? 'customer_group' : 'supplier_group', party.group) : null;
  const lists = [party?.price_list, group?.price_list, side === 'sell' ? c.selling_price_list : c.buying_price_list].filter((x): x is string => typeof x === 'string' && !!x);
  const rows = (db.prepare("SELECT data FROM docs WHERE type = 'item_price' AND deleted = 0").all() as { data: string }[]).map((r) => parse(r.data))
    .filter((p) => p.product === q.item && (!given(p.unit) || p.unit === product!.stock_unit)
      && (!given(p.valid_from) || String(p.valid_from) <= date) && (!given(p.valid_to) || String(p.valid_to) >= date));
  for (const list of lists) {
    const pl = dataOf(db, 'price_list', list);
    if (!pl || pl.active === false) continue;
    const hit = rows.filter((p) => p.price_list === list).sort((a, b) => String(b.valid_from ?? '').localeCompare(String(a.valid_from ?? '')))[0];
    if (hit) return { rate: Number(hit.rate) || 0, price_list: list };
  }
  // buying with no price on any list: the last price paid (ERPNext's last purchase rate)
  if (side === 'buy') { const last = lastPurchase(db, q.item as string); if (last) return { rate: last.rate, price_list: null, last }; }
  return null;
}

/** The last price paid for a product: the newest goods arrived or supplier bill line (not undone), per stock unit. */
export function lastPurchase(db: DB, item: string): { rate: number; date: string; step: string; supplier?: string } | null {
  const undone = new Set((db.prepare("SELECT data FROM steps WHERE kind = 'cancel'").all() as { data: string }[]).map((r) => String(parse(r.data).target)));
  const rows = db.prepare("SELECT id, data FROM steps WHERE kind IN ('purchase_receipt', 'purchase_invoice') ORDER BY seq DESC").all() as { id: string; data: string }[];
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
