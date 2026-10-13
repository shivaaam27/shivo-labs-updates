// Totals and VAT for one invoice (01 §5.2, worked examples 01 §5.3). One VAT row ("On Net Total"); each line may
// override the rate (0 % for exempt goods, 01 §5.3 G). No discounts yet (01 §5.2 step 11 comes later).
//
// Order: line amount = rate x qty (rounded) -> inclusive lines are backed out to their net -> net total ->
// VAT accumulated per line unrounded, rounded once -> inclusive cent correction (|diff| <= 0.05 kept) ->
// grand total -> rounded total (whole shillings, half to even) and the rounding adjustment.
import type { MoneyLine, TaxSpec } from '../contract.ts';
import { roundHalfEven, roundMoney } from '../money.ts';

export interface LineTotal { item: string; qty: number; amount: number; net: number; vatRate: number; vat: number }
export interface Totals {
  lines: LineTotal[];
  total: number;          // sum of line amounts as typed (gross when prices include VAT)
  netTotal: number;       // before VAT
  vat: number;            // the VAT row, rounded
  grandTotal: number;     // net + VAT (+ the kept inclusive cent difference)
  roundedTotal: number;   // what is charged
  roundingAdjustment: number; // roundedTotal - grandTotal
}

export function invoiceTotals(lines: MoneyLine[], tax: TaxSpec | undefined, rounding: boolean): Totals {
  const docRate = tax?.rate ?? 0;
  const inclusive = !!tax?.inclusive;
  const out: LineTotal[] = lines.map((l) => {
    const amount = roundMoney(l.rate * l.qty);                 // step 2
    const vatRate = tax ? (l.vatRate ?? docRate) : 0;
    // step 5: an inclusive price holds net x (1 + rate); back it out
    const net = inclusive ? roundMoney(amount / (1 + vatRate / 100)) : amount;
    return { item: l.item, qty: l.qty, amount, net, vatRate, vat: 0 };
  });
  const total = roundMoney(out.reduce((s, l) => s + l.amount, 0));
  const netTotal = roundMoney(out.reduce((s, l) => s + l.net, 0));  // step 6

  // step 7: per line, unrounded, then the row is rounded once
  let vatExact = 0;
  for (const l of out) { const v = (l.vatRate / 100) * l.net; l.vat = v; vatExact += v; }
  const vat = tax ? roundMoney(vatExact) : 0;
  const rowTotal = roundMoney(netTotal + vat);
  for (const l of out) l.vat = roundMoney(l.vat);

  // step 8: inclusive prices may lose a cent when backed out; a difference up to 0.05 is kept on the grand total
  let grandTotal = rowTotal;
  if (inclusive) {
    const diff = roundMoney(total - rowTotal);
    if (diff !== 0 && Math.abs(diff) <= 0.05) grandTotal = roundMoney(rowTotal + diff);
  }
  // step 10: whole shillings, half to even (01 §5.3 F: 3,274.50 -> 3,274)
  const roundedTotal = rounding ? roundHalfEven(grandTotal, 0) : grandTotal;
  return { lines: out, total, netTotal, vat, grandTotal, roundedTotal, roundingAdjustment: roundMoney(roundedTotal - grandTotal) };
}
