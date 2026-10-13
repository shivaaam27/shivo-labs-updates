// Totals and VAT for one invoice (01 §5.2, worked examples 01 §5.3). One VAT row ("On Net Total"); each line may
// override the rate (0 % for exempt goods, 01 §5.3 G).
//
// Order: line rate = price less its discount % (to the cent) -> line amount = rate x qty (rounded) -> inclusive lines
// are backed out to their net -> net total -> VAT accumulated per line unrounded, rounded once -> inclusive cent
// correction (|diff| <= 0.05 kept) -> grand total -> a discount on the whole invoice (step 11) -> rounded total
// (whole shillings, half to even) and the rounding adjustment.
//
// Step 11, discount on the grand total (checked against ERPNext, referee M16): the discount is turned into a cut of
// the net total in the ratio net / grand, spread over the lines by their net (the last line takes the cent left
// over), VAT is worked out again on the cut nets, and the grand total becomes the old grand total less the discount
// (a gap up to 0.05 against net + VAT is kept, like the inclusive cent).
import type { MoneyLine, TaxSpec } from '../contract.ts';
import { roundHalfEven, roundMoney } from '../money.ts';

export interface LineTotal { item: string; qty: number; rate: number; amount: number; net: number; vatRate: number; vat: number }
export interface Totals {
  lines: LineTotal[];
  total: number;          // sum of line amounts as typed (gross when prices include VAT)
  netTotal: number;       // before VAT
  vat: number;            // the VAT row, rounded
  grandTotal: number;     // net + VAT (+ the kept inclusive cent difference)
  roundedTotal: number;   // what is charged
  roundingAdjustment: number; // roundedTotal - grandTotal
  discount: number;       // the discount on the whole invoice (0 if none)
}

/** A line's rate after its discount %, to the cent. */
export const lineRate = (l: MoneyLine): number => (l.discount ? roundMoney(l.rate * (1 - l.discount / 100)) : l.rate);

export function invoiceTotals(lines: MoneyLine[], tax: TaxSpec | undefined, rounding: boolean, discountAmount = 0): Totals {
  const docRate = tax?.rate ?? 0;
  const inclusive = !!tax?.inclusive;
  const out: LineTotal[] = lines.map((l) => {
    const rate = lineRate(l);
    const amount = roundMoney(rate * l.qty);                   // step 2
    const vatRate = tax ? (l.vatRate ?? docRate) : 0;
    // step 5: an inclusive price holds net x (1 + rate); back it out
    const net = inclusive ? roundMoney(amount / (1 + vatRate / 100)) : amount;
    return { item: l.item, qty: l.qty, rate, amount, net, vatRate, vat: 0 };
  });
  const total = roundMoney(out.reduce((s, l) => s + l.amount, 0));
  let netTotal = roundMoney(out.reduce((s, l) => s + l.net, 0));  // step 6

  // step 7: per line, unrounded, then the row is rounded once
  const taxLines = () => {
    let exact = 0;
    for (const l of out) { const v = (l.vatRate / 100) * l.net; l.vat = v; exact += v; }
    for (const l of out) l.vat = roundMoney(l.vat);
    return tax ? roundMoney(exact) : 0;
  };
  let vat = taxLines();
  const rowTotal = roundMoney(netTotal + vat);

  // step 8: inclusive prices may lose a cent when backed out; a difference up to 0.05 is kept on the grand total
  let grandTotal = rowTotal;
  if (inclusive) {
    const diff = roundMoney(total - rowTotal);
    if (diff !== 0 && Math.abs(diff) <= 0.05) grandTotal = roundMoney(rowTotal + diff);
  }

  // step 11: a discount on the whole invoice (see the top of this file)
  const discount = roundMoney(Math.min(Math.max(discountAmount, 0), grandTotal));
  if (discount > 0 && grandTotal > 0) {
    const wantNet = roundMoney(netTotal - roundMoney((discount * netTotal) / grandTotal));
    let sum = 0;
    out.forEach((l, i) => {
      if (i === out.length - 1) l.net = roundMoney(wantNet - sum);
      else { l.net = roundMoney(l.net - (discount * l.net) / grandTotal); sum = roundMoney(sum + l.net); }
    });
    netTotal = wantNet;
    vat = taxLines();
    const target = roundMoney(grandTotal - discount);
    const after = roundMoney(netTotal + vat);
    grandTotal = Math.abs(target - after) <= 0.05 ? target : after;
  }

  // step 10: whole shillings, half to even (01 §5.3 F: 3,274.50 -> 3,274)
  const roundedTotal = rounding ? roundHalfEven(grandTotal, 0) : grandTotal;
  return { lines: out, total, netTotal, vat, grandTotal, roundedTotal, roundingAdjustment: roundMoney(roundedTotal - grandTotal), discount };
}
