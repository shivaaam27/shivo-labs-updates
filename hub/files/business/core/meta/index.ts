// All definitions (business/FRAME.md). A new master is a new definition here; nothing else is hand-built.
import type { DocDef, Role } from './types.ts';
import { company, store, unit, payment_method, tax, account, user } from './setup.ts';
import { product, product_barcode, product_unit, product_reorder, product_group, brand, price_list, item_price } from './products.ts';
import { customer, customer_group, supplier, supplier_group, salesman } from './parties.ts';

export type { DocDef, Field, Role, Section, Naming, FieldType, Module } from './types.ts';
export { ROLES, FIELD_TYPES } from './types.ts';

export const DEFS: DocDef[] = [
  company, store, unit, payment_method, tax, account, user,
  product, product_barcode, product_unit, product_reorder, product_group, brand, price_list, item_price,
  customer, customer_group, salesman, supplier, supplier_group,
];

const BY_TYPE = new Map(DEFS.map((d) => [d.type, d]));
export const getDef = (type: string): DocDef | undefined => BY_TYPE.get(type);

/** Stock movements (the steps the engine runs) are not a definition yet; who may see and change them. */
export const STEP_ROLES: { read: Role[]; write: Role[]; undo: Role[] } = {
  read: ['manager', 'storekeeper', 'accountant', 'cashier', 'salesman'],
  write: ['manager', 'storekeeper'],
  undo: ['manager'],
};
