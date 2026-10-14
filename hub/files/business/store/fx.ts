// Foreign currency on the database (phase 5b; the engine side is core/money/fx.ts). A customer or supplier kept in
// another currency (its `currency` field) has all its documents in that currency: this file puts the currency and the
// exchange rate on every step that names such a party (the rate typed on the document, else the source document's,
// else the newest exchange rate record on or before the date), checks the rate, and makes sure the books have where to
// put it: a debtors / creditors account in that currency and an Exchange Gain/Loss account (made once when missing,
// so a business set up before phase 5 just works). Exchange rates are records (`currency_exchange`).
import type { Step } from '../core/contract.ts';
import { getDef } from '../core/meta/index.ts';
import type { DocDef } from '../core/meta/index.ts';
import { BASE_CURRENCY } from '../core/money/fx.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data, Errors, Existing } from './docs.ts';
/** Saves a record (docs.ts saveDoc, passed in by store/steps.ts so this file does not import the records layer). */
export type Saver = (db: DB, def: DocDef, input: Data, by: string | null) => Data;

const bad = (message: string): never => fail(422, message);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const dataOf = (db: DB, type: string, id: unknown): Data | null => {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare('SELECT data FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
};
const stepData = (db: DB, id: unknown): Data | null => {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare('SELECT data FROM steps WHERE id = ?').get(id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
};
const company = (db: DB): Data => {
  const r = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
  return r ? parse(r.data) : {};
};
const titleOf = (db: DB, id: string): string => (db.prepare('SELECT title FROM docs WHERE id = ?').get(id) as { title: string } | undefined)?.title ?? id;
const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

/** The currency a customer or supplier is kept in (TZS unless its record says otherwise). */
export function partyCurrency(db: DB, id: unknown): string {
  if (typeof id !== 'string' || !id) return BASE_CURRENCY;
  const r = db.prepare("SELECT data FROM docs WHERE id = ? AND type IN ('customer', 'supplier')").get(id) as { data: string } | undefined;
  const c = r ? parse(r.data).currency : undefined;
  return typeof c === 'string' && c ? c : BASE_CURRENCY;
}

/** TZS for 1 unit of `currency` on `date` for buying or selling: the newest exchange rate record on or before the date
 *  (ERPNext Currency Exchange), unless it is older than the company allows (Accounts Settings stale_days). null: none. */
export function rateFor(db: DB, currency: string, date: string, side: 'buy' | 'sell'): { rate: number; date: string } | null {
  if (currency === BASE_CURRENCY) return { rate: 1, date };
  const rows = (db.prepare("SELECT data FROM docs WHERE type = 'currency_exchange' AND deleted = 0").all() as { data: string }[]).map((r) => parse(r.data))
    .filter((d) => d.from_currency === currency && String(d.date ?? '') <= date && Number(d.rate) > 0
      && (side === 'buy' ? d.for_buying !== false : d.for_selling !== false))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const hit = rows[0];
  if (!hit) return null;
  const days = company(db).rate_days;
  if (given(days) && Number(days) >= 0) {
    const age = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${String(hit.date)}T00:00:00Z`)) / 864e5;
    if (age > Number(days)) return null;
  }
  return { rate: Number(hit.rate), date: String(hit.date) };
}

/** A debtors (customers) or creditors (suppliers) account kept in `currency`: the first active one, made when missing
 *  (next to the company's own debtors / creditors account). Without `save`: only look. */
export function partyAccount(db: DB, type: 'customer' | 'supplier', currency: string, save: Saver | null = null): string | undefined {
  if (currency === BASE_CURRENCY) return undefined;
  const kind = type === 'customer' ? 'Receivable' : 'Payable';
  const rows = db.prepare("SELECT id, data FROM docs WHERE type = 'account' AND deleted = 0 ORDER BY rowid").all() as { id: string; data: string }[];
  const found = rows.find((r) => { const d = parse(r.data); return d.account_type === kind && d.currency === currency && d.active !== false && d.is_group !== true; });
  if (found || !save) return found?.id;
  const co = company(db);
  const home = dataOf(db, 'account', type === 'customer' ? co.receivable_account : co.payable_account);
  const name = `${type === 'customer' ? 'Debtors' : 'Creditors'} ${currency}`;
  const made = save(db, getDef('account')!, { name: uniqueName(db, name), parent: home?.parent ?? null, root_type: type === 'customer' ? 'Asset' : 'Liability',
    account_type: kind, currency, is_group: false, active: true }, null);
  return made.id as string;
}

/** The account exchange differences go to: the company's, else one "used for" exchange gain or loss, else one is made
 *  under the company's expenses (and set on the company). */
function ensureGainLossAccount(db: DB, save: Saver): void {
  const co = company(db);
  if (dataOf(db, 'account', co.exchange_gain_loss_account)) return;
  const rows = db.prepare("SELECT id, data FROM docs WHERE type = 'account' AND deleted = 0 ORDER BY rowid").all() as { id: string; data: string }[];
  if (rows.some((r) => parse(r.data).account_type === 'Exchange Gain/Loss' && parse(r.data).is_group !== true)) return;
  const near = dataOf(db, 'account', co.round_off_account);
  save(db, getDef('account')!, { name: uniqueName(db, 'Exchange Gain/Loss'), parent: near?.parent ?? null, root_type: 'Expense', account_type: 'Exchange Gain/Loss',
    is_group: false, active: true }, null);
}
function uniqueName(db: DB, name: string): string {
  const taken = (n: string) => !!db.prepare("SELECT 1 FROM docs WHERE type = 'account' AND deleted = 0 AND name = ?").get(n);
  let out = name;
  for (let i = 2; taken(out); i++) out = `${name} ${i}`;
  return out;
}

/** For the engine's scenario (store/money.ts partiesOf): a foreign-currency party's currency and account. */
export function partyFx(db: DB, type: 'customer' | 'supplier', data: Data): { currency?: string; account?: string } {
  const c = typeof data.currency === 'string' && data.currency ? data.currency : BASE_CURRENCY;
  if (c === BASE_CURRENCY) return {};
  const account = partyAccount(db, type, c);
  return account ? { currency: c, account } : { currency: c };
}

function rateInput(v: unknown, what: string): number | undefined {
  if (!given(v)) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) bad(`${what} must be above 0`);
  return Math.round(n * 1e6) / 1e6;
}

/** The rate of a document whose lines (or receipt, or returned delivery) come from another document in the same
 *  currency: that document's (ERPNext carries conversion_rate over), except a bill from a purchase order when the
 *  company takes the bill date's rate (Buying Settings use_transaction_date_exchange_rate). */
function sourceRate(db: DB, step: Data, currency: string): number | undefined {
  const ids = [step.receipt, step.returnOf, ...((step.lines as Data[] | undefined) ?? []).map((l) => (l.from as Data | undefined)?.step)].filter((x): x is string => typeof x === 'string' && !!x);
  for (const id of ids) {
    const src = stepData(db, id);
    if (!src || src.currency !== currency || !(Number(src.exchangeRate) > 0)) continue;
    if (step.kind === 'purchase_invoice' && src.kind === 'purchase_order' && company(db).bill_rate_on_bill_date === true) continue;
    return Number(src.exchangeRate);
  }
  return undefined;
}

/** Documents that may be in another currency (the buying documents of phase 5 too, when they exist). */
const IN_CURRENCY = new Set(['sales_invoice', 'purchase_invoice', 'payment', 'credit_note', 'debit_note', 'journal', 'quotation', 'sales_order',
  'delivery_note', 'purchase_receipt', 'purchase_order', 'supplier_quotation', 'landed_cost']);

/** Puts the currency and exchange rate on a cleaned step (store/steps.ts calls it for every kind). TZS documents stay as
 *  they are (and may not carry another currency or a rate). `save` null (a preview): nothing is made in the chart. */
export function withCurrency(db: DB, step: Step, input: Data, save: Saver | null): Step {
  const s = step as Step & Data;
  if (!IN_CURRENCY.has(step.kind)) return step;
  if (step.kind === 'landed_cost') {
    // a cost billed in another currency (freight in USD): booked in TZS at its rate; what was typed is kept for people
    const cur = typeof input.currency === 'string' && input.currency ? input.currency : BASE_CURRENCY;
    if (cur === BASE_CURRENCY) return step;
    const r = rateInput(input.exchange_rate, 'The exchange rate') ?? rateFor(db, cur, step.date, 'buy')?.rate ?? bad(`No exchange rate for ${cur} on ${step.date}: type it, or add it under Money > Exchange rates`);
    // every cost line (and its amounts typed per line) of an import shipment's cost too
    const tzs = (n: number) => Math.round(n * r * 100) / 100;
    const lc = step as Extract<Step, { kind: 'landed_cost' }>;
    const charges = lc.charges?.map((c) => ({ ...c, amount: tzs(c.amount), ...(c.shares ? { shares: c.shares.map((x) => ({ ...x, amount: tzs(x.amount) })) } : {}) }));
    return { ...step, amount: tzs(step.amount), amountInCurrency: step.amount, currency: cur, exchangeRate: r, ...(charges ? { charges } : {}) } as Step;
  }
  if (step.kind === 'journal') return journalRates(db, step, input, save);
  // returns keep the currency of what they return (ERPNext copies it; ours: always)
  if (step.kind === 'credit_note' || (step.kind as string) === 'debit_note') {
    const orig = stepData(db, s.against);
    if (!orig?.currency) return step;
    return { ...step, currency: orig.currency, exchangeRate: rateInput(input.exchange_rate, 'The exchange rate') ?? Number(orig.exchangeRate) } as Step;
  }
  const party = (s.customer ?? s.supplier ?? s.party ?? (step.kind === 'purchase_receipt' ? input.supplier : undefined)) as string | undefined;
  if (!party) return step;
  const cur = partyCurrency(db, party);
  if (given(input.currency) && input.currency !== cur) bad(`${titleOf(db, party)} is kept in ${cur}: the document must be in ${cur}`);
  if (cur === BASE_CURRENCY) {
    if (given(input.exchange_rate) && Number(input.exchange_rate) !== 1) bad('A document in TZS has no exchange rate');
    return step;
  }
  if (given(input.till)) bad(`The till sells in TZS: sell to ${titleOf(db, party)} (kept in ${cur}) on the Sell screen`);
  const type = (db.prepare("SELECT type FROM docs WHERE id = ?").get(party) as { type: 'customer' | 'supplier' }).type;
  const side = type === 'supplier' ? 'buy' : 'sell';
  const rate = rateInput(input.exchange_rate, 'The exchange rate') ?? sourceRate(db, s, cur) ?? rateFor(db, cur, step.date, side)?.rate
    ?? bad(`No exchange rate for ${cur} on ${step.date}: type it on the document, or add it under Money > Exchange rates`);
  if (save) { partyAccount(db, type, cur, save); ensureGainLossAccount(db, save); }
  return { ...step, currency: cur, exchangeRate: rate } as Step;
}

/** A journal row for a party kept in another currency is in that currency at its rate: the rate of the invoice it
 *  settles (ERPNext takes it from the invoice), else the row's own, else the day's rate. */
function journalRates(db: DB, step: Extract<Step, { kind: 'journal' }>, input: Data, save: Saver | null): Step {
  const raw = Array.isArray(input.rows) ? (input.rows as Data[]) : [];
  let foreign = false;
  const rows = step.rows.map((r, i) => {
    if (!r.party || (r.role !== 'receivable' && r.role !== 'payable')) {
      if (given(raw[i]?.exchange_rate) && Number(raw[i].exchange_rate) !== 1) bad(`Row ${i + 1}: only a row for a customer or supplier kept in another currency has an exchange rate`);
      return r;
    }
    const cur = partyCurrency(db, r.party);
    const typed = rateInput(raw[i]?.exchange_rate, `Row ${i + 1}: the exchange rate`);
    if (cur === BASE_CURRENCY) {
      if (typed !== undefined && typed !== 1) bad(`Row ${i + 1}: ${titleOf(db, r.party)} is kept in TZS (no exchange rate)`);
      return r;
    }
    foreign = true;
    const inv = r.invoice ? stepData(db, r.invoice) : null;
    if (inv && Number(inv.exchangeRate) > 0 && typed !== undefined && typed !== Number(inv.exchangeRate)) {
      bad(`Row ${i + 1} settles ${r.invoice}: it takes the invoice's rate (${money(Number(inv.exchangeRate))}); put a difference on a row of its own (exchange gain or loss)`);
    }
    const rate = (inv && Number(inv.exchangeRate) > 0 ? Number(inv.exchangeRate) : undefined) ?? typed ?? rateFor(db, cur, step.date, r.role === 'payable' ? 'buy' : 'sell')?.rate
      ?? bad(`Row ${i + 1}: no exchange rate for ${cur} on ${step.date}; type it`);
    if (save) partyAccount(db, r.role === 'receivable' ? 'customer' : 'supplier', cur, save);
    return { ...r, exchangeRate: rate };
  });
  if (foreign && save) ensureGainLossAccount(db, save);
  return foreign ? { ...step, rows } : step;
}

/** A price found on a list (or the last price paid) in the document's currency: TZS value / the document's rate. */
export function priceInCurrency<T extends { rate: number; price_list: string | null; last?: { step: string } } | null>(db: DB, price: T, q: { currency?: unknown; exchange_rate?: unknown; date?: unknown; side?: unknown }): T {
  if (!price) return price;
  const cur = typeof q.currency === 'string' && q.currency ? q.currency : BASE_CURRENCY;
  const date = typeof q.date === 'string' && q.date ? q.date : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const side = q.side === 'buy' ? 'buy' : 'sell';
  // the currency the price is in: the list's, or the bill it was last paid on
  const from = price.last ? (stepData(db, price.last.step)?.currency as string | undefined) ?? BASE_CURRENCY : String(dataOf(db, 'price_list', price.price_list)?.currency ?? BASE_CURRENCY);
  if (from === cur) return cur === BASE_CURRENCY ? price : { ...price, currency: cur };
  const fromRate = price.last ? Number(stepData(db, price.last.step)?.exchangeRate) || rateFor(db, from, date, side)?.rate : rateFor(db, from, date, side)?.rate;
  const toRate = cur === BASE_CURRENCY ? 1 : Number(q.exchange_rate) > 0 ? Number(q.exchange_rate) : rateFor(db, cur, date, side)?.rate;
  if (!fromRate || !toRate) return null as T;   // no rate to turn it into this currency: the screen asks for a price
  return { ...price, rate: Math.round(((price.rate * fromRate) / toRate) * 100) / 100, currency: cur, priceListCurrency: from, priceListRate: fromRate };
}

/** GET /rate?party=&date=&side=: the currency a party is kept in and the rate a new document would take. */
export function rateQuery(db: DB, q: { party?: unknown; currency?: unknown; date?: unknown; side?: unknown }): { currency: string; rate: number | null; date?: string } {
  const cur = typeof q.currency === 'string' && q.currency ? q.currency : partyCurrency(db, q.party);
  const date = typeof q.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const r = rateFor(db, cur, date, q.side === 'buy' ? 'buy' : 'sell');
  return { currency: cur, rate: r?.rate ?? null, ...(r ? { date: r.date } : {}) };
}

/** Record checks (store/rules.ts): a party's currency is fixed once it has documents; an account in another currency is
 *  a debtors or creditors account; an exchange rate is for buying, selling or both. */
export function currencyRules(db: DB, def: DocDef, data: Data, prev: Existing | null, errors: Errors): void {
  if ((def.type === 'customer' || def.type === 'supplier') && prev && (prev.data.currency ?? BASE_CURRENCY) !== (data.currency ?? BASE_CURRENCY)
    && db.prepare("SELECT 1 FROM links WHERE from_type = 'step' AND to_id = ? LIMIT 1").get(prev.id)) {
    errors.currency = `Cannot change: they already have documents in ${prev.data.currency ?? BASE_CURRENCY}`;
  }
  if (def.type === 'account' && (data.currency ?? BASE_CURRENCY) !== BASE_CURRENCY && data.is_group !== true
    && data.account_type !== 'Receivable' && data.account_type !== 'Payable') {
    errors.currency = 'Only debtors and creditors accounts are kept in another currency (money kept in USD comes later)';
  }
  if (def.type === 'account' && prev && (prev.data.currency ?? BASE_CURRENCY) !== (data.currency ?? BASE_CURRENCY)) {
    const used = (db.prepare("SELECT data FROM steps").all() as { data: string }[]).some((r) => r.data.includes(`"${prev.id}"`));
    if (used) errors.currency = 'Cannot change: it already has entries';
  }
  if (def.type === 'currency_exchange' && data.for_buying === false && data.for_selling === false) errors.for_selling = 'For buying, selling or both';
}
