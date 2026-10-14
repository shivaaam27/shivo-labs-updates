// Stock to accounts: the ledger rows each stock step makes, summed per account role (02 §7, 01 §2.2).
// Figures come from the stock rows as they stand now, so a back-dated step that changed a later
// sale's cost also changes that sale's cost of goods sold (02 §4.4 step 3.6, R12).

import type { AccountRole, Entry, LedgerTotal } from '../contract.ts';
import { roundMoney } from '../money.ts';
import type { StockLedger } from './ledger.ts';

const ROLE_ORDER: AccountRole[] = [
  'stock', 'stock_adjustment', 'stock_received_not_billed', 'cost_of_goods_sold', 'expenses_in_valuation', 'temporary_opening', 'other',
];
type Amount = { role: AccountRole; ref?: string; amount: number };

/** `skip`: steps whose ledger rows another part writes (invoices that move goods: money/books.ts). */
export function ledgerTotals(book: StockLedger, skip?: Set<string>): LedgerTotal[] {
  const out: LedgerTotal[] = [];
  for (const id of book.order) {
    if (skip?.has(id)) continue;
    const p = book.posted.get(id)!;
    // A cancelled step's rows and their mirrors are both flagged cancelled, so it posts nothing;
    // the cancel step itself posts nothing either (01 §2.6 default mode).
    if (p.cancelled) continue;
    const amounts = new Map<AccountRole, number>();
    for (const a of stepAmounts(book, id)) amounts.set(a.role, (amounts.get(a.role) ?? 0) + a.amount);
    // the usual stock roles first, then any other a landed cost line books to (VAT, expenses...)
    for (const role of [...ROLE_ORDER, ...[...amounts.keys()].filter((r) => !ROLE_ORDER.includes(r))]) {
      const net = roundMoney(amounts.get(role) ?? 0);
      if (net === 0) continue; // zero rows dropped after merging (01 §2.2 step 4b)
      // Negative debit goes to the credit side (01 §2.2 step 4c).
      out.push({ step: id, role, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
    }
  }
  return out;
}

/** The same rows per role and our own account (`ref`, when a landed cost line names one): for the books. */
export function stockEntries(book: StockLedger, skip?: Set<string>): Entry[] {
  const out: Entry[] = [];
  for (const id of book.order) {
    if (skip?.has(id) || book.posted.get(id)!.cancelled) continue;
    const by = new Map<string, Amount>();
    for (const a of stepAmounts(book, id)) {
      const k = `${a.role}|${a.ref ?? ''}`;
      const was = by.get(k);
      if (was) was.amount += a.amount; else by.set(k, { ...a });
    }
    for (const a of by.values()) {
      const net = roundMoney(a.amount);
      if (net) out.push({ step: id, role: a.role, ...(a.ref ? { ref: a.ref } : {}), debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
    }
  }
  return out;
}

/** Signed amounts for one step: + debit, - credit; `ref` is our own account when the document names one. */
function stepAmounts(book: StockLedger, id: string): Amount[] {
  const step = book.posted.get(id)!.step;
  const rows = book.rowsOf(id);
  const stockChange = roundMoney(rows.reduce((sum, r) => sum + r.valueChange, 0));
  const m: Amount[] = [];
  const add = (role: AccountRole, amount: number, ref?: string) => m.push({ role, amount, ...(ref ? { ref } : {}) });

  switch (step.kind) {
    case 'receipt':
      if (step.cogs) { add('stock', stockChange); add('cost_of_goods_sold', -stockChange); break; }
    // falls through
    case 'issue':
    case 'count':
      // Dr/Cr Stock by the value change; the other side is Stock Adjustment (02 §6.1, §6.3; R6, R20), or Temporary
      // Opening for opening stock (ERPNext Stock Reconciliation purpose "Opening Stock", referee S12).
      add('stock', stockChange);
      add(step.kind === 'count' && step.opening ? 'temporary_opening' : 'stock_adjustment', -stockChange);
      break;
    case 'delivery':
      // Dr Cost of Goods Sold / Cr Stock (02 §6.5).
      add('stock', stockChange);
      add('cost_of_goods_sold', -stockChange);
      break;
    case 'purchase_receipt': {
      // Dr Stock = value change; Cr SRBNB = line net amounts; Cr landed cost (expenses included in
      // valuation, or each cost line's own account); the gap (negative stock filled at a different cost) is the
      // divisional loss to COGS (02 §6.4 step 3, §5.3; R3, R11). Landed cost is booked on the receipt, as ERPNext
      // re-posts the receipt's ledger (02 §6.7 live MAT-LCV-2026-00001).
      // a return (goods sent back) takes the amounts off again: Dr SRBNB / Cr Stock (04 §5)
      const net = (step.returnOf ? -1 : 1) * roundMoney(step.lines.reduce((sum, l) => sum + roundMoney(l.qty * l.rate), 0));
      const { total: landed, credits } = book.landedBooked(id);
      // the bill at another price re-valued the goods: the difference is cleared from SRBNB too (04 §5.3)
      const billed = step.returnOf ? 0 : roundMoney(rows.reduce((sum, r) => sum + (r.qty > 0 && !r.rejected ? book.billDiff(r) * r.qty : 0), 0));
      add('stock', stockChange);
      add('stock_received_not_billed', -net - billed);
      for (const c of credits) add(c.role, -c.amount, c.ref);
      add('cost_of_goods_sold', net + landed + billed - stockChange);
      break;
    }
    case 'transfer':
      // Every warehouse uses the one Stock role, so source and target cancel out: nothing posted
      // (02 §6.1 transfer, §7.3 merge; live MAT-STE-2026-00001).
      break;
    case 'landed_cost':
      // Its cost lines are booked on the receipts (above). Lines that are not stock cost are booked here (04 §7):
      // import VAT that can be claimed back to VAT, an expense to its account, a refundable deposit to its asset
      // account; the other side is the cost line's own account (what is owed to the agent or TRA until the bill).
      for (const c of step.charges ?? []) {
        const t = c.treatment ?? 'cost';
        if (t === 'cost' || !(c.amount > 0)) continue;
        add(t === 'vat' ? 'vat' : t === 'expense' ? 'expense' : 'other', c.amount, c.debitAccount);
        add(c.role ?? 'expenses_in_valuation', -c.amount, c.account);
      }
      break;
    case 'cancel':
      break;
  }
  return m;
}
