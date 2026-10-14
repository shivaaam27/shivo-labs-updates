// The books per real account: the engine books every row by its kind of account (role: cash, sales, debtors...) and,
// where the document names one, our own account (`ref`: the payment method's account, an expense account on a bill
// line, a journal row's account). Here each row lands on an account of the chart: the named one, else the company's
// default for that kind (Setup > Company), else the first active account "used for" that kind. Nothing is guessed
// silently: a kind with no account at all shows as "Not set up".
import type { AccountRole, Entry, Step } from '../core/contract.ts';
import { runScenario } from '../core/run.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { titlesOf } from './docs.ts';
import { loadSteps, scenarioOf, stepLabel } from './steps.ts';

const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };

/** Company field for each kind of account, and what an account must be "used for" to stand in for it. */
const DEFAULTS: Partial<Record<AccountRole, { field?: string; type?: string; name?: string }>> = {
  cash: { field: 'cash_account', type: 'Cash' },
  bank: { type: 'Bank' },
  mobile_money: { type: 'Mobile Money' },
  receivable: { field: 'receivable_account', type: 'Receivable' },
  payable: { field: 'payable_account', type: 'Payable' },
  income: { field: 'income_account', type: 'Income Account' },
  expense: { field: 'expense_account', type: 'Expense Account' },
  cost_of_goods_sold: { field: 'cogs_account', type: 'Cost of Goods Sold' },
  stock: { field: 'stock_account', type: 'Stock' },
  stock_adjustment: { field: 'stock_adjustment_account', type: 'Stock Adjustment' },
  stock_received_not_billed: { field: 'srbnb_account', type: 'Stock Received But Not Billed' },
  expenses_in_valuation: { field: 'landed_cost_account', type: 'Expenses Included In Valuation' },
  round_off: { field: 'round_off_account', type: 'Round Off' },
  write_off: { field: 'write_off_account', name: 'Write Off' },
  temporary_opening: { field: 'opening_account', type: 'Temporary' },
  capital: { type: 'Equity' },
  exchange_gain_loss: { field: 'exchange_gain_loss_account', type: 'Exchange Gain/Loss' },   // foreign currency (phase 5b)
};
const SALES_SIDE = new Set(['sales_invoice', 'credit_note']);

export interface AccountRow { id: string; title: string; number: string; root_type: string; debit: number; credit: number; balance: number }
export interface BookRow { step: string; date: string; label: string; account: string; party?: string; debit: number; credit: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Resolves rows to accounts, using the records as they are now. */
function resolver(db: DB) {
  const accounts = new Map<string, Data>();
  for (const r of db.prepare("SELECT id, data FROM docs WHERE type = 'account' AND deleted = 0 ORDER BY rowid").all() as { id: string; data: string }[]) {
    accounts.set(r.id, parse(r.data));
  }
  const co = db.prepare("SELECT data FROM docs WHERE type = 'company' AND deleted = 0 LIMIT 1").get() as { data: string } | undefined;
  const company = co ? parse(co.data) : {};
  const vat = (db.prepare("SELECT data FROM docs WHERE type = 'tax' AND deleted = 0 ORDER BY rowid").all() as { data: string }[])
    .map((r) => parse(r.data)).find((d) => d.active !== false && d.type !== 'Withholding') ?? {};
  const usable = (id: unknown): id is string => typeof id === 'string' && accounts.has(id) && accounts.get(id)!.is_group !== true;
  const byKind = new Map<string, string>();
  const forRole = (role: AccountRole, kind: string): string => {
    const key = `${role}|${SALES_SIDE.has(kind) ? 's' : 'p'}`;
    if (byKind.has(key)) return byKind.get(key)!;
    let id: string | undefined;
    if (role === 'vat') {
      const side = SALES_SIDE.has(kind) ? vat.account : (vat.input_account ?? vat.account);
      if (usable(side)) id = side;
      else id = [...accounts].find(([k, a]) => usable(k) && a.account_type === 'Tax' && a.active !== false)?.[0];
    } else {
      const d = DEFAULTS[role];
      if (d?.field && usable(company[d.field])) id = company[d.field] as string;
      if (!id && d) id = [...accounts].find(([k, a]) => usable(k) && a.active !== false && (d.type ? a.account_type === d.type : a.name === d.name))?.[0];
    }
    const out = id ?? `unset:${role}`;
    byKind.set(key, out);
    return out;
  };
  return {
    accounts,
    account: (e: Entry, kind: string): string => (usable(e.ref) ? e.ref : forRole(e.role, kind)),
  };
}

const ROLE_WORDS: Record<string, string> = {
  cash: 'cash', bank: 'bank', mobile_money: 'mobile money', receivable: 'debtors', payable: 'creditors', income: 'sales', expense: 'expenses',
  cost_of_goods_sold: 'cost of goods sold', stock: 'stock in hand', stock_adjustment: 'stock adjustment', stock_received_not_billed: 'stock received, not billed',
  expenses_in_valuation: 'freight and landed costs', round_off: 'round off', write_off: 'write off', temporary_opening: 'opening balances', capital: 'capital', vat: 'VAT', exchange_gain_loss: 'exchange gain or loss', other: 'other',
};
export const unsetTitle = (id: string) => `Not set up: ${ROLE_WORDS[id.slice(6)] ?? id.slice(6)} (choose an account in Setup)`;

/** Every ledger row of the stored steps, on its real account. `steps` lets a check run with a step not saved yet. */
export function bookRows(db: DB, steps: Step[] = loadSteps(db)): { rows: BookRow[]; res: ReturnType<typeof resolver> } {
  const result = runScenario(scenarioOf(db, steps));
  const res = resolver(db);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const rows = (result.entries ?? []).map((e) => {
    const s = byId.get(e.step);
    return { step: e.step, date: s?.date ?? '', label: s ? stepLabel(s) : e.step, account: res.account(e, s?.kind ?? ''), ...(e.party ? { party: e.party } : {}), debit: e.debit, credit: e.credit };
  });
  return { rows, res };
}

/** The trial balance: every account with rows, its debits, credits and balance (debit minus credit). */
export function trialBalance(db: DB) {
  const { rows, res } = bookRows(db);
  const sum = new Map<string, { d: number; c: number }>();
  for (const r of rows) { const s = sum.get(r.account) ?? { d: 0, c: 0 }; s.d += r.debit; s.c += r.credit; sum.set(r.account, s); }
  const titles = titlesOf(db, [...sum.keys()].filter((k) => !k.startsWith('unset:')));
  const accounts: AccountRow[] = [...sum].filter(([, s]) => r2(s.d) !== 0 || r2(s.c) !== 0).map(([id, s]) => {
    const a = res.accounts.get(id);
    return { id, title: id.startsWith('unset:') ? unsetTitle(id) : titles[id] ?? id, number: String(a?.number ?? ''), root_type: String(a?.root_type ?? ''),
      debit: r2(s.d), credit: r2(s.c), balance: r2(s.d - s.c) };
  }).sort((a, b) => (a.number || 'zzzz').localeCompare(b.number || 'zzzz') || a.title.localeCompare(b.title));
  const debit = r2(accounts.reduce((x, a) => x + a.debit, 0)), credit = r2(accounts.reduce((x, a) => x + a.credit, 0));
  return { accounts, debit, credit, unset: accounts.filter((a) => a.id.startsWith('unset:')).map((a) => a.id.slice(6)) };
}

/** One account's rows, oldest first, with the running balance. */
export function accountLedger(db: DB, account: unknown) {
  if (typeof account !== 'string' || !account) fail(400, 'Which account?');
  const { rows } = bookRows(db);
  const mine = rows.filter((r) => r.account === account).sort((a, b) => a.date.localeCompare(b.date) || a.step.localeCompare(b.step));
  let bal = 0;
  const titles = titlesOf(db, [...new Set(mine.map((r) => r.party).filter((p): p is string => !!p)), ...(account.startsWith('unset:') ? [] : [account])]);
  return {
    account, title: account.startsWith('unset:') ? unsetTitle(account) : titles[account as string] ?? account,
    rows: mine.map((r) => { bal = r2(bal + r.debit - r.credit); return { ...r, partyTitle: r.party ? titles[r.party] ?? r.party : undefined, balance: bal }; }),
  };
}

/** ERPNext "Balance must be" (01 §1.1): an account marked Debit may never end up in credit, and the other way round.
 *  Checked for the accounts a new step touches, with that step included. */
export function balanceRule(db: DB, all: Step[], stepId: string): string | null {
  const { rows, res } = bookRows(db, all);
  const touched = new Set(rows.filter((r) => r.step === stepId).map((r) => r.account));
  for (const id of touched) {
    const must = res.accounts.get(id)?.balance_must_be;
    if (must !== 'Debit' && must !== 'Credit') continue;
    const bal = r2(rows.filter((r) => r.account === id).reduce((s, r) => s + r.debit - r.credit, 0));
    if ((must === 'Debit' && bal < 0) || (must === 'Credit' && bal > 0)) {
      const t = titlesOf(db, [id])[id] ?? id;
      return `Balance of ${t} must always be ${must.toLowerCase()} (it would be ${Math.abs(bal).toLocaleString('en-US')} ${bal < 0 ? 'credit' : 'debit'})`;
    }
  }
  return null;
}
