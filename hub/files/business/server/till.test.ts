// Phase 4c through the API: a till with its store, walk-in customer, price list and payment methods; a shift opened
// with the float, sales and a refund in it, closed with a count (expected, difference, totals); what the till allows
// (full payment, its methods, fixed prices and discounts, write-off limit, who may sell); undoing shifts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('till: shifts with a cash count, till rules on sales and payments', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.doc.id as string; };
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    const mpesa = await idOf(k, 'payment_method', 'M-Pesa');
    const soda = await doc('product', { code: 'SODA', name: 'Soda 500ml', vat_category: 'Exempt' });
    await add({ kind: 'purchase_receipt', warehouse: main, date: '2026-10-01', lines: [{ item: soda, qty: 100, rate: 500 }] });
    const walk = await doc('customer', { name: 'Walk-in' });
    const shopList = await doc('price_list', { name: 'Shop', type: 'Selling' });
    await doc('item_price', { product: soda, price_list: shopList, rate: 1000 });
    const till = await doc('till', { name: 'Counter 1', store: main, customer: walk, price_list: shopList,
      methods: [{ method: cash, default: true }, { method: mpesa }], allow_rate_change: false, allow_discount_change: false, write_off_limit: 200 });
    const sale = (more: object = {}) => ({ kind: 'sales_invoice', till, customer: walk, warehouse: main, lines: [{ item: soda, qty: 3, rate: 1000 }], payments: [{ method: cash, amount: 3000 }], ...more });

    // no shift yet; the till's price comes from its own list
    assert.match((await add(sale(), 422)).error, /Open a shift at Counter 1 first/);
    assert.equal((await k.get('price', { item: soda, party: walk, side: 'sell', till })).body.price.rate, 1000);
    const open = await add({ kind: 'shift_open', till, opening: [{ method: cash, amount: 20000 }] });
    assert.match((await add({ kind: 'shift_open', till }, 422)).error, /already open at Counter 1/);

    // sales in the shift: cash with change, M-Pesa, and the till's rules
    await add(sale({ payments: [{ method: cash, amount: 5000 }] }));                       // 2,000 change
    await add(sale({ payments: [{ method: mpesa, amount: 3000 }] }));
    assert.match((await add(sale({ payments: [{ method: cash, amount: 2000 }] }), 422)).error, /takes full payment: 1,000 still to pay/);
    assert.match((await add(sale({ lines: [{ item: soda, qty: 3, rate: 900 }], payments: [{ method: cash, amount: 2700 }] }), 422)).error, /price of Soda 500ml at Counter 1 is 1,000/);
    assert.match((await add(sale({ lines: [{ item: soda, qty: 3, rate: 1000, discount: 10 }], payments: [{ method: cash, amount: 2700 }] }), 422)).error, /no discount on Soda/);
    await add(sale({ payments: [{ method: cash, amount: 2900 }], write_off: true }));      // 100 written off
    const bank = await idOf(k, 'payment_method', 'Card');
    assert.match((await add(sale({ payments: [{ method: bank, amount: 3000 }] }), 422)).error, /not taken at Counter 1/);
    assert.match((await add(sale({ warehouse: await doc('store', { name: 'Back store' }) }), 422)).error, /leave Main Store/);
    // money paid out at the till (a refund to a customer)
    await add({ kind: 'payment', till, direction: 'out', party: walk, method: cash, amount: 500 });

    // what the shift took so far
    const now = (await k.get('shifts')).body.shifts;
    assert.equal(now.length, 1);
    assert.deepEqual(now[0].expected, [{ method: cash, amount: 20000 + 3000 + 2900 - 500 }, { method: mpesa, amount: 3000 }]);

    // close with a count: 300 short in cash
    const close = await add({ kind: 'shift_close', till, counted: [{ method: cash, amount: 25100 }, { method: mpesa, amount: 3000 }] });
    assert.deepEqual(close.step.expected, [{ method: cash, amount: 25400 }, { method: mpesa, amount: 3000 }]);
    assert.deepEqual(close.step.totals, { sales: 3, grandTotal: 9000, netTotal: 9000, vat: 0, qty: 9, owed: 0, paidOut: 500 });
    assert.match((await add(sale(), 422)).error, /Open a shift/);

    // undo: an opening with sales on it cannot be undone; the close can (the shift opens again)
    assert.match((await k.post('steps/undo', { id: open.step.id })).body.error, /was made in this shift/);
    assert.equal((await k.post('steps/undo', { id: close.step.id })).status, 200);
    assert.equal((await k.get('shifts')).body.shifts.length, 1);

    // who may sell here: a cashier not on the list is refused; on the list, they need their own shift
    const ana = (await k.post('doc/user', { doc: { name: 'Ana', role: 'Cashier' } })).body.doc.id;
    const ben = (await k.post('doc/user', { doc: { name: 'Ben', role: 'Cashier' } })).body.doc.id;
    await k.post('pin', { user: ana, pin: '3001' });
    await k.post('pin', { user: ben, pin: '3002' });
    const t2 = await doc('till', { name: 'Counter 2', store: main, customer: walk, users: [{ user: ana }] });
    await k.post('session', { pin: '3002' });
    assert.match((await add({ kind: 'shift_open', till: t2 }, 422)).error, /not on the list/);
    await k.post('session', { pin: '3001' });
    await add({ kind: 'shift_open', till: t2, opening: [{ method: cash, amount: 0 }] });
    assert.match((await add(sale({ till: t2, lines: [{ item: soda, qty: 1, rate: 1000 }], payments: [] }), 422)).error, /takes full payment/);
    await add(sale({ till: t2, lines: [{ item: soda, qty: 1, rate: 1200 }], payments: [{ method: cash, amount: 1200 }] }));   // prices may change here
    // a cashier writes off small change only up to the till's limit (none set: 1,000)
    assert.match((await add(sale({ till: t2, lines: [{ item: soda, qty: 2, rate: 1000 }], payments: [{ method: cash, amount: 500 }], write_off: true }), 422)).error, /Only up to 1,000 can be written off at Counter 2/);
    // the first till's shift is the owner's: Ana may not close it
    assert.match((await add({ kind: 'shift_close', till, counted: [] }, 422)).error, /they or a manager close it/);
    // a product only a manager sells at a till; a till for some product and customer groups only; a payment's code
    await k.post('session', { pin: '1234' });
    const beer = await doc('product', { code: 'BEER', name: 'Beer 500ml', vat_category: 'Exempt', needs_manager: true });
    await add({ kind: 'purchase_receipt', warehouse: main, lines: [{ item: beer, qty: 10, rate: 1500 }] });
    await k.post('session', { pin: '3001' });
    assert.match((await add(sale({ till: t2, lines: [{ item: beer, qty: 1, rate: 2500 }], payments: [{ method: cash, amount: 2500 }] }), 422)).error, /Only a manager may sell Beer 500ml/);
    await k.post('session', { pin: '1234' });
    const drinks = await doc('product_group', { name: 'Drinks' }), cola = await doc('product_group', { name: 'Cola', parent: drinks });
    const shops = await doc('customer_group', { name: 'Shops' });
    const shop = await doc('customer', { name: 'Duka la Kona', group: shops });
    await doc('product', { ...(await k.get('doc/product/' + soda)).body.doc, group: cola });
    const t3 = await doc('till', { name: 'Drinks counter', store: main, customer: shop, product_groups: [{ group: drinks }], customer_groups: [{ group: shops }] });
    await add({ kind: 'shift_close', till, counted: [] });   // the owner's shift at Counter 1 first
    await add({ kind: 'shift_open', till: t3 });
    assert.match((await add(sale({ till: t3, customer: shop, lines: [{ item: beer, qty: 1, rate: 2500 }], payments: [{ method: cash, amount: 2500 }] }), 422)).error, /not sold at Drinks counter \(only Drinks\)/);
    assert.match((await add(sale({ till: t3, lines: [{ item: soda, qty: 1, rate: 1000 }], payments: [{ method: cash, amount: 1000 }] }), 422)).error, /sells only to customers of Shops/);
    const paid = await add(sale({ till: t3, customer: shop, lines: [{ item: soda, qty: 1, rate: 1000 }], payments: [{ method: mpesa, amount: 1000, reference: 'QK7HD81X' }] }));
    assert.equal(paid.step.payments[0].reference, 'QK7HD81X');
  } finally { k.done(); }
});
