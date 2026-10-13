// The worked VAT examples of 01 §5.3 (TZS, 18 %, half-even rounding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotals } from './taxes.ts';

const VAT_EX = { rate: 18, inclusive: false }, VAT_IN = { rate: 18, inclusive: true };

test('A: exclusive 100,000 + 18 %', () => {
  const t = invoiceTotals([{ item: 'a', qty: 1, rate: 100000 }], VAT_EX, true);
  assert.deepEqual([t.netTotal, t.vat, t.grandTotal, t.roundedTotal], [100000, 18000, 118000, 118000]);
});

test('B: inclusive 5,900 -> net 5,000, VAT 900', () => {
  const t = invoiceTotals([{ item: 'a', qty: 1, rate: 5900 }], VAT_IN, true);
  assert.deepEqual([t.netTotal, t.vat, t.grandTotal], [5000, 900, 5900]);
});

test('C: inclusive, two lines, no cent lost', () => {
  const t = invoiceTotals([{ item: 'a', qty: 2, rate: 3500 }, { item: 'b', qty: 3, rate: 1200 }], VAT_IN, true);
  assert.deepEqual([t.lines[0].net, t.lines[1].net, t.netTotal, t.vat, t.grandTotal], [5932.2, 3050.85, 8983.05, 1616.95, 10600]);
});

test('D: inclusive cent loss kept on the grand total', () => {
  const t = invoiceTotals([{ item: 'a', qty: 1, rate: 1000 }, { item: 'b', qty: 1, rate: 2500 }, { item: 'c', qty: 1, rate: 750 }], VAT_IN, true);
  assert.deepEqual([t.netTotal, t.vat, t.grandTotal, t.roundedTotal], [3601.69, 648.3, 4250, 4250]);
});

test('E: rounded total and its adjustment', () => {
  const t = invoiceTotals([{ item: 'a', qty: 1, rate: 1234 }], VAT_EX, true);
  assert.deepEqual([t.vat, t.grandTotal, t.roundedTotal, t.roundingAdjustment], [222.12, 1456.12, 1456, -0.12]);
});

test('F: half to even on whole shillings', () => {
  const t = invoiceTotals([{ item: 'a', qty: 1, rate: 2775 }], VAT_EX, true);
  assert.deepEqual([t.grandTotal, t.roundedTotal, t.roundingAdjustment], [3274.5, 3274, -0.5]);
  assert.equal(invoiceTotals([{ item: 'a', qty: 1, rate: 2775 }], VAT_EX, false).roundedTotal, 3274.5);
});

test('G: mixed basket, exempt rice at 0 %', () => {
  const t = invoiceTotals([{ item: 'rice', qty: 1, rate: 13200, vatRate: 0 }, { item: 'soap', qty: 1, rate: 1180 }], VAT_IN, true);
  assert.deepEqual([t.netTotal, t.vat, t.grandTotal], [14200, 180, 14380]);
  assert.deepEqual(t.lines.map((l) => [l.item, l.vatRate, l.vat]), [['rice', 0, 0], ['soap', 18, 180]]);
});
