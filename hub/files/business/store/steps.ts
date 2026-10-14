// Stock movements on the database. Each movement is an engine Step (core/contract.ts) whose item keys are
// product ids and whose warehouse keys are store ids. A new step is kept only if the engine accepts it with
// every earlier step (it is run on the whole history); undo adds a 'cancel' step, so history is never rewritten.
import type { Line, Result, Scenario, Step, ValuationMethod } from '../core/contract.ts';
import { runScenario } from '../core/run.ts';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { loadSingle, nextSeries, saveDoc, titlesOf, writeLog } from './docs.ts';
import { OPENING_ITEM, TILL_WRITE_OFF, cleanMoneyStep, partiesOf } from './money.ts';
import { balanceRule } from './books.ts';
import { MONEY_KINDS } from '../core/money/books.ts';
import { SELL_KINDS } from '../core/sell/orders.ts';
import { cleanSellStep } from './sell.ts';
import { BUY_KINDS } from '../core/buy/orders.ts';
import { buySources, cleanBuyStep } from './buy.ts';
import { invoiceTotals } from '../core/money/taxes.ts';
import { SHIFT_KINDS, applyTill, cleanShiftStep } from './till.ts';
import { TRIP_KINDS, cleanTripStep, undoTripCheck } from './trips.ts';
/** Steps that book nothing (till shifts, delivery trips): kept by the store, never run by the engine. */
const STORE_ONLY = new Set<string>([...SHIFT_KINDS, ...TRIP_KINDS]);
import { addPrintInputs } from './print.ts';
import { addTradeTerms, cleanLandedCost } from './imports.ts';
import { withCurrency } from './fx.ts';   // foreign currency (phase 5b)
import { roundsTotal } from '../core/money/fx.ts';

interface StepRow { seq: number; id: string; kind: string; data: string; created: string; by: string | null }
const MOVING = ['receipt', 'issue', 'transfer', 'count', 'purchase_receipt', 'delivery'] as const;
const NEEDS_RATE = new Set(['receipt', 'purchase_receipt', 'count', 'delivery']);
const KINDS = new Set<string>([...MOVING, 'landed_cost', ...MONEY_KINDS, ...SELL_KINDS, ...BUY_KINDS, ...SHIFT_KINDS, ...TRIP_KINDS]);
export const STEP_LABELS: Record<string, string> = {
  receipt: 'Stock in', issue: 'Damaged or own use', transfer: 'Move stock', count: 'Stock count',
  purchase_receipt: 'Goods arrived', delivery: 'Delivered to customer', landed_cost: 'Landed cost', cancel: 'Undo',
  sales_invoice: 'Sale', purchase_invoice: 'Supplier bill', payment: 'Payment', credit_note: 'Return', money_transfer: 'Money moved', journal: 'Journal',
  quotation: 'Quotation', sales_order: 'Sales order', delivery_note: 'Delivery note', set_status: 'Status change', reconcile: 'Credit matched',
  shift_open: 'Shift opened', shift_close: 'Shift closed', pick_list: 'Pick list', delivery_trip: 'Delivery trip', trip_visit: 'Stop visited',
  material_request: 'Stock request', supplier_quotation: 'Supplier quotation', purchase_order: 'Purchase order', debit_note: 'Debit note',
};
/** A step's label for people (an opening balance is a sale or bill underneath). */
export const stepLabel = (s: Step): string => ('opening' in s && s.opening === true ? 'Opening balance' : s.kind === 'delivery_note' && s.returnOf ? 'Delivery return'
  : s.kind === 'purchase_receipt' && s.returnOf ? 'Goods sent back' : STEP_LABELS[s.kind] ?? s.kind);

const parse = (s: string): Step | null => { try { return JSON.parse(s) as Step; } catch { return null; } };
const docData = (db: DB, type: string, id: string): Data | null => {
  const r = db.prepare('SELECT data FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id) as { data: string } | undefined;
  if (!r) return null;
  try { return JSON.parse(r.data) as Data; } catch { return {}; }
};

export function loadSteps(db: DB): Step[] {
  return (db.prepare('SELECT * FROM steps ORDER BY seq').all() as unknown as StepRow[]).map((r) => parse(r.data)).filter((s): s is Step => !!s);
}

function idsIn(steps: Step[]): { items: Set<string>; stores: Set<string>; parties: Set<string> } {
  const items = new Set<string>(), stores = new Set<string>(), parties = new Set<string>();
  for (const s of steps) {
    if ('lines' in s && Array.isArray(s.lines)) for (const l of s.lines) items.add(l.item);
    if ('warehouse' in s && typeof s.warehouse === 'string') stores.add(s.warehouse);
    if (s.kind === 'transfer') { stores.add(s.from); stores.add(s.to); }
    if (s.kind === 'purchase_receipt' && s.rejectedWarehouse) stores.add(s.rejectedWarehouse);
    if (s.kind === 'material_request' && s.from) stores.add(s.from);
    if ((s.kind === 'purchase_order' || s.kind === 'supplier_quotation' || s.kind === 'purchase_receipt') && s.supplier) parties.add(s.supplier);
    if (s.kind === 'sales_invoice') parties.add(s.customer);
    if (s.kind === 'purchase_invoice') parties.add(s.supplier);
    if (s.kind === 'payment') parties.add(s.party);
    if (s.kind === 'journal') for (const r of s.rows) if (r.party) parties.add(r.party);
    if (s.kind === 'quotation' || s.kind === 'sales_order' || s.kind === 'delivery_note') parties.add(s.customer);
    if (s.kind === 'reconcile') parties.add(s.party);
  }
  items.delete(OPENING_ITEM);
  return { items, stores, parties };
}

/** The engine's scenario for these steps: each product with its own valuation method (services never move stock);
 *  the company's negative-stock rule. */
export function scenarioOf(db: DB, all: Step[], allowNegativeOverride?: boolean): Scenario {
  // shifts book nothing: they and their undo stay out of the engine
  const shiftIds = new Set(all.filter((s) => STORE_ONLY.has(s.kind)).map((s) => s.id));
  const steps = all.filter((s) => !STORE_ONLY.has(s.kind) && !(s.kind === 'cancel' && shiftIds.has(s.target)));
  const { items, stores } = idsIn(steps);
  const company = loadSingle(db, 'company');
  let allowNegative = false;
  try { allowNegative = company ? JSON.parse(company.data).allow_negative_stock === true : false; } catch { /* damaged row: keep the safe rule */ }
  if (allowNegativeOverride !== undefined) allowNegative = allowNegativeOverride;
  let co: Data = {};
  try { co = company ? JSON.parse(company.data) : {}; } catch { /* damaged row */ }
  return {
    id: 'business', title: 'Stored stock movements',
    ...(Number(co.over_delivery) > 0 ? { overDelivery: Number(co.over_delivery) } : {}),
    ...(Number(co.over_billing) > 0 ? { overBilling: Number(co.over_billing) } : {}),
    ...(co.no_sale_below_cost === true ? { noSaleBelowCost: true } : {}),
    ...(co.stock_reservation === true ? { stockReservation: true } : {}),
    ...(co.partial_reservation === false ? { partialReservation: false } : {}),
    ...(Number(co.over_picking) > 0 ? { overPicking: Number(co.over_picking) } : {}),
    ...(co.no_hold_on_return === true ? { noHoldOnReturn: true } : {}),
    // buying rules (phase 5): order needed, goods arrived first, bill refused units, the bill's price re-values goods
    ...(co.po_required === true ? { poRequired: true } : {}),
    ...(co.pr_required === true ? { prRequired: true } : {}),
    ...(co.bill_rejected === true ? { billRejected: true } : {}),
    ...(co.bill_rate_revalues !== false ? { billRateRevalues: true } : {}),
    ...(Number(co.request_allowance) > 0 ? { requestAllowance: Number(co.request_allowance) } : {}),
    items: [
      ...[...items].map((key) => {
        const r = db.prepare('SELECT data FROM docs WHERE id = ?').get(key) as { data: string } | undefined;
        let valuation: ValuationMethod = 'Moving Average', stock = true;
        let d: Data = {};
        try { d = r ? JSON.parse(r.data) : {}; if (d.valuation_method === 'FIFO') valuation = 'FIFO'; if (d.is_stock === false) stock = false; } catch { /* default */ }
        // the product's own buying rules: the least to order, its over-delivery and over-billing allowances
        const own = {
          ...(Number(d.min_order_qty) > 0 ? { minOrderQty: Number(d.min_order_qty) } : {}),
          ...(d.over_delivery !== undefined && d.over_delivery !== null && d.over_delivery !== '' ? { overDelivery: Number(d.over_delivery) || 0 } : {}),
          ...(d.over_billing !== undefined && d.over_billing !== null && d.over_billing !== '' ? { overBilling: Number(d.over_billing) || 0 } : {}),
        };
        return stock ? { key, valuation, ...own } : { key, valuation, stock: false, ...own };
      }),
      { key: OPENING_ITEM, valuation: 'Moving Average' as ValuationMethod, stock: false },
    ],
    warehouses: [...stores],
    allowNegativeStock: allowNegative,
    parties: partiesOf(db, steps),
    steps,
  };
}

/** POST /run without a scenario: stock, ledger and balances from the stored movements, plus titles for every id. */
export function computeStock(db: DB): Result & { titles: Record<string, string> } {
  const steps = loadSteps(db);
  const result = runScenario(scenarioOf(db, steps));
  const { items, stores, parties } = idsIn(steps);
  const titles = titlesOf(db, [...items, ...stores, ...parties]);
  return { ...result, errors: result.errors.map((e) => ({ ...e, message: plain(e.message, titles, null) })), titles };
}

/** What counts against a customer's credit limit now (owed, open orders, deliveries not billed). */
export function owedBy(db: DB, customer: string): number {
  return computeStock(db).credit?.find((c) => c.customer === customer)?.owed ?? 0;
}

/** Engine messages name ids; people need names. */
export function plain(message: string, titles: Record<string, string>, stepDate: string | null): string {
  const t = (id: string): string => titles[id] ?? id;
  const short = /^([\d.]+) units of (.+?) needed in (.+?) on (\d{4}-\d{2}-\d{2}) [\d:]+ \(step .+\)$/.exec(message);
  if (short) return `Not enough ${t(short[2])} in ${t(short[3])}: ${short[1]} short${stepDate && short[4] !== stepDate ? ` (on ${short[4]})` : ''}`;
  let out = message;
  for (const [id, title] of Object.entries(titles)) out = out.split(id).join(title);
  return out;
}

/** Dar es Salaam time (UTC+3, no daylight saving). */
function darNow(): { date: string; time: string } {
  const iso = new Date(Date.now() + 3 * 3600e3).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

const bad = (message: string): never => fail(422, message);

function realDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function activeDoc(db: DB, type: 'product' | 'store', id: unknown, what: string): { id: string; data: Data; title: string } {
  if (typeof id !== 'string' || !id) bad(`Choose the ${what}`);
  const data = docData(db, type, id as string) ?? bad(`That ${what} does not exist (it may have been deleted)`);
  const title = titlesOf(db, [id as string])[id as string] ?? String(id);
  if (data.active === false) bad(`${title} is not active`);
  return { id: id as string, data, title };
}

/** Check a step sent by a screen and give it its final shape (ids, date, time, clean lines). */
function cleanStep(db: DB, input: Data, id: string, role = '', by: string | null = null): Step {
  if (!input || typeof input !== 'object') bad('Send the movement as {step: {...}}');
  const kind = String(input.kind ?? '');
  if (!KINDS.has(kind)) bad(`Unknown kind of stock movement "${kind}"`);
  const stamp = darNow();
  const date = input.date === undefined || input.date === '' ? stamp.date : String(input.date);
  const time = input.time === undefined || input.time === '' ? stamp.time : String(input.time);
  if (!realDate(date)) bad('Date must be a real date like 2026-10-13');
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) bad('Time must be like 14:30:00');

  if (SELL_KINDS.has(kind)) return cleanSellStep(db, input, kind, id, date, time, role);
  if (BUY_KINDS.has(kind)) return cleanBuyStep(db, input, kind, id, date, time, role);
  if (SHIFT_KINDS.has(kind)) return withRemarks(cleanShiftStep(db, input, kind, id, date, time, by, role), input);
  if (TRIP_KINDS.has(kind)) return withRemarks(cleanTripStep(db, input, kind, id, date, time), input);
  if (MONEY_KINDS.has(kind)) {
    const step = cleanMoneyStep(db, input, kind, id, date, time, role);
    // made at a till: its shift, payment methods, prices and write-off limit (store/till.ts)
    if (input.till !== undefined && input.till !== null && input.till !== '') { applyTill(db, step, input, by, role); return step; }
    // the till may write off small change; more needs the owner or a manager (ERPNext: POS Profile write-off limit)
    if (step.kind === 'sales_invoice' && step.writeOff && role !== 'owner' && role !== 'manager') {
      const t = invoiceTotals(step.lines, step.tax, scenarioOf(db, []).rounding !== false, step.discountAmount);
      const paid = (step.payments ?? []).reduce((a, p) => a + p.amount, 0);
      if (t.roundedTotal - paid > TILL_WRITE_OFF) bad(`Only up to ${TILL_WRITE_OFF.toLocaleString('en-US')} can be written off at the till; ask a manager`);
    }
    return step;
  }

  // one cost or several cost lines, over one or several goods arrived (store/imports.ts)
  if (kind === 'landed_cost') return cleanLandedCost(db, input, id, date, time);

  if (!Array.isArray(input.lines) || !input.lines.length) bad('Add at least one product');
  if ((input.lines as unknown[]).length > 500) bad('At most 500 lines in one movement');
  const lines: Line[] = (input.lines as Data[]).map((l, i) => {
    if (!l || typeof l !== 'object') bad(`Line ${i + 1} is empty`);
    const p = activeDoc(db, 'product', l.item, 'product');
    if (p.data.is_stock === false) bad(`${p.title} is not a stock product`);
    const qty = Number(l.qty);
    const zeroOk = kind === 'count';
    if (!Number.isFinite(qty) || qty < 0 || (!zeroOk && qty === 0)) bad(`${p.title}: quantity must be ${zeroOk ? '0 or more' : 'above 0'}`);
    const unit = typeof p.data.stock_unit === 'string' ? docData(db, 'unit', p.data.stock_unit) : null;
    if (unit?.whole_number === true && !Number.isInteger(qty)) bad(`${p.title} is counted in ${titlesOf(db, [p.data.stock_unit as string])[p.data.stock_unit as string]}: whole numbers only`);
    const line: Line = { item: p.id, qty };
    if (NEEDS_RATE.has(kind)) {
      const rate = Number(l.rate);
      if (l.rate === undefined || l.rate === null || l.rate === '' || !Number.isFinite(rate) || rate < 0) {
        bad(`${p.title}: ${kind === 'delivery' ? 'selling price' : 'cost'} needed`);
      }
      line.rate = rate;
    }
    return line;
  });

  if (kind === 'transfer') {
    // a move may fill a stock request between stores (its lines name the request lines)
    buySources(db, 'transfer', input.lines, lines);
    const from = activeDoc(db, 'store', input.from, 'store to move from');
    const to = activeDoc(db, 'store', input.to, 'store to move to');
    if (from.id === to.id) bad('Choose two different stores');
    return withRemarks({ id, kind, date, time, from: from.id, to: to.id, lines }, input);
  }
  const wh = activeDoc(db, 'store', input.warehouse, 'store');
  const step = { id, kind, date, time, warehouse: wh.id, lines } as Step;
  // opening stock: a count on the start day posts against Opening Balances, not Stock Adjustment (referee S12)
  if (kind === 'count' && input.opening === true) (step as Extract<Step, { kind: 'count' }>).opening = true;
  return withRemarks(step, input);
}

/** A note for people on a stock movement (the engine ignores it). */
function withRemarks<T extends Step>(step: T, input: Data): T {
  if (input.remarks === undefined || input.remarks === null || input.remarks === '') return step;
  const r = String(input.remarks).trim();
  if (r.length > 500) bad('Note: at most 500 characters');
  return r ? { ...step, remarks: r } : step;
}

function writeStep(db: DB, step: Step, by: string | null, clientId: string | null): void {
  db.prepare('INSERT INTO steps (id, kind, data, created, by, client_id) VALUES (?, ?, ?, ?, ?, ?)').run(step.id, step.kind, JSON.stringify(step), now(), by, clientId);
  const { items, stores } = idsIn([step]);
  const ins = db.prepare("INSERT INTO links (from_type, from_id, field, to_type, to_id) VALUES ('step', ?, ?, ?, ?)");
  for (const id of items) ins.run(step.id, 'item', 'product', id);
  for (const id of stores) ins.run(step.id, 'warehouse', 'store', id);
  for (const id of idsIn([step]).parties) {
    const t = db.prepare("SELECT type FROM docs WHERE id = ?").get(id) as { type: string } | undefined;
    if (t) ins.run(step.id, 'party', t.type, id);   // a customer or supplier with documents cannot be deleted
  }
  writeLog(db, 'step', step.id, step.kind === 'cancel' ? 'undo' : 'create', by, null, step);
}

/** Run the history plus this step; keep it only if the engine accepts it. A step posted while negative stock is
 *  allowed remembers that (negativeOk), so switching the setting off later never refuses or drops it. */
function postIfAccepted(db: DB, step: Step, by: string | null, clientId: string | null): Step {
  if (scenarioOf(db, []).allowNegativeStock && step.kind !== 'cancel') (step as Step & { negativeOk?: boolean }).negativeOk = true;
  const all = [...loadSteps(db), step];
  const result = runScenario(scenarioOf(db, all));
  const err = result.errors.find((e) => e.step === step.id);
  if (err) {
    const { items, stores, parties } = idsIn(all);
    fail(422, plain(err.message, titlesOf(db, [...items, ...stores, ...parties, ...all.map((s) => s.id)]), step.date));
  }
  // an account marked "Balance must be" may not end up the wrong way (ERPNext, 01 §1.1)
  const rule = balanceRule(db, all, step.id);
  if (rule) fail(422, rule);
  writeStep(db, step, by, clientId);
  return step;
}

/** The screen's id for a movement (optional): letters, digits, '-' and '_', at most 64. */
function clientIdOf(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[\w-]{1,64}$/.test(v)) bad('Bad movement id from the screen');
  return v as string;
}
/** A movement already saved under this screen id (a retry after a timeout): give it back instead of saving it twice. */
function already(db: DB, clientId: string | null): Step | null {
  if (!clientId) return null;
  const r = db.prepare('SELECT data FROM steps WHERE client_id = ?').get(clientId) as { data: string } | undefined;
  return r ? parse(r.data) : null;
}

/** Totals of a sale or bill being typed (nothing is saved): the engine's own VAT rules, so screen and books agree. */
export function previewMoney(db: DB, input: Data) {
  const kind = String(input?.kind ?? '');
  if (kind !== 'sales_invoice' && kind !== 'purchase_invoice') bad('Only sales and bills have a preview');
  const { date, time } = darNow();
  const step = withCurrency(db, cleanMoneyStep(db, { ...input, bill_no: undefined }, kind, 'preview', date, time, 'owner'), input, null) as Extract<Step, { kind: 'sales_invoice' | 'purchase_invoice' }>;
  const t = invoiceTotals(step.lines, step.tax, roundsTotal(step, scenarioOf(db, []).rounding !== false), step.discountAmount);
  const out: Record<string, unknown> = { netTotal: t.netTotal, vat: t.vat, grandTotal: t.grandTotal, roundedTotal: t.roundedTotal, roundingAdjustment: t.roundingAdjustment,
    discount: t.discount, lines: t.lines.map((l) => ({ item: l.item, rate: l.rate, amount: l.amount, net: l.net, vatRate: l.vatRate, vat: l.vat })) };
  // another currency: its rate and the totals in TZS, as the books will have them
  if (step.currency && step.exchangeRate) out.currency = { code: step.currency, rate: step.exchangeRate, roundedTotal: Math.round(t.roundedTotal * step.exchangeRate * 100) / 100 };
  // what this customer owes now and their credit limit, so the screen can warn before saving
  if (step.kind === 'sales_invoice') {
    const steps = loadSteps(db);
    const sc = scenarioOf(db, [...steps, step]);
    const limit = sc.parties?.find((p) => p.key === step.customer)?.creditLimit ?? 0;
    const owed = runScenario(scenarioOf(db, steps)).parties?.find((p) => p.party === step.customer)?.balance ?? 0;
    out.credit = { owed, limit };
  }
  return out;
}

export function addStep(db: DB, input: Data, by: string | null, role = ''): Step {
  const clientId = clientIdOf(input?.client_id);
  // printing (heading, letter head, terms...), trade terms (incoterm) and the currency are checked after the step itself
  return tx(db, () => already(db, clientId) ?? postIfAccepted(db, addTradeTerms(db, addPrintInputs(db, withCurrency(db, cleanStep(db, input, nextSeries(db, 'ST-', 5), role, by), input, saveDoc), input), input), by, clientId));
}

export function undoStep(db: DB, target: unknown, by: string | null, client?: unknown): Step {
  const clientId = clientIdOf(client);
  const again = already(db, clientId);
  if (again) return again;
  if (typeof target !== 'string' || !target) bad('Which movement should be undone?');
  const row = db.prepare('SELECT kind FROM steps WHERE id = ?').get(target as string) as { kind: string } | undefined;
  if (!row) fail(404, 'That movement does not exist');
  if (row!.kind === 'cancel') bad('An undo cannot be undone');
  if (db.prepare("SELECT 1 FROM steps WHERE kind = 'cancel' AND json_extract(data, '$.target') = ?").get(target as string)) fail(409, 'This movement is already undone');
  if (row!.kind === 'shift_open' || row!.kind === 'shift_close') undoShiftCheck(db, row!.kind, target as string);
  if (row!.kind === 'delivery_trip' || row!.kind === 'delivery_note') undoTripCheck(db, row!.kind, target as string);
  return tx(db, () => postIfAccepted(db, { id: nextSeries(db, 'ST-', 5), kind: 'cancel', ...darNow(), target: target as string }, by, clientId));
}

/** A shift can be undone only while nothing hangs on it: an opening with no sales, payments or close on it; a close
 *  (the shift opens again) when its till and cashier have no other shift open. */
function undoShiftCheck(db: DB, kind: string, target: string): void {
  const steps = loadSteps(db);
  const undone = new Set(steps.filter((s) => s.kind === 'cancel').map((s) => (s as { target: string }).target));
  const live = steps.filter((s) => !undone.has(s.id));
  if (kind === 'shift_open') {
    const on = live.find((s) => (s as { shift?: string }).shift === target);
    if (on) fail(422, `${on.id} was made in this shift; undo it first (or close the shift)`);
    return;
  }
  const close = live.find((s) => s.id === target) as Extract<Step, { kind: 'shift_close' }>;
  const closed = new Set(live.filter((s) => s.kind === 'shift_close').map((s) => (s as { shift: string }).shift));
  const other = live.find((s) => s.kind === 'shift_open' && s.id !== close.shift && !closed.has(s.id) && (s.till === close.till || s.user === close.user));
  if (other) fail(422, `Shift ${other.id} is open at that till or for that cashier; close it first`);
}

/** Movements, newest first, with who made them and whether they were undone; titles for every id. */
export function listSteps(db: DB, limit: unknown, offset: unknown) {
  const lim = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 1000);
  const off = Math.max(Math.trunc(Number(offset) || 0), 0);
  const total = (db.prepare('SELECT COUNT(*) AS n FROM steps').get() as { n: number }).n;
  const rows = db.prepare('SELECT * FROM steps ORDER BY seq DESC LIMIT ? OFFSET ?').all(lim, off) as unknown as StepRow[];
  const undoneBy = new Map<string, string>();
  for (const r of db.prepare("SELECT id, json_extract(data, '$.target') AS target FROM steps WHERE kind = 'cancel'").all() as { id: string; target: string }[]) undoneBy.set(r.target, r.id);
  const steps = rows.map((r) => ({ step: parse(r.data), row: r })).filter((x) => x.step);
  const { items, stores, parties } = idsIn(steps.map((x) => x.step!));
  // tills, cashiers and payment methods named by shifts and till sales
  const more: string[] = [];
  for (const { step } of steps) {
    const x = step as unknown as Record<string, unknown>;
    for (const k of ['till', 'user', 'method', 'driver', 'vehicle', 'salesman', 'transporter']) if (typeof x[k] === 'string') more.push(x[k] as string);
    if (Array.isArray(x.stops)) for (const st of x.stops as { customer?: unknown }[]) if (typeof st?.customer === 'string') more.push(st.customer);
    // rows of money per payment method (a shift's opening, count and expected; a sale's payments); `opening` may also
    // be true on an opening balance
    for (const k of ['opening', 'counted', 'expected', 'payments']) {
      if (Array.isArray(x[k])) for (const r of x[k] as { method?: unknown }[]) if (typeof r?.method === 'string') more.push(r.method);
    }
  }
  const titles = titlesOf(db, [...items, ...stores, ...parties, ...steps.map((x) => x.row.by ?? ''), ...more]);
  return {
    total,
    titles,
    steps: steps.map(({ step, row }) => ({
      ...step, label: stepLabel(step!), created: row.created, by: row.by,
      undone: undoneBy.has(row.id), undoneBy: undoneBy.get(row.id) ?? null,
    })),
  };
}
