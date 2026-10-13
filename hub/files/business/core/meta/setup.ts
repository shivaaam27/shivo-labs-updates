// Setup definitions: who the business is and its rules (company, stores and vans, units, payment methods,
// taxes, chart of accounts, users). Pure data.
import type { DocDef } from './types.ts';
import { ALL } from './types.ts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TIN_HELP = 'TIN: Taxpayer Identification Number from TRA, 9 digits (e.g. 123-456-789).';
const VRN_HELP = 'VRN: VAT Registration Number from TRA. Only for businesses registered for VAT.';
const LEAF = { is_group: false };

export const company: DocDef = {
  type: 'company', label: 'Company', plural: 'Company', module: 'setup', single: true,
  icon: '<path d="M4 21V5l8-3 8 3v16"/><path d="M9 21v-5h6v5M8 8h2M14 8h2M8 12h2M14 12h2"/>',
  title: 'name', subtitle: 'tin',
  description: 'Who the business is, its tax numbers and the accounts it uses by default.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Business name', type: 'text', required: true, search: true },
    { key: 'legal_name', label: 'Registered name', type: 'text', help: 'As on the BRELA certificate, if different.' },
    { key: 'tin', label: 'TIN', type: 'tin', help: TIN_HELP },
    { key: 'vrn', label: 'VRN', type: 'text', help: VRN_HELP },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'address', label: 'Address', type: 'longtext', help: 'Street, area and landmark, as printed on receipts.' },
    { key: 'city', label: 'City / region', type: 'text', default: 'Dar es Salaam' },
    { key: 'currency', label: 'Currency', type: 'select', options: ['TZS'], default: 'TZS', readOnly: true },
    { key: 'year_start', label: 'Financial year starts in', type: 'select', options: MONTHS, default: 'January' },
    { key: 'allow_negative_stock', label: 'Allow selling below zero stock', type: 'check', default: false,
      help: 'Off: a sale or move is refused when the store does not have enough stock.' },
    { key: 'default_store', label: 'Main store', type: 'link', to: 'store' },
    { key: 'selling_price_list', label: 'Default selling price list', type: 'link', to: 'price_list', filter: { type: 'Selling' } },
    { key: 'buying_price_list', label: 'Default buying price list', type: 'link', to: 'price_list', filter: { type: 'Buying' } },
    { key: 'cash_account', label: 'Cash', type: 'link', to: 'account', filter: LEAF },
    { key: 'receivable_account', label: 'Debtors (customers owe us)', type: 'link', to: 'account', filter: LEAF },
    { key: 'payable_account', label: 'Creditors (we owe suppliers)', type: 'link', to: 'account', filter: LEAF },
    { key: 'income_account', label: 'Sales', type: 'link', to: 'account', filter: LEAF },
    { key: 'cogs_account', label: 'Cost of goods sold', type: 'link', to: 'account', filter: LEAF },
    { key: 'stock_account', label: 'Stock in hand', type: 'link', to: 'account', filter: LEAF },
    { key: 'stock_adjustment_account', label: 'Stock adjustment', type: 'link', to: 'account', filter: LEAF },
    { key: 'srbnb_account', label: 'Stock received, not billed', type: 'link', to: 'account', filter: LEAF,
      help: 'Holds the value of goods that arrived before the supplier\'s bill.' },
    { key: 'landed_cost_account', label: 'Freight and landed costs', type: 'link', to: 'account', filter: LEAF },
    { key: 'round_off_account', label: 'Round off', type: 'link', to: 'account', filter: LEAF },
  ],
  sections: [
    { label: 'Business', fields: ['name', 'legal_name', 'tin', 'vrn', 'phone', 'email', 'address', 'city'], columns: 2 },
    { label: 'Rules', fields: ['currency', 'year_start', 'allow_negative_stock', 'default_store', 'selling_price_list', 'buying_price_list'], columns: 2 },
    { label: 'Default accounts', fields: ['cash_account', 'receivable_account', 'payable_account', 'income_account', 'cogs_account',
      'stock_account', 'stock_adjustment_account', 'srbnb_account', 'landed_cost_account', 'round_off_account'], columns: 2 },
  ],
  list: { columns: ['name', 'tin', 'vrn', 'phone'], sort: 'name', filters: [] },
  roles: { read: ALL, write: ['manager'], delete: [] },
};

export const store: DocDef = {
  type: 'store', label: 'Store or van', plural: 'Stores and vans', module: 'setup',
  icon: '<path d="M3 9l2-5h14l2 5"/><path d="M4 9v11h16V9M3 9h18M9 20v-6h6v6"/>',
  title: 'name', subtitle: 'type',
  description: 'Places that hold stock: shops, stores and salesmen\'s vans.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'type', label: 'Type', type: 'select', options: ['Store', 'Van'], default: 'Store', required: true },
    { key: 'address', label: 'Address', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Store or van', fields: ['name', 'type', 'address', 'active'], columns: 2 }],
  list: { columns: ['name', 'type', 'active'], sort: 'name', filters: ['type', 'active'] },
  related: [{ type: 'salesman', by: 'store', label: 'Salesmen' }],
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const unit: DocDef = {
  type: 'unit', label: 'Unit', plural: 'Units', module: 'setup',
  icon: '<path d="M4 17l10-10 3 3-10 10H4z"/><path d="M8 13l1.5 1.5M11 10l1.5 1.5M14 7l1.5 1.5"/>',
  title: 'name',
  description: 'Units products are counted in: pieces, kilograms, cartons…',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'whole_number', label: 'Whole numbers only', type: 'check', default: true, help: 'On for pieces, cartons, boxes; off for kilograms and litres.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Unit', fields: ['name', 'whole_number', 'active'], columns: 2 }],
  list: { columns: ['name', 'whole_number', 'active'], sort: 'name', filters: ['active'] },
  roles: { read: ALL, write: ['manager', 'storekeeper'], delete: ['manager'] },
};

export const payment_method: DocDef = {
  type: 'payment_method', label: 'Payment method', plural: 'Payment methods', module: 'setup',
  icon: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  title: 'name', subtitle: 'type',
  description: 'How customers pay and how we pay: cash, mobile money, bank, card.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'type', label: 'Type', type: 'select', options: ['Cash', 'Mobile money', 'Bank', 'Card'], required: true, default: 'Cash' },
    { key: 'account', label: 'Account', type: 'link', to: 'account', filter: LEAF, required: true,
      help: 'Where the money goes in the books, e.g. Cash or M-Pesa.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Payment method', fields: ['name', 'type', 'account', 'active'], columns: 2 }],
  list: { columns: ['name', 'type', 'account', 'active'], sort: 'name', filters: ['type', 'active'] },
  roles: { read: ALL, write: ['manager', 'accountant'], delete: ['manager'] },
};

export const tax: DocDef = {
  type: 'tax', label: 'Tax', plural: 'Taxes', module: 'setup',
  icon: '<path d="M7 17L17 7"/><circle cx="8" cy="8" r="2"/><circle cx="16" cy="16" r="2"/>',
  title: 'name', subtitle: 'rate',
  description: 'VAT and withholding rates and the accounts they are booked to.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'type', label: 'Type', type: 'select', options: ['VAT', 'Withholding'], required: true, default: 'VAT',
      help: 'VAT: Value Added Tax, 18 % standard rate in Tanzania.' },
    { key: 'rate', label: 'Rate', type: 'percent', required: true, min: 0, max: 100 },
    { key: 'account', label: 'Account (on sales)', type: 'link', to: 'account', filter: LEAF, required: true, help: 'Usually VAT Output.' },
    { key: 'input_account', label: 'Account (on purchases)', type: 'link', to: 'account', filter: LEAF, help: 'Usually VAT Input.' },
    { key: 'to_confirm', label: 'To be confirmed with TRA', type: 'check', default: false,
      help: 'Marked while the rule is not yet confirmed by TRA; not used on receipts until cleared.' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Tax', fields: ['name', 'type', 'rate', 'active', 'to_confirm'], columns: 2 },
    { label: 'Accounts', fields: ['account', 'input_account'], columns: 2 },
    { label: 'Notes', fields: ['notes'], columns: 1 },
  ],
  list: { columns: ['name', 'type', 'rate', 'to_confirm', 'active'], sort: 'name', filters: ['type', 'active'] },
  roles: { read: ALL, write: ['manager', 'accountant'], delete: ['manager'] },
};

export const account: DocDef = {
  type: 'account', label: 'Account', plural: 'Chart of accounts', module: 'money',
  icon: '<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/>',
  title: 'name', subtitle: 'number',
  description: 'The chart of accounts: where every shilling is booked.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'number', label: 'Number', type: 'text', unique: true, search: true, help: 'Optional code, e.g. 1110.' },
    { key: 'parent', label: 'Under', type: 'link', to: 'account', filter: { is_group: true }, help: 'The group this account sits in. Empty only for the five main groups.' },
    { key: 'root_type', label: 'Main group', type: 'select', options: ['Asset', 'Liability', 'Equity', 'Income', 'Expense'], required: true,
      help: 'Taken from the group above when there is one.' },
    { key: 'account_type', label: 'Used for', type: 'select',
      options: ['', 'Cash', 'Bank', 'Mobile Money', 'Receivable', 'Payable', 'Tax', 'Stock', 'Cost of Goods Sold', 'Stock Received But Not Billed',
        'Stock Adjustment', 'Expenses Included In Valuation', 'Round Off', 'Equity', 'Temporary', 'Income Account', 'Expense Account'],
      help: 'The role the system looks the account up by.' },
    { key: 'is_group', label: 'Group (holds other accounts)', type: 'check', default: false, help: 'A group only adds up the accounts under it; nothing is booked to it directly.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Account', fields: ['name', 'number', 'parent', 'root_type', 'account_type', 'is_group', 'active'], columns: 2 }],
  list: { columns: ['number', 'name', 'parent', 'root_type', 'account_type', 'is_group'], sort: 'number', filters: ['root_type', 'account_type', 'is_group', 'active'] },
  roles: { read: ['manager', 'accountant'], write: ['accountant'], delete: ['accountant'] },
};

export const user: DocDef = {
  type: 'user', label: 'User', plural: 'Users', module: 'setup',
  icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  title: 'name', subtitle: 'role',
  description: 'People who use the system, what they may do, and their PIN.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'role', label: 'Role', type: 'select', options: ['Owner', 'Manager', 'Cashier', 'Storekeeper', 'Salesman', 'Accountant'], required: true, default: 'Cashier',
      help: 'Owner: everything. Manager: everything except users. Cashier: sells. Storekeeper: stock. Salesman: orders and customers. Accountant: money and books.' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'active', label: 'Active', type: 'check', default: true, help: 'Off: this person can no longer switch in with their PIN.' },
  ],
  sections: [{ label: 'User', fields: ['name', 'role', 'phone', 'active'], columns: 2 }],
  list: { columns: ['name', 'role', 'phone', 'active'], sort: 'name', filters: ['role', 'active'] },
  roles: { read: ['manager'], write: [], delete: [] },
};
