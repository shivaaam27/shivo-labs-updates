// Transfers between warehouses (02 §6.2, §6.1): out at valuation, in at the same value; no ledger rows
// because every warehouse uses the one Stock role (R5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, figures, gl, on, row, run } from './testkit.ts';

test('transfer Stores -> Van: Sugar 20 @ 2,800, Water 48 @ 330, no ledger rows (R5)', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'Sugar', qty: 200, rate: 2800 }, { item: 'Water', qty: 240, rate: 330 }] },
    { id: 'T1', kind: 'transfer', ...on(2), from: 'Stores', to: 'Van', lines: [{ item: 'Sugar', qty: 20 }, { item: 'Water', qty: 48 }] },
  ], { items: { Sugar: 'FIFO', Water: 'Moving Average' } });
  assert.deepEqual(r.errors, []);
  figures(row(r, 'T1', 'Sugar', 'Stores'), 180, 2800, 504000, -56000);
  figures(row(r, 'T1', 'Water', 'Stores'), 192, 330, 63360, -15840);
  figures(row(r, 'T1', 'Sugar', 'Van'), 20, 2800, 56000, 56000);
  figures(row(r, 'T1', 'Water', 'Van'), 48, 330, 15840, 15840);
  assert.deepEqual(gl(r, 'T1'), {});
  // Outward rows are written before inward rows (02 §4.2 step 1).
  assert.deepEqual(r.stock.filter((x) => x.step === 'T1').map((x) => x.warehouse), ['Stores', 'Stores', 'Van', 'Van']);
});

test('fifo transfer: the target gets ONE layer at the average cost of what left (referee S03)', () => {
  // Stores [10 @ 100][10 @ 200]; 15 leave = 10 x 100 + 5 x 200 = 2,000. The van does not get those two
  // layers: it gets [15 @ 2,000 / 15 = 133.33], so its first sale costs the average, not 100.
  // (Earlier we copied the layers, after 02 §11 ":942"; the referee showed ERPNext v15 does not.)
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'R2', kind: 'receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 200 }] },
    { id: 'T1', kind: 'transfer', ...on(3), from: 'Stores', to: 'Van', lines: [{ item: 'A', qty: 15 }] },
    { id: 'S1', kind: 'delivery', ...on(4), warehouse: 'Van', lines: [{ item: 'A', qty: 10, rate: 300 }] },
  ], { items: { A: 'FIFO' } });
  figures(row(r, 'T1', 'A', 'Stores'), 5, 200, 1000, -2000);
  figures(row(r, 'T1', 'A', 'Van'), 15, 2000 / 15, 2000, 2000);
  figures(row(r, 'S1'), 5, 2000 / 15, 666.67, -1333.33);
  assert.deepEqual(balance(r, 'A', 'Stores'), { item: 'A', warehouse: 'Stores', qty: 5, value: 1000, valuationRate: 200 });
});

test('fifo transfer then a new receipt in the van: the transferred layer goes first', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'B', qty: 10, rate: 100 }, { item: 'B', qty: 10, rate: 130 }] },
    { id: 'T1', kind: 'transfer', ...on(2), from: 'Stores', to: 'Van', lines: [{ item: 'B', qty: 15 }] },
    { id: 'R2', kind: 'receipt', ...on(3), warehouse: 'Van', lines: [{ item: 'B', qty: 10, rate: 200 }] },
    { id: 'I1', kind: 'issue', ...on(4), warehouse: 'Van', lines: [{ item: 'B', qty: 20 }] },
  ], { items: { B: 'FIFO' } });
  // Van: [15 @ 110] then [10 @ 200]; issuing 20 takes 15 x 110 + 5 x 200 = 2,650, leaving [5 @ 200].
  figures(row(r, 'T1', 'B', 'Van'), 15, 110, 1650, 1650);
  figures(row(r, 'I1'), 5, 200, 1000, -2650);
});

test('transfer needs stock in the source warehouse', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 5, rate: 100 }] },
    { id: 'T1', kind: 'transfer', ...on(2), from: 'Stores', to: 'Van', lines: [{ item: 'A', qty: 6 }] },
  ]);
  assert.equal(r.errors[0]?.step, 'T1');
  assert.match(r.errors[0].message, /^1 units of A needed in Stores/);
  assert.equal(r.stock.length, 1);
});
