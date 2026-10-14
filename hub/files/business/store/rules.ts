// The few checks a definition cannot say on its own, per type. Kept small: anything generic belongs in docs.ts.
import type { DocDef } from '../core/meta/index.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data, DocRow, Errors, Existing } from './docs.ts';
import { owedBy } from './steps.ts';
import { checkShipment } from './imports.ts';
import { currencyRules } from './fx.ts';

const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const dataOf = (db: DB, type: string, id: unknown): Data | null => {
  if (typeof id !== 'string') return null;
  const r = db.prepare('SELECT data FROM docs WHERE type = ? AND id = ? AND deleted = 0').get(type, id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
};
const titleOf = (db: DB, id: unknown): string => {
  const r = typeof id === 'string' ? db.prepare('SELECT title FROM docs WHERE id = ?').get(id) as { title: string } | undefined : undefined;
  return r?.title ?? '';
};

/** Runs after the field checks; may fill derived values and add or clear errors. */
export function checkRules(db: DB, def: DocDef, data: Data, prev: Existing | null, errors: Errors): void {
  currencyRules(db, def, data, prev, errors);   // foreign currency (store/fx.ts)
  // a new customer with no route gets the company's default route (ERPNext Selling Settings territory)
  if (def.type === 'customer' && !prev && (data.route === undefined || data.route === null || data.route === '')) {
    const co = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
    const r = co ? parse(co.data).default_route : undefined;
    if (typeof r === 'string' && r) data.route = r;
  }
  // a credit limit may not be set below what the customer already owes (03 §5.2, CU:350)
  if (def.type === 'customer' && prev && Number(data.credit_limit) > 0 && Number(data.credit_limit) !== Number(prev.data.credit_limit)) {
    const owed = owedBy(db, prev.id);
    if (owed > Number(data.credit_limit)) errors.credit_limit = `They already owe ${owed.toLocaleString('en-US')} (open orders and deliveries included): the limit cannot be lower`;
  }
  if (def.type === 'account') {
    // the main group comes from the group above (01 §1.1: root type inherited from the parent)
    const parent = dataOf(db, 'account', data.parent);
    if (parent?.root_type) { data.root_type = parent.root_type; delete errors.root_type; }
    if (prev) {
      const children = db.prepare("SELECT COUNT(*) AS n FROM links WHERE from_type = 'account' AND field = 'parent' AND to_id = ?").get(prev.id) as { n: number };
      if (children.n && !data.is_group) errors.is_group = 'Accounts sit under it, so it must stay a group';
      if (children.n && prev.data.root_type !== data.root_type) errors.root_type = 'Accounts sit under it; move them first';
    }
  }

  if (def.type === 'user' && prev && prev.data.role === 'Owner' && prev.data.active !== false) {
    const stillOwner = data.role === 'Owner' && data.active !== false;
    if (!stillOwner && otherOwners(db, prev.id) === 0) errors.role = 'There must always be at least one active owner';
  }

  // an import shipment: its documents, cost lines and status (store/imports.ts)
  if (def.type === 'import_shipment') checkShipment(db, data, prev, errors);

  if (def.type === 'product') {
    const units = Array.isArray(data.units) ? (data.units as Data[]) : [];
    units.forEach((u, i) => { if (u.unit && u.unit === data.stock_unit) errors[`units.${i}.unit`] = 'This is already the stock unit'; });
  }

  if (def.type === 'item_price') {
    if (data.valid_from && data.valid_to && String(data.valid_to) < String(data.valid_from)) errors.valid_to = 'Must be on or after "Valid from"';
    // the unit must be one the product is counted or sold in
    const product = dataOf(db, 'product', data.product);
    if (product && data.unit && data.unit !== product.stock_unit) {
      const units = Array.isArray(product.units) ? (product.units as Data[]) : [];
      if (!units.some((u) => u.unit === data.unit)) errors.unit = `${titleOf(db, data.product)} has no unit ${titleOf(db, data.unit)}; add it under its other units first`;
    }
    // one price per product, list, unit and customer or supplier (a price only for one customer, or from one supplier,
    // sits next to the list price) for any day
    if (!errors.product && !errors.price_list && !errors.valid_to) {
      const others = db.prepare(`SELECT name, data FROM docs WHERE type = 'item_price' AND deleted = 0 AND id <> ?
          AND json_extract(data, '$.product') = ? AND json_extract(data, '$.price_list') = ?`).all(prev?.id ?? '', String(data.product ?? ''), String(data.price_list ?? '')) as { name: string; data: string }[];
      const from = String(data.valid_from ?? '0000-00-00'), to = String(data.valid_to ?? '9999-12-31');
      const unitOf = (d: Data): unknown => d.unit ?? product?.stock_unit ?? null;
      for (const o of others) {
        const d = parse(o.data);
        if (unitOf(d) !== unitOf(data) || (d.customer ?? null) !== (data.customer ?? null) || (d.supplier ?? null) !== (data.supplier ?? null)) continue;
        const of = String(d.valid_from ?? '0000-00-00'), ot = String(d.valid_to ?? '9999-12-31');
        if (of <= to && from <= ot) { errors.rate = `There is already a price for these dates (${o.name}); end it first or change its dates`; break; }
      }
    }
  }
}

function otherOwners(db: DB, except: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND id <> ?").get(except) as { n: number }).n;
}

export function afterSave(db: DB, def: DocDef, id: string, data: Data): void {
  if (def.type === 'user') {
    // the users table holds what logging in needs; the PIN hash is set separately (users.ts)
    db.prepare(`INSERT INTO users (id, name, role, active) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, active = excluded.active,
          pin_hash = CASE WHEN excluded.active = 0 THEN NULL ELSE users.pin_hash END`)   // switched off: the PIN goes
      .run(id, String(data.name), String(data.role).toLowerCase(), data.active === false ? 0 : 1);
  }
}

export function beforeDelete(db: DB, def: DocDef, row: DocRow): void {
  if (def.type === 'user') {
    const d = parse(row.data);
    if (d.role === 'Owner' && d.active !== false && otherOwners(db, row.id) === 0) fail(409, 'The last owner cannot be deleted');
  }
}

export function afterDelete(db: DB, def: DocDef, row: DocRow): void {
  if (def.type === 'user') db.prepare('UPDATE users SET active = 0, pin_hash = NULL WHERE id = ?').run(row.id);
}
