// 02 §5.1 worked example (Sugar 1kg, Stores) and referee test R8.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, figures, gl, on, row, run } from './testkit.ts';

const steps = [
  { id: 'R1', kind: 'receipt' as const, ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 2800 }] },
  { id: 'P1', kind: 'purchase_receipt' as const, ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 50, rate: 3100 }] },
  { id: 'D1', kind: 'delivery' as const, ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 30, rate: 4000 }] },
  { id: 'P2', kind: 'purchase_receipt' as const, ...on(4), warehouse: 'Stores', lines: [{ item: 'A', qty: 80, rate: 3000 }] },
  { id: 'D2', kind: 'delivery' as const, ...on(5), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 4000 }] },
];

test('moving average: the 02 §5.1 table row by row', () => {
  const r = run(steps);
  assert.deepEqual(r.errors, []);
  figures(row(r, 'R1'), 100, 2800, 280000, 280000);
  figures(row(r, 'P1'), 150, 2900, 435000, 155000);
  figures(row(r, 'D1'), 120, 2900, 348000, -87000);
  figures(row(r, 'P2'), 200, 2940, 588000, 240000);
  figures(row(r, 'D2'), 100, 2940, 294000, -294000);
  assert.equal(r.system, 'shivo');
});

test('moving average: COGS 87,000 then 294,000 and final 100 @ 2,940 (R8)', () => {
  const r = run(steps);
  assert.deepEqual(gl(r, 'D1'), { stock: -87000, cost_of_goods_sold: 87000 });
  assert.deepEqual(gl(r, 'D2'), { stock: -294000, cost_of_goods_sold: 294000 });
  assert.deepEqual(gl(r, 'P1'), { stock: 155000, stock_received_not_billed: -155000 });
  assert.deepEqual(gl(r, 'R1'), { stock: 280000, stock_adjustment: -280000 });
  assert.deepEqual(balance(r, 'A', 'Stores'), { item: 'A', warehouse: 'Stores', qty: 100, value: 294000, valuationRate: 2940 });
});

test('moving average: steps given out of date order give the same ledger', () => {
  // Opening first, then the day-5 sale, then the earlier days (each step keeps stock at or above zero).
  const r = run([steps[0], steps[4], steps[3], steps[2], steps[1]]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stock.map((x) => x.step), ['R1', 'P1', 'D1', 'P2', 'D2']);
  figures(row(r, 'D2'), 100, 2940, 294000, -294000);
});

test('material issue: 3 damaged @ 1,050 goes to stock adjustment (R20)', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 1050 }] },
    { id: 'I1', kind: 'issue', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 3 }] },
  ]);
  figures(row(r, 'I1'), 7, 1050, 7350, -3150);
  assert.deepEqual(gl(r, 'I1'), { stock: -3150, stock_adjustment: 3150 });
});
