// Selling documents on the database (phase 4): quotations, sales orders, delivery notes and status changes (close,
// hold, reopen, lost). Like every step they are checked against the records here and kept by the engine
// (core/sell/orders.ts) only if it accepts them with the whole history.
import type { MoneyLine, Step } from '../core/contract.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { checkSameRate, checkSellDiscounts, cleanSellLines, customerTax, dateInput, record, textInput, wholeDiscount } from './money.ts';

const bad = (message: string): never => fail(422, message);
const MANAGERS = new Set(['owner', 'manager']);
const WANT: Record<string, string> = { sales_order: 'quotation', delivery_note: 'sales_order|delivery_note', pick_list: 'sales_order', sales_invoice: 'sales_order|delivery_note' };

/** `from` on a screen's line: the source step and the line's position; the source must be of the right kind. */
export function lineSources(db: DB, kind: string, input: unknown, lines: MoneyLine[]): void {
  if (!Array.isArray(input)) return;
  (input as Data[]).forEach((l, i) => {
    const f = l?.from as Data | undefined;
    if (!f || typeof f !== 'object') return;
    const step = String(f.step ?? ''), line = Number(f.line);
    if (!step || !Number.isInteger(line) || line < 0) bad(`Line ${i + 1}: bad link to its source`);
    const src = db.prepare('SELECT kind FROM steps WHERE id = ?').get(step) as { kind: string } | undefined;
    if (!src || !(WANT[kind] ?? '').split('|').includes(src.kind)) bad(`Line ${i + 1}: ${step} cannot be the source of this document`);
    lines[i].from = { step, line };
  });
}

/** The salesman of a document: the one chosen, else the customer's own (03 §1.2, one salesman per document). */
export function salesmanOf(db: DB, input: Data, customer: Data): { salesman?: string } {
  const id = typeof input.salesman === 'string' && input.salesman ? input.salesman : typeof customer.salesman === 'string' ? customer.salesman : '';
  return id ? { salesman: record(db, 'salesman', id, 'salesman').id } : {};
}

/** How a delivery travels (ERPNext Delivery Note transport): driver, vehicle, a transport company and its receipt. */
function transportOf(db: DB, input: Data): { driver?: string; vehicle?: string; transporter?: string; lrNo?: string; lrDate?: string } {
  const out: { driver?: string; vehicle?: string; transporter?: string; lrNo?: string; lrDate?: string } = {};
  if (typeof input.driver === 'string' && input.driver) out.driver = record(db, 'driver', input.driver, 'driver').id;
  if (typeof input.vehicle === 'string' && input.vehicle) out.vehicle = record(db, 'vehicle', input.vehicle, 'vehicle').id;
  if (typeof input.transporter === 'string' && input.transporter) out.transporter = record(db, 'supplier', input.transporter, 'transport company').id;
  const lr = textInput(input.lr_no, 'Transport receipt number');
  if (lr) out.lrNo = lr.slice(0, 60);
  const lrd = dateInput(input.lr_date, 'Transport receipt date');
  if (lrd) out.lrDate = lrd;
  return out;
}

export function cleanSellStep(db: DB, input: Data, kind: string, id: string, date: string, time: string, role = ''): Step {
  const remarks = textInput(input.remarks, 'Remarks');
  const notes = <T extends Step>(s: T): T => (remarks ? { ...s, remarks } : s);
  if (kind === 'set_status') {
    const target = String(input.target ?? '');
    const t = db.prepare('SELECT kind FROM steps WHERE id = ?').get(target) as { kind: string } | undefined;
    if (!t || !['quotation', 'sales_order', 'delivery_note'].includes(t.kind)) bad('Choose a quotation, order or delivery note');
    const status = String(input.status ?? '');
    if (!['Closed', 'On Hold', 'Open', 'Lost'].includes(status)) bad('Status must be Closed, On Hold, Open or Lost');
    if (status !== 'Lost' && !MANAGERS.has(role)) bad('Only the owner or a manager may close, hold or reopen');
    if (status === 'Lost' && !remarks) bad('Why was it lost? (price, delivery time, went to a competitor…)');
    return notes({ id, kind: 'set_status', date, time, target, status: status as 'Closed' | 'On Hold' | 'Open' | 'Lost' });
  }
  const c = record(db, 'customer', input.customer, 'customer');
  const lines = cleanSellLines(db, input.lines);
  lineSources(db, kind, input.lines, lines);
  checkSameRate(db, lines, role);
  const tax = customerTax(db, input, c.data);
  checkSellDiscounts(db, lines, role);
  const disc = wholeDiscount(db, input, lines);
  const extra = disc ? { discountAmount: disc } : {};
  if (kind === 'quotation') {
    const validTill = dateInput(input.valid_till, 'Valid till');
    return notes({ id, kind, date, time, customer: c.id, lines, ...(tax ? { tax } : {}), ...(validTill ? { validTill } : {}), ...extra, ...salesmanOf(db, input, c.data) });
  }
  const warehouse = record(db, 'store', input.warehouse, 'store').id;
  if (kind === 'pick_list') return notes({ id, kind, date, time, customer: c.id, warehouse, lines });
  const over = input.allow_over_limit === true;
  const who = salesmanOf(db, input, c.data);
  if (over && !MANAGERS.has(role)) bad('Only the owner or a manager may go over a customer\'s credit limit');
  if (kind === 'sales_order') {
    const deliveryDate = dateInput(input.delivery_date, 'Delivery date');
    return notes({ id, kind, date, time, customer: c.id, warehouse, lines, ...(tax ? { tax } : {}), ...(deliveryDate ? { deliveryDate } : {}), ...(over ? { creditOk: true } : {}), ...extra,
      ...(input.reserve_stock === true ? { reserve: true } : {}), ...who });
  }
  if (kind === 'delivery_note') {
    // goods coming back on a delivery not yet invoiced; or delivered from a pick list
    const returnOf = typeof input.return_against === 'string' && input.return_against ? String(input.return_against) : undefined;
    const pick = typeof input.pick_list === 'string' && input.pick_list ? String(input.pick_list) : undefined;
    if (pick) for (const l of lines) if (l.from) (l as typeof l & { pick?: string }).pick = pick;
    return notes({ id, kind, date, time, customer: c.id, warehouse, lines, ...(tax ? { tax } : {}), ...(over ? { creditOk: true } : {}), ...extra,
      ...(returnOf ? { returnOf } : {}), ...who, ...transportOf(db, input) });
  }
  return bad(`Unknown kind of document "${kind}"`);
}
