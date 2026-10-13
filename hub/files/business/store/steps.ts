// Stock movements on the database. Each movement is an engine Step (core/contract.ts) whose item keys are
// product ids and whose warehouse keys are store ids. A new step is kept only if the engine accepts it with
// every earlier step (it is run on the whole history); undo adds a 'cancel' step, so history is never rewritten.
import type { Line, Result, Scenario, Step, ValuationMethod } from '../core/contract.ts';
import { runScenario } from '../core/run.ts';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { loadSingle, nextSeries, titlesOf, writeLog } from './docs.ts';
import { cleanMoneyStep, partiesOf } from './money.ts';
import { MONEY_KINDS } from '../core/money/books.ts';
import { invoiceTotals } from '../core/money/taxes.ts';

interface StepRow { seq: number; id: string; kind: string; data: string; created: string; by: string | null }
const MOVING = ['receipt', 'issue', 'transfer', 'count', 'purchase_receipt', 'delivery'] as const;
const NEEDS_RATE = new Set(['receipt', 'purchase_receipt', 'count', 'delivery']);
const KINDS = new Set<string>([...MOVING, 'landed_cost', ...MONEY_KINDS]);
export const STEP_LABELS: Record<string, string> = {
  receipt: 'Stock in', issue: 'Damaged or own use', transfer: 'Move stock', count: 'Stock count',
  purchase_receipt: 'Goods arrived', delivery: 'Delivered to customer', landed_cost: 'Landed cost', cancel: 'Undo',
  sales_invoice: 'Sale', purchase_invoice: 'Supplier bill', payment: 'Payment', credit_note: 'Return', money_transfer: 'Money moved', journal: 'Journal',
};

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
    if (s.kind === 'sales_invoice') parties.add(s.customer);
    if (s.kind === 'purchase_invoice') parties.add(s.supplier);
    if (s.kind === 'payment') parties.add(s.party);
  }
  return { items, stores, parties };
}

/** The engine's scenario for these steps: each product with its own valuation method; the company's negative-stock rule. */
export function scenarioOf(db: DB, steps: Step[], allowNegativeOverride?: boolean): Scenario {
  const { items, stores } = idsIn(steps);
  const company = loadSingle(db, 'company');
  let allowNegative = false;
  try { allowNegative = company ? JSON.parse(company.data).allow_negative_stock === true : false; } catch { /* damaged row: keep the safe rule */ }
  if (allowNegativeOverride !== undefined) allowNegative = allowNegativeOverride;
  return {
    id: 'business', title: 'Stored stock movements',
    items: [...items].map((key) => {
      const r = db.prepare('SELECT data FROM docs WHERE id = ?').get(key) as { data: string } | undefined;
      let valuation: ValuationMethod = 'Moving Average';
      try { if (r && JSON.parse(r.data).valuation_method === 'FIFO') valuation = 'FIFO'; } catch { /* default */ }
      return { key, valuation };
    }),
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
function cleanStep(db: DB, input: Data, id: string): Step {
  if (!input || typeof input !== 'object') bad('Send the movement as {step: {...}}');
  const kind = String(input.kind ?? '');
  if (!KINDS.has(kind)) bad(`Unknown kind of stock movement "${kind}"`);
  const stamp = darNow();
  const date = input.date === undefined || input.date === '' ? stamp.date : String(input.date);
  const time = input.time === undefined || input.time === '' ? stamp.time : String(input.time);
  if (!realDate(date)) bad('Date must be a real date like 2026-10-13');
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) bad('Time must be like 14:30:00');

  if (MONEY_KINDS.has(kind)) return cleanMoneyStep(db, input, kind, id, date, time);

  if (kind === 'landed_cost') {
    const receipt = String(input.receipt ?? '');
    const target = db.prepare('SELECT kind FROM steps WHERE id = ?').get(receipt) as { kind: string } | undefined;
    if (!target || target.kind !== 'purchase_receipt') bad('Landed cost must be added to a "Goods arrived" movement');
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) bad('The landed cost amount must be above 0');
    const distribute = input.distribute === 'qty' ? 'qty' : 'amount';
    return { id, kind: 'landed_cost', date, time, receipt, amount, distribute };
  }

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
    const from = activeDoc(db, 'store', input.from, 'store to move from');
    const to = activeDoc(db, 'store', input.to, 'store to move to');
    if (from.id === to.id) bad('Choose two different stores');
    return { id, kind, date, time, from: from.id, to: to.id, lines };
  }
  const wh = activeDoc(db, 'store', input.warehouse, 'store');
  return { id, kind, date, time, warehouse: wh.id, lines } as Step;
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
  const step = cleanMoneyStep(db, input, kind, 'preview', date, time) as Extract<Step, { kind: 'sales_invoice' | 'purchase_invoice' }>;
  const t = invoiceTotals(step.lines, step.tax, scenarioOf(db, []).rounding !== false);
  return { netTotal: t.netTotal, vat: t.vat, grandTotal: t.grandTotal, roundedTotal: t.roundedTotal, roundingAdjustment: t.roundingAdjustment,
    lines: t.lines.map((l) => ({ item: l.item, amount: l.amount, net: l.net, vatRate: l.vatRate, vat: l.vat })) };
}

export function addStep(db: DB, input: Data, by: string | null): Step {
  const clientId = clientIdOf(input?.client_id);
  return tx(db, () => already(db, clientId) ?? postIfAccepted(db, cleanStep(db, input, nextSeries(db, 'ST-', 5)), by, clientId));
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
  return tx(db, () => postIfAccepted(db, { id: nextSeries(db, 'ST-', 5), kind: 'cancel', ...darNow(), target: target as string }, by, clientId));
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
  const titles = titlesOf(db, [...items, ...stores, ...parties, ...steps.map((x) => x.row.by ?? '')]);
  return {
    total,
    titles,
    steps: steps.map(({ step, row }) => ({
      ...step, label: STEP_LABELS[step!.kind] ?? step!.kind, created: row.created, by: row.by,
      undone: undoneBy.has(row.id), undoneBy: undoneBy.get(row.id) ?? null,
    })),
  };
}
