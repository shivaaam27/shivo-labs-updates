// Every input listed in STEP_INPUTS is really read by the store (so a field map can never point at something that
// does nothing), and every kind the store accepts is listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEP_INPUTS } from './inputs.ts';
import { MONEY_KINDS } from '../core/money/books.ts';
import { SELL_KINDS } from '../core/sell/orders.ts';
import { SHIFT_KINDS } from './till.ts';

const CODE = ['steps.ts', 'money.ts', 'sell.ts', 'till.ts'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n');

test('every listed input is read by the store', () => {
  const unread: string[] = [];
  for (const [kind, keys] of Object.entries(STEP_INPUTS)) for (const k of keys) {
    const key = k.split('.').pop()!;
    if (!new RegExp(String.raw`(\.${key}\b|'${key}'|\[${key}\])`).test(CODE)) unread.push(`${kind}: ${k}`);
  }
  assert.deepEqual(unread, []);
});

test('every kind of step is listed', () => {
  for (const k of [...MONEY_KINDS, ...SELL_KINDS, ...SHIFT_KINDS, 'receipt', 'issue', 'transfer', 'count', 'purchase_receipt', 'delivery', 'landed_cost']) assert.ok(STEP_INPUTS[k], k);
});
