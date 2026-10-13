// Money rules through the API (the gaps found by checking ERPNext, 13 Oct 2026): services next to goods, discounts,
// opening balances, credit limits (own and group's) with a manager's override, write-off at the till, bill numbers,
// payment references, returns that keep their discount or come off the invoice, journals on accounts, the price
// lookup, and who may record what.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('services, discounts, opening balances, credit limit, write-off, bill numbers, journals, prices', async () => {
  const k = await readyKit();
  try {
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    const mpesa = await idOf(k, 'payment_method', 'M-Pesa');
    const add = (step: object) => k.post('steps', { step });
    const doc = async (type: string, d: object) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.doc.id as string; };
    const soap = await doc('product', { code: 'SOAP', name: 'Bath Soap' });
    const delivery = await doc('product', { code: 'DEL', name: 'Delivery charge', is_stock: false });
    const rice = await doc('product', { code: 'RICE', name: 'Rice', stock_unit: 'Kg', vat_category: 'Exempt' });
    const group = await doc('customer_group', { name: 'Shops', credit_limit: 50000, credit_days: 14 });
    const shop = await doc('customer', { name: 'Mama Neema Shop', group });
    const sup = await doc('supplier', { name: 'Bidco Ltd' });
    assert.equal((await add({ kind: 'purchase_receipt', warehouse: main, lines: [{ item: soap, qty: 100, rate: 800 }, { item: rice, qty: 50, rate: 2000 }] })).status, 200);

    // a delivery charge (service) on a sale that moves goods: only the soap leaves the store
    const s1 = await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 2, rate: 1180 }, { item: delivery, qty: 1, rate: 2360 }] });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    // days to pay come from the group (14) when the customer has none
    assert.equal(s1.body.step.dueDate, addDays(s1.body.step.date, 14));
    // whole numbers for pieces, any amount for kilograms
    assert.match((await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 1.5, rate: 1180 }] })).body.error, /whole numbers only/);
    assert.equal((await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: rice, qty: 1.5, rate: 2500 }], payments: [{ method: cash, amount: 3750 }] })).status, 200);

    // discounts: 10 % off a line and 1,000 off the whole sale; the preview shows the same totals the books keep
    const draft = { kind: 'sales_invoice', customer: shop, warehouse: main, discount_amount: 1000, lines: [{ item: soap, qty: 10, rate: 1180, discount: 10 }], payments: [{ method: mpesa, amount: 9620 }] };
    const pv = (await k.post('preview', { step: draft })).body;
    assert.deepEqual([pv.lines[0].rate, pv.discount, pv.roundedTotal], [1062, 1000, 9620]);
    assert.equal(pv.credit.limit, 50000, 'the group limit applies');
    const s2 = await add(draft);
    assert.equal(s2.status, 200, JSON.stringify(s2.body));

    // credit limit of the group (50,000): 2 x 1,180 + 2,360 = 4,720 owed; 46,000 more on credit is refused...
    const big = { kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 40, rate: 1150 }] };
    const over = await add(big);
    assert.equal(over.status, 422);
    assert.match(over.body.error, /Credit limit crossed for Mama Neema Shop: they would owe 50,720, the limit is 50,000/);
    // ...a cashier may not allow it, the owner may
    assert.equal((await add({ ...big, allow_over_limit: true })).status, 200);
    // the customer's own limit wins over the group's
    const vip = await doc('customer', { name: 'Big Buyer', group, credit_limit: 1000000 });
    assert.equal((await add({ ...big, customer: vip })).status, 200);

    // opening balance: what the shop owed before (no VAT, no stock), then paid off
    const o1 = await add({ kind: 'sales_invoice', customer: vip, opening: true, amount: 250000, due_date: '2026-09-30' });
    assert.equal(o1.status, 200, JSON.stringify(o1.body));
    const o2 = await add({ kind: 'purchase_invoice', supplier: sup, opening: true, amount: 400000 });
    assert.equal(o2.status, 200, JSON.stringify(o2.body));

    // supplier bill: their bill number once per supplier; a payment keeps its M-Pesa code
    const bill = { kind: 'purchase_invoice', supplier: sup, bill_no: 'INV-778', bill_date: '2026-10-10', lines: [{ item: soap, qty: 1, rate: 800 }] };
    assert.equal((await add(bill)).status, 200);
    assert.match((await add(bill)).body.error, /Bill number INV-778 of this supplier is already entered/);
    const pay = await add({ kind: 'payment', direction: 'in', party: vip, method: mpesa, amount: 100000, reference: 'QK7HD81X', remarks: 'Old balance', allocate: [{ invoice: o1.body.step.id, amount: 100000 }] });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    assert.equal(pay.body.step.reference, 'QK7HD81X');

    // a return keeps the discount it was sold with, whatever the screen sends, and can come off the invoice
    const ret = await add({ kind: 'credit_note', against: s2.body.step.id, reduce_invoice: false, lines: [{ item: soap, qty: 1, rate: 99999 }] });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    assert.deepEqual([ret.body.step.lines[0].rate, ret.body.step.lines[0].discount], [1180, 10]);
    const ret2 = await add({ kind: 'credit_note', against: s1.body.step.id, reduce_invoice: true, lines: [{ item: soap, qty: 1, rate: 1180 }] });
    assert.equal(ret2.status, 200, JSON.stringify(ret2.body));

    // journal on accounts: rent paid from cash
    const rent = await idOf(k, 'account', 'Rent');
    const cashAcc = await idOf(k, 'account', 'Cash');
    const j = await add({ kind: 'journal', reference: 'Oct rent', rows: [{ account: rent, debit: 300000 }, { account: cashAcc, credit: 300000 }] });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    assert.deepEqual(j.body.step.rows.map((r: any) => r.role), ['expense', 'cash']);
    assert.match((await add({ kind: 'journal', rows: [{ account: rent, debit: 1 }, { account: cashAcc, credit: 2 }] })).body.error, /Total Debit must be equal to Total Credit/);

    const run = (await k.post('run')).body;
    const inv = (id: string) => run.invoices.find((i: any) => i.step === id);
    assert.deepEqual([inv(s2.body.step.id).roundedTotal, inv(s2.body.step.id).outstanding], [9620, 0]);
    assert.equal(inv(o1.body.step.id).outstanding, 150000);
    assert.equal(inv(s1.body.step.id).outstanding, 4720 - 1180, 'the return came off the invoice');
    // stock: 100 in, 2 + 10 + 40 + 40 out, 1 + 1 back; the delivery charge never touched the store
    assert.equal(run.balances.find((b: any) => b.item === soap).qty, 100 - 2 - 10 - 40 - 40 + 1 + 1);
    assert.ok(!run.balances.some((b: any) => b.item === delivery));
    const lab = (await k.get('steps')).body.steps;
    assert.equal(lab.find((s: any) => s.id === o1.body.step.id).label, 'Opening balance');

    // price lookup: the customer's list, else the group's, else the company default; dates must fit
    const wholesale = await doc('price_list', { name: 'Shop prices', type: 'Selling' });
    await doc('item_price', { product: soap, price_list: wholesale, rate: 950, valid_from: '2026-01-01', valid_to: '2026-01-31' });
    await doc('item_price', { product: soap, price_list: wholesale, rate: 1000, valid_from: '2026-02-01' });
    const company = (await k.get('doc/company')).body.doc;
    const retail = company.selling_price_list ?? (await doc('price_list', { name: 'Retail', type: 'Selling' }));
    await doc('item_price', { product: soap, price_list: retail, rate: 1180 });
    if (!company.selling_price_list) assert.equal((await k.post('doc/company', { doc: { ...company, selling_price_list: retail } })).status, 200);
    const price = async (party: string, date?: string) => (await k.get('price', { item: soap, party, side: 'sell', ...(date ? { date } : {}) })).body.price;
    assert.equal((await price(shop)).rate, 1180, 'no list on customer or group: the company default');
    const g = (await k.get(`doc/customer_group/${group}`)).body.doc;
    assert.equal((await k.post('doc/customer_group', { doc: { ...g, price_list: wholesale } })).status, 200);
    assert.equal((await price(shop)).rate, 1000, 'the group list');
    assert.equal((await price(shop, '2026-01-15')).rate, 950, 'the newest price valid on that date');
  } finally { k.done(); }
});

test('who records what: a cashier sells and takes payments, a storekeeper moves stock, only managers write off big amounts', async () => {
  const k = await readyKit();
  try {
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    const p = (await k.post('doc/product', { doc: { code: 'P', name: 'P' } })).body.doc.id;
    const walkin = (await k.post('doc/customer', { doc: { name: 'Walk-in' } })).body.doc.id;
    await k.post('steps', { step: { kind: 'receipt', warehouse: main, lines: [{ item: p, qty: 10, rate: 100 }] } });
    for (const [role, pin] of [['Cashier', '2001'], ['Storekeeper', '2002']]) {
      const u = (await k.post('doc/user', { doc: { name: role, role } })).body.doc.id;
      assert.equal((await k.post('pin', { user: u, pin })).status, 200);
    }
    await k.post('session', { pin: '2001' });   // cashier
    const sale = (paid: number, writeOff = true) => k.post('steps', { step: { kind: 'sales_invoice', customer: walkin, warehouse: main, lines: [{ item: p, qty: 1, rate: 5000 }], payments: [{ method: cash, amount: paid }], write_off: writeOff } });
    assert.equal((await sale(4500)).status, 200, 'small change written off at the till');
    assert.match((await sale(3000)).body.error, /Only up to 1,000 can be written off at the till/);
    assert.equal((await k.post('steps', { step: { kind: 'receipt', warehouse: main, lines: [{ item: p, qty: 1, rate: 1 }] } })).status, 403);
    assert.match((await k.post('steps', { step: { kind: 'sales_invoice', customer: walkin, opening: true, amount: 5 } })).body.error, /Only the owner, a manager or the accountant may enter opening balances/);
    await k.post('session', { pin: '2002' });   // storekeeper
    assert.equal((await k.post('steps', { step: { kind: 'transfer', from: main, to: main, lines: [{ item: p, qty: 1 }] } })).status, 422, 'may move stock (same store refused for its own reason)');
    assert.equal((await sale(5000, false)).status, 403, 'may not sell');
    await k.post('session', { pin: '1234' });   // owner
    assert.equal((await sale(3000)).status, 200, 'the owner may write off more');
  } finally { k.done(); }
});

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
