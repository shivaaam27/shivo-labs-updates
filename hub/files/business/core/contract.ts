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
  | { id: string; kind: 'count'; date: string; time: string; warehouse: string; lines: Required<Line>[] }         // stock count: qty = counted, rate = valuation to use
  | { id: string; kind: 'purchase_receipt'; date: string; time: string; warehouse: string; lines: Required<Line>[] } // goods arrived from the scenario supplier
  | { id: string; kind: 'delivery'; date: string; time: string; warehouse: string; lines: Required<Line>[] }     // goods delivered to the scenario customer (rate = selling price)
  | { id: string; kind: 'landed_cost'; date: string; time: string; receipt: string; amount: number; distribute: 'qty' | 'amount' } // extra cost on an earlier purchase_receipt step
  | { id: string; kind: 'cancel'; date: string; time: string; target: string };                                 // cancel an earlier step by id

/** Any step may carry `negativeOk: true`: it was recorded while negative stock was allowed, so its own rows may
 *  go below zero even if the scenario no longer allows it (the setting was switched off later). */
export type NegativeOk = { negativeOk?: boolean };

export interface Scenario {
  id: string;            // e.g. "S01-moving-average-receipts"
  title: string;         // one line, plain English
  items: { key: string; valuation: ValuationMethod }[];
  warehouses: string[];  // scenario keys, e.g. ["Stores", "Van"]
  allowNegativeStock?: boolean; // default false
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
export type AccountRole = 'stock' | 'stock_adjustment' | 'stock_received_not_billed' | 'cost_of_goods_sold' | 'expenses_in_valuation' | 'other';
export interface LedgerTotal { step: string; role: AccountRole; debit: number; credit: number }

export interface Result {
  scenario: string;
  system: 'erpnext' | 'shivo';
  stock: StockRow[];
  ledger: LedgerTotal[];
  /** Final position per item+warehouse (from the last non-cancelled row). */
  balances: { item: string; warehouse: string; qty: number; value: number; valuationRate: number }[];
  errors: { step: string; message: string }[]; // a step the system refused (e.g. negative stock not allowed)
}

/** Amounts compare equal within this tolerance (TZS); rates within RATE_TOLERANCE. */
export const AMOUNT_TOLERANCE = 0.01;
export const RATE_TOLERANCE = 0.0001;
