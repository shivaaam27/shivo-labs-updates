// Amounts in words (phase 4e): English as on ERPNext's printed invoices, and Swahili for customers who read Swahili.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, englishWords, swahiliWords } from './words.ts';

test('English words for whole numbers', () => {
  assert.equal(englishWords(0), 'Zero');
  assert.equal(englishWords(7), 'Seven');
  assert.equal(englishWords(19), 'Nineteen');
  assert.equal(englishWords(40), 'Forty');
  assert.equal(englishWords(105), 'One Hundred Five');
  assert.equal(englishWords(118000), 'One Hundred Eighteen Thousand');
  assert.equal(englishWords(1234567), 'One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven');
  assert.equal(englishWords(2000000005), 'Two Billion Five');
  assert.equal(englishWords(1000000000000), 'One Trillion');
});

test('English amounts, with cents', () => {
  assert.equal(amountInWords(118000), 'Tanzanian Shillings One Hundred Eighteen Thousand Only');
  assert.equal(amountInWords(118000.5), 'Tanzanian Shillings One Hundred Eighteen Thousand and Fifty Cents Only');
  assert.equal(amountInWords(3274.01), 'Tanzanian Shillings Three Thousand Two Hundred Seventy Four and One Cent Only');
  assert.equal(amountInWords(0), 'Tanzanian Shillings Zero Only');
  // a return is said as its size
  assert.equal(amountInWords(-2500), 'Tanzanian Shillings Two Thousand Five Hundred Only');
  // no float noise: 0.29 * 100 is 28.999…
  assert.equal(amountInWords(10.29), 'Tanzanian Shillings Ten and Twenty Nine Cents Only');
});

test('Swahili words for whole numbers', () => {
  assert.equal(swahiliWords(0), 'sifuri');
  assert.equal(swahiliWords(8), 'nane');
  assert.equal(swahiliWords(18), 'kumi na nane');
  assert.equal(swahiliWords(50), 'hamsini');
  assert.equal(swahiliWords(105), 'mia moja na tano');
  assert.equal(swahiliWords(120), 'mia moja na ishirini');
  assert.equal(swahiliWords(125), 'mia moja ishirini na tano');
  assert.equal(swahiliWords(1250), 'elfu moja, mia mbili na hamsini');
  assert.equal(swahiliWords(18000), 'elfu kumi na nane');
  // 10,008 must not read like 18,000
  assert.equal(swahiliWords(10008), 'elfu kumi, na nane');
  assert.equal(swahiliWords(118000), 'laki moja, elfu kumi na nane');
  assert.equal(swahiliWords(118500), 'laki moja, elfu kumi na nane, mia tano');
  assert.equal(swahiliWords(1500000), 'milioni moja, laki tano');
  assert.equal(swahiliWords(250000000), 'milioni mia mbili na hamsini');
});

test('Swahili amounts, with cents', () => {
  assert.equal(amountInWords(118000, 'Swahili'), 'Shilingi za Kitanzania laki moja, elfu kumi na nane tu');
  assert.equal(amountInWords(2500.5, 'Swahili'), 'Shilingi za Kitanzania elfu mbili, mia tano na senti hamsini tu');
});
