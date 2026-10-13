// Rounding: half to even, 2 dp for TZS amounts (01 §2.4 examples).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundHalfEven, roundMoney, roundQty } from './money.ts';

test('half to even at whole shillings (01 §2.4: 3,274.50 -> 3,274; 3,275.50 -> 3,276)', () => {
  assert.equal(roundHalfEven(3274.5, 0), 3274);
  assert.equal(roundHalfEven(3275.5, 0), 3276);
  assert.equal(roundHalfEven(-2.5, 0), -2);
});

test('money: 2 decimals, halves to even even when float noise hides them', () => {
  assert.equal(roundMoney(17455.621), 17455.62);
  assert.equal(roundMoney(2.675), 2.68);
  assert.equal(roundMoney(2.665), 2.66);
  assert.equal(roundMoney(1.005), 1);
  assert.equal(roundMoney(648.3042), 648.3);
  assert.equal(roundMoney(-0.001), 0);
  assert.ok(!Object.is(roundMoney(-0.001), -0));
});

test('quantities: 3 decimals', () => {
  assert.equal(roundQty(0.1 + 0.2), 0.3);
  assert.equal(roundQty(1.0005), 1);
});
