// Foreign currency through the API (phase 5b): exchange rate records fill the rate, a USD supplier's bill and payment
// land on a creditors account in USD (made by itself), the difference goes to Exchange Gain/Loss, prices are turned into
// the document's currency, and the currency rules on the records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('USD supplier and customer: rates, bills, payments at another rate, books, prices, rules', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object, status = 200) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, status, JSON.stringify(r.body)); return status === 200 ? r.body.doc.id as string : r.body; };
    const main = await idOf(k, 'store', 'Main Store');
    const rice = await doc('product', { code: 'RICE', name: 'Rice 25kg', vat_category: 'Exempt' });
    const acme = await doc('supplier', { name: 'Acme Overseas', currency: 'USD' });
    const bank = await idOf(k, 'payment_method', 'Bank Transfer');

    // no rate yet: the bill asks for one; a rate record fills it in (newest on or before the date)
    assert.match((await add({ kind: 'purchase_invoice', supplier: acme, date: '2026-10-02', update_stock: true, warehouse: main, lines: [{ item: rice, qty: 10, rate: 20 }] }, 422)).error, /No exchange rate for USD/);
    await doc('currency_exchange', { date: '2026-10-01', from_currency: 'USD', rate: 2500 });
    await doc('currency_exchange', { date: '2026-10-05', from_currency: 'USD', rate: 2600 });
    assert.deepEqual((await k.get('rate', { party: acme, date: '2026-10-03', side: 'buy' })).body, { currency: 'USD', rate: 2500, date: '2026-10-01' });
    const b1 = (await add({ kind: 'purchase_invoice', supplier: acme, date: '2026-10-02', update_stock: true, warehouse: main, lines: [{ item: rice, qty: 10, rate: 20 }] })).step;
    assert.deepEqual([b1.currency, b1.exchangeRate], ['USD', 2500]);
    // a TZS document for a USD supplier is refused
    assert.match((await add({ kind: 'purchase_invoice', supplier: acme, currency: 'TZS', lines: [{ item: rice, qty: 1, rate: 1 }] }, 422)).error, /kept in USD/);

    // paid at the rate of the payment day (2,600): 200 USD clears 520,000 TZS, the 20,000 more is a loss
    await add({ kind: 'payment', direction: 'out', party: acme, method: bank, amount: 200, date: '2026-10-06', allocate: [{ invoice: b1.id, amount: 200 }] });
    const run = (await k.post('run')).body;
    assert.deepEqual(run.invoices.find((i: any) => i.step === b1.id).outstanding, 0);
    assert.deepEqual(run.parties.find((p: any) => p.party === acme), { party: acme, balance: 0, inCurrency: 0 });
    const tb = (await k.get('books')).body;
    const acc = (name: string) => tb.accounts.find((a: any) => a.title === name);
    assert.equal(acc('Creditors USD').balance, 0);     // made by itself, kept in USD
    assert.equal(acc('Exchange Gain/Loss').balance, 20000);
    assert.equal(acc('Stock In Hand').balance, 500000);
    const usdAcc = await idOf(k, 'account', 'Creditors USD');
    assert.equal((await k.get('doc/account/' + usdAcc)).body.doc.currency, 'USD');

    // its currency cannot change now; only debtors and creditors accounts are kept in another currency
    const a = (await k.get('doc/supplier/' + acme)).body.doc;
    assert.match((await doc('supplier', { ...a, currency: 'EUR' }, 422)).errors.currency, /already have documents/);
    assert.match((await doc('account', { name: 'USD cash', parent: await idOf(k, 'account', 'Cash In Hand'), account_type: 'Cash', currency: 'USD' }, 422)).errors.currency, /debtors and creditors/);

    // a USD customer: prices from a TZS list turned into USD at the document's rate; the preview keeps cents
    const safari = await doc('customer', { name: 'Safari Lodge', currency: 'USD' });
    const retail = await idOf(k, 'price_list', 'Retail');
    await doc('item_price', { product: rice, price_list: retail, rate: 65000 });
    const price = (await k.get('price', { item: rice, party: safari, side: 'sell', currency: 'USD', exchange_rate: '2600', date: '2026-10-06' })).body.price;
    assert.deepEqual([price.rate, price.currency, price.priceListCurrency], [25, 'USD', 'TZS']);
    const pv = (await k.post('preview', { step: { kind: 'sales_invoice', customer: safari, warehouse: main, exchange_rate: 2600, lines: [{ item: rice, qty: 1, rate: 25.25 }] } })).body;
    assert.deepEqual([pv.roundedTotal, pv.currency], [25.25, { code: 'USD', rate: 2600, roundedTotal: 65650 }]);
    const s1 = (await add({ kind: 'sales_invoice', customer: safari, warehouse: main, date: '2026-10-06', exchange_rate: 2600, lines: [{ item: rice, qty: 2, rate: 30 }] })).step;
    // a journal row settling it takes its rate; another rate is refused
    const debUsd = () => idOf(k, 'account', 'Debtors USD');
    const bankAcc = await idOf(k, 'account', 'Bank');
    assert.match((await add({ kind: 'journal', rows: [{ account: bankAcc, debit: 156000 }, { account: await debUsd(), credit: 60, party: safari, invoice: s1.id, exchange_rate: 2500 }] }, 422)).error, /takes the invoice's rate/);
    const j = (await add({ kind: 'journal', rows: [{ account: bankAcc, debit: 156000 }, { account: await debUsd(), credit: 60, party: safari, invoice: s1.id }] })).step;
    assert.equal(j.rows[1].exchangeRate, 2600);
    assert.equal((await k.post('run')).body.invoices.find((i: any) => i.step === s1.id).status, 'Paid');
  } finally { k.done(); }
});
