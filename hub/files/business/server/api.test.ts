// The API as the screens use it: first-run setup, session and PINs, permissions per role, meta,
// stock movements (add, refuse, undo) and /run on the stored movements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKit, readyKit, idOf } from './testkit.ts';
import type { Kit } from './testkit.ts';

test('before setup only session, meta and setup work; setup seeds the Tanzania template', async () => {
  const k = makeKit();
  try {
    assert.deepEqual((await k.get('session')).body, { ready: false, user: null, company: null, needsPin: false });
    assert.equal((await k.get('list/product')).status, 409);
    const meta = await k.get('meta');
    assert.deepEqual(meta.body.defs.map((d: any) => d.type), ['company']);
    // writes need the hub header
    const noHeader = await k.api.call({ method: 'POST', path: '/api/business/setup', body: {}, headers: {} });
    assert.equal(noHeader.status, 403);
    // bad setup: nothing is created
    const bad = await k.post('setup', { company: { name: 'Juma Traders', tin: '12' }, owner: { name: 'Juma', pin: '1234' } });
    assert.equal(bad.status, 422);
    assert.match(bad.body.errors['company.tin'], /9 digits/);
    assert.equal((await k.post('setup', { company: { name: 'X' }, owner: { name: 'Juma', pin: '12' } })).body.errors['owner.pin'], 'The PIN must be 4 to 8 digits');
    assert.match((await k.post('setup', { company: { name: 'X' }, owner: { name: 'Juma', pin: '1234', phone: '12' } })).body.errors['owner.phone'], /Phone like/);
    assert.equal((await k.get('session')).body.ready, false);

    const r = await k.post('setup', { company: { name: 'Juma Traders', tin: '123456789', vrn: '40-012345-K' }, owner: { name: 'Juma', pin: '1234' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = (await k.get('session')).body;
    assert.equal(s.ready, true);
    assert.equal(s.user.role, 'owner');
    assert.equal(s.company.name, 'Juma Traders');
    assert.equal((await k.post('setup', { company: { name: 'Again' }, owner: { name: 'A', pin: '9999' } })).status, 409);

    const titles = async (type: string) => (await k.get('list/' + type, { limit: '500' })).body.rows.map((x: any) => x.title).sort();
    assert.deepEqual(await titles('unit'), ['Bag', 'Box', 'Bundle', 'Carton', 'Dozen', 'g', 'Kg', 'L', 'ml', 'Pcs'].sort());
    assert.deepEqual(await titles('payment_method'), ['Airtel Money', 'Bank Transfer', 'Card', 'Cash', 'HaloPesa', 'M-Pesa', 'Mixx by Yas']);
    assert.deepEqual(await titles('price_list'), ['Buying', 'Retail', 'Wholesale']);
    assert.deepEqual(await titles('store'), ['Main Store']);
    assert.deepEqual(await titles('product_group'), ['All Products']);
    const taxes = (await k.get('list/tax')).body.rows;
    assert.deepEqual(taxes.map((t: any) => [t.title, t.rate, t.to_confirm]), [['VAT 16% (electronic payment)', 16, true], ['VAT 18%', 18, false]]);
    const mpesa = await k.get(`doc/payment_method/${await idOf(k, 'payment_method', 'M-Pesa')}`);
    assert.equal(mpesa.body.doc._titles.account, 'M-Pesa');
    const company = (await k.get('doc/company')).body.doc;
    assert.equal(company.tin, '123-456-789');
    assert.equal(company._titles.default_store, 'Main Store');
    assert.equal(company._titles.srbnb_account, 'Stock Received Not Billed');
    assert.equal(company._titles.cogs_account, 'Cost of Goods Sold');
    // every account sits in a group of the same main group
    const accounts = (await k.get('list/account', { limit: '500' })).body.rows;
    const byId = new Map(accounts.map((a: any) => [a.id, a]));
    for (const a of accounts) {
      if (!a.parent) { assert.ok(a.is_group, `${a.title} is a root`); continue; }
      const p: any = byId.get(a.parent);
      assert.ok(p.is_group && p.root_type === a.root_type, `${a.title} under ${p.title}`);
    }
  } finally { k.done(); }
});

/** Owner Juma (1234) plus one user per other role, PIN 2000 + index. */
async function teamKit(): Promise<{ k: Kit; ids: Record<string, string> }> {
  const k = await readyKit();
  const ids: Record<string, string> = {};
  const roles = ['Manager', 'Cashier', 'Storekeeper', 'Salesman', 'Accountant'];
  for (const [i, role] of roles.entries()) {
    const u = await k.post('doc/user', { doc: { name: role + ' One', role } });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    ids[role.toLowerCase()] = u.body.doc.id;
    assert.equal((await k.post('pin', { user: u.body.doc.id, pin: String(2001 + i) })).status, 200);
  }
  return { k, ids };
}

test('session: PIN switch, wrong PIN, lock, lockout after 5 tries, PIN never stored plain', async () => {
  const { k, ids } = await teamKit();
  try {
    const sw = await k.post('session', { pin: '2002' });
    assert.equal(sw.body.user.role, 'cashier');
    assert.equal((await k.get('session')).body.user.id, ids.cashier);
    assert.equal((await k.post('session', { pin: '9999' })).status, 401);
    await k.post('session', { lock: true });
    const locked = await k.get('session');
    assert.equal(locked.body.user, null);
    assert.equal(locked.body.needsPin, true);
    assert.equal((await k.get('list/product')).status, 401);
    // the earlier wrong PIN counts: 4 more make 5
    for (let i = 0; i < 3; i++) assert.equal((await k.post('session', { pin: '0000' })).status, 401);
    assert.equal((await k.post('session', { pin: '0000' })).status, 401);
    assert.equal((await k.post('session', { pin: '1234' })).status, 429);   // locked for 30 s, even with the right PIN
    k.api.session.lockedUntil = 0;
    assert.equal((await k.post('session', { pin: '1234' })).body.user.role, 'owner');
    const rows = k.api.db.prepare('SELECT pin_hash FROM users').all() as { pin_hash: string }[];
    for (const r of rows) assert.ok(r.pin_hash.startsWith('scrypt$') && !r.pin_hash.includes('1234'));
    // a PIN must pick one person
    const dup = await k.post('pin', { user: ids.manager, pin: '2002' });
    assert.equal(dup.status, 422);
    // the user record says whether a PIN is set; the hash never leaves the server
    const doc = await k.get(`doc/user/${ids.manager}`);
    assert.equal(doc.body.doc._meta.hasPin, true);
    assert.ok(!JSON.stringify(doc.body).includes('scrypt'));
  } finally { k.done(); }
});

test('permissions follow the definitions; the owner may do everything', async () => {
  const { k, ids } = await teamKit();
  try {
    const as = async (pin: string) => { const r = await k.post('session', { pin }); assert.equal(r.status, 200); };
    // cashier: may add customers, may not touch products, accounts or users
    await as('2002');
    assert.equal((await k.post('doc/customer', { doc: { name: 'Walk-in', type: 'Walk-in' } })).status, 200);
    const noProduct = await k.post('doc/product', { doc: { code: 'P1', name: 'P1' } });
    assert.equal(noProduct.status, 403);
    assert.match(noProduct.body.error, /cashier/);
    assert.equal((await k.get('list/account')).status, 403);
    assert.equal((await k.get('list/user')).status, 403);
    assert.equal((await k.post('pin', { user: ids.manager, pin: '7777' })).status, 403);
    assert.equal((await k.post('pin', { pin: '7777', current: '0000' })).status, 422);  // own PIN needs the current one
    assert.equal((await k.post('pin', { pin: '7777', current: '2002' })).status, 200);
    const meta = (await k.get('meta')).body;
    const types = meta.defs.map((d: any) => d.type);
    assert.ok(!types.includes('account') && !types.includes('user') && types.includes('product') && types.includes('product_unit'));
    assert.equal(meta.defs.find((d: any) => d.type === 'customer').can.write, true);
    assert.equal(meta.defs.find((d: any) => d.type === 'product').can.write, false);
    // a cashier records sales, returns and payments, never stock movements, bills or journals
    assert.deepEqual([meta.steps.kinds.sales_invoice, meta.steps.kinds.payment, meta.steps.kinds.receipt, meta.steps.kinds.purchase_invoice, meta.steps.kinds.journal], [true, true, false, false, false]);
    const noMove = await k.post('steps', { step: { kind: 'receipt', warehouse: 'x', lines: [] } });
    assert.equal(noMove.status, 403);
    assert.match(noMove.body.error, /cashier.*stock in/);
    // search only shows what the role may read
    assert.ok(!(await k.get('search', { q: 'cash' })).body.some((x: any) => x.type === 'account'));

    // storekeeper: products and stock, not customers or price lists
    await as('2003');
    assert.equal((await k.post('doc/product', { doc: { code: 'P1', name: 'Product one' } })).status, 200);
    assert.equal((await k.post('doc/price_list', { doc: { name: 'Special' } })).status, 403);
    assert.equal((await k.get('list/customer')).status, 200);
    assert.equal((await k.post('doc/customer', { doc: { name: 'Z' } })).status, 403);

    // accountant: chart of accounts
    await as('2005');
    assert.equal((await k.post('doc/account', { doc: { name: 'Insurance', number: '5297', parent: 'Indirect Expenses' } })).status, 200);
    assert.equal((await k.post('doc/user', { doc: { name: 'Sneaky', role: 'Owner' } })).status, 403);

    // manager: almost everything, but not users
    await as('2001');
    assert.equal((await k.get('list/user')).status, 200);
    assert.equal((await k.post('doc/user', { doc: { name: 'Sneaky', role: 'Owner' } })).status, 403);
    const p = await idOf(k, 'product', 'Product one');
    assert.equal((await k.post(`delete/product/${p}`)).status, 200);

    // owner: users; the last owner cannot be demoted or deleted
    await as('1234');
    const owner = (await k.get('session')).body.user.id;
    const demote = await k.post('doc/user', { doc: { id: owner, role: 'Manager' } });
    assert.equal(demote.body.errors.role, 'There must always be at least one active owner');
    assert.equal((await k.post(`delete/user/${owner}`)).status, 409);
    // a deactivated user can no longer switch in
    assert.equal((await k.post('doc/user', { doc: { id: ids.salesman, active: false } })).status, 200);
    assert.equal((await k.post('session', { pin: '2004' })).status, 401);
  } finally { k.done(); }
});

test('with two owners nobody is assumed: a PIN is needed', async () => {
  const k = await readyKit();
  try {
    const u = await k.post('doc/user', { doc: { name: 'Asha', role: 'Owner' } });
    await k.post('pin', { user: u.body.doc.id, pin: '5555' });
    k.api.session.switched = false; k.api.session.userId = null;   // as after a hub restart
    assert.equal((await k.get('session')).body.needsPin, true);
    assert.equal((await k.post('session', { pin: '5555' })).body.user.name, 'Asha');
  } finally { k.done(); }
});

test('stock movements: add, refuse with a plain message, undo, and /run from the database', async () => {
  const k = await readyKit();
  try {
    const rice = (await k.post('doc/product', { doc: { code: 'RICE-5', name: 'Rice 5kg' } })).body.doc.id;
    const oil = (await k.post('doc/product', { doc: { code: 'OIL-1', name: 'Cooking Oil 1L', valuation_method: 'FIFO' } })).body.doc.id;
    const kilo = (await k.post('doc/product', { doc: { code: 'BEANS', name: 'Beans', stock_unit: 'Kg' } })).body.doc.id;
    const main = await idOf(k, 'store', 'Main Store');
    const van = (await k.post('doc/store', { doc: { name: 'Van 1', type: 'Van' } })).body.doc.id;
    const add = (step: object) => k.post('steps', { step });

    const r1 = await add({ kind: 'purchase_receipt', date: '2026-10-01', time: '09:00:00', warehouse: main, lines: [{ item: rice, qty: 10, rate: 13000 }, { item: oil, qty: 5, rate: 5800 }] });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.step.id, 'ST-00001');
    await add({ kind: 'purchase_receipt', date: '2026-10-02', time: '09:00:00', warehouse: main, lines: [{ item: oil, qty: 5, rate: 6000 }] });
    const sell = await add({ kind: 'delivery', date: '2026-10-03', time: '10:00:00', warehouse: main, lines: [{ item: rice, qty: 42, rate: 16000 }] });
    assert.equal(sell.status, 422);
    assert.equal(sell.body.error, 'Not enough Rice 5kg in Main Store: 32 short');
    // the refused step is not kept and its number is not used up
    const ok = await add({ kind: 'transfer', date: '2026-10-03', time: '11:00:00', from: main, to: van, lines: [{ item: rice, qty: 4 }] });
    assert.equal(ok.body.step.id, 'ST-00003');
    assert.equal((await add({ kind: 'issue', warehouse: main, lines: [{ item: rice, qty: 1.5 }] })).body.error, 'Rice 5kg is counted in Pcs: whole numbers only');
    assert.equal((await add({ kind: 'receipt', warehouse: main, lines: [{ item: kilo, qty: 2.5, rate: 3000 }] })).status, 200);
    assert.match((await add({ kind: 'receipt', warehouse: main, lines: [{ item: rice, qty: 1 }] })).body.error, /cost needed/);
    assert.match((await add({ kind: 'teleport', warehouse: main, lines: [] })).body.error, /Unknown kind/);
    assert.match((await add({ kind: 'issue', warehouse: 'nope', lines: [{ item: rice, qty: 1 }] })).body.error, /store does not exist/);
    assert.match((await add({ kind: 'transfer', from: main, to: main, lines: [{ item: rice, qty: 1 }] })).body.error, /two different stores/);
    assert.equal((await add({ kind: 'issue', date: '2026-13-01', warehouse: main, lines: [{ item: rice, qty: 1 }] })).status, 422);

    // stock in use: the product's cost method and stock unit are fixed; the product and store cannot be deleted
    const lock = await k.post('doc/product', { doc: { id: oil, valuation_method: 'Moving Average' } });
    assert.match(lock.body.errors.valuation_method, /already has stock movements/);
    assert.equal((await k.post(`delete/product/${rice}`)).status, 409);
    assert.equal((await k.post(`delete/store/${van}`)).status, 409);
    assert.equal((await k.get(`doc/product/${rice}`)).body.links.step, 2);

    // run from the database: FIFO for oil, moving average for rice, per store
    const run = (await k.post('run')).body;
    const bal = (item: string, wh: string) => run.balances.find((b: any) => b.item === item && b.warehouse === wh);
    assert.deepEqual([bal(rice, main).qty, bal(rice, van).qty, bal(oil, main).qty, bal(oil, main).value], [6, 4, 10, 59000]);
    assert.equal(run.titles[rice], 'Rice 5kg');
    assert.equal(run.errors.length, 0);

    // undo the transfer; undoing twice or undoing an undo is refused
    const undo = await k.post('steps/undo', { id: 'ST-00003' });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(undo.body.step.kind, 'cancel');
    assert.equal((await k.post('steps/undo', { id: 'ST-00003' })).status, 409);
    assert.equal((await k.post('steps/undo', { id: undo.body.step.id })).status, 422);
    assert.equal((await k.post('steps/undo', { id: 'ST-99999' })).status, 404);
    const after = (await k.post('run')).body;
    assert.equal(after.balances.find((b: any) => b.item === rice && b.warehouse === main).qty, 10);

    // undo that would leave stock below zero is refused: sell 8 of the 10, then try to undo the receipt
    assert.equal((await add({ kind: 'delivery', date: '2026-10-05', time: '10:00:00', warehouse: main, lines: [{ item: rice, qty: 8, rate: 16000 }] })).status, 200);
    const undoReceipt = await k.post('steps/undo', { id: 'ST-00001' });
    assert.equal(undoReceipt.status, 422);
    assert.match(undoReceipt.body.error, /^Not enough (Rice 5kg|Cooking Oil 1L) in Main Store/);

    // landed cost on goods arrived
    assert.equal((await add({ kind: 'landed_cost', receipt: 'ST-00001', amount: 15000, distribute: 'qty' })).status, 200);
    assert.match((await add({ kind: 'landed_cost', receipt: 'ST-00003', amount: 100 })).body.error, /Goods arrived/);

    // the movement list, newest first, with titles and who made them
    const list = (await k.get('steps')).body;
    assert.equal(list.total, list.steps.length);
    assert.equal(list.steps.at(-1).id, 'ST-00001');
    assert.equal(list.steps.find((s: any) => s.id === 'ST-00003').undone, true);
    assert.equal(list.titles[list.steps[0].by], 'Juma');

    // a scenario sent in the body is ignored: /run always works from the stored movements
    const demo = await k.post('run', { id: 'd', title: 'demo', items: [{ key: 'A', valuation: 'FIFO' }], warehouses: ['S'], steps: [{ id: 's1', kind: 'receipt', date: '2026-10-01', time: '09:00:00', warehouse: 'S', lines: [{ item: 'A', qty: 2, rate: 10 }] }] });
    assert.deepEqual(demo.body.balances, (await k.post('run')).body.balances);

    // a storekeeper may add movements but not undo them; a cashier may not add them
    const sk = await k.post('doc/user', { doc: { name: 'Store Keeper', role: 'Storekeeper' } });
    await k.post('pin', { user: sk.body.doc.id, pin: '3333' });
    await k.post('session', { pin: '3333' });
    assert.equal((await add({ kind: 'receipt', warehouse: main, lines: [{ item: rice, qty: 1, rate: 13000 }] })).status, 200);
    assert.equal((await k.post('steps/undo', { id: 'ST-00002' })).status, 403);
  } finally { k.done(); }
});

test('bad requests get JSON errors, not crashes', async () => {
  const k = await readyKit();
  try {
    assert.equal((await k.get('nothing/here')).status, 404);
    assert.equal((await k.get('list/spaceship')).status, 404);
    assert.equal((await k.post('doc/product', { doc: 'text' })).status, 400);
    assert.equal((await k.post('doc/product', {})).status, 400);
    assert.equal((await k.api.call({ method: 'POST', path: '/api/business/doc/product', body: [1], headers: { 'x-hub': '1' } })).status, 400);
    assert.equal((await k.get('doc/product/%E0%A4%A')).status, 400);
    assert.equal((await k.api.call({ method: 'DELETE', path: '/api/business/doc/product', headers: { 'x-hub': '1' } })).status, 405);
    assert.equal((await k.post('steps', {})).status, 422);
    assert.equal((await k.get('options/product_unit')).status, 400);
    // history only for a record of the type asked for
    const unit = await idOf(k, 'unit', 'Pcs');
    assert.equal((await k.get(`log/unit/${unit}`)).status, 200);
    assert.equal((await k.get(`log/brand/${unit}`)).status, 404);
  } finally { k.done(); }
});
