// Stock counts (02 §6.3): set qty and rate; the difference goes to Stock Adjustment (R6, R1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figures, gl, on, row, run } from './testkit.ts';

test('count: Salt was 300 @ 700, counted 295 (R6)', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 300, rate: 700 }] },
    { id: 'C1', kind: 'count', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 295, rate: 700 }] },
  ]);
  const c = row(r, 'C1');
  assert.equal(c.qty, -5); // the row records the real change, counted minus before (referee S04; ERPNext stores 0 but means this)
  figures(c, 295, 700, 206500, -3500);
  assert.deepEqual(gl(r, 'C1'), { stock: -3500, stock_adjustment: 3500 });
});

test('count as opening stock: Sugar 200 @ 2,800 into an empty store (R1 figures)', () => {
  const r = run([
    { id: 'C1', kind: 'count', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 200, rate: 2800 }] },
  ], { items: { A: 'FIFO' } });
  figures(row(r, 'C1'), 200, 2800, 560000, 560000);
  // ERPNext books opening stock to Temporary Opening; the contract has no such role, so a count posts to Stock Adjustment.
  assert.deepEqual(gl(r, 'C1'), { stock: 560000, stock_adjustment: -560000 });
});

test('count: a fifo count replaces the queue with one layer at the counted rate', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'R2', kind: 'receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 200 }] },
    { id: 'C1', kind: 'count', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 18, rate: 150 }] },
    { id: 'S1', kind: 'delivery', ...on(4), warehouse: 'Stores', lines: [{ item: 'A', qty: 4, rate: 300 }] },
  ], { items: { A: 'FIFO' } });
  figures(row(r, 'C1'), 18, 150, 2700, -300);
  figures(row(r, 'S1'), 14, 150, 2100, -600);
});

test('count: a line that changes nothing is dropped; a count with nothing left is refused', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }, { item: 'B', qty: 5, rate: 50 }] },
    { id: 'C1', kind: 'count', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }, { item: 'B', qty: 4, rate: 50 }] },
    { id: 'C2', kind: 'count', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
  ], { items: { A: 'Moving Average', B: 'Moving Average' } });
  assert.deepEqual(r.stock.filter((x) => x.step === 'C1').map((x) => x.item), ['B']);
  assert.deepEqual(r.errors.map((e) => e.step), ['C2']);
});

test('count: a back-dated receipt before a count does not change the counted balance', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 10 }] },
    { id: 'C1', kind: 'count', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 80, rate: 10 }] },
    { id: 'S1', kind: 'delivery', ...on(4), warehouse: 'Stores', lines: [{ item: 'A', qty: 30, rate: 20 }] },
    { id: 'R2', kind: 'receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 50, rate: 10 }] },
  ]);
  assert.deepEqual(r.errors, []);
  // The count still asserts 80; its difference is now against 150 instead of 100 (02 §4.2 step 5).
  figures(row(r, 'C1'), 80, 10, 800, -700);
  assert.equal(row(r, 'C1').qty, -70); // its qty change follows: 80 - 150
  figures(row(r, 'S1'), 50, 10, 500, -300);
});
