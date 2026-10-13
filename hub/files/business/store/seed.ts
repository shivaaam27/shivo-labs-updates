// First-run setup for a Tanzanian business: the company from the setup screen, plus a ready template
// (units, payment methods, VAT, a simple chart of accounts, price lists, groups, a main store) and the owner.
// Everything is created through saveDoc, so the template obeys the same definitions as anything typed in later.
import { getDef } from '../core/meta/index.ts';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { fail, HttpError } from './errors.ts';
import type { Data } from './docs.ts';
import { loadSingle, saveDoc } from './docs.ts';
import { checkPinShape, hashPin, storePin } from './users.ts';

export const UNITS: [string, boolean][] = [
  ['Pcs', true], ['Kg', false], ['g', false], ['L', false], ['ml', false],
  ['Carton', true], ['Box', true], ['Dozen', true], ['Bag', true], ['Bundle', true],
];

type Acc = [number: string, name: string, parent: string, root: string, type: string, group: boolean];
// A simple Tanzanian chart of accounts (01 §1.1 starter template, cut to what shops and wholesalers use).
export const ACCOUNTS: Acc[] = [
  ['1000', 'Assets', '', 'Asset', '', true],
  ['1100', 'Current Assets', '1000', 'Asset', '', true],
  ['1110', 'Cash In Hand', '1100', 'Asset', 'Cash', true],
  ['1111', 'Cash', '1110', 'Asset', 'Cash', false],
  ['1120', 'Mobile Money', '1100', 'Asset', 'Mobile Money', true],
  ['1121', 'M-Pesa', '1120', 'Asset', 'Mobile Money', false],
  ['1122', 'Mixx by Yas', '1120', 'Asset', 'Mobile Money', false],
  ['1123', 'Airtel Money', '1120', 'Asset', 'Mobile Money', false],
  ['1124', 'HaloPesa', '1120', 'Asset', 'Mobile Money', false],
  ['1130', 'Bank Accounts', '1100', 'Asset', 'Bank', true],
  ['1131', 'Bank', '1130', 'Asset', 'Bank', false],
  ['1132', 'Card Payments Clearing', '1130', 'Asset', 'Bank', false],
  ['1140', 'Debtors', '1100', 'Asset', 'Receivable', false],
  ['1150', 'Stock In Hand', '1100', 'Asset', 'Stock', false],
  ['1160', 'VAT Input', '1100', 'Asset', 'Tax', false],
  ['1170', 'Withholding Tax Receivable', '1100', 'Asset', 'Tax', false],
  ['1200', 'Fixed Assets', '1000', 'Asset', '', true],
  ['1210', 'Furniture and Equipment', '1200', 'Asset', '', false],
  ['1220', 'Vehicles', '1200', 'Asset', '', false],
  ['1900', 'Temporary Opening', '1000', 'Asset', 'Temporary', false],
  ['2000', 'Liabilities', '', 'Liability', '', true],
  ['2100', 'Current Liabilities', '2000', 'Liability', '', true],
  ['2110', 'Creditors', '2100', 'Liability', 'Payable', false],
  ['2120', 'VAT Output', '2100', 'Liability', 'Tax', false],
  ['2130', 'Withholding Tax Payable', '2100', 'Liability', 'Tax', false],
  ['2140', 'Stock Received Not Billed', '2100', 'Liability', 'Stock Received But Not Billed', false],
  ['2150', 'Salaries Payable', '2100', 'Liability', '', false],
  ['2160', 'PAYE, NSSF, SDL and WCF Payable', '2100', 'Liability', 'Tax', false],
  ['2200', 'Loans', '2000', 'Liability', '', true],
  ['2210', 'Bank Loans', '2200', 'Liability', '', false],
  ['3000', 'Equity', '', 'Equity', '', true],
  ['3100', 'Capital', '3000', 'Equity', 'Equity', false],
  ['3200', 'Opening Balance Equity', '3000', 'Equity', 'Equity', false],
  ['3300', 'Retained Earnings', '3000', 'Equity', 'Equity', false],
  ['3400', 'Owner Drawings', '3000', 'Equity', 'Equity', false],
  ['4000', 'Income', '', 'Income', '', true],
  ['4100', 'Sales', '4000', 'Income', 'Income Account', false],
  ['4200', 'Service Income', '4000', 'Income', 'Income Account', false],
  ['4300', 'Other Income', '4000', 'Income', 'Income Account', false],
  ['5000', 'Expenses', '', 'Expense', '', true],
  ['5100', 'Direct Expenses', '5000', 'Expense', '', true],
  ['5110', 'Cost of Goods Sold', '5100', 'Expense', 'Cost of Goods Sold', false],
  ['5120', 'Stock Adjustment', '5100', 'Expense', 'Stock Adjustment', false],
  ['5130', 'Freight and Landed Costs', '5100', 'Expense', 'Expenses Included In Valuation', false],
  ['5200', 'Indirect Expenses', '5000', 'Expense', '', true],
  ['5210', 'Rent', '5200', 'Expense', 'Expense Account', false],
  ['5220', 'Salaries and Wages', '5200', 'Expense', 'Expense Account', false],
  ['5230', 'Electricity and Water', '5200', 'Expense', 'Expense Account', false],
  ['5240', 'Telephone and Internet', '5200', 'Expense', 'Expense Account', false],
  ['5250', 'Transport and Fuel', '5200', 'Expense', 'Expense Account', false],
  ['5260', 'Bank and Mobile Money Charges', '5200', 'Expense', 'Expense Account', false],
  ['5270', 'Repairs and Maintenance', '5200', 'Expense', 'Expense Account', false],
  ['5280', 'Licences and Levies', '5200', 'Expense', 'Expense Account', false],
  ['5290', 'Shop and Office Supplies', '5200', 'Expense', 'Expense Account', false],
  ['5295', 'Round Off', '5200', 'Expense', 'Round Off', false],
  ['5296', 'Write Off', '5200', 'Expense', 'Expense Account', false],
];

export const PAYMENT_METHODS: [string, string, string][] = [
  ['Cash', 'Cash', '1111'], ['M-Pesa', 'Mobile money', '1121'], ['Mixx by Yas', 'Mobile money', '1122'],
  ['Airtel Money', 'Mobile money', '1123'], ['HaloPesa', 'Mobile money', '1124'],
  ['Bank Transfer', 'Bank', '1131'], ['Card', 'Card', '1132'],
];

const def = (type: string) => getDef(type)!;

/** POST /setup { company: {name, tin, …}, owner: {name, pin} }. Returns the owner's user id. */
export async function setupBusiness(db: DB, body: Data): Promise<string> {
  if (loadSingle(db, 'company')) fail(409, 'The business is already set up');
  const company = (body?.company && typeof body.company === 'object' ? body.company : {}) as Data;
  const owner = (body?.owner && typeof body.owner === 'object' ? body.owner : {}) as Data;
  const ownerName = typeof owner.name === 'string' ? owner.name.trim() : '';
  if (!ownerName) fail(422, 'Enter the owner\'s name', { errors: { 'owner.name': 'Required' } });
  let pin: string;
  try { pin = checkPinShape(owner.pin); } catch (e) {
    if (e instanceof HttpError) fail(422, e.message, { errors: { 'owner.pin': e.message } });
    throw e;
  }
  const hash = await hashPin(pin!);
  if (loadSingle(db, 'company')) fail(409, 'The business is already set up');

  return tx(db, () => {
    const ownerDoc = prefixed('owner', () => saveDoc(db, def('user'), { name: ownerName, role: 'Owner', phone: owner.phone, active: true }, null));
    const by = ownerDoc.id as string;
    storePin(db, by, hash);
    const save = (type: string, doc: Data) => saveDoc(db, def(type), doc, by);

    for (const [name, whole] of UNITS) save('unit', { name, whole_number: whole });
    const acc: Record<string, string> = {};
    for (const [number, name, parent, root, type, group] of ACCOUNTS) {
      acc[number] = save('account', { number, name, parent: parent ? acc[parent] : null, root_type: root, account_type: type, is_group: group }).id as string;
    }
    for (const [name, type, number] of PAYMENT_METHODS) save('payment_method', { name, type, account: acc[number] });
    save('tax', { name: 'VAT 18%', type: 'VAT', rate: 18, account: acc['2120'], input_account: acc['1160'] });
    save('tax', { name: 'VAT 16% (electronic payment)', type: 'VAT', rate: 16, account: acc['2120'], input_account: acc['1160'], to_confirm: true,
      notes: 'Lower VAT rate for sales paid electronically (mobile money, card, bank). Rules and start date to be confirmed with TRA before use.' });
    const retail = save('price_list', { name: 'Retail', type: 'Selling' }).id;
    save('price_list', { name: 'Wholesale', type: 'Selling' });
    const buying = save('price_list', { name: 'Buying', type: 'Buying' }).id;
    save('product_group', { name: 'All Products' });
    save('customer_group', { name: 'All Customers' });
    save('supplier_group', { name: 'All Suppliers' });
    const store = save('store', { name: 'Main Store', type: 'Store' }).id;

    prefixed('company', () => save('company', {
        ...company, default_store: store, selling_price_list: retail, buying_price_list: buying,
        cash_account: acc['1111'], receivable_account: acc['1140'], payable_account: acc['2110'], income_account: acc['4100'],
        cogs_account: acc['5110'], stock_account: acc['1150'], stock_adjustment_account: acc['5120'], srbnb_account: acc['2140'],
        landed_cost_account: acc['5130'], round_off_account: acc['5295'],
      }));
    return by;
  });
}

/** Field errors are shown on the setup form as company.<field> and owner.<field>. */
function prefixed<T>(prefix: string, fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof HttpError && e.extra.errors) {
      const errors: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.extra.errors as Record<string, string>)) errors[`${prefix}.${k}`] = v;
      throw new HttpError(422, e.message, { errors });
    }
    throw e;
  }
}
