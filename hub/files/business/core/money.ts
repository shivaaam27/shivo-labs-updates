// Rounding helpers: one place, used by every part of the core (00 A8, 01 §2.4).
//
// Rule: round half to even ("Banker's rounding"). That is the rounding method of the ERPNext test site
// (01 §2.4, 00 A8), so our figures match the referee to the cent. Other values round normally.
//
// Precision:
// - money (TZS amounts: stock value, value change, ledger): 2 decimals (01 §2.4: currency precision 2).
// - quantities: 3 decimals, thousandths of a stock unit (00 A8; float precision 3 in 01 §2.4).
// - rates (TZS per unit): 9 decimals. The blueprint fixes no rate precision; rates must stay much finer
//   than amounts so that qty x rate still rounds to the right cent (02 §6.7: 13,525.4438 per unit),
//   and 9 decimals is far below the contract's RATE_TOLERANCE (0.0001).
//
// How a row's rate follows its rounded value (Moving Average: rounded value / qty; FIFO: exact layers)
// is explained at the top of stock/valuation.ts (learned from the referee, S06).

export const MONEY_DP = 2;
export const QTY_DP = 3;
export const RATE_DP = 9;

/** Round half to even at `dp` decimals. Exact halves hidden by float noise (2.675 is 2.67499999...) count as halves. */
export function roundHalfEven(x: number, dp: number): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** dp;
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  // A few units of float error, never less than 1e-9 of a unit.
  const eps = Math.max(1e-9, Math.abs(scaled) * 8 * Number.EPSILON);
  let whole: number;
  if (Math.abs(frac - 0.5) <= eps) whole = floor % 2 === 0 ? floor : floor + 1;
  else whole = Math.round(scaled);
  const out = whole / f;
  return out === 0 ? 0 : out; // never -0
}

export function roundMoney(x: number): number {
  return roundHalfEven(x, MONEY_DP);
}

export function roundQty(x: number): number {
  return roundHalfEven(x, QTY_DP);
}

export function roundRate(x: number): number {
  return roundHalfEven(x, RATE_DP);
}
