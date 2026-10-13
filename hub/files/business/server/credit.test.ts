// Phase 4 selling rules through the API: the company's credit limit and payment terms for everyone without their own,
// a customer checked at the invoice instead of the order, a limit that may not go below what is owed, a journal over
// the limit (a manager may allow it), no sale below cost, and keeping the price from the order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('company limit and terms, credit at the invoice, lower limit refused, journals, below cost, same price', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object, status = 200) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, status, JSON.stringify(r.body)); return status === 200 ? r.body.doc.id as string : r.body; };
    const company = async (more: object) => { const c = (await k.get('doc/company')).body.doc; assert.equal((await k.post('doc/company', { doc: { ...c, ...more } })).status, 200); };
    const main = await idOf(k, 'store', 'Main Store');
    const rice = await doc('product', { code: 'RICE', name: 'Rice 25kg', vat_category: 'Exempt' });
    const sup = await doc('supplier', { name: 'Mchele Ltd' });
    await add({ kind: 'purchase_receipt', supplier: sup, warehouse: main, date: '2026-10-01', lines: [{ item: rice, qty: 100, rate: 50000 }] });

    // the company's limit and terms apply to a customer with none of their own (and no group ones)
    const terms = await doc('payment_terms', { name: '30 days', rows: [{ portion: 100, basis: 'Days after the invoice date', days: 30 }] });
    await company({ credit_limit: 200000, payment_terms: terms });
    const duka = await doc('customer', { name: 'Duka la Juma' });
    const s1 = await add({ kind: 'sales_invoice', customer: duka, warehouse: main, date: '2026-10-02', lines: [{ item: rice, qty: 3, rate: 60000 }] });
    assert.deepEqual(s1.step.schedule, [{ dueDate: '2026-11-01', portion: 100 }]);
    assert.match((await add({ kind: 'sales_invoice', customer: duka, warehouse: main, date: '2026-10-02', lines: [{ item: rice, qty: 1, rate: 60000 }] }, 422)).error, /Credit limit crossed/);

    // checked at the invoice: a big order is taken, the invoice is checked
    const big = await doc('customer', { name: 'Big Wholesale', credit_limit: 100000, credit_at_invoice: true });
    const o1 = await add({ kind: 'sales_order', customer: big, warehouse: main, date: '2026-10-03', lines: [{ item: rice, qty: 10, rate: 60000 }] });
    assert.match((await add({ kind: 'sales_invoice', customer: big, warehouse: main, date: '2026-10-03', lines: [{ item: rice, qty: 2, rate: 60000, from: { step: o1.step.id, line: 0 } }] }, 422)).error, /Credit limit crossed/);
    await add({ kind: 'sales_invoice', customer: big, warehouse: main, date: '2026-10-03', lines: [{ item: rice, qty: 1, rate: 60000, from: { step: o1.step.id, line: 0 } }] });

    // a limit below what they owe is refused (Duka owes 180,000)
    const d = (await k.get('doc/customer/' + duka)).body.doc;
    const r = await doc('customer', { ...d, credit_limit: 150000 }, 422);
    assert.match(r.errors.credit_limit, /already owe 180,000/);
    await doc('customer', { ...d, credit_limit: 250000 });

    // a journal debiting a customer over the limit; a manager may allow it
    const recv = await idOf(k, 'account', 'Debtors'), sales = await idOf(k, 'account', 'Sales');
    const j = { kind: 'journal', rows: [{ account: recv, debit: 100000, party: duka }, { account: sales, credit: 100000 }] };
    assert.match((await add(j, 422)).error, /Credit limit crossed/);
    await add({ ...j, allow_over_limit: true });

    // no sale below cost (bought at 50,000)
    await company({ no_sale_below_cost: true });
    const walk = await doc('customer', { name: 'Walk-in', credit_limit: 10000000 });
    const cash = await idOf(k, 'payment_method', 'Cash');
    assert.match((await add({ kind: 'sales_invoice', customer: walk, warehouse: main, lines: [{ item: rice, qty: 1, rate: 49000 }], payments: [{ method: cash, amount: 49000 }] }, 422)).error, /below its last purchase rate/);
    await add({ kind: 'sales_invoice', customer: walk, warehouse: main, lines: [{ item: rice, qty: 1, rate: 52000 }], payments: [{ method: cash, amount: 52000 }] });

    // keep the price from the order: a cashier may not change it, a manager may
    await company({ keep_same_rate: true });
    const o2 = await add({ kind: 'sales_order', customer: walk, warehouse: main, date: '2026-10-04', lines: [{ item: rice, qty: 4, rate: 60000 }] });
    const u = (await k.post('doc/user', { doc: { name: 'Cashier', role: 'Cashier' } })).body.doc.id;
    assert.equal((await k.post('pin', { user: u, pin: '2001' })).status, 200);
    await k.post('session', { pin: '2001' });
    const inv = (rate: number) => ({ kind: 'sales_invoice', customer: walk, warehouse: main, lines: [{ item: rice, qty: 1, rate, from: { step: o2.step.id, line: 0 } }], payments: [{ method: cash, amount: rate }] });
    assert.match((await add(inv(58000), 422)).error, /price must stay 60,000/);
    await add(inv(60000));
    await k.post('session', { pin: '1234' });
    await add(inv(58000));
  } finally { k.done(); }
});
