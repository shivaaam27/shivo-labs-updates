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
    'lines.rate', 'lines.discount', 'discount_amount', 'payments', 'payments.method', 'payments.amount', 'write_off', 'allow_over_limit', 'opening',
    'amount', 'remarks', 'client_id'],
  purchase_invoice: ['date', 'time', 'supplier', 'due_date', 'receipt', 'update_stock', 'warehouse', 'vat', 'prices_include_vat', 'lines', 'lines.item',
    'lines.qty', 'lines.rate', 'lines.discount', 'lines.account', 'discount_amount', 'payments', 'payments.method', 'payments.amount', 'opening', 'amount',
    'bill_no', 'bill_date', 'remarks', 'client_id'],
  payment: ['date', 'time', 'direction', 'party', 'method', 'amount', 'allocate', 'allocate.invoice', 'allocate.amount', 'deductions', 'deductions.account',
    'deductions.amount', 'reference', 'remarks', 'client_id'],
  credit_note: ['date', 'time', 'against', 'lines', 'lines.item', 'lines.qty', 'update_stock', 'reduce_invoice', 'remarks', 'client_id'],
  money_transfer: ['date', 'time', 'from', 'to', 'amount', 'reference', 'remarks', 'client_id'],
  journal: ['date', 'time', 'rows', 'rows.account', 'rows.debit', 'rows.credit', 'rows.party', 'reference', 'remarks', 'client_id'],
};
