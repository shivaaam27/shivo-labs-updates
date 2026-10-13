// Phase 4b through the API: payment terms in parts, pricing rules (product before group, priority, ties refused),
// prices for one customer, discount limits (product maximum, manager above the company's %), a journal row that
// settles a named invoice, and matching credit to invoices later (and undoing it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('terms, pricing rules, customer prices, discount limits, journals on invoices, matching credit', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.doc.id as string; };
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    const grp = await doc('product_group', { name: 'Soaps' });
    const soap = await doc('product', { code: 'SOAP', name: 'Bath Soap', group: grp, vat_category: 'Exempt', max_discount: 20 });
    const cgroup = await doc('customer_group', { name: 'Wholesale shops' });
    const terms = await doc('payment_terms', { name: 'Half now, half in 30', rows: [{ portion: 50, basis: 'Days after the invoice date', days: 0 }, { portion: 50, basis: 'Days after the invoice date', days: 30 }] });
    const shop = await doc('customer', { name: 'Mama Neema Shop', group: cgroup, payment_terms: terms });
    await add({ kind: 'purchase_receipt', warehouse: main, date: '2026-09-30', lines: [{ item: soap, qty: 500, rate: 800 }] });

    // payment terms: two instalments, due on the last one; a sale paid at the till has none
    const s1 = await add({ kind: 'sales_invoice', customer: shop, warehouse: main, date: '2026-10-01', lines: [{ item: soap, qty: 10, rate: 1000 }] });
    assert.deepEqual(s1.step.schedule, [{ dueDate: '2026-10-01', portion: 50 }, { dueDate: '2026-10-31', portion: 50 }]);
    const till = await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1000 }], payments: [{ method: cash, amount: 1000 }] });
    assert.equal(till.step.schedule, undefined);

    // pricing rules: the group gives 5 % from 10 pieces; the product's own rule (from 50, 10 %) wins when it fits
    await doc('price_rule', { name: 'Shops 5% from 10', applies_to: 'Product group', product_group: grp, for: 'Customer group', customer_group: cgroup, min_qty: 10, action: 'Discount %', value: 5 });
    const price = async (qty: number) => (await k.get('price', { item: soap, party: shop, side: 'sell', qty: String(qty) })).body;
    assert.equal((await price(5)).rule, null);
    assert.deepEqual([(await price(12)).rule.action, (await price(12)).rule.value], ['Discount %', 5]);
    await doc('price_rule', { name: 'Soap 10% from 50', applies_to: 'Product', product: soap, for: 'Any customer', min_qty: 50, action: 'Discount %', value: 10 });
    assert.equal((await price(60)).rule.value, 10, 'the product level comes before the group level');
    await doc('price_rule', { name: 'Soap 8% from 50', applies_to: 'Product', product: soap, for: 'Any customer', min_qty: 50, action: 'Discount %', value: 8 });
    assert.match((await price(60)).rule.error, /More than one pricing rule fits/);

    // a price for one customer comes before the list price
    const retail = (await k.get('doc/company')).body.doc.selling_price_list;
    await doc('item_price', { product: soap, price_list: retail, rate: 1200 });
    await doc('item_price', { product: soap, price_list: retail, customer: shop, rate: 1100 });
    const other = await doc('customer', { name: 'Walk-in' });
    assert.equal((await price(1)).price.rate, 1100);
    assert.equal((await k.get('price', { item: soap, party: other, side: 'sell' })).body.price.rate, 1200);

    // discount limits: the product's maximum (20 %) for everyone; above the company's 10 % a cashier needs a manager
    assert.match((await add({ kind: 'sales_invoice', customer: other, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1000, discount: 25 }] }, 422)).error, /most discount on Bath Soap is 20 %/);
    const company = (await k.get('doc/company')).body.doc;
    assert.equal((await k.post('doc/company', { doc: { ...company, discount_needs_manager: 10 } })).status, 200);
    const u = (await k.post('doc/user', { doc: { name: 'Cashier', role: 'Cashier' } })).body.doc.id;
    assert.equal((await k.post('pin', { user: u, pin: '2001' })).status, 200);
    await k.post('session', { pin: '2001' });
    assert.match((await add({ kind: 'sales_invoice', customer: other, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1000, discount: 15 }], payments: [{ method: cash, amount: 850 }] }, 422)).error, /above 10 % needs a manager/);
    assert.match((await add({ kind: 'sales_invoice', customer: other, warehouse: main, discount_amount: 300, lines: [{ item: soap, qty: 1, rate: 1000 }], payments: [{ method: cash, amount: 700 }] }, 422)).error, /needs a manager/);
    await add({ kind: 'sales_invoice', customer: other, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1000, discount: 10 }], payments: [{ method: cash, amount: 900 }] });
    await k.post('session', { pin: '1234' });

    // a journal row settles a named invoice (a bad debt written off); matching a payment's credit later, then undoing it
    const s2 = await add({ kind: 'sales_invoice', customer: other, warehouse: main, lines: [{ item: soap, qty: 2, rate: 1000 }] });
    const recv = await idOf(k, 'account', 'Debtors'), woff = await idOf(k, 'account', 'Write Off');
    await add({ kind: 'journal', rows: [{ account: woff, debit: 500 }, { account: recv, credit: 500, party: other, invoice: s2.step.id }] });
    const pay = await add({ kind: 'payment', direction: 'in', party: other, method: cash, amount: 1500 });
    const m = await add({ kind: 'reconcile', party: other, allocations: [{ from: pay.step.id, invoice: s2.step.id, amount: 1500 }] });
    let run = (await k.post('run')).body;
    assert.equal(run.invoices.find((i: any) => i.step === s2.step.id).outstanding, 0);
    await add({ kind: 'reconcile', party: other, allocations: [{ from: pay.step.id, invoice: s2.step.id, amount: 1 }] }, 422);
    assert.equal((await k.post('steps/undo', { id: m.step.id })).status, 200);
    run = (await k.post('run')).body;
    assert.equal(run.invoices.find((i: any) => i.step === s2.step.id).outstanding, 1500);
  } finally { k.done(); }
});
