// The Owner page (only on the PC that holds the owner key, hub/api/id.mjs): every customer, which modules they have,
// their PCs, phones and TVs, and invite codes. Changes reach their devices at the next pass (within a few hours, or
// at once when the device restarts).
import qrcode from '/shared/qrcode.mjs';

const NAMES = { ai: 'Shivo Labs AI', chat: 'Chat', mirror: 'Mirror', files: 'Shivo Labs Cloud', xtools: 'X Tools', tv: 'TV',
  camera: 'Camera', phone: 'Phone', insights: 'Insights', oracle: 'Oracle TM' };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Error ${r.status}`); return j; });
const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const ago = (t) => { if (!t) return 'never'; const m = (Date.now() - t) / 60000; return m < 2 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : day(t); };
// a device that checked in within 20 minutes (it sends one every 15 while it runs) is online
const online = (d) => !d.removed && d.last_seen && Date.now() - d.last_seen < 20 * 60e3;
const pretty = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;

export function mountOwner(root, { esc, toast }) {
  root.innerHTML = '<div class="own" id="own"><p class="set-note">Loading…</p></div>';
  const $ = (s) => root.querySelector(s);
  let st = null, api = '', alive = true, open = new Set();

  async function load() {
    try {
      const [s, id] = await Promise.all([fetch('/api/owner/state').then((r) => r.json()), fetch('/api/id').then((r) => r.json())]);
      if (s.error) throw new Error(s.error);
      st = s; api = id.api || '';
    } catch (e) { $('#own').innerHTML = `<p class="set-note">${esc(e.message || "Couldn't reach shivo-id")}</p>`; return; }
    if (alive) paint();
  }
  // ---------- what Shivo Labs uses on Cloudflare, against the free plan (hub/api/usage.mjs)
  const num = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString();
  const gb = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : Math.round(b / 1048576) + ' MB';
  const PER = { day: 'today', month: 'this month', total: 'in total' };
  let cfHtml = '', cfAt = 0;
  const cfOpen = new Set();   // (the page redraws itself: the card keeps what it showed and which parts are open)
  const cfWire = () => {
    const el = $('#cfUse'); if (!el) return;
    el.querySelectorAll('details[data-k]').forEach((d) => { d.open = cfOpen.has(d.dataset.k); d.ontoggle = () => { d.open ? cfOpen.add(d.dataset.k) : cfOpen.delete(d.dataset.k); }; });
    const b = $('#cfAgain'); if (b) b.onclick = () => usage(true);
  };
  async function usage(fresh) {
    if (!fresh && cfHtml && Date.now() - cfAt < 5 * 60000) return cfWire();
    const el = $('#cfUse'); if (!el) return;
    let u;
    try { const r = await fetch('/api/owner/usage' + (fresh ? '?fresh' : '')); u = await r.json(); if (u.error) throw new Error(u.error); }
    catch (e) { el.innerHTML = `<h3>Cloudflare</h3><p class="set-note">${esc(e.message || "Couldn't read the usage")}</p>`; return; }
    if (!alive || !$('#cfUse')) return;
    const top = Math.max(...u.items.map((i) => i.pct));
    const days = Object.entries(u.days).sort(), peak = Math.max(1, ...days.map(([, n]) => n));
    cfAt = Date.now();
    el.innerHTML = cfHtml = `<div class="own-uh"><h3>Cloudflare</h3><button class="tbtn" id="cfAgain">Refresh</button></div>
      <p class="set-note">${top >= 70 ? 'Something is close to its free limit.' : 'Everything is well inside the free plan.'} Daily limits start again at 3 am (midnight UTC). Over a limit, that part pauses until then; the free plan never sends a bill.</p>
      ${u.items.map((i) => `<div class="own-use"><div class="own-ul"><span>${esc(i.name)}</span><b>${i.bytes ? gb(i.used) : num(i.used)} of ${i.bytes ? gb(i.limit) : num(i.limit)} ${PER[i.per]}${i.id === 'storage' ? ' (updated hourly)' : ''}</b></div>
        <div class="fl-bar${i.pct >= 90 ? ' bad' : i.pct >= 70 ? ' warn' : ''}"><i style="width:${Math.min(100, i.pct)}%"></i></div></div>`).join('')}
      <details class="own-more" data-k="w"><summary>Requests by Worker today, and the last 7 days</summary>
        ${Object.entries(u.workers).sort((a, b) => b[1] - a[1]).map(([w, n]) => `<div class="own-ul"><span>${esc(w)}</span><b>${num(n)}</b></div>`).join('')}
        <div class="own-days">${days.map(([d, n]) => `<div title="${esc(d)}: ${n}"><i style="height:${Math.max(4, (n / peak) * 60)}px"></i><span>${esc(d.slice(8))}</span></div>`).join('')}</div>
      </details>
      ${u.customers.length ? `<details class="own-more" data-k="c"><summary>Cloud space per customer</summary>${u.customers.map((c) => `<div class="own-ul"><span>${esc(c.name)}</span><b>${gb(c.used)} of ${gb(c.quota)}</b></div>`).join('')}</details>` : ''}`;
    cfWire();
  }
  const chips = (sel, name, all = st.modules) => all.map((m) => `<label class="own-chip"><input type="checkbox" name="${name}" value="${m}" ${sel.includes(m) ? 'checked' : ''}><span>${esc(NAMES[m] || m)}</span></label>`).join('');
  const picked = (form, name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

  function paint() {
    $('#own').innerHTML = `
      <section class="card set-card" id="cfUse">${cfHtml || '<h3>Cloudflare</h3><p class="set-note">Loading…</p>'}</section>
      <section class="card set-card">
        <h3>New customer</h3>
        <form class="own-new" id="newC">
          <input class="own-in" name="name" placeholder="Name (a shop, a family, a company)" maxlength="80" required>
          <div class="own-chips">${chips([], 'm')}</div>
          <button class="btn pri">Add customer</button>
        </form>
      </section>
      ${st.customers.slice().reverse().map((c) => customer(c)).join('')}`;
    usage();
    $('#newC').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, modules = picked(f, 'm');
      if (!modules.length) return toast('Pick at least one module');
      try { const r = await post('/api/owner/customer', { name: f.name.value, modules }); open.add(r.id); toast('Customer added'); load(); } catch (er) { toast(er.message); }
    };
    root.querySelectorAll('[data-c]').forEach((el) => wire(el, st.customers.find((c) => c.id === el.dataset.c)));
    setTimeout(() => $('#own')?.classList.add('shown'), 600);   // the cards pop in once, not at every redraw
  }

  function customer(c) {
    const live = c.devices.filter((d) => !d.removed);
    return `<section class="card set-card own-c${c.paused ? ' paused' : ''}" data-c="${c.id}">
      <button class="own-head" data-act="toggle"><span><b>${esc(c.name)}</b><small>${c.owner ? 'Owner: every module, and ' + st.ownerOnly.map((m) => esc(NAMES[m] || m)).join(', ') : c.modules.map((m) => esc(NAMES[m] || m)).join(' · ') || 'No modules'}${c.paused ? ' · paused' : ''}</small></span>
        <span class="own-count">${live.length} device${live.length === 1 ? '' : 's'}</span></button>
      ${open.has(c.id) ? `<div class="own-body">
        <form class="own-mods"><div class="own-chips">${chips(c.modules, 'm')}</div>
          <div class="set-row"><span><b>Paid until</b><small>Leave empty when it isn't paid by date</small></span><input type="date" class="own-in sm" name="paid" value="${c.paidUntil ? new Date(c.paidUntil).toISOString().slice(0, 10) : ''}"></div>
          <div class="set-row"><span><b>Paused</b><small>Every device of this customer loses its modules at its next pass</small></span><input type="checkbox" name="paused" ${c.paused ? 'checked' : ''}></div>
          <button class="btn sm">Save</button></form>
        <h4>Invite codes</h4>
        ${c.codes.map((k) => `<div class="set-row"><span><b class="own-code">${pretty(k.code)}</b><small>${esc(k.label || 'No label')} · ${k.uses - k.used} of ${k.uses} left · until ${day(k.expires)}${k.modules ? ' · ' + k.modules.map((m) => esc(NAMES[m] || m)).join(', ') : ''}</small></span>
          <span class="own-acts"><button class="btn" data-qr="${k.code}">QR</button><button class="btn" data-copy="${k.code}">Copy</button><button class="btn" data-revoke="${k.code}">Cancel</button></span></div>
          <div class="own-qr" data-qr-for="${k.code}" hidden></div>`).join('') || '<p class="set-note">No open codes.</p>'}
        <form class="own-code-new"><div class="own-chips">${chips(c.modules, 'k', c.modules)}</div>
          <div class="own-line"><input class="own-in" name="label" placeholder="For (e.g. Till PC, Mum's phone)" maxlength="60">
          <label>Uses <input class="own-in xs" name="uses" type="number" min="1" max="100" value="1"></label>
          <label>Days <input class="own-in xs" name="days" type="number" min="1" max="90" value="7"></label></div>
          <button class="btn sm pri">Make a code</button></form>
        <h4>Devices</h4>
        ${c.devices.map((d) => `<div class="set-row${d.removed ? ' gone' : ''}"><span><b>${online(d) ? '<i class="own-on"></i>' : ''}${esc(d.name)}</b><small>${esc(d.info?.os || d.kind.toUpperCase())} · ${online(d) ? 'online' : 'seen ' + ago(d.last_seen)}${d.version ? ' · ' + esc(d.version) : ''}${d.modules ? ' · only ' + d.modules.map((m) => esc(NAMES[m] || m)).join(', ') : ''}${d.removed ? ' · removed' : ''}</small>${d.info?.update && !d.info.update.ok ? `<small class="own-bad">${esc(d.info.update.msg)}</small>` : ''}</span>
          <button class="btn" data-dev="${d.id}" data-removed="${d.removed ? 1 : 0}">${d.removed ? 'Allow again' : 'Remove'}</button></div>`).join('') || '<p class="set-note">No devices yet. Send a code.</p>'}
        ${c.paused && !c.owner ? '<button class="btn sm own-del" data-del>Delete this customer</button>' : ''}
      </div>` : ''}
    </section>`;
  }

  function wire(el, c) {
    el.querySelector('[data-act="toggle"]').onclick = () => { open.has(c.id) ? open.delete(c.id) : open.add(c.id); paint(); };
    const mods = el.querySelector('.own-mods');
    if (!mods) return;
    mods.onsubmit = async (e) => {
      e.preventDefault();
      const paid = mods.paid.value ? Date.parse(mods.paid.value + 'T23:59:59') : 0;
      try { await post('/api/owner/customer', { id: c.id, modules: picked(mods, 'm'), paused: mods.paused.checked, paidUntil: paid }); toast('Saved. Devices change at their next pass'); load(); } catch (er) { toast(er.message); }
    };
    el.querySelector('.own-code-new').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, k = picked(f, 'k');
      if (!k.length) return toast('Pick at least one module');
      try {
        const r = await post('/api/owner/code', { customer: c.id, modules: k.length === c.modules.length ? null : k, uses: +f.uses.value, days: +f.days.value, label: f.label.value });
        await copy(r.code); toast(`Code ${pretty(r.code)} copied, with the download link`); load();
      } catch (er) { toast(er.message); }
    };
    el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => { await copy(b.dataset.copy); toast('Copied, with the download link'); }));
    // the code as a QR (UNIFY-PLAN.md): a customer's first phone scans it with Shivo Labs or the Camera app instead of
    // typing it; that phone then adds their other devices by QR
    el.querySelectorAll('[data-qr]').forEach((b) => (b.onclick = () => {
      const box = el.querySelector(`[data-qr-for="${b.dataset.qr}"]`);
      if (!box.hidden) { box.hidden = true; return; }
      const q = qrcode(0, 'M'); q.addData(`shivolabs://code/${b.dataset.qr}`); q.make();
      box.innerHTML = `<div class="own-qr-img">${q.createSvgTag({ cellSize: 4, margin: 1, scalable: true })}</div><p>Scan with the phone's camera or in Shivo Labs. Then that phone adds the customer's other PCs, phones and TVs by QR.</p>`;
      box.hidden = false;
    }));
    el.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = async () => { try { await post('/api/owner/code/revoke', { code: b.dataset.revoke }); load(); } catch (er) { toast(er.message); } }));
    // deleted for good, with its codes and devices: only a paused customer, and a second click to be sure
    const del = el.querySelector('[data-del]');
    if (del) del.onclick = async () => {
      if (!del.dataset.sure) { del.dataset.sure = 1; del.textContent = `Click again to delete ${c.name}`; return; }
      try { await post('/api/owner/customer/delete', { id: c.id }); open.delete(c.id); toast(`${c.name} deleted`); load(); } catch (er) { toast(er.message); }
    };
    el.querySelectorAll('[data-dev]').forEach((b) => (b.onclick = async () => {
      try { await post('/api/owner/device', { id: b.dataset.dev, removed: b.dataset.removed !== '1' }); load(); } catch (er) { toast(er.message); }
    }));
  }
  // what the person needs: the link and the code (ready to paste into WhatsApp)
  const copy = (code) => navigator.clipboard.writeText(`Shivo Labs: download it from ${api || 'the Shivo Labs page'} and type this code: ${pretty(code)}`).catch(() => {});

  load();
  return () => { alive = false; };
}
