// The order chain through the API (phase 4a): quotation → order → delivery note → invoice, with statuses, what is
// still to deliver and bill, stock held for open orders, close and hold, and who may do what.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('quotation, order, deliveries and invoices', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const main = await idOf(k, 'store', 'Main Store');
    const soap = (await k.post('doc/product', { doc: { code: 'SOAP', name: 'Bath Soap', vat_category: 'Exempt' } })).body.doc.id;
    const shop = (await k.post('doc/customer', { doc: { name: 'Mama Neema Shop' } })).body.doc.id;
    await add({ kind: 'purchase_receipt', warehouse: main, lines: [{ item: soap, qty: 100, rate: 800 }] });

    const q = (await add({ kind: 'quotation', customer: shop, valid_till: '2099-12-31', lines: [{ item: soap, qty: 20, rate: 1000 }] })).step.id;
    const o = (await add({ kind: 'sales_order', customer: shop, warehouse: main, delivery_date: '2026-10-20', lines: [{ item: soap, qty: 20, rate: 1000, from: { step: q, line: 0 } }] })).step.id;
    const d = (await add({ kind: 'delivery_note', customer: shop, warehouse: main, lines: [{ item: soap, qty: 12, rate: 1000, from: { step: o, line: 0 } }] })).step.id;
    // an invoice made from a delivery note never moves the goods again, whatever the screen sends
    const inv = await add({ kind: 'sales_invoice', customer: shop, warehouse: main, update_stock: true, lines: [{ item: soap, qty: 12, rate: 1000, from: { step: d, line: 0 } }] });
    assert.equal(inv.step.updateStock, undefined);
    // a line linked to the wrong kind of document is refused
    assert.match((await add({ kind: 'delivery_note', customer: shop, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1000, from: { step: q, line: 0 } }] }, 422)).error, /cannot be the source/);

    const run = (await k.post('run')).body;
    const doc = (id: string) => run.documents.find((x: any) => x.step === id);
    assert.equal(doc(q).status, 'Ordered');
    assert.deepEqual([doc(o).status, doc(o).perDelivered, doc(o).perBilled], ['To Deliver and Bill', 60, 60]);
    assert.deepEqual(doc(o).lines, [{ delivered: 12, billed: 12000 }]);
    assert.equal(doc(d).status, 'Completed');
    assert.deepEqual(run.reserved, [{ item: soap, warehouse: main, qty: 8 }]);
    assert.equal(run.balances.find((b: any) => b.item === soap).qty, 88);

    // close: nothing held any more; a delivery is refused; only a manager may close (the owner is signed in here)
    await add({ kind: 'set_status', target: o, status: 'Closed' });
    const run2 = (await k.post('run')).body;
    assert.equal(run2.documents.find((x: any) => x.step === o).status, 'Closed');
    assert.deepEqual(run2.reserved.filter((x: any) => x.qty), []);
    assert.match((await add({ kind: 'delivery_note', customer: shop, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1000, from: { step: o, line: 0 } }] }, 422)).error, /closed/);
    const steps = (await k.get('steps')).body.steps;
    assert.equal(steps.find((s: any) => s.id === o).label, 'Sales order');
  } finally { k.done(); }
});
