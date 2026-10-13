// One form/detail component for any definition (business/FRAME.md):
// view mode (values by section, "Used in" panel, Edit, Delete with a kind refusal) and edit mode (fields by
// section in 1-3 columns, inline errors from the server, Save/Cancel, unsaved-changes guard, Ctrl+S).
// Single definitions (company) open straight on their one record.
import { flatDoc } from './api.js';
import { esc, svg, I, when, modal, confirmBox, busy, errText } from './ui.js';
import { makeField, display, localCheck, isEmpty, linkTitle } from './fields.js';

/** Fields of a definition grouped by its sections; fields in no section go into a last "More" section. */
export function sectionsOf(def) {
  const byKey = Object.fromEntries(def.fields.map((f) => [f.key, f]));
  const used = new Set();
  const out = (def.sections || []).map((s) => {
    const fields = s.fields.map((k) => byKey[k]).filter((f) => f && !f.hidden);
    fields.forEach((f) => used.add(f.key));
    return { label: s.label, columns: s.columns || 2, fields };
  });
  const rest = def.fields.filter((f) => !f.hidden && !used.has(f.key));
  if (rest.length) out.push({ label: out.length ? 'More' : def.label, columns: 2, fields: rest });
  return out.filter((s) => s.fields.length);
}

export const titleOfDoc = (def, d) => {
  if (!d) return '';
  const t = d.title || linkTitle(d, def.title) || d[def.title] || d.name || d.id;
  return String(t ?? '');
};

/**
 * mountDoc(el, kit, { type, id, mode: 'view'|'edit'|'new', prefill, inModal, onSaved(doc), onCancel() })
 * kit: { api, defs, nav, toast, can(type, what), titleOf, quickCreate, setTitle, setGuard }
 * Returns leave().
 */
export function mountDoc(el, kit, opts) {
  const def = kit.defs[opts.type];
  let mode = opts.mode || 'view';
  let id = opts.id, doc = null, links = {}, widgets = [], initial = '', alive = true, saving = false;
  const inModal = !!opts.inModal;
  if (!def) { el.innerHTML = `<div class="bz-empty card"><b>Unknown kind of record</b><p>${esc(opts.type)}</p></div>`; return () => {}; }

  const canWrite = kit.can(def.type, 'write');
  const canDelete = kit.can(def.type, 'delete') && !def.single;

  async function load() {
    el.innerHTML = '<div class="bz-loading"><span class="bz-spin"></span></div>';
    try {
      if (def.single && !id) {
        const r = await kit.api.list(def.type, { limit: 1 });
        id = r?.rows?.[0]?.id;
        if (!id) mode = canWrite ? 'new' : 'view';
      }
      if (id) {
        const r = await kit.api.doc(def.type, id);
        doc = flatDoc(r?.doc || r);
        links = r?.links || {};
      } else {
        doc = {};
        doc._titles = {};
        for (const f of def.fields) {
          if (f.default === undefined) continue;
          doc[f.key] = f.default;
          if (f.type === 'link') doc._titles[f.key] = String(f.default); // a link's default is the target's name; the server finds it on save
        }
        Object.assign(doc, opts.prefill || {});
      }
    } catch (e) {
      if (!alive) return;
      el.innerHTML = `<div class="bz-empty card"><span class="bz-ic big">${svg(I.info)}</span><b>${e.status === 404 ? 'Not found' : 'Could not open this'}</b><p>${esc(errText(e))}</p>
        ${inModal ? '' : `<button class="btn sm" id="bzBack">${svg(I.back)}Back to ${esc(def.plural)}</button>`}</div>`;
      el.querySelector('#bzBack')?.addEventListener('click', () => kit.nav(def.single ? 'm/' + def.module : 'l/' + def.type));
      kit.setTitle?.(def.label, 'Not found');
      return;
    }
    if (!alive) return;
    if (mode === 'view' && !id) return paintEmptySingle();
    mode === 'view' ? paintView() : paintEdit();
  }

  const recTitle = () => titleOfDoc(def, doc) || (mode === 'new' ? `New ${def.label.toLowerCase()}` : def.label);

  // ---------- view
  function paintView() {
    kit.setGuard?.(null);
    const t = recTitle();
    const sub = def.subtitle && !isEmpty(doc[def.subtitle]) ? `${def.label} · ${linkTitle(doc, def.subtitle) ?? doc[def.subtitle]}` : def.label;
    kit.setTitle?.(t, sub);
    // sections with nothing filled in are left out of the view (Edit shows them all)
    const secs = sectionsOf(def).filter((s) => s.fields.some((f) => f.type === 'check' || !isEmpty(doc[f.key])));
    const meta = doc._meta || doc;
    el.innerHTML = `<div class="bz-doc">
      <div class="bz-bar">
        ${def.single ? '' : `<button class="tbtn bz-back" data-nav="l/${esc(def.type)}">${svg(I.back)}${esc(def.plural)}</button>`}
        <span class="bz-grow"></span>
        ${pinAllowed() ? `<button class="tbtn" id="bzPin">${svg(I.key)}${doc._meta?.hasPin ? 'Change PIN' : 'Set PIN'}</button>` : ''}
        ${canDelete ? `<button class="tbtn bz-del" id="bzDel">${svg(I.trash)}Delete</button>` : ''}
        ${canWrite ? `<button class="btn pri sm" id="bzEdit">${svg(I.edit)}Edit</button>` : ''}
      </div>
      <div class="bz-docgrid">
        <div class="bz-col">${secs.map((s, i) => `<section class="card bz-sec" style="--i:${i}"><h3>${esc(s.label)}</h3>
          <dl class="bz-dl c${s.columns}">${s.fields.map((f) => f.type === 'table' ? `<div class="bz-dv wide"><dt${s.fields.length === 1 ? ' class="bz-sr"' : ''}>${esc(f.label)}</dt><dd>${tableView(f, doc[f.key])}</dd></div>`
            : `<div class="bz-dv${f.type === 'longtext' ? ' wide' : ''}"><dt>${esc(f.label)}</dt><dd>${display(f, doc[f.key], doc)}</dd></div>`).join('')}</dl></section>`).join('')}</div>
        <aside class="bz-col bz-side">
          <section class="card bz-sec"><h3>Used in</h3><div id="bzUsed"><p class="bz-muted">Checking…</p></div></section>
          <section class="card bz-sec bz-info"><h3>Record</h3>
            <dl class="bz-dl c1">${def.naming?.by === 'series' && doc._name ? `<div class="bz-dv"><dt>Number</dt><dd class="bz-mono">${esc(doc._name)}</dd></div>` : ''}
            ${meta.created ? `<div class="bz-dv"><dt>Created</dt><dd>${esc(when(meta.created))}${meta.owner ? ` · <span data-user="${esc(meta.owner)}"></span>` : ''}</dd></div>` : ''}
            ${meta.modified ? `<div class="bz-dv"><dt>Last changed</dt><dd>${esc(when(meta.modified))}${meta.modified_by ? ` · <span data-user="${esc(meta.modified_by)}"></span>` : ''}</dd></div>` : ''}</dl></section>
        </aside>
      </div></div>`;
    wireLinks(el);
    el.querySelectorAll('[data-user]').forEach((u) => {
      const v = u.dataset.user;
      if (v === 'setup') { u.textContent = 'Setup'; return; }
      kit.titleOf?.('user', v).then((t) => { u.textContent = t; });
    });
    el.querySelector('#bzEdit')?.addEventListener('click', () => (inModal ? (mode = 'edit', paintEdit()) : kit.nav(`e/${def.type}/${id}`)));
    el.querySelector('#bzDel')?.addEventListener('click', (e) => remove(e.currentTarget));
    el.querySelector('#bzPin')?.addEventListener('click', setPin);
    usedIn();
  }

  // users: the owner sets anyone's PIN; others change their own (with the current one)
  function pinAllowed() {
    const me = kit.session?.user;
    return def.type === 'user' && !!id && !!me && doc.active !== false && (String(me.role).toLowerCase() === 'owner' || me.id === id);
  }
  function setPin() {
    const me = kit.session?.user;
    const needCurrent = me?.id === id && String(me.role).toLowerCase() !== 'owner' && doc._meta?.hasPin;
    const inp = (k, label) => `<div class="bz-fld" data-k="${k}"><label class="bz-lbl" for="bzP-${k}">${label}</label><input class="bz-in bz-pinin" id="bzP-${k}" type="password" inputmode="numeric" maxlength="8" autocomplete="off"><small class="bz-ferr" role="alert"></small></div>`;
    const body = `<form class="bz-pin" novalidate>${needCurrent ? inp('current', 'Current PIN') : ''}${inp('pin', 'New PIN (4 to 8 digits)')}${inp('pin2', 'New PIN again')}<button type="submit" hidden></button></form>`;
    const m = modal({ title: `${doc._meta?.hasPin ? 'Change' : 'Set'} PIN for ${recTitle()}`, sub: 'Used to switch to this user', icon: I.key, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save PIN', pri: true, onClick: (_, b) => go(b) }] });
    const v = (k) => m.box.querySelector(`#bzP-${k}`)?.value.trim() ?? '';
    const err = (k, t) => { const f = m.box.querySelector(`[data-k="${k}"] .bz-ferr`); if (f) f.textContent = t || ''; };
    m.box.querySelector('form').onsubmit = (e) => { e.preventDefault(); go(m.box.querySelector('.btn.pri')); };
    async function go(b) {
      ['current', 'pin', 'pin2'].forEach((k) => err(k, ''));
      if (!/^\d{4,8}$/.test(v('pin'))) return err('pin', 'Use 4 to 8 digits');
      if (v('pin') !== v('pin2')) return err('pin2', "The two PINs don't match");
      await busy(b, async () => {
        try {
          await kit.api.setPin(id, v('pin'), needCurrent ? v('current') : undefined);
          m.close(true);
          kit.toast(`PIN saved for ${recTitle()}`);
          load();
        } catch (e) {
          if (e.errors?.current) err('current', e.errors.current);
          else if (e.errors?.pin) err('pin', e.errors.pin);
          else err('pin', errText(e));
        }
      });
    }
  }

  function paintEmptySingle() {
    kit.setTitle?.(def.label, 'Not set up yet');
    el.innerHTML = `<div class="bz-empty card"><span class="bz-ic big">${svg(def.icon)}</span><b>${esc(def.label)} is not set up yet</b>
      <p>${esc(def.description || '')}</p><p class="bz-muted">Ask the owner or a manager to fill it in.</p></div>`;
  }

  function tableView(f, rows) {
    const child = kit.defs[f.of];
    const cols = (child?.fields || []).filter((c) => !c.hidden);
    if (!Array.isArray(rows) || !rows.length) return '<span class="bz-none">—</span>';
    return `<div class="bz-mini" style="--cols:${cols.length}"><div class="bz-mr bz-mh">${cols.map((c) => `<span>${esc(c.label)}</span>`).join('')}</div>
      ${rows.map((r) => `<div class="bz-mr">${cols.map((c) => `<span data-l="${esc(c.label)}">${display(c, r[c.key], r)}</span>`).join('')}</div>`).join('')}</div>`;
  }

  // link values: fill in titles the server did not send, and open the linked record on click
  function wireLinks(scope) {
    scope.querySelectorAll('a.bz-lnk').forEach((a) => {
      if (a.textContent === a.dataset.id && kit.titleOf) kit.titleOf(a.dataset.type, a.dataset.id).then((t) => { if (t) a.textContent = t; });
      a.onclick = (e) => { e.preventDefault(); if (inModal) return; if (kit.defs[a.dataset.type]) kit.nav(`d/${a.dataset.type}/${a.dataset.id}`); };
    });
    scope.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => kit.nav(b.dataset.nav)));
  }

  // "Used in": counts of records that point here (links), plus the definition's related lists
  async function usedIn() {
    const box = el.querySelector('#bzUsed');
    const items = new Map();
    for (const [t, n] of Object.entries(links || {})) if (n) items.set(t, { type: t, count: n });
    for (const r of def.related || []) {
      if (!kit.defs[r.type]) continue;
      let n = items.get(r.type)?.count ?? 0;
      if (!items.has(r.type)) { try { n = (await kit.api.list(r.type, { limit: 1, filters: { [r.by]: id } }))?.total ?? 0; } catch {} }
      items.set(r.type, { type: r.type, count: n, by: r.by, label: r.label, add: kit.can(r.type, 'write') && !kit.defs[r.type].single });
    }
    if (!alive || !box.isConnected) return;
    if (!items.size) { box.innerHTML = `<p class="bz-muted">Nothing uses this ${esc(def.label.toLowerCase())} yet.</p>`; return; }
    box.innerHTML = [...items.values()].map((u) => {
      const d = kit.defs[u.type];
      const step = u.type === 'step';
      const row = `<button class="bz-used" data-t="${esc(u.type)}"${u.by ? ` data-by="${esc(u.by)}"` : ''}${u.count ? '' : ' disabled'}><span class="bz-ic sm">${svg(step ? I.stock : d?.icon || I.link)}</span><span>${esc(u.label || (step ? 'Stock movements' : d?.plural) || u.type)}</span><b>${u.count ? esc(u.count) : '<span class="bz-none">none</span>'}</b>${u.count ? svg(I.right) : ''}</button>`;
      return u.add ? `<div class="bz-usedrow">${row}<button class="ibtn" data-add="${esc(u.type)}" data-by="${esc(u.by)}" aria-label="Add ${esc((d?.label || '').toLowerCase())}" title="Add ${esc((d?.label || '').toLowerCase())}">${svg(I.plus)}</button></div>` : row;
    }).join('');
    box.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => kit.nav(`n/${b.dataset.add}`, { prefill: { [b.dataset.by]: id } })));
    box.querySelectorAll('.bz-used').forEach((b) => (b.onclick = () => openUsed(b.dataset.t, b.dataset.by)));
  }
  function openUsed(type, by) {
    if (type === 'step') return kit.nav('m/stock', { tab: 'activity' });
    const d = kit.defs[type];
    if (!d) return;
    const field = by || d.fields.find((f) => f.type === 'link' && f.to === def.type)?.key;
    if (d.child || !field) return kit.toast(`Used inside ${d.plural.toLowerCase()}`);
    kit.nav(`l/${type}`, { filters: { [field]: id }, filterTitles: { [field]: recTitle() } });
  }

  async function remove(btn) {
    const t = recTitle();
    if (!(await confirmBox({ title: `Delete ${t}?`, text: `This ${def.label.toLowerCase()} will be removed. You can't undo this.`, ok: 'Delete', danger: true, icon: I.trash }))) return;
    await busy(btn, async () => {
      try {
        await kit.api.remove(def.type, id);
        kit.toast(`${t} deleted`);
        kit.setGuard?.(null);
        kit.nav(`l/${def.type}`, null, true);
      } catch (e) {
        if (e.status === 409 || e.usedIn) return refuseDelete(t, e);
        kit.toast(errText(e));
      }
    });
  }
  function refuseDelete(t, e) {
    const list = Array.isArray(e.usedIn) ? e.usedIn : [];
    const hasActive = def.fields.some((f) => f.key === 'active' && f.type === 'check') && canWrite;
    // group by kind: "Item prices · 3 · Retail, Wholesale…"
    const groups = new Map();
    for (const u of list) {
      if (typeof u === 'string') { groups.set(u, { name: u, n: 1, titles: [] }); continue; }
      const d = kit.defs[u.type];
      const key = u.type || u.label;
      const g = groups.get(key) || { name: d ? d.plural : u.type === 'step' ? 'Stock movements' : u.label || u.type, one: d?.label || u.label, n: 0, titles: [] };
      g.n += u.count || 1;
      if (u.title && g.titles.length < 3) g.titles.push(u.title);
      groups.set(key, g);
    }
    const line = (g) => `<li><b>${esc(g.n === 1 && g.one ? g.one : g.name)}</b>${g.n > 1 ? ` · ${esc(g.n)}${list.length >= 50 ? '+' : ''}` : ''}${g.titles.length ? ` <span class="bz-muted">(${esc(g.titles.join(', '))}${g.n > g.titles.length ? '…' : ''})</span>` : ''}</li>`;
    const m = modal({
      title: `${t} is still in use`, icon: I.link,
      body: `<p class="bz-p">It can't be deleted while other records point to it:</p>${groups.size ? `<ul class="bz-ul">${[...groups.values()].map(line).join('')}</ul>` : `<p class="bz-p">${esc(e.message)}</p>`}
        <p class="bz-p bz-muted">Change or remove those first${hasActive ? ', or mark this one inactive so it is no longer offered' : ''}.</p>`,
      actions: [...(hasActive && doc.active !== false ? [{ label: 'Mark inactive', value: 'inactive' }] : []), { label: 'OK', pri: true, value: 'ok' }],
    });
    m.done.then(async (v) => {
      if (v !== 'inactive') return;
      try { await kit.api.save(def.type, { ...doc, active: false }); kit.toast(`${t} marked inactive`); load(); }
      catch (err) { kit.toast(errText(err)); }
    });
  }

  // ---------- edit / new
  function paintEdit() {
    const isNew = mode === 'new' || !id;
    if (!canWrite) { kit.toast("Your role can't change this"); mode = 'view'; return id ? paintView() : paintEmptySingle(); }
    const t = isNew ? `New ${def.label.toLowerCase()}` : recTitle();
    kit.setTitle?.(t, isNew ? def.plural : `Editing ${def.label.toLowerCase()}`);
    const secs = sectionsOf(def);
    el.innerHTML = `<form class="bz-doc bz-edit" novalidate>
      ${inModal ? '' : `<div class="bz-bar">${def.single && isNew ? '' : `<button type="button" class="tbtn bz-back" id="bzCancelTop">${svg(I.back)}${isNew ? esc(def.plural) : 'Back'}</button>`}<span class="bz-grow"></span>
        <span class="bz-dirty" hidden>Unsaved changes</span></div>`}
      <div class="bz-formerr" role="alert" hidden></div>
      <div class="bz-col">${secs.map((s, i) => `<section class="card bz-sec" style="--i:${i}"><h3>${esc(s.label)}</h3><div class="bz-grid c${s.columns}" data-s="${i}"></div></section>`).join('')}</div>
      <div class="bz-savebar${inModal ? ' in-modal' : ''}"><span class="bz-hint">${inModal ? '' : '<kbd>Ctrl</kbd>+<kbd>S</kbd> saves'}</span>
        <button type="button" class="btn" id="bzCancel">Cancel</button><button type="submit" class="btn pri" id="bzSave">${svg(I.check)}${isNew ? 'Create' : 'Save'}</button></div>
    </form>`;
    const form = el.querySelector('form');
    const ctx = {
      api: kit.api, defs: kit.defs, doc, titleOf: kit.titleOf,
      canCreate: (t2) => !!kit.defs[t2] && !kit.defs[t2].child && !kit.defs[t2].single && kit.can(t2, 'write'),
      quickCreate: kit.quickCreate, onChange: () => dirtyMark(),
    };
    widgets = [];
    secs.forEach((s, i) => {
      const grid = form.querySelector(`[data-s="${i}"]`);
      for (const f of s.fields) {
        if (isNew && f.readOnly && isEmpty(doc[f.key])) continue;
        const w = makeField(f, doc[f.key], ctx);
        if (s.fields.length === 1 && f.type === 'table') w.el.classList.add('solo'); // the section title already names it
        grid.append(w.el);
        widgets.push(w);
      }
    });
    initial = JSON.stringify(values());
    kit.setGuard?.(() => dirty());
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    form.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
    const cancel = () => (opts.onCancel ? opts.onCancel() : isNew ? kit.nav(def.single ? 'm/setup' : `l/${def.type}`) : kit.nav(`d/${def.type}/${id}`));
    el.querySelector('#bzCancel').onclick = cancel;
    el.querySelector('#bzCancelTop')?.addEventListener('click', cancel);
    // start in the first field that still needs filling in
    requestAnimationFrame(() => (widgets.find((w) => !w.field.readOnly && w.field.type !== 'check' && w.field.type !== 'table' && isEmpty(w.get())) || widgets.find((w) => !w.field.readOnly))?.focus());
  }
  const values = () => Object.fromEntries(widgets.map((w) => [w.key, w.get()]));
  const dirty = () => mode !== 'view' && widgets.length > 0 && JSON.stringify(values()) !== initial;
  function dirtyMark() { const d = el.querySelector('.bz-dirty'); if (d) d.hidden = !dirty(); }

  function showErrors(errors, general) {
    widgets.forEach((w) => { w.error(''); w.clearCells?.(); });
    const box = el.querySelector('.bz-formerr');
    const left = [];
    let first = null;
    for (const [k, msg] of Object.entries(errors || {})) {
      const m = /^(\w+)(?:\.|\[)(\d+)\]?\.(\w+)$/.exec(k); // units.0.unit or units[0].unit
      const w = widgets.find((x) => x.key === (m ? m[1] : k));
      if (!w) { left.push(msg); continue; }
      if (m && w.cellError?.(+m[2], m[3], msg)) { first ??= w; continue; }
      w.error(String(msg)); first ??= w;
    }
    if (general) left.unshift(general);
    box.hidden = !left.length;
    box.innerHTML = left.map((x) => `<p>${esc(x)}</p>`).join('');
    if (first) { first.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus(); }
    else if (left.length) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function save() {
    if (saving) return;
    const v = values();
    const errs = {};
    for (const w of widgets) { const m = localCheck(w.field, v[w.key]); if (m) errs[w.key] = m; }
    let cellBad = 0;
    widgets.forEach((w) => { if (w.check) cellBad += w.check(); });
    if (Object.keys(errs).length || cellBad) { showErrors(errs); if (cellBad && !Object.keys(errs).length) el.querySelector('.bz-fld.bad')?.scrollIntoView({ block: 'center' }); return kit.toast(`Check the ${Object.keys(errs).length + cellBad > 1 ? 'fields' : 'field'} marked in red`); }
    const btn = el.querySelector('#bzSave');
    saving = true;
    await busy(btn, async () => {
      try {
        const out = { ...doc, ...v };
        if (id) out.id = id;
        for (const k of Object.keys(out)) if (k.endsWith('_title')) delete out[k];
        const r = await kit.api.save(def.type, out);
        const saved = flatDoc(r?.doc || r);
        showErrors({});
        initial = JSON.stringify(values());
        kit.setGuard?.(null);
        kit.toast(`${titleOfDoc(def, saved) || def.label} saved`);
        if (opts.onSaved) return opts.onSaved(saved);
        if (def.single) { id = saved.id; mode = 'view'; doc = saved; return load(); }
        kit.nav(`d/${def.type}/${saved.id}`, null, true);
      } catch (e) {
        if (e.status === 422 || e.errors) { showErrors(e.errors || {}, e.errors ? '' : e.message); kit.toast('Some fields need a look'); }
        else showErrors({}, errText(e));
      }
    });
    saving = false;
  }

  load();
  return {
    leave: () => { alive = false; },
    dirty,
  };
}

/** A "create new …" dialog for a link field: the full form of that definition in a dialog. Resolves {id, title} or undefined. */
export function quickCreate(kit, type, text) {
  const def = kit.defs[type];
  if (!def) return Promise.resolve(undefined);
  const body = document.createElement('div');
  body.className = 'bz-qc';
  let handle = null;
  const m = modal({ title: `New ${def.label.toLowerCase()}`, sub: def.description || '', icon: def.icon, body, wide: true });
  const prefill = text ? { [def.title]: text } : {};
  const subKit = { ...kit, setTitle: null, setGuard: null, nav: () => {} };
  handle = mountDoc(body, subKit, {
    type, mode: 'new', inModal: true, prefill,
    onSaved: (d) => { handle.dirty = () => false; m.close({ id: d.id, title: titleOfDoc(def, d) }); },
    onCancel: () => m.close(undefined),
  });
  m.beforeClose = async (v) => {
    if (v || !handle.dirty()) return true;
    return confirmBox({ title: 'Discard this new record?', text: 'What you typed will be lost.', ok: 'Discard', danger: true });
  };
  m.done.then(() => handle.leave());
  return m.done;
}

