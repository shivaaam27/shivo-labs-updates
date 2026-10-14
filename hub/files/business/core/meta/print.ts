// Printing (phase 4e): the words at the top of a printed document (ERPNext Print Heading), terms printed at the bottom
// (ERPNext Terms and Conditions) and the letter head (ERPNext Letter Head). The company's own details (name, address,
// TIN, VRN, phone, email) come from Setup > Company on every print; a letter head adds lines above and a footer below.
// We have no picture uploads yet, so there is no logo (ERPNext's letter head image). The print pages are
// shared/biz/print.js, their data store/print.ts. Pure data.
import type { DocDef } from './types.ts';
import { ALL } from './types.ts';

const PRINT_ICON = '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>';

export const print_heading: DocDef = {
  type: 'print_heading', label: 'Print heading', plural: 'Print headings', module: 'setup',
  icon: PRINT_ICON,
  title: 'name', subtitle: 'description',
  description: 'Words printed at the top of a document instead of its usual title, e.g. Proforma invoice or Cash sale.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Heading', type: 'text', required: true, unique: true, search: true, help: 'Printed large at the top, e.g. Proforma invoice.' },
    { key: 'description', label: 'Description', type: 'longtext', help: 'For people choosing it: when to use this heading.' },
  ],
  sections: [{ label: 'Print heading', fields: ['name', 'description'], columns: 1 }],
  list: { columns: ['name', 'description'], sort: 'name', filters: [] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const terms: DocDef = {
  type: 'terms', label: 'Terms and conditions', plural: 'Terms and conditions', module: 'setup',
  icon: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 12h6M10 15h6M10 18h4"/>',
  title: 'name',
  description: 'Terms printed at the bottom of quotations, orders, deliveries, invoices and purchase orders: payment, delivery, returns.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true, help: 'E.g. Wholesale terms, Cash sale terms.' },
    { key: 'text', label: 'Terms', type: 'longtext', required: true,
      help: 'As printed. Copied onto each document when it is made, where it can still be changed for that document.' },
    { key: 'selling', label: 'For selling documents', type: 'check', default: true, help: 'Offered on quotations, orders, deliveries and sales.' },
    { key: 'buying', label: 'For buying documents', type: 'check', default: false, help: 'Offered on stock requests, supplier quotations, purchase orders, goods arrived and supplier bills.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Terms and conditions', fields: ['name', 'selling', 'buying', 'active', 'text'], columns: 2 }],
  list: { columns: ['name', 'selling', 'buying', 'active'], sort: 'name', filters: ['selling', 'buying', 'active'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const letter_head: DocDef = {
  type: 'letter_head', label: 'Letter head', plural: 'Letter heads', module: 'setup',
  icon: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 10h5M8 17h8"/>',
  title: 'name',
  description: 'The top and bottom of printed documents. Your business name, address, TIN, VRN, phone and email come from Setup > Company.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true, help: 'E.g. Main letter head, Kariakoo branch.' },
    { key: 'show_company', label: 'Print the business details', type: 'check', default: true,
      help: 'Name, address, phone, email, TIN and VRN from Setup > Company, at the top.' },
    { key: 'header', label: 'Lines at the top', type: 'longtext', help: 'Printed under the business details, e.g. “Wholesale of rice, sugar and cooking oil”.' },
    { key: 'footer', label: 'Lines at the bottom', type: 'longtext', help: 'E.g. bank account for payments, or “Goods once sold are not returnable”.' },
    { key: 'is_default', label: 'Use on every document', type: 'check', default: false,
      help: 'Used when neither the document, the till nor Setup > Company names a letter head.' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Letter head', fields: ['name', 'is_default', 'show_company', 'active'], columns: 2 },
    { label: 'What is printed', fields: ['header', 'footer'], columns: 1 },
  ],
  list: { columns: ['name', 'is_default', 'active'], sort: 'name', filters: ['active'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};
