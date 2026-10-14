// Buying documents on the database (phase 5): stock requests, supplier quotations, purchase orders, goods arrived
// (with units refused on arrival, from orders, and goods sent back) and status changes (close, hold, stop, reopen).
// Like every step they are checked against the records here and kept only if the engine (core/buy/orders.ts) accepts
// them with the whole history.
import type { MoneyLine, ReceiptLine, Step } from '../core/contract.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { buyTax, cleanBuyLines, dateInput, record, scheduleFor, textInput, wholeDiscount } from './money.ts';

const bad = (message: string): never => fail(422, message);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const MANAGERS = new Set(['owner', 'manager']);
export const BUY_STATUS_KINDS = new Set(['material_request', 'purchase_order', 'purchase_receipt', 'purchase_invoice']);
const WANT: Record<string, string> = {
  purchase_order: 'material_request|supplier_quotation', supplier_quotation: 'material_request',
  purchase_receipt: 'purchase_order', purchase_invoice: 'purchase_order|purchase_receipt', transfer: 'material_request',
};

const company = (db: DB): Data => {
  const r = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
  return r ? parse(r.data) : {};
};

/** `from` on a buying line: the source step and the line's position; the source must be of the right kind. */
export function buySources(db: DB, kind: string, input: unknown, lines: { from?: { step: string; line: number } }[]): void {
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

/** Keep the price from the purchase order (Buying Settings maintain_same_rate, action Stop): goods arrived and bills
 *  made from an order keep the order line's price after discount; the owner or a manager may change it when the
 *  company lets them (role allowed to override). Warn: allowed (the screen shows the change). */
export function checkBuyRate(db: DB, lines: MoneyLine[] | ReceiptLine[], role: string): void {
  const co = company(db);
  if (co.buy_same_rate !== 'Stop' || (co.buy_same_rate_role === 'Manager' && MANAGERS.has(role))) return;
  const eff = (l: { rate: number; discount?: number }) => Math.round((l.discount ? l.rate * (1 - l.discount / 100) : l.rate) * 100) / 100;
  lines.forEach((l, i) => {
    if (!l.from) return;
    const r = db.prepare("SELECT data FROM steps WHERE id = ? AND kind = 'purchase_order'").get(l.from.step) as { data: string } | undefined;
    const src = r ? ((parse(r.data).lines as MoneyLine[] | undefined) ?? [])[l.from.line] : undefined;
    if (src && Math.abs(eff(l) - eff(src)) > 0.005) bad(`Line ${i + 1}: the price must stay ${eff(src).toLocaleString('en-US')} as on ${l.from.step}`);
  });
}

/** A status change on a buying document: close, hold or reopen an order, stop or reopen a request, close goods arrived. */
export function cleanBuyStatus(db: DB, input: Data, targetKind: string, id: string, date: string, time: string, role: string, remarks?: string): Step {
  const target = String(input.target);
  const status = String(input.status ?? '');
  // a supplier bill: Open releases a hold (ERPNext "Unblock Invoice")
  const ok: Record<string, string[]> = { purchase_order: ['Closed', 'On Hold', 'Open'], material_request: ['Stopped', 'Open'], purchase_receipt: ['Closed', 'Open'], purchase_invoice: ['Open'] };
  if (!ok[targetKind].includes(status)) bad(`Status must be ${ok[targetKind].join(', ')}`);
  const who = targetKind === 'material_request' ? ['owner', 'manager', 'storekeeper'] : ['owner', 'manager', 'accountant'];
  if (!who.includes(role)) bad('Only the owner, a manager' + (targetKind === 'material_request' ? ' or the storekeeper' : ' or the accountant') + ' may do this');
  return { id, kind: 'set_status', date, time, target, status: status as 'Closed', ...(remarks ? { remarks } : {}) };
}

/** How goods came (ours, kept for people): the supplier's delivery note, transport company, waybill, vehicle. */
function arrivedBy(db: DB, input: Data): Record<string, string> {
  const out: Record<string, string> = {};
  const note = textInput(input.supplier_note, 'Supplier\'s delivery note number');
  if (note) out.supplierNote = note.slice(0, 60);
  if (typeof input.transporter === 'string' && input.transporter) out.transporter = record(db, 'supplier', input.transporter, 'transport company').id;
  const lr = textInput(input.lr_no, 'Waybill number');
  if (lr) out.lrNo = lr.slice(0, 60);
  const lrd = dateInput(input.lr_date, 'Waybill date');
  if (lrd) out.lrDate = lrd;
  const v = textInput(input.vehicle, 'Vehicle');
  if (v) out.vehicle = v.slice(0, 40);
  return out;
}

export function cleanBuyStep(db: DB, input: Data, kind: string, id: string, date: string, time: string, role = ''): Step {
  const remarks = textInput(input.remarks, 'Remarks');
  const notes = <T extends Step>(s: T): T => (remarks ? { ...s, remarks } : s);
  if (kind === 'material_request') {
    const purpose = input.purpose === 'transfer' ? 'transfer' : 'purchase';
    const warehouse = record(db, 'store', input.warehouse, 'store that needs the goods').id;
    const lines = cleanBuyLines(db, input.lines, purpose === 'purchase');
    const requiredBy = dateInput(input.required_by, 'Required by');
    const from = purpose === 'transfer' ? record(db, 'store', input.from, 'store the goods come from').id : undefined;
    return notes({ id, kind, date, time, purpose, warehouse, lines, ...(from ? { from } : {}), ...(requiredBy ? { requiredBy } : {}) });
  }
  if (kind === 'supplier_quotation' || kind === 'purchase_order') {
    const s = record(db, 'supplier', input.supplier, 'supplier');
    const lines = cleanBuyLines(db, input.lines, true);
    buySources(db, kind, input.lines, lines);
    const tax = buyTax(db, input);
    const disc = wholeDiscount(db, input, lines);
    const extra = { ...(tax ? { tax } : {}), ...(disc ? { discountAmount: disc } : {}) };
    if (kind === 'supplier_quotation') {
      const validTill = dateInput(input.valid_till, 'Valid till');
      return notes({ id, kind, date, time, supplier: s.id, lines, ...extra, ...(validTill ? { validTill } : {}) });
    }
    const warehouse = record(db, 'store', input.warehouse, 'store the goods go to').id;
    const requiredBy = dateInput(input.required_by, 'Required by');
    const schedule = scheduleFor(db, input, s.data, date);
    return notes({ id, kind, date, time, supplier: s.id, warehouse, lines, ...extra, ...(requiredBy ? { requiredBy } : {}), ...(schedule ? { schedule } : {}) });
  }
  if (kind === 'purchase_receipt') {
    const warehouse = record(db, 'store', input.warehouse, 'store').id;
    const supplier = typeof input.supplier === 'string' && input.supplier ? record(db, 'supplier', input.supplier, 'supplier').id : undefined;
    const returnOf = typeof input.return_against === 'string' && input.return_against ? String(input.return_against) : undefined;
    if (returnOf && !db.prepare("SELECT 1 FROM steps WHERE id = ? AND kind = 'purchase_receipt'").get(returnOf)) bad(`${returnOf} is not goods arrived`);
    const money = cleanBuyLines(db, input.lines, true);
    const lines: ReceiptLine[] = money.map((l, i) => {
      const p = record(db, 'product', l.item, 'product');
      if (p.data.is_stock === false) bad(`${p.title} is not a stock product; bill it as a service`);
      const raw = (input.lines as Data[])[i];
      const rate = l.discount ? Math.round(l.rate * (1 - l.discount / 100) * 100) / 100 : l.rate;
      const out: ReceiptLine = { item: l.item, qty: l.qty, rate };
      const rej = Number(raw.rejected ?? 0);
      if (!Number.isFinite(rej) || rej < 0) bad(`${p.title}: refused must be 0 or more`);
      if (rej > 0) { if (returnOf) bad('Goods sent back have no refused units'); out.rejected = rej; }
      return out;
    });
    if (returnOf) {
      // a line sent back names the goods-arrived line; it keeps that line's cost (never what the screen says)
      const orig = parse((db.prepare('SELECT data FROM steps WHERE id = ?').get(returnOf) as { data: string }).data);
      (input.lines as Data[]).forEach((l, i) => {
        const line = Number((l?.from as Data | undefined)?.line);
        const ol = ((orig.lines as ReceiptLine[]) ?? [])[line];
        if (!Number.isInteger(line) || !ol) bad(`Line ${i + 1}: choose the line of ${returnOf} that goes back`);
        lines[i].from = { step: returnOf, line };
        lines[i].rate = ol.rate;
      });
    } else {
      buySources(db, kind, input.lines, lines);
      checkBuyRate(db, lines, role);
    }
    // refused units go to a store marked "For refused goods" (ERPNext is_rejected_warehouse)
    const rej = lines.some((l) => l.rejected) ? record(db, 'store', input.rejected_warehouse, 'store for refused goods') : undefined;
    if (rej && rej.data.rejected !== true) bad(`${rej.title} is not marked "For refused goods" (Setup > Stores)`);
    const rejectedWarehouse = rej?.id;
    return notes({ id, kind, date, time, warehouse, lines, ...(supplier ? { supplier } : {}), ...(rejectedWarehouse ? { rejectedWarehouse } : {}),
      ...(returnOf ? { returnOf } : {}), ...arrivedBy(db, input) } as Step);
  }
  return bad(`Unknown kind of document "${kind}"`);
}
