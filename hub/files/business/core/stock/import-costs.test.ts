// Import costs on the engine (phase 5c, 04 §7, 02 §6.7): one landed cost over several goods arrived, cost lines
// spread by value, by quantity or typed per line, each credited to its own account; import VAT, expenses and deposits
// kept out of the goods and booked by the landed cost itself; the landed cost per unit for the screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Step } from '../contract.ts';
import { figures, gl, near, on, row, run } from './testkit.ts';

const ITEMS = { items: { A: 'Moving Average' as const, B: 'FIFO' as const } };
const p1: Step = { id: 'p1', kind: 'purchase_receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }, { item: 'B', qty: 5, rate: 200 }] };
const p2: Step = { id: 'p2', kind: 'purchase_receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 20, rate: 110 }] };

test('one landed cost over two goods arrived, by value: the cent left over goes to the last line of the last receipt', () => {
  const r = run([p1, p2, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', receipts: ['p1', 'p2'], amount: 1000, distribute: 'amount' }], ITEMS);
  assert.deepEqual(r.errors, []);
  // values 1,000 + 1,000 + 2,200 = 4,200: 238.10 + 238.10 + 523.80
  assert.deepEqual(gl(r, 'p1'), { stock: 2476.2, stock_received_not_billed: -2000, expenses_in_valuation: -476.2 });
  assert.deepEqual(gl(r, 'p2'), { stock: 2723.8, stock_received_not_billed: -2200, expenses_in_valuation: -523.8 });
  assert.deepEqual(r.landed?.map((l) => [l.receipt, l.line, l.extra]), [['p1', 0, 238.1], ['p1', 1, 238.1], ['p2', 0, 523.8]]);
  near(r.landed![2].perUnit, 110 + 523.8 / 20, 1e-9, 'per unit');
});

test('a receipt with a landed cost on it cannot be undone; the landed cost can, from both receipts at once', () => {
  const lc: Step = { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', receipts: ['p1', 'p2'], amount: 300, distribute: 'qty' };
  const r = run([p1, p2, lc, { id: 'x', kind: 'cancel', ...on(4), target: 'p2' }], ITEMS);
  assert.deepEqual(r.errors.map((e) => e.step), ['x']);
  const r2 = run([p1, p2, lc, { id: 'x', kind: 'cancel', ...on(4), target: 'lc' }], ITEMS);
  assert.deepEqual(r2.errors, []);
  figures(row(r2, 'p2'), 30, 106.67, 3200, 2200);
  assert.equal(r2.landed, undefined);
});

test('cost lines: freight by value and duty typed per line, each to its own account', () => {
  const r = run([p1, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', amount: 700, distribute: 'amount', charges: [
    { amount: 400, distribute: 'amount', role: 'expenses_in_valuation', account: 'ACC-FREIGHT' },
    { amount: 300, distribute: 'manual', role: 'expense', account: 'ACC-DUTY', shares: [{ receipt: 'p1', line: 1, amount: 300 }] },
  ] }], ITEMS);
  assert.deepEqual(r.errors, []);
  // A: 200 freight; B: 200 freight + 300 duty
  figures(row(r, 'p1', 'A'), 10, 120, 1200, 1200);
  figures(row(r, 'p1', 'B'), 5, 300, 1500, 1500);
  assert.deepEqual(gl(r, 'p1'), { stock: 2700, stock_received_not_billed: -2000, expenses_in_valuation: -400, expense: -300 });
  const own = (r.entries ?? []).filter((e) => e.step === 'p1' && e.credit).map((e) => [e.role, e.ref ?? null, e.credit]);
  assert.deepEqual(own, [['stock_received_not_billed', null, 2000], ['expenses_in_valuation', 'ACC-FREIGHT', 400], ['expense', 'ACC-DUTY', 300]]);
});

test('import VAT, an expense and a deposit stay out of the goods: the landed cost books them itself', () => {
  const r = run([p1, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', amount: 100, distribute: 'qty', charges: [
    { amount: 150, treatment: 'cost' },
    { amount: 180, treatment: 'vat', account: 'ACC-AGENT' },
    { amount: 50, treatment: 'expense', debitAccount: 'ACC-FEES', account: 'ACC-AGENT' },
    { amount: 500, treatment: 'deposit', debitAccount: 'ACC-DEPOSITS', account: 'ACC-AGENT' },
  ] }], ITEMS);
  assert.deepEqual(r.errors.map((e) => e.message), ['Landed cost amount 100 is not the sum of its cost lines (150)']);
  const ok = run([p1, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', amount: 150, distribute: 'qty', charges: [
    { amount: 150, treatment: 'cost' },
    { amount: 180, treatment: 'vat', account: 'ACC-AGENT' },
    { amount: 50, treatment: 'expense', debitAccount: 'ACC-FEES', account: 'ACC-AGENT' },
    { amount: 500, treatment: 'deposit', debitAccount: 'ACC-DEPOSITS', account: 'ACC-AGENT' },
  ] }], ITEMS);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(gl(ok, 'p1'), { stock: 2150, stock_received_not_billed: -2000, expenses_in_valuation: -150 });
  assert.deepEqual(gl(ok, 'lc'), { expenses_in_valuation: -730, vat: 180, expense: 50, other: 500 });
  const lc = (ok.entries ?? []).filter((e) => e.step === 'lc').map((e) => [e.role, e.ref ?? null, e.debit - e.credit]);
  assert.deepEqual(lc, [['vat', null, 180], ['expenses_in_valuation', 'ACC-AGENT', -730], ['expense', 'ACC-FEES', 50], ['other', 'ACC-DEPOSITS', 500]]);
  // only import VAT (nothing added to the goods), then undone: its own lines go
  const x = run([p1, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', amount: 0, distribute: 'qty', charges: [{ amount: 180, treatment: 'vat' }] },
    { id: 'x', kind: 'cancel', ...on(4), target: 'lc' }], ITEMS);
  assert.deepEqual(x.errors, []);
  assert.deepEqual(gl(x, 'lc'), {});
});

test('typed per line: the amounts must add up to the cost line and name lines of its receipts', () => {
  const bad = (shares: { receipt: string; line: number; amount: number }[]) => run([p1, p2, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', amount: 300,
    distribute: 'manual', charges: [{ amount: 300, shares }] }], ITEMS).errors.map((e) => e.message);
  assert.match(bad([{ receipt: 'p1', line: 0, amount: 200 }])[0], /must add up/);
  assert.match(bad([{ receipt: 'p2', line: 0, amount: 300 }])[0], /not on the receipts/);
  assert.match(bad([{ receipt: 'p1', line: 5, amount: 300 }])[0], /not on the receipts/);
  assert.deepEqual(bad([{ receipt: 'p1', line: 0, amount: 100 }, { receipt: 'p1', line: 1, amount: 200 }]), []);
});

test('costs added after part of the goods were sold re-cost what was sold (R8), on FIFO layers too', () => {
  const r = run([
    { id: 'p', kind: 'purchase_receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 100, rate: 1000 }, { item: 'B', qty: 100, rate: 1000 }] },
    { id: 'd', kind: 'delivery', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 40, rate: 1500 }, { item: 'B', qty: 40, rate: 1500 }] },
    { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p', amount: 20000, distribute: 'qty', charges: [{ amount: 12000 }, { amount: 8000, distribute: 'amount' }] },
  ], ITEMS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(gl(r, 'd'), { stock: -88000, cost_of_goods_sold: 88000 });
  figures(row(r, 'd', 'B'), 60, 1100, 66000, -44000);
});

test('a landed cost is refused on a goods-arrived return or a receipt named twice', () => {
  const ret = { id: 'r', kind: 'purchase_receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 1, rate: 100 }], returnOf: 'p1' } as Step;
  const e1 = run([p1, ret, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'r', amount: 10, distribute: 'qty' }], ITEMS).errors.find((e) => e.step === 'lc');
  assert.match(e1!.message, /is not one/);
  const e2 = run([p1, { id: 'lc', kind: 'landed_cost', ...on(3), receipt: 'p1', receipts: ['p1', 'p1'], amount: 10, distribute: 'qty' }], ITEMS).errors;
  assert.match(e2[0].message, /named twice/);
});
