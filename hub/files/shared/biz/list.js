// One list view for any definition (business/FRAME.md): title + count, search, filter chips (list.filters),
// sortable columns, paging, row → detail, "+ New", CSV import with a preview of each row's problems.
import { esc, svg, I, debounce, modal, busy, errText, popMenu, qty } from './ui.js';
import { cell } from './fields.js';

const PAGE = 50;
const NUMERIC = new Set(['number', 'money', 'percent']);

/**
 * mountList(el, kit, { type, state }) — `state` ({q, sort, dir, filters, filterTitles, offset}) is kept by the shell
 * so coming back to a list finds it as it was. Returns leave().
 */
export function mountList(el, kit, { type, state = {} }) {
  const def = kit.defs[type];
  const byKey = Object.fromEntries(def.fields.map((f) => [f.key, f]));
  const cols = (def.list?.columns?.length ? def.list.columns : [def.title]).filter((k) => byKey[k] || k === 'title');
  const filters = (def.list?.filters || []).map((k) => byKey[k]).filter(Boolean);
  const st = Object.assign(state, {
    q: state.q || '', sort: state.sort || def.list?.sort || def.title, dir: state.dir || def.list?.dir || 'asc',
    filters: state.filters || {}, filterTitles: state.filterTitles || {}, offset: state.offset || 0,
  });
  let alive = true, seq = 0, total = 0, rows = [];
  const canWrite = kit.can(type, 'write');
  const lower = def.plural.toLowerCase();

  const widths = cols.map((k, i) => {
    const f = byKey[k];
    if (i === 0) return 'minmax(10rem,2fr)';
    if (f?.type === 'check') return 'minmax(4.5rem,.5fr)';
    if (NUMERIC.has(f?.type)) return 'minmax(6rem,1fr)';
    return 'minmax(7rem,1.2fr)';
  }).join(' ');

  el.innerHTML = `<div class="bz-listv">
    <div class="bz-bar">
      <label class="bz-search"><span class="bz-sr">Search ${esc(lower)}</span>${svg(I.search)}<input type="search" id="bzQ" placeholder="Search ${esc(lower)}…" autocomplete="off" value="${esc(st.q)}"></label>
      <div class="bz-chips" id="bzChips"></div>
      <span class="bz-grow"></span>
      ${canWrite ? `<button class="tbtn" id="bzImport">${svg(I.upload)}Import</button><button class="btn pri sm" id="bzNew">${svg(I.plus)}New ${esc(def.label.toLowerCase())}</button>` : ''}
    </div>
    <section class="card bz-table" style="--cols:${widths}">
      <div class="bz-tr bz-th" role="row">${cols.map((k) => {
        const f = byKey[k];
        return `<button class="bz-sort${NUMERIC.has(f?.type) ? ' n' : ''}" data-k="${esc(k)}" role="columnheader">${esc(f?.label || 'Title')}<span class="bz-arr"></span></button>`;
      }).join('')}</div>
      <div class="bz-tbody" id="bzRows" role="rowgroup"></div>
    </section>
    <div class="bz-pager" id="bzPager"></div>
  </div>`;
  const $ = (s) => el.querySelector(s);

  function chips() {
    $('#bzChips').innerHTML = filters.map((f) => {
      const v = st.filters[f.key];
      const on = v !== undefined && v !== '';
      const shown = !on ? 'Any' : f.type === 'check' ? (String(v) === '1' || v === true || v === 'true' ? 'Yes' : 'No') : (st.filterTitles[f.key] ?? v);
      return `<span class="bz-chip${on ? ' on' : ''}"><button class="bz-chip-b" data-k="${esc(f.key)}" aria-haspopup="menu">${esc(f.label)}: <b>${esc(shown)}</b>${svg(I.chev)}</button>${on ? `<button class="bz-chip-x" data-x="${esc(f.key)}" aria-label="Clear ${esc(f.label)} filter">${svg(I.close)}</button>` : ''}</span>`;
    }).join('');
    // a filter that came from "Used in" on another record (not one of list.filters)
    for (const [k, v] of Object.entries(st.filters)) {
      if (filters.some((f) => f.key === k) || v === undefined || v === '') continue;
      $('#bzChips').insertAdjacentHTML('beforeend', `<span class="bz-chip on"><span class="bz-chip-b">${esc(byKey[k]?.label || k)}: <b>${esc(st.filterTitles[k] ?? v)}</b></span><button class="bz-chip-x" data-x="${esc(k)}" aria-label="Clear filter">${svg(I.close)}</button></span>`);
    }
    el.querySelectorAll('.bz-chip-b[data-k]').forEach((b) => (b.onclick = () => pickFilter(b, byKey[b.dataset.k])));
    el.querySelectorAll('.bz-chip-x').forEach((b) => (b.onclick = () => { delete st.filters[b.dataset.x]; delete st.filterTitles[b.dataset.x]; st.offset = 0; chips(); load(); }));
  }

  async function pickFilter(btn, f) {
    let items = [{ label: 'Any', value: '' }];
    const cur = st.filters[f.key] ?? '';
    if (f.type === 'check') items.push({ label: 'Yes', value: '1' }, { label: 'No', value: '0' });
    else if (f.type === 'select') items.push(...(f.options || []).map((o) => ({ label: o, value: o })));
    else if (f.type === 'link') {
      try { const r = await kit.api.options(f.to, ''); items.push(...(Array.isArray(r) ? r : r?.options || []).map((o) => ({ label: String(o.title ?? o.id), sub: o.subtitle, value: String(o.id) }))); }
      catch (e) { return kit.toast(errText(e)); }
    }
    items = items.map((it) => ({ ...it, on: String(it.value) === String(cur) }));
    const v = await popMenu(btn, items);
    if (v === undefined) return;
    if (v === '') { delete st.filters[f.key]; delete st.filterTitles[f.key]; }
    else { st.filters[f.key] = v; st.filterTitles[f.key] = items.find((x) => x.value === v)?.label; }
    st.offset = 0; chips(); load();
    el.querySelector(`.bz-chip-b[data-k="${CSS.escape(f.key)}"]`)?.focus();
  }

  function heads() {
    el.querySelectorAll('.bz-sort').forEach((b) => {
      const on = b.dataset.k === st.sort;
      b.classList.toggle('on', on);
      b.setAttribute('aria-sort', on ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      b.querySelector('.bz-arr').innerHTML = on ? svg(st.dir === 'asc' ? I.up : I.down) : '';
    });
  }

  async function load() {
    const my = ++seq;
    $('#bzRows').classList.add('loading');
    let r;
    try { r = await kit.api.list(type, { q: st.q, sort: st.sort, dir: st.dir, limit: PAGE, offset: st.offset, filters: st.filters }); }
    catch (e) {
      if (my !== seq || !alive) return;
      $('#bzRows').classList.remove('loading');
      $('#bzRows').innerHTML = `<div class="bz-empty"><b>Could not load ${esc(lower)}</b><p>${esc(errText(e))}</p><button class="btn sm" id="bzRetry">Try again</button></div>`;
      $('#bzRetry').onclick = load;
      return;
    }
    if (my !== seq || !alive) return;
    rows = r?.rows || []; total = r?.total ?? rows.length;
    if (st.offset && !rows.length && total) { st.offset = Math.max(0, Math.floor((total - 1) / PAGE) * PAGE); return load(); }
    $('#bzRows').classList.remove('loading');
    paintRows();
  }

  function paintRows() {
    const filtered = st.q || Object.keys(st.filters).length;
    kit.setTitle(def.plural, `${qty(total)} ${total === 1 ? def.label.toLowerCase() : lower}${def.description ? ' · ' + def.description : ''}`);
    el.querySelector('.bz-table').hidden = !rows.length;
    const box = $('#bzRows');
    if (!rows.length) {
      el.querySelector('.bz-table').hidden = true;
      $('#bzPager').innerHTML = '';
      const empty = filtered
        ? `<div class="bz-empty card"><span class="bz-ic big">${svg(I.search)}</span><b>Nothing matches${st.q ? ` “${esc(st.q)}”` : ''}</b><p>Try fewer letters, or clear the search and filters.</p><button class="btn sm" id="bzClear">Clear search and filters</button></div>`
        : `<div class="bz-empty card"><span class="bz-ic big">${svg(def.icon)}</span><b>No ${esc(lower)} yet</b><p>${esc(def.description || '')}</p>
            ${canWrite ? `<div class="bz-acts2"><button class="btn pri sm" id="bzNew2">${svg(I.plus)}Add the first ${esc(def.label.toLowerCase())}</button><button class="btn sm" id="bzImp2">${svg(I.upload)}Import from a CSV file</button></div>` : '<p class="bz-muted">Nothing here yet.</p>'}</div>`;
      el.querySelector('.bz-emptyhost')?.remove();
      el.querySelector('.bz-table').insertAdjacentHTML('afterend', `<div class="bz-emptyhost">${empty}</div>`);
      $('#bzClear')?.addEventListener('click', () => { st.q = ''; st.filters = {}; st.filterTitles = {}; st.offset = 0; $('#bzQ').value = ''; chips(); load(); });
      $('#bzNew2')?.addEventListener('click', () => kit.nav(`n/${type}`));
      $('#bzImp2')?.addEventListener('click', () => importCsv(kit, def, load));
      box.innerHTML = '';
      return;
    }
    el.querySelector('.bz-emptyhost')?.remove();
    box.innerHTML = rows.map((r, i) => `<button class="bz-tr" data-id="${esc(r.id)}" role="row" style="--i:${Math.min(i, 12)}">${cols.map((k, j) => {
      const f = byKey[k];
      const v = j === 0 ? (r.title ?? r[k]) : r[k];
      const c = j === 0 ? esc(v ?? '') : cell(f, v, r);
      return `<span role="cell" class="${j === 0 ? 'bz-t1' : ''}${NUMERIC.has(f?.type) ? ' n' : ''}" data-l="${esc(f?.label || '')}">${c || (j ? '' : '<i class="bz-none">(no name)</i>')}</span>`;
    }).join('')}</button>`).join('');
    box.querySelectorAll('.bz-tr').forEach((b) => (b.onclick = () => kit.nav(`d/${type}/${b.dataset.id}`)));
    const from = st.offset + 1, to = st.offset + rows.length;
    $('#bzPager').innerHTML = total > PAGE ? `<span>${qty(from)}–${qty(to)} of ${qty(total)}</span>
      <button class="tbtn" id="bzPrev"${st.offset ? '' : ' disabled'}>${svg(I.back)}Previous</button><button class="tbtn" id="bzNext"${to < total ? '' : ' disabled'}>Next${svg(I.right)}</button>` : '';
    $('#bzPrev')?.addEventListener('click', () => { st.offset = Math.max(0, st.offset - PAGE); load(); });
    $('#bzNext')?.addEventListener('click', () => { st.offset += PAGE; load(); });
  }

  const search = debounce(() => { st.offset = 0; load(); }, 200);
  $('#bzQ').addEventListener('input', (e) => { st.q = e.target.value.trim(); search(); });
  $('#bzQ').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); el.querySelector('.bz-tbody .bz-tr')?.focus(); }
    if (e.key === 'Enter' && rows.length === 1) kit.nav(`d/${type}/${rows[0].id}`);
  });
  // arrow keys move between rows
  $('#bzRows').addEventListener('keydown', (e) => {
    const r = e.target.closest('.bz-tr'); if (!r) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); r.nextElementSibling?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (r.previousElementSibling || $('#bzQ')).focus(); }
  });
  el.querySelectorAll('.bz-sort').forEach((b) => (b.onclick = () => {
    if (st.sort === b.dataset.k) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = b.dataset.k; st.dir = NUMERIC.has(byKey[b.dataset.k]?.type) ? 'desc' : 'asc'; }
    st.offset = 0; heads(); load();
  }));
  $('#bzNew')?.addEventListener('click', () => kit.nav(`n/${type}`));
  $('#bzImport')?.addEventListener('click', () => importCsv(kit, def, load));

  kit.setTitle(def.plural, def.description || '');
  chips(); heads(); load();
  return () => { alive = false; };
}

// ---------- CSV import: choose a file, see each row's problems, then import the good rows
const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

export function importCsv(kit, def, after) {
  const fields = def.fields.filter((f) => !f.hidden && !f.readOnly && f.type !== 'table');
  const byKey = Object.fromEntries(def.fields.map((f) => [f.key, f]));
  const body = document.createElement('div');
  body.className = 'bz-imp';
  const m = modal({ title: `Import ${def.plural.toLowerCase()}`, sub: 'From a CSV file (in Excel: Save as → CSV UTF-8)', icon: I.upload, body, wide: true });
  let csv = '', name = '';

  function pickStep() {
    body.innerHTML = `<p class="bz-p">The first row holds the column names. Use these (only the ones marked * are needed):</p>
      <div class="bz-colnames">${fields.map((f) => `<code>${esc(f.label)}${f.required ? '*' : ''}</code>`).join('')}</div>
      <p class="bz-p bz-muted">Upper or lower case doesn't matter. Links (like a group or unit) are written by name. Yes/No columns take yes, no, 1 or 0. ${def.naming?.by === 'field' && byKey[def.naming.field] ? `A line whose ${esc(byKey[def.naming.field].label.toLowerCase())} already exists updates that record.` : `A “${esc(def.label)} number” column (e.g. from an export) updates existing records.`}</p>
      <label class="bz-drop" tabindex="0"><input type="file" accept=".csv,text/csv" hidden>${svg(I.file)}<b>Choose a CSV file</b><small>or drop it here</small></label>
      <div class="bz-dlg-a"><button class="tbtn" id="bzTpl">${svg(I.down)}Download an empty template</button><span class="bz-grow"></span><button class="btn" data-x>Cancel</button></div>`;
    const drop = body.querySelector('.bz-drop'), inp = drop.querySelector('input');
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
    inp.onchange = () => inp.files[0] && read(inp.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondragleave = () => drop.classList.remove('drag');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) read(f); };
    body.querySelector('[data-x]').onclick = () => m.close();
    body.querySelector('#bzTpl').onclick = () => {
      const blob = new Blob(['﻿' + fields.map((f) => csvCell(f.label)).join(',') + '\r\n'], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `${def.type}-template.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
  }
  async function read(file) {
    if (file.size > 5e6) return kit.toast('That file is too big (over 5 MB). Split it into smaller files.');
    name = file.name;
    csv = (await file.text()).replace(/^﻿/, '');
    if (!csv.trim()) return kit.toast('That file is empty');
    preview();
  }
  async function preview() {
    body.innerHTML = '<div class="bz-loading"><span class="bz-spin"></span><p class="bz-muted">Checking every row…</p></div>';
    let r;
    try { r = await kit.api.importCsv(def.type, csv, false); }
    catch (e) { body.innerHTML = `<div class="bz-formerr"><p>${esc(errText(e))}</p></div><div class="bz-dlg-a"><button class="btn" id="bzAgain">Choose another file</button></div>`; body.querySelector('#bzAgain').onclick = pickStep; return; }
    const list = r?.rows || [];
    const bad = list.filter((x) => hasErr(x.errors));
    const good = r?.counts?.ok ?? (list.length - bad.length);
    const cols = r?.columns || [];
    const unused = cols.filter((c) => !c.field);
    const label = (k) => { const [top, i, sub] = String(k).split('.'); const f = byKey[top]; if (!f) return k === '_' ? '' : k; if (sub) { const cf = kit.defs[f.of]?.fields.find((x) => x.key === sub); return `${f.label} row ${+i + 1}, ${cf?.label || sub}`; } return f.label; };
    const upd = r?.counts?.update || 0;
    body.innerHTML = `<div class="bz-impsum"><span class="bz-ic sm">${svg(I.file)}</span><b>${esc(name)}</b>
        <span class="bz-pill ok">${esc(good)} ready${upd ? ` (${esc(upd)} update existing)` : ''}</span>${bad.length ? `<span class="bz-pill bad">${esc(bad.length)} with problems</span>` : ''}</div>
      ${cols.length ? `<div class="bz-colnames">${cols.map((c) => c.field ? `<code class="ok" title="Fills ${esc(c.label)}">${svg(I.check)}${esc(c.column)}</code>` : `<code class="off" title="No field has this name; this column is skipped">${esc(c.column)}</code>`).join('')}</div>
        ${unused.length ? `<p class="bz-p bz-muted">Skipped columns (no field with that name): ${esc(unused.map((c) => c.column).join(', '))}</p>` : ''}` : ''}
      <div class="bz-imptable">${list.map((x, i) => {
        const errs = Object.entries(x.errors || {}).map(([k, m]) => (label(k) ? `${label(k)}: ${m}` : String(m)));
        return `<div class="bz-impr${errs.length ? ' bad' : ''}"><span class="bz-impn">Line ${esc(x.line ?? i + 2)}</span><b>${esc(x.title || '—')}</b>
          <span class="bz-impm">${errs.length ? errs.map((e) => esc(e)).join('<br>') : `${svg(I.check)}${x.action === 'update' ? 'Will update' : 'Will add'}`}</span></div>`;
      }).join('')}</div>
      ${bad.length && good ? '<p class="bz-p bz-muted">Lines with problems are skipped. Fix them in the file and import it again later.</p>' : ''}
      <div class="bz-dlg-a"><button class="btn" id="bzAgain">Choose another file</button><span class="bz-grow"></span>
        <button class="btn pri" id="bzGo"${good ? '' : ' disabled'}>${svg(I.check)}Import ${esc(good)} ${good === 1 ? 'line' : 'lines'}</button></div>`;
    body.querySelector('#bzAgain').onclick = pickStep;
    body.querySelector('#bzGo').onclick = (e) => commit(e.currentTarget);
  }
  async function commit(btn) {
    await busy(btn, async () => {
      try {
        const r = await kit.api.importCsv(def.type, csv, true);
        const c = r?.counts || {};
        const n = (c.created || 0) + (c.updated || 0);
        kit.toast(`${n} ${n === 1 ? def.label.toLowerCase() : def.plural.toLowerCase()} imported${c.updated ? ` (${c.updated} updated)` : ''}${c.failed ? `, ${c.failed} skipped` : ''}`);
        m.close(true);
        after?.();
      } catch (e) { kit.toast(errText(e)); }
    });
  }
  pickStep();
  return m.done;
}
const hasErr = (e) => !!e && Object.keys(e).length > 0;
