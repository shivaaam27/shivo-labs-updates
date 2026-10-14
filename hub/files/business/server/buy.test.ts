// Phase 5a through the API: a stock request ordered from a supplier quotation, goods arrived with refused units, goods
// sent back, the bill from goods arrived with an advance paid on the order, a debit note, holds, buying rules,
// supplier prices and buying pricing rules, reorder suggestions and the supplier price comparison.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('stock request, quotation, order, goods arrived with refused units, return, bill with advance, debit note, holds, reorder', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.doc.id as string; };
    const company = async (more: object) => { const c = (await k.get('doc/company')).body.doc; assert.equal((await k.post('doc/company', { doc: { ...c, ...more } })).status, 200); };
    const run = async () => (await k.post('run')).body;
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    const bad = await doc('store', { name: 'Refused goods', rejected: true });
    const mill = await doc('supplier', { name: 'Mill Ltd' });
    const rice = await doc('product', { code: 'RICE', name: 'Rice 25kg', vat_category: 'Exempt', default_supplier: mill, min_order_qty: 10, lead_time_days: 7,
      reorder: [{ store: main, level: 50, qty: 100 }], suppliers: [{ supplier: mill, code: 'MR-25' }] });

    // reorder suggestions: nothing in stock, level 50 -> order 100 from the usual supplier, needed in 7 days
    let sug = (await k.get('reorder')).body.suggestions;
    assert.deepEqual([sug.length, sug[0].qty, sug[0].supplier, sug[0].type], [1, 100, mill, 'Purchase']);

    // a stock request (counts as asked for: no suggestion any more), quoted by the supplier, ordered from the quotation
    const mr = await add({ kind: 'material_request', purpose: 'purchase', warehouse: main, lines: [{ item: rice, qty: 100 }] });
    assert.equal((await k.get('reorder')).body.suggestions.length, 0, 'what is asked for counts');
    const sq = await add({ kind: 'supplier_quotation', supplier: mill, valid_till: '2099-12-31', lines: [{ item: rice, qty: 100, rate: 50000, from: { step: mr.step.id, line: 0 } }] });
    assert.equal((await k.get('compare/' + rice)).body.suppliers[0].quoted, 50000);
    assert.match((await add({ kind: 'purchase_order', supplier: mill, warehouse: main, lines: [{ item: rice, qty: 5, rate: 50000 }] }, 422)).error, /at least 10/);
    const po = await add({ kind: 'purchase_order', supplier: mill, warehouse: main, lines: [{ item: rice, qty: 100, rate: 50000, from: { step: sq.step.id, line: 0 } }] });
    let r = await run();
    const docOf = (id: string) => r.documents.find((x: any) => x.step === id);
    assert.equal(docOf(mr.step.id).status, 'Ordered');
    assert.equal(r.ordered.find((x: any) => x.item === rice).qty, 100);

    // an advance on the order; 90 arrive accepted and 10 refused into the refused-goods store; 5 go back
    const adv = await add({ kind: 'payment', direction: 'out', party: mill, method: cash, amount: 1000000, advance_for: [{ order: po.step.id, amount: 1000000 }] });
    const gr = await add({ kind: 'purchase_receipt', supplier: mill, warehouse: main, rejected_warehouse: bad, supplier_note: 'DN-881', lr_no: 'WB-1',
      lines: [{ item: rice, qty: 90, rate: 50000, rejected: 10, from: { step: po.step.id, line: 0 } }] });
    assert.equal(gr.step.supplierNote, 'DN-881');
    const back = await add({ kind: 'purchase_receipt', supplier: mill, warehouse: main, return_against: gr.step.id, lines: [{ item: rice, qty: 5, rate: 1, from: { step: gr.step.id, line: 0 } }] });
    assert.equal(back.step.lines[0].rate, 50000, 'goes back at the rate it came in');
    r = await run();
    assert.deepEqual([docOf(po.step.id).perReceived, docOf(po.step.id).advancePaid], [95, 1000000]);
    assert.equal(r.balances.find((b: any) => b.warehouse === bad).value, 0, 'refused goods carry no value');

    // the bill for the 85 kept, the advance set against it; then 2 more go back on a debit note
    const bill = await add({ kind: 'purchase_invoice', supplier: mill, bill_no: 'INV-9', lines: [{ item: rice, qty: 85, rate: 50000, from: { step: gr.step.id, line: 0 } }],
      advances: [{ from: adv.step.id, amount: 1000000 }] });
    r = await run();
    assert.equal(r.invoices.find((i: any) => i.step === bill.step.id).outstanding, 85 * 50000 - 1000000);
    assert.equal(docOf(gr.step.id).status, 'Completed');
    const dn = await add({ kind: 'debit_note', against: bill.step.id, reduce_invoice: true, lines: [{ item: rice, qty: 2 }] });
    r = await run();
    assert.equal(r.invoices.find((i: any) => i.step === bill.step.id).outstanding, 83 * 50000 - 1000000);
    assert.match((await k.post('steps/undo', { id: bill.step.id })).body.error, /first/, 'the debit note is undone first');
    assert.equal((await k.post('steps/undo', { id: dn.step.id })).status, 200);

    // the order is closed: nothing more on order, no more goods on it
    await add({ kind: 'set_status', target: po.step.id, status: 'Closed' });
    assert.equal((await run()).ordered.find((x: any) => x.item === rice)?.qty ?? 0, 0);
    assert.match((await add({ kind: 'purchase_receipt', supplier: mill, warehouse: main, lines: [{ item: rice, qty: 1, rate: 50000, from: { step: po.step.id, line: 0 } }] }, 422)).error, /closed/);

    // holds: a bill on hold cannot be paid; a supplier on hold for payments cannot be paid at all
    const fee = await doc('product', { code: 'FEE', name: 'Transport', is_stock: false, vat_category: 'Exempt' });
    const held = await add({ kind: 'purchase_invoice', supplier: mill, lines: [{ item: fee, qty: 1, rate: 20000 }], hold: true, hold_until: '2099-01-01' });
    assert.match((await add({ kind: 'payment', direction: 'out', party: mill, method: cash, amount: 20000, allocate: [{ invoice: held.step.id, amount: 20000 }] }, 422)).error, /on hold/);
    await add({ kind: 'set_status', target: held.step.id, status: 'Open' });   // released
    await add({ kind: 'payment', direction: 'out', party: mill, method: cash, amount: 20000, allocate: [{ invoice: held.step.id, amount: 20000 }] });
    // refused goods only into a store marked for them; never picked for a customer
    const plain = await doc('store', { name: 'Back room' });
    assert.match((await add({ kind: 'purchase_receipt', supplier: mill, warehouse: main, rejected_warehouse: plain, lines: [{ item: rice, qty: 1, rate: 50000, rejected: 1 }] }, 422)).error, /not marked/);
    const s = (await k.get('doc/supplier/' + mill)).body.doc;
    await doc('supplier', { ...s, on_hold: true, hold_type: 'Payments' });
    assert.match((await add({ kind: 'payment', direction: 'out', party: mill, method: cash, amount: 100 }, 422)).error, /on hold/);
    await doc('supplier', { ...(await k.get('doc/supplier/' + mill)).body.doc, on_hold: false });

    // buying rules: an order needed for goods arrived; the supplier's own price, a supplier quantity discount
    await company({ po_required: true });
    assert.match((await add({ kind: 'purchase_receipt', supplier: mill, warehouse: main, lines: [{ item: rice, qty: 1, rate: 50000 }] }, 422)).error, /purchase order is needed/);
    await company({ po_required: false });
    const list = (await k.get('doc/company')).body.doc.buying_price_list;
    await doc('item_price', { product: rice, price_list: list, rate: 52000 });
    await doc('item_price', { product: rice, price_list: list, supplier: mill, rate: 49000, lead_time_days: 5 });
    assert.equal((await k.get('price', { item: rice, party: mill, side: 'buy' })).body.price.rate, 49000);
    await doc('price_rule', { name: 'Mill 2%', applies_to: 'Product', product: rice, for: 'Supplier', supplier: mill, min_qty: 50, action: 'Discount %', value: 2 });
    assert.equal((await k.get('price', { item: rice, party: mill, side: 'buy', qty: '60' })).body.rule.value, 2);
    assert.equal((await k.get('price', { item: rice, party: mill, side: 'sell', qty: '60' })).body.rule, null, 'a supplier rule never applies to a sale');
    assert.equal((await k.get('compare/' + rice)).body.suppliers[0].leadDays, 5);
  } finally { k.done(); }
});
