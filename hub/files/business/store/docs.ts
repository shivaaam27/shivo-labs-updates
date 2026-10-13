// Generic records over the docs / links / log tables (FRAME.md "Storage"). Every master goes through here:
// create, update, get, list, options, search, delete. Validation comes from the definition only
// (required, types, select options, link targets, unique, child rows); per-type extras are in rules.ts.
// SQL safety: every value is a bound parameter; the only text put into SQL is fixed code or '?' placeholders.
import { randomUUID } from 'node:crypto';
import type { DocDef, Field } from '../core/meta/index.ts';
import { DEFS, getDef } from '../core/meta/index.ts';
import { roundMoney, roundQty } from '../core/money.ts';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { HttpError, fail } from './errors.ts';
import { afterDelete, afterSave, beforeDelete, checkRules } from './rules.ts';

export type Data = Record<string, unknown>;
export interface DocRow {
  id: string; type: string; name: string; title: string; data: string; search: string;
  created: string; modified: string; owner: string | null; modified_by: string | null; deleted: number;
}
export interface Existing { id: string; name: string; data: Data }
export type Errors = Record<string, string>;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
export const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
const path = (key: string): string => '$.' + key;
const parse = (s: string): Data => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export function defOrFail(type: string): DocDef {
  return getDef(type) ?? fail(404, `There is no record type "${type}"`);
}

// ---- reading -------------------------------------------------------------------------------------

export function loadRow(db: DB, type: string, id: string): DocRow | undefined {
  return db.prepare('SELECT * FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id) as DocRow | undefined;
}

/** The one record of a single definition (company), if it exists. */
export function loadSingle(db: DB, type: string): DocRow | undefined {
  return db.prepare('SELECT * FROM docs WHERE type = ? AND deleted = 0 ORDER BY created LIMIT 1').get(type) as DocRow | undefined;
}

export function existing(row: DocRow | undefined): Existing | null {
  return row ? { id: row.id, name: row.name, data: parse(row.data) } : null;
}

/** Titles of many records at once: { id: title }. */
export function titlesOf(db: DB, ids: Iterable<string>): Record<string, string> {
  const list = [...new Set([...ids].filter((x) => typeof x === 'string' && x))];
  const out: Record<string, string> = {};
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    const rows = db.prepare(`SELECT id, title FROM docs WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as { id: string; title: string }[];
    for (const r of rows) out[r.id] = r.title;
  }
  return out;
}

/** Link field values of a record, top level and child rows: [{ field: 'units.unit', to, id }]. */
export function linksOf(def: DocDef, data: Data): { field: string; to: string; id: string }[] {
  const out: { field: string; to: string; id: string }[] = [];
  for (const f of def.fields) {
    if (f.type === 'link' && typeof data[f.key] === 'string' && f.to) out.push({ field: f.key, to: f.to, id: data[f.key] as string });
    if (f.type === 'table' && Array.isArray(data[f.key])) {
      const child = getDef(f.of!)!;
      for (const row of data[f.key] as Data[]) {
        for (const cf of child.fields) {
          if (cf.type === 'link' && typeof row[cf.key] === 'string' && cf.to) out.push({ field: `${f.key}.${cf.key}`, to: cf.to, id: row[cf.key] as string });
        }
      }
    }
  }
  return out;
}

/** A record as the screens get it: { id, title, _name (its code, e.g. CUST-00001), ...fields, _titles, _meta }. Child rows carry their own _titles. */
export function present(db: DB, def: DocDef, row: DocRow): Data {
  const data = parse(row.data);
  const titles = titlesOf(db, linksOf(def, data).map((l) => l.id));
  const doc: Data = { ...data, id: row.id, title: row.title, _name: row.name };
  const top: Record<string, string> = {};
  for (const f of def.fields) {
    if (f.type === 'link' && typeof data[f.key] === 'string') top[f.key] = titles[data[f.key] as string] ?? '';
    if (f.type === 'table' && Array.isArray(data[f.key])) {
      const child = getDef(f.of!)!;
      doc[f.key] = (data[f.key] as Data[]).map((r) => {
        const t: Record<string, string> = {};
        for (const cf of child.fields) if (cf.type === 'link' && typeof r[cf.key] === 'string') t[cf.key] = titles[r[cf.key] as string] ?? '';
        return { ...r, _titles: t };
      });
    }
  }
  doc._titles = top;
  doc._meta = { created: row.created, modified: row.modified, owner: row.owner, modified_by: row.modified_by };
  return doc;
}

/** How many records (and stock movements, as 'step') point at this one, per type. */
export function linkCounts(db: DB, id: string): Record<string, number> {
  const rows = db.prepare('SELECT from_type, COUNT(DISTINCT from_id) AS n FROM links WHERE to_id = ? GROUP BY from_type').all(id) as { from_type: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.from_type] = r.n;
  return out;
}

export function getDoc(db: DB, def: DocDef, id: string): { doc: Data; links: Record<string, number> } {
  const row = def.single ? loadSingle(db, def.type) : loadRow(db, def.type, id);
  if (!row) fail(404, `${def.label} not found`);
  return { doc: present(db, def, row!), links: linkCounts(db, row!.id) };
}

// ---- lists, options, search ------------------------------------------------------------------------

export interface ListQuery { q?: string; sort?: string; dir?: string; limit?: number; offset?: number; filters?: Record<string, string> }

const SORT_COLUMNS: Record<string, string> = { title: 'docs.title', name: 'docs.name', modified: 'docs.modified', created: 'docs.created' };

function words(q: string | undefined): string[] {
  return String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}
const likeArg = (w: string): string => '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

/** WHERE parts for quick search words and field filters. Unknown filter fields are refused (400). */
function whereFor(def: DocDef, q: string | undefined, filters: Record<string, string> = {}): { sql: string[]; args: (string | number)[] } {
  const sql = ['docs.type = ?', 'docs.deleted = 0'];
  const args: (string | number)[] = [def.type];
  for (const w of words(q)) { sql.push("docs.search LIKE ? ESCAPE '\\'"); args.push(likeArg(w)); }
  for (const [key, raw] of Object.entries(filters)) {
    const f = def.fields.find((x) => x.key === key);
    if (!f || f.type === 'table') fail(400, `Cannot filter ${def.plural} by "${key}"`);
    const value = String(raw);
    if (f!.type === 'check') {
      // a record saved before this field existed counts as the field's default
      sql.push('IFNULL(json_extract(docs.data, ?), ?) = ?');
      args.push(path(key), f!.default === true ? 1 : 0, /^(1|true|yes)$/i.test(value) ? 1 : 0);
    } else if (value === '') {
      sql.push("IFNULL(json_extract(docs.data, ?), '') = ''");
      args.push(path(key));
    } else if (f!.type === 'number' || f!.type === 'money' || f!.type === 'percent') {
      const n = Number(value);
      if (!Number.isFinite(n)) fail(400, `${f!.label} filter must be a number`);
      sql.push('json_extract(docs.data, ?) = ?');
      args.push(path(key), n);
    } else {
      sql.push('json_extract(docs.data, ?) = ?');
      args.push(path(key), value);
    }
  }
  return { sql, args };
}

export function listDocs(db: DB, def: DocDef, q: ListQuery): { rows: Data[]; total: number } {
  if (def.child) fail(400, `${def.plural} only exist inside another record`);
  const where = whereFor(def, q.q, q.filters);
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 50), 1), 500);
  const offset = Math.max(Math.trunc(Number(q.offset) || 0), 0);
  const sortKey = q.sort || def.list.sort;
  const dir = (q.dir || (q.sort ? 'asc' : def.list.dir) || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  let order: string;
  const orderArgs: string[] = [];
  const sf = def.fields.find((x) => x.key === sortKey);
  if (SORT_COLUMNS[sortKey]) order = SORT_COLUMNS[sortKey];
  else if (sf && sf.type === 'link') { order = '(SELECT t.title FROM docs t WHERE t.id = json_extract(docs.data, ?))'; orderArgs.push(path(sortKey)); }
  else if (sf && sf.type !== 'table') { order = 'json_extract(docs.data, ?)'; orderArgs.push(path(sortKey)); }
  else fail(400, `Cannot sort ${def.plural} by "${sortKey}"`);

  const whereSql = where.sql.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE ${whereSql}`).get(...where.args) as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM docs WHERE ${whereSql} ORDER BY ${order!} COLLATE NOCASE ${dir}, docs.title COLLATE NOCASE, docs.id LIMIT ? OFFSET ?`)
    .all(...where.args, ...orderArgs, limit, offset) as unknown as DocRow[];

  const datas = rows.map((r) => parse(r.data));
  const cols = new Set([...def.list.columns, ...(def.subtitle ? [def.subtitle] : [])]);
  const linkCols = def.fields.filter((f) => f.type === 'link' && cols.has(f.key));
  const titles = titlesOf(db, datas.flatMap((d) => linkCols.map((f) => d[f.key] as string)));
  return {
    total,
    rows: rows.map((r, i) => {
      const d = datas[i];
      const out: Data = { id: r.id, title: r.title, _name: r.name, _modified: r.modified };
      const t: Record<string, string> = {};
      for (const c of cols) {
        if (c in out) continue;
        out[c] = d[c] ?? null;
        if (linkCols.some((f) => f.key === c) && typeof d[c] === 'string') t[c] = titles[d[c] as string] ?? '';
      }
      out.subtitle = def.subtitle ? (t[def.subtitle] ?? (d[def.subtitle] ?? null)) : null;
      out._titles = t;
      return out;
    }),
  };
}

/** Choices for a link field: active, not deleted, matching the field's filter. Max 20. */
export function optionsFor(db: DB, def: DocDef, q: string | undefined, filters: Record<string, string> = {}): { id: string; title: string; subtitle: string | null }[] {
  if (def.child) fail(400, `${def.plural} only exist inside another record`);
  const f = { ...filters };
  if (def.fields.some((x) => x.key === 'active') && !hasOwn(f, 'active')) f.active = '1';
  const where = whereFor(def, q, f);
  const rows = db.prepare(`SELECT * FROM docs WHERE ${where.sql.join(' AND ')} ORDER BY docs.title COLLATE NOCASE, docs.id LIMIT 20`).all(...where.args) as unknown as DocRow[];
  const sub = def.subtitle ? def.fields.find((x) => x.key === def.subtitle) : undefined;
  const datas = rows.map((r) => parse(r.data));
  const titles = sub?.type === 'link' ? titlesOf(db, datas.map((d) => d[sub.key] as string)) : {};
  return rows.map((r, i) => {
    const v = sub ? datas[i][sub.key] : undefined;
    const subtitle = v === undefined || v === null ? null : sub!.type === 'link' ? titles[v as string] ?? null : sub!.type === 'percent' ? `${v} %` : String(v);
    return { id: r.id, title: r.title, subtitle };
  });
}

/** Ctrl+K: records of every type the user may read, and actions (open a list, start a new record). */
export function searchAll(db: DB, defs: DocDef[], q: string, canWrite: (d: DocDef) => boolean): Data[] {
  const ws = words(q);
  const out: Data[] = [];
  const readable = defs.filter((d) => !d.child);
  for (const d of readable) {
    // actions match by the start of a word ("pri" finds Prices, "rice" does not)
    const hay = `${d.label} ${d.plural}`.toLowerCase().split(/[^a-z0-9]+/);
    if (!ws.length || !ws.every((w) => hay.some((h) => h.startsWith(w)))) continue;
    out.push({ kind: 'action', action: 'list', type: d.type, title: d.single ? d.label : d.plural, subtitle: 'Open' });
    if (!d.single && canWrite(d)) out.push({ kind: 'action', action: 'new', type: d.type, title: `New ${d.label.toLowerCase()}`, subtitle: 'Create' });
  }
  if (!ws.length || !readable.length) return out;
  const sql = [`docs.type IN (${readable.map(() => '?').join(',')})`, 'docs.deleted = 0'];
  const args: string[] = readable.map((d) => d.type);
  for (const w of ws) { sql.push("docs.search LIKE ? ESCAPE '\\'"); args.push(likeArg(w)); }
  const rows = db.prepare(`SELECT id, type, title, name FROM docs WHERE ${sql.join(' AND ')} ORDER BY docs.title COLLATE NOCASE, docs.id LIMIT 25`).all(...args) as { id: string; type: string; title: string; name: string }[];
  for (const r of rows) {
    const d = getDef(r.type)!;
    out.push({ kind: 'record', type: r.type, id: r.id, title: r.title, subtitle: `${d.label}${r.name && r.name !== r.title ? ' · ' + r.name : ''}` });
  }
  return out;
}

// ---- validation --------------------------------------------------------------------------------

/** Find a record by id, else by its name, else by its title (case-insensitive). */
export function resolveLink(db: DB, to: string, value: string): { row?: DocRow; error?: string } {
  const v = value.trim();
  const byId = loadRow(db, to, v);
  if (byId) return { row: byId };
  for (const col of ['name', 'title']) {
    const rows = db.prepare(`SELECT * FROM docs WHERE type = ? AND deleted = 0 AND ${col} = ? COLLATE NOCASE LIMIT 2`).all(to, v) as unknown as DocRow[];
    if (rows.length === 1) return { row: rows[0] };
    if (rows.length > 1) return { error: `More than one ${getDef(to)?.label.toLowerCase() ?? to} is called "${v}"` };
  }
  return { error: `No ${getDef(to)?.label.toLowerCase() ?? to} called "${v}"` };
}

function matchesFilter(def: DocDef, data: Data, filter: Record<string, string | number | boolean>): boolean {
  return Object.entries(filter).every(([k, want]) => {
    const fallback = def.fields.find((f) => f.key === k)?.default ?? false;
    return typeof want === 'boolean' ? Boolean(data[k] ?? fallback) === want : String(data[k] ?? '') === String(want);
  });
}

const CHECK_TRUE = /^(1|true|yes|y|on|ndiyo)$/i;
const CHECK_FALSE = /^(0|false|no|n|off|hapana)$/i;
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TZ = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/;

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

interface Ctx { db: DB; def: DocDef; self: string | null; old: Data }
type Clean = { v: unknown } | { e: string };

/** Turn one raw value into the stored value for its field, or an error message. Blank → null. */
function clean(ctx: Ctx, f: Field, raw: unknown, oldValue: unknown): Clean {
  if (f.type === 'check') {
    if (raw === undefined || raw === null || raw === '') return { v: false };
    if (typeof raw === 'boolean') return { v: raw };
    if (typeof raw === 'number') return { v: raw !== 0 };
    const s = String(raw).trim();
    if (CHECK_TRUE.test(s)) return { v: true };
    if (CHECK_FALSE.test(s)) return { v: false };
    return { e: 'Must be yes or no' };
  }
  if (f.type === 'table') return { e: 'internal: tables are cleaned separately' };
  if (isBlank(raw)) return { v: null };
  if (typeof raw === 'object') return { e: 'Must be a single value' };
  const s = String(raw).trim();

  switch (f.type) {
    case 'text': case 'longtext': {
      const max = f.type === 'text' ? 140 : 5000;
      if (s.length > max) return { e: `At most ${max} characters` };
      return { v: f.type === 'text' ? s.replace(/\s+/g, ' ') : s };
    }
    case 'number': case 'money': case 'percent': {
      const n = typeof raw === 'number' ? raw : Number(s.replace(/[,\s]/g, '').replace(/%$/, ''));
      if (!Number.isFinite(n)) return { e: 'Must be a number' };
      if (f.integer && !Number.isInteger(n)) return { e: 'Must be a whole number' };
      const min = f.min ?? (f.type === 'percent' ? 0 : undefined);
      const max = f.max ?? (f.type === 'percent' ? 100 : undefined);
      if (min !== undefined && n < min) return { e: `Must be at least ${min}` };
      if (max !== undefined && n > max) return { e: `Must be at most ${max}` };
      return { v: f.type === 'money' ? roundMoney(n) : roundQty(n) };
    }
    case 'select': {
      const opt = (f.options ?? []).find((o) => o.toLowerCase() === s.toLowerCase());
      return opt === undefined ? { e: `Choose one of: ${(f.options ?? []).filter(Boolean).join(', ')}` } : { v: opt || null };
    }
    case 'date': {
      let m = DATE_ISO.exec(s);
      let y: number, mo: number, d: number;
      if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else if ((m = DATE_TZ.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
      else return { e: 'Date like 2026-10-13 or 13/10/2026' };
      if (!validDate(y, mo, d)) return { e: 'Not a real date' };
      return { v: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
    }
    case 'phone': {
      const p = s.replace(/[\s\-().]/g, '');
      if (/^0\d{9}$/.test(p)) return { v: '+255' + p.slice(1) };
      if (/^255\d{9}$/.test(p)) return { v: '+' + p };
      if (/^\+\d{8,15}$/.test(p)) return { v: p };
      return { e: 'Phone like 0712 345 678 or +255 712 345 678' };
    }
    case 'email': {
      const e = s.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? { v: e } : { e: 'Not an email address' };
    }
    case 'tin': {
      const digits = s.replace(/[\s-]/g, '');
      if (!/^\d{9}$/.test(digits)) return { e: 'TIN has 9 digits, e.g. 123-456-789' };
      return { v: `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` };
    }
    case 'link': {
      const r = resolveLink(ctx.db, f.to!, s);
      if (!r.row) return { e: r.error! };
      const target = parse(r.row.data);
      const changed = r.row.id !== oldValue;
      const toDef = getDef(f.to!)!;
      if (f.filter && !matchesFilter(toDef, target, f.filter)) return { e: `${r.row.title} cannot be used here` };
      if (changed && toDef.fields.some((x) => x.key === 'active') && target.active === false) return { e: `${r.row.title} is not active` };
      if (f.to === ctx.def.type && ctx.self) {
        // A record cannot sit under itself, directly or through others (account and group trees).
        let cur: string | undefined = r.row.id;
        for (let i = 0; cur && i < 200; i++) {
          if (cur === ctx.self) return { e: 'This would put it under itself' };
          const up = loadRow(ctx.db, f.to!, cur);
          const next: unknown = up ? parse(up.data)[f.key] : undefined;
          cur = typeof next === 'string' ? next : undefined;
        }
      }
      return { v: r.row.id };
    }
  }
  return { e: 'Unknown field type' };
}

/** Is this value already used by another record? (unique fields; case-insensitive) */
function takenBy(db: DB, def: DocDef, f: Field, value: unknown, self: string | null): string | null {
  const row = db.prepare('SELECT title FROM docs WHERE type = ? AND deleted = 0 AND id <> ? AND json_extract(data, ?) = ? COLLATE NOCASE LIMIT 1')
    .get(def.type, self ?? '', path(f.key), value as string | number) as { title: string } | undefined;
  return row ? row.title : null;
}

/** A child field marked unique: true, used in another record's table? */
function childTakenBy(db: DB, def: DocDef, table: string, f: Field, value: unknown, self: string | null): string | null {
  const row = db.prepare(`SELECT d.title FROM docs d, json_each(d.data, ?) j
      WHERE d.type = ? AND d.deleted = 0 AND d.id <> ? AND json_extract(j.value, ?) = ? COLLATE NOCASE LIMIT 1`)
    .get(path(table), def.type, self ?? '', path(f.key), value as string | number) as { title: string } | undefined;
  return row ? row.title : null;
}

export function hasStock(db: DB, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM links WHERE from_type = 'step' AND to_id = ? LIMIT 1").get(id);
}

/** Check a record against its definition. `input` may be partial on update: missing fields keep their old value. */
export function validateDoc(db: DB, def: DocDef, input: Data, prev: Existing | null): { data: Data; errors: Errors } {
  const errors: Errors = {};
  const data: Data = {};
  const old = prev?.data ?? {};
  const ctx: Ctx = { db, def, self: prev?.id ?? null, old };
  const namingField = def.naming.by === 'field' && !def.single && !def.child ? def.naming.field : null;

  for (const f of def.fields) {
    let raw: unknown;
    if (f.readOnly) raw = prev ? old[f.key] : undefined;
    else raw = hasOwn(input, f.key) ? input[f.key] : prev ? old[f.key] : undefined;
    if (isBlank(raw) && f.default !== undefined && (!prev || f.readOnly)) raw = f.default;

    if (f.type === 'table') {
      const rows = cleanTable(ctx, f, raw, old[f.key], errors);
      if (rows.length) data[f.key] = rows;
      if (f.required && !rows.length && !errors[f.key]) errors[f.key] = 'Add at least one row';
      continue;
    }
    const r = clean(ctx, f, raw, old[f.key]);
    if ('e' in r) { errors[f.key] = r.e; continue; }
    if (r.v === null) {
      if (f.required) errors[f.key] = 'Required';
      continue;
    }
    data[f.key] = r.v;
    if ((f.unique === true || f.key === namingField) && !def.single) {
      const who = takenBy(db, def, f, r.v, ctx.self);
      if (who) errors[f.key] = `Already used by ${who}`;
    }
    if (f.lockOnStock && prev && JSON.stringify(old[f.key] ?? null) !== JSON.stringify(r.v) && hasStock(db, prev.id)) {
      errors[f.key] = `Cannot change: this ${def.label.toLowerCase()} already has stock movements`;
    }
  }
  checkRules(db, def, data, prev, errors);
  return { data, errors };
}

function cleanTable(ctx: Ctx, f: Field, raw: unknown, oldRows: unknown, errors: Errors): Data[] {
  if (isBlank(raw)) return [];
  if (!Array.isArray(raw)) { errors[f.key] = 'Must be a list of rows'; return []; }
  if (raw.length > 500) { errors[f.key] = 'At most 500 rows'; return []; }
  const child = getDef(f.of!)!;
  const oldList = Array.isArray(oldRows) ? (oldRows as Data[]) : [];
  const out: Data[] = [];
  const seen = new Map<string, Map<string, number>>();
  raw.forEach((rowIn, i) => {
    if (!rowIn || typeof rowIn !== 'object' || Array.isArray(rowIn)) { errors[`${f.key}.${i}`] = 'Bad row'; return; }
    const rowData = rowIn as Data;
    // a row with nothing filled in is dropped (the screens add an empty row to type into)
    if (child.fields.every((cf) => isBlank(rowData[cf.key]))) return;
    const row: Data = {};
    for (const cf of child.fields) {
      let v = rowData[cf.key];
      if (isBlank(v) && cf.default !== undefined) v = cf.default;
      // a link already in the old table is not refused for being inactive now
      const was = cf.type === 'link' && oldList.some((o) => o[cf.key] === v) ? v : undefined;
      const r = clean({ ...ctx, def: child, self: null }, cf, v, was);
      const at = `${f.key}.${i}.${cf.key}`;
      if ('e' in r) { errors[at] = r.e; continue; }
      if (r.v === null) { if (cf.required) errors[at] = 'Required'; continue; }
      row[cf.key] = r.v;
      if (cf.unique) {
        const key = String(r.v).toLowerCase();
        const m = seen.get(cf.key) ?? new Map<string, number>();
        seen.set(cf.key, m);
        if (m.has(key)) errors[at] = `Same as row ${m.get(key)! + 1}`;
        else m.set(key, i);
        if (cf.unique === true && !errors[at]) {
          const who = childTakenBy(ctx.db, ctx.def, f.key, cf, r.v, ctx.self);
          if (who) errors[at] = `Already used by ${who}`;
        }
      }
    }
    out.push(row);
  });
  return out;
}

// ---- saving ----------------------------------------------------------------------------------------

function nextName(db: DB, def: DocDef): string {
  if (def.naming.by !== 'series') return '';
  const { prefix, digits } = def.naming;
  db.prepare('INSERT INTO series (prefix, current) VALUES (?, 0) ON CONFLICT(prefix) DO NOTHING').run(prefix);
  for (;;) {
    const { current } = db.prepare('UPDATE series SET current = current + 1 WHERE prefix = ? RETURNING current').get(prefix) as { current: number };
    const name = prefix + String(current).padStart(digits, '0');
    if (!db.prepare('SELECT 1 FROM docs WHERE type = ? AND name = ?').get(def.type, name)) return name;
  }
}

/** Next number in a series that is not a record (stock movements: ST-00001). */
export function nextSeries(db: DB, prefix: string, digits: number): string {
  db.prepare('INSERT INTO series (prefix, current) VALUES (?, 0) ON CONFLICT(prefix) DO NOTHING').run(prefix);
  const { current } = db.prepare('UPDATE series SET current = current + 1 WHERE prefix = ? RETURNING current').get(prefix) as { current: number };
  return prefix + String(current).padStart(digits, '0');
}

function titleFor(db: DB, def: DocDef, data: Data, name: string): string {
  const tf = def.fields.find((f) => f.key === def.title);
  const v = data[def.title];
  if (tf?.type === 'link' && typeof v === 'string') return titlesOf(db, [v])[v] ?? name;
  return v === undefined || v === null || v === '' ? name : String(v);
}

function searchFor(def: DocDef, data: Data, name: string, title: string): string {
  const parts = [name, title];
  for (const f of def.fields) {
    if (f.search && f.type !== 'link' && !isBlank(data[f.key])) parts.push(String(data[f.key]));
    if (f.type === 'table' && Array.isArray(data[f.key])) {
      const child = getDef(f.of!)!;
      for (const row of data[f.key] as Data[]) for (const cf of child.fields) if (cf.search && !isBlank(row[cf.key])) parts.push(String(row[cf.key]));
    }
    // phone numbers are also findable as typed locally (0712…)
    if (f.type === 'phone' && typeof data[f.key] === 'string' && (data[f.key] as string).startsWith('+255')) parts.push('0' + (data[f.key] as string).slice(4));
  }
  return parts.join(' ').toLowerCase();
}

function writeLinks(db: DB, def: DocDef, id: string, data: Data): void {
  db.prepare('DELETE FROM links WHERE from_type = ? AND from_id = ?').run(def.type, id);
  const ins = db.prepare('INSERT INTO links (from_type, from_id, field, to_type, to_id) VALUES (?, ?, ?, ?, ?)');
  const done = new Set<string>();
  for (const l of linksOf(def, data)) {
    const k = `${l.field}\u0000${l.id}`;
    if (done.has(k) || l.id === id) continue;
    done.add(k);
    ins.run(def.type, id, l.field, l.to, l.id);
  }
}

export function writeLog(db: DB, type: string, docId: string, action: string, by: string | null, before: unknown, after: unknown): void {
  db.prepare('INSERT INTO log (type, doc_id, action, by, at, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(type, docId, action, by, now(), before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after));
}

/** Create (no id) or update (id present) a record. Throws 422 { errors } when the definition says no. */
export function saveDoc(db: DB, def: DocDef, input: Data, by: string | null): Data {
  if (def.child) fail(400, `${def.plural} are saved inside their parent record`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Send the record as {doc: {...}}');
  const id0 = typeof input.id === 'string' && input.id ? input.id : null;
  const row = def.single ? loadSingle(db, def.type) : id0 ? loadRow(db, def.type, id0) : undefined;
  if (id0 && !row && !def.single) fail(404, `${def.label} not found (it may have been deleted)`);
  const prev = existing(row);
  // someone else saved it after this screen loaded it
  const seen = (input._meta as Data | undefined)?.modified;
  if (row && typeof seen === 'string' && seen !== row.modified) {
    fail(409, `${def.label} was changed by someone else meanwhile. Open it again to see the new version.`, { conflict: true });
  }

  return tx(db, () => {
    const { data, errors } = validateDoc(db, def, input, prev);
    if (Object.keys(errors).length) throw new HttpError(422, 'Please check the marked fields', { errors });
    const id = row?.id ?? (def.single ? def.type : randomUUID());
    const name = def.naming.by === 'field' ? String(data[def.naming.field] ?? '') : row?.name ?? nextName(db, def);
    const title = titleFor(db, def, data, name);
    const search = searchFor(def, data, name, title);
    const at = now();
    if (row) {
      db.prepare('UPDATE docs SET name = ?, title = ?, data = ?, search = ?, modified = ?, modified_by = ? WHERE id = ?')
        .run(name, title, JSON.stringify(data), search, at, by, id);
      writeLog(db, def.type, id, 'update', by, prev!.data, data);
      if (row.title !== title) refreshTitles(db, def, id, title);
    } else {
      db.prepare('INSERT INTO docs (id, type, name, title, data, search, created, modified, owner, modified_by, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
        .run(id, def.type, name, title, JSON.stringify(data), search, at, at, by, by);
      writeLog(db, def.type, id, 'create', by, null, data);
    }
    writeLinks(db, def, id, data);
    afterSave(db, def, id, data);
    return present(db, def, loadRow(db, def.type, id)!);
  });
}

/** Records whose title is the title of a linked record (a price shows its product) follow a rename. */
function refreshTitles(db: DB, def: DocDef, id: string, title: string): void {
  for (const d of DEFS) {
    const tf = d.fields.find((f) => f.key === d.title);
    if (tf?.type !== 'link' || tf.to !== def.type) continue;
    const ids = db.prepare('SELECT from_id FROM links WHERE from_type = ? AND field = ? AND to_id = ?').all(d.type, tf.key, id) as { from_id: string }[];
    for (const r of ids) {
      const other = loadRow(db, d.type, r.from_id);
      if (!other) continue;
      db.prepare('UPDATE docs SET title = ?, search = ? WHERE id = ?').run(title, searchFor(d, parse(other.data), other.name, title), other.id);
    }
  }
}

/** Where a record is used: [{type, label, id, title, field}] (max 50). Stock movements show as type 'step'. */
export function usedIn(db: DB, id: string): Data[] {
  const rows = db.prepare('SELECT DISTINCT from_type, from_id, field FROM links WHERE to_id = ? ORDER BY from_type, from_id LIMIT 50').all(id) as { from_type: string; from_id: string; field: string }[];
  const titles = titlesOf(db, rows.map((r) => r.from_id));
  return rows.map((r) => {
    const d = getDef(r.from_type);
    const label = d?.label ?? (r.from_type === 'step' ? 'Stock movement' : r.from_type);
    return { type: r.from_type, label, id: r.from_id, title: titles[r.from_id] ?? r.from_id, field: r.field };
  });
}

/** Soft delete; refused with 409 { usedIn } while anything points at the record. */
export function deleteDoc(db: DB, def: DocDef, id: string, by: string | null): void {
  if (def.single) fail(400, `The ${def.label.toLowerCase()} cannot be deleted`);
  if (def.child) fail(400, `${def.plural} are removed inside their parent record`);
  const row = loadRow(db, def.type, id) ?? fail(404, `${def.label} not found`);
  const used = usedIn(db, id);
  if (used.length) {
    const kinds = [...new Set(used.map((u) => String(u.label).toLowerCase()))].join(', ');
    fail(409, `${row.title} cannot be deleted: it is used in ${used.length}${used.length === 50 ? '+' : ''} record(s) (${kinds}). Make it inactive instead.`, { usedIn: used });
  }
  beforeDelete(db, def, row);
  tx(db, () => {
    db.prepare('UPDATE docs SET deleted = 1, modified = ?, modified_by = ? WHERE id = ?').run(now(), by, id);
    db.prepare('DELETE FROM links WHERE from_type = ? AND from_id = ?').run(def.type, id);
    writeLog(db, def.type, id, 'delete', by, parse(row.data), null);
    afterDelete(db, def, row);
  });
}

/** History of one record, newest first. */
export function history(db: DB, id: string, limit = 50): Data[] {
  const rows = db.prepare('SELECT log.action, log.at, log.by, log.before, log.after, docs.title AS by_name FROM log LEFT JOIN docs ON docs.id = log.by WHERE log.doc_id = ? ORDER BY log.id DESC LIMIT ?')
    .all(id, limit) as { action: string; at: string; by: string | null; before: string | null; after: string | null; by_name: string | null }[];
  return rows.map((r) => {
    const before = r.before ? parse(r.before) : {};
    const after = r.after ? parse(r.after) : {};
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    return { action: r.action, at: r.at, by: r.by, byName: r.by_name ?? (r.by === 'setup' ? 'Setup' : null), changed };
  });
}
