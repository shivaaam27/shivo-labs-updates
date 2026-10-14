// Printing buying documents through the API (phase 5): stock requests, supplier quotations, purchase orders, goods
// arrived (with or without prices, refused units, goods sent back), supplier bills, debit notes and advances to
// suppliers keep their heading, letter head and buying terms (the company's default buying terms filled in), print in
// the supplier's language with the supplier's address and contact person, the store the goods go to, the same items
// grouped, the amount in words and the total quantity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('buying documents print with buying terms, the supplier, the store and the engine’s totals', async () => {
  const k = await readyKit();
  try {
    const ok = async (r: Promise<{ status: number; body: any }>, status = 200) => { const x = await r; assert.equal(x.status, status, JSON.stringify(x.body)); return x.body; };
    const add = async (step: object, status = 200) => (await ok(k.post('steps', { step }), status));
    const doc = async (type: string, d: object) => (await ok(k.post('doc/' + type, { doc: d }))).doc.id as string;
    const print = (id: string) => ok(k.get('print/' + id));
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    await ok(k.post('doc/store', { doc: { ...(await ok(k.get('doc/store/' + main))).doc, address: 'Plot 12, Nyerere Road' } }));
    const refused = await doc('store', { name: 'Refused goods', rejected: true });
    const lh = await doc('letter_head', { name: 'Main', header: 'Wholesale of rice and sugar' });
    const lpo = await doc('print_heading', { name: 'Local purchase order' });
    const supply = await doc('terms', { name: 'Supply terms', text: 'Deliver to our store by noon.', selling: false, buying: true });
    const wholesale = await doc('terms', { name: 'Wholesale', text: 'Pay within 30 days.' });
    const co = (await ok(k.get('doc/company'))).doc;
    await ok(k.post('doc/company', { doc: { ...co, buying_terms: supply, selling_terms: wholesale } }));
    const mill = await doc('supplier', { name: 'Mill Ltd', language: 'Swahili', address: 'Industrial Area, Morogoro', tin: '222333444',
      contacts: [{ name: 'Ali', role: 'Sales', phone: '0713 000 222' }] });
    const truck = await doc('supplier', { name: 'Fast Trucks' });
    const rice = await doc('product', { code: 'RICE', name: 'Rice 25kg', vat_category: 'Exempt', suppliers: [{ supplier: mill, code: 'MR-25' }] });
    const halves = await doc('payment_terms', { name: 'Half now', rows: [{ portion: 50, days: 0 }, { portion: 50, days: 30 }] });

    // a stock request: quantities only, the company's buying terms, no language or contact
    const mr = (await add({ kind: 'material_request', purpose: 'purchase', warehouse: main, required_by: '2099-01-10', lines: [{ item: rice, qty: 100 }] })).step;
    assert.deepEqual([mr.terms, mr.termsText, mr.language], [supply, 'Deliver to our store by noon.', undefined]);
    const pm = await print(mr.id);
    assert.deepEqual([pm.kind, pm.withoutAmount, pm.purpose, pm.requiredBy, pm.party, pm.store.address, pm.totalQty], ['material_request', true, 'purchase', '2099-01-10', null, 'Plot 12, Nyerere Road', 100]);

    // a supplier quotation in the supplier's language, for their contact person, the same product grouped
    const sq = (await add({ kind: 'supplier_quotation', supplier: mill, valid_till: '2099-12-31', contact: 'Ali', group_same_items: true,
      lines: [{ item: rice, qty: 60, rate: 50000, from: { step: mr.id, line: 0 } }, { item: rice, qty: 40, rate: 50000, from: { step: mr.id, line: 0 } }] })).step;
    const ps = await print(sq.id);
    assert.deepEqual([ps.language, ps.party.type, ps.party.name, ps.party.address, ps.party.tin, ps.contact.name, ps.terms, ps.validTill],
      ['Swahili', 'supplier', 'Mill Ltd', 'Industrial Area, Morogoro', '222-333-444', 'Ali', 'Deliver to our store by noon.', '2099-12-31']);
    assert.deepEqual(ps.lines.map((l: any) => [l.name, l.qty, l.amount, l.supplierCode]), [['Rice 25kg', 100, 5000000, 'MR-25']]);
    assert.equal(ps.words, 'Shilingi za Kitanzania milioni tano tu');

    // terms only for selling, a contact who is not theirs: refused on a buying document
    assert.match((await add({ kind: 'purchase_order', supplier: mill, warehouse: main, terms: wholesale, lines: [{ item: rice, qty: 1, rate: 50000 }] }, 422)).error, /not for buying/);
    assert.match((await add({ kind: 'purchase_order', supplier: mill, warehouse: main, contact: 'Juma', lines: [{ item: rice, qty: 1, rate: 50000 }] }, 422)).error, /supplier's contact people/);

    // the purchase order: its own heading and letter head, English for once, delivered elsewhere, paid in halves, an advance
    const po = (await add({ kind: 'purchase_order', supplier: mill, warehouse: main, required_by: '2099-01-10', print_heading: lpo, letter_head: lh, language: 'English',
      ship_to: 'Godown 3, Kurasini', payment_terms: halves, lines: [{ item: rice, qty: 100, rate: 50000, from: { step: sq.id, line: 0 } }] })).step;
    const adv = (await add({ kind: 'payment', direction: 'out', party: mill, method: cash, amount: 1000000, advance_for: [{ order: po.id, amount: 1000000 }], letter_head: lh })).step;
    const pp = await print(po.id);
    assert.deepEqual([pp.heading, pp.letterHead.header, pp.language, pp.shipTo, pp.store.name, pp.requiredBy, pp.advancePaid, pp.terms],
      ['Local purchase order', 'Wholesale of rice and sugar', 'English', 'Godown 3, Kurasini', 'Main Store', '2099-01-10', 1000000, 'Deliver to our store by noon.']);
    assert.deepEqual(pp.schedule.map((x: any) => x.amount), [2500000, 2500000]);
    assert.equal(pp.words, 'Tanzanian Shillings Five Million Only');
    assert.deepEqual(pp.from, [sq.id]);
    const pa = await print(adv.id);
    assert.deepEqual([pa.party.name, pa.payment.direction, pa.payment.advanceFor], ['Mill Ltd', 'out', [{ order: po.id, amount: 1000000 }]]);

    // goods arrived: 90 kept, 10 refused, how they came; printed without prices
    const gr = (await add({ kind: 'purchase_receipt', supplier: mill, warehouse: main, rejected_warehouse: refused, supplier_note: 'DN-881', transporter: truck, lr_no: 'WB-1',
      lr_date: '2026-10-14', vehicle: 'T 123 ABC', print_without_amount: true, lines: [{ item: rice, qty: 90, rate: 50000, rejected: 10, from: { step: po.id, line: 0 } }] })).step;
    assert.equal(gr.terms, supply);
    const pg = await print(gr.id);
    assert.deepEqual([pg.withoutAmount, pg.supplierNote, pg.rejectedStore, pg.totalQty, pg.totalRejected, pg.lines[0].rejected],
      [true, 'DN-881', 'Refused goods', 90, 10, 10]);
    assert.deepEqual(pg.transport, { driver: null, vehicle: 'T 123 ABC', transporter: 'Fast Trucks', waybill: 'WB-1', waybillDate: '2026-10-14', trip: null });

    // 5 sent back: printed like a return (no terms), in the supplier's language
    const back = (await add({ kind: 'purchase_receipt', supplier: mill, warehouse: main, return_against: gr.id, lines: [{ item: rice, qty: 5, rate: 1, from: { step: gr.id, line: 0 } }] })).step;
    assert.deepEqual([back.terms, back.language], [undefined, 'Swahili']);
    const pb = await print(back.id);
    assert.deepEqual([pb.returnOf, pb.terms, pb.totals.roundedTotal], [gr.id, null, 250000]);

    // the bill: their number, the advance set against it, a small amount written off, held until a date
    const bill = (await add({ kind: 'purchase_invoice', supplier: mill, bill_no: 'INV-9', bill_date: '2026-10-14', lines: [{ item: rice, qty: 85, rate: 50000, from: { step: gr.id, line: 0 } }],
      advances: [{ from: adv.id, amount: 1000000 }], write_off: 250, hold: true, hold_until: '2099-02-01' })).step;
    const pi = await print(bill.id);
    const run = await ok(k.post('run'));
    const owed = run.invoices.find((i: any) => i.step === bill.id).outstanding;
    assert.deepEqual([pi.billNo, pi.billDate, pi.advances, pi.writtenOff, pi.holdUntil, pi.owed, pi.terms, pi.language],
      ['INV-9', '2026-10-14', [{ from: adv.id, amount: 1000000 }], 250, '2099-02-01', owed, 'Deliver to our store by noon.', 'Swahili']);
    assert.equal(pi.totals.roundedTotal, 4250000);
    // released from its hold: no longer printed as on hold
    await add({ kind: 'set_status', target: bill.id, status: 'Open' });
    assert.equal((await print(bill.id)).holdUntil, null);

    // a debit note on the bill: the supplier, their language, the bill's price
    const dn = (await add({ kind: 'debit_note', against: bill.id, reduce_invoice: true, lines: [{ item: rice, qty: 2 }], print_heading: lpo })).step;
    const pd = await print(dn.id);
    assert.deepEqual([pd.party.name, pd.language, pd.against, pd.heading, pd.totals.roundedTotal, pd.lines[0].rate], ['Mill Ltd', 'Swahili', bill.id, 'Local purchase order', 100000, 50000]);
  } finally { k.done(); }
});
