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
    { key: 'factor', label: 'How many stock units', type: 'number', required: true, min: 0.001, help: 'E.g. a carton of 24 pieces: 24.' },
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
  ],
  sections: [{ label: 'Reorder rule', fields: ['store', 'level', 'qty'], columns: 3 }],
  list: { columns: ['store', 'level', 'qty'], sort: 'store', filters: [] },
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
    { key: 'group', label: 'Group', type: 'link', to: 'product_group', required: true, default: 'All Products' },
    { key: 'brand', label: 'Brand', type: 'link', to: 'brand' },
    { key: 'stock_unit', label: 'Stock unit', type: 'link', to: 'unit', required: true, default: 'Pcs', lockOnStock: true,
      help: 'The unit stock is counted in. Cannot change once the product has stock movements.' },
    { key: 'valuation_method', label: 'Cost method', type: 'select', options: ['Moving Average', 'FIFO'], required: true, default: 'Moving Average', lockOnStock: true,
      help: 'Moving Average: one average cost. FIFO: first in, first out (the oldest stock is sold first). Cannot change once the product has stock movements.' },
    { key: 'is_stock', label: 'Keep stock', type: 'check', default: true, lockOnStock: true, help: 'Off for services and things you do not count.' },
    { key: 'can_sell', label: 'Can be sold', type: 'check', default: true },
    { key: 'can_buy', label: 'Can be bought', type: 'check', default: true },
    { key: 'vat_category', label: 'VAT', type: 'select', options: ['Standard rate (18%)', 'Zero-rated', 'Exempt'], required: true, default: 'Standard rate (18%)',
      help: 'Zero-rated and exempt goods are listed in the VAT Act schedules (e.g. some basic foods).' },
    { key: 'barcodes', label: 'Barcodes', type: 'table', of: 'product_barcode' },
    { key: 'units', label: 'Other units', type: 'table', of: 'product_unit', help: 'E.g. Carton = 24 Pcs, so you can buy and sell by the carton.' },
    { key: 'reorder', label: 'Reorder per store', type: 'table', of: 'product_reorder', help: 'The suggestions list built from these rules comes with the Buy phase.' },
    { key: 'default_supplier', label: 'Usual supplier', type: 'link', to: 'supplier', help: 'Shown on its product page; reorder suggestions use it (Buy phase).' },
    { key: 'batch_tracked', label: 'Track batches', type: 'check', default: false, help: 'Batch numbers on goods arrived and sales come with the Stock extras phase; the switch is kept for then.' },
    { key: 'has_expiry', label: 'Has expiry date', type: 'check', default: false, help: 'Expiry dates and the expiring-stock list come with the Stock extras phase.' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Product', fields: ['name', 'code', 'group', 'brand', 'stock_unit', 'vat_category', 'can_sell', 'can_buy', 'active'], columns: 2 },
    { label: 'Stock', fields: ['is_stock', 'valuation_method', 'default_supplier', 'batch_tracked', 'has_expiry'], columns: 2 },
    { label: 'Barcodes', fields: ['barcodes'], columns: 1 },
    { label: 'Units', fields: ['units'], columns: 1 },
    { label: 'Reorder', fields: ['reorder'], columns: 1 },
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
    { key: 'currency', label: 'Currency', type: 'select', options: ['TZS', 'USD'], required: true, default: 'TZS', help: 'USD lists are for buying from overseas; sales and bills in USD come with the Buy phase.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Price list', fields: ['name', 'type', 'currency', 'active'], columns: 2 }],
  list: { columns: ['name', 'type', 'currency', 'active'], sort: 'name', filters: ['type', 'active'] },
  related: [{ type: 'item_price', by: 'price_list', label: 'Prices' }, { type: 'customer', by: 'price_list', label: 'Customers' }],
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
    { key: 'rate', label: 'Price', type: 'money', required: true, min: 0 },
    { key: 'valid_from', label: 'Valid from', type: 'date' },
    { key: 'valid_to', label: 'Valid until', type: 'date', help: 'Empty: no end date.' },
  ],
  sections: [{ label: 'Price', fields: ['product', 'price_list', 'unit', 'rate', 'valid_from', 'valid_to'], columns: 2 }],
  list: { columns: ['product', 'price_list', 'unit', 'rate', 'valid_from', 'valid_to'], sort: 'modified', dir: 'desc', filters: ['product', 'price_list'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};
