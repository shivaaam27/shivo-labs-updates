// Printing (phase 4e, ERPNext print settings and print formats for selling documents). Two halves:
//  - addPrintInputs: what a screen may send for the printed page of a quotation, order, delivery note, sale, return,
//    payment or journal (print heading, letter head, terms and their text, language, contact, deliver-to address,
//    "without amounts", "group same items"), checked against the records and kept on the step (core/contract.ts
//    PrintExtra; the engine ignores it). New selling documents get the company's default terms (a till sale the till's).
//  - printView: everything one printed page needs, worked out here so every printed total is the engine's own
//    (invoiceTotals, the run's invoices): the business and its letter head, the customer, lines (grouped if asked),
//    VAT per rate, rounding, the amount in words, payments, change, what is still owed, instalments, terms, footer.
// The pages themselves are drawn by shared/biz/print.js (A4 documents, 58/80 mm till receipts).
import type { MoneyLine, PrintExtra, Step, TaxSpec } from '../core/contract.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { loadSingle, titlesOf } from './docs.ts';
import { OPENING_ITEM, record, text } from './money.ts';
import { computeStock, scenarioOf } from './steps.ts';
import { invoiceTotals } from '../core/money/taxes.ts';
import { amountInWords } from '../core/money/words.ts';
import { tripOf } from './trips.ts';
import type { Language } from '../core/money/words.ts';

const bad = (message: string): never => fail(422, message);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Selling documents (terms, contact, deliver-to, grouping) and the other printed kinds (heading, letter head). */
const SELLING = new Set(['quotation', 'sales_order', 'delivery_note', 'sales_invoice']);
export const PRINTED = new Set([...SELLING, 'credit_note', 'payment', 'journal']);
const LANGUAGES = ['English', 'Swahili'];

function dataOf(db: DB, type: string, id: unknown): Data | null {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare('SELECT data FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
}
const companyOf = (db: DB): Data => { const r = loadSingle(db, 'company'); return r ? parse(r.data) : {}; };
const stepData = (db: DB, id: unknown): Data | null => {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare('SELECT data FROM steps WHERE id = ?').get(id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
};

/** The customer a selling document or return is for (a return: the sale it returns). */
function customerOf(db: DB, step: Step): { id: string; data: Data } | null {
  const s = step as unknown as Data;
  const id = step.kind === 'credit_note' ? stepData(db, s.against)?.customer : s.customer;
  const data = dataOf(db, 'customer', id);
  return data ? { id: String(id), data } : null;
}

/** Terms used without being chosen (the company's or the till's): skipped quietly if gone, switched off or not for selling. */
function defaultTerms(db: DB, id: unknown): { id: string; text: string } | null {
  const t = dataOf(db, 'terms', id);
  return t && t.active !== false && t.selling !== false ? { id: String(id), text: String(t.text ?? '') } : null;
}

/** Check the print inputs of a step from a screen and keep them on it (PrintExtra). */
export function addPrintInputs(db: DB, step: Step, input: Data): Step {
  if (!PRINTED.has(step.kind) || !input || typeof input !== 'object') return step;
  const out = step as Step & PrintExtra;
  if (given(input.print_heading)) out.printHeading = record(db, 'print_heading', input.print_heading, 'print heading').id;
  if (given(input.letter_head)) out.letterHead = record(db, 'letter_head', input.letter_head, 'letter head').id;
  if (step.kind === 'payment' || step.kind === 'journal') return out;

  // the print language: as chosen, else the customer's
  if (given(input.language) && !LANGUAGES.includes(String(input.language))) bad('Print language must be English or Swahili');
  const cust = customerOf(db, step);
  const language = given(input.language) ? String(input.language) : cust?.data.language;
  if (language === 'Swahili' || given(input.language)) out.language = language as Language;
  // opening balances from the old books are not selling documents: no terms, contact or delivery
  if (!SELLING.has(step.kind) || (step as { opening?: boolean }).opening === true) return out;

  // terms: as chosen (or none, when the screen sends an empty choice), else the till's for a till sale, else the company's
  if ('terms' in input || 'terms_text' in input) {
    if (given(input.terms)) {
      // switched off later is fine: an order made from a quotation keeps the quotation's terms
      const t = dataOf(db, 'terms', input.terms) ?? bad('Those terms and conditions do not exist (they may have been deleted)');
      if (t.selling === false) bad(`${titlesOf(db, [String(input.terms)])[String(input.terms)]} is not for selling documents`);
      out.terms = String(input.terms);
      out.termsText = String(t.text ?? '');
    }
    // the text as changed for this document; an empty text prints no terms
    if ('terms_text' in input) {
      const tt = text(input.terms_text, 'Terms and conditions', 5000);
      if (tt) out.termsText = tt; else delete out.termsText;
    }
  } else {
    const t = defaultTerms(db, given(input.till) ? dataOf(db, 'till', input.till)?.terms : companyOf(db).selling_terms);
    if (t) { out.terms = t.id; if (t.text) out.termsText = t.text; }
  }

  // who it is for there, and where the goods go
  const contact = text(input.contact, 'Contact person', 100);
  if (contact) {
    const people = (cust?.data.contacts as Data[] | undefined) ?? [];
    if (!people.some((p) => String(p?.name ?? '').trim() === contact)) bad(`${contact} is not one of this customer's contact people`);
    out.contact = contact;
  }
  const shipTo = text(input.ship_to, 'Deliver to', 500);
  if (shipTo) out.shipTo = shipTo;
  if (step.kind === 'delivery_note' && input.print_without_amount === true) out.printWithoutAmount = true;
  if (input.group_same_items === true) out.groupSameItems = true;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The printed page

interface PrintLine { item: string; name: string; short: string | null; code: string | null; unit: string | null; qty: number; listRate: number; discount: number; rate: number; amount: number; vatRate: number }

/** Everything a printed page of this document needs (GET /print/:id). */
export function printView(db: DB, id: string) {
  const row = db.prepare('SELECT kind, data, by FROM steps WHERE id = ?').get(id) as { kind: string; data: string; by: string | null } | undefined;
  if (!row) fail(404, 'That document does not exist');
  const s = parse(row!.data) as Data & PrintExtra;
  const kind = String(s.kind);
  if (!PRINTED.has(kind)) fail(422, 'This kind of movement has no printed page');
  const co = companyOf(db);
  const undone = !!db.prepare("SELECT 1 FROM steps WHERE kind = 'cancel' AND json_extract(data, '$.target') = ?").get(id);
  const run = computeStock(db);
  const rounding = scenarioOf(db, []).rounding !== false;
  const titleCache: Record<string, string> = { ...run.titles };
  const title = (x: unknown): string => {
    if (typeof x !== 'string' || !x) return '';
    if (!(x in titleCache)) Object.assign(titleCache, titlesOf(db, [x]));
    return titleCache[x] ?? x;
  };
  const till = dataOf(db, 'till', s.till);

  // the party: a customer (selling documents, returns, payments in), a supplier (payments out), or none (journals)
  const against = kind === 'credit_note' ? stepData(db, s.against) : null;
  const partyId = (kind === 'credit_note' ? against?.customer : s.customer ?? s.party) as string | undefined;
  const partyRow = typeof partyId === 'string'
    ? db.prepare("SELECT type, title, data FROM docs WHERE id = ? AND type IN ('customer', 'supplier')").get(partyId) as { type: string; title: string; data: string } | undefined : undefined;
  const pd = partyRow ? parse(partyRow.data) : {};
  const hideTin = co.hide_customer_tin === true;
  const party = partyRow ? {
    id: partyId, type: partyRow.type, name: partyRow.title, phone: pd.phone ?? null, email: pd.email ?? null, address: pd.address ?? null, area: pd.area ?? null,
    tin: hideTin ? null : pd.tin ?? null, vrn: hideTin ? null : pd.vrn ?? null,
  } : null;
  const language: Language = (s.language ?? (pd.language === 'Swahili' ? 'Swahili' : 'English')) as Language;
  const contactRow = s.contact ? ((pd.contacts as Data[] | undefined) ?? []).find((p) => String(p?.name ?? '').trim() === s.contact) : undefined;

  // letter head: the document's, the till's, the company's, else the one marked for every document
  const lhId = [s.letterHead, till?.letter_head, co.letter_head].find((x) => given(x) && dataOf(db, 'letter_head', x)?.active !== false && dataOf(db, 'letter_head', x))
    ?? (db.prepare("SELECT id FROM docs WHERE type = 'letter_head' AND deleted = 0 AND json_extract(data, '$.is_default') = 1 AND COALESCE(json_extract(data, '$.active'), 1) = 1 ORDER BY created LIMIT 1").get() as { id: string } | undefined)?.id;
  const lh = dataOf(db, 'letter_head', lhId);
  const headingId = [s.printHeading, kind === 'sales_invoice' ? till?.print_heading : undefined].find((x) => given(x) && dataOf(db, 'print_heading', x));
  const store = dataOf(db, 'store', s.warehouse ?? till?.store);

  const out: Data = {
    id, kind, undone, language, date: s.date, time: s.time,
    heading: headingId ? title(headingId) : null,
    company: { name: co.name ?? '', legal_name: co.legal_name ?? null, address: co.address ?? null, city: co.city ?? null,
      phone: co.phone ?? null, email: co.email ?? null, tin: co.tin ?? null, vrn: co.vrn ?? null, website: co.website ?? null,
      registration_details: co.registration_details ?? null, sales_contact: co.sales_contact ?? null },
    letterHead: lh ? { name: title(lhId), header: lh.header ?? null, footer: lh.footer ?? null, show_company: lh.show_company !== false } : null,
    party, contact: contactRow ? { name: contactRow.name, role: contactRow.role ?? null, phone: contactRow.phone ?? null, email: contactRow.email ?? null } : null,
    shipTo: s.shipTo ?? null,
    store: store ? { name: title(s.warehouse ?? till?.store), address: store.address ?? null, phone: store.phone ?? null } : null,
    till: till ? { name: title(s.till), paper: till.paper ?? '80 mm' } : null,
    // who sold it, and how a delivery travels: its own driver and vehicle, else its delivery trip's (phase 4d)
    salesman: typeof s.salesman === 'string' ? title(s.salesman) : null,
    transport: (() => {
      if (kind !== 'delivery_note') return null;
      const trip = tripOf(db, id);
      const drv = (s.driver as string | undefined) ?? trip?.driver, veh = (s.vehicle as string | undefined) ?? trip?.vehicle;
      const t = { driver: drv ? title(drv) : null, vehicle: veh ? title(veh) : null, transporter: typeof s.transporter === 'string' ? title(s.transporter) : null,
        waybill: (s.lrNo as string | undefined) ?? null, waybillDate: (s.lrDate as string | undefined) ?? null, trip: trip?.id ?? null };
      return Object.values(t).some(Boolean) ? t : null;
    })(),
    by: row!.by ? title(row!.by) : null,
    remarks: s.remarks ?? null, reference: s.reference ?? null,
    terms: s.termsText ?? null,
    withoutAmount: s.printWithoutAmount === true,
    settings: { vatTable: co.vat_table === true, hideWords: co.hide_words === true, withVat: co.print_with_vat !== false,
      schedule: co.print_schedule !== false, hideCurrency: co.hide_currency === true },
  };

  if (kind === 'payment') {
    const amount = Number(s.amount) || 0;
    out.payment = {
      direction: s.direction, method: s.method ? title(s.method) : null, amount, reference: s.reference ?? null,
      allocations: ((s.allocate as Data[] | undefined) ?? []).map((a) => ({ invoice: a.invoice, amount: a.amount })),
      deductions: ((s.deductions as Data[] | undefined) ?? []).map((d) => ({ account: d.ref ? title(d.ref) : String(d.role), amount: d.amount })),
    };
    out.words = co.hide_words === true ? null : amountInWords(amount, language);
    return out;
  }
  if (kind === 'journal') {
    const rows = ((s.rows as Data[] | undefined) ?? []).map((r) => ({ account: r.account ? title(r.account) : String(r.role), party: r.party ? title(r.party) : null,
      invoice: r.invoice ?? null, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0 }));
    const total = r2(rows.reduce((a, r) => a + r.debit, 0));
    out.rows = rows;
    out.total = total;
    out.words = co.hide_words === true ? null : amountInWords(total, language);
    return out;
  }

  // documents with lines: the engine's totals, lines as printed, VAT per rate
  const lines = ((kind === 'credit_note' ? (s.lines ?? against?.lines) : s.lines) as MoneyLine[] | undefined) ?? [];
  const tax = (kind === 'credit_note' ? against?.tax : s.tax) as TaxSpec | undefined;
  const discount = kind === 'credit_note' ? 0 : Number(s.discountAmount) || 0;
  const full = invoiceTotals(lines, tax, rounding, discount);
  const plain = invoiceTotals(lines, tax, rounding, 0);
  const net = !!tax?.inclusive && co.print_with_vat === false;   // lines printed before VAT
  const official = run.invoices?.find((i) => i.step === id);
  const docRes = run.documents?.find((d) => d.step === id);
  const netTotal = Math.abs(official?.netTotal ?? full.netTotal), vat = Math.abs(official?.vat ?? full.vat);
  const grandTotal = Math.abs(official?.grandTotal ?? full.grandTotal), roundedTotal = Math.abs(official?.roundedTotal ?? full.roundedTotal);

  const products = new Map<string, Data | null>();
  const product = (item: string) => { if (!products.has(item)) products.set(item, dataOf(db, 'product', item)); return products.get(item); };
  let printed: PrintLine[] = plain.lines.map((t, i) => {
    const l = lines[i], p = product(l.item);
    const amount = net ? t.net : t.amount;
    return { item: l.item, name: l.item === OPENING_ITEM ? 'Opening balance' : title(l.item), short: (p?.short_name as string | undefined) || null, code: (p?.code as string | undefined) ?? null,
      unit: p?.stock_unit ? title(p.stock_unit) : null, qty: l.qty, listRate: l.rate, discount: l.discount ?? 0,
      rate: net ? (l.qty ? r2(t.net / l.qty) : 0) : t.rate, amount, vatRate: t.vatRate };
  });
  // the same product at the same price, printed as one line (ERPNext group_same_items)
  if (s.groupSameItems === true) {
    const merged = new Map<string, PrintLine>();
    for (const l of printed) {
      const key = `${l.item} ${l.rate} ${l.discount} ${l.vatRate}`;
      const m = merged.get(key);
      if (m) { m.qty = Math.round((m.qty + l.qty) * 1000) / 1000; m.amount = r2(m.amount + l.amount); } else merged.set(key, { ...l });
    }
    printed = [...merged.values()];
  }
  const linesTotal = r2(printed.reduce((a, l) => a + l.amount, 0));
  // VAT per rate (Accounts Settings show_taxes_as_table_in_print): the cent the VAT row's own rounding leaves goes to the biggest rate
  const byRate = new Map<number, { rate: number; net: number; vat: number }>();
  if (tax) for (const l of full.lines) { const g = byRate.get(l.vatRate) ?? { rate: l.vatRate, net: 0, vat: 0 }; g.net = r2(g.net + l.net); g.vat = r2(g.vat + l.vat); byRate.set(l.vatRate, g); }
  const vatTable = [...byRate.values()].sort((a, b) => b.rate - a.rate);
  const left = r2(vat - vatTable.reduce((a, g) => a + g.vat, 0));
  if (vatTable.length && left) { const big = vatTable.reduce((a, g) => (g.net > a.net ? g : a)); big.vat = r2(big.vat + left); }

  out.lines = printed;
  out.totalQty = Math.round(lines.reduce((a, l) => a + (l.item === OPENING_ITEM ? 0 : l.qty), 0) * 1000) / 1000;
  out.totals = {
    lines: linesTotal, discount: net ? r2(plain.netTotal - full.netTotal) : full.discount, netTotal, vat, grandTotal,
    rounding: r2(roundedTotal - grandTotal), roundedTotal, vatCharged: !!tax && vat > 0, pricesIncludeVat: !!tax?.inclusive, linesBeforeVat: net,
  };
  out.vatTable = vatTable;
  out.words = co.hide_words === true ? null : amountInWords(roundedTotal, language);
  out.status = official?.status ?? docRes?.status ?? null;
  out.from = [...new Set(lines.filter((l) => l.from).map((l) => l.from!.step))];
  out.validTill = s.validTill ?? null;
  out.deliveryDate = s.deliveryDate ?? null;
  out.against = s.against ?? null;
  if (kind === 'sales_invoice') {
    const pays = ((s.payments as Data[] | undefined) ?? []).map((p) => ({ method: p.method ? title(p.method) : String(p.account), amount: Number(p.amount) || 0, reference: p.reference ?? null }));
    const paid = r2(pays.reduce((a, p) => a + p.amount, 0));
    const owed = official ? Math.max(0, r2(official.outstanding)) : 0;
    out.payments = pays;
    out.paid = paid;
    out.change = paid > roundedTotal + 0.004 ? r2(paid - roundedTotal) : 0;
    out.writtenOff = s.writeOff === true && paid < roundedTotal - 0.004 && owed < 0.005 ? r2(roundedTotal - paid) : 0;
    out.owed = owed;
    out.dueDate = owed > 0.004 ? s.dueDate ?? null : null;
    out.opening = s.opening === true;
    // instalments (Accounts Settings show_payment_schedule_in_print): each share of the rounded total, the last takes the cents left
    const sched = (s.schedule as { dueDate: string; portion: number }[] | undefined) ?? [];
    if (sched.length && co.print_schedule !== false) {
      let sum = 0;
      out.schedule = sched.map((x, i) => {
        const amount = i === sched.length - 1 ? r2(roundedTotal - sum) : r2((roundedTotal * x.portion) / 100);
        sum = r2(sum + amount);
        return { dueDate: x.dueDate, portion: x.portion, amount };
      });
    }
  }
  return out;
}
