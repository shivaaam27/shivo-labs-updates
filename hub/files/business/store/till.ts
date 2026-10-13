// The till on the database (phase 4c, blueprint 03 §3.4): shifts opened with the money in the drawer and closed with
// a count per payment method (ERPNext POS Opening / Closing Entry, Cashier Closing), and what a till allows on a sale
// or a payment made there (ERPNext POS Profile). A till sale is an ordinary paid sale (posted at once, no merging at
// the close); shifts book nothing, so the engine never sees them.
import type { MoneyLine, ShiftStep, Step } from '../core/contract.ts';
import { invoiceTotals } from '../core/money/taxes.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { TILL_WRITE_OFF, priceFor, record, ruleFor } from './money.ts';

const bad = (message: string): never => fail(422, message);
const MANAGERS = new Set(['owner', 'manager']);
export const SHIFT_KINDS = new Set<string>(['shift_open', 'shift_close']);
const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const r2 = (n: number) => Math.round(n * 100) / 100;
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
type Open = Extract<ShiftStep, { kind: 'shift_open' }>;
type Close = Extract<ShiftStep, { kind: 'shift_close' }>;

/** Live steps of these kinds (not undone), oldest first. */
function live(db: DB, kinds: string[]): Data[] {
  const undone = new Set((db.prepare("SELECT json_extract(data, '$.target') AS t FROM steps WHERE kind = 'cancel'").all() as { t: string }[]).map((r) => r.t));
  return (db.prepare(`SELECT id, data FROM steps WHERE kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY seq`).all(...kinds) as { id: string; data: string }[])
    .filter((r) => !undone.has(r.id)).map((r) => parse(r.data));
}

/** An active till. */
export function tillOf(db: DB, id: unknown): { id: string; data: Data; title: string } {
  const t = record(db, 'till', id, 'till');
  if (t.data.active === false) bad(`${t.title} is switched off`);
  return t;
}

/** The till's payment methods (its list, else every active method). */
function methodsOf(db: DB, t: { data: Data }): string[] {
  const rows = (t.data.methods as Data[] | undefined) ?? [];
  if (rows.length) return rows.map((r) => String(r.method));
  return (db.prepare("SELECT id, data FROM docs WHERE type = 'payment_method' AND deleted = 0").all() as { id: string; data: string }[])
    .filter((r) => parse(r.data).active !== false).map((r) => r.id);
}

function mayUse(t: { data: Data; title: string }, user: string | null, role: string): void {
  const users = ((t.data.users as Data[] | undefined) ?? []).map((r) => String(r.user));
  if (users.length && !(user && users.includes(user)) && !MANAGERS.has(role)) bad(`You are not on the list of people who may sell at ${t.title}`);
}

const titleOf = (db: DB, id: unknown): string => {
  const r = typeof id === 'string' ? db.prepare('SELECT title FROM docs WHERE id = ?').get(id) as { title: string } | undefined : undefined;
  return r?.title ?? String(id ?? '');
};

/** The open shift of a till (opened, not closed, neither undone). */
export function openShift(db: DB, till: string): Open | null {
  const closed = new Set(live(db, ['shift_close']).map((c) => String(c.shift)));
  return (live(db, ['shift_open']).filter((o) => o.till === till && !closed.has(String(o.id))).pop() as Open | undefined) ?? null;
}
function openShiftOfUser(db: DB, user: string): Open | null {
  const closed = new Set(live(db, ['shift_close']).map((c) => String(c.shift)));
  return (live(db, ['shift_open']).filter((o) => o.user === user && !closed.has(String(o.id))).pop() as Open | undefined) ?? null;
}

/** What a shift took, per payment method (opening + sales paid there − change + payments in − payments out) and in
 *  total: sales, grand / net total, VAT, pieces, what customers were left owing, money paid out. */
export function shiftSummary(db: DB, shiftId: string): { expected: { method: string; amount: number }[]; totals: Close['totals'] } {
  const open = live(db, ['shift_open']).find((o) => o.id === shiftId) as Open | undefined;
  if (!open) bad('That shift does not exist (or was undone)');
  const by = new Map<string, number>();
  const add = (m: string | undefined, a: number) => { if (m) by.set(m, r2((by.get(m) ?? 0) + a)); };
  for (const o of open!.opening) add(o.method, o.amount);
  const totals = { sales: 0, grandTotal: 0, netTotal: 0, vat: 0, qty: 0, owed: 0, paidOut: 0 };
  for (const s of live(db, ['sales_invoice', 'payment'])) {
    if (s.shift !== shiftId) continue;
    if (s.kind === 'payment') {
      add(s.method as string, s.direction === 'out' ? -Number(s.amount) : Number(s.amount));
      if (s.direction === 'out') totals.paidOut = r2(totals.paidOut + Number(s.amount));
      continue;
    }
    const lines = (s.lines as MoneyLine[]) ?? [];
    const t = invoiceTotals(lines, s.tax as Parameters<typeof invoiceTotals>[1], true, s.discountAmount as number | undefined);
    const pays = ((s.payments as Data[]) ?? []).filter((p) => Number(p.amount) > 0);
    const paid = pays.reduce((a, p) => a + Number(p.amount), 0);
    const cash = pays.find((p) => p.account === 'cash');
    const change = paid > t.roundedTotal && cash ? r2(paid - t.roundedTotal) : 0;
    for (const p of pays) add(p.method as string, Number(p.amount));
    if (change) add(cash!.method as string, -change);
    totals.sales++;
    totals.grandTotal = r2(totals.grandTotal + t.roundedTotal);
    totals.netTotal = r2(totals.netTotal + t.netTotal);
    totals.vat = r2(totals.vat + t.vat);
    totals.qty = r2(totals.qty + lines.reduce((a, l) => a + l.qty, 0));
    if (!s.writeOff) totals.owed = r2(totals.owed + Math.max(0, t.roundedTotal - paid + change));
  }
  return { expected: [...by].map(([method, amount]) => ({ method, amount })), totals };
}

function amounts(db: DB, input: unknown, allowed: string[], what: string): { method: string; amount: number }[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) bad(`${what}: send a list of payment methods and amounts`);
  const seen = new Set<string>();
  return (input as Data[]).map((r, i) => {
    const m = record(db, 'payment_method', r?.method, `payment method on row ${i + 1}`);
    if (!allowed.includes(m.id)) bad(`${m.title} is not taken at this till`);
    if (seen.has(m.id)) bad(`${m.title} is on two rows`);
    seen.add(m.id);
    const a = Number(r.amount ?? 0);
    if (!Number.isFinite(a) || a < 0) bad(`${what}: ${m.title} must be 0 or more`);
    return { method: m.id, amount: r2(a) };
  });
}

/** Open or close a shift. */
export function cleanShiftStep(db: DB, input: Data, kind: string, id: string, date: string, time: string, by: string | null, role: string): Step {
  if (!by) bad('Switch in with your PIN first');
  if (kind === 'shift_open') {
    const t = tillOf(db, input.till);
    mayUse(t, by, role);
    const there = openShift(db, t.id);
    if (there) bad(`A shift is already open at ${t.title} (${there.id}, ${titleOf(db, there.user)}): close it first`);
    const mine = openShiftOfUser(db, by!);
    if (mine) bad(`You already have a shift open at ${titleOf(db, mine.till)} (${mine.id}): close it first`);
    return { id, kind, date, time, till: t.id, user: by!, opening: amounts(db, input.opening, methodsOf(db, t), 'Opening') };
  }
  // closing: the till's open shift (or the one named); its own cashier or a manager
  const shift = given(input.shift) ? String(input.shift) : given(input.till) ? openShift(db, String(input.till))?.id : undefined;
  if (!shift) bad('No open shift to close');
  const open = live(db, ['shift_open']).find((o) => o.id === shift) as Open | undefined;
  if (!open) bad('That shift does not exist (or was undone)');
  if (live(db, ['shift_close']).some((c) => c.shift === shift)) bad(`Shift ${shift} is already closed`);
  if (open!.user !== by && !MANAGERS.has(role)) bad(`Shift ${shift} is ${titleOf(db, open!.user)}'s; they or a manager close it`);
  const t = record(db, 'till', open!.till, 'till');
  const counted = amounts(db, input.counted, methodsOf(db, t), 'Counted');
  const { expected, totals } = shiftSummary(db, shift!);
  return { id, kind: 'shift_close', date, time, shift: shift!, till: open!.till, user: open!.user, counted, expected, totals };
}

/** A sale or a payment made at a till: who may use it, its open shift, its payment methods; for a sale also its
 *  store, full payment unless credit is allowed, its write-off limit, and fixed prices / discounts when the cashier
 *  may not change them (ERPNext POS Profile). */
export function applyTill(db: DB, step: Step, input: Data, by: string | null, role: string): void {
  if (step.kind !== 'sales_invoice' && step.kind !== 'payment') bad('Only sales and payments are made at a till');
  const t = tillOf(db, input.till);
  mayUse(t, by, role);
  const s = step as Step & { till?: string; shift?: string };
  s.till = t.id;
  if (t.data.needs_shift !== false) {
    const sh = openShift(db, t.id);
    if (!sh) bad(`Open a shift at ${t.title} first`);
    if (sh!.user !== by && !MANAGERS.has(role)) bad(`The open shift at ${t.title} is ${titleOf(db, sh!.user)}'s`);
    s.shift = sh!.id;
  }
  const allowed = methodsOf(db, t);
  if (step.kind === 'payment') {
    const m = record(db, 'payment_method', input.method, 'payment method');
    if (!allowed.includes(m.id)) bad(`${m.title} is not taken at ${t.title}`);
    const row = ((t.data.methods as Data[] | undefined) ?? []).find((r) => r.method === m.id);
    if (step.direction === 'out' && row && row.allow_in_returns === false) bad(`Money is not paid back by ${m.title} at ${t.title}`);
    return;
  }
  for (const p of step.payments ?? []) if (p.method && !allowed.includes(p.method)) bad(`${titleOf(db, p.method)} is not taken at ${t.title}`);
  // what this till sells, and to whom (with the groups under the ones named); products only a manager sells
  const pg = groupsUnder(db, 'product_group', t.data.product_groups), cg = groupsUnder(db, 'customer_group', t.data.customer_groups);
  const cust = record(db, 'customer', step.customer, 'customer');
  if (cg && !cg.has(String(cust.data.group ?? ''))) bad(`${t.title} sells only to customers of ${listOf(db, t.data.customer_groups)}`);
  for (const l of step.lines) {
    const p = record(db, 'product', l.item, 'product');
    if (pg && !pg.has(String(p.data.group ?? ''))) bad(`${p.title} is not sold at ${t.title} (only ${listOf(db, t.data.product_groups)})`);
    if (p.data.needs_manager === true && !MANAGERS.has(role)) bad(`Only a manager may sell ${p.title} at the till`);
  }
  if (step.updateStock && step.warehouse !== t.data.store) bad(`Goods sold at ${t.title} leave ${titleOf(db, t.data.store)}`);
  const tot = invoiceTotals(step.lines, step.tax, true, step.discountAmount);
  const paid = (step.payments ?? []).reduce((a, p) => a + p.amount, 0);
  const left = r2(tot.roundedTotal - paid);
  if (left > 0 && !step.writeOff && t.data.allow_credit !== true) bad(`${t.title} takes full payment: ${left.toLocaleString('en-US')} still to pay`);
  const limit = given(t.data.write_off_limit) ? Number(t.data.write_off_limit) : TILL_WRITE_OFF;
  if (step.writeOff && left > limit && !MANAGERS.has(role)) bad(`Only up to ${limit.toLocaleString('en-US')} can be written off at ${t.title}; ask a manager`);
  const fixedRate = t.data.allow_rate_change === false, fixedDisc = t.data.allow_discount_change === false;
  if (fixedDisc && step.discountAmount) bad(`No discount on the whole sale at ${t.title}`);
  if (!fixedRate && !fixedDisc) return;
  step.lines.forEach((l, i) => {
    if (l.from) return;
    const price = priceFor(db, { item: l.item, party: step.customer, side: 'sell', date: step.date, till: t.id });
    const rule = ruleFor(db, { item: l.item, party: step.customer, qty: l.qty, date: step.date, price_list: price?.price_list, till: t.id });
    const r = rule && !('error' in rule) ? rule : null;
    // the price and discount the till itself gives this line (as the till screen fills them)
    const base = price?.rate;
    const rate = r?.action === 'Fixed price' ? r.value : r?.action === 'Discount amount' && base !== undefined ? Math.max(0, base - r.value) : base;
    const disc = r?.action === 'Discount %' ? r.value : 0;
    const name = titleOf(db, l.item);
    if (fixedRate) {
      if (rate === undefined) bad(`${name} has no price at ${t.title}`);
      if (Math.abs(l.rate - rate!) > 0.005) bad(`Line ${i + 1}: the price of ${name} at ${t.title} is ${rate!.toLocaleString('en-US')}`);
    }
    if (fixedDisc && Math.abs((l.discount ?? 0) - disc) > 1e-9) bad(`Line ${i + 1}: no discount on ${name} at ${t.title}${disc ? ` other than the pricing rule's ${disc} %` : ''}`);
  });
}

/** The groups named in a till's group table and every group under them; null when the table is empty (no limit). */
function groupsUnder(db: DB, type: 'product_group' | 'customer_group', rows: unknown): Set<string> | null {
  const named = ((rows as Data[] | undefined) ?? []).map((r) => String(r.group)).filter(Boolean);
  if (!named.length) return null;
  const all = (db.prepare('SELECT id, data FROM docs WHERE type = ? AND deleted = 0').all(type) as { id: string; data: string }[]).map((r) => ({ id: r.id, parent: parse(r.data).parent }));
  const out = new Set(named);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of all) if (!out.has(g.id) && typeof g.parent === 'string' && out.has(g.parent)) { out.add(g.id); grew = true; }
  }
  return out;
}
const listOf = (db: DB, rows: unknown): string => ((rows as Data[] | undefined) ?? []).map((r) => titleOf(db, r.group)).join(', ');

/** Open shifts (and the asker's own) with what they took so far; the expected amounts are left out for a cashier at
 *  a till that counts blind. */
export function shiftsNow(db: DB, user: string | null, role: string) {
  const closed = new Set(live(db, ['shift_close']).map((c) => String(c.shift)));
  return live(db, ['shift_open']).filter((o) => !closed.has(String(o.id))).map((o) => {
    const t = record(db, 'till', o.till, 'till');
    const s = shiftSummary(db, String(o.id));
    const blind = t.data.hide_expected === true && !MANAGERS.has(role);
    return { ...o, tillTitle: t.title, userTitle: titleOf(db, o.user), mine: o.user === user, totals: s.totals, ...(blind ? {} : { expected: s.expected }) };
  });
}

/** What the till screen needs at the start: the tills this person may use (all their settings), the products with
 *  codes and barcodes (for scanning), and the payment methods. */
export function tillStart(db: DB, user: string | null, role: string) {
  const rows = (type: string) => (db.prepare('SELECT id, title, data FROM docs WHERE type = ? AND deleted = 0 ORDER BY title COLLATE NOCASE').all(type) as { id: string; title: string; data: string }[])
    .map((r) => ({ id: r.id, title: r.title, ...parse(r.data) }) as Data & { id: string; title: string });
  const tills = rows('till').filter((t) => t.active !== false && (MANAGERS.has(role) || !((t.users as Data[] | undefined) ?? []).length || ((t.users as Data[]) ?? []).some((u) => u.user === user)))
    .map((t) => { const pg = groupsUnder(db, 'product_group', t.product_groups); return pg ? { ...t, productGroupsAll: [...pg] } : t; });
  const products = rows('product').filter((p) => p.active !== false && p.can_sell !== false)
    .map((p) => ({ id: p.id, title: p.title, short_name: p.short_name ?? null, code: p.code ?? null, group: p.group ?? null, is_stock: p.is_stock !== false,
      needs_manager: p.needs_manager === true, barcodes: ((p.barcodes as Data[] | undefined) ?? []).map((b) => String(b.barcode)) }));
  const methods = rows('payment_method').filter((m) => m.active !== false).map((m) => ({ id: m.id, title: m.title, type: m.type }));
  return { tills, products, methods };
}
