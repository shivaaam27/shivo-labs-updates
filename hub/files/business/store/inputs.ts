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
    'amount', 'payment_terms', 'till', 'remarks', 'client_id'],
  purchase_invoice: ['date', 'time', 'supplier', 'due_date', 'receipt', 'update_stock', 'warehouse', 'vat', 'prices_include_vat', 'lines', 'lines.item',
    'lines.qty', 'lines.rate', 'lines.discount', 'lines.account', 'discount_amount', 'payments', 'payments.method', 'payments.amount', 'opening', 'amount',
    'bill_no', 'bill_date', 'payment_terms', 'remarks', 'client_id'],
  payment: ['date', 'time', 'direction', 'party', 'method', 'amount', 'allocate', 'allocate.invoice', 'allocate.amount', 'deductions', 'deductions.account',
    'deductions.amount', 'reference', 'till', 'remarks', 'client_id'],
  credit_note: ['date', 'time', 'against', 'lines', 'lines.item', 'lines.qty', 'update_stock', 'reduce_invoice', 'remarks', 'client_id'],
  money_transfer: ['date', 'time', 'from', 'to', 'amount', 'reference', 'remarks', 'client_id'],
  journal: ['date', 'time', 'rows', 'rows.account', 'rows.debit', 'rows.credit', 'rows.party', 'rows.invoice', 'allow_over_limit', 'reference', 'remarks', 'client_id'],
  quotation: ['date', 'time', 'customer', 'valid_till', 'vat', 'prices_include_vat', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'lines.discount',
    'discount_amount', 'remarks', 'client_id'],
  sales_order: ['date', 'time', 'customer', 'delivery_date', 'warehouse', 'vat', 'prices_include_vat', 'lines', 'lines.item', 'lines.qty', 'lines.rate',
    'lines.discount', 'lines.from', 'discount_amount', 'allow_over_limit', 'remarks', 'client_id'],
  delivery_note: ['date', 'time', 'customer', 'warehouse', 'vat', 'prices_include_vat', 'lines', 'lines.item', 'lines.qty', 'lines.rate', 'lines.discount',
    'lines.from', 'discount_amount', 'allow_over_limit', 'remarks', 'client_id'],
  set_status: ['date', 'time', 'target', 'status', 'remarks', 'client_id'],
  reconcile: ['date', 'time', 'party', 'allocations', 'allocations.from', 'allocations.invoice', 'allocations.amount', 'remarks', 'client_id'],
  shift_open: ['date', 'time', 'till', 'opening', 'opening.method', 'opening.amount', 'remarks', 'client_id'],
  shift_close: ['date', 'time', 'shift', 'till', 'counted', 'counted.method', 'counted.amount', 'remarks', 'client_id'],
};
