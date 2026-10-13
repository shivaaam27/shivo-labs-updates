// Selling documents (phase 4, pos/blueprint/03-selling.md §3-§5): quotation → sales order → delivery note → sales
// invoice. A quotation and an order book nothing; a delivery note sends goods out through the stock ledger (Dr cost of
// goods sold, Cr stock, as a 'delivery' step with the same id). Each line may point at the line it came from
// (`from`); ordered, delivered and billed are re-summed from the live documents every time (03 §3.2), so a cancel or
// a late sync can never double count.
import type { DocResult, MoneyLine, Scenario, SellStep, Step } from '../contract.ts';
import { roundMoney } from '../money.ts';
import type { StockLedger } from '../stock/ledger.ts';
import { invoiceTotals, lineRate } from '../money/taxes.ts';

export const SELL_KINDS = new Set<string>(['quotation', 'sales_order', 'delivery_note', 'set_status']);
type Doc = Exclude<SellStep, { kind: 'set_status' }>;
interface Posted { step: Doc; cancelled: boolean; manual?: 'Closed' | 'On Hold' | 'Lost' }
/** What the selling side needs to know about invoices (money/books.ts). */
export interface InvoiceView { id: string; customer: string; lines: MoneyLine[]; updateStock: boolean; date: string }

const FULL = 99.999999;   // ERPNext: >= 99.999999 % counts as fully done (03 §3.2)
const pct = (done: number, of: number) => (of ? Math.round((done / of) * 100 * 1e6) / 1e6 : 0);
const amountOf = (l: MoneyLine) => roundMoney(lineRate(l) * l.qty);
/** Dar es Salaam date today: a quotation past its valid-till date is Expired. */
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export class SalesBook {
  private scenario: Scenario;
  private stock: StockLedger;
  private invoices: () => InvoiceView[];
  private services: Set<string>;
  posted = new Map<string, Posted>();
  order: string[] = [];
  errors: { step: string; message: string }[] = [];

  private credit: (customer: string, adds: number) => string | null;
  /** Set by run.ts: whether a customer is checked at the delivery and invoice instead of at the order, and the
   *  below-cost check (money/books.ts). */
  atInvoice: (customer: string) => boolean = () => false;
  belowCost: (lines: MoneyLine[], tax: Doc['tax'], discount: number | undefined, warehouse: string | undefined, date: string, time: string) => string | null = () => null;
  private billing: InvoiceView | null = null;   // an invoice being checked for credit, counted as if posted

  constructor(scenario: Scenario, stock: StockLedger, invoices: () => InvoiceView[], credit: (customer: string, adds: number) => string | null) {
    this.scenario = scenario;
    this.stock = stock;
    this.invoices = invoices;
    this.credit = credit;
    this.services = new Set(scenario.items.filter((i) => i.stock === false).map((i) => i.key));
  }

  isSell(id: string): boolean { return this.posted.has(id); }
  private inv(): InvoiceView[] { return this.billing ? [...this.invoices(), this.billing] : this.invoices(); }
  live(id: string): Doc | null { const p = this.posted.get(id); return p && !p.cancelled ? p.step : null; }

  post(step: SellStep): void {
    if (step.kind === 'set_status') return this.setStatus(step);
    const bad = this.check(step);
    if (bad) return this.fail(step.id, bad);
    const low = this.belowCost(step.lines, step.tax, step.discountAmount, step.kind === 'quotation' ? undefined : step.warehouse, step.date, step.time);
    if (low) return this.fail(step.id, low);
    // credit (03 §5.2): an order always; a delivery note only for lines not made from an order. A customer checked at
    // the invoice (bypass): orders never, a delivery note in full.
    const atInv = this.atInvoice(step.customer);
    if (!step.creditOk && step.kind !== 'quotation' && !(atInv && step.kind === 'sales_order')) {
      const own = step.kind === 'sales_order' || atInv ? step.lines : step.lines.filter((l) => !l.from);
      if (own.length) {
        const t = invoiceTotals(own, step.tax, this.scenario.rounding !== false, step.kind === 'sales_order' ? step.discountAmount : undefined);
        const msg = this.credit(step.customer, step.kind === 'sales_order' ? t.roundedTotal : t.grandTotal);
        if (msg) return this.fail(step.id, msg);
      }
    }
    if (step.kind === 'delivery_note') {
      // goods out at the stock ledger under the delivery note's id (rate = selling price, cost from the ledger)
      const goods = step.lines.filter((l) => !this.services.has(l.item)).map((l) => ({ item: l.item, qty: l.qty, rate: lineRate(l) }));
      if (goods.length) {
        const before = this.stock.errors.length;
        this.stock.post({ id: step.id, kind: 'delivery', date: step.date, time: step.time, warehouse: step.warehouse, lines: goods } as Step);
        const err = this.stock.errors.slice(before).find((e) => e.step === step.id);
        if (err) return this.fail(step.id, err.message);
      }
    }
    this.posted.set(step.id, { step, cancelled: false });
    this.order.push(step.id);
  }

  /** Cancel (01 §2.6): refused while a live document was made from it (ERPNext: cancel the later one first). */
  cancel(cancelId: string, target: string, date: string, time: string): void {
    const p = this.posted.get(target);
    if (!p) return this.fail(cancelId, `Step ${target} was not posted, nothing to cancel`);
    if (p.cancelled) return this.fail(cancelId, `Step ${target} is already cancelled`);
    const child = this.childrenOf(target)[0];
    if (child) return this.fail(cancelId, `Cancel ${child} first: it was made from ${target}`);
    if (p.step.kind === 'delivery_note' && this.stock.posted.has(target)) this.stock.post({ id: `${cancelId}:stock`, kind: 'cancel', date, time, target } as Step);
    p.cancelled = true;
    this.order.push(cancelId);
  }

  /** Live documents with a line made from this one. */
  private childrenOf(id: string): string[] {
    const out = new Set<string>();
    for (const p of this.posted.values()) if (!p.cancelled && p.step.lines.some((l) => l.from?.step === id)) out.add(p.step.id);
    for (const inv of this.inv()) if (inv.lines.some((l) => l.from?.step === id)) out.add(inv.id);
    return [...out];
  }

  private setStatus(step: Extract<SellStep, { kind: 'set_status' }>): void {
    const p = this.posted.get(step.target);
    if (!p || p.cancelled) return this.fail(step.id, `${step.target} is not a live selling document`);
    const k = p.step.kind, st = step.status;
    if (st === 'Lost' && k !== 'quotation') return this.fail(step.id, 'Only a quotation can be lost');
    if ((st === 'Closed' || st === 'On Hold') && k === 'quotation') return this.fail(step.id, 'A quotation cannot be closed or held; mark it lost');
    if (st === 'On Hold' && k !== 'sales_order') return this.fail(step.id, 'Only a sales order can be put on hold');
    if (st === 'Lost' && this.orderedPct(p.step.id) > 0) return this.fail(step.id, 'An order was made from this quotation; it cannot be lost');
    if (st === 'Closed' && k === 'sales_order' && this.status(p) === 'Completed') return this.fail(step.id, 'The order is already completed');
    if (st === 'Open') {
      if (!p.manual) return this.fail(step.id, `${step.target} is not closed, held or lost`);
      const was = p.manual;
      delete p.manual;
      // an order opened again is checked against the credit limit again (03 §5.2)
      if (k === 'sales_order' && !this.atInvoice(p.step.customer)) {
        const msg = this.credit(p.step.customer, 0);
        if (msg) { p.manual = was; return this.fail(step.id, msg); }
      }
    } else p.manual = st;
    this.order.push(step.id);
  }

  // ---- checks ------------------------------------------------------------------------------------------------

  private check(step: Doc): string | null {
    if (!this.scenario.parties?.some((p) => p.key === step.customer && p.type === 'customer')) return `Unknown customer ${step.customer}`;
    if (!step.lines.length) return 'No lines';
    if (step.kind !== 'quotation' && !this.scenario.warehouses.includes(step.warehouse)) return 'Choose the store';
    for (const [i, l] of step.lines.entries()) {
      if (!(l.qty > 0) || !(l.rate >= 0)) return `Line ${i + 1}: quantity above 0 and a price of 0 or more`;
      if (l.from) {
        const bad = this.lineSource(step, l, i);
        if (bad) return bad;
      }
    }
    if (step.kind === 'quotation' && step.validTill && step.validTill < step.date) return 'Valid till cannot be before the quotation date';
    if (step.kind === 'sales_order' && step.deliveryDate && step.deliveryDate < step.date) return 'The deliver-by date cannot be before the order date';
    return null;
  }

  /** A line made from another document: the right kind, the same customer, still open, not more than is left. */
  private lineSource(step: Doc, l: MoneyLine, i: number): string | null {
    const src = this.posted.get(l.from!.step);
    const want = step.kind === 'sales_order' ? 'quotation' : step.kind === 'delivery_note' ? 'sales_order' : null;
    if (!src || src.cancelled || src.step.kind !== want) return `Line ${i + 1}: ${l.from!.step} is not a live ${want ?? 'source'}`;
    if (src.step.customer !== step.customer) return `Line ${i + 1}: ${l.from!.step} is for another customer`;
    const sl = src.step.lines[l.from!.line];
    if (!sl || sl.item !== l.item) return `Line ${i + 1}: no such line ${l.from!.line + 1} of ${src.step.id}`;
    const st = this.status(src);
    if (st === 'Closed' || st === 'On Hold' || st === 'Lost') return `${src.step.id} is ${st.toLowerCase()}`;
    // an expired quotation cannot become an order (ERPNext's default, 03 §3.3)
    if (src.step.kind === 'quotation' && src.step.validTill && src.step.validTill < step.date) return `${src.step.id} expired on ${src.step.validTill}`;
    if (want === 'sales_order') {
      const allow = 1 + (this.scenario.overDelivery ?? 0) / 100;
      const done = this.deliveredQty(src.step.id, l.from!.line);
      if (done + l.qty > sl.qty * allow + 1e-9) return `${l.item}: ${done + l.qty} would be delivered, only ${sl.qty} ordered on ${src.step.id}`;
    }
    return null;
  }

  /** An invoice line made from an order or a delivery note (money/books.ts asks before posting). */
  checkInvoiceLine(customer: string, l: MoneyLine, i: number, updateStock: boolean, billedBefore: (ref: { step: string; line: number }) => number): string | null {
    const src = this.posted.get(l.from!.step);
    if (!src || src.cancelled || (src.step.kind !== 'sales_order' && src.step.kind !== 'delivery_note')) return `Line ${i + 1}: ${l.from!.step} is not a live order or delivery note`;
    if (src.step.customer !== customer) return `Line ${i + 1}: ${l.from!.step} is for another customer`;
    const sl = src.step.lines[l.from!.line];
    if (!sl || sl.item !== l.item) return `Line ${i + 1}: no such line ${l.from!.line + 1} of ${src.step.id}`;
    const st = this.status(src);
    if (st === 'Closed' || st === 'On Hold') return `${src.step.id} is ${st.toLowerCase()}`;
    if (src.step.kind === 'delivery_note' && updateStock && !this.services.has(l.item)) return `${l.item} was already delivered on ${src.step.id}; the invoice cannot move it again`;
    const allow = 1 + (this.scenario.overBilling ?? 0) / 100;
    const billed = billedBefore(l.from!);
    if (billed + amountOf(l) > amountOf(sl) * allow + 0.001) return `${l.item}: billing ${roundMoney(billed + amountOf(l))} is more than ${amountOf(sl)} on ${src.step.id}`;
    if (src.step.kind === 'sales_order' && updateStock && !this.services.has(l.item)) {
      const done = this.deliveredQty(src.step.id, l.from!.line);
      if (done + l.qty > sl.qty * (1 + (this.scenario.overDelivery ?? 0) / 100) + 1e-9) return `${l.item}: ${done + l.qty} would be delivered, only ${sl.qty} ordered`;
    }
    return null;
  }

  // ---- counters (re-summed, 03 §3.2) -------------------------------------------------------------------------

  private liveDocs(kind: string): Doc[] { return [...this.posted.values()].filter((p) => !p.cancelled && p.step.kind === kind).map((p) => p.step); }

  private orderedQty(q: string, line: number): number {
    return this.liveDocs('sales_order').reduce((s, o) => s + o.lines.filter((l) => l.from?.step === q && l.from.line === line).reduce((x, l) => x + l.qty, 0), 0);
  }
  deliveredQty(so: string, line: number): number {
    let q = 0;
    for (const d of this.liveDocs('delivery_note')) for (const l of d.lines) if (l.from?.step === so && l.from.line === line) q += l.qty;
    for (const inv of this.inv()) if (inv.updateStock) for (const l of inv.lines) if (l.from?.step === so && l.from.line === line) q += l.qty;
    return q;
  }
  /** Billed amount of the order or delivery note line an invoice line points at. */
  billedFor(ref: { step: string; line: number }): number {
    return this.live(ref.step)?.kind === 'delivery_note' ? this.dnBilled(ref.step, ref.line) : this.billedAmount(ref);
  }

  /** Billed amount of an order line: invoice lines made from it, directly or through a delivery note line made from it. */
  billedAmount(ref: { step: string; line: number }): number {
    const src = this.posted.get(ref.step)?.step;
    let a = 0;
    for (const inv of this.inv()) for (const l of inv.lines) {
      if (!l.from) continue;
      if (l.from.step === ref.step && l.from.line === ref.line) a += amountOf(l);
      else if (src?.kind === 'sales_order') {
        const dn = this.live(l.from.step);
        const dl = dn?.kind === 'delivery_note' ? dn.lines[l.from.line] : undefined;
        if (dl?.from?.step === ref.step && dl.from.line === ref.line) a += amountOf(l);
      }
    }
    return roundMoney(a);
  }
  /** Billed amount of a delivery note line: invoice lines made from it, plus invoices made straight from its order
   *  line spread over that order line's delivery notes, oldest first (ERPNext, 03 §3.2). */
  private dnBilled(dn: string, line: number): number {
    const d = this.live(dn) as Extract<Doc, { kind: 'delivery_note' }>;
    const dl = d.lines[line];
    let direct = 0;
    for (const inv of this.inv()) for (const l of inv.lines) if (l.from?.step === dn && l.from.line === line) direct += amountOf(l);
    if (!dl.from) return roundMoney(direct);
    // invoices made from the order line itself (not through a delivery note)
    let pool = 0;
    for (const inv of this.inv()) for (const l of inv.lines) if (l.from?.step === dl.from.step && l.from.line === dl.from.line) pool += amountOf(l);
    if (!pool) return roundMoney(direct);
    const sibs = this.liveDocs('delivery_note').flatMap((x) => x.lines.map((l, i) => ({ dn: x.id, i, l })))
      .filter((x) => x.l.from?.step === dl.from!.step && x.l.from.line === dl.from!.line);
    for (const s of sibs) {
      let own = 0;
      for (const inv of this.inv()) for (const l of inv.lines) if (l.from?.step === s.dn && l.from.line === s.i) own += amountOf(l);
      const room = Math.max(0, amountOf(s.l) - own);
      const take = Math.min(room, pool);
      pool -= take;
      if (s.dn === dn && s.i === line) return roundMoney(direct + take);
    }
    return roundMoney(direct);
  }

  private orderedPct(q: string): number {
    const d = this.live(q)!;
    return pct(d.lines.reduce((s, l, i) => s + Math.min(this.orderedQty(q, i), l.qty), 0), d.lines.reduce((s, l) => s + l.qty, 0));
  }
  /** Every line counts, services too: ERPNext keeps an order of services at To Deliver until a delivery note is made
   *  (referee P06), so nothing skips delivery by itself. */
  private perDelivered(so: string): number {
    const d = this.live(so)!;
    return pct(d.lines.reduce((s, l, i) => s + Math.min(this.deliveredQty(so, i), l.qty), 0), d.lines.reduce((s, l) => s + l.qty, 0));
  }
  private perBilled(id: string): number {
    const d = this.live(id)!;
    const billed = (i: number) => (d.kind === 'delivery_note' ? this.dnBilled(id, i) : this.billedAmount({ step: id, line: i }));
    return pct(d.lines.reduce((s, l, i) => s + Math.min(billed(i), amountOf(l)), 0), d.lines.reduce((s, l) => s + amountOf(l), 0));
  }

  private status(p: Posted): string {
    if (p.cancelled) return 'Cancelled';
    const d = p.step;
    if (d.kind === 'quotation') {
      if (p.manual === 'Lost') return 'Lost';
      const o = this.orderedPct(d.id);
      if (o >= FULL) return 'Ordered';
      if (o > 0) return 'Partially Ordered';
      return d.validTill && d.validTill < today() ? 'Expired' : 'Open';
    }
    if (p.manual) return p.manual;
    if (d.kind === 'delivery_note') {
      const b = this.perBilled(d.id);
      return b >= FULL ? 'Completed' : b > 0 ? 'Partially Billed' : 'To Bill';
    }
    const pd = this.perDelivered(d.id), pb = this.perBilled(d.id);
    const delivered = pd >= FULL, billed = pb >= FULL;
    return delivered && billed ? 'Completed' : delivered ? 'To Bill' : billed ? 'To Deliver' : 'To Deliver and Bill';
  }

  // ---- results -----------------------------------------------------------------------------------------------

  documents(): DocResult[] {
    const out: DocResult[] = [];
    for (const id of this.order) {
      const p = this.posted.get(id);
      if (!p) continue;
      const r: DocResult = { step: id, kind: p.step.kind, status: this.status(p) };
      // a cancelled document counts nothing (ERPNext shows 0 %, referee P05)
      const live = !p.cancelled;
      if (p.step.kind === 'quotation' && live) r.perOrdered = this.orderedPct(id);
      if (p.step.kind === 'sales_order') { r.perDelivered = live ? this.perDelivered(id) : 0; r.perBilled = live ? this.perBilled(id) : 0; }
      if (p.step.kind === 'delivery_note') r.perBilled = live ? this.perBilled(id) : 0;
      const t = invoiceTotals(p.step.lines, p.step.tax, this.scenario.rounding !== false, p.step.discountAmount);
      r.totals = { netTotal: t.netTotal, vat: t.vat, grandTotal: t.grandTotal, roundedTotal: t.roundedTotal, discount: t.discount };
      if (live) r.lines = p.step.lines.map((_, i) => p.step.kind === 'quotation' ? { ordered: this.orderedQty(id, i) }
        : p.step.kind === 'sales_order' ? { delivered: this.deliveredQty(id, i), billed: this.billedAmount({ step: id, line: i }) }
        : { billed: this.dnBilled(id, i) });
      out.push(r);
    }
    return out;
  }

  /** Stock held for open orders per item + store: ordered less delivered on orders that are not closed (Bin reserved qty). */
  reserved(): { item: string; warehouse: string; qty: number }[] {
    const sum = new Map<string, number>();
    for (const p of this.posted.values()) {
      if (p.cancelled || p.step.kind !== 'sales_order' || p.manual === 'Closed') continue;
      const so = p.step;
      so.lines.forEach((l, i) => {
        if (this.services.has(l.item)) return;
        const left = Math.max(0, l.qty - this.deliveredQty(so.id, i));
        const k = `${l.item}|${so.warehouse}`;
        sum.set(k, (sum.get(k) ?? 0) + left);
      });
    }
    return [...sum].map(([k, qty]) => { const [item, warehouse] = k.split('|'); return { item, warehouse, qty }; });
  }

  /** What open orders (unless left out) and delivery notes of a customer still add to what they owe (credit check,
   *  03 §5.1). `billing`: an invoice being checked, counted as if it were posted. */
  unbilled(customer: string, withOrders = true, billing?: InvoiceView): number {
    this.billing = billing ?? null;
    try { return this.unbilledNow(customer, withOrders); } finally { this.billing = null; }
  }
  private unbilledNow(customer: string, withOrders: boolean): number {
    let total = 0;
    for (const p of this.posted.values()) {
      if (p.cancelled || p.step.customer !== customer) continue;
      const d = p.step;
      if (d.kind === 'sales_order') {
        if (!withOrders) continue;
        if (p.manual === 'Closed') continue;
        const t = invoiceTotals(d.lines, d.tax, this.scenario.rounding !== false, d.discountAmount);
        total += t.roundedTotal * (100 - this.perBilled(d.id)) / 100;
      } else if (d.kind === 'delivery_note' && d.lines.every((l) => !l.from)) {
        const t = invoiceTotals(d.lines, d.tax, this.scenario.rounding !== false, d.discountAmount);
        total += t.grandTotal * (100 - this.perBilled(d.id)) / 100;
      }
    }
    return roundMoney(total);
  }

  /** Totals of an order (for the credit check at order time). */
  totalOf(step: Doc): number { return invoiceTotals(step.lines, step.tax, this.scenario.rounding !== false).roundedTotal; }

  private fail(step: string, message: string): void { this.errors.push({ step, message }); }
}
