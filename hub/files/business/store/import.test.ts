// Excel (CSV) import: the parser, header mapping, links by name, preview vs commit, errors per row.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, mapHeaders } from './import.ts';
import { getDef } from '../core/meta/index.ts';
import { readyKit } from '../server/testkit.ts';
import type { Kit } from '../server/testkit.ts';

test('parser: BOM, quotes, commas and line breaks inside quotes, CRLF, blank lines', () => {
  const text = '﻿Code,Name,Notes\r\n"R-1","Rice, 5kg","He said ""fresh""\r\nsecond line"\r\n\r\nS-1,Sugar,\r\n';
  const { rows, lines } = parseCsv(text);
  assert.deepEqual(rows, [
    ['Code', 'Name', 'Notes'],
    ['R-1', 'Rice, 5kg', 'He said "fresh"\nsecond line'],
    ['S-1', 'Sugar', ''],
  ]);
  assert.deepEqual(lines, [1, 2, 5]);
});

test('parser: semicolon files (Excel in some languages) and no final newline', () => {
  assert.deepEqual(parseCsv('a;b\n"1;2";3').rows, [['a', 'b'], ['1;2', '3']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
});

test('headers map by label or key, in any case; duplicates and unknown columns are left out', () => {
  const cols = mapHeaders(getDef('product')!, ['CODE', 'Name', 'stock unit', 'Cost method', 'Colour', 'code']);
  assert.deepEqual(cols.map((c) => c.field), ['code', 'name', 'stock_unit', 'valuation_method', null, null]);
  const cust = mapHeaders(getDef('customer')!, ['ID', 'Name', 'Area', 'Route']);
  assert.deepEqual(cust.map((c) => c.field), ['_name', 'name', 'area', 'route']);
});

let k: Kit;
before(async () => { k = await readyKit(); });
after(() => k.done());

const CSV = [
  'Code,Name,Group,Stock unit,Cost method,Keep stock,Notes',
  'RICE-5,Rice 5kg,All Products,Pcs,Moving Average,yes,"Bags, 5 kg"',
  'OIL-1,Cooking Oil 1L,all products,pcs,fifo,ndiyo,',
  'BAD-1,,Nowhere,Pcs,LIFO,maybe,',
  'RICE-5,Rice again,All Products,Pcs,,,',
].join('\n');

test('preview shows what would happen and saves nothing', async () => {
  const r = await k.post('import/product', { csv: CSV, commit: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.committed, false);
  assert.deepEqual(r.body.counts, { total: 4, ok: 2, failed: 2, create: 2, update: 0, created: 0, updated: 0 });
  const bad = r.body.rows[2];
  assert.equal(bad.line, 4);
  assert.equal(bad.errors.name, 'Required');
  assert.match(bad.errors.group, /No product group called "Nowhere"/);
  assert.match(bad.errors.valuation_method, /Choose one of/);
  assert.equal(bad.errors.is_stock, 'Must be yes or no');
  assert.equal(r.body.rows[3].errors.code, 'Same as line 2');
  assert.equal((await k.get('list/product')).body.total, 0);
});

test('commit saves the good rows, resolves links by name, and skips the bad ones', async () => {
  const r = await k.post('import/product', { csv: CSV, commit: true });
  assert.equal(r.body.counts.created, 2);
  const list = await k.get('list/product', { sort: 'code' });
  assert.deepEqual(list.body.rows.map((x: any) => x.title), ['Cooking Oil 1L', 'Rice 5kg']);
  const oil = list.body.rows[0];
  assert.equal(oil._titles.group, 'All Products');
  const doc = await k.get(`doc/product/${list.body.rows[1].id}`);
  assert.equal(doc.body.doc.notes, 'Bags, 5 kg');
  const fifo = await k.get(`doc/product/${oil.id}`);
  assert.equal(fifo.body.doc.valuation_method, 'FIFO');
});

test('importing again updates by code and leaves empty cells alone', async () => {
  const r = await k.post('import/product', { csv: 'Code,Name\nrice-5,Rice 5 kg (Kilombero)', commit: true });
  assert.equal(r.body.counts.updated, 1);
  const list = await k.get('list/product', { q: 'kilombero' });
  assert.equal(list.body.total, 1);
  const doc = await k.get(`doc/product/${list.body.rows[0].id}`);
  assert.equal(doc.body.doc.notes, 'Bags, 5 kg');
});

test('customers with links (group, price list) and a file with no known column', async () => {
  const r = await k.post('import/customer', { csv: 'Name,Phone,Price list,Credit limit\nDuka la Ali,0754 111 222,Wholesale,"1,500,000"', commit: true });
  assert.equal(r.body.counts.created, 1, JSON.stringify(r.body));
  const c = await k.get('list/customer', { q: 'ali' });
  assert.equal(c.body.rows[0].phone, '+255754111222');
  const doc = await k.get(`doc/customer/${c.body.rows[0].id}`);
  assert.equal(doc.body.doc.credit_limit, 1500000);
  assert.equal(doc.body.doc._titles.price_list, 'Wholesale');
  assert.equal((await k.post('import/customer', { csv: 'Foo,Bar\n1,2', commit: false })).status, 422);
  assert.equal((await k.post('import/customer', { csv: '', commit: false })).status, 400);
  // Buying is not a selling price list
  const buy = await k.post('import/customer', { csv: 'Name,Price list\nX,Buying', commit: false });
  assert.equal(buy.body.rows[0].errors.price_list, 'Buying cannot be used here');
});
