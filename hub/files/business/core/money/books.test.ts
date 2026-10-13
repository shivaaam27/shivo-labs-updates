// Money postings against the worked examples of 01 §7 and the referee list 01 §9 (R1, R2, R3, R4, R9, R10, R11, R12, R13, R14, R15, R20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../run.ts';
import type { Scenario, Step } from '../contract.ts';

const base = (steps: Step[], extra: Partial<Scenario> = {}): Scenario => ({
  id: 't', title: 't', items: [{ key: 'A', valuation: 'Moving Average' }, { key: 'B', valuation: 'Moving Average' }, { key: 'C', valuation: 'FIFO' }],
  warehouses: ['S'], parties: [{ key: 'duka', type: 'customer' }, { key: 'walkin', type: 'customer' }, { key: 'sup', type: 'supplier' }], steps, ...extra,
});
const at = (d: number) => ({ date: `2026-10-${String(d).padStart(2, '0')}`, time: '10:00:00' });
const L = (r: ReturnType<typeof runScenario>, step: string) =>
  Object.fromEntries(r.ledger.filter((l) => l.step === step).map((l) => [l.role, [l.debit, l.credit]]));
const inv = (r: ReturnType<typeof runScenario>, step: string) => r.invoices!.find((i) => i.step === step)!;

test('R1: credit sale, VAT 18 % exclusive', () => {
  const r = runScenario(base([{ id: 'si', kind: 'sales_invoice', ...at(1), dueDate: '2099-01-01', customer: 'duka', lines: [{ item: 'A', qty: 1, rate: 100000 }], tax: { rate: 18, inclusive: false } }]));
  assert.deepEqual(L(r, 'si'), { receivable: [118000, 0], vat: [0, 18000], income: [0, 100000] });
  assert.deepEqual([inv(r, 'si').outstanding, inv(r, 'si').status], [118000, 'Unpaid']);
  assert.deepEqual(r.parties, [{ party: 'duka', balance: 118000 }]);
});

test('R2: credit sale that moves goods books their cost', () => {
  const r = runScenario(base([
    { id: 'in', kind: 'receipt', ...at(1), warehouse: 'S', lines: [{ item: 'A', qty: 1, rate: 70000 }] },
    { id: 'si', kind: 'sales_invoice', ...at(2), customer: 'duka', lines: [{ item: 'A', qty: 1, rate: 100000 }], tax: { rate: 18, inclusive: false }, updateStock: true, warehouse: 'S' },
  ]));
  assert.deepEqual(L(r, 'si'), { receivable: [118000, 0], vat: [0, 18000], income: [0, 100000], stock: [0, 70000], cost_of_goods_sold: [70000, 0] });
  assert.equal(r.balances[0].qty, 0);
});

test('R3: till sale paid in cash, VAT-inclusive 5,900', () => {
  const r = runScenario(base([{ id: 'si', kind: 'sales_invoice', ...at(1), customer: 'walkin', lines: [{ item: 'A', qty: 1, rate: 5900 }], tax: { rate: 18, inclusive: true }, payments: [{ account: 'cash', amount: 5900 }] }]));
  assert.deepEqual(L(r, 'si'), { receivable: [5900, 5900], vat: [0, 900], income: [0, 5000], cash: [5900, 0] });
  assert.deepEqual([inv(r, 'si').outstanding, inv(r, 'si').status], [0, 'Paid']);
});

test('R4: split payment with change and the inclusive cent', () => {
  const r = runScenario(base([{ id: 'si', kind: 'sales_invoice', ...at(1), customer: 'walkin', tax: { rate: 18, inclusive: true },
    lines: [{ item: 'A', qty: 1, rate: 1000 }, { item: 'B', qty: 1, rate: 2500 }, { item: 'C', qty: 1, rate: 750 }],
    payments: [{ account: 'cash', amount: 2000 }, { account: 'mobile_money', amount: 2500 }] }]));
  assert.deepEqual(L(r, 'si'), { receivable: [4500, 4500], vat: [0, 648.3], income: [0, 3601.69], cash: [2000, 250], mobile_money: [2500, 0], round_off: [0, 0.01] });
  assert.equal(inv(r, 'si').outstanding, 0);
});

test('R9 + R12: part payment, then cancelling the invoice frees the payment as credit', () => {
  const steps: Step[] = [
    { id: 'si', kind: 'sales_invoice', ...at(1), dueDate: '2099-01-01', customer: 'duka', lines: [{ item: 'A', qty: 1, rate: 291500 }] },
    { id: 'pe', kind: 'payment', ...at(2), direction: 'in', party: 'duka', account: 'mobile_money', amount: 100000, allocate: [{ invoice: 'si', amount: 100000 }] },
  ];
  const r = runScenario(base(steps));
  assert.deepEqual([inv(r, 'si').outstanding, inv(r, 'si').status], [191500, 'Partly Paid']);
  assert.deepEqual(L(r, 'pe'), { mobile_money: [100000, 0], receivable: [0, 100000] });
  const c = runScenario(base([...steps, { id: 'x', kind: 'cancel', ...at(3), target: 'si' }]));
  assert.deepEqual([inv(c, 'si').status, inv(c, 'si').outstanding], ['Cancelled', 191500], 'keeps what was owed when cancelled (referee M11)');
  assert.deepEqual(c.parties, [{ party: 'duka', balance: -100000 }], 'the payment is now credit');
  assert.equal(L(c, 'si').receivable, undefined, 'a cancelled invoice posts nothing');
});

test('R10: a payment with no invoice stays as credit; a later one settles an invoice', () => {
  const r = runScenario(base([
    { id: 'si', kind: 'sales_invoice', ...at(1), dueDate: '2099-01-01', customer: 'duka', lines: [{ item: 'A', qty: 1, rate: 118000 }] },
    { id: 'adv', kind: 'payment', ...at(2), direction: 'in', party: 'duka', account: 'cash', amount: 50000 },
    { id: 'pe', kind: 'payment', ...at(3), direction: 'in', party: 'duka', account: 'bank', amount: 50000, allocate: [{ invoice: 'si', amount: 50000 }] },
  ]));
  assert.equal(inv(r, 'si').outstanding, 68000);
  assert.deepEqual(r.parties, [{ party: 'duka', balance: 18000 }]);
});

test('R11: a full credit note mirrors the sale and is the customer\'s credit', () => {
  const r = runScenario(base([
    { id: 'si', kind: 'sales_invoice', ...at(1), dueDate: '2099-01-01', customer: 'duka', lines: [{ item: 'A', qty: 1, rate: 100000 }], tax: { rate: 18, inclusive: false } },
    { id: 'cn', kind: 'credit_note', ...at(2), against: 'si' },
  ]));
  assert.deepEqual(L(r, 'cn'), { receivable: [0, 118000], income: [100000, 0], vat: [18000, 0] });
  assert.deepEqual([inv(r, 'cn').outstanding, inv(r, 'cn').status, inv(r, 'cn').roundedTotal], [-118000, 'Return', -118000]);
  assert.deepEqual(r.parties, [{ party: 'duka', balance: 0 }]);
});

test('R13: goods arrived, billed from the receipt, then paid', () => {
  const r = runScenario(base([
    { id: 'pr', kind: 'purchase_receipt', ...at(1), warehouse: 'S', lines: [{ item: 'A', qty: 10, rate: 5000 }] },
    { id: 'pi', kind: 'purchase_invoice', ...at(2), dueDate: '2099-01-01', supplier: 'sup', receipt: 'pr', lines: [{ item: 'A', qty: 10, rate: 5000 }] },
    { id: 'pay', kind: 'payment', ...at(3), direction: 'out', party: 'sup', account: 'bank', amount: 50000, allocate: [{ invoice: 'pi', amount: 50000 }] },
  ]));
  assert.deepEqual(L(r, 'pi'), { payable: [0, 50000], stock_received_not_billed: [50000, 0] });
  assert.deepEqual(L(r, 'pay'), { payable: [50000, 0], bank: [0, 50000] });
  assert.deepEqual([inv(r, 'pi').outstanding, inv(r, 'pi').status], [0, 'Paid']);
});

test('R14: an expense bill with input VAT', () => {
  const r = runScenario(base([{ id: 'pi', kind: 'purchase_invoice', ...at(1), dueDate: '2099-01-01', supplier: 'sup', lines: [{ item: 'B', qty: 1, rate: 100000 }], tax: { rate: 18, inclusive: false } }]));
  assert.deepEqual(L(r, 'pi'), { payable: [0, 118000], expense: [100000, 0], vat: [18000, 0] });
});

test('R15 + R20: journals must balance; moving cash to the bank', () => {
  const r = runScenario(base([
    { id: 'j1', kind: 'journal', ...at(1), rows: [{ role: 'expense', debit: 300000 }, { role: 'cash', credit: 300000 }] },
    { id: 'j2', kind: 'journal', ...at(1), rows: [{ role: 'expense', debit: 300001 }, { role: 'cash', credit: 300000 }] },
    { id: 't', kind: 'money_transfer', ...at(2), from: 'cash', to: 'bank', amount: 1000000 },
  ]));
  assert.deepEqual(L(r, 'j1'), { expense: [300000, 0], cash: [0, 300000] });
  assert.match(r.errors.find((e) => e.step === 'j2')!.message, /Total Debit must be equal to Total Credit/);
  assert.deepEqual(L(r, 't'), { bank: [1000000, 0], cash: [0, 1000000] });
});

test('refusals: oversell, over-allocation, unknown party', () => {
  const r = runScenario(base([
    { id: 'si', kind: 'sales_invoice', ...at(1), customer: 'duka', lines: [{ item: 'A', qty: 5, rate: 100 }], updateStock: true, warehouse: 'S' },
    { id: 'si2', kind: 'sales_invoice', ...at(1), customer: 'duka', lines: [{ item: 'A', qty: 1, rate: 100 }] },
    { id: 'pe', kind: 'payment', ...at(2), direction: 'in', party: 'duka', account: 'cash', amount: 500, allocate: [{ invoice: 'si2', amount: 500 }] },
    { id: 'x', kind: 'sales_invoice', ...at(2), customer: 'nobody', lines: [{ item: 'A', qty: 1, rate: 1 }] },
  ]));
  assert.deepEqual(r.errors.map((e) => e.step), ['si', 'pe', 'x']);
  assert.equal(r.invoices!.length, 1, 'only the accepted invoice exists');
});
