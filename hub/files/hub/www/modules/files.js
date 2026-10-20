// Shivo Labs Cloud on the laptop (files/PLAN.md): sending to your phones (beam.js) and the files kept in the cloud,
// on one page. Browse, upload (drop or choose), new folder, rename, delete to the Trash, download, versions, share links
// and request-files links. Everything is encrypted by the hub before it leaves this PC (hub/api/files.mjs).
import { enhanceSelects } from '/shared/select.js';
import { mountBeam } from './beam.js';

const ICON = {
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  up: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.2a3 3 0 0 1 0 5.6M17.5 14.2A5.5 5.5 0 0 1 20.5 19"/>',
  inbox: '<path d="M4 13l2.5-7h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 13h5l1 2h4l1-2h5"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
const big = (n, u) => `${n >= 100 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)} ${u}`;
const size = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? big(b / 1048576, 'MB') : b < 1099511627776 ? big(b / 1073741824, 'GB') : big(b / 1099511627776, 'TB');
const ext = (n) => (n.match(/\.([a-z0-9]{1,4})$/i)?.[1] || 'file').toUpperCase();
const isImg = (n) => /\.(jpe?g|png|gif|heic|heif|webp|mov|mp4)$/i.test(n);
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
// the link on the clipboard; if the browser says no, shown so it can be copied by hand
async function copy(link, toast, what) {
  const no = new Promise((_, bad) => setTimeout(bad, 2000));   // (a clipboard that never answers)
  try { await Promise.race([navigator.clipboard.writeText(link), no]); toast(what + ' copied'); } catch { prompt('Copy this link', link); }
}
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

export function mountFiles(root, ctx) {
  const { esc, toast } = ctx;
  let folder = '', path = [], trash = false, menuFor = '', st = null, busy = 0;
  root.innerHTML = `
    <div class="bm-grid">
      <div class="bm-col">
        <div id="cSend"></div>
        <div class="card bm-card">
          <div class="bm-h fl-head"><nav class="fl-crumbs" id="flCrumbs"></nav>
            <button class="tbtn" id="flNew">${svg('plus')}New folder</button>
            <button class="tbtn" id="flAsk">${svg('inbox')}Request files</button>
            <button class="tbtn" id="flTrash">${svg('trash')}Trash</button>
            <button class="tbtn" id="flCust" hidden>${svg('people')}Customers</button></div>
          <label class="fl-drop" id="flDrop"><input type="file" id="flPick" multiple hidden>
            <span>${svg('up')}</span><b id="flDropT">Drop files to keep them here</b><small>or click to choose</small></label>
          <div id="flList"></div>
        </div>
        <div id="cRecv"></div>
      </div>
      <div class="bm-col">
        <div class="card bm-card" id="flSide"></div>
        <div id="cPair"></div>
      </div>
    </div>
    <div class="xt-veil" id="flVeil" hidden><div class="xt-dialog card" id="flDialog"></div></div>`;
  const $ = (s) => root.querySelector(s);
  const leaveBeam = mountBeam(root, ctx, { send: $('#cSend'), pair: $('#cPair'), recv: $('#cRecv') });

  // ---------- the right-hand card: setup, space, devices, recovery
  async function side() {
    st = await (await fetch('/api/files/status')).json().catch(() => null);
    const el = $('#flSide');
    if (!st?.ready) {
      el.innerHTML = `<div class="bm-h"><h2>Storage</h2></div>
        <p class="bm-note">Keep your files in Shivo Labs Cloud: on your phone with this PC off, from anywhere. Encrypted on your devices before they leave them.</p>
        ${st?.operator ? '' : `<input class="field" id="flCodeIn" placeholder="Setup code (XXXX-XXXX)" autocomplete="off" spellcheck="false">
        <input class="field" id="flRecIn" placeholder="Recovery code" autocomplete="off" spellcheck="false" hidden>`}
        <button class="btn" id="flSetup">Set up</button><p class="bm-note" id="flSetupMsg"></p>`;
      $('#flSetup').onclick = async () => {
        const code = $('#flCodeIn')?.value.trim(), recovery = $('#flRecIn')?.value.trim();
        if (!st?.operator && !code) return ($('#flSetupMsg').textContent = 'Enter the setup code from Shivo Labs.');
        $('#flSetup').disabled = true;
        const r = await post('/api/files/setup', { name: 'PC', code, recovery }); const j = await r.json().catch(() => ({}));
        $('#flSetup').disabled = false;
        if (r.ok) { toast('Shivo Labs Cloud is ready'); side(); show(); return; }
        if (j.recovery) $('#flRecIn').hidden = false;
        $('#flSetupMsg').textContent = j.error || "Couldn't set up";
      };
      $('#flList').innerHTML = ''; $('#flDrop').hidden = true;
      return;
    }
    $('#flDrop').hidden = trash;
    $('#flCust').hidden = !st.operator;
    const pct = st.quota ? Math.min(100, (st.used / st.quota) * 100) : 0;
    const devs = (await (await fetch('/api/files/devices')).json().catch(() => ({}))).devices || [];
    el.innerHTML = `<div class="bm-h"><h2>Storage</h2><small class="bm-hint">${svg('lock')}Encrypted</small></div>
      <div class="fl-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <p class="bm-note">${size(st.used || 0)} of ${size(st.quota || 0)} used${st.planName && st.plan !== 'own' ? ' · ' + esc(st.planName) : ''}</p>
      ${st.readOnly ? '<p class="bm-note fl-warn">Read-only: files can be opened and downloaded, not added. Contact Shivo Labs to continue.</p>' : ''}
      <div class="bm-h fl-sec"><h2>Synced with this PC</h2><button class="tbtn" id="flAddF">${svg('plus')}Add folder</button><button class="tbtn" id="flSyncNow">Sync now</button></div>
      <div id="flFolders"></div>
      <p class="bm-note">${st.sync?.error ? 'Sync problem: ' + esc(st.sync.error) : st.sync?.busy ? esc(st.sync.busy) + '…' : st.sync?.last ? 'Synced ' + ago(st.sync.last) : 'Not synced yet'}. These folders open on your phone with this PC off.</p>
      <div id="flLinks"></div>
      <div class="bm-h fl-sec"><h2>Access to your files</h2></div>
      ${devs.map((d) => `<div class="file"><span class="ext">${d.admin ? 'PC' : (d.kind || 'DEV').slice(0, 4).toUpperCase()}</span>
        <div class="meta"><div class="n">${esc(d.name)}</div><div class="s">${d.last_seen ? 'Seen ' + ago(d.last_seen) : 'Added ' + ago(d.created)}</div></div>
        ${d.admin ? '' : `<button class="ibtn" data-unlink="${esc(d.id)}" aria-label="Remove">${svg('trash')}</button>`}</div>`).join('')}
      <p class="bm-note">A phone set up below gets access the next time it opens Shivo Labs on this PC's Wi-Fi.</p>
      <details class="bm-more"><summary>${svg('lock')}Recovery code</summary>
        <p class="bm-note">Keep this somewhere safe. Without it, files can't be read if this PC and your phones are lost.</p>
        <button class="tbtn" id="flShowCode">Show</button><code class="fl-code" id="flCode"></code></details>`;
    $('#flSyncNow').onclick = async () => { await post('/api/files/sync'); toast('Syncing'); setTimeout(() => { side(); show(); }, 4000); };
    folders();
    root.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Remove this device? It loses access to your files in Shivo Labs Cloud.')) return;
      await post('/api/files/device-remove', { id: b.dataset.unlink }); toast('Removed'); side();
    }));
    $('#flShowCode').onclick = async () => { $('#flCode').textContent = (await (await fetch('/api/files/recovery')).json()).code; };
    links();
  }

  // ---------- PC folders kept in sync with Shivo Cloud: the Beam folder always, plus the ones added here
  async function folders() {
    const f = await (await fetch('/api/beam/folders')).json().catch(() => null), el = $('#flFolders');
    if (!f || !el) return;
    const row = (name, path, removable, missing) => `<div class="file"><span class="ext">${svg('folder')}</span>
      <div class="meta"><div class="n">${esc(name)}</div><div class="s">${missing ? 'Not found on this PC' : esc(path)}</div></div>
      ${removable ? `<button class="ibtn" data-unsync="${esc(path)}" aria-label="Stop syncing">${svg('x')}</button>` : ''}</div>`;
    el.innerHTML = row('Beam', f.beam, false) + (f.list || []).map((x) => row(x.name, x.path, true, x.missing)).join('');
    el.querySelectorAll('[data-unsync]').forEach((b) => (b.onclick = async () => {
      const r = await post('/api/beam/folders', { remove: b.dataset.unsync });
      if (r.ok) { toast('No longer synced. The copy in the cloud stays.'); folders(); }
    }));
  }
  $('#flSide').addEventListener('click', async (e) => {
    if (!e.target.closest('#flAddF')) return;
    const r = await post('/api/beam/folders', { add: true }), j = await r.json().catch(() => ({}));
    if (j.ok) { toast('Added. It syncs to Shivo Labs Cloud in a moment.'); folders(); } else if (j.error) toast(j.error);
  });

  // ---------- share links and request links that still work
  async function links() {
    const [sh, rq] = await Promise.all([fetch('/api/files/shares'), fetch('/api/files/requests')].map((p) => p.then((r) => r.json()).catch(() => ({}))));
    const shares = sh.shares || [], reqs = rq.requests || [], el = $('#flLinks');
    if (!el) return;
    const left = (t) => (t ? 'until ' + new Date(t).toLocaleDateString() : 'no end date');
    el.innerHTML = !shares.length && !reqs.length ? '' : `<div class="bm-h fl-sec"><h2>Links</h2></div>
      ${shares.map((x) => `<div class="file"><span class="ext">${svg('link')}</span>
        <div class="meta"><div class="n">${esc(x.name)}</div><div class="s">${x.downloads} download${x.downloads === 1 ? '' : 's'} · ${left(x.expires)}${x.password ? ' · password' : ''}</div></div>
        <button class="tbtn" data-copy="${esc(x.link)}">Copy</button><button class="ibtn" data-unshare="${esc(x.id)}" aria-label="Turn off">${svg('trash')}</button></div>`).join('')}
      ${reqs.map((x) => `<div class="file"><span class="ext">${svg('inbox')}</span>
        <div class="meta"><div class="n">${esc(x.title)}</div><div class="s">Into ${esc(x.folder)} · ${x.count} received · ${left(x.expires)}</div></div>
        <button class="tbtn" data-copy="${esc(x.link)}">Copy</button><button class="ibtn" data-unask="${esc(x.id)}" aria-label="Turn off">${svg('trash')}</button></div>`).join('')}`;
    el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy, toast, 'Link')));
    el.querySelectorAll('[data-unshare]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Turn off this link? Anyone who has it can no longer download the file.')) return;
      await post('/api/files/share-remove', { id: b.dataset.unshare }); toast('Link turned off'); links();
    }));
    el.querySelectorAll('[data-unask]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Turn off this request link? Files already received stay.')) return;
      await post('/api/files/request-remove', { id: b.dataset.unask }); toast('Link turned off'); links();
    }));
  }
  async function share(id, password) {
    const r = await post('/api/files/share', { id, days: 7, password }), j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || "Couldn't make a link");
    links(); copy(j.link, toast, 'Link (works for 7 days)');
  }

  // ---------- the list
  async function show() {
    if (!st?.ready) return;
    $('#flDrop').hidden = trash;
    $('#flTrash').innerHTML = trash ? `${svg('back')}Files` : `${svg('trash')}Trash`;
    $('#flNew').hidden = trash; $('#flAsk').hidden = trash;
    $('#flCrumbs').innerHTML = trash ? '<b>Trash</b>'
      : [{ id: '', name: 'Your files' }, ...path].map((p, i, a) => i === a.length - 1 ? `<b>${esc(p.name)}</b>` : `<button class="tbtn" data-go="${esc(p.id)}">${esc(p.name)}</button><span>›</span>`).join('');
    root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => open(b.dataset.go)));
    const r = await fetch(trash ? '/api/files/trash' : `/api/files/list?parent=${encodeURIComponent(folder)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('#flList').innerHTML = `<p class="emptyt">${esc(j.error || "Couldn't reach Shivo Labs Cloud")}</p>`; return; }
    const items = j.items || [];
    $('#flList').innerHTML = items.length ? items.map((f) => `
      <div class="file fl-row${f.kind === 'file' && isImg(f.name) ? ' img' : ''}" data-id="${esc(f.id)}">
        <button class="fl-open" data-open="${esc(f.id)}" data-kind="${f.kind}">
          <span class="ext">${f.kind === 'folder' ? svg('folder') : esc(ext(f.name))}</span>
          <div class="meta"><div class="n">${esc(f.name)}</div><div class="s">${f.kind === 'folder' ? 'Folder' : size(f.size)} · ${ago(trash ? f.deleted : f.mtime)}</div></div></button>
        ${trash ? `<button class="tbtn" data-restore="${esc(f.id)}">Restore</button>`
          : `<button class="ibtn" data-more="${esc(f.id)}" aria-label="More">${svg('dots')}</button>
             ${menuFor === f.id ? `<div class="bm-devmenu">${f.kind === 'file' ? `<button class="tbtn" data-share="${esc(f.id)}">Copy link</button><button class="tbtn" data-sharepw="${esc(f.id)}">Link with password</button><button class="tbtn" data-vers="${esc(f.id)}">Versions</button>` : ''}<button class="tbtn" data-ren="${esc(f.id)}">Rename</button><button class="tbtn" data-del="${esc(f.id)}">Delete</button></div>` : ''}`}
      </div>`).join('')
      : `<p class="emptyt">${trash ? 'The Trash is empty. Deleted files stay here for 30 days.' : 'Nothing here yet. Drop files above.'}</p>`;
    root.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => {
      if (trash) return;
      if (b.dataset.kind === 'folder') return open(b.dataset.open, items.find((x) => x.id === b.dataset.open)?.name);
      location.href = '/api/files/download?id=' + encodeURIComponent(b.dataset.open);   // decrypted by the hub, saved by the browser
    }));
    root.querySelectorAll('[data-more]').forEach((b) => (b.onclick = () => { menuFor = menuFor === b.dataset.more ? '' : b.dataset.more; show(); }));
    root.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = async () => {
      const it = items.find((x) => x.id === b.dataset.ren), name = prompt('New name', it.name); menuFor = '';
      if (name && name !== it.name) { const r = await post('/api/files/rename', { id: it.id, name }); if (!r.ok) toast((await r.json()).error); }
      show();
    }));
    root.querySelectorAll('[data-share]').forEach((b) => (b.onclick = () => { menuFor = ''; show(); share(b.dataset.share); }));
    root.querySelectorAll('[data-sharepw]').forEach((b) => (b.onclick = () => {
      const pw = prompt('Password for this link'); menuFor = ''; show();
      if (pw) share(b.dataset.sharepw, pw);
    }));
    root.querySelectorAll('[data-vers]').forEach((b) => (b.onclick = () => { menuFor = ''; show(); versions(items.find((x) => x.id === b.dataset.vers)); }));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { menuFor = ''; await post('/api/files/delete', { id: b.dataset.del }); toast('Moved to the Trash'); show(); side(); }));
    root.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { await post('/api/files/restore', { id: b.dataset.restore }); toast('Restored'); show(); }));
  }
  // ---------- a file's earlier versions: download one, or make it the current one again
  const veil = $('#flVeil'), dlg = $('#flDialog');
  const closeDialog = () => { veil.hidden = true; dlg.innerHTML = ''; dlg.classList.remove('wide'); };
  veil.onclick = (e) => { if (e.target === veil) closeDialog(); };
  async function versions(it) {
    veil.hidden = false;
    dlg.innerHTML = `<h2>${esc(it.name)}</h2><p>Loading versions…</p>`;
    const r = await fetch('/api/files/versions?id=' + encodeURIComponent(it.id)), j = await r.json().catch(() => ({}));
    const list = j.versions || [];
    dlg.innerHTML = `<h2>${esc(it.name)}</h2><p>${r.ok ? 'The last 10 versions are kept.' : esc(j.error || "Couldn't load the versions")}</p>
      ${list.map((v) => `<div class="file"><span class="ext">${esc(ext(it.name))}</span>
        <div class="meta"><div class="n">${v.current ? 'Current version' : 'Version ' + v.version}</div><div class="s">${size(v.size)} · ${new Date(v.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div></div>
        <button class="tbtn" data-get="${v.current ? '' : v.version}">Download</button>
        ${v.current ? '' : `<button class="tbtn" data-back="${v.version}">Restore</button>`}</div>`).join('')}
      <div class="xt-actions"><button class="btn xt-btn" id="flClose">Done</button></div>`;
    $('#flClose').onclick = closeDialog;
    dlg.querySelectorAll('[data-get]').forEach((b) => (b.onclick = () => { location.href = '/api/files/download?id=' + encodeURIComponent(it.id) + (b.dataset.get ? '&version=' + b.dataset.get : ''); }));
    dlg.querySelectorAll('[data-back]').forEach((b) => (b.onclick = async () => {
      b.disabled = true; b.textContent = 'Restoring…';
      const rr = await post('/api/files/version-restore', { id: it.id, version: Number(b.dataset.back) });
      if (!rr.ok) { toast((await rr.json().catch(() => ({}))).error || "Couldn't restore"); b.disabled = false; b.textContent = 'Restore'; return; }
      toast('Restored'); versions(it); show(); side();
    }));
  }
  // ---------- Shivo Labs' customers (only on PCs that hold the create key)
  const day = (t) => (t ? new Date(t).toLocaleDateString([], { dateStyle: 'medium' }) : '');
  const dateIn = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  const state = (a) => a.paused ? 'Paused' : a.readOnly ? 'Read-only (not paid)' : a.codePending && !a.devices ? 'Waiting for setup' : 'Active';
  async function customers() {
    veil.hidden = false; dlg.classList.add('wide');
    dlg.innerHTML = '<h2>Customers</h2><p>Loading…</p>';
    const r = await fetch('/api/files/admin/accounts'), j = await r.json().catch(() => ({}));
    if (!r.ok) { dlg.innerHTML = `<h2>Customers</h2><p>${esc(j.error || "Couldn't load")}</p><div class="xt-actions"><button class="btn xt-btn" id="flClose">Done</button></div>`; $('#flClose').onclick = closeDialog; return; }
    const plans = j.plans || {};
    dlg.innerHTML = `<div class="bm-h"><h2>Customers</h2><button class="tbtn" id="flAdd">${svg('plus')}New customer</button></div>
      ${(j.accounts || []).map((a) => `<div class="file">
        <span class="ext">${esc((a.name || 'SL').slice(0, 2).toUpperCase())}</span>
        <div class="meta"><div class="n">${esc(a.name || 'Shivo Labs')}</div>
          <div class="s">${esc(a.planName)} · ${size(a.used)} of ${size(a.quota)} · ${a.devices || 0} device${a.devices === 1 ? '' : 's'}${a.lastSeen ? ' · seen ' + ago(a.lastSeen) : ''}</div>
          <div class="s">${state(a)}${a.paidUntil ? ' · paid until ' + day(a.paidUntil) : ''}</div></div>
        <button class="tbtn" data-edit="${esc(a.id)}">Edit</button></div>`).join('') || '<p class="emptyt">No customers yet.</p>'}
      <details class="bm-more"><summary>${svg('link')}Turn off a reported link</summary>
        <div class="fl-inline"><input class="field" id="flTake" placeholder="Paste the share link"><button class="tbtn" id="flTakeGo">Turn off</button></div></details>
      <div class="xt-actions"><button class="btn xt-btn" id="flClose">Done</button></div>`;
    $('#flClose').onclick = closeDialog;
    $('#flTakeGo').onclick = async () => {
      const rr = await post('/api/files/admin/takedown', { link: $('#flTake').value }), jj = await rr.json().catch(() => ({}));
      toast(!rr.ok ? jj.error || "Couldn't turn it off" : jj.found ? 'Link turned off' : 'No working link with that address');
    };
    $('#flAdd').onclick = () => editCustomer(null, plans);
    dlg.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editCustomer(j.accounts.find((a) => a.id === b.dataset.edit), plans)));
  }
  function editCustomer(a, plans) {
    dlg.innerHTML = `<h2>${a ? esc(a.name || 'Shivo Labs') : 'New customer'}</h2>
      <label class="fl-lbl">Name<input class="field" id="cuName" value="${esc(a?.name || '')}" placeholder="Customer or company"></label>
      <label class="fl-lbl">Package<select class="field" id="cuPlan">${Object.entries(plans).map(([k, v]) => `<option value="${k}"${(a ? a.plan : 'starter') === k ? ' selected' : ''}>${esc(v.name)} · ${size(v.quota)}</option>`).join('')}</select></label>
      <label class="fl-lbl">Paid until<input class="field" type="date" id="cuPaid" value="${dateIn(a?.paidUntil)}"></label>
      <p class="bm-note">Empty: no end date. 14 days after the date, the account becomes read-only until it is renewed.</p>
      ${a ? `<label class="fl-check"><input type="checkbox" id="cuPause"${a.paused ? ' checked' : ''}> Paused (read-only)</label>` : ''}
      <div id="cuCode"></div>
      <div class="xt-actions">${a ? '<button class="tbtn" id="cuNewCode">New setup code</button>' : ''}<button class="tbtn" id="cuBack">Back</button><button class="btn xt-btn" id="cuSave">${a ? 'Save' : 'Create'}</button></div>`;
    enhanceSelects(dlg);
    const showCode = (c) => { $('#cuCode').innerHTML = `<p class="bm-note">Setup code for the customer's PC (Files › Set up). Valid for 7 days.</p><code class="fl-code fl-big">${esc(c)}</code>`; };
    $('#cuBack').onclick = customers;
    if (a) $('#cuNewCode').onclick = async () => { const rr = await post('/api/files/admin/code', { id: a.id }), jj = await rr.json(); if (rr.ok) showCode(jj.code); else toast(jj.error); };
    $('#cuSave').onclick = async () => {
      const paid = $('#cuPaid').value ? new Date($('#cuPaid').value + 'T23:59:59').getTime() : 0;
      const body = { name: $('#cuName').value.trim(), plan: $('#cuPlan').value, paidUntil: paid };
      if (!a && !body.name) return toast('Enter a name');
      const rr = a ? await post('/api/files/admin/edit', { id: a.id, ...body, paused: $('#cuPause').checked }) : await post('/api/files/admin/new', body);
      const jj = await rr.json().catch(() => ({}));
      if (!rr.ok) return toast(jj.error || "Couldn't save");
      if (a) { toast('Saved'); customers(); side(); return; }
      toast('Customer added'); showCode(jj.code); $('#cuSave').hidden = true; $('#cuBack').textContent = 'Done';
    };
  }
  $('#flCust').onclick = customers;
  async function open(id, name) {
    folder = id || '';
    if (!folder) path = [];
    else { const i = path.findIndex((p) => p.id === folder); path = i >= 0 ? path.slice(0, i + 1) : [...path, { id: folder, name: name || '…' }]; }
    menuFor = ''; show();
  }

  // ---------- uploading (the hub encrypts as it goes)
  async function upload(list) {
    if (!list.length) return;
    busy += list.length; paintBusy();
    let ok = 0;
    for (const f of list) {
      try {
        const r = await fetch(`/api/files/upload?parent=${encodeURIComponent(folder)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'x-hub': '1' }, body: f });
        if (r.ok) ok++; else toast((await r.json().catch(() => ({}))).error || `Couldn't upload ${f.name}`);
      } catch { toast(`Couldn't upload ${f.name}`); }
      busy--; paintBusy();
    }
    if (ok) toast(`${ok} uploaded`);
    show(); side();
  }
  const paintBusy = () => { $('#flDropT').textContent = busy ? `Uploading ${busy}…` : 'Drop files here'; $('#flDrop').classList.toggle('busy', busy > 0); };
  const drop = $('#flDrop');
  $('#flPick').onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); upload([...e.dataTransfer.files].filter((f) => f.size || f.type)); };
  $('#flNew').onclick = async () => {
    const name = prompt('Folder name', 'New folder'); if (!name) return;
    const r = await post('/api/files/mkdir', { parent: folder, name }); if (!r.ok) toast((await r.json()).error); show();
  };
  // a link anyone can use to send files into this folder (at the top: into a new folder named after it)
  $('#flAsk').onclick = async () => {
    const here = path.length ? path[path.length - 1].name : '';
    const title = prompt(here ? `Files sent with this link go into "${here}". Title people see:` : 'Files sent with this link go into a new folder. Its name:', here ? `Send files to ${here}` : 'Received files');
    if (!title) return;
    const r = await post('/api/files/request', { folder, title, days: 30 }), j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || "Couldn't make a link");
    links(); if (!folder) show();
    copy(j.link, toast, 'Request link (works for 30 days)');
  };
  $('#flTrash').onclick = () => { trash = !trash; menuFor = ''; show(); };

  side().then(show);
  const timer = setInterval(() => { if (!busy && !menuFor && veil.hidden && document.visibilityState === 'visible') show(); }, 15000);
  return () => { clearInterval(timer); leaveBeam(); };
}
