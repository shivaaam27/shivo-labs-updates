// Back-dated steps (02 §4.4, R12): the new row goes in date order and every later row of that
// item+warehouse is valued again, including the cascade through transfers (02 §4.4 step 3.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Step } from '../contract.ts';
import { figures, gl, on, row, run } from './testkit.ts';

const r12: Step[] = [
  { id: 'O1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 1000 }] },
  { id: 'DN1', kind: 'delivery', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 50, rate: 1500 }] },
  { id: 'PR1', kind: 'purchase_receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 1300 }] },
];

test('back-dated receipt, moving average: later sale re-valued to 57,500 (R12)', () => {
  const r = run(r12);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stock.map((x) => x.step), ['O1', 'PR1', 'DN1']); // date order, not creation order
  figures(row(r, 'PR1'), 200, 1150, 230000, 130000);
  figures(row(r, 'DN1'), 150, 1150, 172500, -57500);
  assert.deepEqual(gl(r, 'DN1'), { stock: -57500, cost_of_goods_sold: 57500 });
});

test('back-dated receipt, fifo: later sale still takes the oldest layer, 50,000 (R12)', () => {
  const r = run(r12, { items: { A: 'FIFO' } });
  figures(row(r, 'DN1'), 150, 1200, 180000, -50000);
  assert.deepEqual(gl(r, 'DN1'), { stock: -50000, cost_of_goods_sold: 50000 });
});

test('same date and time: rows keep creation order (02 §4.3)', () => {
  const r = run([
    { id: 'O1', kind: 'receipt', ...on(1, '09:00:00'), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'D1', kind: 'delivery', ...on(1, '09:00:00'), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 150 }] },
    { id: 'O2', kind: 'receipt', ...on(1, '09:00:00'), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 300 }] },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stock.map((x) => x.step), ['O1', 'D1', 'O2']);
  figures(row(r, 'O2'), 10, 300, 3000, 3000);
});

test('back-dated receipt in the store re-values a later transfer and the van\'s sale (cascade)', () => {
  const r = run([
    { id: 'O1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 1000 }] },
    { id: 'T1', kind: 'transfer', ...on(3), from: 'Stores', to: 'Van', lines: [{ item: 'A', qty: 50 }] },
    { id: 'S1', kind: 'delivery', ...on(4), warehouse: 'Van', lines: [{ item: 'A', qty: 50, rate: 2000 }] },
    { id: 'PR1', kind: 'purchase_receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 1300 }] },
  ]);
  assert.deepEqual(r.errors, []);
  figures(row(r, 'T1', 'A', 'Stores'), 150, 1150, 172500, -57500);
  figures(row(r, 'T1', 'A', 'Van'), 50, 1150, 57500, 57500);
  figures(row(r, 'S1'), 0, 1150, 0, -57500);
  assert.deepEqual(gl(r, 'S1'), { stock: -57500, cost_of_goods_sold: 57500 });
});
