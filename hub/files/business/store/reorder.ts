// What to reorder and what suppliers charge (phase 5, pos/blueprint/04-buying.md §2.1, §2.2). Worked out live from
// the stock and the open documents (no hidden job, no saved suggestions): ERPNext's reorder job makes stock requests
// every day; ours shows the list and the screen makes the purchase order or stock request with one tap.
import type { DB } from './db.ts';
import type { Data } from './docs.ts';
import { titlesOf } from './docs.ts';
import { computeStock } from './steps.ts';
import { lastPurchase } from './money.ts';

const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const dar = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export interface Suggestion {
  product: string; store: string; type: 'Purchase' | 'Transfer'; supplier: string | null;
  inStock: number; ordered: number; requested: number; reserved: number; projected: number;
  level: number; reorderQty: number; safety: number; qty: number; requiredBy: string;
}

/** Products whose projected stock in a store (in stock + on open purchase orders + asked for on open stock requests
 *  - held for open sales orders, ERPNext Bin projected qty) is at or below the reorder level: order the reorder
 *  quantity, or more to come back up to the level (ERPNext: max(reorder qty, level - projected)); with safety stock,
 *  enough to stay above level + safety. Grouped by the usual supplier for one purchase order each. */
export function reorderSuggestions(db: DB): { suggestions: Suggestion[]; titles: Record<string, string> } {
  const r = computeStock(db);
  const key = (item: string, wh: string) => `${item}|${wh}`;
  const sum = (rows: { item: string; warehouse: string; qty: number }[] | undefined) => {
    const m = new Map<string, number>();
    for (const x of rows ?? []) m.set(key(x.item, x.warehouse), (m.get(key(x.item, x.warehouse)) ?? 0) + x.qty);
    return m;
  };
  const stock = new Map(r.balances.map((b) => [key(b.item, b.warehouse), b.qty]));
  const ordered = sum(r.ordered), requested = sum(r.requested), reserved = sum(r.reserved);
  const out: Suggestion[] = [];
  const today = dar();
  for (const row of db.prepare("SELECT id, data FROM docs WHERE type = 'product' AND deleted = 0").all() as { id: string; data: string }[]) {
    const p = parse(row.data);
    if (p.active === false || p.is_stock === false || !Array.isArray(p.reorder)) continue;
    for (const rule of p.reorder as Data[]) {
      if (typeof rule.store !== 'string') continue;
      const k = key(row.id, rule.store);
      const level = Number(rule.level) || 0, reorderQty = Number(rule.qty) || 0, safety = Number(p.safety_stock) || 0;
      const inStock = stock.get(k) ?? 0, o = ordered.get(k) ?? 0, q = requested.get(k) ?? 0, res = reserved.get(k) ?? 0;
      const projected = Math.round((inStock + o + q - res) * 1000) / 1000;
      if (projected > level) continue;
      const qty = Math.max(reorderQty, level + safety - projected);
      if (!(qty > 0)) continue;
      const type = (given(rule.request_type) ? rule.request_type : p.request_type) === 'Transfer' ? 'Transfer' : 'Purchase';
      out.push({ product: row.id, store: rule.store, type, supplier: typeof p.default_supplier === 'string' && p.default_supplier ? p.default_supplier : null,
        inStock, ordered: o, requested: q, reserved: res, projected, level, reorderQty, safety, qty,
        requiredBy: addDays(today, Math.max(0, Math.trunc(Number(p.lead_time_days) || 0))) });
    }
  }
  out.sort((a, b) => (a.supplier ?? '~').localeCompare(b.supplier ?? '~') || a.store.localeCompare(b.store));
  const ids = out.flatMap((s) => [s.product, s.store, s.supplier ?? '']).filter(Boolean);
  return { suggestions: out, titles: titlesOf(db, ids) };
}

/** Compare supplier prices for one product (04 §2.2, ours instead of request for quotation): per supplier, their
 *  price on a buying list (their own row first), their latest quotation, the last price paid to them, their code for
 *  the product and how long they take. Cheapest first. */
export function comparePrices(db: DB, product: string) {
  const p = parse((db.prepare("SELECT data FROM docs WHERE type = 'product' AND id = ? AND deleted = 0").get(product) as { data: string } | undefined)?.data ?? '{}');
  const today = dar();
  const rows = new Map<string, { supplier: string; code?: string; listPrice?: number; listFrom?: string; leadDays?: number; quoted?: number; quotedOn?: string; quote?: string; validTill?: string; lastPaid?: number; lastOn?: string; usual: boolean }>();
  const row = (s: string) => {
    if (!rows.has(s)) rows.set(s, { supplier: s, usual: p.default_supplier === s });
    return rows.get(s)!;
  };
  for (const x of (p.suppliers as Data[] | undefined) ?? []) if (typeof x.supplier === 'string') { const r = row(x.supplier); if (given(x.code)) r.code = String(x.code); }
  if (typeof p.default_supplier === 'string' && p.default_supplier) row(p.default_supplier);
  for (const d of (db.prepare("SELECT data FROM docs WHERE type = 'item_price' AND deleted = 0").all() as { data: string }[]).map((x) => parse(x.data))) {
    if (d.product !== product || typeof d.supplier !== 'string' || !d.supplier) continue;
    if ((given(d.valid_from) && String(d.valid_from) > today) || (given(d.valid_to) && String(d.valid_to) < today)) continue;
    const r = row(d.supplier);
    if (r.listFrom === undefined || String(d.valid_from ?? '') >= r.listFrom) {
      r.listPrice = Number(d.rate) || 0; r.listFrom = String(d.valid_from ?? '');
      if (given(d.lead_time_days)) r.leadDays = Number(d.lead_time_days);
    }
  }
  const undone = new Set((db.prepare("SELECT json_extract(data, '$.target') AS t FROM steps WHERE kind = 'cancel'").all() as { t: string }[]).map((x) => x.t));
  for (const s of db.prepare("SELECT id, data FROM steps WHERE kind = 'supplier_quotation' ORDER BY seq").all() as { id: string; data: string }[]) {
    if (undone.has(s.id)) continue;
    const d = parse(s.data);
    const l = ((d.lines as Data[]) ?? []).find((x) => x.item === product);
    if (!l) continue;
    const r = row(String(d.supplier));
    const rate = l.discount ? Math.round(Number(l.rate) * (1 - Number(l.discount) / 100) * 100) / 100 : Number(l.rate);
    Object.assign(r, { quoted: rate, quotedOn: String(d.date), quote: s.id, ...(d.validTill ? { validTill: String(d.validTill) } : {}) });
  }
  for (const r of rows.values()) {
    const last = lastPurchase(db, product, r.supplier);
    if (last) { r.lastPaid = last.rate; r.lastOn = last.date; }
  }
  const best = (r: { listPrice?: number; quoted?: number; validTill?: string; lastPaid?: number }) =>
    (r.quoted !== undefined && (!r.validTill || r.validTill >= today) ? r.quoted : undefined) ?? r.listPrice ?? r.lastPaid ?? Infinity;
  const list = [...rows.values()].sort((a, b) => best(a) - best(b));
  return { product, suppliers: list, titles: titlesOf(db, [product, ...list.map((x) => x.supplier)]) };
}
