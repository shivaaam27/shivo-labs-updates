// Product definitions: product (with its barcodes, units and reorder tables), groups, brands, price lists and prices.
import type { DocDef } from './types.ts';
import { ALL } from './types.ts';

const STOCK_WRITE = ['manager', 'storekeeper'] as DocDef['roles']['write'];

export const product_barcode: DocDef = {
  type: 'product_barcode', label: 'Barcode', plural: 'Barcodes', module: 'products', child: true,
  icon: '<path d="M4 6v12M7 6v12M10 6v12M14 6v12M16 6v12M20 6v12"/>',
  title: 'barcode', naming: { by: 'field', field: 'barcode' },
  fields: [
    { key: 'barcode', label: 'Barcode', type: 'text', required: true, unique: true, search: true, help: 'The number under the bars (EAN/UPC). One product can have several.' },
  ],
  sections: [{ label: 'Barcode', fields: ['barcode'] }],
  list: { columns: ['barcode'], sort: 'barcode', filters: [] },
  roles: { read: ALL, write: STOCK_WRITE, delete: STOCK_WRITE },
};

export const product_unit: DocDef = {
  type: 'product_unit', label: 'Other unit', plural: 'Other units', module: 'products', child: true,
  icon: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/>',
  title: 'unit', naming: { by: 'field', field: 'unit' },
  fields: [
    { key: 'unit', label: 'Unit', type: 'link', to: 'unit', required: true, unique: 'table' },
    { key: 'factor', label: 'How many stock units', type: 'number', required: true, min: 0.001, help: 'E.g. a carton of 24 pieces: 24.', soon: 'Phase 6 (Stock extras): buying and selling by the carton' },
  ],
  sections: [{ label: 'Other unit', fields: ['unit', 'factor'], columns: 2 }],
  list: { columns: ['unit', 'factor'], sort: 'unit', filters: [] },
  roles: { read: ALL, write: STOCK_WRITE, delete: STOCK_WRITE },
};

export const product_reorder: DocDef = {
  type: 'product_reorder', label: 'Reorder rule', plural: 'Reorder rules', module: 'products', child: true,
  icon: '<path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2"/>',
  title: 'store', naming: { by: 'field', field: 'store' },
  fields: [
    { key: 'store', label: 'Store or van', type: 'link', to: 'store', required: true, unique: 'table' },
    { key: 'level', label: 'Reorder when below', type: 'number', required: true, min: 0, help: 'Stock level (in stock units) that triggers a reorder suggestion.' },
    { key: 'qty', label: 'Order this many', type: 'number', required: true, min: 0 },
    { key: 'request_type', label: 'Get it by', type: 'select', options: ['', 'Purchase', 'Transfer'], default: '', help: 'Buying it, or moving it from another store. Empty: as set on the product.' },
  ],
  sections: [{ label: 'Reorder rule', fields: ['store', 'level', 'qty', 'request_type'], columns: 2 }],
  list: { columns: ['store', 'level', 'qty', 'request_type'], sort: 'store', filters: [] },
  roles: { read: ALL, write: STOCK_WRITE, delete: STOCK_WRITE },
};

export const product_supplier: DocDef = {
  type: 'product_supplier', label: 'Supplier of it', plural: 'Suppliers of it', module: 'products', child: true,
  icon: '<path d="M2 7h11v9H2zM13 10h4l3 3v3h-7z"/>',
  title: 'supplier', naming: { by: 'field', field: 'supplier' },
  fields: [
    { key: 'supplier', label: 'Supplier', type: 'link', to: 'supplier', required: true, unique: 'table' },
    { key: 'code', label: 'Their code for it', type: 'text', help: 'The code on their price list and bills.' },
  ],
  sections: [{ label: 'Supplier of it', fields: ['supplier', 'code'], columns: 2 }],
  list: { columns: ['supplier', 'code'], sort: 'supplier', filters: [] },
  roles: { read: ALL, write: STOCK_WRITE, delete: STOCK_WRITE },
};

export const product: DocDef = {
  type: 'product', label: 'Product', plural: 'Products', module: 'products',
  icon: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  title: 'name', subtitle: 'code',
  description: 'Everything you buy, sell or keep in stock.',
  naming: { by: 'field', field: 'code' },
  fields: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: true, search: true, help: 'Short code you use for the product, e.g. RICE-5KG.' },
    { key: 'name', label: 'Name', type: 'text', required: true, search: true },
    { key: 'short_name', label: 'Short name', type: 'text', help: 'For the till buttons (and receipts), e.g. "Sugar 1kg". Empty: the name.' },
    { key: 'group', label: 'Group', type: 'link', to: 'product_group', required: true, default: 'All Products' },
    { key: 'brand', label: 'Brand', type: 'link', to: 'brand', info: 'Sorting and filtering products; brand reports come in phase 7' },
    { key: 'stock_unit', label: 'Stock unit', type: 'link', to: 'unit', required: true, default: 'Pcs', lockOnStock: true,
      help: 'The unit stock is counted in. Cannot change once the product has stock movements.' },
    { key: 'valuation_method', label: 'Cost method', type: 'select', options: ['Moving Average', 'FIFO'], required: true, default: 'Moving Average', lockOnStock: true,
      help: 'Moving Average: one average cost. FIFO: first in, first out (the oldest stock is sold first). Cannot change once the product has stock movements.' },
    { key: 'is_stock', label: 'Keep stock', type: 'check', default: true, lockOnStock: true, help: 'Off for services and things you do not count.' },
    { key: 'can_sell', label: 'Can be sold', type: 'check', default: true },
    { key: 'can_buy', label: 'Can be bought', type: 'check', default: true },
    { key: 'vat_category', label: 'VAT', type: 'select', options: ['Standard rate (18%)', 'Zero-rated', 'Exempt'], required: true, default: 'Standard rate (18%)',
      help: 'Zero-rated and exempt goods are listed in the VAT Act schedules (e.g. some basic foods).' },
    { key: 'barcodes', label: 'Barcodes', type: 'table', of: 'product_barcode', info: 'Scanned at the till and in the scan box of sales, quotations, orders and deliveries; found by any product search' },
    { key: 'units', label: 'Other units', type: 'table', of: 'product_unit', help: 'E.g. Carton = 24 Pcs, so you can buy and sell by the carton.' },
    { key: 'reorder', label: 'Reorder per store', type: 'table', of: 'product_reorder', help: 'When stock (counting what is ordered and asked for) falls below the level, it is on the reorder suggestions.' },
    { key: 'request_type', label: 'Reorder by', type: 'select', options: ['Purchase', 'Transfer'], default: 'Purchase', help: 'Buying it from a supplier, or moving it from another store.' },
    { key: 'safety_stock', label: 'Safety stock', type: 'number', min: 0, help: 'Kept in reserve: the reorder suggestion orders enough to stay above it.' },
    { key: 'lead_time_days', label: 'Days to arrive', type: 'number', min: 0, integer: true, help: 'Days from ordering to arrival; sets the required-by date of a reorder.' },
    { key: 'min_order_qty', label: 'Order at least', type: 'number', min: 0, help: 'The least a purchase order may ask for.' },
    { key: 'over_delivery', label: 'Deliver or receive up to % more', type: 'percent', min: 0, max: 100, help: 'For this product only. Empty: the company rule.' },
    { key: 'over_billing', label: 'Bill up to % more', type: 'percent', min: 0, max: 100, help: 'For this product only. Empty: the company rule.' },
    { key: 'suppliers', label: 'Suppliers of it', type: 'table', of: 'product_supplier', help: 'Who sells it, with their own code for it.' },
    { key: 'max_discount', label: 'Max discount %', type: 'percent', min: 0, max: 100, help: 'A bigger discount on this product is refused. Empty: no limit of its own.' },
    { key: 'needs_manager', label: 'Only a manager sells it at the till', type: 'check', default: false,
      help: 'E.g. alcohol or medicines: a cashier at a till cannot sell it; the owner or a manager can.' },
    { key: 'expense_account', label: 'Expense account', type: 'link', to: 'account', filter: { is_group: false, root_type: 'Expense' },
      help: 'For services you buy (rent, transport, fuel): the account their bills are booked to. Empty: Other expenses (Setup).' },
    { key: 'default_supplier', label: 'Usual supplier', type: 'link', to: 'supplier', help: 'Reorder suggestions make the purchase order to them.' },
    { key: 'batch_tracked', label: 'Track batches', type: 'check', default: false, soon: 'Phase 6 (Stock extras): batch numbers on goods arrived, sales and counts' },
    { key: 'has_expiry', label: 'Has expiry date', type: 'check', default: false, soon: 'Phase 6 (Stock extras): expiry dates and the expiring-stock list' },
    { key: 'customs_tariff', label: 'HS code', type: 'link', to: 'customs_tariff', help: 'Its customs tariff number, for imports: shares the duty on a shipment by its duty rate.' },
    { key: 'country_of_origin', label: 'Country of origin', type: 'text', help: 'Where it is made, for customs papers.' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Product', fields: ['name', 'short_name', 'code', 'group', 'brand', 'stock_unit', 'vat_category', 'can_sell', 'can_buy', 'needs_manager', 'active'], columns: 2 },
    { label: 'Imports', fields: ['customs_tariff', 'country_of_origin'], columns: 2 },
    { label: 'Stock', fields: ['is_stock', 'valuation_method', 'max_discount', 'expense_account', 'default_supplier', 'batch_tracked', 'has_expiry'], columns: 2 },
    { label: 'Barcodes', fields: ['barcodes'], columns: 1 },
    { label: 'Units', fields: ['units'], columns: 1 },
    { label: 'Buying', fields: ['request_type', 'min_order_qty', 'lead_time_days', 'safety_stock', 'over_delivery', 'over_billing'], columns: 2 },
    { label: 'Reorder', fields: ['reorder'], columns: 1 },
    { label: 'Suppliers', fields: ['suppliers'], columns: 1 },
    { label: 'Notes', fields: ['notes'], columns: 1 },
  ],
  list: { columns: ['name', 'code', 'group', 'brand', 'stock_unit', 'active'], sort: 'name', filters: ['group', 'brand', 'valuation_method', 'is_stock', 'active'] },
  related: [{ type: 'item_price', by: 'product', label: 'Prices' }],
  roles: { read: ALL, write: STOCK_WRITE, delete: ['manager'] },
};

export const product_group: DocDef = {
  type: 'product_group', label: 'Product group', plural: 'Product groups', module: 'products',
  icon: '<path d="M4 6h6v6H4zM14 6h6v6h-6zM4 16h6v4H4zM14 16h6v4h-6z"/>',
  title: 'name',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'parent', label: 'Under', type: 'link', to: 'product_group' },
  ],
  sections: [{ label: 'Product group', fields: ['name', 'parent'], columns: 2 }],
  list: { columns: ['name', 'parent'], sort: 'name', filters: ['parent'] },
  related: [{ type: 'product', by: 'group', label: 'Products' }],
  roles: { read: ALL, write: STOCK_WRITE, delete: ['manager'] },
};

export const brand: DocDef = {
  type: 'brand', label: 'Brand', plural: 'Brands', module: 'products',
  icon: '<path d="M4 4h8l8 8-8 8-8-8z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  title: 'name',
  naming: { by: 'field', field: 'name' },
  fields: [{ key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true }],
  sections: [{ label: 'Brand', fields: ['name'], columns: 2 }],
  list: { columns: ['name'], sort: 'name', filters: [] },
  related: [{ type: 'product', by: 'brand', label: 'Products' }],
  roles: { read: ALL, write: STOCK_WRITE, delete: ['manager'] },
};

export const price_list: DocDef = {
  type: 'price_list', label: 'Price list', plural: 'Price lists', module: 'products',
  icon: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  title: 'name', subtitle: 'type',
  description: 'Sets of prices, e.g. Retail and Wholesale.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'type', label: 'Used for', type: 'select', options: ['Selling', 'Buying'], required: true, default: 'Selling' },
    { key: 'currency', label: 'Currency', type: 'select', options: ['TZS', 'USD'], required: true, default: 'TZS', help: 'USD lists are for buying from overseas.', soon: 'Phase 5 (Buy): prices and bills in USD' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Price list', fields: ['name', 'type', 'currency', 'active'], columns: 2 }],
  list: { columns: ['name', 'type', 'currency', 'active'], sort: 'name', filters: ['type', 'active'] },
  related: [{ type: 'item_price', by: 'price_list', label: 'Prices' }, { type: 'customer', by: 'price_list', label: 'Customers' }],
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

/** Pricing rules (03 §2.4, ERPNext Pricing Rule, core kinds): for a product, a product group or a brand, for any
 *  customer, one customer or a customer group, from a quantity up: a fixed price, a discount % or a discount amount. */
export const price_rule: DocDef = {
  type: 'price_rule', label: 'Pricing rule', plural: 'Pricing rules', module: 'products',
  icon: '<path d="M7 7h.01M3 3h8l10 10-8 8L3 11z"/>',
  title: 'name', subtitle: 'action',
  description: 'Quantity prices and discounts for customers or groups, e.g. 5 % off 10 cartons and more.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'applies_to', label: 'Applies to', type: 'select', options: ['Product', 'Product group', 'Brand'], required: true, default: 'Product' },
    { key: 'product', label: 'Product', type: 'link', to: 'product', help: 'When it applies to a product.' },
    { key: 'product_group', label: 'Product group', type: 'link', to: 'product_group', help: 'When it applies to a group (and the groups under it).' },
    { key: 'brand', label: 'Brand', type: 'link', to: 'brand', help: 'When it applies to a brand.' },
    { key: 'for', label: 'For', type: 'select', options: ['Any customer', 'Customer', 'Customer group', 'Route', 'Any supplier', 'Supplier', 'Supplier group'], required: true, default: 'Any customer',
      help: 'Customers: on sales, quotations and orders. Suppliers: on purchase orders and bills (their quantity discounts).' },
    { key: 'supplier', label: 'Supplier', type: 'link', to: 'supplier' },
    { key: 'supplier_group', label: 'Supplier group', type: 'link', to: 'supplier_group', help: 'The group and the groups under it.' },
    { key: 'route', label: 'Route', type: 'link', to: 'route', help: 'Customers of this route and the routes inside it.' },
    { key: 'customer', label: 'Customer', type: 'link', to: 'customer' },
    { key: 'customer_group', label: 'Customer group', type: 'link', to: 'customer_group', help: 'The group and the groups under it.' },
    { key: 'price_list', label: 'Only on price list', type: 'link', to: 'price_list', help: 'A selling list for customers, a buying list for suppliers. Empty: any price list.' },
    { key: 'min_qty', label: 'From quantity', type: 'number', min: 0, default: 0, help: 'In stock units, on one line.' },
    { key: 'max_qty', label: 'Up to quantity', type: 'number', min: 0, help: 'Empty: no upper limit.' },
    { key: 'action', label: 'Gives', type: 'select', options: ['Fixed price', 'Discount %', 'Discount amount'], required: true, default: 'Discount %' },
    { key: 'value', label: 'Price, % or amount', type: 'number', required: true, min: 0 },
    { key: 'valid_from', label: 'Valid from', type: 'date' },
    { key: 'valid_to', label: 'Valid until', type: 'date' },
    { key: 'priority', label: 'Priority', type: 'number', min: 0, max: 20, integer: true, default: 0, help: 'When two rules fit, the higher one wins; two at the same priority are refused at the sale.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Pricing rule', fields: ['name', 'active', 'priority'], columns: 3 },
    { label: 'What', fields: ['applies_to', 'product', 'product_group', 'brand'], columns: 2 },
    { label: 'Who', fields: ['for', 'customer', 'customer_group', 'route', 'supplier', 'supplier_group', 'price_list'], columns: 2 },
    { label: 'When', fields: ['min_qty', 'max_qty', 'valid_from', 'valid_to'], columns: 2 },
    { label: 'Gives', fields: ['action', 'value'], columns: 2 },
  ],
  list: { columns: ['name', 'applies_to', 'for', 'min_qty', 'action', 'value', 'active'], sort: 'name', filters: ['applies_to', 'for', 'action', 'active'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const item_price: DocDef = {
  type: 'item_price', label: 'Price', plural: 'Prices', module: 'products',
  icon: '<path d="M12 3v18M16 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7"/>',
  title: 'product', subtitle: 'price_list',
  description: 'The price of a product in a price list, per unit and for a period.',
  naming: { by: 'series', prefix: 'PRICE-', digits: 5 },
  fields: [
    { key: 'product', label: 'Product', type: 'link', to: 'product', required: true },
    { key: 'price_list', label: 'Price list', type: 'link', to: 'price_list', required: true },
    { key: 'unit', label: 'Unit', type: 'link', to: 'unit', help: 'Empty: the product\'s stock unit.' },
    { key: 'customer', label: 'Only for customer', type: 'link', to: 'customer', help: 'A price for this customer only; others get the list price.' },
    { key: 'supplier', label: 'Only from supplier', type: 'link', to: 'supplier', help: 'A buying price this supplier gave; others get the list price.' },
    { key: 'lead_time_days', label: 'Days to arrive', type: 'number', min: 0, integer: true, help: 'How long this supplier takes at this price.' },
    { key: 'rate', label: 'Price', type: 'money', required: true, min: 0 },
    { key: 'valid_from', label: 'Valid from', type: 'date' },
    { key: 'valid_to', label: 'Valid until', type: 'date', help: 'Empty: no end date.' },
  ],
  sections: [{ label: 'Price', fields: ['product', 'price_list', 'unit', 'customer', 'supplier', 'rate', 'lead_time_days', 'valid_from', 'valid_to'], columns: 2 }],
  list: { columns: ['product', 'price_list', 'unit', 'rate', 'valid_from', 'valid_to'], sort: 'modified', dir: 'desc', filters: ['product', 'price_list'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};
