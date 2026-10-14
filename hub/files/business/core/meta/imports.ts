// Imports (phase 5c, blueprint 04 §7): trade terms (ERPNext Incoterm), HS codes (ERPNext Customs Tariff Number), the
// kinds of import cost (a list the business adds to, never hard-coded rates), and our own Import Shipment, which ties
// one import together: the supplier, its orders, goods arrived and bills, the shipping papers, customs, and every cost
// line with how it is booked. Costing a shipment posts one landed cost (store/imports.ts). Pure data.
import type { DocDef, Role } from './types.ts';
import { ALL } from './types.ts';

const BUYERS: Role[] = ['manager', 'storekeeper', 'accountant'];

export const incoterm: DocDef = {
  type: 'incoterm', label: 'Incoterm', plural: 'Incoterms', module: 'buy',
  icon: '<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/><circle cx="12" cy="12" r="9"/>',
  title: 'code', subtitle: 'name',
  description: 'Who pays and carries the risk of the goods up to which place (FOB, CIF…), on orders, bills and shipments.',
  naming: { by: 'field', field: 'code' },
  fields: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: true, search: true, help: 'E.g. FOB, CIF, EXW.' },
    { key: 'name', label: 'Name', type: 'text', required: true, search: true, help: 'E.g. Free On Board.' },
    { key: 'description', label: 'What it means', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Incoterm', fields: ['code', 'name', 'active', 'description'], columns: 2 }],
  list: { columns: ['code', 'name', 'active'], sort: 'code', filters: ['active'] },
  related: [{ type: 'import_shipment', by: 'incoterm', label: 'Import shipments' }],
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const customs_tariff: DocDef = {
  type: 'customs_tariff', label: 'HS code', plural: 'HS codes', module: 'products',
  icon: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  title: 'number', subtitle: 'description',
  description: 'Customs tariff numbers (HS codes, EAC Common External Tariff) of the products you import.',
  naming: { by: 'field', field: 'number' },
  fields: [
    { key: 'number', label: 'HS code', type: 'text', required: true, unique: true, search: true, help: 'E.g. 1006.30.00 (rice).' },
    { key: 'description', label: 'Description', type: 'text', search: true },
    { key: 'duty_rate', label: 'Import duty %', type: 'percent', min: 0, max: 100,
      help: 'The duty rate for this code. Used to share the duty on a shipment over its lines ("By hand per line", filled by HS code); rates change with each Finance Act, so keep it up to date.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'HS code', fields: ['number', 'description', 'duty_rate', 'active'], columns: 2 }],
  list: { columns: ['number', 'description', 'duty_rate', 'active'], sort: 'number', filters: ['active'] },
  related: [{ type: 'product', by: 'customs_tariff', label: 'Products' }],
  roles: { read: ALL, write: BUYERS, delete: ['manager'] },
};

/** The ways a cost line is booked (04 §7 "Treatment per cost line"). */
export const TREATMENTS = ['Add to the cost of the goods', 'Import VAT (claimed back)', 'Expense', 'Refundable deposit'];
export const SPREADS = ['By value', 'By quantity', 'By hand per line'];

export const import_charge: DocDef = {
  type: 'import_charge', label: 'Import cost type', plural: 'Import cost types', module: 'buy',
  icon: '<path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6"/>',
  title: 'name', subtitle: 'treatment',
  description: 'Kinds of import cost (duty, freight, clearing, import VAT, container deposit…) and how each is booked.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true, help: 'E.g. Import duty, Freight, Railway Development Levy.' },
    { key: 'treatment', label: 'How it is booked', type: 'select', options: TREATMENTS, required: true, default: TREATMENTS[0],
      help: 'Into the cost of the goods; import VAT you claim back (a business not registered for VAT adds it to the cost instead); an expense; or a deposit you get back.' },
    { key: 'distribute', label: 'Shared over the goods', type: 'select', options: SPREADS, required: true, default: SPREADS[0],
      help: 'For costs added to the goods: by each line’s value, by quantity, or typed per line (duty per HS code).' },
    { key: 'account', label: 'Booked against', type: 'link', to: 'account', filter: { is_group: false },
      help: 'The account the cost waits on until the agent’s or TRA’s bill comes (their bill is booked to the same account). Empty: Freight and landed costs (Setup > Company).' },
    { key: 'debit_account', label: 'Expense or deposit account', type: 'link', to: 'account', filter: { is_group: false },
      help: 'For an expense: the expense account (empty: Other expenses). For a deposit: the asset account it is kept on (needed).' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Import cost type', fields: ['name', 'treatment', 'distribute', 'active'], columns: 2 },
    { label: 'Accounts', fields: ['account', 'debit_account'], columns: 2 },
    { label: 'Notes', fields: ['notes'], columns: 1 },
  ],
  list: { columns: ['name', 'treatment', 'distribute', 'active'], sort: 'name', filters: ['treatment', 'active'] },
  roles: { read: BUYERS, write: ['manager', 'accountant'], delete: ['manager'] },
};

/** One document number on a shipment (a purchase order, goods arrived or a bill: a step number, e.g. ST-00012). */
export const import_doc: DocDef = {
  type: 'import_doc', label: 'Document', plural: 'Documents', module: 'buy', child: true,
  icon: '<path d="M6 3h9l3 3v15H6z"/>',
  title: 'doc',
  naming: { by: 'series', prefix: 'IMPD-', digits: 5 },
  fields: [{ key: 'doc', label: 'Number', type: 'text', required: true, unique: 'table', help: 'E.g. ST-00012.' }],
  sections: [{ label: 'Document', fields: ['doc'], columns: 1 }],
  list: { columns: ['doc'], sort: 'doc', filters: [] },
  roles: { read: BUYERS, write: BUYERS, delete: BUYERS },
};

export const import_cost: DocDef = {
  type: 'import_cost', label: 'Cost line', plural: 'Cost lines', module: 'buy', child: true,
  icon: '<path d="M12 3v18"/>',
  title: 'charge',
  naming: { by: 'series', prefix: 'IMPC-', digits: 5 },
  fields: [
    { key: 'charge', label: 'Cost', type: 'link', to: 'import_charge', required: true },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'amount', label: 'Amount (TZS)', type: 'money', required: true, min: 0 },
    { key: 'treatment', label: 'How it is booked', type: 'select', options: TREATMENTS, help: 'Empty: as its cost type says.' },
    { key: 'distribute', label: 'Shared', type: 'select', options: SPREADS, help: 'Empty: as its cost type says.' },
    { key: 'account', label: 'Booked against', type: 'link', to: 'account', filter: { is_group: false }, help: 'Empty: as its cost type says.' },
    { key: 'debit_account', label: 'Expense or deposit account', type: 'link', to: 'account', filter: { is_group: false }, help: 'Empty: as its cost type says.' },
    { key: 'bill', label: 'Charged on bill', type: 'text', help: 'The agent’s or TRA’s supplier bill (e.g. ST-00031). Empty: still an estimate.' },
    { key: 'status', label: 'Status', type: 'select', options: ['Estimated', 'Billed'], readOnly: true, default: 'Estimated', help: 'Billed once the bill that charged it is named.' },
  ],
  sections: [{ label: 'Cost line', fields: ['charge', 'description', 'amount', 'treatment', 'distribute', 'account', 'debit_account', 'bill', 'status'], columns: 2 }],
  list: { columns: ['charge', 'amount', 'status'], sort: 'charge', filters: [] },
  roles: { read: BUYERS, write: BUYERS, delete: BUYERS },
};

/** A cost line's amount typed by hand for one line of goods arrived (duty per HS line). */
export const import_share: DocDef = {
  type: 'import_share', label: 'Share by hand', plural: 'Shares by hand', module: 'buy', child: true,
  icon: '<path d="M4 12h16"/>',
  title: 'receipt',
  naming: { by: 'series', prefix: 'IMPS-', digits: 5 },
  fields: [
    { key: 'cost', label: 'Cost line', type: 'number', required: true, min: 1, integer: true, help: 'Which cost line (1 = the first).' },
    { key: 'receipt', label: 'Goods arrived', type: 'text', required: true, help: 'E.g. ST-00012.' },
    { key: 'line', label: 'Line', type: 'number', required: true, min: 1, integer: true, help: 'Line of that goods arrived (1 = the first).' },
    { key: 'amount', label: 'Amount (TZS)', type: 'money', required: true, min: 0 },
  ],
  sections: [{ label: 'Share', fields: ['cost', 'receipt', 'line', 'amount'], columns: 2 }],
  list: { columns: ['cost', 'receipt', 'line', 'amount'], sort: 'cost', filters: [] },
  roles: { read: BUYERS, write: BUYERS, delete: BUYERS },
};

export const SHIPMENT_STATUS = ['Ordered', 'Shipped', 'At port', 'Cleared', 'Received', 'Costed'];

export const import_shipment: DocDef = {
  type: 'import_shipment', label: 'Import shipment', plural: 'Import shipments', module: 'buy',
  icon: '<path d="M3 17l2 4h14l2-4H3z"/><path d="M6 17V9h12v8M9 9V5h6v4"/>',
  title: 'supplier', subtitle: 'bl_no',
  description: 'One import from order to landed cost: its papers, customs, and every cost (duty, freight, clearing, import VAT).',
  naming: { by: 'series', prefix: 'IMP-', digits: 5 },
  fields: [
    { key: 'supplier', label: 'Supplier', type: 'link', to: 'supplier', required: true },
    { key: 'status', label: 'Status', type: 'select', options: SHIPMENT_STATUS, required: true, default: 'Ordered',
      help: 'Ordered, shipped, at port, cleared: set as it moves. Received (goods arrived named) and Costed (landed cost posted) follow by themselves.' },
    { key: 'incoterm', label: 'Incoterm', type: 'link', to: 'incoterm', info: 'Kept for people and the papers: who pays the freight and insurance' },
    { key: 'named_place', label: 'Named place', type: 'text', help: 'The port or place the incoterm names, e.g. FOB Mombasa, CIF Dar es Salaam.' },
    { key: 'bl_no', label: 'Bill of lading / airway bill', type: 'text', search: true },
    { key: 'containers', label: 'Container numbers', type: 'text', search: true, help: 'Separate them with commas.' },
    { key: 'eta', label: 'Expected at port', type: 'date', help: 'The shipment page says when it is late.' },
    { key: 'customs_entry', label: 'Customs declaration (TANCIS) number', type: 'text', search: true },
    { key: 'customs_rate', label: 'Customs exchange rate (TZS per USD)', type: 'number', min: 0,
      help: 'The rate on the customs declaration: only for the customs value (duty and import VAT), not for stock or the supplier’s bill.' },
    { key: 'assessed_cif', label: 'Assessed CIF value', type: 'number', min: 0,
      help: 'From the TRA assessment: in USD when there is a customs exchange rate, else in TZS. The page works out the customs value and the import VAT base from it.' },
    { key: 'orders', label: 'Purchase orders', type: 'table', of: 'import_doc', help: 'The orders this shipment brings in.' },
    { key: 'receipts', label: 'Goods arrived', type: 'table', of: 'import_doc', help: 'The goods arrived its costs are added to.' },
    { key: 'bills', label: 'Supplier bills', type: 'table', of: 'import_doc', help: 'The supplier’s own bills for the goods (commercial invoice).' },
    { key: 'costs', label: 'Costs', type: 'table', of: 'import_cost' },
    { key: 'shares', label: 'Costs typed per line', type: 'table', of: 'import_share', help: 'For cost lines shared "By hand per line": the amount on each line of goods.' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ],
  sections: [
    { label: 'Shipment', fields: ['supplier', 'status', 'incoterm', 'named_place', 'eta'], columns: 2 },
    { label: 'Papers and customs', fields: ['bl_no', 'containers', 'customs_entry', 'customs_rate', 'assessed_cif'], columns: 2 },
    { label: 'Documents', fields: ['orders', 'receipts', 'bills'], columns: 1 },
    { label: 'Costs', fields: ['costs', 'shares'], columns: 1 },
    { label: 'Notes', fields: ['notes'], columns: 1 },
  ],
  list: { columns: ['supplier', 'status', 'bl_no', 'eta'], sort: 'created', dir: 'desc', filters: ['supplier', 'status', 'incoterm'] },
  roles: { read: BUYERS, write: BUYERS, delete: ['manager'] },
};
