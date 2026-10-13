// The books on real accounts (gaps found 13 Oct 2026): each payment method keeps its own balance, bills name their
// expense account, cash purchases, charges taken off payments, opening stock, landed cost on a bill, "balance must
// be", and a trial balance where debits equal credits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('books per real account', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.doc.id as string; };
    const main = await idOf(k, 'store', 'Main Store');
    const [cash, mpesa, airtel, bankT] = await Promise.all(['Cash', 'M-Pesa', 'Airtel Money', 'Bank Transfer'].map((n) => idOf(k, 'payment_method', n)));
    const acc = async (n: string) => idOf(k, 'account', n);
    const soap = await doc('product', { code: 'SOAP', name: 'Bath Soap', vat_category: 'Exempt' });
    const rent = await doc('product', { code: 'RENT', name: 'Shop rent', is_stock: false, expense_account: await acc('Rent') });
    const transport = await doc('product', { code: 'TRN', name: 'Transport', is_stock: false });
    const shop = await doc('customer', { name: 'Mama Neema Shop' });
    const sup = await doc('supplier', { name: 'Bidco Ltd' });

    // opening stock on the start day goes to Temporary Opening, not to profit and loss
    await add({ kind: 'count', opening: true, warehouse: main, date: '2026-10-01', lines: [{ item: soap, qty: 100, rate: 800 }], remarks: 'Start day' });
    // two mobile-money sales: M-Pesa and Airtel Money keep separate balances
    await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 2, rate: 1000 }], payments: [{ method: mpesa, amount: 2000 }] });
    await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 1, rate: 1000 }], payments: [{ method: airtel, amount: 1000 }] });
    // moving money between two methods of the same kind is fine now
    await add({ kind: 'money_transfer', from: mpesa, to: airtel, amount: 500 });
    await add({ kind: 'money_transfer', from: mpesa, to: mpesa, amount: 1 }, 422);
    // a bill for rent (its product names Rent) and transport (no account: Other expenses), paid at once in cash
    const bill = await add({ kind: 'purchase_invoice', supplier: sup, lines: [{ item: rent, qty: 1, rate: 300 }, { item: transport, qty: 1, rate: 200 }], payments: [{ method: cash, amount: 500 }] });
    assert.equal(bill.step.payments[0].amount, 500);
    // goods arriving with a bill, then 1,000 transport added to that bill as landed cost
    const goods = await add({ kind: 'purchase_invoice', supplier: sup, update_stock: true, warehouse: main, lines: [{ item: soap, qty: 10, rate: 700 }] });
    await add({ kind: 'landed_cost', receipt: goods.step.id, amount: 1000 });
    // a customer pays 9,000 by bank for a 10,000 sale; the bank kept 1,000 in charges
    const s3 = await add({ kind: 'sales_invoice', customer: shop, warehouse: main, lines: [{ item: soap, qty: 10, rate: 1000 }] });
    await add({ kind: 'payment', direction: 'in', party: shop, method: bankT, amount: 9000, deductions: [{ account: await acc('Bank and Mobile Money Charges'), amount: 1000 }],
      allocate: [{ invoice: s3.step.id, amount: 10000 }] });

    const tb = (await k.get('books')).body;
    const bal = (n: string) => tb.accounts.find((a: any) => a.title === n)?.balance ?? 0;
    assert.equal(tb.debit, tb.credit, 'debits equal credits');
    assert.deepEqual(tb.unset, [], 'every kind of account is set up');
    assert.equal(bal('M-Pesa'), 2000 - 500);
    assert.equal(bal('Airtel Money'), 1000 + 500);
    assert.equal(bal('Cash'), -500);
    assert.equal(bal('Rent'), 300);
    assert.equal(bal('Other Expenses'), 200);
    assert.equal(bal('Temporary Opening'), -80000, 'opening stock is not profit');
    assert.equal(bal('Bank and Mobile Money Charges'), 1000);
    assert.equal(bal('Bank'), 9000);
    assert.equal(bal('Freight and Landed Costs'), -1000);
    // one account's history with the running balance
    const led = (await k.get('books/' + await acc('M-Pesa'))).body;
    assert.deepEqual(led.rows.map((r: any) => r.balance), [2000, 1500]);

    // "balance must be": cash marked Debit may not go below zero
    const cashAcc = await acc('Cash');
    const a = (await k.get('doc/account/' + cashAcc)).body.doc;
    assert.equal((await k.post('doc/account', { doc: { ...a, balance_must_be: 'Debit' } })).status, 200);
    const r = await k.post('steps', { step: { kind: 'money_transfer', from: cash, to: mpesa, amount: 1 } });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /Balance of Cash must always be debit/);
  } finally { k.done(); }
});
