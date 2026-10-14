// Printing through the API (phase 4e): print headings, letter heads and terms are kept on the documents, the company's
// default terms are filled in, and the printed page has the engine's own totals, VAT per rate, the amount in words,
// payments, change, what is still owed, instalments and the footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('a quotation and a sale keep their heading, letter head and terms; the printed page adds up', async () => {
  const k = await readyKit();
  try {
    const ok = async (r: Promise<{ status: number; body: any }>, status = 200) => { const x = await r; assert.equal(x.status, status, JSON.stringify(x.body)); return x.body; };
    const add = (step: object, status = 200) => ok(k.post('steps', { step }), status);
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    const proforma = await idOf(k, 'print_heading', 'Proforma invoice');   // set up with the business
    const lh = (await ok(k.post('doc/letter_head', { doc: { name: 'Main', header: 'Wholesale of rice and sugar', footer: 'NMB account 123' } }))).doc.id;
    const wholesale = (await ok(k.post('doc/terms', { doc: { name: 'Wholesale', text: 'Pay within 30 days.' } }))).doc.id;
    const buyOnly = (await ok(k.post('doc/terms', { doc: { name: 'Suppliers', text: 'Deliver by noon.', selling: false, buying: true } }))).doc.id;
    const co = (await ok(k.get('doc/company'))).doc;
    await ok(k.post('doc/company', { doc: { ...co, vrn: '40-123456-A', website: 'juma.co.tz', registration_details: 'BRELA 12345', selling_terms: wholesale, vat_table: true } }));
    const rice = (await ok(k.post('doc/product', { doc: { code: 'RICE', name: 'Rice 5kg' } }))).doc.id;
    const soap = (await ok(k.post('doc/product', { doc: { code: 'SOAP', name: 'Bath Soap', vat_category: 'Exempt' } }))).doc.id;
    const shop = (await ok(k.post('doc/customer', { doc: { name: 'Mama Neema Shop', tin: '111222333', address: 'Kariakoo, Msimbazi St', language: 'Swahili',
      contacts: [{ name: 'Neema', role: 'Buyer', phone: '0712 000 111' }] } }))).doc.id;
    await add({ kind: 'purchase_receipt', warehouse: main, lines: [{ item: rice, qty: 100, rate: 8000 }, { item: soap, qty: 100, rate: 800 }] });

    // a quotation with a heading, a letter head, the terms changed for it, a contact person and grouping
    const q = (await add({ kind: 'quotation', customer: shop, print_heading: proforma, letter_head: lh, terms: wholesale, terms_text: 'Pay within 14 days.',
      contact: 'Neema', ship_to: 'Shop 4, Mbezi', group_same_items: true, language: 'English',
      lines: [{ item: rice, qty: 2, rate: 11800 }, { item: rice, qty: 3, rate: 11800 }, { item: soap, qty: 10, rate: 1000 }] })).step;
    assert.deepEqual([q.printHeading, q.letterHead, q.terms, q.termsText, q.contact, q.shipTo, q.groupSameItems, q.language],
      [proforma, lh, wholesale, 'Pay within 14 days.', 'Neema', 'Shop 4, Mbezi', true, 'English']);
    const pq = await ok(k.get('print/' + q.id));
    assert.equal(pq.heading, 'Proforma invoice');
    assert.equal(pq.letterHead.header, 'Wholesale of rice and sugar');
    assert.equal(pq.terms, 'Pay within 14 days.');
    assert.deepEqual(pq.contact, { name: 'Neema', role: 'Buyer', phone: '+255712000111', email: null });
    assert.equal(pq.party.tin, '111-222-333');
    // the two rice lines are printed as one; 5 x 11,800 incl. VAT + 10 x 1,000 exempt = 69,000
    assert.deepEqual(pq.lines.map((l: any) => [l.name, l.qty, l.amount]), [['Rice 5kg', 5, 59000], ['Bath Soap', 10, 10000]]);
    assert.equal(pq.totalQty, 15);
    assert.deepEqual([pq.totals.netTotal, pq.totals.vat, pq.totals.roundedTotal], [60000, 9000, 69000]);
    assert.deepEqual(pq.vatTable, [{ rate: 18, net: 50000, vat: 9000 }, { rate: 0, net: 10000, vat: 0 }]);
    assert.equal(pq.words, 'Tanzanian Shillings Sixty Nine Thousand Only');
    assert.equal(pq.company.website, 'juma.co.tz');
    assert.equal(pq.company.registration_details, 'BRELA 12345');

    // terms not for selling, a contact who is not theirs, a heading that does not exist: refused
    assert.match((await add({ kind: 'quotation', customer: shop, terms: buyOnly, lines: [{ item: rice, qty: 1, rate: 11800 }] }, 422)).error, /not for selling/);
    assert.match((await add({ kind: 'quotation', customer: shop, contact: 'Juma', lines: [{ item: rice, qty: 1, rate: 11800 }] }, 422)).error, /contact people/);
    assert.match((await add({ kind: 'quotation', customer: shop, print_heading: 'nope', lines: [{ item: rice, qty: 1, rate: 11800 }] }, 422)).error, /does not exist/);

    // a sale with no terms named gets the company's; part paid, in instalments; printed in the customer's Swahili
    const terms = (await ok(k.post('doc/payment_terms', { doc: { name: 'Half now', rows: [{ portion: 50, days: 0 }, { portion: 50, days: 30 }] } }))).doc.id;
    const sale = (await add({ kind: 'sales_invoice', customer: shop, warehouse: main, payment_terms: terms, lines: [{ item: rice, qty: 10, rate: 11800 }] })).step;
    assert.deepEqual([sale.terms, sale.termsText, sale.language], [wholesale, 'Pay within 30 days.', 'Swahili']);
    await add({ kind: 'payment', direction: 'in', party: shop, method: cash, amount: 50000, allocate: [{ invoice: sale.id, amount: 50000 }], letter_head: lh, print_heading: proforma });
    const ps = await ok(k.get('print/' + sale.id));
    assert.equal(ps.language, 'Swahili');
    assert.equal(ps.words, 'Shilingi za Kitanzania laki moja, elfu kumi na nane tu');
    assert.equal(ps.owed, 68000);
    assert.deepEqual(ps.schedule.map((x: any) => x.amount), [59000, 59000]);
    assert.equal(ps.status, 'Partly Paid');

    // an empty choice prints no terms; a delivery note without amounts
    const d = (await add({ kind: 'delivery_note', customer: shop, warehouse: main, terms: '', print_without_amount: true, lines: [{ item: soap, qty: 5, rate: 1000 }] })).step;
    assert.deepEqual([d.terms, d.termsText, d.printWithoutAmount], [undefined, undefined, true]);
    assert.equal((await ok(k.get('print/' + d.id))).withoutAmount, true);

    // paid at once with cash above the total: change; the payment's own receipt
    const paid = (await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 3, rate: 1000 }], payments: [{ method: cash, amount: 5000 }] })).step;
    const pp = await ok(k.get('print/' + paid.id));
    assert.deepEqual([pp.paid, pp.change, pp.owed, pp.schedule], [5000, 2000, 0, undefined]);
    const pays = (await ok(k.get('steps'))).steps.filter((s: any) => s.kind === 'payment');
    const pr = await ok(k.get('print/' + pays[0].id));
    assert.deepEqual([pr.heading, pr.letterHead.name, pr.payment.amount, pr.payment.allocations], ['Proforma invoice', 'Main', 50000, [{ invoice: sale.id, amount: 50000 }]]);
    assert.equal(pr.words, 'Shilingi za Kitanzania elfu hamsini tu');

    // the company may hide the words; a stock movement has no printed page
    await ok(k.post('doc/company', { doc: { ...(await ok(k.get('doc/company'))).doc, hide_words: true } }));
    assert.equal((await ok(k.get('print/' + paid.id))).words, null);
    const moved = (await add({ kind: 'issue', warehouse: main, lines: [{ item: soap, qty: 1 }] })).step;
    await ok(k.get('print/' + moved.id), 422);
    await ok(k.get('print/ST-99999'), 404);
  } finally { k.done(); }
});

test('a till sale prints with the till’s letter head, heading, terms and paper', async () => {
  const k = await readyKit();
  try {
    const ok = async (r: Promise<{ status: number; body: any }>, status = 200) => { const x = await r; assert.equal(x.status, status, JSON.stringify(x.body)); return x.body; };
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    await ok(k.post('doc/store', { doc: { ...(await ok(k.get('doc/store/' + main))).doc, phone: '0754 111 222' } }));
    const lh = (await ok(k.post('doc/letter_head', { doc: { name: 'Shop', footer: 'Karibu tena', is_default: true } }))).doc.id;
    const cashSale = await idOf(k, 'print_heading', 'Cash sale');
    const noReturn = (await ok(k.post('doc/terms', { doc: { name: 'Shop', text: 'Goods once sold are not returnable.' } }))).doc.id;
    const walkIn = (await ok(k.post('doc/customer', { doc: { name: 'Walk-in', type: 'Walk-in' } }))).doc.id;
    const till = (await ok(k.post('doc/till', { doc: { name: 'Counter 1', store: main, customer: walkIn, needs_shift: false, paper: '58 mm', print_heading: cashSale, terms: noReturn, print_receipt: true } }))).doc.id;
    const sugar = (await ok(k.post('doc/product', { doc: { code: 'SUG', name: 'Sugar 1kg' } }))).doc.id;
    await ok(k.post('steps', { step: { kind: 'purchase_receipt', warehouse: main, lines: [{ item: sugar, qty: 10, rate: 2500 }] } }));
    const s = (await ok(k.post('steps', { step: { kind: 'sales_invoice', till, customer: walkIn, warehouse: main, lines: [{ item: sugar, qty: 2, rate: 3000 }], payments: [{ method: cash, amount: 10000 }] } }))).step;
    assert.equal(s.terms, noReturn);
    const p = await ok(k.get('print/' + s.id));
    assert.deepEqual([p.till.paper, p.heading, p.letterHead.footer, p.terms, p.store.phone, p.change, p.by], ['58 mm', 'Cash sale', 'Karibu tena', 'Goods once sold are not returnable.', '+255754111222', 4000, 'Juma']);
  } finally { k.done(); }
});
