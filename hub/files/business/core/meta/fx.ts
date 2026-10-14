// Foreign currency (phase 5b): exchange rates, and the currency fields on the masters that have one (customer,
// supplier, account, price list, pricing rule, company). Kept in this one file, added to the definitions they belong
// to, so the other definition files stay easy to merge. The books are kept in TZS (core/money/fx.ts).
import type { DocDef, Field } from './types.ts';
import { ALL } from './types.ts';
import { account, company } from './setup.ts';
import { customer, supplier } from './parties.ts';
import { price_list, price_rule } from './products.ts';

/** Currencies a customer, supplier, account or price list may be kept in. TZS first: the books' own. */
export const CURRENCIES = ['TZS', 'USD', 'EUR', 'GBP', 'KES', 'UGX', 'RWF', 'BIF', 'ZMW', 'MWK', 'MZN', 'CDF', 'ZAR', 'AED', 'CNY', 'INR', 'JPY', 'CHF', 'SAR'];
const FOREIGN = CURRENCIES.filter((c) => c !== 'TZS');

/** One exchange rate (ERPNext Currency Exchange): TZS for 1 unit of a currency from a date on, for buying, selling or
 *  both. A new document takes the newest rate on or before its date (the rate stays editable on the document). */
export const currency_exchange: DocDef = {
  type: 'currency_exchange', label: 'Exchange rate', plural: 'Exchange rates', module: 'money',
  icon: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  title: 'from_currency', subtitle: 'date',
  description: 'TZS for one dollar (or other currency) from a date on; new documents in that currency start with it.',
  naming: { by: 'series', prefix: 'FX-', digits: 5 },
  fields: [
    { key: 'date', label: 'From date', type: 'date', required: true },
    { key: 'from_currency', label: 'Currency', type: 'select', options: FOREIGN, required: true, default: 'USD' },
    { key: 'to_currency', label: 'In', type: 'select', options: ['TZS'], default: 'TZS', readOnly: true, info: 'Rates are always in TZS, the books’ currency' },
    { key: 'rate', label: 'TZS for 1', type: 'number', required: true, min: 0.000001, help: 'E.g. 2,560 for one US dollar (the bank’s rate).' },
    { key: 'for_buying', label: 'For buying', type: 'check', default: true, help: 'Supplier bills, goods arrived, payments to suppliers.' },
    { key: 'for_selling', label: 'For selling', type: 'check', default: true, help: 'Quotations, orders, deliveries, sales, payments from customers.' },
  ],
  sections: [{ label: 'Exchange rate', fields: ['date', 'from_currency', 'to_currency', 'rate', 'for_buying', 'for_selling'], columns: 2 }],
  list: { columns: ['date', 'from_currency', 'rate', 'for_buying', 'for_selling'], sort: 'date', dir: 'desc', filters: ['from_currency', 'for_buying', 'for_selling'] },
  roles: { read: ALL, write: ['manager', 'accountant'], delete: ['manager', 'accountant'] },
};

const add = (def: DocDef, fields: Field[], section: string, at?: string): void => {
  def.fields.push(...fields);
  const s = def.sections.find((x) => x.label === section);
  if (s) {
    const i = at ? s.fields.indexOf(at) : -1;
    s.fields.splice(i >= 0 ? i + 1 : s.fields.length, 0, ...fields.map((f) => f.key));
  } else def.sections.push({ label: section, fields: fields.map((f) => f.key), columns: 2 });
};

// customers and suppliers: the currency they are kept in (all their documents are in it, ERPNext default_currency)
const partyCurrency = (who: string): Field => ({ key: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, default: 'TZS',
  help: `TZS, or e.g. USD for ${who}: all their documents are in it, and what they owe is kept in it too. Cannot change once they have documents.` });
add(customer, [partyCurrency('a customer abroad')], 'Prices and credit', 'price_list');
Object.assign(supplier.fields.find((f) => f.key === 'currency')!, { ...partyCurrency('an overseas supplier'), required: true });
delete supplier.fields.find((f) => f.key === 'currency')!.soon;

// accounts: debtors and creditors may be kept in another currency (a USD customer's or supplier's account)
account.fields.find((f) => f.key === 'account_type')!.options!.push('Exchange Gain/Loss');
add(account, [{ key: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, default: 'TZS',
  help: 'TZS for almost every account. A debtors or creditors account in USD holds what USD customers or suppliers owe.' }], 'Account', 'account_type');

// price lists in another currency (an overseas supplier's prices); pricing rules for documents in one currency
const pl = price_list.fields.find((f) => f.key === 'currency')!;
pl.options = CURRENCIES;
pl.help = 'The currency of its prices. A sale or bill in another currency converts them at its exchange rate.';
delete pl.soon;
add(price_rule, [{ key: 'currency', label: 'For documents in', type: 'select', options: CURRENCIES, default: 'TZS',
  help: 'The rule applies to sales in this currency only (its prices and amounts are in it).' }], 'Who');

// the company: where exchange differences go, and how old a rate may be
const cur = company.fields.find((f) => f.key === 'currency')!;
cur.info = 'The books are kept in TZS; customers and suppliers may be kept in USD or another currency (their own currency field)';
add(company, [
  { key: 'exchange_gain_loss_account', label: 'Exchange gain or loss', type: 'link', to: 'account', filter: { is_group: false },
    help: 'Where the difference goes when a USD bill or sale is paid at another rate than it was booked at.' },
  { key: 'rate_days', label: 'Use an exchange rate for at most', type: 'number', min: 0, integer: true,
    help: 'Days after its date. Older rates are not filled in: type the rate on the document. Empty: the newest rate, however old.' },
  { key: 'bill_rate_on_bill_date', label: 'Bills made from purchase orders take the bill date’s rate', type: 'check', default: false,
    help: 'Off: a bill made from an order keeps the order’s exchange rate.' },
], 'Foreign currency');
