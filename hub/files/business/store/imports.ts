// Imports on the database (phase 5c, blueprint 04 §7, 02 §6.7):
//  - addTradeTerms: the incoterm and named place a selling or buying document may carry (kept for people, the engine
//    ignores them).
//  - cleanLandedCost: a landed cost from a screen (one cost, or several cost lines with their accounts, over one or
//    several goods arrived, shared by value, by quantity or typed per line) checked and given its final shape.
//  - the import shipment: its checks on save (documents of the right kind, cost lines filled from their cost types,
//    Estimated / Billed, status Received / Costed by itself), the page it shows (goods with their landed cost per unit,
//    what each cost line adds, customs value and import VAT base, duty shared by HS code) and costing it, which posts
//    one landed cost for all its cost lines (a re-costing undoes the earlier one in the same go).
//  - importTemplate: the usual incoterms and import cost types, made once.
import type { LandedCharge, Result, Step } from '../core/contract.ts';
import { getDef } from '../core/meta/index.ts';
import { SPREADS, TREATMENTS } from '../core/meta/imports.ts';
import { runScenario } from '../core/run.ts';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { fail } from './errors.ts';
import type { Data, Errors, Existing } from './docs.ts';
import { loadSingle, loadRow, saveDoc, titlesOf } from './docs.ts';
import { record, text } from './money.ts';
import { addStep, loadSteps, scenarioOf, undoStep } from './steps.ts';

const bad = (message: string): never => fail(422, message);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const r2 = (n: number) => Math.round(n * 100) / 100;
const TREATMENT: Record<string, LandedCharge['treatment']> = { [TREATMENTS[0]]: 'cost', [TREATMENTS[1]]: 'vat', [TREATMENTS[2]]: 'expense', [TREATMENTS[3]]: 'deposit' };
const SPREAD: Record<string, 'amount' | 'qty' | 'manual'> = { [SPREADS[0]]: 'amount', [SPREADS[1]]: 'qty', [SPREADS[2]]: 'manual' };
const WAYS = new Set(['amount', 'qty', 'manual']);
const KINDS = new Set(['cost', 'vat', 'expense', 'deposit']);

const stepRow = (db: DB, id: unknown): Step | null => {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare('SELECT data FROM steps WHERE id = ?').get(id) as { data: string } | undefined;
  return r ? (parse(r.data) as unknown as Step) : null;
};
const undone = (db: DB, id: string): boolean => !!db.prepare("SELECT 1 FROM steps WHERE kind = 'cancel' AND json_extract(data, '$.target') = ?").get(id);
const companyOf = (db: DB): Data => { const r = loadSingle(db, 'company'); return r ? parse(r.data) : {}; };
function dataOf(db: DB, type: string, id: unknown): Data | null {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare('SELECT data FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
}

// ---- trade terms ---------------------------------------------------------------------------------------------

/** Documents that may name an incoterm (ERPNext: quotations, orders, deliveries, sales, purchase documents). */
const TRADE_KINDS = new Set(['quotation', 'sales_order', 'delivery_note', 'sales_invoice', 'supplier_quotation', 'purchase_order', 'purchase_receipt', 'purchase_invoice']);

/** Check the incoterm and named place a screen sent with a document and keep them on it. */
export function addTradeTerms(db: DB, step: Step, input: Data): Step {
  if (!TRADE_KINDS.has(step.kind) || !input || typeof input !== 'object') return step;
  const s = step as Step & { incoterm?: string; namedPlace?: string };
  if (given(input.incoterm)) s.incoterm = record(db, 'incoterm', input.incoterm, 'incoterm').id;
  const place = text(input.named_place, 'Named place', 140);
  if (place) {
    if (!s.incoterm) bad('A named place goes with an incoterm (e.g. FOB Mombasa): choose the incoterm');
    s.namedPlace = place;
  }
  return step;
}

// ---- landed cost from a screen -------------------------------------------------------------------------------

/** One of our accounts a cost line may book to: a leaf, active. */
function leaf(db: DB, id: unknown, what: string): string {
  const a = record(db, 'account', id, what);
  if (a.data.is_group === true) bad(`${a.title} is a group; choose an account under it`);
  return a.id;
}

/** A goods arrived (not a return) or a bill that brought the goods in: what a landed cost may be added to. */
function costable(db: DB, id: unknown): string {
  const s = stepRow(db, id);
  const ok = !!s && ((s.kind === 'purchase_receipt' && !(s as { returnOf?: string }).returnOf)
    || (s.kind === 'purchase_invoice' && s.updateStock === true && !s.receipt));
  if (!ok) bad('Landed cost must be added to "Goods arrived" or to a bill that brought the goods in');
  return String(id);
}

/** POST /steps {kind: 'landed_cost', …}: one cost (amount, distribute) or cost lines (`charges`), on `receipt` or
 *  several `receipts`. A cost line may name its cost type (`charge_type`), which fills in how it is booked, how it is
 *  shared and its accounts; `shares` (typed per line) are {receipt, line (from 0), amount}. */
export function cleanLandedCost(db: DB, input: Data, id: string, date: string, time: string): Step {
  const list = Array.isArray(input.receipts) && input.receipts.length ? (input.receipts as unknown[]) : [input.receipt];
  if (list.length > 50) bad('At most 50 goods arrived on one landed cost');
  const receipts = list.map((r) => costable(db, r));
  if (new Set(receipts).size !== receipts.length) bad('A goods arrived is named twice');
  const receipt = given(input.receipt) ? costable(db, input.receipt) : receipts[0];
  if (!receipts.includes(receipt)) bad(`${receipt} must be one of the goods arrived it covers`);
  const distribute = WAYS.has(String(input.distribute)) ? (String(input.distribute) as 'amount' | 'qty' | 'manual') : 'amount';
  const step: Extract<Step, { kind: 'landed_cost' }> = { id, kind: 'landed_cost', date, time, receipt, amount: 0, distribute };
  if (receipts.length > 1) step.receipts = receipts;
  if (given(input.shipment)) step.shipment = record(db, 'import_shipment', input.shipment, 'import shipment').id;

  if (!Array.isArray(input.charges) || !input.charges.length) {
    // one cost, spread by value or quantity, on the company's freight and landed costs account
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) bad('The landed cost amount must be above 0');
    if (distribute === 'manual') bad('A cost typed per line needs its cost lines');
    step.amount = r2(amount);
    return remarks(step, input);
  }
  if (input.charges.length > 100) bad('At most 100 cost lines');
  const co = companyOf(db);
  step.charges = (input.charges as Data[]).map((c, i) => {
    const what = `Cost line ${i + 1}`;
    if (!c || typeof c !== 'object') bad(`${what} is empty`);
    const type = given(c.charge_type) ? record(db, 'import_charge', c.charge_type, 'import cost type') : null;
    const amount = Number(c.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) bad(`${what}: the amount must be 0 or more`);
    const treatment = (KINDS.has(String(c.treatment)) ? String(c.treatment) : TREATMENT[String(type?.data.treatment ?? '')] ?? 'cost') as NonNullable<LandedCharge['treatment']>;
    const way = WAYS.has(String(c.distribute)) ? String(c.distribute) : SPREAD[String(type?.data.distribute ?? '')] ?? distribute;
    const label = text(c.label, `${what}: description`, 140) ?? type?.title;
    const out: LandedCharge = { amount: r2(amount), ...(treatment !== 'cost' ? { treatment } : {}), ...(label ? { label } : {}) };
    // the account it waits on until the bill (the agent's or TRA's bill books to the same one)
    const credit = given(c.account) ? c.account : type?.data.account;
    if (given(credit)) out.account = leaf(db, credit, `${what}: account`);
    if (treatment === 'cost') {
      out.distribute = way as 'amount' | 'qty' | 'manual';
      if (way === 'manual') {
        if (!Array.isArray(c.shares) || !c.shares.length) bad(`${what} is typed per line: give its amount on each line`);
        out.shares = (c.shares as Data[]).map((s) => {
          const r = String(s?.receipt ?? '');
          const line = Number(s?.line), amt = Number(s?.amount);
          if (!receipts.includes(r)) bad(`${what}: ${r || 'a line'} is not one of the goods arrived of this landed cost`);
          const lines = (stepRow(db, r) as { lines?: unknown[] } | null)?.lines ?? [];
          if (!Number.isInteger(line) || line < 0 || line >= lines.length) bad(`${what}: ${r} has no line ${line + 1}`);
          if (!Number.isFinite(amt) || amt < 0) bad(`${what}: amounts per line must be 0 or more`);
          return { receipt: r, line, amount: r2(amt) };
        });
        const typed = r2(out.shares.reduce((a, s) => a + s.amount, 0));
        if (Math.abs(typed - out.amount) > 0.005) bad(`${what}: the amounts per line (${typed.toLocaleString('en-US')}) must add up to ${out.amount.toLocaleString('en-US')}`);
      }
    } else if (treatment !== 'vat') {
      // an expense to its account (empty: the company's other expenses); a deposit to the asset account it is kept on
      const debit = given(c.debit_account) ? c.debit_account : type?.data.debit_account ?? (treatment === 'expense' ? co.expense_account : undefined);
      if (!given(debit)) bad(`${what} (${label ?? 'deposit'}): choose the asset account the deposit is kept on`);
      out.debitAccount = leaf(db, debit, `${what}: ${treatment === 'deposit' ? 'deposit' : 'expense'} account`);
    }
    return out;
  });
  step.amount = r2(step.charges.filter((c) => !c.treatment).reduce((a, c) => a + c.amount, 0));
  if (!step.charges.some((c) => c.amount > 0)) bad('The landed cost amount must be above 0');
  return remarks(step, input);
}

function remarks<T extends Step>(step: T, input: Data): T {
  const r = text(input.remarks, 'Note');
  return r ? { ...step, remarks: r } : step;
}

// ---- the import shipment record ----------------------------------------------------------------------------

/** The live landed cost that costs a shipment (the newest not undone), if any. */
export function shipmentCost(db: DB, shipment: string): string | null {
  const rows = db.prepare("SELECT id FROM steps WHERE kind = 'landed_cost' AND json_extract(data, '$.shipment') = ? ORDER BY seq DESC").all(shipment) as { id: string }[];
  return rows.find((r) => !undone(db, r.id))?.id ?? null;
}

/** On save (rules.ts): documents of the right kind, cost lines filled from their cost types, Estimated or Billed,
 *  the status Received / Costed by itself. */
export function checkShipment(db: DB, data: Data, prev: Existing | null, errors: Errors): void {
  const docs = (key: string, ok: (s: Step) => boolean, what: string) => {
    ((data[key] ?? []) as Data[]).forEach((r, i) => {
      const s = stepRow(db, r.doc);
      if (!s || !ok(s)) errors[`${key}.${i}.doc`] = `Not ${what}`;
      else if (undone(db, s.id)) errors[`${key}.${i}.doc`] = 'This one was undone';
    });
  };
  docs('orders', (s) => s.kind === 'purchase_order', 'a purchase order');
  docs('receipts', (s) => (s.kind === 'purchase_receipt' && !(s as { returnOf?: string }).returnOf) || (s.kind === 'purchase_invoice' && s.updateStock === true && !s.receipt), 'goods arrived (or a bill that brought the goods in)');
  docs('bills', (s) => s.kind === 'purchase_invoice', 'a supplier bill');
  const costs = (data.costs ?? []) as Data[];
  costs.forEach((c, i) => {
    const type = dataOf(db, 'import_charge', c.charge);
    if (type) {
      if (!given(c.treatment)) c.treatment = type.treatment;
      if (!given(c.distribute)) c.distribute = type.distribute;
    }
    if (given(c.bill)) {
      const b = stepRow(db, c.bill);
      if (!b || b.kind !== 'purchase_invoice') errors[`costs.${i}.bill`] = 'Not a supplier bill';
      else if (undone(db, b.id)) errors[`costs.${i}.bill`] = 'This bill was undone';
    }
    c.status = given(c.bill) ? 'Billed' : 'Estimated';
  });
  ((data.shares ?? []) as Data[]).forEach((s, i) => {
    const c = costs[Number(s.cost) - 1];
    if (!c) errors[`shares.${i}.cost`] = `There is no cost line ${s.cost}`;
    else if (c.distribute !== SPREADS[2]) errors[`shares.${i}.cost`] = `Cost line ${s.cost} is not shared by hand per line`;
    if (!((data.receipts ?? []) as Data[]).some((r) => r.doc === s.receipt)) errors[`shares.${i}.receipt`] = 'Not one of the goods arrived above';
  });
  const live = prev ? shipmentCost(db, prev.id) : null;
  if (live) data.status = 'Costed';
  else if (((data.receipts ?? []) as Data[]).length) data.status = 'Received';
  else if (data.status === 'Received' || data.status === 'Costed') data.status = 'Cleared';
}

/** The landed cost a shipment's cost lines make (what costing it would post), as a screen would send it. */
function costInput(db: DB, ship: Data, id: string, date?: string): Data {
  const receipts = ((ship.receipts ?? []) as Data[]).map((r) => String(r.doc));
  if (!receipts.length) bad('Name the goods arrived first: costs are added to goods that arrived');
  const costs = (ship.costs ?? []) as Data[];
  if (!costs.some((c) => Number(c.amount) > 0)) bad('Add the costs first (duty, freight, clearing…)');
  const shares = (ship.shares ?? []) as Data[];
  const titles = titlesOf(db, costs.map((c) => String(c.charge)));
  return {
    kind: 'landed_cost', receipt: receipts[0], receipts, shipment: id, distribute: 'amount', ...(date ? { date } : {}),
    remarks: `Import shipment ${loadRow(db, 'import_shipment', id)?.name ?? id}`,
    charges: costs.map((c, i) => ({
      charge_type: c.charge, amount: Number(c.amount), label: c.description || titles[String(c.charge)],
      ...(given(c.treatment) ? { treatment: TREATMENT[String(c.treatment)] } : {}),
      ...(given(c.distribute) ? { distribute: SPREAD[String(c.distribute)] } : {}),
      ...(given(c.account) ? { account: c.account } : {}), ...(given(c.debit_account) ? { debit_account: c.debit_account } : {}),
      shares: shares.filter((s) => Number(s.cost) === i + 1).map((s) => ({ receipt: s.receipt, line: Number(s.line) - 1, amount: Number(s.amount) })),
    })),
  };
}

const darToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

/** GET /shipment/:id: everything the shipment page shows, worked out here (the engine's own figures). */
export function shipmentView(db: DB, id: string) {
  const row = loadRow(db, 'import_shipment', id) ?? fail(404, 'Import shipment not found');
  const ship = parse(row.data);
  const steps = loadSteps(db);
  const live = shipmentCost(db, id);
  // the status follows what happened since it was saved (a landed cost posted or undone)
  const want = live ? 'Costed' : ((ship.receipts ?? []) as Data[]).length ? 'Received' : ship.status === 'Received' || ship.status === 'Costed' ? 'Cleared' : ship.status;
  if (want !== ship.status) { ship.status = want; saveDoc(db, getDef('import_shipment')!, { id, status: want }, null); }

  const now = runScenario(scenarioOf(db, steps));
  // what costing it now would give: the landed cost it would post, run with the whole history (the one it has now undone)
  let preview: Result | null = null, problem: string | null = null;
  try {
    const input = costInput(db, ship, id);
    const step = cleanLandedCost(db, input, 'preview', darToday(), '23:59:59');
    const sim: Step[] = [...steps, ...(live ? [{ id: 'preview-undo', kind: 'cancel', date: darToday(), time: '23:59:58', target: live } as Step] : []), step];
    preview = runScenario(scenarioOf(db, sim));
    problem = preview.errors.find((e) => e.step === 'preview' || e.step === 'preview-undo')?.message ?? null;
  } catch (e) { problem = (e as Error).message; }

  const receipts = ((ship.receipts ?? []) as Data[]).map((r) => String(r.doc));
  const items = new Set<string>(), parties = new Set<string>();
  const goods: Data[] = [];
  for (const rid of receipts) {
    const s = stepRow(db, rid) as (Step & { lines?: { item: string; qty: number; rate?: number }[]; supplier?: string }) | null;
    if (!s?.lines) continue;
    if (s.supplier) parties.add(s.supplier);
    s.lines.forEach((l, i) => {
      // goods with the bill: stock in at the line's net (after discounts), as the engine takes it
      const rate = s.kind === 'purchase_invoice' ? (now.landed?.find((x) => x.receipt === rid && x.line === i)?.rate ?? l.rate ?? 0) : l.rate ?? 0;
      if (s.kind === 'purchase_invoice' && dataOf(db, 'product', l.item)?.is_stock === false) return;
      items.add(l.item);
      const p = dataOf(db, 'product', l.item) ?? {};
      const hs = dataOf(db, 'customs_tariff', p.customs_tariff);
      const nowL = now.landed?.find((x) => x.receipt === rid && x.line === i);
      const newL = preview?.landed?.find((x) => x.receipt === rid && x.line === i);
      goods.push({ receipt: rid, line: i, item: l.item, qty: l.qty, rate, amount: r2(l.qty * rate), hs: p.customs_tariff ?? null, hsNumber: hs?.number ?? null,
        dutyRate: hs && Number.isFinite(Number(hs.duty_rate)) ? Number(hs.duty_rate) : null, origin: p.country_of_origin ?? null,
        extraNow: nowL?.extra ?? 0, perUnitNow: nowL?.perUnit ?? rate, extraNew: newL?.extra ?? 0, perUnitNew: newL?.perUnit ?? rate });
    });
  }
  // duty shared by HS code: each line's part of the duty in proportion to its value x its duty rate (04 §7 "duty per
  // HS line"); the screen fills a cost line typed per line with these
  const weight = goods.reduce((a, g) => a + (g.dutyRate ? Number(g.amount) * Number(g.dutyRate) : 0), 0);
  for (const g of goods) g.dutyWeight = weight ? (g.dutyRate ? (Number(g.amount) * Number(g.dutyRate)) / weight : 0) : null;

  // what each cost line adds, from the preview's landed cost (the engine's own split)
  const costs = ((ship.costs ?? []) as Data[]).map((c, i) => ({ line: i + 1, charge: c.charge, description: c.description ?? null, amount: Number(c.amount) || 0,
    treatment: c.treatment ?? null, distribute: c.distribute ?? null, bill: c.bill ?? null, status: c.status ?? 'Estimated' }));
  const sum = (f: (c: (typeof costs)[number]) => boolean) => r2(costs.filter(f).reduce((a, c) => a + c.amount, 0));
  const company = companyOf(db);
  const rate = Number(ship.customs_rate) > 0 ? Number(ship.customs_rate) : null;
  const cif = Number(ship.assessed_cif) > 0 ? Number(ship.assessed_cif) : null;
  const customsValue = cif === null ? null : r2(rate ? cif * rate : cif);
  // import VAT is charged on the customs value plus duty and excise (04 §7 step 3); the rates are kept in Setup
  const dutyLike = sum((c) => /duty|excise/i.test(titlesOf(db, [String(c.charge)])[String(c.charge)] ?? '') && c.treatment === TREATMENTS[0]);
  const vat = (db.prepare("SELECT data FROM docs WHERE type = 'tax' AND deleted = 0 ORDER BY rowid").all() as { data: string }[]).map((r) => parse(r.data))
    .find((d) => d.active !== false && d.type === 'VAT' && d.to_confirm !== true);
  const vatBase = customsValue === null ? null : r2(customsValue + dutyLike);
  const eta = typeof ship.eta === 'string' ? ship.eta : null;
  const docIds = [...receipts, ...((ship.orders ?? []) as Data[]).map((r) => String(r.doc)), ...((ship.bills ?? []) as Data[]).map((r) => String(r.doc)), ...costs.map((c) => String(c.bill ?? '')).filter(Boolean)];
  const docs = docIds.map((d) => {
    const s = stepRow(db, d) as (Step & { supplier?: string }) | null;
    if (s?.supplier) parties.add(s.supplier);
    return { id: d, kind: s?.kind ?? null, date: s?.date ?? null, supplier: s?.supplier ?? null, undone: s ? undone(db, d) : false };
  });
  return {
    shipment: { id, name: row.name, supplier: ship.supplier, status: ship.status, incoterm: ship.incoterm ?? null, named_place: ship.named_place ?? null, eta,
      late: !!eta && eta < darToday() && ['Ordered', 'Shipped', 'At port'].includes(String(ship.status)) },
    goods, costs, docs,
    totals: { goods: r2(goods.reduce((a, g) => a + Number(g.amount), 0)), toGoods: sum((c) => !c.treatment || c.treatment === TREATMENTS[0]), vat: sum((c) => c.treatment === TREATMENTS[1]),
      expense: sum((c) => c.treatment === TREATMENTS[2]), deposit: sum((c) => c.treatment === TREATMENTS[3]), estimated: sum((c) => c.status !== 'Billed'), all: sum(() => true) },
    customs: { rate, cif, value: customsValue, vatBase, vatRate: vat ? Number(vat.rate) : null, vatDue: vatBase !== null && vat ? r2((vatBase * Number(vat.rate)) / 100) : null },
    costed: live, preview: problem ? { ok: false, problem } : { ok: true },
    companyVatRegistered: given(company.vrn),
    titles: titlesOf(db, [...items, ...parties, ship.supplier as string, ...costs.map((c) => String(c.charge)), ...(ship.incoterm ? [ship.incoterm as string] : [])].filter(Boolean)),
  };
}

/** POST /shipment/:id/cost {date?}: post the landed cost for all its cost lines; an earlier one is undone first (in
 *  the same go: if the new one is refused, nothing changes). */
export function costShipment(db: DB, id: string, body: Data, by: string | null, role: string): { step: Step; undone: string | null } {
  return tx(db, () => {
    const row = loadRow(db, 'import_shipment', id) ?? fail(404, 'Import shipment not found');
    const ship = parse(row.data);
    const input = costInput(db, ship, id, given(body?.date) ? String(body.date) : undefined);
    const live = shipmentCost(db, id);
    if (live) undoStep(db, live, by);
    const step = addStep(db, input, by, role);
    saveDoc(db, getDef('import_shipment')!, { id, status: 'Costed' }, by);
    return { step, undone: live };
  });
}

// ---- template -----------------------------------------------------------------------------------------------

const INCOTERMS: [string, string][] = [
  ['EXW', 'Ex Works'], ['FCA', 'Free Carrier'], ['FAS', 'Free Alongside Ship'], ['FOB', 'Free On Board'], ['CFR', 'Cost and Freight'],
  ['CIF', 'Cost, Insurance and Freight'], ['CPT', 'Carriage Paid To'], ['CIP', 'Carriage and Insurance Paid To'], ['DAP', 'Delivered At Place'],
  ['DPU', 'Delivered at Place Unloaded'], ['DDP', 'Delivered Duty Paid'],
];
/** The usual import costs in Tanzania (04 §7): name, how it is booked, how it is shared. Rates are never kept here:
 *  duty, levies and VAT come from the TRA assessment of each shipment. */
const CHARGES: [string, number, number, string][] = [
  ['Import duty', 0, 0, 'By the EAC Common External Tariff rate of each HS code: share it per line when the lines have different rates.'],
  ['Excise duty', 0, 0, ''],
  ['Levies (RDL, CPF and others)', 0, 0, 'Railway Development Levy, Customs Processing Fee and the like; rates change with each Finance Act.'],
  ['Freight', 0, 0, ''], ['Insurance', 0, 0, ''], ['Clearing and forwarding fee', 0, 0, 'The agent’s fee.'],
  ['Port charges (TPA)', 0, 0, ''], ['Storage', 0, 0, ''], ['Transport to our store', 0, 1, ''],
  ['Import VAT', 1, 0, 'Claimed back on the VAT return when the business is registered for VAT; otherwise book it into the cost of the goods.'],
  ['Container deposit', 3, 0, 'Paid to the shipping line and refunded when the empty container is returned.'],
];

/** The usual incoterms and import cost types (and an asset account for deposits), each made once: a business that
 *  deleted them does not get them back. */
export function importTemplate(db: DB, by: string | null): void {
  if (!loadSingle(db, 'company')) return;
  const ever = (type: string) => !!db.prepare('SELECT 1 FROM docs WHERE type = ? LIMIT 1').get(type);
  if (ever('incoterm') && ever('import_charge')) return;
  tx(db, () => {
    if (!ever('incoterm')) for (const [code, name] of INCOTERMS) saveDoc(db, getDef('incoterm')!, { code, name }, by);
    if (ever('import_charge')) return;
    // deposits are kept on an asset account (made under Current Assets when the chart has none numbered 1180)
    let deposit = (db.prepare("SELECT id FROM docs WHERE type = 'account' AND deleted = 0 AND json_extract(data, '$.number') = '1180'").get() as { id: string } | undefined)?.id;
    const current = (db.prepare("SELECT id FROM docs WHERE type = 'account' AND deleted = 0 AND json_extract(data, '$.number') = '1100' AND json_extract(data, '$.is_group') = 1").get() as { id: string } | undefined)?.id;
    if (!deposit && current) deposit = saveDoc(db, getDef('account')!, { number: '1180', name: 'Deposits Paid', parent: current, root_type: 'Asset', is_group: false }, by).id as string;
    for (const [name, t, d, notes] of CHARGES) {
      saveDoc(db, getDef('import_charge')!, { name, treatment: TREATMENTS[t], distribute: SPREADS[d], ...(notes ? { notes } : {}),
        ...(t === 3 && deposit ? { debit_account: deposit } : {}) }, by);
    }
  });
}
