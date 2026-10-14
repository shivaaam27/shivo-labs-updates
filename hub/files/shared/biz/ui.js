// Small parts every Business screen shares: escaping, numbers and money, icons, dialogs and confirmations.
// Dialogs trap the keyboard inside them, close on Esc and give focus back to where it was.

/** Escape any value before it goes into HTML. Use it for every value that came from a person or the server. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const svg = (p, cls = '') => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''} aria-hidden="true">${p}</svg>`;
export const I = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
  right: '<path d="M10 7l5 5-5 5"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  up: '<path d="M7 14l5-5 5 5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  // modules
  home: '<path d="M4 11l8-6.5 8 6.5v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z"/>',
  sell: '<path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  buy: '<path d="M3 4h2l2.2 11h10.6L20 7H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  stock: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
  products: '<path d="M20.5 13.5l-7 7a1.5 1.5 0 0 1-2.1 0L3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l7.9 7.9a1.5 1.5 0 0 1 0 2.1z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  customers: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5a6 6 0 0 1 12 0"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 6M18 14.2a6 6 0 0 1 3 5.3"/>',
  suppliers: '<path d="M3 6.5h11v10H3zM14 10h4l3 3v3.5h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  // stock actions
  arrived: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  move: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  count: '<path d="M9 4h6M8 4h8a2 2 0 0 1 2 2v14H6V6a2 2 0 0 1 2-2z"/><path d="M9 11l2 2 4-4"/>',
  damaged: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

// ---------- numbers (TZS has no cents in daily use; quantities keep up to 3 decimals)
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
export const fmt = (n) => (n === null || n === undefined || n === '' || isNaN(n) ? '' : nf0.format(Math.round(Number(n))));
/** A price: whole shillings stay whole, a price with cents (a USD price) keeps them. */
export const price = (n) => (n === null || n === undefined || n === '' || isNaN(n) ? '' : nf2.format(Math.round(Number(n) * 100) / 100));
export const money = (n) => (n === null || n === undefined || n === '' || isNaN(n) ? '' : 'TZS ' + nf2.format(Number(n)));
export const qty = (n) => (n === null || n === undefined || n === '' || isNaN(n) ? '' : nf3.format(Number(n)));
export const num = (s) => {
  if (typeof s === 'number') return s;
  const t = String(s ?? '').replace(/[,\s]|TZS/gi, '').replace(/%$/, '');
  if (t === '') return null;
  const n = Number(t);
  return isNaN(n) ? NaN : n;
};
export function date(s) {
  if (!s) return '';
  const d = new Date(String(s).length === 10 ? s + 'T00:00:00' : s);
  return isNaN(d) ? String(s) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function when(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- toast (the hub gives its own; this one is used when the kit runs elsewhere)
let toastFn = null;
export const setToast = (fn) => { toastFn = fn; };
export function toast(msg) {
  if (toastFn) return toastFn(msg);
  let t = document.getElementById('bzToast');
  if (!t) { t = document.createElement('div'); t.id = 'bzToast'; t.className = 'bz-toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2800);
}

// ---------- dialogs
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]):not([hidden]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const openDialogs = [];
export const dialogOpen = () => openDialogs.length > 0;
/** Close every open dialog and menu (when the screen goes away). */
export function closeAll() { [...openDialogs].reverse().forEach((d) => { d.forced = true; d.close(undefined); }); document.querySelector('.bz-pop')?._close?.(); }

/**
 * modal({title, sub, icon, body (html or element), wide, actions:[{label, pri, danger, value, id}], onClose})
 * → {el, box, close(value), done: Promise<value>}. Clicking an action resolves `done` with its value.
 */
export function modal({ title = '', sub = '', icon = '', body = '', wide = false, actions = [], cls = '', closeOnVeil = true } = {}) {
  const back = document.activeElement;
  const el = document.createElement('div');
  el.className = 'bz-veil';
  el.innerHTML = `<div class="bz-dlg${wide ? ' wide' : ''}${cls ? ' ' + cls : ''}" role="dialog" aria-modal="true" aria-labelledby="bzDlgT${openDialogs.length}">
    ${title ? `<div class="bz-dlg-h">${icon ? `<span class="bz-ic">${svg(icon)}</span>` : ''}<div><h2 id="bzDlgT${openDialogs.length}">${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
      <button class="bz-x" data-close aria-label="Close">${svg(I.close)}</button></div>` : ''}
    <div class="bz-dlg-b"></div>
    ${actions.length ? `<div class="bz-dlg-a">${actions.map((a, i) => `<button class="btn${a.pri ? ' pri' : ''}${a.danger ? ' danger' : ''}" data-act="${i}"${a.id ? ` id="${esc(a.id)}"` : ''}>${esc(a.label)}</button>`).join('')}</div>` : ''}
  </div>`;
  const box = el.firstElementChild;
  const b = box.querySelector('.bz-dlg-b');
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.append(body);
  if (!b.childNodes.length) b.remove();
  let resolve;
  const done = new Promise((r) => (resolve = r));
  let closed = false;
  const api = { el, box, done, onClose: null, beforeClose: null };
  api.close = async (value) => {
    if (closed) return;
    if (api.beforeClose && !api.forced && (await api.beforeClose(value)) === false) return;
    closed = true;
    el.remove();
    openDialogs.splice(openDialogs.indexOf(api), 1);
    document.removeEventListener('keydown', onKey, true);
    api.onClose?.(value);
    resolve(value);
    if (back && back.isConnected) back.focus?.();
  };
  function onKey(e) {
    if (openDialogs.at(-1) !== api) return;
    if (e.key === 'Escape') {
      if (document.querySelector('.sl-pop, .bz-pop')) return; // an open dropdown inside closes first
      e.preventDefault(); e.stopPropagation(); api.close(undefined); return;
    }
    if (e.key === 'Tab') { // keep the keyboard inside the dialog
      const f = [...box.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      else if (!box.contains(document.activeElement)) { e.preventDefault(); f[0].focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  el.addEventListener('pointerdown', (e) => { if (closeOnVeil && e.target === el) api.close(undefined); });
  box.querySelectorAll('[data-close]').forEach((x) => (x.onclick = () => api.close(undefined)));
  box.querySelectorAll('[data-act]').forEach((x) => (x.onclick = () => {
    const a = actions[+x.dataset.act];
    if (a.onClick) return a.onClick(api, x);
    api.close(a.value ?? a.label);
  }));
  document.body.append(el);
  openDialogs.push(api);
  requestAnimationFrame(() => {
    const first = box.querySelector('[autofocus]') || box.querySelector('.bz-dlg-b ' + FOCUSABLE) || box.querySelector('.btn.pri') || box.querySelector(FOCUSABLE);
    first?.focus();
  });
  return api;
}

/** Ask a yes/no question. Resolves true when the person agrees. */
export function confirmBox({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, icon = '' }) {
  const m = modal({ title, icon, body: text ? `<p class="bz-p">${esc(text)}</p>` : '', actions: [{ label: cancel, value: false }, { label: ok, pri: !danger, danger, value: true }] });
  return m.done.then((v) => v === true);
}

/** Keep a button from being pressed twice while its work runs. */
export async function busy(btn, work) {
  if (!btn) return work();
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1'; btn.disabled = true; btn.classList.add('busy');
  try { return await work(); } finally { delete btn.dataset.busy; btn.disabled = false; btn.classList.remove('busy'); }
}

/**
 * A small floating menu under `anchor`: items [{label, sub, icon, value, on, sep, head}] → resolves the value or undefined.
 * Arrow keys move, Enter picks, Esc closes.
 */
export function popMenu(anchor, items, { align = 'left', cls = '' } = {}) {
  document.querySelector('.bz-pop')?._close?.();
  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'bz-pop' + (cls ? ' ' + cls : '');
    pop.setAttribute('role', 'menu');
    pop.innerHTML = items.map((it, i) => it.sep ? '<div class="bz-pop-sep"></div>' : it.head ? `<div class="bz-pop-head">${esc(it.head)}</div>`
      : `<button class="bz-pop-i${it.on ? ' on' : ''}" role="menuitem" data-i="${i}">${it.icon ? svg(it.icon) : ''}<span><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.on ? svg(I.check, 'ok') : ''}</button>`).join('');
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pop.style.left = left + 'px'; pop.style.top = Math.max(8, top) + 'px';
    const btns = [...pop.querySelectorAll('.bz-pop-i')];
    const close = (v) => {
      pop.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      removeEventListener('resize', closeNow);
      anchor.setAttribute?.('aria-expanded', 'false');
      if (v === undefined) anchor.focus?.();
      resolve(v);
    };
    const closeNow = () => close(undefined);
    pop._close = closeNow;
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(undefined); };
    const key = (e) => {
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
      else if (e.key === 'Tab') close(undefined);
    };
    btns.forEach((b) => (b.onclick = () => close(items[+b.dataset.i].value)));
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', key, true);
      addEventListener('resize', closeNow);
    });
    anchor.setAttribute?.('aria-expanded', 'true');
    (pop.querySelector('.bz-pop-i.on') || btns[0])?.focus();
  });
}

/** Plain-language message for an error from the api. */
export const errText = (e) => (e && e.message) || String(e || 'Something went wrong');
