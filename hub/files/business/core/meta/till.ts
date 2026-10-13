// The till (phase 4c, blueprint 03 §3.4): a till's settings (ERPNext POS Profile) and who may use it. Shifts (opening
// and closing with a cash count, ERPNext POS Opening / Closing Entry and Cashier Closing) are steps, not records:
// store/till.ts. Pure data.
import type { DocDef } from './types.ts';
import { ALL } from './types.ts';

export const till_user: DocDef = {
  type: 'till_user', label: 'Till user', plural: 'Till users', module: 'sell', child: true,
  icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  title: 'user', naming: { by: 'series', prefix: 'TU-', digits: 6 },
  fields: [
    { key: 'user', label: 'User', type: 'link', to: 'user', required: true },
    { key: 'default', label: 'Their till', type: 'check', default: false, help: 'Opens first for this person.' },
  ],
  sections: [{ label: 'Till user', fields: ['user', 'default'], columns: 2 }],
  list: { columns: ['user', 'default'], sort: 'user', filters: [] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const till_method: DocDef = {
  type: 'till_method', label: 'Payment method at the till', plural: 'Payment methods at the till', module: 'sell', child: true,
  icon: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  title: 'method', naming: { by: 'series', prefix: 'TM-', digits: 6 },
  fields: [
    { key: 'method', label: 'Payment method', type: 'link', to: 'payment_method', required: true, filter: { active: true } },
    { key: 'default', label: 'Default', type: 'check', default: false, help: 'The whole amount goes here unless the cashier splits it.' },
    { key: 'allow_in_returns', label: 'Refunds', type: 'check', default: true, help: 'Money may be paid back to customers this way.' },
  ],
  sections: [{ label: 'Payment method', fields: ['method', 'default', 'allow_in_returns'], columns: 3 }],
  list: { columns: ['method', 'default', 'allow_in_returns'], sort: 'method', filters: [] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const till_product_group: DocDef = {
  type: 'till_product_group', label: 'Product group at the till', plural: 'Product groups at the till', module: 'sell', child: true,
  icon: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  title: 'group', naming: { by: 'series', prefix: 'TPG-', digits: 6 },
  fields: [{ key: 'group', label: 'Product group', type: 'link', to: 'product_group', required: true }],
  sections: [{ label: 'Product group', fields: ['group'], columns: 1 }],
  list: { columns: ['group'], sort: 'group', filters: [] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const till_customer_group: DocDef = {
  type: 'till_customer_group', label: 'Customer group at the till', plural: 'Customer groups at the till', module: 'sell', child: true,
  icon: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c1-3.5 3.5-5 6-5s5 1.5 6 5"/>',
  title: 'group', naming: { by: 'series', prefix: 'TCG-', digits: 6 },
  fields: [{ key: 'group', label: 'Customer group', type: 'link', to: 'customer_group', required: true }],
  sections: [{ label: 'Customer group', fields: ['group'], columns: 1 }],
  list: { columns: ['group'], sort: 'group', filters: [] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const till: DocDef = {
  type: 'till', label: 'Till', plural: 'Tills', module: 'sell',
  icon: '<rect x="3" y="10" width="18" height="10" rx="2"/><path d="M6 10V5h12v5M9 15h6"/>',
  title: 'name', subtitle: 'store',
  description: 'A till (counter or phone) that sells: its store, prices, payment methods, who may use it and its shift rules.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true, help: 'E.g. Counter 1, Kariakoo shop, Van 2.' },
    { key: 'store', label: 'Store', type: 'link', to: 'store', required: true, help: 'Goods sold here leave this store.' },
    { key: 'customer', label: 'Walk-in customer', type: 'link', to: 'customer', help: 'Each new sale starts with this customer. Empty: the cashier chooses one every time.' },
    { key: 'price_list', label: 'Price list', type: 'link', to: 'price_list', filter: { type: 'Selling' },
      help: 'For customers with no price list of their own (their group’s list is not used at the till, as in ERPNext). Empty: the company’s default.' },
    { key: 'users', label: 'Who may sell here', type: 'table', of: 'till_user', help: 'Empty: every cashier, salesman and manager.' },
    { key: 'methods', label: 'Payment methods', type: 'table', of: 'till_method', help: 'How customers may pay here. Empty: every active payment method.' },
    { key: 'needs_shift', label: 'Sales need an open shift', type: 'check', default: true,
      help: 'The cashier opens a shift with the cash in the drawer and closes it by counting; the difference is shown.' },
    { key: 'hide_expected', label: 'Count without seeing the expected amount', type: 'check', default: false,
      help: 'At closing the cashier counts first; the expected amount and difference are shown after saving (a blind count).' },
    { key: 'allow_credit', label: 'Sales may be left unpaid', type: 'check', default: false,
      help: 'The customer owes what is not paid (credit limit checked). Off: every sale is paid in full.' },
    { key: 'allow_rate_change', label: 'Cashier may change prices', type: 'check', default: true, help: 'Off: the price from the price list (or pricing rule) is used.' },
    { key: 'allow_discount_change', label: 'Cashier may give discounts', type: 'check', default: true, help: 'Off: only discounts from pricing rules.' },
    { key: 'ignore_price_rules', label: 'No pricing rules here', type: 'check', default: false },
    { key: 'write_off_limit', label: 'Small change the cashier may write off', type: 'money', min: 0, help: 'Empty: 1,000. A manager may write off any amount.' },
    { key: 'hide_out_of_stock', label: 'Hide products out of stock', type: 'check', default: false, help: 'Products with no stock in this store are not offered.' },
    { key: 'product_groups', label: 'Only these product groups', type: 'table', of: 'till_product_group', help: 'With the groups under them. Empty: every product.' },
    { key: 'customer_groups', label: 'Only customers of these groups', type: 'table', of: 'till_customer_group', help: 'With the groups under them. Empty: every customer.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Till', fields: ['name', 'store', 'customer', 'price_list', 'active'], columns: 2 },
    { label: 'Shifts', fields: ['needs_shift', 'hide_expected'], columns: 2 },
    { label: 'What the cashier may do', fields: ['allow_credit', 'allow_rate_change', 'allow_discount_change', 'ignore_price_rules', 'write_off_limit', 'hide_out_of_stock'], columns: 2 },
    { label: 'Payment methods', fields: ['methods'], columns: 1 },
    { label: 'What this till sells, and to whom', fields: ['product_groups', 'customer_groups'], columns: 2 },
    { label: 'Who may sell here', fields: ['users'], columns: 1 },
  ],
  list: { columns: ['name', 'store', 'customer', 'active'], sort: 'name', filters: ['store', 'active'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};
