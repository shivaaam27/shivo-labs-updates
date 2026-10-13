// The money side (01 §2, §3, §4, §7): sales and purchase invoices, payments, credit notes, transfers between own
// accounts and journals. Each posted step writes ledger rows (debit and credit kept apart, as the referee reads
// them) and party-ledger rows (which invoice each shilling belongs to, 01 §3). Goods that an invoice moves go
// through the stock ledger as a step with the same id; their cost is read from the stock rows at the end, so a
// back-dated stock step also corrects the cost of goods sold on a later invoice (as for deliveries, 02 §4.4).
import type { AccountRole, Entry, InvoiceResult, LedgerTotal, MoneyAccount, MoneyLine, MoneyStep, Scenario, Step } from '../contract.ts';
import { roundMoney } from '../money.ts';
import type { StockLedger } from '../stock/ledger.ts';
import type { Totals } from './taxes.ts';
import { invoiceTotals, lineRate } from './taxes.ts';
import type { InvoiceView, SalesBook } from '../sell/orders.ts';

type Kind = MoneyStep['kind'];
export const MONEY_KINDS = new Set<string>(['sales_invoice', 'purchase_invoice', 'payment', 'credit_note', 'money_transfer', 'journal', 'reconcile']);

interface Gl { role: AccountRole; debit: number; credit: number; party?: string; ref?: string }   // ref: our own account id, when the document names one
interface Ple { party: string; against: string; amount: number }   // + = owed (customer owes us / we owe the supplier)
interface Invoice {
  step: Extract<MoneyStep, { kind: 'sales_invoice' | 'purchase_invoice' | 'credit_note' }>;
  party: string;
  side: 'customer' | 'supplier';
  totals: Totals;
  dueDate: string;
  returnOf?: string;      // credit note: the invoice it returns
  owedAtCancel?: number;  // a cancelled invoice keeps showing what was owed when it was cancelled (referee M11)
  stock: 'out' | 'in' | null; // goods moved with it (cost read from the stock rows)
}
interface Posted { step: MoneyStep; gl: Gl[]; ple: Ple[]; cancelled: boolean }

const ACCOUNT_ROLE: Record<MoneyAccount, AccountRole> = { cash: 'cash', bank: 'bank', mobile_money: 'mobile_money' };

/** Dar es Salaam date today (UTC+3): invoices past their due date are Overdue, as ERPNext judges by today. */
function today(): string { return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); }

export class MoneyBook {
  readonly scenario: Scenario;
  private stock: StockLedger;
  private parties = new Map<string, 'customer' | 'supplier'>();
  private items: Set<string>;
  private services: Set<string>;               // items that never move stock (delivery charge, transport, rent)
  private limits = new Map<string, number>();  // customer -> credit limit (none if absent or 0)
  private atInvoice = new Set<string>();       // customers checked at delivery and invoice, not at order (03 §5.2 bypass)
  posted = new Map<string, Posted>();
  /** The selling side (orders, delivery notes), set by run.ts: invoice lines may bill their lines. */
  sales: SalesBook | null = null;
  order: string[] = [];
  invoices = new Map<string, Invoice>();
  errors: { step: string; message: string }[] = [];
  private rounding: boolean;

  constructor(scenario: Scenario, stock: StockLedger) {
    this.scenario = scenario;
    this.stock = stock;
    for (const p of scenario.parties ?? []) {
      this.parties.set(p.key, p.type);
      if (p.creditLimit && p.creditLimit > 0) this.limits.set(p.key, p.creditLimit);
      if (p.creditAtInvoice) this.atInvoice.add(p.key);
    }
    this.items = new Set(scenario.items.map((i) => i.key));
    this.services = new Set(scenario.items.filter((i) => i.stock === false).map((i) => i.key));
    this.rounding = scenario.rounding !== false;
  }

  isMoney(id: string): boolean { return this.posted.has(id); }

  post(step: MoneyStep): void {
    const bad = this.check(step);
    if (bad) return this.fail(step.id, bad);
    switch (step.kind) {
      case 'sales_invoice': return this.salesInvoice(step);
      case 'purchase_invoice': return this.purchaseInvoice(step);
      case 'credit_note': return this.creditNote(step);
      case 'payment': return this.payment(step);
      case 'money_transfer': return this.keep(step, [at(dr(ACCOUNT_ROLE[step.to], step.amount), step.toRef), at(cr(ACCOUNT_ROLE[step.from], step.amount), step.fromRef)], []);
      case 'journal': return this.journal(step);
      case 'reconcile': return this.keep(step, [], step.allocations.flatMap((a) => [
        { party: step.party, against: a.invoice, amount: -a.amount }, { party: step.party, against: a.from, amount: a.amount }]));
    }
  }

  /** Cancel a money step (01 §2.6): its ledger rows stop counting; payments allocated to a cancelled invoice become credit again (R12). */
  cancel(cancelId: string, target: string, date: string, time: string): void {
    const p = this.posted.get(target);
    if (!p) return this.fail(cancelId, `Step ${target} was not posted, nothing to cancel`);
    if (p.cancelled) return this.fail(cancelId, `Step ${target} is already cancelled`);
    const inv = this.invoices.get(target);
    if (inv?.stock) this.stock.post({ id: `${cancelId}:stock`, kind: 'cancel', date, time, target } as Step);
    if (inv) inv.owedAtCancel = this.outstanding(target);
    p.cancelled = true;
    if (inv) {
      // unlink: rows of other steps pointing at this invoice now point at their own step (unallocated credit)
      for (const other of this.posted.values()) {
        if (other.cancelled) continue;
        for (const row of other.ple) if (row.against === target && other.step.id !== target) row.against = other.step.id;
      }
    }
    this.order.push(cancelId);
  }

  // ---- documents -------------------------------------------------------------------------------------------

  private salesInvoice(step: Extract<MoneyStep, { kind: 'sales_invoice' }>): void {
    const t = invoiceTotals(step.lines, step.tax, this.rounding, step.discountAmount);
    const pays = (step.payments ?? []).filter((p) => p.amount > 0);
    const paid = roundMoney(pays.reduce((s, p) => s + p.amount, 0));
    const change = paid > t.roundedTotal && pays.some((p) => p.account === 'cash') ? roundMoney(paid - t.roundedTotal) : 0;
    const left = roundMoney(t.roundedTotal - paid + change);
    // credit limit (03 §5.1-5.2, referee M18): refused when what the customer owes would go above the limit. Ours only
    // checks a sale that adds to what is owed (ERPNext also blocks a fully paid sale of a customer already over it).
    // an invoice made wholly from orders or delivery notes was checked there (03 §5.2), unless the customer is checked
    // at the invoice (bypass at the order). What the invoice bills no longer counts as open orders or deliveries.
    const adds = step.writeOff || (!this.atInvoice.has(step.customer) && step.lines.every((l) => l.from)) ? 0 : left;
    if (adds > 0 && !step.creditOk) {
      const msg = this.creditFor(step.customer, adds, { id: step.id, customer: step.customer, lines: step.lines, updateStock: !!step.updateStock, date: step.date });
      if (msg) return this.fail(step.id, msg);
    }
    const low = this.belowCost(step.lines, step.tax, step.discountAmount, step.updateStock ? step.warehouse : undefined, step.date, step.time);
    if (low) return this.fail(step.id, low);
    const goods = this.goods(step.lines);
    const moves = !!step.updateStock && !step.opening && goods.length > 0;
    if (moves && !this.moveStock(step.id, step, 'out', step.warehouse, goods)) return;
    const gl: Gl[] = [dr('receivable', t.roundedTotal, step.customer)];
    if (t.vat) gl.push(cr('vat', t.vat));
    gl.push(cr(step.opening ? 'temporary_opening' : 'income', t.netTotal));
    const ple: Ple[] = [{ party: step.customer, against: step.id, amount: t.roundedTotal }];
    // paid at the till (01 §7.3): each payment settles the invoice; cash above the total is change
    for (const p of pays) {
      gl.push(cr('receivable', p.amount, step.customer), at(dr(ACCOUNT_ROLE[p.account], p.amount), p.ref));
      ple.push({ party: step.customer, against: step.id, amount: -p.amount });
    }
    if (change) {
      gl.push(dr('receivable', change, step.customer), at(cr('cash', change), pays.find((p) => p.account === 'cash')?.ref));
      ple.push({ party: step.customer, against: step.id, amount: change });
    }
    if (step.writeOff && left > 0) {
      gl.push(cr('receivable', left, step.customer), dr('write_off', left));
      ple.push({ party: step.customer, against: step.id, amount: -left });
    }
    this.invoices.set(step.id, { step, party: step.customer, side: 'customer', totals: t, dueDate: lastDue(step), stock: moves ? 'out' : null });
    this.keep(step, balance(gl), ple);
  }

  private purchaseInvoice(step: Extract<MoneyStep, { kind: 'purchase_invoice' }>): void {
    const t = invoiceTotals(step.lines, step.tax, this.rounding, step.discountAmount);
    const paidNow = roundMoney((step.payments ?? []).reduce((s, p) => s + p.amount, 0));
    if (paidNow > t.roundedTotal) return this.fail(step.id, `Paid ${paidNow} is more than the bill (${t.roundedTotal})`);
    const moves = !!step.updateStock && !step.opening && !step.receipt && this.goods(step.lines).length > 0;
    if (moves) {
      // goods come in at their net cost after discounts; services on the same bill are expenses (referee M15)
      const idx = step.lines.map((_, i) => i).filter((i) => !this.services.has(step.lines[i].item));
      const goods = idx.map((i) => ({ item: step.lines[i].item, qty: step.lines[i].qty, rate: t.lines[i].net / step.lines[i].qty }));
      this.stock.billSteps.add(step.id);
      if (!this.moveStock(step.id, step, 'in', step.warehouse, goods)) return;
    }
    // what each line is: an opening balance, a service or expense, goods coming in now (stock), or goods already
    // received or still to come (01 §7.5, stock received not billed: the goods' receipt clears it, referee M23)
    const gl: Gl[] = [cr('payable', t.roundedTotal, step.supplier)];
    step.lines.forEach((l, i) => {
      const role: AccountRole = step.opening ? 'temporary_opening' : this.services.has(l.item) ? 'expense'
        : moves ? 'stock' : 'stock_received_not_billed';
      gl.push(at(dr(role, t.lines[i].net), role === 'expense' ? l.account : undefined));
    });
    if (t.vat) gl.push(dr('vat', t.vat));
    const ple: Ple[] = [{ party: step.supplier, against: step.id, amount: t.roundedTotal }];
    // paid at once (a cash purchase, ERPNext "Is Paid", referee M24): the bill is settled from the money account
    for (const p of (step.payments ?? []).filter((x) => x.amount > 0)) {
      gl.push(dr('payable', p.amount, step.supplier), at(cr(ACCOUNT_ROLE[p.account], p.amount), p.ref));
      ple.push({ party: step.supplier, against: step.id, amount: -p.amount });
    }
    this.invoices.set(step.id, { step, party: step.supplier, side: 'supplier', totals: t, dueDate: lastDue(step), stock: moves ? 'in' : null });
    this.keep(step, balance(gl), ple);
  }

  private creditNote(step: Extract<MoneyStep, { kind: 'credit_note' }>): void {
    const orig = this.invoices.get(step.against)!;
    const sold = orig.step as Extract<MoneyStep, { kind: 'sales_invoice' }>;
    const lines: MoneyLine[] = step.lines ?? sold.lines;
    // a discount on the whole sale comes back in proportion to what is returned (ERPNext gives the whole discount back
    // again on a part return, so the customer gets less than they paid for those goods; ours differs, referee M22)
    const t = invoiceTotals(lines, sold.tax, this.rounding, step.lines ? this.discountShare(orig, lines) : sold.discountAmount);
    const goods = this.goods(lines);
    const moves = !!step.updateStock && goods.length > 0;
    if (moves) {
      // goods come back at the cost they left with (the original invoice's stock rows)
      const back = goods.map((l) => {
        const rows = this.stock.rowsOf(sold.id).filter((r) => r.item === l.item);
        const qty = rows.reduce((s, r) => s - r.qty, 0), value = rows.reduce((s, r) => s - r.valueChange, 0);
        return { item: l.item, qty: l.qty, rate: qty ? value / qty : 0 };
      });
      if (!this.moveStock(step.id, step, 'in', sold.warehouse, back)) return;
    }
    const gl: Gl[] = [cr('receivable', t.roundedTotal, orig.party), dr('income', t.netTotal)];
    if (t.vat) gl.push(dr('vat', t.vat));
    this.invoices.set(step.id, { step, party: orig.party, side: 'customer', totals: t, dueDate: step.date, returnOf: step.against, stock: moves ? 'in' : null });
    // its own balance is a credit to the customer (01 §3.3, update_outstanding_for_self), or it comes off the invoice
    this.keep(step, balance(gl), [{ party: orig.party, against: step.reduceInvoice ? step.against : step.id, amount: -t.roundedTotal }]);
  }

  private payment(step: Extract<MoneyStep, { kind: 'payment' }>): void {
    const into = step.direction === 'in';
    // charges (ERPNext "Payment Deductions or Loss", referee M26): a deduction is always booked as a debit (a charge);
    // money in: the customer is settled for what arrived plus the charges; money out: the supplier is settled for what
    // left less the charges (bank charges paid on top of a bill)
    const ded = (step.deductions ?? []).filter((d) => d.amount !== 0);
    const dsum = ded.reduce((s, d) => s + d.amount, 0);
    const settled = roundMoney(into ? step.amount + dsum : step.amount - dsum);
    const money = at((into ? dr : cr)(ACCOUNT_ROLE[step.account], step.amount), step.ref);
    // a customer paying, or us paying a supplier; or the other way: paying a customer back (their credit, e.g. a
    // return, is used up) or a supplier paying us back (an advance comes back), referee M29
    const role = this.parties.get(step.party) === 'customer' ? 'receivable' : 'payable';
    const sign = (role === 'receivable') === into ? -1 : 1;
    const gl: Gl[] = into ? [money, cr(role, settled, step.party)] : [dr(role, settled, step.party), money];
    for (const d of ded) gl.push(at(d.amount > 0 ? dr(d.role, d.amount) : cr(d.role, -d.amount), d.ref));
    const ple: Ple[] = [];
    let used = 0;
    for (const a of step.allocate ?? []) {
      ple.push({ party: step.party, against: a.invoice, amount: sign * a.amount });
      used = roundMoney(used + a.amount);
    }
    if (roundMoney(settled - used) > 0) ple.push({ party: step.party, against: step.id, amount: sign * roundMoney(settled - used) });
    this.keep(step, gl, ple);
  }

  private journal(step: Extract<MoneyStep, { kind: 'journal' }>): void {
    // debiting a customer is checked against their credit limit, like a sale (03 §5.2)
    if (!step.creditOk) {
      const net = new Map<string, number>();
      for (const r of step.rows) if (r.party && r.role === 'receivable' && this.parties.get(r.party) === 'customer') net.set(r.party, (net.get(r.party) ?? 0) + (r.debit ?? 0) - (r.credit ?? 0));
      for (const [c, n] of net) {
        const msg = n > 0 ? this.creditFor(c, roundMoney(n)) : null;
        if (msg) return this.fail(step.id, msg);
      }
    }
    const gl: Gl[] = [], ple: Ple[] = [];
    for (const r of step.rows) {
      gl.push({ role: r.role, debit: r.debit ?? 0, credit: r.credit ?? 0, party: r.party, ref: r.account });
      if (r.party && (r.role === 'receivable' || r.role === 'payable')) {
        const amount = r.role === 'receivable' ? (r.debit ?? 0) - (r.credit ?? 0) : (r.credit ?? 0) - (r.debit ?? 0);
        ple.push({ party: r.party, against: r.invoice ?? step.id, amount: roundMoney(amount) });
      }
    }
    this.keep(step, gl, ple);
  }

  // ---- checks --------------------------------------------------------------------------------------------------

  private check(step: MoneyStep): string | null {
    const party = (key: string, type: 'customer' | 'supplier') =>
      this.parties.get(key) === type ? null : `Unknown ${type} ${key}`;
    const lines = (ls: MoneyLine[] | undefined) => {
      if (!ls?.length) return 'No lines';
      for (const l of ls) {
        if (!this.items.has(l.item)) return `Unknown item ${l.item}`;
        if (!(l.qty > 0) || !Number.isFinite(l.qty)) return `Bad quantity for ${l.item}`;
        if (!(l.rate >= 0) || !Number.isFinite(l.rate)) return `Bad rate for ${l.item}`;
      }
      return null;
    };
    const k: Kind = step.kind;
    if ((k === 'sales_invoice' || k === 'purchase_invoice') && step.schedule?.length) {
      const sum = Math.round(step.schedule.reduce((s, x) => s + x.portion, 0) * 1e6) / 1e6;
      if (sum !== 100) return `Payment terms must add up to 100 % (they add up to ${sum} %)`;
      if (step.schedule.some((x) => !(x.portion > 0) || x.dueDate < step.date)) return 'Each instalment needs a share above 0 and a due date on or after the invoice date';
      const dates = step.schedule.map((x) => x.dueDate);
      if (new Set(dates).size !== dates.length) return 'Two instalments have the same due date';
    }
    if (k === 'sales_invoice') {
      if (step.updateStock && !this.scenario.warehouses.includes(step.warehouse ?? '')) return 'Choose the warehouse the goods leave from';
      for (const [i, l] of step.lines.entries()) {
        if (!l.from) continue;
        if (!this.sales) return `Line ${i + 1}: no orders or delivery notes to bill`;
        const bad = this.sales.checkInvoiceLine(step.customer, l, i, !!step.updateStock, (ref) => this.sales!.billedFor(ref));
        if (bad) return bad;
      }
      if ((step.payments ?? []).some((p) => !(p.amount >= 0))) return 'A payment cannot be negative';
      return party(step.customer, 'customer') ?? lines(step.lines);
    }
    if (k === 'purchase_invoice') {
      if (step.receipt) {
        const r = this.stock.posted.get(step.receipt);
        if (!r || r.cancelled || r.step.kind !== 'purchase_receipt') return `${step.receipt} is not a posted goods receipt`;
      }
      if (step.updateStock && !this.scenario.warehouses.includes(step.warehouse ?? '')) return 'Choose the warehouse the goods go into';
      return party(step.supplier, 'supplier') ?? lines(step.lines);
    }
    if (k === 'credit_note') {
      const orig = this.invoices.get(step.against);
      if (!orig || orig.step.kind !== 'sales_invoice' || this.posted.get(step.against)?.cancelled) return `${step.against} is not a posted sales invoice`;
      if (step.updateStock && !orig.stock && this.goods(step.lines ?? orig.step.lines).length) return 'The invoice moved no goods, so none can come back';
      if (step.reduceInvoice && this.outstanding(step.against) <= 0) return `Nothing is owed on ${step.against} any more; give the return as credit`;
      if (step.lines) {
        const bad = lines(step.lines);
        if (bad) return bad;
        for (const l of step.lines) {
          const sold = orig.step.lines.filter((x) => x.item === l.item).reduce((s, x) => s + x.qty, 0);
          if (l.qty > sold) return `Cannot return more ${l.item} than was sold (${sold})`;
        }
      }
      return null;
    }
    if (k === 'payment') {
      if (!(step.amount > 0)) return 'The amount must be above 0';
      if (!this.parties.has(step.party)) return `Unknown customer or supplier ${step.party}`;
      // paying back: what is linked must be credit they have (a negative balance, e.g. a return)
      const back = (this.parties.get(step.party) === 'customer') !== (step.direction === 'in');
      let total = 0;
      for (const a of step.allocate ?? []) {
        const inv = this.invoices.get(a.invoice);
        if (!inv || inv.party !== step.party || this.posted.get(a.invoice)?.cancelled) return `${a.invoice} is not an open invoice of ${step.party}`;
        if (!(a.amount > 0)) return 'An allocated amount must be above 0';
        if (back && a.amount > -this.outstanding(a.invoice) + 0.001) return `More than the credit on ${a.invoice} (${-this.outstanding(a.invoice)})`;
        if (!back && a.amount > this.outstanding(a.invoice) + 0.001) return `More than is owed on ${a.invoice} (${this.outstanding(a.invoice)})`;
        total += a.amount;
      }
      const ded = (step.deductions ?? []).reduce((s, d) => s + d.amount, 0);
      if (roundMoney(total) > roundMoney(step.direction === 'in' ? step.amount + ded : step.amount - ded)) return 'Allocated more than was paid';
      return null;
    }
    if (k === 'money_transfer') {
      if (!(step.amount > 0)) return 'The amount must be above 0';
      const same = step.from === step.to && (step.fromRef ?? '') === (step.toRef ?? '');
      return same ? 'Choose two different accounts' : null;
    }
    if (k === 'reconcile') {
      if (!this.parties.has(step.party)) return `Unknown party ${step.party}`;
      if (!step.allocations.length) return 'Nothing to match';
      const used = new Map<string, number>(), owed = new Map<string, number>();
      for (const a of step.allocations) {
        if (!(a.amount > 0)) return 'A matched amount must be above 0';
        const inv = this.invoices.get(a.invoice);
        if (!inv || inv.party !== step.party || this.posted.get(a.invoice)?.cancelled || inv.returnOf) return `${a.invoice} is not an open invoice of ${step.party}`;
        const src = this.posted.get(a.from);
        if (!src || src.cancelled) return `${a.from} is not live`;
        // what the source still has as credit for this party: its own party rows (negative = credit)
        const credit = -roundMoney(this.rowsAgainst(a.from, step.party));
        used.set(a.from, roundMoney((used.get(a.from) ?? 0) + a.amount));
        if (used.get(a.from)! > credit + 0.001) return `${a.from} has only ${credit} left to match`;
        owed.set(a.invoice, roundMoney((owed.get(a.invoice) ?? 0) + a.amount));
        if (owed.get(a.invoice)! > this.outstanding(a.invoice) + 0.001) return `More than is owed on ${a.invoice} (${this.outstanding(a.invoice)})`;
      }
      return null;
    }
    if (k === 'journal') {
      if (step.rows.length < 2) return 'A journal needs at least two rows';
      const d = roundMoney(step.rows.reduce((s, r) => s + (r.debit ?? 0), 0));
      const c = roundMoney(step.rows.reduce((s, r) => s + (r.credit ?? 0), 0));
      if (d !== c) return `Total Debit must be equal to Total Credit (${d} vs ${c})`;
      return null;
    }
    return `Unknown kind ${k}`;
  }

  // ---- results -------------------------------------------------------------------------------------------------

  /** The live party rows of one party against one step (its own credit when negative). */
  private rowsAgainst(id: string, party: string): number {
    let o = 0;
    for (const p of this.posted.values()) if (!p.cancelled) for (const r of p.ple) if (r.against === id && r.party === party) o += r.amount;
    return o;
  }

  /** What is still owed on an invoice: its live party rows (01 §3.2). */
  outstanding(id: string): number {
    let o = 0;
    for (const p of this.posted.values()) {
      if (p.cancelled) continue;
      for (const r of p.ple) if (r.against === id) o += r.amount;
    }
    return roundMoney(o);
  }

  /** Ledger totals per step and role, debit and credit kept apart (cancelled steps post nothing, 01 §2.6). */
  ledger(): LedgerTotal[] {
    const out: LedgerTotal[] = [];
    for (const id of this.order) {
      const p = this.posted.get(id);
      if (!p || p.cancelled) continue;
      const rows = [...p.gl, ...this.stockRows(id)];
      const sum = new Map<AccountRole, { d: number; c: number }>();
      for (const r of rows) { const s = sum.get(r.role) ?? { d: 0, c: 0 }; s.d += r.debit; s.c += r.credit; sum.set(r.role, s); }
      for (const [role, s] of sum) {
        const d = roundMoney(s.d), c = roundMoney(s.c);
        if (d || c) out.push({ step: id, role, debit: d, credit: c });
      }
    }
    return out;
  }

  /** Cost and stock rows for goods an invoice moved, from the stock ledger as it stands now. */
  private stockRows(id: string): Gl[] {
    const inv = this.invoices.get(id);
    if (!inv?.stock) return [];
    const change = roundMoney(this.stock.rowsOf(id).reduce((s, r) => s + r.valueChange, 0));
    if (!change) return [];
    if (inv.step.kind === 'purchase_invoice') {
      // its stock debit is the goods' net amounts (above); a landed cost added later (referee M25) is booked like on
      // goods arrived: Dr Stock by the extra value, Cr Expenses Included In Valuation, the gap to cost of goods sold
      const rows = this.stock.rowsOf(id);
      const landed = roundMoney(rows.reduce((s, r) => s + this.stock.landedPerUnit(r) * r.qty, 0));
      if (!landed) return [];
      const t = inv.totals;
      const net = roundMoney(inv.step.lines.reduce((s, l, i) => s + (this.services.has(l.item) ? 0 : t.lines[i].net), 0));
      const out: Gl[] = [dr('stock', change - net), cr('expenses_in_valuation', landed)];
      const gap = roundMoney(net + landed - change);
      if (gap) out.push(gap > 0 ? dr('cost_of_goods_sold', gap) : cr('cost_of_goods_sold', -gap));
      return out;
    }
    // sale: Cr stock / Dr cost of goods sold; return: Dr stock / Cr cost of goods sold (02 §6.5)
    return change < 0 ? [cr('stock', -change), dr('cost_of_goods_sold', -change)] : [dr('stock', change), cr('cost_of_goods_sold', change)];
  }

  /** Every ledger row of the live money steps (goods they moved included), with account refs and parties. */
  entries(): Entry[] {
    const out: Entry[] = [];
    for (const id of this.order) {
      const p = this.posted.get(id);
      if (!p || p.cancelled) continue;
      for (const g of [...p.gl, ...this.stockRows(id)]) {
        if (!g.debit && !g.credit) continue;
        out.push({ step: id, role: g.role, debit: g.debit, credit: g.credit, ...(g.ref ? { ref: g.ref } : {}), ...(g.party ? { party: g.party } : {}) });
      }
    }
    return out;
  }

  invoiceResults(): InvoiceResult[] {
    const now = today();
    const out: InvoiceResult[] = [];
    for (const id of this.order) {
      const inv = this.invoices.get(id);
      if (!inv) continue;
      const cancelled = !!this.posted.get(id)?.cancelled;
      const o = cancelled ? inv.owedAtCancel ?? 0 : this.outstanding(id);
      const t = inv.totals;
      // a return's totals are negative, as ERPNext stores them (referee M10)
      const sign = inv.returnOf ? -1 : 1;
      out.push({ step: id, party: inv.party, netTotal: sign * t.netTotal, vat: sign * t.vat, grandTotal: sign * t.grandTotal, roundedTotal: sign * t.roundedTotal,
        outstanding: o, status: this.status(inv, o, cancelled, now) });
    }
    return out;
  }

  /** Late (03 §3.3): without a schedule, past the due date; with one, paid less than the instalments due before today. */
  private late(inv: Invoice, o: number, now: string): boolean {
    const sched = (inv.step as { schedule?: { dueDate: string; portion: number }[] }).schedule;
    if (!sched?.length) return inv.dueDate < now;
    const total = inv.totals.roundedTotal;
    const due = sched.filter((x) => x.dueDate < now).reduce((s, x) => s + roundMoney((total * x.portion) / 100), 0);
    return roundMoney(total - o) < roundMoney(due);
  }

  private status(inv: Invoice, o: number, cancelled: boolean, now: string): string {
    if (cancelled) return 'Cancelled';
    if (inv.returnOf) return 'Return';
    // ERPNext keeps the status it set when the invoice's balance last changed: a return counts once something touched
    // the invoice after it (a payment, or the return itself when it comes off the invoice), referee M29
    const at = (id: string) => this.order.indexOf(id);
    let touched = at(inv.step.id);
    for (const [id, p] of this.posted) if (!p.cancelled && p.ple.some((r) => r.against === inv.step.id)) touched = Math.max(touched, at(id));
    const returned = [...this.invoices.values()].some((x) => x.returnOf === inv.step.id && !this.posted.get(x.step.id)?.cancelled && at(x.step.id) <= touched);
    if (o > 0 && this.late(inv, o, now)) return 'Overdue';
    if (o > 0 && o < inv.totals.roundedTotal) return 'Partly Paid';
    if (o > 0) return 'Unpaid';
    if (returned) return inv.side === 'customer' ? 'Credit Note Issued' : 'Debit Note Issued';
    return 'Paid';
  }

  partyBalances(): { party: string; balance: number }[] {
    const sum = new Map<string, number>();
    for (const p of this.posted.values()) {
      if (p.cancelled) continue;
      for (const r of p.ple) sum.set(r.party, (sum.get(r.party) ?? 0) + r.amount);
    }
    return [...sum].map(([party, b]) => ({ party, balance: roundMoney(b) }));
  }

  // ---- helpers -------------------------------------------------------------------------------------------------

  /** Lines whose items keep stock (services left out), with the rate after any line discount. */
  private goods(lines: MoneyLine[]): { item: string; qty: number; rate: number }[] {
    return lines.filter((l) => !this.services.has(l.item)).map((l) => ({ item: l.item, qty: l.qty, rate: lineRate(l) }));
  }

  /** The part of an invoice's whole-invoice discount that belongs to these returned lines (by their amount). */
  private discountShare(orig: Invoice, lines: MoneyLine[]): number {
    const d = orig.totals.discount;
    if (!d || !orig.totals.total) return 0;
    const back = lines.reduce((s, l) => s + roundMoney(lineRate(l) * l.qty), 0);
    return roundMoney((d * back) / orig.totals.total);
  }

  /** Credit check (03 §5.1): what the customer owes, plus open orders (not for a customer checked at the invoice) and
   *  delivery notes not billed yet, plus this document, against their limit. `billing`: the invoice being checked, so
   *  what it bills is not counted twice. null when it fits (or there is no limit). */
  creditFor(customer: string, adds: number, billing?: InvoiceView): string | null {
    const limit = this.limits.get(customer);
    if (!limit) return null;
    const owed = roundMoney(this.balanceOf(customer) + (this.sales?.unbilled(customer, !this.atInvoice.has(customer), billing) ?? 0) + adds);
    return owed > limit ? `Credit limit crossed for ${customer}: they would owe ${money(owed)}, the limit is ${money(limit)}` : null;
  }

  /** Per customer, what counts against the credit limit now (owed, plus open orders unless checked at the invoice,
   *  plus deliveries not billed). */
  creditPositions(): { customer: string; owed: number }[] {
    return [...this.parties].filter(([, t]) => t === 'customer').map(([c]) => ({
      customer: c, owed: roundMoney(this.balanceOf(c) + (this.sales?.unbilled(c, !this.atInvoice.has(c)) ?? 0)),
    }));
  }

  /** Checked at the delivery and invoice instead of at the order (ERPNext's bypass credit limit check at sales order). */
  checksAtInvoice(customer: string): boolean { return this.atInvoice.has(customer); }

  /** No sale below cost (03 §2, Selling Settings validate_selling_price): each stock line's net rate (after discounts,
   *  without VAT) may not be below the product's last purchase rate, nor its valuation rate in the store the goods
   *  leave from. Off unless the scenario asks for it. */
  belowCost(lines: MoneyLine[], tax: Parameters<typeof invoiceTotals>[1], discount: number | undefined, warehouse: string | undefined, date: string, time: string): string | null {
    if (!this.scenario.noSaleBelowCost) return null;
    const t = invoiceTotals(lines, tax, this.rounding, discount);
    for (const [i, l] of lines.entries()) {
      if (this.services.has(l.item) || !l.qty) continue;
      const net = roundMoney(t.lines[i].net / l.qty);
      const last = this.lastPurchaseRate(l.item);
      if (last !== null && net < last) return `Line ${i + 1}: the rate ${money(net)} of ${l.item} is below its last purchase rate ${money(last)}`;
      const row = warehouse ? this.stock.lastActive(l.item, warehouse, `${date} ${time}`) : undefined;
      if (row && row.valuationRate > 0 && net < roundMoney(row.valuationRate)) return `Line ${i + 1}: the rate ${money(net)} of ${l.item} is below its valuation rate ${money(roundMoney(row.valuationRate))}`;
    }
    return null;
  }

  /** The newest live purchase of a product (goods arrived or supplier bill), per stock unit, without VAT. */
  private lastPurchaseRate(item: string): number | null {
    let best: { at: string; rate: number } | null = null;
    const take = (at: string, rate: number) => { if (!best || at >= best.at) best = { at, rate }; };
    for (const id of this.stock.order) {
      const p = this.stock.posted.get(id);
      if (!p || p.cancelled || p.step.kind !== 'purchase_receipt') continue;
      for (const l of p.step.lines) if (l.item === item) take(`${p.step.date} ${p.step.time}`, l.rate);
    }
    for (const id of this.order) {
      const p = this.posted.get(id);
      if (!p || p.cancelled || p.step.kind !== 'purchase_invoice' || p.step.opening) continue;
      const t = invoiceTotals(p.step.lines, p.step.tax, this.rounding, p.step.discountAmount);
      p.step.lines.forEach((l, i) => { if (l.item === item && l.qty) take(`${p.step.date} ${p.step.time}`, roundMoney(t.lines[i].net / l.qty)); });
    }
    return best === null ? null : (best as { rate: number }).rate;
  }

  /** Live sales invoices as the selling side sees them (for ordered / delivered / billed counters). */
  invoiceViews(): InvoiceView[] {
    const out: InvoiceView[] = [];
    for (const id of this.order) {
      const p = this.posted.get(id);
      if (!p || p.cancelled || p.step.kind !== 'sales_invoice') continue;
      out.push({ id, customer: p.step.customer, lines: p.step.lines, updateStock: !!p.step.updateStock, date: p.step.date });
    }
    return out;
  }

  /** What a party owes now (customer) or is owed (supplier): its live party rows. */
  private balanceOf(party: string): number {
    let b = 0;
    for (const p of this.posted.values()) if (!p.cancelled) for (const r of p.ple) if (r.party === party) b += r.amount;
    return roundMoney(b);
  }

  /** Send the goods of an invoice through the stock ledger under the invoice's id; false if the stock refused them. */
  private moveStock(id: string, step: { date: string; time: string }, dir: 'in' | 'out', warehouse: string | undefined, lines: MoneyLine[] | { item: string; qty: number; rate: number }[], t?: Totals): boolean {
    const before = this.stock.errors.length;
    const stockLines = lines.map((l, i) => ({ item: l.item, qty: l.qty, rate: t ? t.lines[i].net / l.qty : l.rate }));
    this.stock.post({ id, kind: dir === 'out' ? 'delivery' : 'receipt', date: step.date, time: step.time, warehouse: warehouse!, lines: stockLines } as Step);
    const err = this.stock.errors.slice(before).find((e) => e.step === id);
    if (err) { this.fail(id, err.message); return false; }
    return true;
  }

  private keep(step: MoneyStep, gl: Gl[], ple: Ple[]): void {
    this.posted.set(step.id, { step, gl, ple, cancelled: false });
    this.order.push(step.id);
  }

  private fail(step: string, message: string): void {
    this.errors.push({ step, message });
  }
}

const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
/** An invoice is due on its last instalment, else its due date, else its date. */
const lastDue = (s: { date: string; dueDate?: string; schedule?: { dueDate: string }[] }) =>
  s.schedule?.length ? s.schedule.map((x) => x.dueDate).sort().at(-1)! : s.dueDate ?? s.date;

/** The same row, booked to one of our own accounts (when the document names one). */
const at = (g: Gl, ref?: string): Gl => (ref ? { ...g, ref } : g);
const dr = (role: AccountRole, amount: number, party?: string): Gl => ({ role, debit: roundMoney(amount), credit: 0, party });
const cr = (role: AccountRole, amount: number, party?: string): Gl => ({ role, debit: 0, credit: roundMoney(amount), party });

/** Rows that do not balance by a few cents (inclusive VAT, whole-shilling rounding) get a Round Off row (01 §2.2 7a). */
function balance(gl: Gl[]): Gl[] {
  const d = gl.reduce((s, r) => s + r.debit, 0), c = gl.reduce((s, r) => s + r.credit, 0);
  const diff = roundMoney(d - c);
  if (diff > 0) gl.push(cr('round_off', diff));
  else if (diff < 0) gl.push(dr('round_off', -diff));
  return gl;
}
