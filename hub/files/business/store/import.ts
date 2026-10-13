// Excel import: a CSV saved from Excel goes in, records come out. Preview first (what would happen, row by row,
// with the errors), then commit (rows without errors are saved in one transaction; rows with errors are skipped).
// Headers match a field's label or key, in any case. Link cells may hold the target's name, title or id.
import type { DocDef } from '../core/meta/index.ts';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { fail, HttpError } from './errors.ts';
import type { Data, DocRow, Errors } from './docs.ts';
import { existing, isBlank, loadSingle, saveDoc, validateDoc } from './docs.ts';

const MAX_ROWS = 5000;

/** RFC 4180 CSV with what Excel adds: a UTF-8 BOM, CRLF, ';' or tab as separator in some setups,
 *  quotes around cells with commas, quotes ("") or line breaks. Returns the rows and the line each row starts on. */
export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const sep = guessSeparator(s);
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else if (c === '\r' && s[i + 1] === '\n') {
        // Windows line break inside a quoted cell: keep only the \n
      } else {
        if (c === '\n') line++;
        cell += c;
      }
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === sep) {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) { rows.push(row); lines.push(rowLine); }
      row = [];
      line++;
      rowLine = line;
    } else {
      cell += c;
    }
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) { rows.push(row); lines.push(rowLine); }
  return { rows, lines };
}

/** The separator used on the first line (outside quotes): ',' unless ';' or tab is clearly what was used. */
function guessSeparator(s: string): string {
  const count: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in count) count[c]++;
  }
  if (count[';'] > count[','] && count[';'] >= count['\t']) return ';';
  if (count['\t'] > count[','] && count['\t'] > count[';']) return '\t';
  return ',';
}

const norm = (h: string): string => h.toLowerCase().replace(/\*/g, '').replace(/[_\s]+/g, ' ').trim();

export interface Column { column: string; field: string | null; label: string | null }

/** Which field each header fills: by label or key (case-insensitive). '_name' = the record's number (e.g. CUST-00001). */
export function mapHeaders(def: DocDef, headers: string[]): Column[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const n = norm(h);
    let f = def.fields.find((x) => x.type !== 'table' && !x.readOnly && (norm(x.label) === n || norm(x.key) === n));
    let field: string | null = f ? f.key : null;
    if (!f && def.naming.by === 'series' && ['id', 'number', 'no', 'code', def.label.toLowerCase() + ' number'].includes(n)) field = '_name';
    if (field && used.has(field)) { field = null; f = undefined; }
    if (field) used.add(field);
    return { column: h, field, label: f ? f.label : field === '_name' ? `${def.label} number` : null };
  });
}

export interface ImportRow { line: number; action: 'create' | 'update'; title: string; errors: Errors; values: Data }

export function importCsv(db: DB, def: DocDef, csv: unknown, commit: boolean, by: string | null) {
  if (def.child) fail(400, `${def.plural} cannot be imported on their own`);
  if (typeof csv !== 'string' || !csv.trim()) fail(400, 'The file is empty');
  const { rows, lines } = parseCsv(csv as string);
  if (rows.length < 2) fail(422, 'The file needs a header row and at least one row of data');
  if (rows.length - 1 > MAX_ROWS) fail(422, `At most ${MAX_ROWS} rows at a time; split the file`);
  const columns = mapHeaders(def, rows[0]);
  if (!columns.some((c) => c.field && c.field !== '_name')) {
    fail(422, `No column matches a ${def.label.toLowerCase()} field. Use headers like: ${def.fields.filter((f) => f.type !== 'table').map((f) => f.label).join(', ')}`);
  }
  const namingField = def.naming.by === 'field' ? def.naming.field : null;
  const uniqueKeys = def.fields.filter((f) => f.unique === true || f.key === namingField).map((f) => f.key);
  const seen = new Map<string, Map<string, number>>(uniqueKeys.map((k) => [k, new Map()]));

  const out: ImportRow[] = [];
  const run = () => {
    let created = 0, updated = 0;
    for (let r = 1; r < rows.length; r++) {
      const line = lines[r];
      const input: Data = {};
      columns.forEach((c, i) => { if (c.field && !isBlank(rows[r][i])) input[c.field] = rows[r][i].trim(); });
      // match an existing record: by its naming field (product code, store name…) or its number
      let row: DocRow | undefined;
      if (def.single) row = loadSingle(db, def.type);
      else if (namingField && typeof input[namingField] === 'string') row = byName(db, def, input[namingField] as string);
      else if (typeof input._name === 'string') row = byName(db, def, input._name as string);
      const prev = existing(row);
      const { _name, ...values } = input;
      void _name;
      const { data, errors } = validateDoc(db, def, values, prev);
      for (const k of uniqueKeys) {
        if (data[k] === undefined || errors[k]) continue;
        const key = String(data[k]).toLowerCase();
        const at = seen.get(k)!;
        if (at.has(key)) errors[k] = `Same as line ${at.get(key)}`;
        else at.set(key, line);
      }
      const titleField = def.fields.find((f) => f.key === def.title);
      const title = titleField?.type === 'link' ? String(input[def.title] ?? '') : String(data[def.title] ?? row?.title ?? '');
      const item: ImportRow = { line, action: prev ? 'update' : 'create', title, errors, values };
      if (commit && !Object.keys(errors).length) {
        try {
          saveDoc(db, def, prev ? { ...values, id: prev.id } : values, by);
          if (prev) updated++; else created++;
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          item.errors = (e.extra.errors as Errors) ?? { _: e.message };
        }
      }
      out.push(item);
    }
    return { created, updated };
  };
  const done = commit ? tx(db, run) : run();
  const failed = out.filter((r) => Object.keys(r.errors).length).length;
  return {
    committed: commit,
    columns,
    rows: out,
    counts: { total: out.length, ok: out.length - failed, failed, create: out.filter((r) => r.action === 'create' && !Object.keys(r.errors).length).length,
      update: out.filter((r) => r.action === 'update' && !Object.keys(r.errors).length).length, created: done.created, updated: done.updated },
  };
}

function byName(db: DB, def: DocDef, name: string): DocRow | undefined {
  return db.prepare('SELECT * FROM docs WHERE type = ? AND deleted = 0 AND name = ? COLLATE NOCASE LIMIT 1').get(def.type, name.trim()) as DocRow | undefined;
}
