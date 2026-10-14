// Imports through the API (phase 5c): the incoterms and import cost types a business starts with, HS codes on
// products, an import shipment with its documents and cost lines, its page (landed cost per unit before and after),
// costing it (one landed cost; costing again undoes the earlier one), the books it writes, and trade terms on documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

test('import shipment: documents, costs, landed cost per unit, costing and the books', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const doc = async (type: string, d: object, status = 200) => { const r = await k.post('doc/' + type, { doc: d }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const main = await idOf(k, 'store', 'Main Store');

    // the template: eleven incoterms and the usual import costs (with a deposits account for the container deposit)
    assert.equal((await k.get('list/incoterm')).body.total, 11);
    const types = (await k.get('list/import_charge', { limit: '50' })).body.rows as { id: string; title: string }[];
    assert.equal(types.length, 11);
    const type = (n: string) => types.find((t) => t.title === n)!.id;
    const deposit = (await k.get('doc/import_charge/' + type('Container deposit'))).body.doc;
    assert.equal(deposit.treatment, 'Refundable deposit');
    assert.equal(deposit._titles.debit_account, 'Deposits Paid');
    const fob = await idOf(k, 'incoterm', 'FOB');

    // HS codes on products, an overseas supplier
    const hsRice = (await doc('customs_tariff', { number: '1006.30.00', description: 'Rice', duty_rate: 35 })).doc.id;
    const hsOil = (await doc('customs_tariff', { number: '1511.90.00', description: 'Palm oil', duty_rate: 10 })).doc.id;
    const rice = (await doc('product', { code: 'RICE', name: 'Rice 25kg', customs_tariff: hsRice, country_of_origin: 'Pakistan' })).doc.id;
    const oil = (await doc('product', { code: 'OIL', name: 'Palm oil 20L', customs_tariff: hsOil, country_of_origin: 'Malaysia' })).doc.id;
    const sup = (await doc('supplier', { name: 'Karachi Grains', country: 'Pakistan' })).doc.id;
    assert.equal((await k.get('doc/supplier/' + sup)).body.doc.country, 'Pakistan');

    const g1 = (await add({ kind: 'purchase_receipt', warehouse: main, date: '2026-10-01', lines: [{ item: rice, qty: 100, rate: 13200 }, { item: oil, qty: 120, rate: 5900 }] })).step.id;
    const g2 = (await add({ kind: 'purchase_receipt', warehouse: main, date: '2026-10-02', lines: [{ item: rice, qty: 50, rate: 13000 }] })).step.id;
    const sale = (await add({ kind: 'sales_invoice', customer: (await doc('customer', { name: 'Duka' })).doc.id, warehouse: main, update_stock: true, date: '2026-10-03',
      lines: [{ item: rice, qty: 10, rate: 20000 }] })).step.id;

    // a shipment checks its documents
    const wrong = await doc('import_shipment', { supplier: sup, receipts: [{ doc: sale }] }, 422);
    assert.match(wrong.errors['receipts.0.doc'], /Not goods arrived/);
    const ship = (await doc('import_shipment', { supplier: sup, incoterm: fob, named_place: 'Karachi', bl_no: 'MSKU123', eta: '2026-09-30', customs_rate: 2500, assessed_cif: 1000,
      receipts: [{ doc: g1 }, { doc: g2 }],
      costs: [
        { charge: type('Import duty'), amount: 70000, distribute: 'By hand per line' },
        { charge: type('Freight'), amount: 50000 },
        { charge: type('Import VAT'), amount: 180000 },
        { charge: type('Container deposit'), amount: 300000 },
        { charge: type('Clearing and forwarding fee'), amount: 20000, treatment: 'Expense', bill: g2 },
      ],
      shares: [{ cost: 1, receipt: g1, line: 1, amount: 50000 }, { cost: 1, receipt: g1, line: 2, amount: 5000 }, { cost: 1, receipt: g2, line: 1, amount: 15000 }] }, 422));
    // the clearing fee's bill must be a supplier bill
    assert.match(ship.errors['costs.4.bill'], /Not a supplier bill/);
    const s = (await doc('import_shipment', { supplier: sup, incoterm: fob, named_place: 'Karachi', bl_no: 'MSKU123', eta: '2026-09-30', customs_rate: 2500, assessed_cif: 1000,
      receipts: [{ doc: g1 }, { doc: g2 }],
      costs: [
        { charge: type('Import duty'), amount: 70000, distribute: 'By hand per line' },
        { charge: type('Freight'), amount: 50000 },
        { charge: type('Import VAT'), amount: 180000 },
        { charge: type('Container deposit'), amount: 300000 },
        { charge: type('Clearing and forwarding fee'), amount: 20000, treatment: 'Expense' },
      ],
      shares: [{ cost: 1, receipt: g1, line: 1, amount: 50000 }, { cost: 1, receipt: g1, line: 2, amount: 5000 }, { cost: 1, receipt: g2, line: 1, amount: 15000 }] })).doc;
    assert.equal(s.status, 'Received');                 // goods arrived named
    assert.equal(s.costs[1].treatment, 'Add to the cost of the goods');   // filled from its cost type
    assert.equal(s.costs[0].status, 'Estimated');

    // the page: goods with their landed cost per unit now and after costing; customs value and VAT base
    let v = (await k.get('shipment/' + s.id)).body;
    assert.equal(v.shipment.late, false);              // received: no longer waiting at port
    assert.equal(v.goods.length, 3);
    assert.equal(v.goods[0].hsNumber, '1006.30.00');
    assert.equal(v.goods[0].perUnitNow, 13200);
    // freight 50,000 by value over 1,320,000 + 708,000 + 650,000 = 2,678,000; duty typed: 50,000 on rice of g1
    const freightRice1 = Math.round(50000 * 1320000 / 2678000 * 100) / 100;
    assert.ok(Math.abs(v.goods[0].perUnitNew - (13200 + (freightRice1 + 50000) / 100)) < 0.01, JSON.stringify(v.goods[0]));
    assert.deepEqual(v.totals, { goods: 2678000, toGoods: 120000, vat: 180000, expense: 20000, deposit: 300000, estimated: 620000, all: 620000 });
    assert.equal(v.customs.value, 2500000);
    assert.equal(v.customs.vatBase, 2570000);          // customs value + duty
    assert.equal(v.customs.vatDue, 462600);
    assert.ok(v.goods[0].dutyWeight > v.goods[1].dutyWeight);   // rice pays 35 %, oil 10 %
    assert.equal(v.preview.ok, true);

    // costing posts one landed cost for all its cost lines
    const c1 = await k.post(`shipment/${s.id}/cost`, { date: '2026-10-04' });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    const lc = c1.body.step;
    assert.equal(lc.kind, 'landed_cost');
    assert.deepEqual(lc.receipts, [g1, g2]);
    assert.equal(lc.amount, 120000);
    assert.deepEqual(lc.charges.map((c: { treatment?: string }) => c.treatment ?? 'cost'), ['cost', 'cost', 'vat', 'deposit', 'expense']);
    v = (await k.get('shipment/' + s.id)).body;
    assert.equal(v.shipment.status, 'Costed');
    assert.equal(v.costed, lc.id);
    assert.ok(Math.abs(v.goods[0].perUnitNow - v.goods[0].perUnitNew) < 1e-6);

    // the books: stock up by 120,000; VAT input, deposits and the fee debited; all of it waits on Freight and landed costs
    const tb = (await k.get('books')).body.accounts as { title: string; balance: number }[];
    const bal = (t: string) => tb.find((a) => a.title === t)?.balance ?? 0;
    assert.equal(bal('VAT Input'), 180000);
    assert.equal(bal('Deposits Paid'), 300000);
    assert.equal(bal('Other Expenses'), 20000);
    assert.equal(bal('Freight and Landed Costs'), -620000);
    assert.equal(bal('Stock In Hand') + bal('Cost of Goods Sold'), 2678000 + 120000);   // the sale took its share of the extra cost

    // costs change (the agent's real bill): costing again undoes the first landed cost in the same go
    const cur = (await k.get('doc/import_shipment/' + s.id)).body.doc;
    cur.costs[1].amount = 60000;
    await doc('import_shipment', cur);
    const c2 = await k.post(`shipment/${s.id}/cost`, {});
    assert.equal(c2.status, 200, JSON.stringify(c2.body));
    assert.equal(c2.body.undone, lc.id);
    assert.equal(c2.body.step.amount, 130000);
    const steps = (await k.get('steps', { limit: '100' })).body.steps as { id: string; kind: string; undone: boolean; shipment?: string }[];
    assert.deepEqual(steps.filter((x) => x.kind === 'landed_cost').map((x) => x.undone), [false, true]);

    // undoing the landed cost by hand: the shipment is Received again
    const u = await k.post('steps/undo', { id: c2.body.step.id });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal((await k.get('shipment/' + s.id)).body.shipment.status, 'Received');

    // a shipment with no goods arrived cannot be costed
    const empty = (await doc('import_shipment', { supplier: sup, costs: [{ charge: type('Freight'), amount: 100 }] })).doc;
    assert.equal(empty.status, 'Ordered');
    const no = await k.post(`shipment/${empty.id}/cost`, {});
    assert.equal(no.status, 422);
    assert.match(no.body.error, /goods arrived first/);

    // a cost line named on a bill is Billed
    const bill = (await add({ kind: 'purchase_invoice', supplier: sup, lines: [{ item: (await doc('product', { code: 'CLR', name: 'Clearing', is_stock: false })).doc.id, qty: 1, rate: 20000 }] })).step.id;
    const withBill = (await doc('import_shipment', { id: empty.id, _meta: undefined, costs: [{ charge: type('Freight'), amount: 100, bill }] })).doc;
    assert.equal(withBill.costs[0].status, 'Billed');
  } finally { k.done(); }
});

test('landed cost lines through the steps API, and trade terms on documents', async () => {
  const k = await readyKit();
  try {
    const add = async (step: object, status = 200) => { const r = await k.post('steps', { step }); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
    const main = await idOf(k, 'store', 'Main Store');
    const p = (await k.post('doc/product', { doc: { code: 'A', name: 'Soap' } })).body.doc.id;
    const g = (await add({ kind: 'purchase_receipt', warehouse: main, lines: [{ item: p, qty: 10, rate: 100 }] })).step.id;
    const acc = (n: string) => idOf(k, 'account', n);

    // a deposit needs its asset account; typed per line must add up; an account must not be a group
    assert.match((await add({ kind: 'landed_cost', receipt: g, charges: [{ amount: 50, treatment: 'deposit' }] }, 422)).error, /asset account/);
    assert.match((await add({ kind: 'landed_cost', receipt: g, charges: [{ amount: 50, distribute: 'manual', shares: [{ receipt: g, line: 0, amount: 40 }] }] }, 422)).error, /must add up to 50/);
    assert.match((await add({ kind: 'landed_cost', receipt: g, charges: [{ amount: 50, account: await acc('Current Assets') }] }, 422)).error, /is a group/);
    const ok = (await add({ kind: 'landed_cost', receipt: g, charges: [{ amount: 50, distribute: 'manual', shares: [{ receipt: g, line: 0, amount: 50 }] },
      { amount: 18, treatment: 'vat' }] })).step;
    assert.equal(ok.amount, 50);
    const run = (await k.post('run', {})).body;
    assert.deepEqual(run.landed.map((l: { perUnit: number }) => l.perUnit), [105]);

    // incoterm and named place on a sale (kept on it; the engine ignores them)
    const cif = await idOf(k, 'incoterm', 'CIF');
    const c = (await k.post('doc/customer', { doc: { name: 'Kampala Traders' } })).body.doc.id;
    const sale = (await add({ kind: 'sales_invoice', customer: c, warehouse: main, update_stock: true, incoterm: cif, named_place: 'Kampala', lines: [{ item: p, qty: 1, rate: 300 }] })).step;
    assert.equal(sale.incoterm, cif);
    assert.equal(sale.namedPlace, 'Kampala');
    assert.match((await add({ kind: 'sales_invoice', customer: c, warehouse: main, update_stock: true, named_place: 'Kampala', lines: [{ item: p, qty: 1, rate: 300 }] }, 422)).error, /choose the incoterm/);
  } finally { k.done(); }
});
