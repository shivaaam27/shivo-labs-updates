// Run one Scenario through our core and give back the Result the referee compares (contract.ts).
// Pure: data in, rows out; no network, no database (00 B10).

import type { Result, Scenario, StockRow } from './contract.ts';
import { byTime } from './stock/rows.ts';
import { StockLedger } from './stock/ledger.ts';
import { ledgerTotals } from './stock/gl.ts';
import { MONEY_KINDS, MoneyBook } from './money/books.ts';
import { SELL_KINDS, SalesBook } from './sell/orders.ts';
import type { SellStep } from './contract.ts';
import type { MoneyStep } from './contract.ts';

export function runScenario(s: Scenario): Result {
  const book = new StockLedger(s);
  const money = new MoneyBook(s, book);
  const sales = new SalesBook(s, book, () => money.invoiceViews(), (c, adds) => money.creditFor(c, adds));
  money.sales = sales;
  sales.atInvoice = (c) => money.checksAtInvoice(c);
  sales.creditNotes = () => money.creditNoteViews();
  sales.belowCost = (...a) => money.belowCost(...a);
  book.firmHeld = (item, wh, orders) => sales.firmHeld(item, wh, orders);
  for (const step of s.steps) {
    if (MONEY_KINDS.has(step.kind)) money.post(step as MoneyStep);
    else if (SELL_KINDS.has(step.kind)) sales.post(step as SellStep);
    else if (step.kind === 'cancel' && money.isMoney(step.target)) money.cancel(step.id, step.target, step.date, step.time);
    else if (step.kind === 'cancel' && sales.isSell(step.target)) sales.cancel(step.id, step.target, step.date, step.time);
    else book.post(step);
  }
  const hasMoney = money.order.length > 0 || money.errors.length > 0 || sales.order.length > 0 || sales.errors.length > 0;

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

  // ledger in step order: stock steps from the stock ledger, money steps (and the goods they moved) from the books
  const moneyIds = new Set(money.order);
  const byStep = new Map<string, Result['ledger']>();
  for (const t of [...ledgerTotals(book, moneyIds), ...money.ledger()]) byStep.set(t.step, [...(byStep.get(t.step) ?? []), t]);
  const ledger = s.steps.flatMap((st) => byStep.get(st.id) ?? []);
  // an invoice whose goods the stock ledger refused is reported once, by the books
  const sellErr = new Set(sales.errors.map((e) => e.step));
  const errors = [...book.errors.filter((e) => !moneyIds.has(e.step) && !money.errors.some((m) => m.step === e.step) && !sellErr.has(e.step)), ...money.errors, ...sales.errors];
  // per real account (ours): stock steps carry no account of their own (the company's defaults apply)
  const entries = [
    ...ledgerTotals(book, moneyIds).map((t) => ({ step: t.step, role: t.role, debit: t.debit, credit: t.credit })),
    ...money.entries(),
  ];
  const out: Result = { scenario: s.id, system: 'shivo', stock, ledger, balances, errors, entries };
  if (hasMoney) { out.invoices = money.invoiceResults(); out.parties = money.partyBalances(); out.credit = money.creditPositions(); }
  if (sales.order.length || sales.errors.length) { out.documents = sales.documents(); out.reserved = sales.reserved(); out.firm = sales.firm(); }
  return out;
}
