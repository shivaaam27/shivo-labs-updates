// Records: create, update, validation from the definition, unique, link integrity, delete refused, child rows,
// lists (paging, filters, sort), options, search, and deleted records never leaking.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readyKit, idOf } from '../server/testkit.ts';
import type { Kit } from '../server/testkit.ts';

let k: Kit;
before(async () => { k = await readyKit(); });
after(() => k.done());

const save = (type: string, doc: object) => k.post('doc/' + type, { doc });

test('create fills defaults, normalises values and names by field', async () => {
  const r = await save('product', { code: 'SUG-1', name: '  Sugar   1kg ', notes: 'Kilo bags' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.doc;
  assert.equal(d.name, 'Sugar 1kg');
  assert.equal(d._name, 'SUG-1');
  assert.equal(d.title, 'Sugar 1kg');
  assert.equal(d.valuation_method, 'Moving Average');
  assert.equal(d.active, true);
  assert.equal(d.batch_tracked, false);
  assert.equal(d._titles.group, 'All Products');   // link default given by name
  assert.equal(d._titles.stock_unit, 'Pcs');
});

test('customers are numbered by series; phone, TIN and email are normalised', async () => {
  const a = await save('customer', { name: 'Mama Neema Shop', phone: '0712 345 678', tin: '123456789', email: 'Neema@Example.com' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.doc._name, /^CUST-\d{5}$/);
  assert.equal(a.body.doc.phone, '+255712345678');
  assert.equal(a.body.doc.tin, '123-456-789');
  assert.equal(a.body.doc.email, 'neema@example.com');
  const b = await save('customer', { name: 'Kariakoo Wholesale' });
  assert.notEqual(b.body.doc._name, a.body.doc._name);
  // the local way of writing the phone finds it too
  const s = await k.get('list/customer', { q: '0712345678' });
  assert.equal(s.body.total, 1);
});

test('validation: required, types, select options, min, bad link', async () => {
  const r = await save('customer', { type: 'Friend', credit_limit: 'lots', credit_days: 2.5, phone: '12', tin: '12', email: 'x@', group: 'Nobody' });
  assert.equal(r.status, 422);
  const e = r.body.errors;
  assert.equal(e.name, 'Required');
  assert.match(e.type, /Choose one of/);
  assert.equal(e.credit_limit, 'Must be a number');
  assert.equal(e.credit_days, 'Must be a whole number');
  assert.match(e.phone, /Phone like/);
  assert.match(e.tin, /9 digits/);
  assert.equal(e.email, 'Not an email address');
  assert.match(e.group, /No customer group called "Nobody"/);
  const neg = await save('customer', { name: 'X', credit_limit: -5 });
  assert.equal(neg.body.errors.credit_limit, 'Must be at least 0');
});

test('dates accept 13/10/2026 and refuse impossible dates', async () => {
  const p = await idOf(k, 'product', 'Sugar 1kg');
  const ok = await save('item_price', { product: p, price_list: 'Retail', rate: '3,500', valid_from: '13/10/2026' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.doc.valid_from, '2026-10-13');
  assert.equal(ok.body.doc.rate, 3500);
  assert.equal(ok.body.doc.title, 'Sugar 1kg');      // title from the linked product
  const bad = await save('item_price', { product: p, price_list: 'Wholesale', rate: 1, valid_from: '2026-02-30' });
  assert.equal(bad.body.errors.valid_from, 'Not a real date');
});

test('unique fields and naming fields refuse duplicates (any case)', async () => {
  const r = await save('product', { code: 'sug-1', name: 'Other sugar' });
  assert.equal(r.status, 422);
  assert.equal(r.body.errors.code, 'Already used by Sugar 1kg');
  const s = await save('store', { name: 'main store' });
  assert.equal(s.body.errors.name, 'Already used by Main Store');
});

test('child rows: validated, unique per table, unique barcodes across products, empty rows dropped', async () => {
  const r = await save('product', {
    code: 'OIL-1', name: 'Cooking Oil 1L', valuation_method: 'FIFO',
    units: [{ unit: 'Carton', factor: 12 }, {}, { unit: 'carton', factor: 6 }],
    barcodes: [{ barcode: '600100' }],
    reorder: [{ store: 'Main Store', level: 'x', qty: 10 }],
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.errors['units.2.unit'], 'Same as row 1');
  assert.equal(r.body.errors['reorder.0.level'], 'Must be a number');
  const ok = await save('product', { code: 'OIL-1', name: 'Cooking Oil 1L', valuation_method: 'FIFO', units: [{ unit: 'Carton', factor: 12 }, {}], barcodes: [{ barcode: '600100' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.doc.units.length, 1);
  assert.equal(ok.body.doc.units[0]._titles.unit, 'Carton');
  const dup = await save('product', { code: 'OIL-2', name: 'Oil 2L', barcodes: [{ barcode: '600100' }] });
  assert.equal(dup.body.errors['barcodes.0.barcode'], 'Already used by Cooking Oil 1L');
  const own = await save('product', { code: 'OIL-3', name: 'Oil 3L', units: [{ unit: 'Pcs', factor: 1 }] });
  assert.equal(own.body.errors['units.0.unit'], 'This is already the stock unit');
  // a barcode is found by quick search
  const s = await k.get('search', { q: '600100' });
  assert.ok(s.body.some((x: any) => x.kind === 'record' && x.title === 'Cooking Oil 1L'));
});

test('update keeps fields not sent, refuses a stale copy, and a rename follows into linked titles', async () => {
  const id = await idOf(k, 'product', 'Sugar 1kg');
  const got = await k.get(`doc/product/${id}`);
  const u = await save('product', { id, name: 'Sugar 1 kg' });
  assert.equal(u.status, 200);
  assert.equal(u.body.doc.notes, 'Kilo bags');
  const stale = await save('product', { id, name: 'Sugar again', _meta: got.body.doc._meta });
  assert.equal(stale.status, 409);
  const prices = await k.get('list/item_price', { 'f.product': id });
  assert.equal(prices.body.rows[0].title, 'Sugar 1 kg');
  assert.equal(prices.body.rows[0]._titles.product, 'Sugar 1 kg');
  const missing = await save('product', { id: 'no-such-id', name: 'x' });
  assert.equal(missing.status, 404);
});

test('link filters and inactive targets', async () => {
  const group = await idOf(k, 'account', 'Cash In Hand');
  const r = await save('payment_method', { name: 'Petty cash', type: 'Cash', account: group });
  assert.equal(r.body.errors.account, 'Cash In Hand cannot be used here');
  const brand = await save('brand', { name: 'Azam' });
  const inactiveStore = await save('store', { name: 'Old shop', active: false });
  assert.equal(inactiveStore.status, 200);
  const p = await save('product', { code: 'AZ-1', name: 'Azam Juice', brand: brand.body.doc.id, reorder: [{ store: inactiveStore.body.doc.id, level: 1, qty: 2 }] });
  assert.equal(p.body.errors['reorder.0.store'], 'Old shop is not active');
  // options leave out inactive records and honour filters
  const opts = await k.get('options/store');
  assert.ok(!opts.body.some((o: any) => o.title === 'Old shop'));
  const leaf = await k.get('options/account', { q: 'cash', 'f.is_group': 'false' });
  assert.deepEqual(leaf.body.map((o: any) => o.title), ['Cash']);   // not the group Cash In Hand
});

test('account tree: main group comes from the parent; no loops; groups with children stay groups', async () => {
  const assets = await idOf(k, 'account', 'Current Assets');
  const r = await save('account', { name: 'Petty Cash', number: '1112', parent: assets, root_type: 'Expense' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.doc.root_type, 'Asset');
  const cur = await k.get(`doc/account/${assets}`);
  const loop = await save('account', { id: assets, parent: await idOf(k, 'account', 'Cash In Hand') });
  assert.equal(loop.body.errors.parent, 'This would put it under itself');
  const leaf = await save('account', { id: assets, is_group: false });
  assert.match(leaf.body.errors.is_group, /must stay a group/);
  assert.ok(cur.body.links.account > 0);
});

test('delete is refused while linked (409 usedIn), allowed when free, and deleted records never come back', async () => {
  const group = await save('product_group', { name: 'Drinks' });
  const prod = await save('product', { code: 'SODA', name: 'Soda 500ml', group: group.body.doc.id });
  const refused = await k.post(`delete/product_group/${group.body.doc.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.usedIn[0].title, 'Soda 500ml');
  assert.equal(refused.body.usedIn[0].field, 'group');
  const got = await k.get(`doc/product_group/${group.body.doc.id}`);
  assert.equal(got.body.links.product, 1);

  assert.equal((await k.post(`delete/product/${prod.body.doc.id}`)).status, 200);
  assert.equal((await k.post(`delete/product_group/${group.body.doc.id}`)).status, 200);
  assert.equal((await k.get(`doc/product/${prod.body.doc.id}`)).status, 404);
  assert.equal((await k.get('list/product', { q: 'soda' })).body.total, 0);
  assert.equal((await k.get('options/product_group', { q: 'drinks' })).body.length, 0);
  assert.ok(!(await k.get('search', { q: 'soda' })).body.some((x: any) => x.kind === 'record'));
  // the code is free again, and a link to the deleted record is refused
  assert.equal((await save('product', { code: 'SODA', name: 'Soda 300ml' })).status, 200);
  assert.match((await save('product', { code: 'X1', name: 'X', group: group.body.doc.id })).body.errors.group, /No product group/);
  assert.equal((await k.post(`delete/product/${prod.body.doc.id}`)).status, 404);
  assert.equal((await k.post('delete/company/company')).status, 400);
});

test('lists: total, paging without gaps, sort by field and by link title, filters', async () => {
  for (let i = 1; i <= 7; i++) await save('brand', { name: `Brand ${String(i).padStart(2, '0')}` });
  const page1 = await k.get('list/brand', { q: 'brand', limit: '3', offset: '0', sort: 'name' });
  const page3 = await k.get('list/brand', { q: 'brand', limit: '3', offset: '6', sort: 'name' });
  assert.equal(page1.body.total, 7);
  assert.deepEqual(page1.body.rows.map((r: any) => r.name), ['Brand 01', 'Brand 02', 'Brand 03']);
  assert.deepEqual(page3.body.rows.map((r: any) => r.name), ['Brand 07']);
  const desc = await k.get('list/brand', { q: 'brand', sort: 'name', dir: 'desc', limit: '1' });
  assert.equal(desc.body.rows[0].name, 'Brand 07');
  const fifo = await k.get('list/product', { 'f.valuation_method': 'FIFO' });
  assert.deepEqual(fifo.body.rows.map((r: any) => r.title), ['Cooking Oil 1L']);
  // a record saved without a check field counts as the field's default (active = yes)
  k.api.db.prepare("UPDATE docs SET data = json_remove(data, '$.active') WHERE type = 'unit' AND name = 'Pcs'").run();
  assert.equal((await k.get('list/unit', { 'f.active': '1' })).body.total, 10);
  assert.equal((await k.get('options/unit', { q: 'pcs' })).body.length, 1);
  const inactive = await k.get('list/store', { 'f.active': 'false' });
  assert.deepEqual(inactive.body.rows.map((r: any) => r.title), ['Old shop']);
  const byGroup = await k.get('list/account', { sort: 'parent', limit: '500' });
  assert.equal(byGroup.status, 200);
  assert.equal((await k.get('list/brand', { sort: 'nonsense' })).status, 400);
  assert.equal((await k.get('list/brand', { 'f.nonsense': '1' })).status, 400);
  // quotes and LIKE wildcards in search are plain text
  assert.equal((await k.get('list/brand', { q: "%' OR 1=1 --" })).body.total, 0);
  assert.equal((await k.get('list/brand', { q: '_' })).body.total, 0);
  assert.equal((await k.get('list/product_barcode')).status, 400);
});

test('history records who changed what', async () => {
  const id = await idOf(k, 'product', 'Sugar 1 kg');
  const h = await k.get(`log/product/${id}`);
  assert.equal(h.body.history[0].action, 'update');
  assert.deepEqual(h.body.history[0].changed, ['name']);
  assert.equal(h.body.history[0].byName, 'Juma');
  assert.equal(h.body.history.at(-1).action, 'create');
});
