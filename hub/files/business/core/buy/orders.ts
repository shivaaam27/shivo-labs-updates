// Buying documents (phase 5, pos/blueprint/04-buying.md §2-§3): stock request → (supplier quotation) → purchase order
// → goods arrived → supplier bill. A request, a quotation and an order book nothing; goods arrived go through the stock
// ledger (Dr stock, Cr stock received not billed) under the same id, units refused on arrival into the rejected store
// at no value, goods sent back (a return) out at the rate they came in. Each line may point at the line it came from
// (`from`); requested, ordered, received, billed and returned are re-summed from the live documents every time
// (04 §3.2), so a cancel or a late sync can never double count.
import type { BuyStep, DocResult, MoneyLine, ReceiptLine, Scenario, SellStep, Step } from '../contract.ts';
import { roundMoney } from '../money.ts';
import type { StockLedger } from '../stock/ledger.ts';
import { invoiceTotals, lineRate } from '../money/taxes.ts';
import { inBase, rateOf, roundsTotal } from '../money/fx.ts';

export const BUY_KINDS = new Set<string>(['material_request', 'supplier_quotation', 'purchase_order', 'purchase_receipt']);
type Receipt = Extract<Step, { kind: 'purchase_receipt' }>;
type Doc = BuyStep | Receipt;
type Status = Extract<SellStep, { kind: 'set_status' }>;
interface Posted { step: Doc; cancelled: boolean; manual?: 'Closed' | 'On Hold' | 'Stopped' }
/** What the buying side needs to know about supplier bills and debit notes (money/books.ts). */
export interface BillView {
  id: string; supplier: string; lines: MoneyLine[]; updateStock: boolean; date: string; time: string;
  receipt?: string;       // the goods arrived it bills as a whole (lines matched by product)
  returnOf?: string;      // a debit note: the bill it returns
  opening?: boolean;
  totals: { net: number }[]; // net per line (after discounts, without VAT)
  rate?: number;             // TZS for 1 of its currency (fx; absent: TZS)
}

const FULL = 99.999999;   // ERPNext: >= 99.999999 % counts as fully done
const pct = (done: number, of: number) => (of ? Math.round((done / of) * 100 * 1e6) / 1e6 : 0);
const amountOf = (l: { qty: number; rate: number; discount?: number }) => roundMoney(lineRate(l as MoneyLine) * l.qty);
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export class BuyBook {
  private scenario: Scenario;
  private stock: StockLedger;
  private bills: () => BillView[];
  private services: Set<string>;
  posted = new Map<string, Posted>();
  order: string[] = [];
  errors: { step: string; message: string }[] = [];
  private billing: BillView | null = null;   // a bill being checked, counted as if posted

  constructor(scenario: Scenario, stock: StockLedger, bills: () => BillView[]) {
    this.scenario = scenario;
    this.stock = stock;
    this.bills = bills;
    this.services = new Set(scenario.items.filter((i) => i.stock === false).map((i) => i.key));
  }

  isBuy(id: string): boolean { return this.posted.has(id); }
  live(id: string): Doc | null { const p = this.posted.get(id); return p && !p.cancelled ? p.step : null; }
  private allBills(): BillView[] { return this.billing ? [...this.bills(), this.billing] : this.bills(); }

  post(step: Doc | Status): void {
    if (step.kind === 'set_status') return this.setStatus(step);
    const bad = this.check(step);
    if (bad) return this.fail(step.id, bad);
    if (step.kind === 'purchase_receipt') {
      const before = this.stock.errors.length;
      // the buying side keeps the document's currency; the stock ledger gets TZS (fx)
      this.stock.post(inBase(step));
      const err = this.stock.errors.slice(before).find((e) => e.step === step.id);
      if (err) return this.fail(step.id, err.message);
    }
    this.posted.set(step.id, { step, cancelled: false });
    this.order.push(step.id);
  }

  /** Cancel: refused while a live document was made from it (ERPNext: cancel the later one first). */
  cancel(cancelId: string, target: string, date: string, time: string): void {
    const p = this.posted.get(target);
    if (!p) return this.fail(cancelId, `Step ${target} was not posted, nothing to cancel`);
    if (p.cancelled) return this.fail(cancelId, `Step ${target} is already cancelled`);
    const child = this.childrenOf(target)[0];
    if (child) return this.fail(cancelId, `Cancel ${child} first: it was made from ${target}`);
    if (p.step.kind === 'purchase_receipt') {
      const before = this.stock.errors.length;
      this.stock.post({ id: cancelId, kind: 'cancel', date, time, target } as Step);
      const err = this.stock.errors.slice(before).find((e) => e.step === cancelId);
      if (err) return this.fail(cancelId, err.message);
    }
    p.cancelled = true;
    this.order.push(cancelId);
  }

  private childrenOf(id: string): string[] {
    const out = new Set<string>();
    for (const p of this.posted.values()) {
      if (p.cancelled) continue;
      if (p.step.lines.some((l) => l.from?.step === id) || (p.step.kind === 'purchase_receipt' && p.step.returnOf === id)) out.add(p.step.id);
    }
    for (const b of this.allBills()) if (b.receipt === id || b.lines.some((l) => l.from?.step === id)) out.add(b.id);
    return [...out];
  }

  private setStatus(step: Status): void {
    const p = this.posted.get(step.target);
    if (!p || p.cancelled) return this.fail(step.id, `${step.target} is not a live buying document`);
    const k = p.step.kind, st = step.status;
    if (st === 'Stopped' && k !== 'material_request') return this.fail(step.id, 'Only a stock request can be stopped');
    if ((st === 'Closed' || st === 'On Hold') && k !== 'purchase_order' && !(st === 'Closed' && k === 'purchase_receipt')) return this.fail(step.id, `A ${k.replace('_', ' ')} cannot be ${st.toLowerCase()}`);
    if (st === 'Lost') return this.fail(step.id, 'Only a quotation to a customer can be lost');
    if (st === 'Closed' && k === 'purchase_order' && this.status(p) === 'Completed') return this.fail(step.id, 'The order is already completed');
    if (st === 'Stopped' && ['Received', 'Transferred'].includes(this.status(p))) return this.fail(step.id, 'The request is already done');
    if (st === 'Open') {
      if (!p.manual) return this.fail(step.id, `${step.target} is not closed, held or stopped`);
      delete p.manual;
    } else p.manual = st;
    this.order.push(step.id);
  }

  // ---- checks --------------------------------------------------------------------------------------------------

  /** A supplier on hold (ERPNext on_hold, hold_type, release_date): 'all' blocks everything, 'invoices' bills,
   *  'payments' payments; until the release date (none: until released). */
  private supplierOk(key: string | undefined, what: 'invoices' | 'payments' | 'all', date: string): string | null {
    if (!key) return null;
    const p = this.scenario.parties?.find((x) => x.key === key && x.type === 'supplier');
    if (!p) return `Unknown supplier ${key}`;
    if (p.hold && (p.hold.type === 'all' || p.hold.type === what) && (!p.hold.until || date < p.hold.until)) {
      return `${key} is on hold${p.hold.until ? ` until ${p.hold.until}` : ''}`;
    }
    return null;
  }

  private check(step: Doc): string | null {
    const stores = this.scenario.warehouses;
    if (step.kind !== 'supplier_quotation' && !stores.includes(step.warehouse)) return 'Choose the store';
    if (!step.lines.length) return 'No lines';
    if (step.kind === 'purchase_order' || step.kind === 'supplier_quotation') {
      if (!step.supplier) return 'Choose the supplier';
      const h = this.supplierOk(step.supplier, 'all', step.date);
      if (h) return h;
    }
    if (step.kind === 'material_request') {
      if (step.purpose === 'transfer' && (!step.from || !stores.includes(step.from) || step.from === step.warehouse)) return 'A transfer request needs the store the goods come from (another store)';
      if (step.requiredBy && step.requiredBy < step.date) return 'Required by cannot be before the request date';
    }
    if (step.kind === 'purchase_order' && step.requiredBy && step.requiredBy < step.date) return 'Required by cannot be before the order date';
    if (step.kind === 'supplier_quotation' && step.validTill && step.validTill < step.date) return 'Valid till cannot be before the quotation date';
    if (step.kind === 'purchase_receipt') return this.checkReceipt(step);
    for (const [i, l] of step.lines.entries()) {
      if (!(l.qty > 0) || !(l.rate >= 0)) return `Line ${i + 1}: quantity above 0 and a price of 0 or more`;
      if (l.from) { const bad = this.lineSource(step, l, i); if (bad) return bad; }
    }
    if (step.kind === 'purchase_order') {
      // the smallest quantity a product may be ordered in (Item min_order_qty), per product on the order
      for (const it of this.scenario.items) {
        if (!it.minOrderQty) continue;
        const q = step.lines.filter((l) => l.item === it.key).reduce((s, l) => s + l.qty, 0);
        if (q > 0 && q < it.minOrderQty) return `${it.key}: at least ${it.minOrderQty} must be ordered (${q} on the order)`;
      }
    }
    return null;
  }

  /** A line made from another buying document: the right kind, still open, not more than is left. */
  private lineSource(step: Doc, l: MoneyLine | ReceiptLine, i: number): string | null {
    const src = this.posted.get(l.from!.step);
    const want = step.kind === 'purchase_order' ? ['material_request', 'supplier_quotation'] : step.kind === 'supplier_quotation' ? ['material_request'] : ['purchase_order'];
    if (!src || src.cancelled || !want.includes(src.step.kind)) return `Line ${i + 1}: ${l.from!.step} is not a live ${want.join(' or ').replaceAll('_', ' ')}`;
    const sl = src.step.lines[l.from!.line];
    if (!sl || sl.item !== l.item) return `Line ${i + 1}: no such line ${l.from!.line + 1} of ${src.step.id}`;
    const st = this.status(src);
    if (st === 'Closed' || st === 'On Hold' || st === 'Stopped') return `${src.step.id} is ${st.toLowerCase()}`;
    const s = src.step;
    if (s.kind === 'supplier_quotation') {
      if ('supplier' in step && step.supplier !== s.supplier) return `Line ${i + 1}: ${s.id} is from another supplier`;
      if (s.validTill && s.validTill < step.date) return `${s.id} expired on ${s.validTill}`;
    }
    if (s.kind === 'material_request') {
      if (s.purpose !== 'purchase') return `${s.id} asks for a move between stores, not a purchase`;
      if (step.kind === 'purchase_order') {
        // not more than requested, over the request allowance (Stock Settings mr_qty_allowance)
        const allow = 1 + (this.scenario.requestAllowance ?? 0) / 100;
        const done = this.requestOrdered(s.id, l.from!.line);
        if (done + l.qty > sl.qty * allow + 1e-9) return `${l.item}: ${done + l.qty} would be ordered, only ${sl.qty} requested on ${s.id}`;
      }
    }
    if (s.kind === 'purchase_order') {
      if ('supplier' in step && step.supplier && step.supplier !== s.supplier) return `Line ${i + 1}: ${s.id} is from another supplier`;
      if (this.scenario.sameRate === 'stop' && Math.abs(lineRate(l as MoneyLine) - lineRate(sl)) > 0.001) return `Line ${i + 1}: the rate must stay ${lineRate(sl)} as on ${s.id}`;
    }
    return null;
  }

  private checkReceipt(step: Receipt): string | null {
    const stores = this.scenario.warehouses;
    if (step.returnOf) {
      const pr = this.posted.get(step.returnOf);
      if (!pr || pr.cancelled || pr.step.kind !== 'purchase_receipt' || pr.step.returnOf) return `${step.returnOf} is not live goods arrived`;
      if ((pr.step.supplier ?? '') !== (step.supplier ?? '')) return `${step.returnOf} is from another supplier`;
      if (`${step.date} ${step.time}` < `${pr.step.date} ${pr.step.time}`) return 'A return cannot be dated before the goods arrived';
      for (const [i, l] of step.lines.entries()) {
        if (l.from?.step !== step.returnOf) return `Line ${i + 1}: a return names the goods-arrived line it sends back`;
        const ol = pr.step.lines[l.from.line];
        if (!ol || ol.item !== l.item) return `Line ${i + 1}: no such line ${l.from.line + 1} on ${step.returnOf}`;
        if (!(l.qty > 0)) return `Line ${i + 1}: quantity above 0`;
        const left = ol.qty - this.returnedQty(step.returnOf, l.from.line);
        if (l.qty > left + 1e-9) return `${l.item}: only ${left} left to return on ${step.returnOf}`;
      }
      return null;
    }
    if (step.supplier) { const h = this.supplierOk(step.supplier, 'all', step.date); if (h) return h; }
    if (step.lines.some((l) => (l.rejected ?? 0) > 0)) {
      if (!step.rejectedWarehouse || !stores.includes(step.rejectedWarehouse)) return 'Choose the store for refused goods';
      if (step.rejectedWarehouse === step.warehouse) return 'Refused goods go to another store than the accepted ones';
    }
    for (const [i, l] of step.lines.entries()) {
      if (!((l.rejected ?? 0) >= 0)) return `Line ${i + 1}: refused cannot be below 0`;
      if (this.scenario.poRequired && !l.from) return `Line ${i + 1}: a purchase order is needed (Buying settings)`;
      if (!l.from) continue;
      const bad = this.lineSource(step, l, i);
      if (bad) return bad;
      // over-receipt (04 §2.4): everything received on the order line (accepted + refused) against what was ordered
      const po = this.posted.get(l.from.step)!.step;
      const ol = po.lines[l.from.line];
      if (this.services.has(l.item)) continue;
      const allow = 1 + this.allowance(l.item, 'overDelivery') / 100;
      const got = this.receivedQty(po.id, l.from.line) + l.qty + (l.rejected ?? 0)
        + step.lines.filter((x, k) => k < i && x.from?.step === po.id && x.from.line === l.from!.line).reduce((s, x) => s + x.qty + (x.rejected ?? 0), 0);
      if (got > ol.qty * allow + 1e-9) return `${l.item}: ${got} would be received, only ${ol.qty} ordered on ${po.id}`;
    }
    return null;
  }

  /** A bill line made from an order or goods arrived (money/books.ts asks before posting). */
  checkBillLine(supplier: string, l: MoneyLine, i: number, updateStock: boolean): string | null {
    const src = this.posted.get(l.from!.step);
    if (!src || src.cancelled || (src.step.kind !== 'purchase_order' && src.step.kind !== 'purchase_receipt') || (src.step as Receipt).returnOf) return `Line ${i + 1}: ${l.from!.step} is not a live purchase order or goods arrived`;
    const s = src.step;
    if ((s.kind === 'purchase_order' ? s.supplier : s.supplier ?? supplier) !== supplier) return `Line ${i + 1}: ${s.id} is from another supplier`;
    const sl = s.lines[l.from!.line];
    if (!sl || sl.item !== l.item) return `Line ${i + 1}: no such line ${l.from!.line + 1} of ${s.id}`;
    const st = this.status(src);
    if (st === 'Closed' || st === 'On Hold') return `${s.id} is ${st.toLowerCase()}`;
    if (s.kind === 'purchase_receipt' && updateStock && !this.services.has(l.item)) return `${l.item} already arrived on ${s.id}; the bill cannot bring it in again`;
    if (s.kind === 'purchase_order' && this.scenario.sameRate === 'stop' && Math.abs(lineRate(l) - lineRate(sl as MoneyLine)) > 0.001) return `Line ${i + 1}: the rate must stay ${lineRate(sl as MoneyLine)} as on ${s.id}`;
    const allow = 1 + this.allowance(l.item, 'overBilling') / 100;
    const billed = s.kind === 'purchase_order' ? this.poBilled(s.id, l.from!.line) : this.prBilled(s.id, l.from!.line);
    const due = s.kind === 'purchase_order' ? amountOf(sl) : this.prDue(s as Receipt, l.from!.line);
    // also when the bill's price re-values the goods: ERPNext still needs an over-billing allowance (referee B12)
    if (billed + amountOf(l) > due * allow + 0.001)
      return `${l.item}: billing ${roundMoney(billed + amountOf(l))} is more than ${due} on ${s.id}`;
    if (s.kind === 'purchase_order' && updateStock && !this.services.has(l.item)) {
      const got = this.receivedQty(s.id, l.from!.line);
      if (got + l.qty > sl.qty * (1 + this.allowance(l.item, 'overDelivery') / 100) + 1e-9) return `${l.item}: ${got + l.qty} would be received, only ${sl.qty} ordered`;
    }
    return null;
  }

  /** Buying settings on a whole bill: an order needed, goods arrived needed (for goods). */
  checkBill(bill: BillView): string | null {
    if (bill.opening || bill.returnOf) return null;
    const hold = this.supplierOk(bill.supplier, 'invoices', bill.date);
    if (hold) return hold;
    for (const [i, l] of bill.lines.entries()) {
      const src = l.from ? this.live(l.from.step) : bill.receipt ? this.live(bill.receipt) : null;
      const party = this.scenario.parties?.find((x) => x.key === bill.supplier);
      if (this.scenario.poRequired && !party?.billWithoutOrder && !(src?.kind === 'purchase_order' || (src?.kind === 'purchase_receipt' && (bill.receipt ? src.lines.some((x) => x.item === l.item && x.from) : src.lines[l.from!.line]?.from))))
        return `Line ${i + 1}: a purchase order is needed (Buying settings)`;
      if (this.scenario.prRequired && !party?.billWithoutReceipt && !this.services.has(l.item) && !bill.updateStock && src?.kind !== 'purchase_receipt')
        return `Line ${i + 1}: goods arrived are needed before the bill (Buying settings)`;
    }
    return null;
  }

  /** A stock move whose lines fill a stock request (04 §2.1): the request is a live move request between these stores,
   *  not stopped, and not more is moved than asked for (over the request allowance). Refused: true (error recorded). */
  checkTransfer(step: Extract<Step, { kind: 'transfer' }>): boolean {
    for (const [i, l] of step.lines.entries()) {
      if (!l.from) continue;
      const p = this.posted.get(l.from.step);
      const mr = p && !p.cancelled && p.step.kind === 'material_request' ? p.step : null;
      const bad = !mr ? `Line ${i + 1}: ${l.from.step} is not a live stock request`
        : mr.purpose !== 'transfer' ? `${mr.id} asks to buy, not to move between stores`
        : p!.manual === 'Stopped' ? `${mr.id} is stopped`
        : mr.lines[l.from.line]?.item !== l.item ? `Line ${i + 1}: no such line ${l.from.line + 1} of ${mr.id}`
        : this.requestOrdered(mr.id, l.from.line) + l.qty > mr.lines[l.from.line].qty * (1 + (this.scenario.requestAllowance ?? 0) / 100) + 1e-9
          ? `${l.item}: ${this.requestOrdered(mr.id, l.from.line) + l.qty} would be moved, only ${mr.lines[l.from.line].qty} asked for on ${mr.id}` : null;
      if (bad) { this.fail(step.id, bad); return true; }
    }
    return false;
  }

  /** Supplier on hold for payments (money/books.ts asks before a payment out). */
  paymentHold(supplier: string, date: string): string | null { return this.supplierOk(supplier, 'payments', date); }

  // ---- counters (re-summed, 04 §3.2) ---------------------------------------------------------------------------

  private liveDocs<K extends Doc['kind']>(kind: K): Extract<Doc, { kind: K }>[] {
    return [...this.posted.values()].filter((p) => !p.cancelled && p.step.kind === kind).map((p) => p.step as Extract<Doc, { kind: K }>);
  }
  private receipts(): Receipt[] { return this.liveDocs('purchase_receipt').filter((r) => !r.returnOf); }

  /** Ordered on a request line: purchase orders made from it (or, a transfer request, moved by stock transfers). */
  requestOrdered(mr: string, line: number): number {
    let q = 0;
    for (const o of this.liveDocs('purchase_order')) for (const l of o.lines) {
      if (l.from?.step === mr && l.from.line === line) q += l.qty;
      // ordered through a supplier quotation made from the request (the order line keeps the request's link)
      const sq = l.from ? this.live(l.from.step) : null;
      if (sq?.kind === 'supplier_quotation' && sq.lines[l.from!.line]?.from?.step === mr && sq.lines[l.from!.line].from!.line === line) q += l.qty;
    }
    for (const id of this.stock.order) {
      const p = this.stock.posted.get(id);
      if (!p || p.cancelled || p.step.kind !== 'transfer') continue;
      for (const l of p.step.lines) if ((l as { from?: { step: string; line: number } }).from?.step === mr && (l as { from?: { line: number } }).from!.line === line) q += l.qty;
    }
    return q;
  }
  /** Received on a request line: goods arrived on the order lines made from it (accepted). */
  private requestReceived(mr: string, line: number): number {
    let q = 0;
    for (const o of this.liveDocs('purchase_order')) o.lines.forEach((l, i) => {
      const sq = l.from ? this.live(l.from.step) : null;
      const via = sq?.kind === 'supplier_quotation' ? sq.lines[l.from!.line]?.from : l.from;
      if (via?.step === mr && via.line === line) q += this.acceptedQty(o.id, i);
    });
    return q;
  }
  /** Accepted on an order line (goods arrived and stock-moving bills made from it, less returns). */
  private acceptedQty(po: string, line: number): number {
    let q = 0;
    for (const r of this.receipts()) r.lines.forEach((l, i) => { if (l.from?.step === po && l.from.line === line) q += l.qty - this.returnedQty(r.id, i); });
    for (const b of this.allBills()) if (b.updateStock && !b.returnOf) for (const l of b.lines) if (l.from?.step === po && l.from.line === line) q += l.qty;
    return q;
  }
  /** Received on an order line: accepted + refused (ERPNext received_qty), less what went back. */
  receivedQty(po: string, line: number): number {
    let q = this.acceptedQty(po, line);
    for (const r of this.receipts()) for (const l of r.lines) if (l.from?.step === po && l.from.line === line) q += l.rejected ?? 0;
    return q;
  }
  private rejectedQty(po: string, line: number): number {
    let q = 0;
    for (const r of this.receipts()) for (const l of r.lines) if (l.from?.step === po && l.from.line === line) q += l.rejected ?? 0;
    return q;
  }
  /** Sent back on a goods-arrived line (live returns made from it). */
  returnedQty(pr: string, line: number): number {
    let q = 0;
    for (const r of this.liveDocs('purchase_receipt')) if (r.returnOf === pr) for (const l of r.lines) if (l.from?.line === line) q += l.qty;
    return q;
  }
  private returnedOnOrder(po: string, line: number): number {
    let q = 0;
    for (const r of this.receipts()) r.lines.forEach((l, i) => { if (l.from?.step === po && l.from.line === line) q += this.returnedQty(r.id, i); });
    return q;
  }
  /** Bill lines that bill a goods-arrived line: made from it, or a bill of the whole receipt matched by product. */
  private billLinesOf(pr: Receipt, line: number): { bill: BillView; i: number }[] {
    const out: { bill: BillView; i: number }[] = [];
    for (const b of this.allBills()) {
      if (b.returnOf) continue;
      b.lines.forEach((l, i) => {
        if (l.from?.step === pr.id && l.from.line === line) out.push({ bill: b, i });
        else if (!l.from && b.receipt === pr.id) {
          // a whole-receipt bill: its n-th line of a product bills the receipt's n-th line of it
          const nth = b.lines.slice(0, i).filter((x) => !x.from && x.item === l.item).length;
          const idx = pr.lines.map((x, k) => (x.item === l.item ? k : -1)).filter((k) => k >= 0)[nth];
          if (idx === line) out.push({ bill: b, i });
        }
      });
    }
    return out;
  }
  /** Billed amount on a goods-arrived line, less debit notes on those bills (like a delivery note, referee P12). */
  prBilled(pr: string, line: number): number {
    const r = this.live(pr) as Receipt;
    let a = 0;
    for (const { bill, i } of this.billLinesOf(r, line)) {
      a += amountOf(bill.lines[i]);
      for (const dn of this.allBills()) if (dn.returnOf === bill.id) for (const x of dn.lines) if (x.item === bill.lines[i].item) a -= Math.min(amountOf(x), amountOf(bill.lines[i]));
    }
    return roundMoney(a);
  }
  /** What a goods-arrived line has to be billed: accepted less returned (refused too, if they are billed). */
  private prDue(r: Receipt, line: number): number {
    const l = r.lines[line];
    return roundMoney(l.rate * Math.max(0, l.qty - this.returnedQty(r.id, line) + (this.scenario.billRejected ? l.rejected ?? 0 : 0)));
  }
  /** Billed amount of an order line: bill lines made from it, directly or through goods arrived made from it. */
  poBilled(po: string, line: number): number {
    let a = 0;
    for (const b of this.allBills()) {
      if (b.returnOf) continue;
      for (const l of b.lines) if (l.from?.step === po && l.from.line === line) a += amountOf(l);
    }
    for (const r of this.receipts()) r.lines.forEach((l, i) => { if (l.from?.step === po && l.from.line === line) for (const x of this.billLinesOf(r, i)) a += amountOf(x.bill.lines[x.i]); });
    return roundMoney(a);
  }
  private sqOrdered(sq: string, line: number): number {
    let q = 0;
    for (const o of this.liveDocs('purchase_order')) for (const l of o.lines) if (l.from?.step === sq && l.from.line === line) q += l.qty;
    return q;
  }

  private perOf(id: string, done: (i: number) => number, of: (l: MoneyLine | ReceiptLine, i: number) => number): number {
    const d = this.live(id)!;
    return pct(d.lines.reduce((s, l, i) => s + Math.min(done(i), of(l, i)), 0), d.lines.reduce((s, l, i) => s + of(l, i), 0));
  }
  private perReceived(id: string): number {
    const d = this.live(id)!;
    return d.kind === 'material_request' ? this.perOf(id, (i) => this.requestReceived(id, i), (l) => l.qty) : this.perOf(id, (i) => this.receivedQty(id, i), (l) => l.qty);
  }
  private perBilled(id: string): number {
    const d = this.live(id)!;
    if (d.kind === 'purchase_receipt') return this.perOf(id, (i) => this.prBilled(id, i), (_, i) => this.prDue(d, i));
    return this.perOf(id, (i) => this.poBilled(id, i), (l) => amountOf(l));
  }

  private status(p: Posted): string {
    if (p.cancelled) return 'Cancelled';
    const d = p.step;
    if (p.manual) return p.manual;
    if (d.kind === 'supplier_quotation') {
      if (d.validTill && d.validTill < today()) return 'Expired';
      return 'Submitted';
    }
    if (d.kind === 'material_request') {
      const o = this.perOf(d.id, (i) => this.requestOrdered(d.id, i), (l) => l.qty);
      if (d.purpose === 'transfer') return o >= FULL ? 'Transferred' : o > 0 ? 'Partially Received' : 'Pending';
      // ERPNext looks at ordering first: received counts only once all of it is ordered (referee B07)
      if (o <= 0) return 'Pending';
      if (o < FULL) return 'Partially Ordered';
      const r = this.perReceived(d.id);
      return r >= FULL ? 'Received' : r > 0 ? 'Partially Received' : 'Ordered';
    }
    if (d.kind === 'purchase_receipt') {
      if (d.returnOf) return 'Return';
      if (this.perOf(d.id, (i) => this.returnedQty(d.id, i), (l) => l.qty) >= FULL) return 'Return Issued';
      const b = this.perBilled(d.id);
      return b >= FULL ? 'Completed' : b > 0 ? 'Partly Billed' : 'To Bill';
    }
    const r = this.perReceived(d.id) >= FULL, b = this.perBilled(d.id) >= FULL;
    return r && b ? 'Completed' : r ? 'To Bill' : b ? 'To Receive' : 'To Receive and Bill';
  }

  // ---- results -------------------------------------------------------------------------------------------------

  /** Per unit, what bills charged above (below) a goods-arrived line's rate, when the bill's price sets the cost (04 §5.3):
   *  each bill line's net price per unit less the line's rate, times what it billed, spread over the line's units. */
  billDiff(pr: string, line: number): number {
    if (!this.scenario.billRateRevalues) return 0;
    const r = this.live(pr);
    if (!r || r.kind !== 'purchase_receipt' || r.returnOf) return 0;
    const l = r.lines[line];
    if (!l?.qty) return 0;
    let diff = 0;
    for (const { bill, i } of this.billLinesOf(r, line)) {
      const q = bill.lines[i].qty;
      if (q) diff += (bill.totals[i].net / q - l.rate) * q;
    }
    return (diff / l.qty) * rateOf(r);   // per unit in TZS (fx)
  }

  /** Advances paid against an order (set by run.ts from the books). */
  advanceOf: (order: string) => number = () => 0;

  documents(): DocResult[] {
    const out: DocResult[] = [];
    for (const id of this.order) {
      const p = this.posted.get(id);
      if (!p) continue;
      const r: DocResult = { step: id, kind: p.step.kind, status: this.status(p) };
      const live = !p.cancelled, d = p.step;
      if (d.kind === 'material_request') { r.perOrdered = live ? this.perOf(id, (i) => this.requestOrdered(id, i), (l) => l.qty) : 0; if (d.purpose === 'purchase') r.perReceived = live ? this.perReceived(id) : 0; }
      if (d.kind === 'purchase_order') { r.perReceived = live ? this.perReceived(id) : 0; r.perBilled = live ? this.perBilled(id) : 0; r.advancePaid = live ? this.advanceOf(id) : 0; }
      if (d.kind === 'purchase_receipt' && !d.returnOf) { r.perBilled = live ? this.perBilled(id) : 0; r.perReturned = live ? this.perOf(id, (i) => this.returnedQty(id, i), (l) => l.qty) : 0; }
      if (d.kind !== 'material_request') {
        const t = invoiceTotals(d.lines as MoneyLine[], (d as { tax?: Parameters<typeof invoiceTotals>[1] }).tax, roundsTotal(d as Parameters<typeof roundsTotal>[0], this.scenario.rounding !== false), (d as { discountAmount?: number }).discountAmount);
        r.totals = { netTotal: t.netTotal, vat: t.vat, grandTotal: t.grandTotal, roundedTotal: t.roundedTotal, discount: t.discount };
      }
      if (live) r.lines = d.lines.map((_, i) => d.kind === 'material_request' ? { ordered: this.requestOrdered(id, i), received: this.requestReceived(id, i) }
        : d.kind === 'supplier_quotation' ? { ordered: this.sqOrdered(id, i) }
        : d.kind === 'purchase_order' ? { received: this.receivedQty(id, i), rejected: this.rejectedQty(id, i), billed: this.poBilled(id, i), returned: this.returnedOnOrder(id, i) }
        : d.returnOf ? {} : { billed: this.prBilled(id, i), returned: this.returnedQty(id, i) });
      out.push(r);
    }
    return out;
  }

  /** Goods on open orders not received yet, per item + store (Bin ordered_qty); closed orders count nothing. */
  ordered(): { item: string; warehouse: string; qty: number }[] {
    const sum = new Map<string, number>();
    for (const p of this.posted.values()) {
      if (p.cancelled || p.step.kind !== 'purchase_order' || p.manual === 'Closed') continue;
      const o = p.step;
      o.lines.forEach((l, i) => {
        if (this.services.has(l.item)) return;
        const k = `${l.item}|${o.warehouse}`;
        sum.set(k, (sum.get(k) ?? 0) + Math.max(0, l.qty - this.receivedQty(o.id, i)));
      });
    }
    return [...sum].map(([k, qty]) => { const [item, warehouse] = k.split('|'); return { item, warehouse, qty }; });
  }

  /** Goods asked for on open stock requests not ordered (or moved) yet, per item + store (Bin indented_qty). */
  requested(): { item: string; warehouse: string; qty: number }[] {
    const sum = new Map<string, number>();
    for (const p of this.posted.values()) {
      if (p.cancelled || p.step.kind !== 'material_request' || p.manual === 'Stopped') continue;
      const m = p.step;
      m.lines.forEach((l, i) => {
        if (this.services.has(l.item)) return;
        const k = `${l.item}|${m.warehouse}`;
        sum.set(k, (sum.get(k) ?? 0) + Math.max(0, l.qty - this.requestOrdered(m.id, i)));
      });
    }
    return [...sum].map(([k, qty]) => { const [item, warehouse] = k.split('|'); return { item, warehouse, qty }; });
  }

  /** The last purchase rate of each product (Item last_purchase_rate, 04 §4): the newest live order, goods arrived or
   *  bill line by its date, per stock unit, net of discounts and without VAT; a cancel brings the one before back. */
  lastPurchase(): { item: string; rate: number }[] {
    const best = new Map<string, { at: string; seq: number; rate: number }>();
    let seq = 0;
    const take = (item: string, at: string, rate: number) => {
      seq++;
      const b = best.get(item);
      if (!b || at > b.at || (at === b.at && seq > b.seq)) best.set(item, { at, seq, rate });
    };
    for (const id of this.order) {
      const d = this.live(id);
      if (!d || d.kind === 'material_request' || d.kind === 'supplier_quotation' || (d.kind === 'purchase_receipt' && d.returnOf)) continue;
      // in TZS (fx: a document in another currency at its rate)
      if (d.kind === 'purchase_receipt') { for (const l of d.lines) take(l.item, d.date, roundMoney(l.rate * rateOf(d))); continue; }
      const t = invoiceTotals(d.lines, d.tax, roundsTotal(d, this.scenario.rounding !== false), d.discountAmount);
      d.lines.forEach((l, i) => take(l.item, d.date, roundMoney((t.lines[i].net / l.qty) * rateOf(d))));
    }
    // goods arrived the old way (no buying side: stock-only stories) still count
    for (const id of this.stock.order) {
      const p = this.stock.posted.get(id);
      if (!p || p.cancelled || p.step.kind !== 'purchase_receipt' || this.posted.has(id) || p.step.returnOf) continue;
      for (const l of p.step.lines) take(l.item, p.step.date, l.rate);
    }
    for (const b of this.allBills()) {
      if (b.opening || b.returnOf) continue;
      b.lines.forEach((l, i) => { if (l.qty) take(l.item, b.date, roundMoney((b.totals[i].net / l.qty) * (b.rate ?? 1))); });
    }
    return [...best].filter(([k]) => !this.services.has(k)).map(([item, b]) => ({ item, rate: b.rate }));
  }

  /** Bills as if this one were posted (for checks that count it). */
  withBill<T>(bill: BillView, f: () => T): T {
    this.billing = bill;
    try { return f(); } finally { this.billing = null; }
  }

  /** % a product may go over what was ordered: its own allowance, else the scenario's (ERPNext Item, then settings). */
  private allowance(item: string, kind: 'overDelivery' | 'overBilling'): number {
    return this.scenario.items.find((i) => i.key === item)?.[kind] ?? this.scenario[kind] ?? 0;
  }

  private fail(step: string, message: string): void { this.errors.push({ step, message }); }
}
