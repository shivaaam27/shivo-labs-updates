// Foreign currency (phase 5b, fx.ts): the cases the referee stories M30-M35 do not cover on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../run.ts';
import type { Scenario, Step } from '../contract.ts';

const base = (steps: Step[], extra: Partial<Scenario> = {}): Scenario => ({
  id: 't', title: 't', items: [{ key: 'A', valuation: 'Moving Average' }, { key: 'S', valuation: 'Moving Average', stock: false }],
  warehouses: ['W'], parties: [{ key: 'acme', type: 'supplier', currency: 'USD', account: 'ACC-CRED-USD' }, { key: 'safari', type: 'customer', currency: 'USD' },
    { key: 'duka', type: 'customer' }], steps, ...extra,
});
const at = (d: number) => ({ date: `2026-10-${String(d).padStart(2, '0')}`, time: '10:00:00' });
const L = (r: ReturnType<typeof runScenario>, step: string) =>
  Object.fromEntries(r.ledger.filter((l) => l.step === step).map((l) => [l.role, [l.debit, l.credit]]));
const inv = (r: ReturnType<typeof runScenario>, step: string) => r.invoices!.find((i) => i.step === step)!;
const usd = (rate: number) => ({ currency: 'USD', exchangeRate: rate });

test('a USD bill brings goods in at their TZS cost, keeps its cents, and its creditors rows go to the USD account', () => {
  const r = runScenario(base([{ id: 'b', kind: 'purchase_invoice', ...at(1), supplier: 'acme', ...usd(2510.5), updateStock: true, warehouse: 'W',
    lines: [{ item: 'A', qty: 3, rate: 33.33 }] }]));
  assert.deepEqual([inv(r, 'b').roundedTotal, inv(r, 'b').outstanding], [99.99, 99.99]);   // no whole-shilling rounding in USD
  assert.equal(r.balances[0].value, 251024.9);   // 99.99 x 2,510.5
  assert.deepEqual(L(r, 'b'), { stock: [251024.9, 0], payable: [0, 251024.9] });
  assert.ok(r.entries!.some((e) => e.step === 'b' && e.role === 'payable' && e.ref === 'ACC-CRED-USD'));
  assert.deepEqual(r.parties, [{ party: 'acme', balance: 251024.9, inCurrency: 99.99 }]);
});

test('goods arrived in USD go into stock in TZS', () => {
  const r = runScenario(base([{ id: 'g', kind: 'purchase_receipt', ...at(1), warehouse: 'W', ...usd(2500), lines: [{ item: 'A', qty: 2, rate: 10 }] }]));
  assert.deepEqual([r.balances[0].qty, r.balances[0].value, r.balances[0].valuationRate], [2, 50000, 25000]);
  assert.deepEqual(L(r, 'g'), { stock: [50000, 0], stock_received_not_billed: [0, 50000] });
});

test('cancelling a USD invoice that was paid at another rate takes the exchange difference away; the payment is credit at its own rate', () => {
  const r = runScenario(base([
    { id: 'b', kind: 'purchase_invoice', ...at(1), supplier: 'acme', ...usd(2500), lines: [{ item: 'S', qty: 1, rate: 100 }] },
    { id: 'p', kind: 'payment', ...at(2), direction: 'out', party: 'acme', account: 'bank', amount: 100, ...usd(2600), allocate: [{ invoice: 'b', amount: 100 }] },
    { id: 'x', kind: 'cancel', ...at(3), target: 'b' },
  ]));
  assert.deepEqual(L(r, 'p'), { payable: [260000, 0], bank: [0, 260000] });
  assert.deepEqual(r.parties, [{ party: 'acme', balance: -260000, inCurrency: -100 }]);
});

test('a USD customer pays more shillings than invoiced: a gain; their credit limit counts in TZS', () => {
  const r = runScenario(base([
    { id: 's', kind: 'sales_invoice', ...at(1), customer: 'safari', ...usd(2500), lines: [{ item: 'S', qty: 1, rate: 200 }] },
    { id: 'p', kind: 'payment', ...at(2), direction: 'in', party: 'safari', account: 'cash', amount: 200, ...usd(2550), allocate: [{ invoice: 's', amount: 200 }] },
    { id: 's2', kind: 'sales_invoice', ...at(3), customer: 'safari', ...usd(2500), lines: [{ item: 'S', qty: 1, rate: 500 }] },
  ], { parties: [{ key: 'safari', type: 'customer', currency: 'USD', creditLimit: 1000000 }] }));
  assert.deepEqual(L(r, 'p'), { receivable: [10000, 510000], cash: [510000, 0], exchange_gain_loss: [0, 10000] });
  // 500 USD at 2,500 = 1,250,000 TZS: over the 1,000,000 limit
  assert.match(r.errors.find((e) => e.step === 's2')!.message, /Credit limit crossed/);
});

test('refused: wrong currency for the party, no rate, charges on a USD payment, a USD row without its rate', () => {
  const r = runScenario(base([
    { id: 'a', kind: 'sales_invoice', ...at(1), customer: 'duka', ...usd(2500), lines: [{ item: 'S', qty: 1, rate: 1 }] },
    { id: 'b', kind: 'purchase_invoice', ...at(1), supplier: 'acme', currency: 'USD', lines: [{ item: 'S', qty: 1, rate: 1 }] },
    { id: 'c', kind: 'payment', ...at(2), direction: 'out', party: 'acme', account: 'bank', amount: 10, ...usd(2500), deductions: [{ role: 'expense', amount: 5000 }] },
    { id: 'd', kind: 'journal', ...at(2), rows: [{ role: 'payable', party: 'acme', debit: 10 }, { role: 'bank', credit: 10 }] },
    { id: 'e', kind: 'payment', ...at(2), direction: 'out', party: 'acme', account: 'bank', amount: 10 },
  ]));
  assert.deepEqual(r.errors.map((e) => e.step), ['a', 'b', 'c', 'd', 'e']);
});

test('a journal in two currencies balances in TZS; a party row in USD keeps the USD balance', () => {
  const r = runScenario(base([
    { id: 'j', kind: 'journal', ...at(1), rows: [{ role: 'payable', party: 'acme', debit: 100, exchangeRate: 2500 }, { role: 'bank', credit: 250000 }] },
    { id: 'k', kind: 'journal', ...at(2), rows: [{ role: 'payable', party: 'acme', debit: 100, exchangeRate: 2500 }, { role: 'bank', credit: 100 }] },
  ]));
  assert.deepEqual(L(r, 'j'), { payable: [250000, 0], bank: [0, 250000] });
  assert.deepEqual(r.errors.map((e) => e.step), ['k']);
  assert.deepEqual(r.parties, [{ party: 'acme', balance: -250000, inCurrency: -100 }]);
});
