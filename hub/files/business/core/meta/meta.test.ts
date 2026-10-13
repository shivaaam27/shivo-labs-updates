// Every definition is consistent: links point at real definitions, sections and list columns name real fields,
// selects have options, naming fields exist, and definitions are pure data (survive JSON).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFS, getDef, ROLES, FIELD_TYPES } from './index.ts';

const RESERVED = new Set(['id', 'title', 'subtitle']);
const SORT_EXTRA = new Set(['title', 'name', 'modified', 'created']);

test('definition types are unique and snake_case', () => {
  const seen = new Set<string>();
  for (const d of DEFS) {
    assert.match(d.type, /^[a-z][a-z0-9_]*$/, d.type);
    assert.ok(!seen.has(d.type), `duplicate type ${d.type}`);
    seen.add(d.type);
  }
});

for (const d of DEFS) {
  test(`definition ${d.type} is valid`, () => {
    const keys = new Set<string>();
    assert.ok(d.label && d.plural && d.icon.includes('<'), 'label, plural and icon');
    for (const f of d.fields) {
      assert.match(f.key, /^[a-z][a-z0-9_]*$/, `${d.type}.${f.key} snake_case`);
      assert.ok(!RESERVED.has(f.key), `${d.type}.${f.key} is a reserved key`);
      assert.ok(!keys.has(f.key), `${d.type}.${f.key} twice`);
      keys.add(f.key);
      assert.ok(FIELD_TYPES.includes(f.type), `${d.type}.${f.key} type ${f.type}`);
      assert.ok(f.label, `${d.type}.${f.key} label`);
      if (f.type === 'select') {
        assert.ok(f.options?.length, `${d.type}.${f.key} options`);
        if (f.default !== undefined) assert.ok(f.options!.includes(String(f.default)), `${d.type}.${f.key} default not an option`);
      }
      if (f.type === 'link') {
        const to = getDef(f.to ?? '');
        assert.ok(to && !to.child, `${d.type}.${f.key} links to ${f.to}`);
        for (const k of Object.keys(f.filter ?? {})) assert.ok(to!.fields.some((x) => x.key === k), `${d.type}.${f.key} filter ${k}`);
      }
      if (f.type === 'table') {
        const of = getDef(f.of ?? '');
        assert.ok(of?.child, `${d.type}.${f.key} table of a child definition`);
        assert.ok(!d.child, 'no tables inside child rows');
      }
      if (f.unique === 'table') assert.ok(d.child, `${d.type}.${f.key}: unique 'table' is for child fields`);
      if (f.type === 'check') assert.ok(!f.required, `${d.type}.${f.key}: a check cannot be required`);
    }
    // form sections: real fields, each field once
    const inSections = d.sections.flatMap((s) => s.fields);
    for (const k of inSections) assert.ok(keys.has(k), `${d.type} section field ${k}`);
    assert.equal(new Set(inSections).size, inSections.length, `${d.type}: a field is in two sections`);
    for (const f of d.fields) if (!f.hidden) assert.ok(inSections.includes(f.key), `${d.type}.${f.key} is in no section`);
    // list
    for (const k of [...d.list.columns, ...d.list.filters]) {
      assert.ok(keys.has(k), `${d.type} list field ${k}`);
      assert.notEqual(d.fields.find((f) => f.key === k)!.type, 'table', `${d.type} list field ${k} is a table`);
    }
    assert.ok(keys.has(d.list.sort) || SORT_EXTRA.has(d.list.sort), `${d.type} sort ${d.list.sort}`);
    assert.ok(keys.has(d.title), `${d.type} title ${d.title}`);
    if (d.subtitle) assert.ok(keys.has(d.subtitle), `${d.type} subtitle ${d.subtitle}`);
    if (d.naming.by === 'field') {
      const nf = d.fields.find((f) => f.key === (d.naming as { field: string }).field);
      assert.ok(nf && nf.required, `${d.type} naming field must exist and be required`);
    } else {
      assert.match(d.naming.prefix, /^[A-Z]+-$/);
    }
    for (const r of d.related ?? []) {
      const rd = getDef(r.type);
      const by = rd?.fields.find((f) => f.key === r.by);
      assert.ok(by && by.type === 'link' && by.to === d.type, `${d.type} related ${r.type}.${r.by}`);
    }
    for (const list of Object.values(d.roles)) for (const role of list) assert.ok(ROLES.includes(role), `${d.type} role ${role}`);
    // pure data: nothing is lost on the way to the screens
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  });
}

test('every child definition is used by a table', () => {
  for (const d of DEFS.filter((x) => x.child)) {
    assert.ok(DEFS.some((p) => p.fields.some((f) => f.type === 'table' && f.of === d.type)), `${d.type} unused`);
  }
});
