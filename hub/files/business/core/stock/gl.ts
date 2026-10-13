// Stock to accounts: the ledger rows each stock step makes, summed per account role (02 §7, 01 §2.2).
// Figures come from the stock rows as they stand now, so a back-dated step that changed a later
// sale's cost also changes that sale's cost of goods sold (02 §4.4 step 3.6, R12).

import type { AccountRole, LedgerTotal } from '../contract.ts';
import { roundMoney } from '../money.ts';
import type { StockLedger } from './ledger.ts';

const ROLE_ORDER: AccountRole[] = [
  'stock', 'stock_adjustment', 'stock_received_not_billed', 'cost_of_goods_sold', 'expenses_in_valuation', 'temporary_opening', 'other',
];

/** `skip`: steps whose ledger rows another part writes (invoices that move goods: money/books.ts). */
export function ledgerTotals(book: StockLedger, skip?: Set<string>): LedgerTotal[] {
  const out: LedgerTotal[] = [];
  for (const id of book.order) {
    if (skip?.has(id)) continue;
    const p = book.posted.get(id)!;
    // A cancelled step's rows and their mirrors are both flagged cancelled, so it posts nothing;
    // the cancel step itself posts nothing either (01 §2.6 default mode).
    if (p.cancelled) continue;
    const amounts = stepAmounts(book, id);
    for (const role of ROLE_ORDER) {
      const net = roundMoney(amounts.get(role) ?? 0);
      if (net === 0) continue; // zero rows dropped after merging (01 §2.2 step 4b)
      // Negative debit goes to the credit side (01 §2.2 step 4c).
      out.push({ step: id, role, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
    }
  }
  return out;
}

/** Signed amounts per role for one step: + debit, - credit. */
function stepAmounts(book: StockLedger, id: string): Map<AccountRole, number> {
  const step = book.posted.get(id)!.step;
  const rows = book.rowsOf(id);
  const stockChange = roundMoney(rows.reduce((sum, r) => sum + r.valueChange, 0));
  const m = new Map<AccountRole, number>();
  const add = (role: AccountRole, amount: number) => m.set(role, (m.get(role) ?? 0) + amount);

  switch (step.kind) {
    case 'receipt':
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
      // valuation); the gap (negative stock filled at a different cost) is the divisional loss to
      // COGS (02 §6.4 step 3, §5.3; R3, R11). Landed cost is booked on the receipt, as ERPNext
      // re-posts the receipt's ledger (02 §6.7 live MAT-LCV-2026-00001).
      const net = roundMoney(step.lines.reduce((sum, l) => sum + roundMoney(l.qty * l.rate), 0));
      const landed = roundMoney(rows.reduce((sum, r) => sum + book.landedPerUnit(r) * r.qty, 0));
      add('stock', stockChange);
      add('stock_received_not_billed', -net);
      add('expenses_in_valuation', -landed);
      add('cost_of_goods_sold', net + landed - stockChange);
      break;
    }
    case 'transfer':
      // Every warehouse uses the one Stock role, so source and target cancel out: nothing posted
      // (02 §6.1 transfer, §7.3 merge; live MAT-STE-2026-00001).
      break;
    case 'landed_cost':
    case 'cancel':
      break;
  }
  return m;
}
