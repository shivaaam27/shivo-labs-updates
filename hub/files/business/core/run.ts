// Run one Scenario through our core and give back the Result the referee compares (contract.ts).
// Pure: data in, rows out; no network, no database (00 B10).

import type { Result, Scenario, StockRow } from './contract.ts';
import { byTime } from './stock/rows.ts';
import { StockLedger } from './stock/ledger.ts';
import { ledgerTotals, stockEntries } from './stock/gl.ts';
import { MONEY_KINDS, MoneyBook } from './money/books.ts';
import { SELL_KINDS, SalesBook } from './sell/orders.ts';
import { BUY_KINDS, BuyBook } from './buy/orders.ts';
import type { SellStep } from './contract.ts';
import type { MoneyStep } from './contract.ts';
import { inBase } from './money/fx.ts';

export function runScenario(s: Scenario): Result {
  const book = new StockLedger(s);
  const money = new MoneyBook(s, book);
  const sales = new SalesBook(s, book, () => money.invoiceViews(), (c, adds) => money.creditFor(c, adds));
  money.sales = sales;
  sales.atInvoice = (c) => money.checksAtInvoice(c);
  sales.creditNotes = () => money.creditNoteViews();
  sales.belowCost = (...a) => money.belowCost(...a);
  book.firmHeld = (item, wh, orders) => sales.firmHeld(item, wh, orders);
  const buy = new BuyBook(s, book, () => money.billViews());
  money.buy = buy;
  buy.advanceOf = (o) => money.advanceOf(o);
  sales.advanceOf = (o) => money.advanceOf(o);
  book.billDiff = (row) => buy.billDiff(row.step, row.line);
  for (const step of s.steps) {
    if (MONEY_KINDS.has(step.kind)) money.post(step as MoneyStep);
    else if (step.kind === 'set_status' && buy.isBuy(step.target)) buy.post(step);
    else if (step.kind === 'set_status' && money.isMoney(step.target)) money.release(step);
    else if (SELL_KINDS.has(step.kind)) sales.post(step as SellStep);
    else if (BUY_KINDS.has(step.kind)) buy.post(step as Parameters<BuyBook['post']>[0]);
    else if (step.kind === 'cancel' && buy.isBuy(step.target)) buy.cancel(step.id, step.target, step.date, step.time);
    else if (step.kind === 'cancel' && money.isMoney(step.target)) money.cancel(step.id, step.target, step.date, step.time);
    else if (step.kind === 'cancel' && sales.isSell(step.target)) sales.cancel(step.id, step.target, step.date, step.time);
    else if (step.kind === 'transfer' && buy.checkTransfer(step)) continue;   // a move made from a stock request, refused
    else book.post(inBase(step));   // fx: goods arrived in another currency go into stock in TZS
  }
  // a scenario with parties is a money scenario even before any money step (the referee's rule, files.ts)
  const hasMoney = money.order.length > 0 || money.errors.length > 0 || sales.order.length > 0 || sales.errors.length > 0 || !!s.parties?.length;

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
  const sellErr = new Set([...sales.errors, ...buy.errors].map((e) => e.step));
  const errors = [...book.errors.filter((e) => !moneyIds.has(e.step) && !money.errors.some((m) => m.step === e.step) && !sellErr.has(e.step)), ...money.errors, ...sales.errors, ...buy.errors];
  // per real account (ours): stock steps use the company's defaults, except landed cost lines that name an account
  const entries = [...stockEntries(book, moneyIds), ...money.entries()];
  const out: Result = { scenario: s.id, system: 'shivo', stock, ledger, balances, errors, entries };
  // landed cost per unit on every receipt line that has extra cost (ours, for the screens)
  const landed: NonNullable<Result['landed']> = [];
  for (const id of book.order) {
    const p = book.posted.get(id)!;
    if (p.cancelled || !(p.step.kind === 'purchase_receipt' || (p.step.kind === 'receipt' && book.billSteps.has(id)))) continue;
    p.step.lines.forEach((l, i) => {
      const extra = book.landedOnLine(id, i);
      if (extra) landed.push({ receipt: id, line: i, item: l.item, qty: l.qty, rate: l.rate ?? 0, extra, perUnit: (l.rate ?? 0) + extra / l.qty });
    });
  }
  if (landed.length) out.landed = landed;
  if (hasMoney) { out.invoices = money.invoiceResults(); out.parties = money.partyBalances(); out.credit = money.creditPositions(); }
  if (sales.order.length || sales.errors.length) { out.documents = sales.documents(); out.reserved = sales.reserved(); out.firm = sales.firm(); }
  // a buying story (orders, requests, quotations, goods arrived from a named supplier): its documents and counters
  const buying = s.steps.some((x) => x.kind === 'material_request' || x.kind === 'supplier_quotation' || x.kind === 'purchase_order'
    || (x.kind === 'purchase_receipt' && (x.supplier || x.returnOf)));
  if (buying) {
    out.documents = [...(out.documents ?? []), ...buy.documents()];
    out.ordered = buy.ordered(); out.requested = buy.requested(); out.lastPurchase = buy.lastPurchase();
  }
  return out;
}
