// Money documents through the API (phase 3): sale with goods and VAT, part payment, return, supplier bill and payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('a sale, a part payment, a return and a supplier bill, end to end', async () => {
  const k = await readyKit();
  try {
    const main = await idOf(k, 'store', 'Main Store');
    const cash = await idOf(k, 'payment_method', 'Cash');
    const mpesa = await idOf(k, 'payment_method', 'M-Pesa');
    const soap = (await k.post('doc/product', { doc: { code: 'SOAP', name: 'Bath Soap' } })).body.doc.id;
    const rice = (await k.post('doc/product', { doc: { code: 'RICE', name: 'Rice 5kg', vat_category: 'Exempt' } })).body.doc.id;
    const shop = (await k.post('doc/customer', { doc: { name: 'Mama Neema Shop', credit_limit: 1000000, credit_days: 30 } })).body.doc.id;
    const sup = (await k.post('doc/supplier', { doc: { name: 'Bidco Ltd', payment_days: 14 } })).body.doc.id;
    const add = (step: object) => k.post('steps', { step });

    assert.equal((await add({ kind: 'purchase_receipt', warehouse: main, lines: [{ item: soap, qty: 100, rate: 1000 }, { item: rice, qty: 20, rate: 13000 }] })).status, 200);

    // credit sale, prices include VAT; rice is exempt
    const sale = await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 10, rate: 1180 }, { item: rice, qty: 2, rate: 16000 }] });
    assert.equal(sale.status, 200, JSON.stringify(sale.body));
    const si = sale.body.step.id;

    // till sale paid by M-Pesa and cash with change
    const till = await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1180 }], payments: [{ method: mpesa, amount: 1000 }, { method: cash, amount: 500 }] });
    assert.equal(till.status, 200, JSON.stringify(till.body));

    // part payment against the credit sale
    assert.equal((await add({ kind: 'payment', direction: 'in', party: shop, method: mpesa, amount: 20000, allocate: [{ invoice: si, amount: 20000 }] })).status, 200);
    // paying more than is owed on it is refused in plain words
    const over = await add({ kind: 'payment', direction: 'in', party: shop, method: cash, amount: 999999, allocate: [{ invoice: si, amount: 999999 }] });
    assert.equal(over.status, 422);
    assert.match(over.body.error, /More than is owed/);

    // the shop returns 2 soaps
    const ret = await add({ kind: 'credit_note', against: si, lines: [{ item: soap, qty: 2, rate: 1180 }] });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));

    // supplier bill for the goods received, then paid by bank
    const bill = await add({ kind: 'purchase_invoice', supplier: sup, receipt: 'ST-00001', lines: [{ item: soap, qty: 100, rate: 1000 }, { item: rice, qty: 20, rate: 13000 }] });
    assert.equal(bill.status, 200, JSON.stringify(bill.body));

    const run = (await k.post('run')).body;
    const inv = (id: string) => run.invoices.find((i: any) => i.step === id);
    // 10 soap at 1,180 incl. = 10,000 net + 1,800 VAT; rice 32,000 exempt
    assert.deepEqual([inv(si).netTotal, inv(si).vat, inv(si).roundedTotal], [42000, 1800, 43800]);
    assert.equal(inv(si).outstanding, 23800);
    assert.equal(inv(si).status, 'Partly Paid');
    assert.equal(inv(till.body.step.id).outstanding, 0);
    assert.equal(inv(ret.body.step.id).outstanding, -2360);
    const bal = Object.fromEntries(run.parties.map((p: any) => [run.titles[p.party] ?? p.party, p.balance]));
    assert.equal(bal['Mama Neema Shop'], 23800 - 2360);
    assert.equal(bal['Bidco Ltd'], 360000);
    // stock: 100 - 10 - 1 + 2 soaps
    assert.equal(run.balances.find((b: any) => b.item === soap).qty, 91);

    // the customer cannot be deleted now, and the list of movements names it
    assert.equal((await k.post(`delete/customer/${shop}`)).status, 409);
    const list = (await k.get('steps')).body;
    assert.equal(list.titles[shop], 'Mama Neema Shop');
    assert.equal(list.steps.find((s: any) => s.id === si).label, 'Sale');
  } finally { k.done(); }
});
