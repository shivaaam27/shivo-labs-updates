// The contract between our engine and the referee (ERPNext).
// A Scenario is a business story told in neutral terms. Both systems run it and must produce the same Result.
// Plain TypeScript (types only, erasable syntax) so Node runs it directly with no build step.

export type ValuationMethod = 'Moving Average' | 'FIFO';

/** One line of a stock document. `rate` = cost per stock unit (receipts) or selling rate (sales). */
export interface Line {
  item: string;          // scenario item key, e.g. "A"
  qty: number;           // in the item's stock unit, always positive
  rate?: number;         // TZS per unit; receipts and counts need it, issues/sales take valuation instead
  from?: LineRef;        // a transfer line: the stock request line it moves (phase 5); the stock ledger ignores it
}

/** A stock step. Dates are 'YYYY-MM-DD', times 'HH:MM:SS' (Africa/Dar_es_Salaam). */
export type Step =
  | { id: string; kind: 'receipt'; date: string; time: string; warehouse: string; lines: Line[]; cogs?: boolean }   // stock in without a supplier (opening, found stock); cogs: goods a customer brought back on a delivery return (other side Cost of Goods Sold)
  | { id: string; kind: 'issue'; date: string; time: string; warehouse: string; lines: Line[] }                   // stock out to an expense (damage, own use)
  | { id: string; kind: 'transfer'; date: string; time: string; from: string; to: string; lines: Line[] }         // between stores/vans
  | { id: string; kind: 'count'; date: string; time: string; warehouse: string; lines: Required<Line>[]; opening?: boolean } // stock count: qty = counted, rate = valuation to use; opening: opening stock (Cr Temporary Opening, not Stock Adjustment)
  // goods arrived (phase 5: from a named supplier, lines may receive purchase order lines, units refused on arrival go
  // to the rejected store at no value; returnOf: goods sent back to the supplier from an earlier goods arrived)
  | ({ id: string; kind: 'purchase_receipt'; date: string; time: string; warehouse: string; lines: ReceiptLine[]; supplier?: string;
      rejectedWarehouse?: string; returnOf?: string } & BuyExtras)
  | { id: string; kind: 'delivery'; date: string; time: string; warehouse: string; lines: Required<Line>[] }     // goods delivered to the scenario customer (rate = selling price)
  | LandedCostStep // extra cost on an earlier purchase_receipt step, or a purchase_invoice that brought the goods in
  | { id: string; kind: 'cancel'; date: string; time: string; target: string }                                  // cancel an earlier step by id
  | MoneyStep
  | SellStep
  | BuyStep
  | ShiftStep
  | TripStep;

/** Extra cost on goods that arrived (02 §6.7; imports, 04 §7). `receipt`: the goods arrived (or the bill that brought
 *  the goods in) it is added to; `receipts`: when it covers several, every one of them (`receipt` is the first).
 *  Without `charges` it is one cost of `amount`, spread by `distribute` and credited to expenses included in valuation.
 *  With `charges`, each cost line is booked on its own (`amount` = the sum of the lines added to the cost of the goods). */
export interface LandedCostStep {
  id: string; kind: 'landed_cost'; date: string; time: string; receipt: string; receipts?: string[]; amount: number;
  distribute: 'qty' | 'amount' | 'manual'; charges?: LandedCharge[]; shipment?: string;   // shipment: the import shipment it costs (ours)
}
/** A cost line of a landed cost (import shipments, 04 §7). `treatment`: what it is for the books (default cost):
 *  - cost: added to the cost of the goods, spread over the receipts' lines by `distribute` (default the step's): by
 *    qty, by amount (the line's net value), or by hand (`shares`, one amount per receipt line, the same total);
 *    the receipts' ledger credits it to `role` (default expenses included in valuation) / `account`.
 *  - vat (import VAT that can be claimed back), expense, deposit (refundable, e.g. a container deposit): not in the
 *    cost of the goods; the landed cost books it itself: Dr VAT / expense / `debitAccount` (deposit: an asset), Cr
 *    `role` / `account`.
 *  `account` and `debitAccount` are our own account ids (the referee compares roles only). */
export interface LandedCharge {
  amount: number; treatment?: 'cost' | 'vat' | 'expense' | 'deposit'; role?: AccountRole; account?: string; debitAccount?: string;
  distribute?: 'qty' | 'amount' | 'manual'; shares?: { receipt: string; line: number; amount: number }[]; label?: string;
}

/** A line of goods arrived. `from`: the purchase order line it receives (on a return: the goods-arrived line it sends
 *  back). `rejected`: units refused on arrival, not part of `qty` (accepted); they go to the rejected store at no value. */
export interface ReceiptLine { item: string; qty: number; rate: number; from?: LineRef; rejected?: number }
/** Kept with goods arrived for people (ours; the engine ignores them): the supplier's delivery note number and how the
 *  goods came (transport company, its waybill number and date, the vehicle). */
export type BuyExtras = { supplierNote?: string; transporter?: string; lrNo?: string; lrDate?: string; vehicle?: string } & InCurrency;

// ---- buying documents (phase 5; pos/blueprint/04-buying.md sections 2-3) ----------------------------------------
// A stock request, a supplier quotation and a purchase order book nothing. Goods arrived (purchase_receipt) and the
// supplier bill (purchase_invoice) may point at purchase order lines (`from`); requested, ordered, received and
// billed are re-summed from the live documents every time (04 3.2), never added onto.
export type BuyStep =
  // a stock request (ERPNext Material Request): purpose purchase (to buy) or transfer (from another store, `from`)
  | { id: string; kind: 'material_request'; date: string; time: string; purpose: 'purchase' | 'transfer'; warehouse: string; from?: string;
      requiredBy?: string; lines: MoneyLine[] }
  // a supplier's prices (ERPNext Supplier Quotation; ours: "compare supplier prices"); lines may come from a request
  | { id: string; kind: 'supplier_quotation'; date: string; time: string; supplier: string; validTill?: string; lines: MoneyLine[];
      tax?: TaxSpec; discountAmount?: number }
  // an order to a supplier; lines may come from a stock request or a supplier quotation; goods arrive in `warehouse`
  | { id: string; kind: 'purchase_order'; date: string; time: string; supplier: string; warehouse: string; requiredBy?: string;
      lines: MoneyLine[]; tax?: TaxSpec; discountAmount?: number; schedule?: Instalment[] };

/** A delivery trip (phase 4d): a driver and a vehicle take delivery notes out, one stop each; stops are marked visited
 *  as the van goes. Ours only: it books nothing, so the engine never sees it (store/trips.ts). */
export type TripStep =
  | { id: string; kind: 'delivery_trip'; date: string; time: string; driver: string; vehicle: string; distance?: number;
      stops: { delivery_note: string; customer: string; address?: string; contact?: string; total?: number; note?: string }[] }
  | { id: string; kind: 'trip_visit'; date: string; time: string; trip: string; stop: number; visited: boolean };

/** Who sold a selling document (one salesman, 03 §1.2) and how a delivery travelled (driver, vehicle, transporter and
 *  its receipt number, ERPNext Delivery Note transport fields). Ours: the engine ignores them. */
export type SellExtras = { salesman?: string; driver?: string; vehicle?: string; transporter?: string; lrNo?: string; lrDate?: string } & InCurrency;

/** Foreign currency (phase 5b, core/money/fx.ts): a document in another currency than the books (TZS). Its amounts (line
 *  rates, payments, allocations, a journal row) are in `currency`; `exchangeRate` = TZS for 1 unit of it, the rate of this
 *  document. Absent: TZS, rate 1. The books (ledger) are always in TZS; a foreign-currency customer or supplier also
 *  keeps what they owe in their own currency (Scenario.parties currency). */
export interface InCurrency { currency?: string; exchangeRate?: number }

/** A till shift (phase 4c): opened with the money in the drawer, closed with a count per payment method. Ours only:
 *  it books nothing, so the engine never sees it (store/steps.ts leaves shifts and their undo out of the scenario).
 *  The close keeps what was expected at that moment (opening + money taken at the till during the shift). */
export type ShiftStep =
  | { id: string; kind: 'shift_open'; date: string; time: string; till: string; user: string; opening: { method: string; amount: number }[] }
  | { id: string; kind: 'shift_close'; date: string; time: string; shift: string; till: string; user: string;
      counted: { method: string; amount: number }[]; expected: { method: string; amount: number }[];
      totals: { sales: number; grandTotal: number; netTotal: number; vat: number; qty: number; owed: number; paidOut: number } };
// Every stock movement may also carry `remarks` (why goods were damaged, who took them): kept for people, the engine
// ignores it (MoneyNotes has the same for money documents).
// Selling and buying documents may also carry trade terms for imports and exports (phase 5c, store/imports.ts):
// `incoterm` (an incoterm record, e.g. FOB, CIF) and `namedPlace` (the port or place it names). Kept for people and
// printing; the engine ignores them.

// ---- money (phase 3; pos/blueprint/01-accounting-core.md) -------------------------------------------------------

/** Where money is kept. Each maps to one account per system (cash, bank, mobile money). */
export type MoneyAccount = 'cash' | 'bank' | 'mobile_money';

/** VAT on a document: `inclusive` = the line rates already include VAT (shelf prices); else VAT is added on top. */
export interface TaxSpec { rate: number; inclusive: boolean }

/** A line of an invoice. `vatRate` overrides the document's VAT rate for this item (e.g. 0 for exempt goods). */
export interface MoneyLine { item: string; qty: number; rate: number; vatRate?: number; discount?: number; account?: string; from?: LineRef }
/** Where a line came from: the step (quotation, sales order, delivery note) and the line's position in it (from 0). */
export interface LineRef { step: string; line: number }
// `account`: the account a service or expense line is booked to (ours; the referee ignores it: it compares roles)
// `discount`: % off `rate` (the price-list price); the line is charged rate x (1 - discount/100), rounded to the cent.

/** Extra on sales and purchase invoices: `discountAmount` = a discount on the whole invoice (on the grand total,
 *  spread over the lines by their net, VAT worked out again); `opening` = an opening balance brought in from the old
 *  books (no VAT, no stock: the lines go to Temporary Opening instead of sales or expenses). */
export interface InvoiceExtra { discountAmount?: number; opening?: boolean; schedule?: Instalment[] }
/** Payment terms in parts (03 §5.3): each instalment's due date and its share of the invoice in %. The invoice is due on
 *  the last date, but Overdue as soon as what was paid is less than the instalments already due. */
export interface Instalment { dueDate: string; portion: number }

/** Words kept with a money document for people (the engine ignores them): remarks, a payment's reference (M-Pesa code,
 *  cheque number), a supplier's own bill number and date. */
export interface MoneyNotes { remarks?: string; reference?: string; billNo?: string; billDate?: string }

export type MoneyStep = (
  // sale to a customer. updateStock: goods leave `warehouse` now (cost of goods sold). payments: paid at the till
  // (several methods allowed; cash above the total is change). Unpaid remainder is owed (outstanding).
  | { id: string; kind: 'sales_invoice'; date: string; time: string; customer: string; dueDate?: string; lines: MoneyLine[];
      tax?: TaxSpec; updateStock?: boolean; warehouse?: string; payments?: { account: MoneyAccount; amount: number; ref?: string; method?: string; reference?: string }[]; writeOff?: boolean;
      creditOk?: boolean; till?: string; shift?: string } & InvoiceExtra   // creditOk: allowed over the customer's credit limit by a manager;
      // till / shift / method: where it was sold and how it was paid (ours, for the shift's cash count; the engine ignores them)
  // bill from a supplier. receipt: the purchase_receipt step it bills (stock already in: Dr stock received not billed);
  // without it, lines are expenses (non-stock) unless updateStock (goods come in now into `warehouse`).
  | { id: string; kind: 'purchase_invoice'; date: string; time: string; supplier: string; dueDate?: string; lines: MoneyLine[];
      tax?: TaxSpec; receipt?: string; updateStock?: boolean; warehouse?: string;
      payments?: { account: MoneyAccount; amount: number; ref?: string }[]; advances?: { from: string; amount: number }[];
      writeOff?: number; hold?: boolean; holdUntil?: string } & InvoiceExtra   // payments: paid at once (a cash purchase)
  // advances: earlier payments to the supplier set against this bill (ERPNext Purchase Invoice Advance); writeOff: a small
  // difference not to be paid (Dr payable, Cr write off); hold: no payment until holdUntil (or until released).
  // Lines may bill a purchase order line or a goods-arrived line (`from`).
  // money received from a customer (in) or paid to a supplier (out); allocate: which invoices it settles (the rest stays as credit)
  // deductions: charges (bank, mobile money) or small differences, always booked as a debit to their role; money in:
  // the customer is settled for amount + deductions; money out: the supplier for amount - deductions (ERPNext, M26)
  | { id: string; kind: 'payment'; date: string; time: string; direction: 'in' | 'out'; party: string; account: MoneyAccount; amount: number;
      allocate?: { invoice: string; amount: number }[]; deductions?: { role: AccountRole; amount: number; ref?: string }[]; ref?: string;
      method?: string; till?: string; shift?: string; advanceFor?: { order: string; amount: number }[] }   // till/shift: paid in or out at a till during a shift (ours, for its cash count)
      // advanceFor: an advance paid against a purchase order or sales order (it stays credit until set against a bill)
  // a full or partial return of an earlier sales invoice (lines default to all of it); its own balance is negative
  // credit, or with reduceInvoice it comes off what is owed on that invoice (ERPNext update_outstanding_for_self = 0)
  | { id: string; kind: 'credit_note'; date: string; time: string; against: string; lines?: MoneyLine[]; updateStock?: boolean; reduceInvoice?: boolean }
  // the same for a supplier bill (ERPNext debit note, a Purchase Invoice return): what we owe falls, or a credit with them
  | { id: string; kind: 'debit_note'; date: string; time: string; against: string; lines?: MoneyLine[]; updateStock?: boolean; reduceInvoice?: boolean }
  // move money between own accounts (cash to bank deposit)
  | { id: string; kind: 'money_transfer'; date: string; time: string; from: MoneyAccount; to: MoneyAccount; amount: number; fromRef?: string; toRef?: string }
  // a journal: rows must balance (total debit = total credit), else refused
  | { id: string; kind: 'journal'; date: string; time: string; rows: { role: AccountRole; account?: string; debit?: number; credit?: number; party?: string; invoice?: string; exchangeRate?: number }[];
      creditOk?: boolean }   // creditOk: a manager allowed debiting a customer over their credit limit
  // match credit to invoices later (ERPNext Payment Reconciliation, 01 §3.4): money a party has as credit (a payment,
  // a return, a journal with no invoice) is allocated to their open invoices; nothing is booked again, only who owes
  // what on which invoice changes. Undoing it (cancel) unlinks again (ERPNext Unreconcile Payment).
  | { id: string; kind: 'reconcile'; date: string; time: string; party: string; allocations: { from: string; invoice: string; amount: number }[] }
) & MoneyNotes & InCurrency;
// a journal row with exchangeRate is in the account's own currency (a USD party's row: in USD): TZS = amount x rate

// ---- selling documents (phase 4; pos/blueprint/03-selling.md §3-§5) ---------------------------------------------
// A quotation and a sales order book nothing; a delivery note moves goods out (Dr cost of goods sold, Cr stock) to a
// customer; a sales invoice line may bill an order line or a delivery note line (`from`). Counters (ordered,
// delivered, billed) are always re-summed from the live documents, never added onto (03 §3.2).
export type SellStep =
  | ({ id: string; kind: 'quotation'; date: string; time: string; customer: string; validTill?: string; lines: MoneyLine[]; tax?: TaxSpec; discountAmount?: number } & SellExtras)
  // reserve: hold the goods firmly for this order (ERPNext Stock Reservation Entry): nothing else may take them
  | { id: string; kind: 'sales_order'; date: string; time: string; customer: string; deliveryDate?: string; warehouse: string; lines: MoneyLine[];
      tax?: TaxSpec; creditOk?: boolean; discountAmount?: number; reserve?: boolean } & SellExtras
  // returnOf: goods coming back on a delivery not yet invoiced (ERPNext return Delivery Note); its lines point at the
  // delivery note's lines (`from`). pick: a line delivered from a pick list (the pick list's id).
  | { id: string; kind: 'delivery_note'; date: string; time: string; customer: string; warehouse: string; lines: (MoneyLine & { pick?: string })[]; tax?: TaxSpec; creditOk?: boolean;
      discountAmount?: number; returnOf?: string } & SellExtras
  // picking an order in the store (ERPNext Pick List): no stock moves, the order's lines count as picked
  | { id: string; kind: 'pick_list'; date: string; time: string; customer: string; warehouse: string; lines: MoneyLine[] }
  // a user action on a quotation (Lost, Open) or a sales order / delivery note (Closed, On Hold, Open = reopen)
  | { id: string; kind: 'set_status'; date: string; time: string; target: string; status: 'Closed' | 'On Hold' | 'Open' | 'Lost' | 'Stopped' };   // also purchase orders (Closed, On Hold) and stock requests (Stopped)

// ---- printing (phase 4e; ours only: the engine and the referee ignore these) ----------------------------------------
/** What a quotation, order, delivery note, sale, return, payment or journal may carry for its printed page
 *  (store/print.ts checks and adds them; shared/biz/print.js prints them). Record ids are ours: `printHeading` a
 *  print_heading, `letterHead` a letter_head, `terms` a terms record whose text was copied into `termsText` (and may
 *  have been changed for this document). `language`: the print language (from the customer unless chosen). `contact`:
 *  one of the customer's contact people by name; `shipTo`: where the goods go, when not the customer's own address.
 *  `printWithoutAmount` (delivery notes): prices and totals are left off the paper. `groupSameItems`: lines of the same
 *  product at the same price are printed as one. */
export interface PrintExtra {
  printHeading?: string; letterHead?: string; terms?: string; termsText?: string; language?: 'English' | 'Swahili';
  contact?: string; shipTo?: string; printWithoutAmount?: boolean; groupSameItems?: boolean;
}

/** Status and progress of a selling document (ERPNext: status, per_ordered, per_delivered, per_billed). */
export interface DocResult {
  step: string; kind: string; status: string; perOrdered?: number; perDelivered?: number; perBilled?: number; perPicked?: number; perReturned?: number;
  perReceived?: number; advancePaid?: number;   // buying: received on an order or request; advances paid against an order
  /** Ours only (not compared): per line, how much was ordered / delivered (quantities) and billed (amount). */
  lines?: { ordered?: number; delivered?: number; billed?: number; picked?: number; returned?: number; held?: number; received?: number; rejected?: number }[];
  /** Ours only (not compared): the document's totals (net, VAT, after the discount on the whole). */
  totals?: { netTotal: number; vat: number; grandTotal: number; roundedTotal: number; discount: number };
}

/** Any step may carry `negativeOk: true`: it was recorded while negative stock was allowed, so its own rows may
 *  go below zero even if the scenario no longer allows it (the setting was switched off later). */
export type NegativeOk = { negativeOk?: boolean };

export interface Scenario {
  id: string;            // e.g. "S01-moving-average-receipts"
  title: string;         // one line, plain English
  // stock: false = a service (never moves stock); minOrderQty: the least a purchase order may ask for (Item
  // min_order_qty); overDelivery / overBilling: the product's own allowances in % (Item over_delivery_receipt_allowance,
  // over_billing_allowance), else the scenario's
  items: { key: string; valuation: ValuationMethod; stock?: boolean; minOrderQty?: number; overDelivery?: number; overBilling?: number }[];
  warehouses: string[];  // scenario keys, e.g. ["Stores", "Van"]
  allowNegativeStock?: boolean; // default false
  // money: customers and suppliers (creditLimit 0/absent = none; creditAtInvoice: ERPNext's "bypass credit limit check at
  // sales order": orders are not checked and not counted, deliveries and invoices are checked in full, 03 §5.2)
  // hold (suppliers, ERPNext on_hold / hold_type / release_date): no bills (invoices), no payments, or neither (all),
  // until the date (none: until released)
  // billWithoutOrder / billWithoutReceipt (suppliers): let off poRequired / prRequired for their bills (ERPNext
  // allow_purchase_invoice_creation_without_purchase_order / _receipt)
  parties?: { key: string; type: 'customer' | 'supplier'; creditLimit?: number; creditAtInvoice?: boolean; hold?: { type: 'all' | 'invoices' | 'payments'; until?: string };
    billWithoutOrder?: boolean; billWithoutReceipt?: boolean;
    currency?: string; account?: string }[];   // currency: the party's own (absent: TZS); account: our own debtors / creditors account for it (ours)
  rounding?: boolean;    // money: round grand totals to whole shillings (default true, ERPNext's default)
  oursDiffers?: { why: string; diffs: string[] }; // a deliberate difference from ERPNext: the exact difference lines expected
  overDelivery?: number; // % a delivery may go over the ordered quantity (ERPNext Stock Settings over_delivery_receipt_allowance, default 0)
  overBilling?: number;  // % billing may go over the ordered or delivered amount (Accounts Settings over_billing_allowance, default 0)
  stockReservation?: boolean;   // orders may hold goods firmly (Stock Settings enable_stock_reservation, default off)
  partialReservation?: boolean; // hold what there is when an order wants more (allow_partial_reservation, default on)
  overPicking?: number;         // % a pick list may pick over the ordered quantity (over_picking_allowance, default 0)
  noHoldOnReturn?: boolean;     // goods returned on a delivery are not held for the order again (Selling Settings dont_reserve_sales_order_qty_on_sales_return)
  poRequired?: boolean;      // a supplier bill or goods arrived needs a purchase order (Buying Settings po_required)
  prRequired?: boolean;      // a bill for goods needs goods arrived first (Buying Settings pr_required)
  billRejected?: boolean;    // a bill made from goods arrived bills the refused units too (bill_for_rejected_quantity_in_purchase_invoice)
  sameRate?: 'stop' | 'warn'; // goods arrived and bills keep the order's rate (maintain_same_rate; warn: allowed, ours shows it)
  requestAllowance?: number; // % a purchase order may order over a stock request (Stock Settings mr_qty_allowance)
  billRateRevalues?: boolean; // a bill at another rate than goods arrived re-values the goods (set_landed_cost_based_on_purchase_invoice_rate)
  noSaleBelowCost?: boolean; // refuse selling below the last purchase rate or the valuation rate (Selling Settings validate_selling_price, default off)
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
  | 'temporary_opening' | 'exchange_gain_loss' | 'other';
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
  parties?: { party: string; balance: number; inCurrency?: number }[];   // inCurrency: a foreign-currency party's balance in its own currency
  /** Selling documents: status and % ordered / delivered / billed. */
  documents?: DocResult[];
  /** Stock held for open sales orders per item + store (ERPNext Bin reserved qty). */
  reserved?: { item: string; warehouse: string; qty: number }[];
  /** Goods held firmly for orders per item + store (ERPNext Bin reserved_stock, Stock Reservation Entries). */
  firm?: { item: string; warehouse: string; qty: number }[];
  /** Buying: goods on open purchase orders not yet received, per item + store (ERPNext Bin ordered_qty), and on open
   *  stock requests not yet ordered (Bin indented_qty). */
  ordered?: { item: string; warehouse: string; qty: number }[];
  requested?: { item: string; warehouse: string; qty: number }[];
  /** Buying: the last purchase rate of each product bought (ERPNext Item last_purchase_rate), per stock unit. */
  lastPurchase?: { item: string; rate: number }[];
  /** Ours only (not compared): every line of goods arrived (or of a bill that brought goods in) that has extra cost on
   *  it, with its share of all live landed costs and the landed cost per unit (line rate + share / qty). */
  landed?: { receipt: string; line: number; item: string; qty: number; rate: number; extra: number; perUnit: number }[];
  /** Ours only (the referee does not compare it): every ledger row of every live step, with the account the document
   *  named (`ref`) and the party, so the books can be shown per real account. */
  entries?: Entry[];
  /** Ours only (not compared): per customer, what counts against the credit limit (owed + open orders and
   *  deliveries not billed, 03 §5.1). */
  credit?: { customer: string; owed: number }[];
}

export interface Entry { step: string; role: AccountRole; ref?: string; party?: string; debit: number; credit: number }

export interface InvoiceResult {
  step: string;
  party: string;
  netTotal: number;      // before VAT
  vat: number;           // total VAT
  grandTotal: number;    // net + VAT (before rounding to whole shillings)
  roundedTotal: number;  // what is charged (grand total rounded; = grand total when rounding is off)
  outstanding: number;   // still owed on it (negative on a credit note = credit to the customer); in the party's currency
  // (amounts above are in the invoice's currency, as ERPNext keeps them)
  status: string;        // Paid, Unpaid, Partly Paid, Overdue, Return, Credit Note Issued, Cancelled
}

/** Amounts compare equal within this tolerance (TZS); rates within RATE_TOLERANCE. */
export const AMOUNT_TOLERANCE = 0.01;
export const RATE_TOLERANCE = 0.0001;
