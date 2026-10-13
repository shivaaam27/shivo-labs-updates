// Negative stock (02 §5.3): refused when not allowed (R10), valued and corrected when allowed (R11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, figures, gl, on, row, rows, run } from './testkit.ts';

for (const method of ['Moving Average', 'FIFO'] as const) {
  test(`negative off (${method}): stock 5, delivery 8 is refused and writes nothing (R10)`, () => {
    const r = run([
      { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 5, rate: 1000 }] },
      { id: 'D1', kind: 'delivery', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 8, rate: 1500 }] },
    ], { items: { A: method } });
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].step, 'D1');
    assert.match(r.errors[0].message, /^3 units of A needed in Stores/);
    assert.equal(rows(r, 'D1').length, 0);
    assert.equal(r.stock.length, 1);
    assert.equal(r.ledger.filter((x) => x.step === 'D1').length, 0);
    assert.deepEqual(balance(r, 'A', 'Stores'), { item: 'A', warehouse: 'Stores', qty: 5, value: 5000, valuationRate: 1000 });
  });

  test(`negative on (${method}): +10 @ 1,000; -15; PR +15 @ 1,500 (R11)`, () => {
    const r = run([
      { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 1000 }] },
      { id: 'D1', kind: 'delivery', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 15, rate: 1500 }] },
      { id: 'P1', kind: 'purchase_receipt', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 15, rate: 1500 }] },
    ], { items: { A: method }, allowNegativeStock: true });
    assert.deepEqual(r.errors, []);
    figures(row(r, 'D1'), -5, 1000, -5000, -15000);
    figures(row(r, 'P1'), 10, 1500, 15000, 20000);
    assert.deepEqual(gl(r, 'D1'), { stock: -15000, cost_of_goods_sold: 15000 });
    // Dr Stock 20,000 + Dr COGS 2,500 (divisional loss) / Cr SRBNB 22,500.
    assert.deepEqual(gl(r, 'P1'), { stock: 20000, stock_received_not_billed: -22500, cost_of_goods_sold: 2500 });
  });
}

test('negative off: a back-dated issue that makes a later row negative is refused (02 §5.3)', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'D1', kind: 'delivery', ...on(5), warehouse: 'Stores', lines: [{ item: 'A', qty: 8, rate: 150 }] },
    { id: 'I1', kind: 'issue', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 5 }] },
  ]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].step, 'I1');
  assert.match(r.errors[0].message, /^3 units of A needed in Stores on 2026-10-05/);
  assert.equal(rows(r, 'I1').length, 0);
  figures(row(r, 'D1'), 2, 100, 200, -800);
});

test('negative on: an issue with no cost ever known is refused (02 §5.4)', () => {
  const r = run([
    { id: 'I1', kind: 'issue', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 1 }] },
  ], { allowNegativeStock: true });
  assert.equal(r.errors[0]?.step, 'I1');
  assert.match(r.errors[0].message, /Valuation rate missing/);
  assert.equal(r.stock.length, 0);
});

test('bad steps are refused with a reason', () => {
  const r = run([
    { id: 'X1', kind: 'receipt', ...on(1), warehouse: 'Nowhere', lines: [{ item: 'A', qty: 1, rate: 1 }] },
    { id: 'X2', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 1 }] },
    { id: 'X3', kind: 'transfer', ...on(1), from: 'Stores', to: 'Stores', lines: [{ item: 'A', qty: 1 }] },
    { id: 'X4', kind: 'issue', ...on(1), warehouse: 'Stores', lines: [{ item: 'Z', qty: 1 }] },
  ]);
  assert.deepEqual(r.errors.map((e) => e.step), ['X1', 'X2', 'X3', 'X4']);
  assert.equal(r.stock.length, 0);
});
