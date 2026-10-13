// The money side (01 §2, §3, §4, §7): sales and purchase invoices, payments, credit notes, transfers between own
// accounts and journals. Each posted step writes ledger rows (debit and credit kept apart, as the referee reads
// them) and party-ledger rows (which invoice each shilling belongs to, 01 §3). Goods that an invoice moves go
// through the stock ledger as a step with the same id; their cost is read from the stock rows at the end, so a
// back-dated stock step also corrects the cost of goods sold on a later invoice (as for deliveries, 02 §4.4).
import type { AccountRole, InvoiceResult, LedgerTotal, MoneyAccount, MoneyLine, MoneyStep, Scenario, Step } from '../contract.ts';
import { roundMoney } from '../money.ts';
import type { StockLedger } from '../stock/ledger.ts';
import type { Totals } from './taxes.ts';
import { invoiceTotals } from './taxes.ts';

type Kind = MoneyStep['kind'];
export const MONEY_KINDS = new Set<string>(['sales_invoice', 'purchase_invoice', 'payment', 'credit_note', 'money_transfer', 'journal']);

interface Gl { role: AccountRole; debit: number; credit: number; party?: string }
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
  posted = new Map<string, Posted>();
  order: string[] = [];
  invoices = new Map<string, Invoice>();
  errors: { step: string; message: string }[] = [];
  private rounding: boolean;

  constructor(scenario: Scenario, stock: StockLedger) {
    this.scenario = scenario;
    this.stock = stock;
    for (const p of scenario.parties ?? []) this.parties.set(p.key, p.type);
    this.items = new Set(scenario.items.map((i) => i.key));
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
      case 'money_transfer': return this.keep(step, [dr(ACCOUNT_ROLE[step.to], step.amount), cr(ACCOUNT_ROLE[step.from], step.amount)], []);
      case 'journal': return this.journal(step);
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
    const t = invoiceTotals(step.lines, step.tax, this.rounding);
    if (step.updateStock && !this.moveStock(step.id, step, 'out', step.warehouse, step.lines)) return;
    const gl: Gl[] = [dr('receivable', t.roundedTotal, step.customer)];
    if (t.vat) gl.push(cr('vat', t.vat));
    gl.push(cr('income', t.netTotal));
    const ple: Ple[] = [{ party: step.customer, against: step.id, amount: t.roundedTotal }];
    // paid at the till (01 §7.3): each payment settles the invoice; cash above the total is change
    const pays = (step.payments ?? []).filter((p) => p.amount > 0);
    const paid = roundMoney(pays.reduce((s, p) => s + p.amount, 0));
    for (const p of pays) {
      gl.push(cr('receivable', p.amount, step.customer), dr(ACCOUNT_ROLE[p.account], p.amount));
      ple.push({ party: step.customer, against: step.id, amount: -p.amount });
    }
    const change = paid > t.roundedTotal && pays.some((p) => p.account === 'cash') ? roundMoney(paid - t.roundedTotal) : 0;
    if (change) {
      gl.push(dr('receivable', change, step.customer), cr('cash', change));
      ple.push({ party: step.customer, against: step.id, amount: change });
    }
    const left = roundMoney(t.roundedTotal - paid + change);
    if (step.writeOff && left > 0) {
      gl.push(cr('receivable', left, step.customer), dr('write_off', left));
      ple.push({ party: step.customer, against: step.id, amount: -left });
    }
    this.invoices.set(step.id, { step, party: step.customer, side: 'customer', totals: t, dueDate: step.dueDate ?? step.date, stock: step.updateStock ? 'out' : null });
    this.keep(step, balance(gl), ple);
  }

  private purchaseInvoice(step: Extract<MoneyStep, { kind: 'purchase_invoice' }>): void {
    const t = invoiceTotals(step.lines, step.tax, this.rounding);
    if (step.updateStock && !this.moveStock(step.id, step, 'in', step.warehouse, step.lines, t)) return;
    // what the lines are: goods already received (01 §7.5, SRBNB), goods coming in now (stock), or expenses
    const lineRole: AccountRole = step.receipt ? 'stock_received_not_billed' : step.updateStock ? 'stock' : 'expense';
    const gl: Gl[] = [cr('payable', t.roundedTotal, step.supplier), dr(lineRole, t.netTotal)];
    if (t.vat) gl.push(dr('vat', t.vat));
    this.invoices.set(step.id, { step, party: step.supplier, side: 'supplier', totals: t, dueDate: step.dueDate ?? step.date, stock: step.updateStock ? 'in' : null });
    this.keep(step, balance(gl), [{ party: step.supplier, against: step.id, amount: t.roundedTotal }]);
  }

  private creditNote(step: Extract<MoneyStep, { kind: 'credit_note' }>): void {
    const orig = this.invoices.get(step.against)!;
    const sold = orig.step as Extract<MoneyStep, { kind: 'sales_invoice' }>;
    const lines: MoneyLine[] = step.lines ?? sold.lines;
    const t = invoiceTotals(lines, sold.tax, this.rounding);
    if (step.updateStock) {
      // goods come back at the cost they left with (the original invoice's stock rows)
      const back = lines.map((l) => {
        const rows = this.stock.rowsOf(sold.id).filter((r) => r.item === l.item);
        const qty = rows.reduce((s, r) => s - r.qty, 0), value = rows.reduce((s, r) => s - r.valueChange, 0);
        return { item: l.item, qty: l.qty, rate: qty ? value / qty : 0 };
      });
      if (!this.moveStock(step.id, step, 'in', sold.warehouse, back)) return;
    }
    const gl: Gl[] = [cr('receivable', t.roundedTotal, orig.party), dr('income', t.netTotal)];
    if (t.vat) gl.push(dr('vat', t.vat));
    this.invoices.set(step.id, { step, party: orig.party, side: 'customer', totals: t, dueDate: step.date, returnOf: step.against, stock: step.updateStock ? 'in' : null });
    // its own balance is a credit to the customer (01 §3.3, update_outstanding_for_self)
    this.keep(step, balance(gl), [{ party: orig.party, against: step.id, amount: -t.roundedTotal }]);
  }

  private payment(step: Extract<MoneyStep, { kind: 'payment' }>): void {
    const into = step.direction === 'in';
    const gl: Gl[] = into
      ? [dr(ACCOUNT_ROLE[step.account], step.amount), cr('receivable', step.amount, step.party)]
      : [dr('payable', step.amount, step.party), cr(ACCOUNT_ROLE[step.account], step.amount)];
    const ple: Ple[] = [];
    let used = 0;
    for (const a of step.allocate ?? []) {
      ple.push({ party: step.party, against: a.invoice, amount: -a.amount });
      used = roundMoney(used + a.amount);
    }
    if (roundMoney(step.amount - used) > 0) ple.push({ party: step.party, against: step.id, amount: -roundMoney(step.amount - used) });
    this.keep(step, gl, ple);
  }

  private journal(step: Extract<MoneyStep, { kind: 'journal' }>): void {
    const gl: Gl[] = [], ple: Ple[] = [];
    for (const r of step.rows) {
      gl.push({ role: r.role, debit: r.debit ?? 0, credit: r.credit ?? 0, party: r.party });
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
    if (k === 'sales_invoice') {
      if (step.updateStock && !this.scenario.warehouses.includes(step.warehouse ?? '')) return 'Choose the warehouse the goods leave from';
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
      if (step.updateStock && !orig.stock) return 'The invoice moved no goods, so none can come back';
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
      const bad = party(step.party, step.direction === 'in' ? 'customer' : 'supplier');
      if (bad) return bad;
      let total = 0;
      for (const a of step.allocate ?? []) {
        const inv = this.invoices.get(a.invoice);
        if (!inv || inv.party !== step.party || this.posted.get(a.invoice)?.cancelled) return `${a.invoice} is not an open invoice of ${step.party}`;
        if (!(a.amount > 0)) return 'An allocated amount must be above 0';
        if (a.amount > this.outstanding(a.invoice) + 0.001) return `More than is owed on ${a.invoice} (${this.outstanding(a.invoice)})`;
        total += a.amount;
      }
      if (roundMoney(total) > step.amount) return 'Allocated more than was paid';
      return null;
    }
    if (k === 'money_transfer') {
      if (!(step.amount > 0)) return 'The amount must be above 0';
      return step.from === step.to ? 'Choose two different accounts' : null;
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
    if (inv.step.kind === 'purchase_invoice') return []; // its stock debit is the line amounts (above)
    // sale: Cr stock / Dr cost of goods sold; return: Dr stock / Cr cost of goods sold (02 §6.5)
    return change < 0 ? [cr('stock', -change), dr('cost_of_goods_sold', -change)] : [dr('stock', change), cr('cost_of_goods_sold', change)];
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

  private status(inv: Invoice, o: number, cancelled: boolean, now: string): string {
    if (cancelled) return 'Cancelled';
    if (inv.returnOf) return 'Return';
    const returned = [...this.invoices.values()].some((x) => x.returnOf === inv.step.id && !this.posted.get(x.step.id)?.cancelled);
    if (o > 0 && inv.dueDate < now) return 'Overdue';
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
