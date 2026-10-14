// People we deal with: customers, suppliers, their groups, and salesmen.
import type { DocDef } from './types.ts';
import { ALL } from './types.ts';

const TIN_HELP = 'TIN: Taxpayer Identification Number from TRA, 9 digits (e.g. 123-456-789). Needed on tax invoices for businesses.';
const VRN_HELP = 'VRN: VAT Registration Number from TRA. Only for VAT-registered businesses; a VAT invoice to them shows it.';
const SELLERS = ['manager', 'cashier', 'salesman', 'accountant'] as DocDef['roles']['write'];
const BUYERS = ['manager', 'storekeeper', 'accountant'] as DocDef['roles']['read'];

export const customer: DocDef = {
  type: 'customer', label: 'Customer', plural: 'Customers', module: 'customers',
  icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2"/>',
  title: 'name', subtitle: 'phone',
  description: 'Shops, companies and people you sell to.',
  naming: { by: 'series', prefix: 'CUST-', digits: 5 },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, search: true },
    { key: 'type', label: 'Type', type: 'select', options: ['Walk-in', 'Shop', 'Company'], required: true, default: 'Shop',
      help: 'Walk-in: a person paying at the till. Shop and Company: businesses you may give credit to.' },
    { key: 'tin', label: 'TIN', type: 'tin', search: true, help: TIN_HELP },
    { key: 'vrn', label: 'VRN', type: 'text', help: VRN_HELP },
    { key: 'phone', label: 'Phone', type: 'phone', search: true },
    { key: 'whatsapp', label: 'WhatsApp', type: 'phone', help: 'Empty: same as phone.' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'area', label: 'Area', type: 'text', search: true, help: 'E.g. Kariakoo market, near the mosque. Free text to find them.' },
    { key: 'route', label: 'Route', type: 'link', to: 'route', help: 'The delivery route or area they belong to; pricing rules may be for a route. Empty: the company\u2019s default route.' },
    { key: 'address', label: 'Address', type: 'longtext', help: 'Street, landmark, how to find the shop.' },
    { key: 'group', label: 'Group', type: 'link', to: 'customer_group', required: true, default: 'All Customers' },
    { key: 'price_list', label: 'Price list', type: 'link', to: 'price_list', filter: { type: 'Selling' }, help: 'Empty: the group\'s price list, else Retail.' },
    { key: 'credit_limit', label: 'Credit limit', type: 'money', min: 0, help: 'Most they may owe at one time. 0 or empty: the limit of their group, else the company\u2019s, else no limit. A manager can allow a sale over it.' },
    { key: 'credit_at_invoice', label: 'Check credit at the invoice, not the order', type: 'check', default: false,
      help: 'Their orders are taken whatever they owe and do not count; deliveries and invoices are checked in full.' },
    { key: 'credit_days', label: 'Days to pay', type: 'number', min: 0, max: 365, integer: true, help: 'Days after the invoice before payment is due.' },
    { key: 'vat_exempt', label: 'Buys without VAT', type: 'check', default: false, help: 'Exports, VAT relief, diplomats: their sales carry no VAT unless you switch VAT on for one sale.' },
    { key: 'payment_terms', label: 'Payment terms', type: 'link', to: 'payment_terms', help: 'Paying in parts. Empty: the group\u2019s terms, else the company\u2019s, else days to pay.' },
    { key: 'contacts', label: 'Contact people', type: 'table', of: 'party_contact', help: 'The people you deal with there: buyer, accountant, driver.', info: 'Kept for people: who to call or email there' },
    { key: 'salesman', label: 'Salesman', type: 'link', to: 'salesman', soon: 'Phase 4 (Sell): their orders and route; commission in phase 7' },
    { key: 'language', label: 'Print in', type: 'select', options: ['English', 'Swahili'], default: 'English',
      help: 'The language of their printed invoices, receipts and quotations (headings, labels and the amount in words).' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Customer', fields: ['name', 'type', 'group', 'salesman', 'language', 'active'], columns: 2 },
    { label: 'Contact', fields: ['phone', 'whatsapp', 'email', 'area', 'route', 'address'], columns: 2 },
    { label: 'Tax', fields: ['tin', 'vrn'], columns: 2 },
    { label: 'Prices and credit', fields: ['price_list', 'credit_limit', 'credit_at_invoice', 'credit_days', 'payment_terms', 'vat_exempt'], columns: 2 },
    { label: 'Contact people', fields: ['contacts'], columns: 1 },
    { label: 'Notes', fields: ['notes'], columns: 1 },
  ],
  list: { columns: ['name', 'type', 'phone', 'area', 'group', 'salesman', 'active'], sort: 'name', filters: ['type', 'group', 'salesman', 'price_list', 'active'] },
  roles: { read: ALL, write: SELLERS, delete: ['manager'] },
};

export const customer_group: DocDef = {
  type: 'customer_group', label: 'Customer group', plural: 'Customer groups', module: 'customers',
  icon: '<circle cx="7" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M2 20c.6-3 2.4-5 5-5s4.4 2 5 5M12 20c.6-3 2.4-5 5-5s4.4 2 5 5"/>',
  title: 'name',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'parent', label: 'Under', type: 'link', to: 'customer_group' },
    { key: 'price_list', label: 'Price list', type: 'link', to: 'price_list', filter: { type: 'Selling' }, help: 'Used for customers in this group that have no price list of their own.' },
    { key: 'credit_days', label: 'Days to pay', type: 'number', min: 0, max: 365, integer: true, help: 'For customers in this group who have none of their own.' },
    { key: 'credit_limit', label: 'Credit limit', type: 'money', min: 0, help: 'For customers in this group who have none of their own. 0 or empty: no limit.' },
    { key: 'vat_exempt', label: 'Buy without VAT', type: 'check', default: false, help: 'E.g. a group of exporters: their sales carry no VAT.' },
    { key: 'payment_terms', label: 'Payment terms', type: 'link', to: 'payment_terms', help: 'For customers in this group who have none of their own.' },
  ],
  sections: [{ label: 'Customer group', fields: ['name', 'parent', 'price_list', 'credit_days', 'credit_limit', 'payment_terms', 'vat_exempt'], columns: 2 }],
  list: { columns: ['name', 'parent', 'price_list'], sort: 'name', filters: [] },
  related: [{ type: 'customer', by: 'group', label: 'Customers' }],
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

/** Payment terms in parts (ERPNext Payment Terms Template, 03 §5.3): e.g. 50 % in 7 days, 50 % in 30 days. */
export const payment_term_row: DocDef = {
  type: 'payment_term_row', label: 'Instalment', plural: 'Instalments', module: 'customers', child: true,
  icon: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  title: 'portion', naming: { by: 'series', prefix: 'PTR-', digits: 6 },
  fields: [
    { key: 'portion', label: 'Share %', type: 'percent', required: true, min: 0.01, max: 100 },
    { key: 'basis', label: 'Due', type: 'select', options: ['Days after the invoice date', 'Days after the end of the invoice month', 'Months after the end of the invoice month'],
      required: true, default: 'Days after the invoice date' },
    { key: 'days', label: 'Days or months', type: 'number', min: 0, max: 730, integer: true, default: 0 },
  ],
  sections: [{ label: 'Instalment', fields: ['portion', 'basis', 'days'], columns: 3 }],
  list: { columns: ['portion', 'basis', 'days'], sort: 'portion', filters: [] },
  roles: { read: ALL, write: ['manager', 'accountant'], delete: ['manager', 'accountant'] },
};

export const payment_terms: DocDef = {
  type: 'payment_terms', label: 'Payment terms', plural: 'Payment terms', module: 'customers',
  icon: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M8 14h4"/>',
  title: 'name',
  description: 'Paying in parts, e.g. 50 % in 7 days and 50 % in 30 days. Used on invoices and bills of customers and suppliers who have them.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'rows', label: 'Instalments', type: 'table', of: 'payment_term_row', help: 'The shares must add up to 100 %; two instalments may not fall on the same day.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Payment terms', fields: ['name', 'active'], columns: 2 }, { label: 'Instalments', fields: ['rows'], columns: 1 }],
  list: { columns: ['name', 'active'], sort: 'name', filters: ['active'] },
  related: [{ type: 'customer', by: 'payment_terms', label: 'Customers' }, { type: 'supplier', by: 'payment_terms', label: 'Suppliers' }],
  roles: { read: ALL, write: ['manager', 'accountant'], delete: ['manager'] },
};

export const party_contact: DocDef = {
  type: 'party_contact', label: 'Contact person', plural: 'Contact people', module: 'customers', child: true,
  icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  title: 'name', naming: { by: 'series', prefix: 'PC-', digits: 6 },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, search: true },
    { key: 'role', label: 'Role', type: 'text', help: 'Buyer, accountant, driver…' },
    { key: 'phone', label: 'Phone', type: 'phone', search: true },
    { key: 'email', label: 'Email', type: 'email' },
  ],
  sections: [{ label: 'Contact person', fields: ['name', 'role', 'phone', 'email'], columns: 2 }],
  list: { columns: ['name', 'role', 'phone'], sort: 'name', filters: [] },
  roles: { read: ALL, write: ALL, delete: ALL },
};

export const supplier: DocDef = {
  type: 'supplier', label: 'Supplier', plural: 'Suppliers', module: 'suppliers',
  icon: '<path d="M2 7h11v9H2zM13 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  title: 'name', subtitle: 'phone',
  description: 'Companies you buy from, here and abroad.',
  naming: { by: 'series', prefix: 'SUPP-', digits: 5 },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, search: true },
    { key: 'group', label: 'Group', type: 'link', to: 'supplier_group', required: true, default: 'All Suppliers' },
    { key: 'tin', label: 'TIN', type: 'tin', search: true, help: TIN_HELP },
    { key: 'vrn', label: 'VRN', type: 'text', help: 'VRN: VAT Registration Number. Needed to claim the VAT on their bills.' },
    { key: 'currency', label: 'Currency', type: 'select', options: ['TZS', 'USD'], required: true, default: 'TZS', help: 'USD for overseas suppliers billed in dollars.', soon: 'Phase 5 (Buy): bills and payments in USD; until then amounts are in TZS' },
    { key: 'phone', label: 'Phone', type: 'phone', search: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'address', label: 'Address', type: 'longtext' },
    { key: 'payment_days', label: 'Days to pay', type: 'number', min: 0, max: 365, integer: true, help: 'Days after their bill before we must pay. Empty: the days of their group.' },
    { key: 'price_list', label: 'Price list', type: 'link', to: 'price_list', filter: { type: 'Buying' }, help: 'Their prices, filled in on their bills.' },
    { key: 'payment_terms', label: 'Payment terms', type: 'link', to: 'payment_terms', help: 'Paying them in parts. Empty: the group\u2019s terms, else the company\u2019s, else days to pay.' },
    { key: 'contacts', label: 'Contact people', type: 'table', of: 'party_contact', help: 'The people you deal with there: sales rep, accounts, driver.', info: 'Kept for people: who to call or email there' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Supplier', fields: ['name', 'group', 'currency', 'active'], columns: 2 },
    { label: 'Contact', fields: ['phone', 'email', 'address'], columns: 2 },
    { label: 'Tax', fields: ['tin', 'vrn'], columns: 2 },
    { label: 'Prices and payment', fields: ['price_list', 'payment_days', 'payment_terms'], columns: 2 },
    { label: 'Contact people', fields: ['contacts'], columns: 1 },
    { label: 'Notes', fields: ['notes'], columns: 1 },
  ],
  list: { columns: ['name', 'group', 'phone', 'currency', 'active'], sort: 'name', filters: ['group', 'currency', 'active'] },
  related: [{ type: 'product', by: 'default_supplier', label: 'Products' }],
  roles: { read: BUYERS, write: ['manager', 'accountant'], delete: ['manager'] },
};

export const supplier_group: DocDef = {
  type: 'supplier_group', label: 'Supplier group', plural: 'Supplier groups', module: 'suppliers',
  icon: '<path d="M3 8h18v12H3zM8 8V5h8v3"/>',
  title: 'name',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'payment_days', label: 'Days to pay', type: 'number', min: 0, max: 365, integer: true },
    { key: 'payment_terms', label: 'Payment terms', type: 'link', to: 'payment_terms', help: 'For suppliers in this group who have none of their own.' },
  ],
  sections: [{ label: 'Supplier group', fields: ['name', 'payment_days', 'payment_terms'], columns: 2 }],
  list: { columns: ['name', 'payment_days'], sort: 'name', filters: [] },
  related: [{ type: 'supplier', by: 'group', label: 'Suppliers' }],
  roles: { read: BUYERS, write: ['manager'], delete: ['manager'] },
};

export const salesman: DocDef = {
  type: 'salesman', label: 'Salesman', plural: 'Salesmen', module: 'customers',
  icon: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21l1.5-6h11L19 21M12 11v4"/>',
  title: 'name', subtitle: 'phone',
  description: 'People who take orders and deliver, often with a van.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'phone', label: 'Phone', type: 'phone', search: true },
    { key: 'user', label: 'User', type: 'link', to: 'user', help: 'Their login, if they use the system themselves.' },
    { key: 'store', label: 'Van or store', type: 'link', to: 'store', help: 'Where their stock is kept (usually their van).' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Salesman', fields: ['name', 'phone', 'user', 'store', 'active'], columns: 2 }],
  list: { columns: ['name', 'phone', 'store', 'active'], sort: 'name', filters: ['store', 'active'] },
  related: [{ type: 'customer', by: 'salesman', label: 'Customers' }],
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};
