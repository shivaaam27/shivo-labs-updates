// One dropdown for every Shivo Labs screen. Windows draws plain <select> lists itself (white, blue highlight,
// ignores dark mode), so each <select> gets our own button and list on top. The <select> stays in the page,
// hidden, as the source of truth: read .value and listen for 'change' as usual.
// Use: enhanceSelects(root) after the selects are in the page. Styles: .sl* in tokens.css.
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>';
let open = null; // the one list that is open
// option texts can come from people (store names…): never put them into HTML unescaped
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function close() { if (!open) return; open.pop.remove(); open.btn.setAttribute('aria-expanded', 'false'); open = null; }
document.addEventListener('pointerdown', (e) => { if (open && !open.wrap.contains(e.target)) close(); }, true);

function enhance(sel) {
  sel.dataset.sl = '1';
  const wrap = document.createElement('div');
  wrap.className = 'sl';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sl-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.id) btn.setAttribute('aria-label', sel.closest('label')?.querySelector('span')?.textContent || sel.id);
  sel.before(wrap); wrap.append(btn, sel);
  sel.hidden = true;
  const label = () => { btn.innerHTML = `<span>${esc(sel.selectedOptions[0]?.textContent)}</span>${CHEV}`; };
  label();
  sel.addEventListener('change', label);
  // a script that sets sel.value directly does not fire 'change'; keep the label right anyway
  new MutationObserver(label).observe(sel, { childList: true, subtree: true, attributes: true });
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); label(); } });

  function choose(i) {
    if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    label(); close(); btn.focus();
  }
  function show() {
    close();
    const pop = document.createElement('div');
    pop.className = 'sl-pop';
    pop.setAttribute('role', 'listbox');
    [...sel.options].forEach((o, i) => {
      const it = document.createElement('div');
      it.className = 'sl-opt' + (i === sel.selectedIndex ? ' on' : '');
      it.setAttribute('role', 'option');
      it.innerHTML = `<span>${esc(o.textContent)}</span>${i === sel.selectedIndex ? CHECK : ''}`;
      it.onpointerdown = (e) => { e.preventDefault(); choose(i); };
      pop.append(it);
    });
    wrap.append(pop);
    // open upwards when there is no room below
    const r = btn.getBoundingClientRect();
    if (innerHeight - r.bottom < Math.min(280, pop.scrollHeight + 16) && r.top > innerHeight - r.bottom) pop.classList.add('up');
    open = { wrap, btn, pop, i: sel.selectedIndex };
    btn.setAttribute('aria-expanded', 'true');
    mark();
  }
  function mark() {
    open.pop.querySelectorAll('.sl-opt').forEach((el, i) => el.classList.toggle('hl', i === open.i));
    open.pop.children[open.i]?.scrollIntoView({ block: 'nearest' });
  }
  btn.onclick = () => (open?.btn === btn ? close() : show());
  btn.onkeydown = (e) => {
    const n = sel.options.length;
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); return show(); }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); open.i = Math.min(n - 1, open.i + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open.i = Math.max(0, open.i - 1); mark(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(open.i); }
    else if (e.key === 'Escape' || e.key === 'Tab') close();
    else if (e.key.length === 1) { // jump to the first option starting with that letter
      const k = [...sel.options].findIndex((o) => o.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      if (k >= 0) { open.i = k; mark(); }
    }
  };
}

export function enhanceSelects(root = document) {
  root.querySelectorAll('select:not([data-sl])').forEach(enhance);
}
