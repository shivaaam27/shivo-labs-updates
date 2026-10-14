// Phase 4d and the smaller phase 4 items through the API: routes (a new customer gets the default route; pricing rules
// for a route), the salesman on documents, picking an order and delivering the pick list, goods back on a delivery,
// holding stock firmly for an order, and delivery trips (driver and vehicle papers, stops marked visited, undo rules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('routes, salesmen, pick lists, delivery returns, firm holds, delivery trips', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.doc.id as string; };
    const company = async (more: object) => { const c = (await k.get('doc/company')).body.doc; assert.equal((await k.post('doc/company', { doc: { ...c, ...more } })).status, 200); };
    const run = async () => (await k.post('run')).body;
    const main = await idOf(k, 'store', 'Main Store');
    const flour = await doc('product', { code: 'FLOUR', name: 'Flour 2kg', vat_category: 'Exempt' });
    await add({ kind: 'purchase_receipt', warehouse: main, date: '2026-10-01', lines: [{ item: flour, qty: 100, rate: 2000 }] });

    // routes: the company default for new customers; a pricing rule for a route and the routes inside it
    const dar = await doc('route', { name: 'Dar es Salaam' });
    const kko = await doc('route', { name: 'Kariakoo', parent: dar });
    await company({ default_route: dar });
    const ali = await doc('salesman', { name: 'Ali' });
    const shop = await doc('customer', { name: 'Duka la Ali', route: kko, salesman: ali });
    const other = await doc('customer', { name: 'Walk-in' });
    assert.equal((await k.get('doc/customer/' + other)).body.doc.route, dar, 'a new customer gets the default route');
    await doc('price_rule', { name: 'Dar 5%', applies_to: 'Product', product: flour, for: 'Route', route: dar, action: 'Discount %', value: 5 });
    assert.equal((await k.get('price', { item: flour, party: shop, side: 'sell', qty: '1' })).body.rule.value, 5, 'Kariakoo is inside Dar es Salaam');

    // an order: the salesman comes from the customer; picking 30 of 40, delivering 20 of the pick list
    const o = await add({ kind: 'sales_order', customer: shop, warehouse: main, date: '2026-10-02', lines: [{ item: flour, qty: 40, rate: 3000 }] });
    assert.equal(o.step.salesman, ali);
    const p = await add({ kind: 'pick_list', customer: shop, warehouse: main, lines: [{ item: flour, qty: 30, rate: 3000, from: { step: o.step.id, line: 0 } }] });
    assert.match((await add({ kind: 'pick_list', customer: shop, warehouse: main, lines: [{ item: flour, qty: 15, rate: 3000, from: { step: o.step.id, line: 0 } }] }, 422)).error, /Total picked 45 is more than the 40 ordered/);
    const d = await add({ kind: 'delivery_note', customer: shop, warehouse: main, pick_list: p.step.id, lines: [{ item: flour, qty: 20, rate: 3000, from: { step: o.step.id, line: 0 } }] });
    let r = await run();
    const docOf = (id: string) => r.documents.find((x: any) => x.step === id);
    assert.deepEqual([docOf(o.step.id).perPicked, docOf(p.step.id).status], [75, 'Partly Delivered']);

    // goods back on the delivery (not invoiced): 5 come back, the order holds them again
    await add({ kind: 'delivery_note', customer: shop, warehouse: main, return_against: d.step.id, lines: [{ item: flour, qty: 5, rate: 3000, from: { step: d.step.id, line: 0 } }] });
    assert.match((await add({ kind: 'delivery_note', customer: shop, warehouse: main, return_against: d.step.id, lines: [{ item: flour, qty: 16, rate: 3000, from: { step: d.step.id, line: 0 } }] }, 422)).error, /only 15 left to return/);
    r = await run();
    assert.equal(docOf(d.step.id).perReturned, 25);
    assert.equal(r.reserved.find((x: any) => x.item === flour).qty, 25, '40 ordered, 15 kept');

    // holding stock firmly: 85 in stock; an order holding 50 leaves 35 free for anything else
    await company({ stock_reservation: true });
    const h = await add({ kind: 'sales_order', customer: other, warehouse: main, reserve_stock: true, lines: [{ item: flour, qty: 50, rate: 3000 }] });
    assert.match((await add({ kind: 'sales_invoice', customer: other, warehouse: main, lines: [{ item: flour, qty: 40, rate: 3000 }] }, 422)).error, /only 35 free in Main Store; 50 is held/);
    await add({ kind: 'delivery_note', customer: other, warehouse: main, lines: [{ item: flour, qty: 50, rate: 3000, from: { step: h.step.id, line: 0 } }] });
    assert.match((await add({ kind: 'pick_list', customer: other, warehouse: main, lines: [{ item: flour, qty: 1, rate: 3000, from: { step: h.step.id, line: 0 } }] }, 422)).error, /holds its goods firmly|would be picked|more than/);

    // delivery trips: driver and vehicle papers; two stops; marked visited in turn; undo rules
    const drv = await doc('driver', { name: 'Juma', licence_expiry: '2026-10-05' });
    const van = await doc('vehicle', { plate: 'T 123 ABC', driver: drv });
    assert.match((await add({ kind: 'delivery_trip', driver: drv, vehicle: van, date: '2026-10-10', stops: [{ delivery_note: d.step.id }] }, 422)).error, /licence expired/);
    await doc('driver', { ...(await k.get('doc/driver/' + drv)).body.doc, licence_expiry: '2027-12-31' });
    const d2 = await add({ kind: 'delivery_note', customer: shop, warehouse: main, driver: drv, vehicle: van, lr_no: 'WB-77', lines: [{ item: flour, qty: 5, rate: 3000, from: { step: o.step.id, line: 0 } }] });
    assert.deepEqual([d2.step.driver, d2.step.lrNo], [drv, 'WB-77']);
    const t = await add({ kind: 'delivery_trip', driver: drv, vehicle: van, date: '2026-10-10', time: '07:30:00', stops: [{ delivery_note: d.step.id }, { delivery_note: d2.step.id, note: 'Back gate' }] });
    assert.match((await add({ kind: 'delivery_trip', driver: drv, vehicle: van, stops: [{ delivery_note: d.step.id }] }, 422)).error, /already on trip/);
    assert.match((await k.post('steps/undo', { id: d2.step.id })).body.error, /on trip/);
    const v1 = await add({ kind: 'trip_visit', trip: t.step.id, stop: 0 });
    assert.match((await k.post('steps/undo', { id: t.step.id })).body.error, /marked visited/);
    assert.equal((await k.post('steps/undo', { id: v1.step.id })).status, 200);
    assert.equal((await k.post('steps/undo', { id: t.step.id })).status, 200);
    assert.equal((await k.post('steps/undo', { id: d2.step.id })).status, 200, 'off the trip, the delivery can be undone');
  } finally { k.done(); }
});
