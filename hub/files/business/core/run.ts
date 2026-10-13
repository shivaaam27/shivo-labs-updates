// Run one Scenario through our core and give back the Result the referee compares (contract.ts).
// Pure: data in, rows out; no network, no database (00 B10).

import type { Result, Scenario, StockRow } from './contract.ts';
import { byTime } from './stock/rows.ts';
import { StockLedger } from './stock/ledger.ts';
import { ledgerTotals } from './stock/gl.ts';

export function runScenario(s: Scenario): Result {
  const book = new StockLedger(s);
  for (const step of s.steps) book.post(step);

  // All rows, cancelled ones included, in the order the ledger keeps them (02 §4.3).
  const stock: StockRow[] = [...book.rows].sort(byTime).map((r) => ({
    step: r.step,
    item: r.item,
    warehouse: r.warehouse,
    qty: r.qty,
    qtyAfter: r.qtyAfter,
    valuationRate: r.valuationRate,
    stockValue: r.stockValue,
    valueChange: r.valueChange,
    cancelled: r.cancelled,
  }));

  // Final position per item+warehouse from its last active row; pairs with no active row are left out.
  const balances: Result['balances'] = [];
  for (const item of s.items) {
    for (const warehouse of s.warehouses) {
      const last = book.lastActive(item.key, warehouse, '9999-12-31 23:59:59');
      if (last) balances.push({ item: item.key, warehouse, qty: last.qtyAfter, value: last.stockValue, valuationRate: last.valuationRate });
    }
  }

  return { scenario: s.id, system: 'shivo', stock, ledger: ledgerTotals(book), balances, errors: book.errors };
}
