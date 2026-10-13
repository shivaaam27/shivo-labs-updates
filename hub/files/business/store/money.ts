// Money documents on the database (phase 3): sales and purchase invoices, payments, credit notes and transfers between
// own accounts. Like stock movements they are engine steps (core/contract.ts MoneyStep) kept in the steps table: the
// screen sends what was sold or paid, to whom and how; this file checks it against the records (customer,
// products, payment methods, the company's VAT) and gives the engine ids and amounts it can trust.
import type { MoneyAccount, MoneyLine, Step, TaxSpec } from '../core/contract.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';

const bad = (message: string): never => fail(422, message);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };

function record(db: DB, type: string, id: unknown, what: string): { id: string; data: Data; title: string } {
  if (typeof id !== 'string' || !id) bad(`Choose the ${what}`);
  const r = db.prepare('SELECT data, title FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id as string) as { data: string; title: string } | undefined;
  if (!r) bad(`That ${what} does not exist (it may have been deleted)`);
  const data = parse(r!.data);
  if (data.active === false) bad(`${r!.title} is not active`);
  return { id: id as string, data, title: r!.title };
}

/** The company's VAT rate: the first active VAT in Setup that is not waiting for TRA's confirmation (the 16 %
 *  electronic-payment rate stays unused until it is cleared, as Setup promises). */
export function vatRate(db: DB): number {
  const rows = db.prepare("SELECT data FROM docs WHERE type = 'tax' AND deleted = 0 ORDER BY rowid").all() as { data: string }[];
  for (const r of rows) {
    const d = parse(r.data);
    if (d.active !== false && d.type !== 'Withholding' && d.to_confirm !== true && Number.isFinite(Number(d.rate))) return Number(d.rate);
  }
  return 18;
}

/** Payment method -> the account the engine books it to (cards are paid into the bank). */
function accountOf(db: DB, method: unknown): MoneyAccount {
  const m = record(db, 'payment_method', method, 'payment method');
  const t = String(m.data.type ?? 'Cash');
  return t === 'Mobile money' ? 'mobile_money' : t === 'Cash' ? 'cash' : 'bank';
}

function amount(v: unknown, what: string, zeroOk = false): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!zeroOk && n === 0)) bad(`${what} must be ${zeroOk ? '0 or more' : 'above 0'}`);
  return Math.round(n * 100) / 100;
}

function moneyLines(db: DB, input: unknown, side: 'sell' | 'buy'): MoneyLine[] {
  if (!Array.isArray(input) || !input.length) bad('Add at least one product');
  if ((input as unknown[]).length > 500) bad('At most 500 lines in one document');
  return (input as Data[]).map((l, i) => {
    if (!l || typeof l !== 'object') bad(`Line ${i + 1} is empty`);
    const p = record(db, 'product', l.item, 'product');
    if (side === 'sell' && p.data.can_sell === false) bad(`${p.title} is not for sale`);
    if (side === 'buy' && p.data.can_buy === false) bad(`${p.title} is not bought`);
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) bad(`${p.title}: quantity must be above 0`);
    const line: MoneyLine = { item: p.id, qty, rate: amount(l.rate, `${p.title}: price`, true) };
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

function taxOf(db: DB, input: Data): TaxSpec | undefined {
  if (input.vat === false) return undefined;              // a sale or bill without VAT (not VAT-registered)
  return { rate: vatRate(db), inclusive: input.prices_include_vat !== false };
}

/** Check a money document from a screen and give it the engine's shape. */
export function cleanMoneyStep(db: DB, input: Data, kind: string, id: string, date: string, time: string): Step {
  if (kind === 'sales_invoice') {
    const c = record(db, 'customer', input.customer, 'customer');
    const lines = moneyLines(db, input.lines, 'sell');
    const days = Number(c.data.credit_days) || 0;
    const step: Step = { id, kind, date, time, customer: c.id, dueDate: addDays(date, days), lines, tax: taxOf(db, input) };
    if (input.update_stock !== false) { step.updateStock = true; step.warehouse = record(db, 'store', input.warehouse, 'store').id; }
    if (Array.isArray(input.payments)) {
      step.payments = (input.payments as Data[]).filter((p) => Number(p?.amount) > 0).map((p) => ({ account: accountOf(db, p.method), amount: amount(p.amount, 'Payment') }));
    }
    return step;
  }
  if (kind === 'purchase_invoice') {
    const s = record(db, 'supplier', input.supplier, 'supplier');
    const lines = moneyLines(db, input.lines, 'buy');
    const days = Number(s.data.payment_days) || 0;
    const step: Step = { id, kind, date, time, supplier: s.id, dueDate: addDays(date, days), lines, tax: input.vat === true ? { rate: vatRate(db), inclusive: input.prices_include_vat === true } : undefined };
    if (typeof input.receipt === 'string' && input.receipt) step.receipt = input.receipt;
    else if (input.update_stock === true) { step.updateStock = true; step.warehouse = record(db, 'store', input.warehouse, 'store').id; }
    return step;
  }
  if (kind === 'payment') {
    const dir = input.direction === 'out' ? 'out' : 'in';
    const p = record(db, dir === 'in' ? 'customer' : 'supplier', input.party, dir === 'in' ? 'customer' : 'supplier');
    const allocate = Array.isArray(input.allocate)
      ? (input.allocate as Data[]).filter((a) => Number(a?.amount) > 0).map((a) => ({ invoice: String(a.invoice ?? ''), amount: amount(a.amount, 'Allocated amount') }))
      : undefined;
    return { id, kind, date, time, direction: dir, party: p.id, account: accountOf(db, input.method), amount: amount(input.amount, 'The amount'), allocate };
  }
  if (kind === 'credit_note') {
    const against = String(input.against ?? '');
    const step: Step = { id, kind, date, time, against, updateStock: input.update_stock !== false };
    if (Array.isArray(input.lines)) step.lines = moneyLines(db, input.lines, 'sell');
    return step;
  }
  if (kind === 'money_transfer') {
    const from = accountOf(db, input.from), to = accountOf(db, input.to);
    return { id, kind, date, time, from, to, amount: amount(input.amount, 'The amount') };
  }
  return bad(`Unknown kind of document "${kind}"`);
}

/** The customers and suppliers named by these steps, for the engine's scenario. */
export function partiesOf(db: DB, steps: Step[]): { key: string; type: 'customer' | 'supplier' }[] {
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.kind === 'sales_invoice') ids.add(s.customer);
    if (s.kind === 'purchase_invoice') ids.add(s.supplier);
    if (s.kind === 'payment') ids.add(s.party);
  }
  const out: { key: string; type: 'customer' | 'supplier' }[] = [];
  for (const id of ids) {
    const r = db.prepare("SELECT type FROM docs WHERE id = ? AND type IN ('customer', 'supplier')").get(id) as { type: 'customer' | 'supplier' } | undefined;
    if (r) out.push({ key: id, type: r.type });
  }
  return out;
}

