// 02 §5.2 worked example, referee tests R9 and R7, and the queue rules themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToQueue, takeFromQueue } from './fifo.ts';
import type { Layer } from './fifo.ts';
import { balance, figures, gl, on, row, run } from './testkit.ts';

const FIFO = { items: { A: 'FIFO' as const } };

test('fifo: the 02 §5.2 table row by row (R9)', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 2800 }] },
    { id: 'P1', kind: 'purchase_receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 50, rate: 3100 }] },
    { id: 'D1', kind: 'delivery', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 30, rate: 4000 }] },
    { id: 'P2', kind: 'purchase_receipt', ...on(4), warehouse: 'Stores', lines: [{ item: 'A', qty: 80, rate: 3000 }] },
    { id: 'D2', kind: 'delivery', ...on(5), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 4000 }] },
  ], FIFO);
  assert.deepEqual(r.errors, []);
  figures(row(r, 'R1'), 100, 2800, 280000, 280000);
  figures(row(r, 'P1'), 150, 2900, 435000, 155000);
  figures(row(r, 'D1'), 120, 2925, 351000, -84000);
  figures(row(r, 'P2'), 200, 2955, 591000, 240000);
  figures(row(r, 'D2'), 100, 3020, 302000, -289000);
  assert.deepEqual(gl(r, 'D1'), { stock: -84000, cost_of_goods_sold: 84000 });
  assert.deepEqual(gl(r, 'D2'), { stock: -289000, cost_of_goods_sold: 289000 });
  assert.equal(balance(r, 'A', 'Stores')?.value, 302000);
});

test('fifo: selling everything leaves qty 0 and value 0 (R7 pattern)', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 79, rate: 13000 }] },
    { id: 'S1', kind: 'delivery', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 79, rate: 14000 }] },
  ], FIFO);
  const x = row(r, 'S1');
  assert.equal(x.qtyAfter, 0);
  assert.equal(x.stockValue, 0);
  assert.equal(x.valueChange, -1027000);
});

test('fifo queue: same rate merges, other rate appends', () => {
  const q: Layer[] = [];
  addToQueue(q, 10, 100);
  addToQueue(q, 5, 100);
  addToQueue(q, 5, 120);
  assert.deepEqual(q, [[15, 100], [5, 120]]);
});

test('fifo queue: removal takes oldest layers first and reports the pieces', () => {
  const q: Layer[] = [[15, 100], [5, 120]];
  assert.deepEqual(takeFromQueue(q, 17, 0), [[15, 100], [2, 120]]);
  assert.deepEqual(q, [[3, 120]]);
});

test('fifo queue: running out leaves one negative layer at the last rate; refill turns to the new rate', () => {
  const q: Layer[] = [[10, 1000]];
  takeFromQueue(q, 15, 0);
  assert.deepEqual(q, [[-5, 1000]]);
  addToQueue(q, 3, 1500);
  assert.deepEqual(q, [[-2, 1000]]); // still negative: keeps its old rate
  addToQueue(q, 12, 1500);
  assert.deepEqual(q, [[10, 1500]]);
});

test('fifo queue: empty queue uses the fallback rate', () => {
  const q: Layer[] = [];
  assert.deepEqual(takeFromQueue(q, 4, 250), [[4, 250]]);
  assert.deepEqual(q, [[-4, 250]]);
});
