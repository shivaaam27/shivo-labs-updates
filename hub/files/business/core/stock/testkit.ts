// Small helpers for the stock tests (not a test file itself).

import assert from 'node:assert/strict';
import type { AccountRole, Result, Scenario, Step, StockRow, ValuationMethod } from '../contract.ts';
import { runScenario } from '../run.ts';

/** Build and run a scenario. Items default to A (Moving Average); warehouses to Stores and Van. */
export function run(steps: Step[], opts: { items?: Record<string, ValuationMethod>; warehouses?: string[]; allowNegativeStock?: boolean } = {}): Result {
  const items = Object.entries(opts.items ?? { A: 'Moving Average' }).map(([key, valuation]) => ({ key, valuation }));
  const s: Scenario = {
    id: 'test',
    title: 'test',
    items,
    warehouses: opts.warehouses ?? ['Stores', 'Van'],
    allowNegativeStock: opts.allowNegativeStock,
    steps,
  };
  return runScenario(s);
}

/** Day N of October 2026 at a time (default 10:00:00). */
export function on(day: number, time = '10:00:00'): { date: string; time: string } {
  return { date: `2026-10-${String(day).padStart(2, '0')}`, time };
}

/** Active rows of a step (optionally one item / warehouse). */
export function rows(r: Result, step: string, item?: string, warehouse?: string): StockRow[] {
  return r.stock.filter((x) => x.step === step && !x.cancelled && (!item || x.item === item) && (!warehouse || x.warehouse === warehouse));
}

export function row(r: Result, step: string, item?: string, warehouse?: string): StockRow {
  const found = rows(r, step, item, warehouse);
  assert.equal(found.length, 1, `expected one row for ${step} ${item ?? ''} ${warehouse ?? ''}, got ${found.length}`);
  return found[0];
}

/** Ledger of one step as { role: signed amount } (+ debit, - credit). */
export function gl(r: Result, step: string): Partial<Record<AccountRole, number>> {
  const out: Partial<Record<AccountRole, number>> = {};
  for (const t of r.ledger.filter((x) => x.step === step)) out[t.role] = t.debit - t.credit;
  return out;
}

export function balance(r: Result, item: string, warehouse: string) {
  return r.balances.find((b) => b.item === item && b.warehouse === warehouse);
}

/** Equal within a tolerance (money 0.01 by default). */
export function near(actual: number, expected: number, tol = 0.01, what = ''): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what} expected ${expected}, got ${actual}`);
}

/** Check qtyAfter / valuationRate / stockValue / valueChange of a row. */
export function figures(x: StockRow, qtyAfter: number, rate: number, value: number, change: number): void {
  near(x.qtyAfter, qtyAfter, 0.0005, `${x.step} qtyAfter`);
  near(x.valuationRate, rate, 0.01, `${x.step} rate`);
  near(x.stockValue, value, 0.01, `${x.step} value`);
  near(x.valueChange, change, 0.01, `${x.step} valueChange`);
}
