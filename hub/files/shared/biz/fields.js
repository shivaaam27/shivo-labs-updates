// One widget per field type (business/FRAME.md): text, longtext, number, money, percent, check, select, date,
// link, table, phone, email, tin. Each widget: { el, get(), set(v), focus(), error(msg), key }.
// `display()` gives the read-only HTML for view mode. Every value goes through esc().
import { enhanceSelects } from '../select.js';
import { esc, svg, I, money, qty, num, date, debounce } from './ui.js';

let uid = 0;
const nid = (k) => `bzf-${k}-${++uid}`;
const NUMERIC = new Set(['number', 'money', 'percent']);
/** The title the server sent for a link value (records carry them in _titles). */
export const linkTitle = (doc, key) => doc?._titles?.[key] || doc?.[key + '_title'] || undefined;
export const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

/** Title of a linked record, cached per screen; `ctx.titleOf(type, id)` returns a Promise<string>. */
export function titleCache(api, defs) {
  const cache = new Map();
  return (type, id) => {
    if (isEmpty(id)) return Promise.resolve('');
    const k = type + '\u0000' + id;
    if (!cache.has(k)) {
      cache.set(k, api.doc(type, id).then((r) => {
        const d = r?.doc || r;
        return String(d?.title ?? d?.name ?? id);
      }).catch(() => String(id)));
    }
    return cache.get(k);
  };
}

// ---------- read-only
export function display(f, v, doc = {}) {
  if (f.type === 'check') return v ? `<span class="bz-yes">${svg(I.check)}Yes</span>` : '<span class="bz-no">No</span>';
  if (isEmpty(v)) return '<span class="bz-none">—</span>';
  switch (f.type) {
    case 'money': return `<span class="bz-num">${esc(money(v))}</span>`;
    case 'number': return `<span class="bz-num">${esc(qty(v))}</span>`;
    case 'percent': return `<span class="bz-num">${esc(qty(v))} %</span>`;
    case 'date': return esc(date(v));
    case 'longtext': return `<span class="bz-pre">${esc(v)}</span>`;
    case 'email': return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
    case 'phone': return `<a href="tel:${esc(String(v).replace(/\s/g, ''))}">${esc(v)}</a>`;
    case 'link': {
      const t = linkTitle(doc, f.key);
      return `<a class="bz-lnk" href="#" data-type="${esc(f.to)}" data-id="${esc(v)}">${esc(t ?? v)}</a>`;
    }
    case 'table': return ''; // drawn by the form (needs the child definition)
    default: return esc(v);
  }
}

/** Cell text for lists (shorter than display). */
export function cell(f, v, row = {}) {
  if (!f) return esc(v ?? '');
  if (f.type === 'check') return v ? svg(I.check, 'bz-tick') : '';
  if (isEmpty(v)) return '';
  if (f.type === 'money') return esc(money(v).replace('TZS ', ''));
  if (f.type === 'number') return esc(qty(v));
  if (f.type === 'percent') return esc(qty(v)) + ' %';
  if (f.type === 'date') return esc(date(v));
  if (f.type === 'link') return esc(linkTitle(row, f.key) ?? v);
  if (f.type === 'table') return Array.isArray(v) ? esc(v.length) : '';
  return esc(v);
}

// ---------- editing
/**
 * makeField(field, value, ctx) → widget.
 * ctx: { api, defs, doc, titleOf, canCreate(type), quickCreate(type, text) → Promise<{id,title}|undefined>, onChange(), compact }
 */
export function makeField(f, value, ctx = {}) {
  const id = nid(f.key);
  const el = document.createElement('div');
  el.className = `bz-fld t-${f.type}${f.type === 'table' || f.type === 'longtext' ? ' wide' : ''}`;
  el.dataset.key = f.key;
  const req = f.required ? '<i class="req" aria-hidden="true">*</i>' : '';
  const label = `<label class="bz-lbl" for="${id}">${esc(f.label || f.key)}${req}</label>`;
  const help = f.help && !ctx.compact ? `<small class="bz-help">${esc(f.help)}</small>` : '';
  const errEl = '<small class="bz-ferr" role="alert"></small>';
  const changed = () => ctx.onChange?.();
  let w;

  if (f.readOnly) {
    el.innerHTML = `${label}<div class="bz-ro" id="${id}">${display(f, value, ctx.doc || {})}</div>${help}${errEl}`;
    w = { get: () => value, set: (v) => { value = v; el.querySelector('.bz-ro').innerHTML = display(f, v, ctx.doc || {}); }, focus: () => {} };
  } else if (f.type === 'check') {
    el.innerHTML = `<div class="bz-chk"><span class="bz-lbl" id="${id}-l">${esc(f.label || f.key)}${req}</span>
      <button type="button" class="sw" role="switch" id="${id}" aria-labelledby="${id}-l"></button></div>${help}${errEl}`;
    const b = el.querySelector('.sw');
    let on = !!value;
    const draw = () => { b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); };
    b.onclick = () => { on = !on; draw(); changed(); };
    draw();
    w = { get: () => on, set: (v) => { on = !!v; draw(); }, focus: () => b.focus() };
  } else if (f.type === 'select') {
    const opts = (f.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
    el.innerHTML = `${label}<select id="${id}">${f.required && !isEmpty(value) ? '' : '<option value="">—</option>'}${opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>${help}${errEl}`;
    const s = el.querySelector('select');
    s.value = isEmpty(value) ? '' : String(value);
    enhanceSelects(el);
    const btn = el.querySelector('.sl-btn');
    btn.id = id + '-b'; btn.setAttribute('aria-label', f.label || f.key);
    el.querySelector('label').htmlFor = btn.id;
    s.addEventListener('change', changed);
    w = { get: () => (s.value === '' ? null : s.value), set: (v) => { s.value = isEmpty(v) ? '' : String(v); }, focus: () => btn.focus() };
  } else if (f.type === 'link') {
    w = linkWidget(f, value, ctx, el, id, label + '', help, errEl, changed);
  } else if (f.type === 'table') {
    w = tableWidget(f, value, ctx, el, id, help, errEl, changed);
  } else if (f.type === 'longtext') {
    el.innerHTML = `${label}<textarea class="bz-in" id="${id}" rows="3"></textarea>${help}${errEl}`;
    const t = el.querySelector('textarea');
    t.value = value ?? '';
    const grow = () => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 320) + 'px'; };
    t.addEventListener('input', () => { grow(); changed(); });
    requestAnimationFrame(grow);
    w = { get: () => (t.value.trim() === '' ? null : t.value), set: (v) => { t.value = v ?? ''; grow(); }, focus: () => t.focus() };
  } else {
    const kind = { phone: 'tel', email: 'email', date: 'date' }[f.type] || 'text';
    const mode = NUMERIC.has(f.type) ? 'decimal' : f.type === 'tin' ? 'numeric' : f.type === 'phone' ? 'tel' : '';
    const pre = f.type === 'money' ? '<span class="bz-adorn">TZS</span>' : '';
    const post = f.type === 'percent' ? '<span class="bz-adorn">%</span>' : '';
    const ph = f.type === 'tin' ? '123-456-789' : f.type === 'phone' ? '07XX XXX XXX' : f.placeholder || '';
    el.innerHTML = `${label}<div class="bz-inw${pre || post ? ' adorned' : ''}">${pre}<input class="bz-in${NUMERIC.has(f.type) ? ' n' : ''}" id="${id}" type="${kind}"${mode ? ` inputmode="${mode}"` : ''}${ph ? ` placeholder="${esc(ph)}"` : ''} autocomplete="off"${f.type === 'tin' ? ' maxlength="11"' : ''}>${post}</div>${help}${errEl}`;
    const inp = el.querySelector('input');
    const show = (v) => {
      if (isEmpty(v)) return '';
      if (f.type === 'money') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
      return String(v);
    };
    inp.value = show(value);
    inp.addEventListener('input', changed);
    if (f.type === 'money') {
      inp.addEventListener('blur', () => { const n = num(inp.value); if (n !== null && !isNaN(n)) inp.value = show(n); });
    }
    w = {
      get: () => {
        if (NUMERIC.has(f.type)) return num(inp.value);
        const t = inp.value.trim();
        return t === '' ? null : t;
      },
      set: (v) => { inp.value = show(v); },
      focus: () => inp.focus(),
    };
  }
  const ferr = el.querySelector(':scope > .bz-ferr');
  w.el = el; w.key = f.key; w.field = f;
  w.error = w.error || ((msg) => { el.classList.toggle('bad', !!msg); ferr.textContent = msg || ''; });
  return w;
}

/** Quick checks before asking the server (the server checks again, properly). */
export function localCheck(f, v) {
  if (f.readOnly || f.hidden) return '';
  if (f.required && f.type !== 'check' && isEmpty(v)) return 'Required';
  if (NUMERIC.has(f.type) && v !== null && isNaN(v)) return 'Enter a number';
  if (NUMERIC.has(f.type) && typeof v === 'number') {
    if (f.integer && !Number.isInteger(v)) return 'Whole numbers only';
    if (f.min !== undefined && v < f.min) return `At least ${f.min}`;
    if (f.max !== undefined && v > f.max) return `At most ${f.max}`;
  }
  if (f.type === 'email' && v && !/^\S+@\S+\.\S+$/.test(v)) return 'Check the email address';
  return '';
}

// ---------- link: a searchable dropdown that looks like shared/select.js
function linkWidget(f, value, ctx, el, id, label, help, errEl, changed) {
  const target = ctx.defs?.[f.to];
  const tLabel = target?.label || f.to;
  el.innerHTML = `${label}<div class="bz-link sl"><div class="bz-inw">
      <input class="bz-in" id="${id}" role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off" placeholder="Search ${esc(tLabel.toLowerCase())}…">
      <button type="button" class="bz-clear" tabindex="-1" aria-label="Clear" hidden>${svg(I.close)}</button>
      <span class="bz-chev">${svg(I.chev)}</span></div></div>${help}${errEl}`;
  const wrap = el.querySelector('.bz-link');
  const inp = el.querySelector('input');
  const clear = el.querySelector('.bz-clear');
  let cur = isEmpty(value) ? null : value;
  let title = linkTitle(ctx.doc, f.key) ?? '';
  let pop = null, opts = [], hl = 0, seq = 0, quiet = false;
  const canNew = !!(ctx.canCreate?.(f.to) && ctx.quickCreate);

  const paintValue = () => { inp.value = cur === null ? '' : (title || String(cur)); clear.hidden = cur === null; };
  if (cur !== null && !title && ctx.titleOf) ctx.titleOf(f.to, cur).then((t) => { if (cur === value) { const untouched = inp.value === String(cur); title = t; if (document.activeElement !== inp || untouched) paintValue(); } });
  paintValue();

  function close() { pop?.remove(); pop = null; inp.setAttribute('aria-expanded', 'false'); }
  function render(q) {
    if (!pop) { pop = document.createElement('div'); pop.className = 'sl-pop'; pop.setAttribute('role', 'listbox'); pop.id = id + '-pop'; wrap.append(pop); inp.setAttribute('aria-controls', pop.id); }
    const items = opts.map((o, i) => `<div class="sl-opt${String(o.id) === String(cur) ? ' on' : ''}" role="option" data-i="${i}"><span><span class="bz-ot">${esc(o.title ?? o.id)}</span>${o.subtitle ? `<small>${esc(o.subtitle)}</small>` : ''}</span>${String(o.id) === String(cur) ? svg(I.check) : ''}</div>`);
    if (!opts.length) items.push(`<div class="sl-empty">${q ? `No ${esc(tLabel.toLowerCase())} matches “${esc(q)}”` : `No ${esc((target?.plural || tLabel).toLowerCase())} yet`}</div>`);
    if (canNew) items.push(`<div class="sl-opt bz-new" role="option" data-i="new">${svg(I.plus)}<span>Create new ${esc(tLabel.toLowerCase())}${q ? ` “${esc(q)}”` : ''}…</span></div>`);
    pop.innerHTML = items.join('');
    pop.querySelectorAll('.sl-opt').forEach((o) => (o.onpointerdown = (e) => { e.preventDefault(); pick(o.dataset.i); }));
    const r = inp.getBoundingClientRect();
    pop.classList.toggle('up', innerHeight - r.bottom < 260 && r.top > innerHeight - r.bottom);
    inp.setAttribute('aria-expanded', 'true');
    mark();
  }
  const count = () => opts.length + (canNew ? 1 : 0);
  function mark() {
    if (!pop) return;
    const all = [...pop.querySelectorAll('.sl-opt')];
    all.forEach((x, i) => x.classList.toggle('hl', i === hl));
    all[hl]?.scrollIntoView({ block: 'nearest' });
    if (all[hl]) { all[hl].id = all[hl].id || `${id}-o${hl}`; inp.setAttribute('aria-activedescendant', all[hl].id); }
  }
  const load = debounce(async (q) => {
    const my = ++seq;
    try {
      const r = await ctx.api.options(f.to, q, f.filter);
      if (my !== seq || document.activeElement !== inp) return;
      opts = Array.isArray(r) ? r : r?.options || r?.rows || [];
    } catch { opts = []; }
    hl = Math.max(0, opts.findIndex((o) => String(o.id) === String(cur)));
    render(q);
  }, 140);
  async function pick(i) {
    if (i === 'new') {
      const text = inp.value.trim() !== title ? inp.value.trim() : '';
      close();
      const made = await ctx.quickCreate(f.to, text);
      if (made) { cur = made.id; title = made.title; paintValue(); changed(); }
      quiet = true; inp.focus(); quiet = false;
      return;
    }
    const o = opts[+i];
    if (!o) return;
    cur = o.id; title = String(o.title ?? o.id);
    paintValue(); close(); changed();
    ctx.onPick?.(f, o);
  }
  inp.addEventListener('focus', () => { if (quiet) return; inp.select(); load(''); });
  inp.addEventListener('input', () => { hl = 0; load(inp.value.trim()); });
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      if (wrap.contains(document.activeElement)) return;
      close();
      if (inp.value.trim() === '' && cur !== null) { cur = null; title = ''; changed(); }
      paintValue();
    }, 120);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!pop) return load(inp.value.trim()); hl = Math.min(count() - 1, hl + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(0, hl - 1); mark(); }
    else if (e.key === 'Enter' && pop) { e.preventDefault(); pick(hl < opts.length ? hl : canNew ? 'new' : hl); }
    else if (e.key === 'Escape' && pop) { e.preventDefault(); e.stopPropagation(); close(); paintValue(); }
  });
  clear.onclick = () => { cur = null; title = ''; paintValue(); changed(); inp.focus(); };
  return {
    get: () => cur,
    set: (v, t) => { cur = isEmpty(v) ? null : v; title = t || ''; paintValue(); if (cur !== null && !t && ctx.titleOf) ctx.titleOf(f.to, cur).then((x) => { title = x; paintValue(); }); },
    focus: () => inp.focus(),
    title: () => title,
  };
}

// ---------- table: inline rows of a child definition
function tableWidget(f, value, ctx, el, id, help, errEl, changed) {
  const child = ctx.defs?.[f.of];
  const cols = (child?.fields || []).filter((c) => !c.hidden);
  el.innerHTML = `<div class="bz-lbl" id="${id}">${esc(f.label || f.key)}${f.required ? '<i class="req">*</i>' : ''}</div>${help}
    <div class="bz-tbl" role="table" aria-labelledby="${id}" style="--cols:${cols.map((c) => (c.type === 'check' ? '5rem' : NUMERIC.has(c.type) ? 'minmax(6rem,.7fr)' : 'minmax(8rem,1fr)')).join(' ')} 2.4rem">
      <div class="bz-tr bz-th" role="row">${cols.map((c) => `<span role="columnheader">${esc(c.label || c.key)}${c.required ? '<i class="req">*</i>' : ''}</span>`).join('')}<span></span></div>
      <div class="bz-tb"></div>
    </div>
    <button type="button" class="tbtn bz-addrow">${svg(I.plus)}Add ${esc((child?.label || 'row').toLowerCase())}</button>${errEl}`;
  const body = el.querySelector('.bz-tb');
  const rows = [];
  function addRow(data = {}, focus = false) {
    const tr = document.createElement('div');
    tr.className = 'bz-tr'; tr.setAttribute('role', 'row');
    const cells = cols.map((c) => {
      const w = makeField(c, Object.keys(data).length ? data[c.key] : c.default, { ...ctx, compact: true, doc: data });
      w.el.setAttribute('role', 'cell');
      tr.append(w.el);
      return w;
    });
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'ibtn bz-rmrow'; rm.setAttribute('aria-label', 'Remove this row'); rm.innerHTML = svg(I.trash);
    const row = { tr, cells, keep: data };
    rm.onclick = () => { rows.splice(rows.indexOf(row), 1); tr.remove(); changed(); (body.querySelector('.bz-tr:last-child input, .bz-tr:last-child button') || el.querySelector('.bz-addrow')).focus(); };
    tr.append(rm);
    body.append(tr);
    rows.push(row);
    if (focus) cells[0]?.focus();
  }
  (Array.isArray(value) ? value : []).forEach((r) => addRow(r || {}));
  el.querySelector('.bz-addrow').onclick = () => { addRow({}, true); changed(); };
  const ferr = el.querySelector(':scope > .bz-ferr');
  // Empty rows are not sent, so the server numbers only the rows it got: keep the same list to put its
  // row errors back on the right visible row (review 13 Oct 2026, item 7).
  const valueOf = (r) => { const o = { ...r.keep }; r.cells.forEach((c) => { o[c.key] = c.get(); }); return o; };
  const isSent = (o) => cols.some((c) => !isEmpty(o[c.key]) && !(c.type === 'check' && o[c.key] === false));
  const sentRows = () => rows.filter((r) => isSent(valueOf(r)));
  return {
    get: () => rows.map(valueOf).filter(isSent),
    set: (v) => { rows.splice(0).forEach((r) => r.tr.remove()); (Array.isArray(v) ? v : []).forEach((r) => addRow(r || {})); },
    focus: () => (rows[0]?.cells[0] || { focus: () => el.querySelector('.bz-addrow').focus() }).focus(),
    error: (msg) => { el.classList.toggle('bad', !!msg); ferr.textContent = msg || ''; },
    cellError: (i, key, msg) => { const c = sentRows()[i]?.cells.find((x) => x.key === key); if (c) { c.error(msg); return true; } return false; },
    clearCells: () => rows.forEach((r) => r.cells.forEach((c) => c.error(''))),
    check: () => {
      let bad = 0;
      const live = rows.filter((r) => r.cells.some((c) => !isEmpty(c.get()) && !(c.field.type === 'check' && c.get() === false)));
      live.forEach((r) => r.cells.forEach((c) => { const m = localCheck(c.field, c.get()); c.error(m); if (m) bad++; }));
      return bad;
    },
  };
}
