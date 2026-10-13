// Cancel = reversal (02 §4.2 step 2, 01 §2.6; R13): the original rows and their mirror rows are both
// flagged cancelled, later rows are valued again, and the step's ledger rows drop out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Step } from '../contract.ts';
import { balance, figures, gl, on, row, run } from './testkit.ts';

const r12: Step[] = [
  { id: 'O1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 1000 }] },
  { id: 'DN1', kind: 'delivery', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 50, rate: 1500 }] },
  { id: 'PR1', kind: 'purchase_receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 1300 }] },
];

test('cancel the day-3 delivery of R12: balance 200 @ 1,150 (R13)', () => {
  const r = run([...r12, { id: 'X1', kind: 'cancel', ...on(5), target: 'DN1' }]);
  assert.deepEqual(r.errors, []);
  const dn = r.stock.filter((x) => x.step === 'DN1');
  assert.equal(dn.length, 2); // original + mirror
  assert.ok(dn.every((x) => x.cancelled));
  assert.deepEqual(dn.map((x) => x.qty), [-50, 50]);
  assert.deepEqual(dn.map((x) => x.valueChange), [-57500, 57500]);
  assert.deepEqual(balance(r, 'A', 'Stores'), { item: 'A', warehouse: 'Stores', qty: 200, value: 230000, valuationRate: 1150 });
  assert.deepEqual(gl(r, 'DN1'), {});
  assert.deepEqual(gl(r, 'X1'), {});
});

test('cancel a back-dated receipt: later rows go back to their old figures', () => {
  const r = run([...r12, { id: 'X1', kind: 'cancel', ...on(5), target: 'PR1' }]);
  assert.deepEqual(r.errors, []);
  figures(row(r, 'DN1'), 50, 1000, 50000, -50000);
  assert.deepEqual(gl(r, 'DN1'), { stock: -50000, cost_of_goods_sold: 50000 });
  assert.deepEqual(gl(r, 'PR1'), {});
});

test('cancel refused when it would leave a later row below zero', () => {
  const r = run([
    { id: 'O1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'D1', kind: 'delivery', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 8, rate: 150 }] },
    { id: 'X1', kind: 'cancel', ...on(3), target: 'O1' },
  ]);
  assert.deepEqual(r.errors.map((e) => e.step), ['X1']);
  assert.match(r.errors[0].message, /^8 units of A needed in Stores/);
  assert.ok(r.stock.every((x) => !x.cancelled));
});

test('cancel twice, or cancel an unknown step, is refused', () => {
  const r = run([
    { id: 'O1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'X1', kind: 'cancel', ...on(2), target: 'O1' },
    { id: 'X2', kind: 'cancel', ...on(2), target: 'O1' },
    { id: 'X3', kind: 'cancel', ...on(2), target: 'NOPE' },
    { id: 'X4', kind: 'cancel', ...on(2), target: 'X1' },
  ]);
  assert.deepEqual(r.errors.map((e) => e.step), ['X2', 'X3', 'X4']);
  assert.deepEqual(r.balances, []);
});
