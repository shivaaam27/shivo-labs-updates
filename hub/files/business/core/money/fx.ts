// Foreign currency (phase 5b; pos/blueprint/04-buying.md §6.2-6.3, 01-accounting-core.md §6). The books are kept in
// TZS. A document may be in another currency (contract InCurrency): its amounts are in that currency and its
// `exchangeRate` turns them into TZS. A foreign-currency customer or supplier keeps what they owe in their own currency
// too (ERPNext: a USD debtors / creditors account), so every party-ledger row carries both: `amount` in the party's
// currency (what is owed on an invoice, as ERPNext's outstanding) and `base` in TZS (the books).
//
// Exchange differences (R11, R12): money that settles an invoice at another rate than the invoice's leaves a TZS
// difference on the party's account. It is booked at once as an exchange gain or loss, on the step that settles the
// invoice (ERPNext books the same rows as a separate "Exchange Gain Or Loss" journal made by that step):
//   difference = settled amount x (rate of the money - rate of the invoice)
//   supplier: Cr Creditors by the difference, Dr Exchange Gain/Loss (a loss when we paid more shillings);
//   customer: Dr Debtors by the difference, Cr Exchange Gain/Loss (a gain when they paid more shillings).
// The row moves 0 in the party's currency (only the TZS value of the debt changes).
//
// MoneyBook (books.ts) calls this module at a few marked hook points; everything about currencies lives here.
import type { AccountRole, Scenario, Step } from '../contract.ts';
import { roundMoney } from '../money.ts';

/** The currency the books are kept in. */
export const BASE_CURRENCY = 'TZS';

type Cur = { currency?: string; exchangeRate?: number } | undefined;
/** In another currency than the books. */
export const isForeign = (s: Cur): boolean => !!s?.currency && s.currency !== BASE_CURRENCY;
/** TZS for one unit of the document's currency (1 for TZS documents; 0 when a foreign document has no rate). */
export const rateOf = (s: Cur): number => (isForeign(s) ? Number(s!.exchangeRate) || 0 : 1);
/** Grand totals are rounded to whole shillings for TZS documents only: other currencies keep their cents (ERPNext rounds
 *  to the currency's smallest fraction, 0.01 for USD; probed 14 Oct). */
export const roundsTotal = (s: Cur, rounding: boolean): boolean => rounding && !isForeign(s);

/** The stock ledger works in TZS: goods arrived in a foreign currency go in with their rates turned into TZS. */
export function inBase(step: Step): Step {
  if (step.kind !== 'purchase_receipt' || !isForeign(step)) return step;
  const r = rateOf(step);
  return { ...step, lines: step.lines.map((l) => ({ ...l, rate: l.rate * r })) };
}

/** The ledger and party rows MoneyBook keeps (books.ts Gl and Ple). `fxOf`: an exchange difference on that invoice. */
export interface FxGl { role: AccountRole; debit: number; credit: number; party?: string; ref?: string; fxOf?: string }
export interface FxPle { party: string; against: string; amount: number; base?: number; rate?: number; fxOf?: string }

const CODE = /^[A-Z]{3}$/;

export class Fx {
  private currency = new Map<string, string>();   // party -> its own currency (absent: TZS)
  private account = new Map<string, string>();    // party -> our debtors / creditors account for it
  private type = new Map<string, 'customer' | 'supplier'>();

  constructor(scenario: Scenario) {
    for (const p of scenario.parties ?? []) {
      this.type.set(p.key, p.type);
      if (p.currency && p.currency !== BASE_CURRENCY) this.currency.set(p.key, p.currency);
      if (p.account) this.account.set(p.key, p.account);
    }
  }

  partyCurrency(party: string): string { return this.currency.get(party) ?? BASE_CURRENCY; }
  isForeignParty(party: string): boolean { return this.currency.has(party); }

  /** Refusals before anything is booked (null: fine). `docOf`: an earlier posted money step by id. */
  check(step: Step, docOf: (id: string) => Step | undefined): string | null {
    const s = step as Step & { currency?: string; exchangeRate?: number };
    if (s.currency !== undefined && !CODE.test(String(s.currency))) return `Unknown currency "${s.currency}"`;
    if (isForeign(s) && !(Number(s.exchangeRate) > 0 && Number.isFinite(Number(s.exchangeRate)))) return `Give the exchange rate: TZS for 1 ${s.currency}`;
    if (!isForeign(s) && s.exchangeRate !== undefined && s.exchangeRate !== 1) return 'A document in TZS has no exchange rate';
    const cur = isForeign(s) ? s.currency! : BASE_CURRENCY;
    // a party's documents are all in its own currency (ERPNext: the party account's currency, with
    // allow_multi_currency_invoices_against_single_party_account off)
    const party = step.kind === 'sales_invoice' ? step.customer : step.kind === 'purchase_invoice' ? step.supplier : step.kind === 'payment' ? step.party : null;
    if (party !== null && this.type.has(party) && this.partyCurrency(party) !== cur) {
      return `${party} is kept in ${this.partyCurrency(party)}: the ${step.kind === 'payment' ? 'payment' : 'invoice'} must be in ${this.partyCurrency(party)}, not ${cur}`;
    }
    if (step.kind === 'payment' && isForeign(step) && step.deductions?.some((d) => d.amount)) {
      return 'Charges cannot be taken off a payment in another currency; book them as a journal in TZS';
    }
    if (step.kind === 'credit_note' || (step.kind as string) === 'debit_note') {
      const orig = docOf((step as { against: string }).against) as (Step & { currency?: string }) | undefined;
      const oc = isForeign(orig) ? orig!.currency! : BASE_CURRENCY;
      if (orig && oc !== cur) return `A return is in the invoice's currency (${oc})`;
    }
    // a bill made from goods arrived keeps their exchange rate (ERPNext, with "Set Landed Cost Based on Purchase Invoice
    // Rate" off, its default: probed 14 Oct, referee M34); stock valued at the bill's rate belongs to the goods-arrived
    // and bill link
    if (step.kind === 'purchase_invoice') {
      const sources = new Set([step.receipt, ...step.lines.map((l) => l.from?.step)].filter((x): x is string => !!x));
      for (const id of sources) {
        const src = docOf(id) as (Step & { currency?: string; exchangeRate?: number }) | undefined;
        if (src?.kind === 'purchase_receipt' && rateOf(src) !== rateOf(s)) {
          return `Exchange rate ${rateOf(s)} does not match the exchange rate of the goods arrived ${id} (${rateOf(src)}); use the same rate`;
        }
      }
    }
    if (step.kind === 'journal') {
      for (const [i, r] of step.rows.entries()) {
        // a row settling an invoice takes the invoice's rate (ERPNext sets it from the invoice, referee M35); an exchange
        // difference goes on a row of its own
        const inv = r.invoice ? docOf(r.invoice) as (Step & { currency?: string; exchangeRate?: number }) | undefined : undefined;
        if (inv && isForeign(inv) && (r.exchangeRate ?? 1) !== rateOf(inv)) {
          return `Row ${i + 1} settles ${r.invoice}: it takes the invoice's rate (${rateOf(inv)}); book a difference on a row of its own`;
        }
        if (r.exchangeRate !== undefined && !(r.exchangeRate > 0 && Number.isFinite(r.exchangeRate))) return `Row ${i + 1}: the exchange rate must be above 0`;
        if (r.party && (r.role === 'receivable' || r.role === 'payable') && this.isForeignParty(r.party) && !(Number(r.exchangeRate) > 0)) {
          return `Row ${i + 1}: ${r.party} is kept in ${this.partyCurrency(r.party)}; give the row in ${this.partyCurrency(r.party)} with its exchange rate`;
        }
      }
    }
    return null;
  }

  /** A posted step's rows in TZS, with each party row's TZS value (`base`) and the exchange differences it causes.
   *  `rateOfDoc`: the rate of an earlier posted step (undefined if unknown). Returns the ledger rows to keep. */
  book(step: Step, gl: FxGl[], ple: FxPle[], rateOfDoc: (id: string) => number | undefined): FxGl[] {
    const rowRate: number[] = [];
    let out: FxGl[];
    if (step.kind === 'journal') {
      // each row in its account's currency at its own rate (ERPNext Journal Entry multi_currency)
      out = gl.map((g, i) => scale(g, step.rows[i]?.exchangeRate ?? 1));
      const partyRows = step.rows.filter((r) => r.party && (r.role === 'receivable' || r.role === 'payable'));
      ple.forEach((_, i) => rowRate.push(partyRows[i]?.exchangeRate ?? 1));
    } else if (step.kind === 'reconcile') {
      // matching credit to an invoice moves the credit at the rate it was booked at (the payment's or return's)
      out = gl;
      ple.forEach((_, i) => rowRate.push(rateOfDoc(step.allocations[Math.floor(i / 2)]?.from ?? '') ?? 1));
    } else {
      const r = rateOf(step as Cur);
      out = r === 1 ? gl : gl.map((g) => scale(g, r));
      ple.forEach(() => rowRate.push(r));
    }
    ple.forEach((p, i) => { p.base = roundMoney(p.amount * rowRate[i]); p.rate = rowRate[i]; });
    // a foreign-currency party's rows go to its own debtors / creditors account
    for (const g of out) if (g.party && !g.ref && (g.role === 'receivable' || g.role === 'payable') && this.account.has(g.party)) g.ref = this.account.get(g.party);
    // exchange differences: money settling an invoice of another rate
    const extra: FxPle[] = [];
    ple.forEach((p, i) => {
      if (p.against === step.id || !p.amount || !this.isForeignParty(p.party)) return;
      const ri = rateOfDoc(p.against);
      if (ri === undefined || ri === rowRate[i]) return;
      const diff = roundMoney(roundMoney(-p.amount * rowRate[i]) + roundMoney(p.amount * ri));
      if (!diff) return;
      const role: AccountRole = this.type.get(p.party) === 'customer' ? 'receivable' : 'payable';
      // the party side moves by the difference (customer: debit, supplier: credit); Exchange Gain/Loss the other side
      const partySide = role === 'receivable' ? diff : -diff;   // + = debit
      out.push(side(role, partySide, p.party, this.account.get(p.party), p.against), side('exchange_gain_loss', -partySide, undefined, undefined, p.against));
      extra.push({ party: p.party, against: p.against, amount: 0, base: diff, fxOf: p.against });
    });
    ple.push(...extra);
    // rows turned into TZS one by one may be off by a few cents: Round Off takes it (as ERPNext does on the base amounts)
    const d = roundMoney(out.reduce((s, g) => s + g.debit - g.credit, 0));
    if (d && (out !== gl || extra.length)) out.push(d > 0 ? { role: 'round_off', debit: 0, credit: d } : { role: 'round_off', debit: -d, credit: 0 });
    return out;
  }

  /** An invoice was cancelled: the exchange differences other steps booked on it go too (ERPNext cancels the gain or
   *  loss journal when the payment is unlinked from the invoice). */
  unlink(rows: { gl: FxGl[]; ple: FxPle[] }, target: string): void {
    rows.gl = rows.gl.filter((g) => g.fxOf !== target);
    rows.ple = rows.ple.filter((r) => r.fxOf !== target);
  }
}

function scale(g: FxGl, r: number): FxGl {
  return r === 1 ? g : { ...g, debit: roundMoney(g.debit * r), credit: roundMoney(g.credit * r) };
}
function side(role: AccountRole, amount: number, party?: string, ref?: string, fxOf?: string): FxGl {
  return { role, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0, ...(party ? { party } : {}), ...(ref ? { ref } : {}), ...(fxOf ? { fxOf } : {}) };
}
