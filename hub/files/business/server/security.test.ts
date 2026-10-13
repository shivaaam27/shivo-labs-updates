// Regression tests for the review of 13 Oct 2026: sessions after a restart, PIN reuse, the PIN lock,
// and calls that need a signed-in user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, readyKit } from './testkit.ts';

// what the session looks like right after the hub (re)starts
const restart = (k: Awaited<ReturnType<typeof readyKit>>) => Object.assign(k.api.session, { userId: null, switched: false, fails: 0, lockedUntil: 0 });

test('after a restart only a one-person business skips the PIN', async () => {
  const k = await readyKit();
  try {
    restart(k);
    assert.equal((await k.get('session')).body.user?.name, 'Juma', 'single owner: no PIN needed');

    const c = await k.post('doc/user', { doc: { name: 'Cashier Asha', role: 'Cashier' } });
    await k.post('pin', { user: c.body.doc.id, pin: '2222' });
    restart(k);
    const s = (await k.get('session')).body;
    assert.equal(s.user, null);
    assert.equal(s.needsPin, true);
    assert.equal((await k.get('list/product')).status, 401, 'nothing without a PIN');
  } finally { k.done(); }
});

test('the owner needs the current PIN to change their own PIN', async () => {
  const k = await readyKit();
  try {
    assert.equal((await k.post('pin', { pin: '9999' })).status, 422);
    assert.equal((await k.post('pin', { pin: '9999', current: '1111' })).status, 422);
    assert.equal((await k.post('pin', { pin: '9999', current: '1234' })).status, 200);
  } finally { k.done(); }
});

test('a PIN can never pick two people, also after someone is switched off and on again', async () => {
  const k = await readyKit();
  try {
    const m = await k.post('doc/user', { doc: { name: 'Manager Ali', role: 'Manager' } });
    await k.post('pin', { user: m.body.doc.id, pin: '5555' });
    await k.post('doc/user', { doc: { ...m.body.doc, active: false } });        // switched off: PIN cleared
    const c = await k.post('doc/user', { doc: { name: 'Cashier Neema', role: 'Cashier' } });
    assert.equal((await k.post('pin', { user: c.body.doc.id, pin: '5555' })).status, 200);
    await k.post('doc/user', { doc: { ...m.body.doc, active: true } });         // back on, without a PIN
    assert.equal((await k.post('session', { pin: '5555' })).body.user.name, 'Cashier Neema');

    // two PIN changes at the same moment cannot both take the same PIN
    await k.post('session', { pin: '1234' });   // back to the owner, who may add people
    const x = await k.post('doc/user', { doc: { name: 'X', role: 'Cashier' } });
    const y = await k.post('doc/user', { doc: { name: 'Y', role: 'Cashier' } });
    const both = await Promise.all([k.post('pin', { user: x.body.doc.id, pin: '7777' }), k.post('pin', { user: y.body.doc.id, pin: '7777' })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 422]);
  } finally { k.done(); }
});

test('wrong PINs sent all at once still hit the lock', async () => {
  const k = await readyKit();
  try {
    const tries = await Promise.all([...Array(20)].map(() => k.post('session', { pin: '0000' })));
    const codes = tries.map((r) => r.status);
    assert.ok(codes.filter((c) => c === 401).length <= 5, `at most 5 real checks, got ${codes.join(',')}`);
    assert.ok(codes.includes(429));
    assert.equal((await k.post('session', { pin: '1234' })).status, 429, 'the right PIN waits for the lock too');
  } finally { k.done(); }
});

test('stock figures need a signed-in user; a scenario in the body is never run', async () => {
  const k = await readyKit();
  try {
    const c = await k.post('doc/user', { doc: { name: 'Cashier B', role: 'Cashier' } });
    await k.post('pin', { user: c.body.doc.id, pin: '4444' });
    await k.post('session', { lock: true });
    const r = await k.post('run', { items: [{ key: 'A', valuation: 'FIFO' }], warehouses: ['S'], steps: [] });
    assert.equal(r.status, 401);
  } finally { k.done(); }
});

// ---- stock movements (review items 3 and 4) ----

test('a movement sent twice with the same screen id is saved once (retry after a timeout)', async () => {
  const k = await readyKit();
  try {
    const rice = (await k.post('doc/product', { doc: { code: 'RICE-5', name: 'Rice 5kg' } })).body.doc.id;
    const main = await idOf(k, 'store', 'Main Store');
    const step = { kind: 'purchase_receipt', warehouse: main, lines: [{ item: rice, qty: 10, rate: 13000 }], client_id: 'abc-123' };
    const a = await k.post('steps', { step }), b = await k.post('steps', { step });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.body.step.id, b.body.step.id);
    assert.equal((await k.get('steps')).body.total, 1);
    // undo has a fixed id too: a retry gives back the same undo
    const u1 = await k.post('steps/undo', { id: a.body.step.id, client_id: `undo-${a.body.step.id}` });
    const u2 = await k.post('steps/undo', { id: a.body.step.id, client_id: `undo-${a.body.step.id}` });
    assert.equal(u1.body.step.id, u2.body.step.id);
    assert.equal((await k.post('steps', { step: { ...step, client_id: 'bad id!' } })).status, 422);
  } finally { k.done(); }
});

test('switching "allow negative stock" off keeps movements made while it was on', async () => {
  const k = await readyKit();
  try {
    const rice = (await k.post('doc/product', { doc: { code: 'RICE-5', name: 'Rice 5kg' } })).body.doc.id;
    const main = await idOf(k, 'store', 'Main Store');
    const company = (await k.get('doc/company')).body.doc;
    await k.post('doc/company', { doc: { ...company, allow_negative_stock: true } });
    await k.post('steps', { step: { kind: 'purchase_receipt', warehouse: main, lines: [{ item: rice, qty: 2, rate: 100 }] } });
    assert.equal((await k.post('steps', { step: { kind: 'delivery', warehouse: main, lines: [{ item: rice, qty: 5, rate: 150 }] } })).status, 200);
    const off = await k.post('doc/company', { doc: { ...(await k.get('doc/company')).body.doc, allow_negative_stock: false } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const run = (await k.post('run')).body;
    assert.equal(run.errors.length, 0, 'the old sale is still counted');
    assert.equal(run.balances[0].qty, -3);
    // from now on a sale below zero is refused
    assert.equal((await k.post('steps', { step: { kind: 'delivery', warehouse: main, lines: [{ item: rice, qty: 1, rate: 150 }] } })).status, 422);
  } finally { k.done(); }
});

test('3,000 movements stay fast', async () => {
  const { runScenario } = await import('../core/run.ts');
  const steps: any[] = [];
  for (let i = 0; i < 3000; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString();
    steps.push(i % 2 === 0
      ? { id: 'S' + i, kind: 'purchase_receipt', date: d.slice(0, 10), time: d.slice(11, 19), warehouse: 'W', lines: [{ item: 'I' + (i % 50), qty: 10, rate: 100 }] }
      : { id: 'S' + i, kind: 'delivery', date: d.slice(0, 10), time: d.slice(11, 19), warehouse: 'W', lines: [{ item: 'I' + ((i - 1) % 50), qty: 5, rate: 150 }] });
  }
  const t = performance.now();
  const r = runScenario({ id: 'p', title: 'p', items: Array.from({ length: 50 }, (_, i) => ({ key: 'I' + i, valuation: i % 2 ? 'FIFO' : 'Moving Average' })), warehouses: ['W'], steps });
  const ms = performance.now() - t;
  assert.equal(r.errors.length, 0);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});

test('names of linked records a role may not open are hidden', async () => {
  const k = await readyKit();
  try {
    const sup = (await k.post('doc/supplier', { doc: { name: 'Secret Supplier Ltd' } })).body.doc.id;
    const p = (await k.post('doc/product', { doc: { code: 'P1', name: 'Soap', default_supplier: sup } })).body.doc.id;
    const c = await k.post('doc/user', { doc: { name: 'Cashier C', role: 'Cashier' } });
    await k.post('pin', { user: c.body.doc.id, pin: '6666' });
    await k.post('session', { pin: '6666' });
    assert.equal((await k.get('list/supplier')).status, 403);
    assert.equal((await k.get(`doc/product/${p}`)).body.doc._titles.default_supplier, 'Hidden');
    const row = (await k.get('list/product')).body.rows.find((r: any) => r.id === p);
    assert.notEqual(row?._titles?.default_supplier, 'Secret Supplier Ltd');
  } finally { k.done(); }
});
