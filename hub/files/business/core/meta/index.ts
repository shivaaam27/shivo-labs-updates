// All definitions (business/FRAME.md). A new master is a new definition here; nothing else is hand-built.
import type { DocDef, Role } from './types.ts';
import { company, store, unit, payment_method, tax, account, user } from './setup.ts';
import { product, product_barcode, product_unit, product_reorder, product_group, brand, price_list, item_price, price_rule } from './products.ts';
import { customer, customer_group, party_contact, payment_term_row, payment_terms, supplier, supplier_group, salesman } from './parties.ts';
import { till, till_customer_group, till_method, till_product_group, till_user } from './till.ts';
import { driver, route, vehicle } from './delivery.ts';
import { letter_head, print_heading, terms } from './print.ts';

export type { DocDef, Field, Role, Section, Naming, FieldType, Module } from './types.ts';
export { ROLES, FIELD_TYPES } from './types.ts';

export const DEFS: DocDef[] = [
  company, store, unit, payment_method, tax, account, user,
  product, product_barcode, product_unit, product_reorder, product_group, brand, price_list, item_price, price_rule,
  customer, customer_group, salesman, supplier, supplier_group, party_contact, payment_terms, payment_term_row,
  till, till_user, till_method, till_product_group, till_customer_group, driver, vehicle, route,
  print_heading, terms, letter_head,
];

const BY_TYPE = new Map(DEFS.map((d) => [d.type, d]));
export const getDef = (type: string): DocDef | undefined => BY_TYPE.get(type);

/** Movements and money documents (the steps the engine runs) are not definitions; who may see, record and undo them.
 *  `kinds`: who may record each kind (the owner may do everything). Like ERPNext's Stock User / Sales User /
 *  Purchase User / Accounts User: the till sells, the store moves goods, the accountant records bills and payments. */
const STOCK: Role[] = ['manager', 'storekeeper'];
export const STEP_ROLES: { read: Role[]; write: Role[]; undo: Role[]; kinds: Record<string, Role[]> } = {
  read: ['manager', 'storekeeper', 'accountant', 'cashier', 'salesman'],
  write: ['manager', 'storekeeper', 'accountant', 'cashier', 'salesman'],   // may record at least one kind
  undo: ['manager'],
  kinds: {
    receipt: STOCK, issue: STOCK, transfer: STOCK, count: STOCK, purchase_receipt: STOCK, delivery: STOCK, landed_cost: STOCK,
    sales_invoice: ['manager', 'cashier', 'salesman'],
    credit_note: ['manager', 'cashier'],
    purchase_invoice: ['manager', 'accountant'],
    payment: ['manager', 'accountant', 'cashier'],
    money_transfer: ['manager', 'accountant'],
    journal: ['manager', 'accountant'],
    quotation: ['manager', 'cashier', 'salesman'],
    sales_order: ['manager', 'cashier', 'salesman'],
    delivery_note: ['manager', 'storekeeper'],
    set_status: ['manager', 'salesman'],
    reconcile: ['manager', 'accountant'],
    pick_list: ['manager', 'storekeeper'],
    delivery_trip: ['manager', 'storekeeper'],
    trip_visit: ['manager', 'storekeeper', 'salesman'],
    shift_open: ['manager', 'cashier', 'salesman'],
    shift_close: ['manager', 'cashier', 'salesman'],
  },
};
