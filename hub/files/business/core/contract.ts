// The contract between our engine and the referee (ERPNext).
// A Scenario is a business story told in neutral terms. Both systems run it and must produce the same Result.
// Plain TypeScript (types only, erasable syntax) so Node runs it directly with no build step.

export type ValuationMethod = 'Moving Average' | 'FIFO';

/** One line of a stock document. `rate` = cost per stock unit (receipts) or selling rate (sales). */
export interface Line {
  item: string;          // scenario item key, e.g. "A"
  qty: number;           // in the item's stock unit, always positive
  rate?: number;         // TZS per unit; receipts and counts need it, issues/sales take valuation instead
}

/** A stock step. Dates are 'YYYY-MM-DD', times 'HH:MM:SS' (Africa/Dar_es_Salaam). */
export type Step =
  | { id: string; kind: 'receipt'; date: string; time: string; warehouse: string; lines: Line[] }                 // stock in without a supplier (opening, found stock)
  | { id: string; kind: 'issue'; date: string; time: string; warehouse: string; lines: Line[] }                   // stock out to an expense (damage, own use)
  | { id: string; kind: 'transfer'; date: string; time: string; from: string; to: string; lines: Line[] }         // between stores/vans
  | { id: string; kind: 'count'; date: string; time: string; warehouse: string; lines: Required<Line>[]; opening?: boolean } // stock count: qty = counted, rate = valuation to use; opening: opening stock (Cr Temporary Opening, not Stock Adjustment)
  | { id: string; kind: 'purchase_receipt'; date: string; time: string; warehouse: string; lines: Required<Line>[] } // goods arrived from the scenario supplier
  | { id: string; kind: 'delivery'; date: string; time: string; warehouse: string; lines: Required<Line>[] }     // goods delivered to the scenario customer (rate = selling price)
  | { id: string; kind: 'landed_cost'; date: string; time: string; receipt: string; amount: number; distribute: 'qty' | 'amount' } // extra cost on an earlier purchase_receipt step, or a purchase_invoice that brought the goods in
  | { id: string; kind: 'cancel'; date: string; time: string; target: string }                                  // cancel an earlier step by id
  | MoneyStep;
// Every stock movement may also carry `remarks` (why goods were damaged, who took them): kept for people, the engine
// ignores it (MoneyNotes has the same for money documents).

// ---- money (phase 3; pos/blueprint/01-accounting-core.md) -------------------------------------------------------

/** Where money is kept. Each maps to one account per system (cash, bank, mobile money). */
export type MoneyAccount = 'cash' | 'bank' | 'mobile_money';

/** VAT on a document: `inclusive` = the line rates already include VAT (shelf prices); else VAT is added on top. */
export interface TaxSpec { rate: number; inclusive: boolean }

/** A line of an invoice. `vatRate` overrides the document's VAT rate for this item (e.g. 0 for exempt goods). */
export interface MoneyLine { item: string; qty: number; rate: number; vatRate?: number; discount?: number; account?: string }
// `account`: the account a service or expense line is booked to (ours; the referee ignores it: it compares roles)
// `discount`: % off `rate` (the price-list price); the line is charged rate x (1 - discount/100), rounded to the cent.

/** Extra on sales and purchase invoices: `discountAmount` = a discount on the whole invoice (on the grand total,
 *  spread over the lines by their net, VAT worked out again); `opening` = an opening balance brought in from the old
 *  books (no VAT, no stock: the lines go to Temporary Opening instead of sales or expenses). */
export interface InvoiceExtra { discountAmount?: number; opening?: boolean }

/** Words kept with a money document for people (the engine ignores them): remarks, a payment's reference (M-Pesa code,
 *  cheque number), a supplier's own bill number and date. */
export interface MoneyNotes { remarks?: string; reference?: string; billNo?: string; billDate?: string }

export type MoneyStep = (
  // sale to a customer. updateStock: goods leave `warehouse` now (cost of goods sold). payments: paid at the till
  // (several methods allowed; cash above the total is change). Unpaid remainder is owed (outstanding).
  | { id: string; kind: 'sales_invoice'; date: string; time: string; customer: string; dueDate?: string; lines: MoneyLine[];
      tax?: TaxSpec; updateStock?: boolean; warehouse?: string; payments?: { account: MoneyAccount; amount: number; ref?: string }[]; writeOff?: boolean;
      creditOk?: boolean } & InvoiceExtra   // creditOk: allowed over the customer's credit limit by a manager
  // bill from a supplier. receipt: the purchase_receipt step it bills (stock already in: Dr stock received not billed);
  // without it, lines are expenses (non-stock) unless updateStock (goods come in now into `warehouse`).
  | { id: string; kind: 'purchase_invoice'; date: string; time: string; supplier: string; dueDate?: string; lines: MoneyLine[];
      tax?: TaxSpec; receipt?: string; updateStock?: boolean; warehouse?: string;
      payments?: { account: MoneyAccount; amount: number; ref?: string }[] } & InvoiceExtra   // payments: paid at once (a cash purchase)
  // money received from a customer (in) or paid to a supplier (out); allocate: which invoices it settles (the rest stays as credit)
  // deductions: charges (bank, mobile money) or small differences, always booked as a debit to their role; money in:
  // the customer is settled for amount + deductions; money out: the supplier for amount - deductions (ERPNext, M26)
  | { id: string; kind: 'payment'; date: string; time: string; direction: 'in' | 'out'; party: string; account: MoneyAccount; amount: number;
      allocate?: { invoice: string; amount: number }[]; deductions?: { role: AccountRole; amount: number; ref?: string }[]; ref?: string }
  // a full or partial return of an earlier sales invoice (lines default to all of it); its own balance is negative
  // credit, or with reduceInvoice it comes off what is owed on that invoice (ERPNext update_outstanding_for_self = 0)
  | { id: string; kind: 'credit_note'; date: string; time: string; against: string; lines?: MoneyLine[]; updateStock?: boolean; reduceInvoice?: boolean }
  // move money between own accounts (cash to bank deposit)
  | { id: string; kind: 'money_transfer'; date: string; time: string; from: MoneyAccount; to: MoneyAccount; amount: number; fromRef?: string; toRef?: string }
  // a journal: rows must balance (total debit = total credit), else refused
  | { id: string; kind: 'journal'; date: string; time: string; rows: { role: AccountRole; account?: string; debit?: number; credit?: number; party?: string; invoice?: string }[] }
) & MoneyNotes;

/** Any step may carry `negativeOk: true`: it was recorded while negative stock was allowed, so its own rows may
 *  go below zero even if the scenario no longer allows it (the setting was switched off later). */
export type NegativeOk = { negativeOk?: boolean };

export interface Scenario {
  id: string;            // e.g. "S01-moving-average-receipts"
  title: string;         // one line, plain English
  items: { key: string; valuation: ValuationMethod; stock?: boolean }[]; // stock: false = a service (never moves stock)
  warehouses: string[];  // scenario keys, e.g. ["Stores", "Van"]
  allowNegativeStock?: boolean; // default false
  parties?: { key: string; type: 'customer' | 'supplier'; creditLimit?: number }[]; // money: customers and suppliers (creditLimit 0/absent = none)
  rounding?: boolean;    // money: round grand totals to whole shillings (default true, ERPNext's default)
  oursDiffers?: { why: string; diffs: string[] }; // a deliberate difference from ERPNext: the exact difference lines expected
  steps: Step[];
}

/** One stock ledger row, in the order the system stores them (by posting date, time, then creation). */
export interface StockRow {
  step: string;          // Step.id that produced it
  item: string;          // scenario item key
  warehouse: string;     // scenario warehouse key
  qty: number;           // + in, - out
  qtyAfter: number;      // quantity after this row
  valuationRate: number; // TZS per unit after this row
  stockValue: number;    // TZS value of the item in this warehouse after this row
  valueChange: number;   // stock_value_difference
  cancelled: boolean;
}

/** Ledger rows summed per account role, per step. Account names differ between systems, roles do not. */
export type AccountRole = 'stock' | 'stock_adjustment' | 'stock_received_not_billed' | 'cost_of_goods_sold' | 'expenses_in_valuation'
  | 'receivable' | 'payable' | 'income' | 'expense' | 'vat' | 'cash' | 'bank' | 'mobile_money' | 'round_off' | 'write_off' | 'capital'
  | 'temporary_opening' | 'other';
export interface LedgerTotal { step: string; role: AccountRole; debit: number; credit: number }

export interface Result {
  scenario: string;
  system: 'erpnext' | 'shivo';
  stock: StockRow[];
  ledger: LedgerTotal[];
  /** Final position per item+warehouse (from the last non-cancelled row). */
  balances: { item: string; warehouse: string; qty: number; value: number; valuationRate: number }[];
  errors: { step: string; message: string }[]; // a step the system refused (e.g. negative stock not allowed)
  /** Money scenarios: every sales/purchase invoice and credit note with its totals and what is still owed on it. */
  invoices?: InvoiceResult[];
  /** Money scenarios: balance per party (customer: what they owe us; supplier: what we owe them; negative = credit). */
  parties?: { party: string; balance: number }[];
  /** Ours only (the referee does not compare it): every ledger row of every live step, with the account the document
   *  named (`ref`) and the party, so the books can be shown per real account. */
  entries?: Entry[];
}

export interface Entry { step: string; role: AccountRole; ref?: string; party?: string; debit: number; credit: number }

export interface InvoiceResult {
  step: string;
  party: string;
  netTotal: number;      // before VAT
  vat: number;           // total VAT
  grandTotal: number;    // net + VAT (before rounding to whole shillings)
  roundedTotal: number;  // what is charged (grand total rounded; = grand total when rounding is off)
  outstanding: number;   // still owed on it (negative on a credit note = credit to the customer)
  status: string;        // Paid, Unpaid, Partly Paid, Overdue, Return, Credit Note Issued, Cancelled
}

/** Amounts compare equal within this tolerance (TZS); rates within RATE_TOLERANCE. */
export const AMOUNT_TOLERANCE = 0.01;
export const RATE_TOLERANCE = 0.0001;
