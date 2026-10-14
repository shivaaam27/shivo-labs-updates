// What a screen may send for each kind of step (movement or money document): the "fields" of our transactions, the
// way DocDef fields are the fields of our masters. The ERPNext field maps (business/referee/fields) point at these
// keys; inputs.test.ts checks every key is really read by the store. Dotted keys are fields of a row
// (lines.qty = the quantity on a line). Things the engine works out (totals, VAT, owed, status, ledger) are not inputs.
export const STEP_INPUTS: Record<string, string[]> = {
  receipt: ['date', 'time', 'warehouse', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'remarks', 'client_id'],
  issue: ['date', 'time', 'warehouse', 'lines', 'lines.item', 'lines.qty', 'remarks', 'client_id'],
  transfer: ['date', 'time', 'from', 'to', 'lines', 'lines.item', 'lines.qty', 'remarks', 'client_id'],
  count: ['date', 'time', 'warehouse', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'opening', 'remarks', 'client_id'],
  purchase_receipt: ['date', 'time', 'warehouse', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'remarks', 'client_id'],
  delivery: ['date', 'time', 'warehouse', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'remarks', 'client_id'],
  landed_cost: ['date', 'time', 'receipt', 'amount', 'distribute', 'remarks', 'client_id'],
  sales_invoice: ['date', 'time', 'customer', 'due_date', 'warehouse', 'update_stock', 'vat', 'prices_include_vat', 'lines', 'lines.item', 'lines.qty',
    'lines.rate', 'lines.discount', 'lines.from', 'discount_amount', 'payments', 'payments.method', 'payments.amount', 'payments.reference', 'write_off', 'allow_over_limit', 'opening',
    'amount', 'payment_terms', 'till', 'salesman', 'remarks', 'client_id'],
  purchase_invoice: ['date', 'time', 'supplier', 'due_date', 'receipt', 'update_stock', 'warehouse', 'vat', 'prices_include_vat', 'lines', 'lines.item',
    'lines.qty', 'lines.rate', 'lines.discount', 'lines.account', 'discount_amount', 'payments', 'payments.method', 'payments.amount', 'opening', 'amount',
    'bill_no', 'bill_date', 'payment_terms', 'remarks', 'client_id'],
  payment: ['date', 'time', 'direction', 'party', 'method', 'amount', 'allocate', 'allocate.invoice', 'allocate.amount', 'deductions', 'deductions.account',
    'deductions.amount', 'reference', 'till', 'remarks', 'client_id'],
  credit_note: ['date', 'time', 'against', 'lines', 'lines.item', 'lines.qty', 'update_stock', 'reduce_invoice', 'remarks', 'client_id'],
  money_transfer: ['date', 'time', 'from', 'to', 'amount', 'reference', 'remarks', 'client_id'],
  journal: ['date', 'time', 'rows', 'rows.account', 'rows.debit', 'rows.credit', 'rows.party', 'rows.invoice', 'allow_over_limit', 'reference', 'remarks', 'client_id'],
  quotation: ['date', 'time', 'customer', 'valid_till', 'vat', 'prices_include_vat', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'lines.discount',
    'discount_amount', 'salesman', 'remarks', 'client_id'],
  sales_order: ['date', 'time', 'customer', 'delivery_date', 'warehouse', 'vat', 'prices_include_vat', 'lines', 'lines.item', 'lines.qty', 'lines.rate',
    'lines.discount', 'lines.from', 'discount_amount', 'allow_over_limit', 'reserve_stock', 'salesman', 'remarks', 'client_id'],
  delivery_note: ['date', 'time', 'customer', 'warehouse', 'vat', 'prices_include_vat', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'lines.discount',
    'lines.from', 'discount_amount', 'allow_over_limit', 'return_against', 'pick_list', 'salesman', 'driver', 'vehicle', 'transporter', 'lr_no', 'lr_date',
    'remarks', 'client_id'],
  pick_list: ['date', 'time', 'customer', 'warehouse', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'lines.from', 'remarks', 'client_id'],
  delivery_trip: ['date', 'time', 'driver', 'vehicle', 'distance', 'stops', 'stops.delivery_note', 'stops.note', 'remarks', 'client_id'],
  trip_visit: ['date', 'time', 'trip', 'stop', 'visited', 'remarks', 'client_id'],
  set_status: ['date', 'time', 'target', 'status', 'remarks', 'client_id'],
  reconcile: ['date', 'time', 'party', 'allocations', 'allocations.from', 'allocations.invoice', 'allocations.amount', 'remarks', 'client_id'],
  shift_open: ['date', 'time', 'till', 'opening', 'opening.method', 'opening.amount', 'remarks', 'client_id'],
  shift_close: ['date', 'time', 'shift', 'till', 'counted', 'counted.method', 'counted.amount', 'remarks', 'client_id'],
};

// Printing (phase 4e, read by store/print.ts): every printed kind may name its print heading and letter head; selling
// documents also their print language, terms (a record, and the text as changed for this document), the customer's
// contact person, where the goods go, and "group same items"; a delivery note may be printed without amounts.
// Kept in their own block so the lists above stay easy to merge.
const PRINT_INPUTS = ['print_heading', 'letter_head'];
const SELL_PRINT = [...PRINT_INPUTS, 'language', 'terms', 'terms_text', 'contact', 'ship_to', 'group_same_items'];
for (const k of ['quotation', 'sales_order', 'sales_invoice']) STEP_INPUTS[k].push(...SELL_PRINT);
STEP_INPUTS.delivery_note.push(...SELL_PRINT, 'print_without_amount');
STEP_INPUTS.credit_note.push(...PRINT_INPUTS, 'language');
STEP_INPUTS.payment.push(...PRINT_INPUTS);
STEP_INPUTS.journal.push(...PRINT_INPUTS);
