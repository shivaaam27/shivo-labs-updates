// Shivo Labs Business: the one layout every module uses (business/FRAME.md).
// A slim rail of modules (a bottom bar on narrow screens), a top row with the page title, a search box that
// opens the command palette (Ctrl+K / Ctrl+F), a "+ New" menu and the current user (switch by PIN).
// Routes live in the address after #business/ so Back works and a reload comes back to the same page.
import { api, defsByType } from './api.js';
import { esc, svg, I, modal, confirmBox, popMenu, debounce, initials, errText, dialogOpen, setToast, qty, closeAll } from './ui.js';
import { titleCache } from './fields.js';
import { mountList, importCsv } from './list.js';
import { mountDoc, quickCreate } from './form.js';
import { mountSetup } from './setup.js';
import { mountStock, STOCK_ACTIONS } from './stock.js';

export const MODULES = [
  { id: 'home', label: 'Home', icon: I.home, sub: 'Everything in one place' },
  { id: 'sell', label: 'Sell', icon: I.sell, phase: 4, sub: 'Till, orders, deliveries, invoices and returns', extra: ['customer', 'price_list', 'item_price'] },
  { id: 'buy', label: 'Buy', icon: I.buy, phase: 5, sub: 'Orders to suppliers, goods arrived and supplier bills', extra: ['supplier', 'price_list'] },
  { id: 'stock', label: 'Stock', icon: I.stock, sub: 'What is in each store and van, and every movement', extra: ['store', 'unit', 'product'] },
  { id: 'money', label: 'Money', icon: I.money, phase: 3, sub: 'Payments, expenses, who owes what, VAT and the books', extra: ['payment_method', 'tax'] },
  { id: 'products', label: 'Products', icon: I.products, sub: 'Products, groups, brands and prices' },
  { id: 'customers', label: 'Customers', icon: I.customers, sub: 'Who you sell to, their groups and salesmen' },
  { id: 'suppliers', label: 'Suppliers', icon: I.suppliers, sub: 'Who you buy from' },
  { id: 'reports', label: 'Reports', icon: I.reports, phase: 7, sub: 'Sales, stock, profit and VAT, at a glance' },
  { id: 'setup', label: 'Setup', icon: I.setup, sub: 'Company, stores, units, taxes, payment methods and users' },
];
const PHASE_TEXT = {
  sell: 'Sales, orders, deliveries, invoices and returns come in phase 4. Until then, record a sale of stock under Stock → Sell.',
  buy: 'Purchase orders, supplier bills and import costs come in phase 5. Until then, record deliveries under Stock → Goods arrived.',
  money: 'Payments, expenses, customer and supplier balances and VAT come in phase 3.',
  reports: 'The owner dashboard and reports (sales, stock value, profit, VAT summary) come in phase 7.',
};
const MOBILE_MAIN = ['home', 'sell', 'stock', 'products'];
const SCALES = [['A−', 0.9], ['A', 1], ['A+', 1.12], ['A++', 1.25]];
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

/** Mount the whole Business app into `root`. ctx (from the hub): { toast, goHome }. Returns leave(). */
export function mountShell(root, ctx = {}) {
  if (ctx.toast) setToast(ctx.toast);
  const toast = ctx.toast || ((m) => import('./ui.js').then((u) => u.toast(m)));
  let alive = true, session = null, defs = {}, view = null, guard = null, route = '', listStates = {};
  const startRoute = (location.hash.match(/^#business\/(.*)$/) || [])[1] || 'home';

  const scale = Number(store.get('biz-scale')) || 1;
  document.documentElement.style.setProperty('--ui-scale', scale);

  const kit = {
    api, toast,
    get defs() { return defs; },
    get session() { return session; },
    nav: (r, extra, replace) => nav(r, extra, replace),
    can,
    titleOf: null,
    quickCreate: (type, text) => quickCreate(kit, type, text),
    setTitle,
    setGuard: (fn) => { guard = fn; },
  };

  function can(type, what = 'read') {
    const d = defs[type];
    if (d?.can && typeof d.can[what] === 'boolean') return d.can[what]; // the server says, per user
    const role = String(session?.user?.role || '').toLowerCase();
    if (role === 'owner') return true;
    if (!d?.roles?.[what]) return true;
    return d.roles[what].map((r) => String(r).toLowerCase()).includes(role);
  }

  // ---------- start: session → setup (first run) → meta → the app
  root.innerHTML = '<div class="bz-boot"><span class="bz-spin"></span></div>';
  start();
  async function start() {
    try {
      session = normSession(await api.session());
    } catch (e) {
      if (!alive) return;
      root.innerHTML = `<div class="bz-boot"><div class="bz-empty card"><span class="bz-ic big">${svg(I.info)}</span><b>Business can't start</b><p>${esc(errText(e))}</p><button class="btn pri sm" id="bzRetry">Try again</button></div></div>`;
      root.querySelector('#bzRetry').onclick = () => { root.innerHTML = '<div class="bz-boot"><span class="bz-spin"></span></div>'; start(); };
      return;
    }
    if (!alive) return;
    if (!session.ready) {
      return mountSetup(root, { api, toast, done: (s) => { if (s) session = normSession(s); start(); } });
    }
    await loadMeta();
    if (!alive) return;
    paintFrame();
    api.onNeedPin = () => { if (alive && !document.querySelector('#bzPinIn')) askPin(true); };
    if (!session.user || session.needsPin) return askPin(true);
    nav(startRoute, null, true);
  }
  async function loadMeta() {
    try {
      const m = await api.meta();
      defs = defsByType(m);
      kit.stepRights = m?.steps || null;
    } catch (e) { toast(errText(e)); }
    kit.titleOf = titleCache(api, defs);
  }
  function normSession(s) { return { ...s, user: s?.user || (s?.id ? { id: s.id, name: s.name, role: s.role } : null), ready: s?.ready !== false }; }

  // ---------- frame
  function paintFrame() {
    root.innerHTML = `<div class="bz-app">
      <nav class="bz-rail" aria-label="Business">
        <button class="bz-hubbtn" id="bzHub" title="Back to Shivo Labs" aria-label="Back to Shivo Labs">${svg(I.grid)}</button>
        <div class="bz-mods">${MODULES.map((m) => `<button class="bz-rb${MOBILE_MAIN.includes(m.id) ? ' main' : ''}" data-m="${m.id}" aria-label="${esc(m.label)}">${svg(m.icon)}<span>${esc(m.label)}</span></button>`).join('')}
          <button class="bz-rb bz-morebtn" id="bzMore" aria-label="More modules">${svg(I.more)}<span>More</span></button></div>
      </nav>
      <div class="bz-main">
        <div class="bz-top">
          <div class="bz-title"><h1 id="bzT"></h1><p id="bzS"></p></div>
          <div class="bz-topacts">
            <button class="bz-find" id="bzFind" aria-label="Search (Ctrl+K)">${svg(I.search)}<span>Search or jump to…</span><kbd>Ctrl K</kbd></button>
            <button class="bz-pillbtn pri" id="bzNewMenu" aria-haspopup="menu">${svg(I.plus)}<span>New</span></button>
            <button class="bz-me" id="bzMe" aria-haspopup="menu"><span class="bz-av" id="bzAv"></span><span class="bz-mename"><b id="bzMeN"></b><small id="bzMeR"></small></span></button>
          </div>
        </div>
        <main class="bz-view" id="bzView"></main>
      </div>
    </div>`;
    scrollTo({ top: 0 });
    root.querySelectorAll('.bz-rb[data-m]').forEach((b) => (b.onclick = () => nav(b.dataset.m === 'home' ? 'home' : 'm/' + b.dataset.m)));
    root.querySelector('#bzMore').onclick = async (e) => {
      const v = await popMenu(e.currentTarget, MODULES.filter((m) => !MOBILE_MAIN.includes(m.id)).map((m) => ({ label: m.label, sub: m.sub, icon: m.icon, value: m.id })), { align: 'right' });
      if (v) nav('m/' + v);
    };
    root.querySelector('#bzHub').onclick = async () => { if (await allowLeave()) { guard = null; ctx.goHome?.(); } };
    root.querySelector('#bzFind').onclick = palette;
    root.querySelector('#bzNewMenu').onclick = (e) => newMenu(e.currentTarget);
    root.querySelector('#bzMe').onclick = (e) => meMenu(e.currentTarget);
    paintUser();
  }
  function paintUser() {
    const u = session?.user;
    const av = root.querySelector('#bzAv'); if (!av) return;
    av.textContent = u ? initials(u.name) : '?';
    root.querySelector('#bzMeN').textContent = u?.name || 'Nobody';
    root.querySelector('#bzMeR').textContent = u?.role ? cap(u.role) : 'Switch user';
  }
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

  function setTitle(t, s = '') {
    const h = root.querySelector('#bzT'), p = root.querySelector('#bzS');
    if (!h) return;
    h.textContent = t; p.textContent = s; p.title = s;
    document.title = t ? `${t} · Business` : 'Business';
  }

  // ---------- routing
  async function allowLeave() {
    if (!guard || !guard()) return true;
    return confirmBox({ title: 'Leave without saving?', text: 'Your changes will be lost.', ok: 'Leave', cancel: 'Keep editing', danger: true });
  }
  async function nav(r, extra = null, replace = false, fromPop = false) {
    r = String(r || 'home').replace(/^#?business\/?/, '') || 'home';
    if (!fromPop && r === route && !extra) return;
    if (!(await allowLeave())) { if (fromPop) history.pushState(null, '', '#business/' + route); return; }
    guard = null;
    if (!fromPop) history[replace ? 'replaceState' : 'pushState'](null, '', '#business/' + r);
    route = r;
    render(extra);
  }
  const onPop = () => {
    const m = location.hash.match(/^#business\/(.*)$/);
    if (m && alive) nav(m[1], null, false, true);
  };
  addEventListener('popstate', onPop);

  function render(extra) {
    if (!alive) return;
    view?.(); view = null;
    const host = root.querySelector('#bzView');
    if (!host) return;
    host.innerHTML = '';
    host.className = 'bz-view';
    void host.offsetWidth; host.classList.add('in');
    const [a, b, c] = route.split('/');
    const mod = a === 'home' ? 'home' : a === 'm' ? b : a === 'stock' ? 'stock' : defs[b]?.module ? modOfDef(defs[b]) : 'home';
    root.querySelectorAll('.bz-rb[data-m]').forEach((x) => x.classList.toggle('on', x.dataset.m === mod));
    root.querySelector('#bzMore')?.classList.toggle('on', !MOBILE_MAIN.includes(mod));
    scrollTo({ top: 0 });

    if (a === 'home') return (view = paintHome(host));
    if (a === 'm' && b === 'stock' || a === 'stock') {
      setTitle('Stock', MODULES.find((m) => m.id === 'stock').sub);
      const h = mountStock(host, kit, { action: a === 'stock' ? b : null, tab: extra?.tab, records: (el) => recordCards(el, 'stock') });
      if (a === 'stock') { route = 'm/stock'; history.replaceState(null, '', '#business/m/stock'); }
      return (view = h);
    }
    if (a === 'm') return (view = paintModule(host, b));
    const def = defs[b];
    if (!def) { setTitle('Not found', ''); host.innerHTML = `<div class="bz-empty card"><b>This page doesn't exist</b><p>${esc(route)}</p><button class="btn sm" id="bzHome">Go home</button></div>`; host.querySelector('#bzHome').onclick = () => nav('home'); return; }
    if (!can(b, 'read')) { setTitle(def.plural, ''); host.innerHTML = `<div class="bz-empty card"><span class="bz-ic big">${svg(I.key)}</span><b>Not for your role</b><p>Ask the owner if you need to see ${esc(def.plural.toLowerCase())}.</p></div>`; return; }
    if (a === 'l') {
      if (def.single) return nav(`d/${b}`, null, true);
      const st = extra?.filters ? (listStates[b] = { filters: { ...extra.filters }, filterTitles: { ...(extra.filterTitles || {}) } }) : (listStates[b] ||= {});
      return (view = mountList(host, kit, { type: b, state: st }));
    }
    if (a === 'd' || a === 'e' || a === 'n') {
      const h = mountDoc(host, kit, { type: b, id: c ? decodeURIComponent(c) : undefined, mode: a === 'd' ? 'view' : a === 'e' ? 'edit' : 'new', prefill: extra?.prefill });
      return (view = h.leave);
    }
    nav('home', null, true);
  }
  // a definition from another module shows the module whose rail button fits best
  const modOfDef = (d) => (d.module === 'money' && d.type === 'account' ? 'setup' : d.module);

  // ---------- home
  function paintHome(host) {
    const hr = new Date().getHours();
    const name = session?.user?.name?.split(' ')[0] || '';
    setTitle(`${hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}${name ? ', ' + name : ''}`, session?.company?.name || session?.company || 'Shivo Labs Business');
    const quick = [
      ...STOCK_ACTIONS.filter((x) => ['purchase_receipt', 'delivery', 'count'].includes(x.kind) && (!kit.stepRights || kit.stepRights.write)).map((x) => ({ label: x.label, sub: x.hint, icon: x.icon, go: `stock/${x.kind}`, need: 'stock' })),
      ...['product', 'customer', 'supplier'].filter((t) => defs[t] && can(t, 'write')).map((t) => ({ label: `New ${defs[t].label.toLowerCase()}`, sub: defs[t].plural, icon: defs[t].icon, go: `n/${t}` })),
    ];
    host.innerHTML = `<div class="bz-home">
      <div class="bz-quick">${quick.map((q, i) => `<button class="bz-act" data-go="${esc(q.go)}" style="--i:${i}"><span class="bz-ic">${svg(q.icon)}</span><span><b>${esc(q.label)}</b><small>${esc(q.sub)}</small></span></button>`).join('')}</div>
      <section class="card bz-start" id="bzStart" hidden></section>
      <h2 class="bz-h2">Modules</h2>
      <div class="bz-modgrid">${MODULES.filter((m) => m.id !== 'home').map((m, i) => `<button class="bz-modcard" data-go="${m.id === 'stock' ? 'm/stock' : 'm/' + m.id}" style="--i:${i}">
        <span class="bz-ic">${svg(m.icon)}</span><b>${esc(m.label)}</b><small>${esc(m.sub)}</small>${m.phase ? `<span class="bz-tag">Phase ${m.phase}</span>` : '<span class="bz-tag on" data-count="' + m.id + '"></span>'}</button>`).join('')}</div>
    </div>`;
    host.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => nav(b.dataset.go)));
    let live = true;
    // getting started: what is still empty
    (async () => {
      const steps = [
        ['store', 'Add your stores and vans', 'The places that hold stock'],
        ['product', 'Add products', 'One by one or import a CSV from Excel'],
        ['item_price', 'Set selling prices', 'Prices per price list'],
        ['customer', 'Add customers', 'With credit limits for those who buy on credit'],
        ['supplier', 'Add suppliers', 'Who you buy from'],
      ].filter(([t]) => defs[t]);
      const counts = await Promise.all(steps.map(([t]) => api.list(t, { limit: 1 }).then((r) => r?.total ?? 0).catch(() => null)));
      if (!live || !alive) return;
      const todo = steps.map((s, i) => [...s, counts[i]]).filter((s) => s[3] !== null);
      const done = todo.filter((s) => s[3] > 0).length;
      const box = host.querySelector('#bzStart');
      if (!box || done === todo.length) return;
      box.hidden = false;
      box.innerHTML = `<div class="bz-sech"><h3>Getting started</h3><small>${done} of ${todo.length} done</small></div>
        <div class="bz-track"><i style="width:${Math.round((done / todo.length) * 100)}%"></i></div>
        <div class="bz-steps">${todo.map(([t, label, sub, n]) => `<button class="bz-step${n ? ' done' : ''}" data-t="${t}"><span class="bz-box">${n ? svg(I.check) : ''}</span><span><b>${esc(label)}</b><small>${n ? `${qty(n)} added` : esc(sub)}</small></span>${svg(I.right)}</button>`).join('')}</div>`;
      box.querySelectorAll('.bz-step').forEach((b) => (b.onclick = () => nav(b.classList.contains('done') ? `l/${b.dataset.t}` : `n/${b.dataset.t}`)));
    })();
    // record counts per module card
    MODULES.filter((m) => !m.phase && m.id !== 'home').forEach(async (m) => {
      const ds = Object.values(defs).filter((d) => d.module === m.id && !d.child && !d.single);
      const main = ds[0];
      const tag = host.querySelector(`[data-count="${m.id}"]`);
      if (!main || !tag) { tag?.remove(); return; }
      try { const r = await api.list(main.type, { limit: 1 }); if (live && tag.isConnected) tag.textContent = `${qty(r?.total ?? 0)} ${(r?.total === 1 ? main.label : main.plural).toLowerCase()}`; } catch { tag.remove(); }
    });
    return () => { live = false; };
  }

  // ---------- a module's landing page: its records as cards (with counts) and its main actions
  function paintModule(host, id) {
    const m = MODULES.find((x) => x.id === id);
    if (!m) { nav('home', null, true); return null; }
    setTitle(m.label, m.sub);
    host.innerHTML = `<div class="bz-modpage">
      ${PHASE_TEXT[id] ? `<section class="card bz-soon"><span class="bz-ic big">${svg(m.icon)}</span><div><b>${esc(m.label)} screens are coming in phase ${m.phase}</b><p>${esc(PHASE_TEXT[id])}</p></div></section>` : ''}
      <div id="bzRec"></div></div>`;
    return recordCards(host.querySelector('#bzRec'), id);
  }

  /** Cards for every record kind of a module (and related kinds from other modules), with counts and a New button. */
  function recordCards(el, id) {
    const m = MODULES.find((x) => x.id === id);
    const own = Object.values(defs).filter((d) => modOfDef(d) === id && !d.child && can(d.type, 'read'));
    if (id === 'setup' && defs.account && !own.includes(defs.account)) own.push(defs.account);
    const extra = (m?.extra || []).map((t) => defs[t]).filter((d) => d && !own.includes(d) && can(d.type, 'read'));
    let live = true;
    const card = (d, i) => `<div class="bz-reccard" style="--i:${i}"><button class="bz-recopen" data-go="${d.single ? `d/${d.type}` : `l/${d.type}`}">
        <span class="bz-ic">${svg(d.icon || I.file)}</span><span class="bz-rect"><b>${esc(d.plural)}</b><small>${esc(d.description || '')}</small></span>
        <span class="bz-count" data-c="${esc(d.type)}">${d.single ? '' : '…'}</span></button>
        <div class="bz-recacts">${!d.single && can(d.type, 'write') ? `<button class="tbtn" data-go="n/${esc(d.type)}">${svg(I.plus)}New</button><button class="tbtn" data-imp="${esc(d.type)}">${svg(I.upload)}Import</button>` : d.single ? `<button class="tbtn" data-go="d/${esc(d.type)}">${svg(I.right)}Open</button>` : ''}</div></div>`;
    el.innerHTML = `${own.length ? `<h2 class="bz-h2">${id === 'stock' ? 'Places and units' : 'Records'}</h2><div class="bz-recgrid">${own.map(card).join('')}</div>` : ''}
      ${extra.length ? `<h2 class="bz-h2">${own.length ? 'Also used here' : id === 'stock' ? 'Stores, units and products' : 'Used here'}</h2><div class="bz-recgrid">${extra.map((d, i) => card(d, i + own.length)).join('')}</div>` : ''}
      ${!own.length && !extra.length ? `<div class="bz-empty card"><b>Nothing here yet</b><p>This module gets its screens in a later phase.</p></div>` : ''}`;
    el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => nav(b.dataset.go)));
    el.querySelectorAll('[data-imp]').forEach((b) => (b.onclick = () => importCsv(kit, defs[b.dataset.imp], () => count(b.dataset.imp))));
    const count = async (t) => {
      const c = el.querySelector(`[data-c="${CSS.escape(t)}"]`);
      if (!c || defs[t].single) return;
      try { const r = await api.list(t, { limit: 1 }); if (live && c.isConnected) c.textContent = qty(r?.total ?? 0); } catch { if (c.isConnected) c.textContent = ''; }
    };
    [...own, ...extra].forEach((d) => count(d.type));
    return () => { live = false; };
  }

  // ---------- "+ New" menu
  function newItems() {
    const items = [];
    if (kit.stepRights ? kit.stepRights.write : can('product', 'read')) {
      items.push({ head: 'Stock' });
      STOCK_ACTIONS.forEach((x) => items.push({ label: x.label, sub: x.hint, icon: x.icon, value: `stock/${x.kind}` }));
    }
    for (const m of MODULES) {
      const ds = Object.values(defs).filter((d) => modOfDef(d) === m.id && !d.child && !d.single && can(d.type, 'write'));
      if (!ds.length) continue;
      items.push({ head: m.label });
      ds.forEach((d) => items.push({ label: `New ${d.label.toLowerCase()}`, icon: d.icon, value: `n/${d.type}` }));
    }
    return items;
  }
  async function newMenu(btn) {
    const v = await popMenu(btn, newItems(), { align: 'right', cls: 'tall' });
    if (v) nav(v);
  }

  // ---------- user menu: switch user, text size, back to the hub
  async function meMenu(btn) {
    const cur = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const u = session?.user;
    const v = await popMenu(btn, [
      ...(u ? [{ head: `${u.name}${u.role ? ' · ' + cap(u.role) : ''}` }] : []),
      { label: 'Switch user', sub: 'With a PIN', icon: I.user, value: 'pin' },
      { sep: true }, { head: 'Text size' },
      ...SCALES.map(([l, s]) => ({ label: l === 'A' ? 'Normal' : l === 'A−' ? 'Smaller' : l === 'A+' ? 'Larger' : 'Largest', value: 'scale:' + s, on: Math.abs(cur - s) < 0.01 })),
      { sep: true },
      { label: 'Back to Shivo Labs', icon: I.grid, value: 'hub' },
    ], { align: 'right' });
    if (v === 'pin') askPin(false);
    else if (v?.startsWith('scale:')) { document.documentElement.style.setProperty('--ui-scale', v.slice(6)); store.set('biz-scale', v.slice(6)); }
    else if (v === 'hub') root.querySelector('#bzHub').click();
  }

  function askPin(must) {
    const body = `<form class="bz-pin" autocomplete="off"><label class="bz-lbl" for="bzPinIn">PIN</label>
      <input class="bz-in bz-pinin" id="bzPinIn" type="password" inputmode="numeric" maxlength="12" autocomplete="off" autofocus>
      <small class="bz-ferr" role="alert"></small></form>`;
    const m = modal({ title: must ? "Who's working?" : 'Switch user', sub: 'Enter your PIN', icon: I.user, body, closeOnVeil: !must,
      actions: [...(must ? [] : [{ label: 'Cancel', value: false }]), { label: 'Switch', pri: true, onClick: () => go() }] });
    const inp = m.box.querySelector('#bzPinIn'), err = m.box.querySelector('.bz-ferr');
    m.box.querySelector('form').onsubmit = (e) => { e.preventDefault(); go(); };
    if (must) m.beforeClose = (v) => v === true || !!session?.user;
    let busyNow = false;
    async function go() {
      const pin = inp.value.trim();
      if (!pin) { err.textContent = 'Enter your PIN'; return inp.focus(); }
      if (busyNow) return;
      busyNow = true;
      try {
        const s = await api.switchUser(pin);
        session = normSession({ ...session, ...(s?.user || s?.id ? s : {}), ready: true });
        if (!session.user) session = normSession(await api.session());
        paintUser();
        m.close(true);
        toast(`Hello, ${session.user?.name || 'there'}`);
        await loadMeta();
        const here = (location.hash.match(/^#business\/(.+)$/) || [])[1];
        route = ''; nav(here || startRoute, null, true); // draw the page again for this user's rights
      } catch (e) {
        err.textContent = e.status === 401 ? "That PIN didn't match anyone. Try again." : errText(e);
        inp.value = ''; inp.focus();
      } finally { busyNow = false; }
    }
  }

  // ---------- command palette (Ctrl+K / Ctrl+F): actions and records of every kind
  function localActions() {
    const out = [];
    if (!kit.stepRights || kit.stepRights.write) STOCK_ACTIONS.forEach((x) => out.push({ kind: 'action', title: x.label, sub: x.hint, icon: x.icon, go: `stock/${x.kind}`, words: 'stock ' + x.words }));
    for (const d of Object.values(defs)) {
      if (d.child || !can(d.type, 'read')) continue;
      if (!d.single && can(d.type, 'write')) out.push({ kind: 'action', title: `New ${d.label.toLowerCase()}`, sub: d.plural, icon: I.plus, go: `n/${d.type}`, words: 'new add create ' + d.label + ' ' + d.plural });
      out.push({ kind: 'action', title: d.single ? d.label : d.plural, sub: d.single ? 'Open' : 'Open the list', icon: d.icon, go: d.single ? `d/${d.type}` : `l/${d.type}`, words: 'open list ' + d.label + ' ' + d.plural });
      if (!d.single && can(d.type, 'write')) out.push({ kind: 'action', title: `Import ${d.plural.toLowerCase()}`, sub: 'From a CSV file', icon: I.upload, imp: d.type, words: 'import csv excel upload ' + d.plural });
    }
    MODULES.forEach((m) => out.push({ kind: 'action', title: m.label, sub: m.sub, icon: m.icon, go: m.id === 'home' ? 'home' : 'm/' + m.id, words: 'go module ' + m.label }));
    out.push({ kind: 'action', title: 'Switch user', sub: 'With a PIN', icon: I.user, fn: () => askPin(false), words: 'user pin login change' });
    return out;
  }
  function palette() {
    if (document.querySelector('.bz-palette')) return;
    const body = `<div class="bz-pal"><label class="bz-palin">${svg(I.search)}<input id="bzPalQ" placeholder="Search products, customers… or type an action" autocomplete="off" autofocus aria-label="Search" role="combobox" aria-expanded="true" aria-controls="bzPalR"><kbd>Esc</kbd></label>
      <div class="bz-palr" id="bzPalR" role="listbox"></div></div>`;
    const m = modal({ body, cls: 'bz-palette' });
    const inp = m.box.querySelector('#bzPalQ'), out = m.box.querySelector('#bzPalR');
    const acts = localActions();
    let list = [], hl = 0, seq = 0;
    const score = (a, q) => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = (a.title + ' ' + (a.sub || '') + ' ' + (a.words || '')).toLowerCase();
      return words.every((w) => hay.includes(w)) ? (a.title.toLowerCase().startsWith(words[0]) ? 2 : 1) : 0;
    };
    function draw() {
      if (!list.length) { out.innerHTML = `<p class="bz-muted bz-paln">Nothing found${inp.value ? ` for “${esc(inp.value)}”` : ''}.</p>`; return; }
      let lastKind = '';
      out.innerHTML = list.map((r, i) => {
        const head = r.kind !== lastKind ? `<div class="bz-pop-head">${r.kind === 'record' ? 'Records' : 'Actions'}</div>` : '';
        lastKind = r.kind;
        return `${head}<button class="bz-palrow${i === hl ? ' hl' : ''}" data-i="${i}" role="option" id="bzPal${i}" aria-selected="${i === hl}"><span class="bz-ic sm">${svg(r.icon || I.file)}</span>
          <span class="bz-palt"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span><span class="bz-paltag">${esc(r.tag || (r.kind === 'record' ? '' : 'Action'))}</span></button>`;
      }).join('');
      out.querySelectorAll('.bz-palrow').forEach((b) => {
        b.onclick = () => pick(+b.dataset.i);
        b.onpointermove = () => { if (hl !== +b.dataset.i) { hl = +b.dataset.i; mark(); } };
      });
      inp.setAttribute('aria-activedescendant', 'bzPal' + hl);
    }
    function mark() {
      out.querySelectorAll('.bz-palrow').forEach((b) => { const on = +b.dataset.i === hl; b.classList.toggle('hl', on); b.setAttribute('aria-selected', on); if (on) b.scrollIntoView({ block: 'nearest' }); });
      inp.setAttribute('aria-activedescendant', 'bzPal' + hl);
    }
    const run = debounce(async () => {
      const q = inp.value.trim();
      const my = ++seq;
      const a = q ? acts.map((x) => [x, score(x, q)]).filter(([, s]) => s).sort((x, y) => y[1] - x[1]).map(([x]) => x).slice(0, 8)
        : acts.filter((x) => x.go?.startsWith('stock/') || /^New (product|customer|supplier)$/.test(x.title)).slice(0, 8);
      let recs = [];
      if (q) {
        try {
          const r = await api.search(q);
          const arr = Array.isArray(r) ? r : r?.results || r?.rows || [];
          recs = arr.filter((x) => (x.kind || 'record') === 'record' && defs[x.type]).slice(0, 12).map((x) => ({
            kind: 'record', title: String(x.title ?? x.id), sub: x.subtitle || defs[x.type].label, tag: String(x.subtitle || '').startsWith(defs[x.type].label) ? '' : defs[x.type].label, icon: defs[x.type].icon, go: `d/${x.type}/${encodeURIComponent(x.id)}`,
          }));
          for (const x of arr.filter((y) => y.kind === 'action')) {
            const t = x.title || x.label;
            if (t && !a.some((y) => y.title === t)) a.push({ kind: 'action', title: t, sub: x.subtitle || '', icon: I.right, go: x.route || (x.type && x.action === 'new' ? `n/${x.type}` : x.type ? `l/${x.type}` : null) });
          }
        } catch {}
      }
      if (my !== seq) return;
      list = [...recs, ...a.filter((x) => x.go || x.imp || x.fn)];
      hl = 0; draw();
    }, 120);
    function pick(i) {
      const r = list[i]; if (!r) return;
      m.close();
      if (r.imp) importCsv(kit, defs[r.imp], () => render());
      else if (r.fn) r.fn();
      else if (r.go) nav(r.go);
    }
    inp.addEventListener('input', run);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(list.length - 1, hl + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(0, hl - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(hl); }
    });
    run();
  }

  // ---------- keyboard: Ctrl+K / Ctrl+F open search, Alt+N the New menu
  function onKey(e) {
    if (!alive || !root.querySelector('.bz-app')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'k' || k === 'f') && !e.shiftKey) {
      if (dialogOpen() && !document.querySelector('.bz-palette')) return;
      e.preventDefault(); palette();
    } else if (e.altKey && k === 'n' && !dialogOpen()) { e.preventDefault(); newMenu(root.querySelector('#bzNewMenu')); }
  }
  document.addEventListener('keydown', onKey);
  const onUnload = (e) => { if (guard?.()) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', onUnload);

  return () => {
    alive = false;
    view?.(); view = null;
    removeEventListener('popstate', onPop);
    api.onNeedPin = null;
    removeEventListener('beforeunload', onUnload);
    document.removeEventListener('keydown', onKey);
    closeAll();
    document.title = 'Shivo Labs';
  };
}
