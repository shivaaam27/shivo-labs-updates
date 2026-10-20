// Files: Shivo Cloud on the laptop (files/PLAN.md). Browse, upload (drop or choose), new folder, rename, delete to the
// Trash, download. Everything is encrypted by the hub before it leaves this PC (hub/api/files.mjs).
const ICON = {
  up: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
const size = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
const ext = (n) => (n.match(/\.([a-z0-9]{1,4})$/i)?.[1] || 'file').toUpperCase();
const isImg = (n) => /\.(jpe?g|png|gif|heic|heif|webp|mov|mp4)$/i.test(n);
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

export function mountFiles(root, { esc, toast }) {
  let folder = '', path = [], trash = false, menuFor = '', st = null, busy = 0;
  root.innerHTML = `
    <div class="bm-grid">
      <div class="bm-col">
        <div class="card bm-card">
          <div class="bm-h fl-head"><nav class="fl-crumbs" id="flCrumbs"></nav>
            <button class="tbtn" id="flNew">${svg('plus')}New folder</button>
            <button class="tbtn" id="flTrash">${svg('trash')}Trash</button></div>
          <label class="fl-drop" id="flDrop"><input type="file" id="flPick" multiple hidden>
            <span>${svg('up')}</span><b id="flDropT">Drop files here</b><small>or click to choose</small></label>
          <div id="flList"></div>
        </div>
      </div>
      <div class="bm-col">
        <div class="card bm-card" id="flSide"></div>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);

  // ---------- the right-hand card: setup, space, devices, recovery
  async function side() {
    st = await (await fetch('/api/files/status')).json().catch(() => null);
    const el = $('#flSide');
    if (!st?.ready) {
      el.innerHTML = `<div class="bm-h"><h2>Shivo Cloud</h2></div>
        <p class="bm-note">Your files, available with this PC off and from anywhere. Encrypted on your devices before they leave them.</p>
        <button class="btn" id="flSetup">Set up</button>`;
      $('#flSetup').onclick = async () => {
        const r = await post('/api/files/setup', { name: 'PC' }); const j = await r.json().catch(() => ({}));
        if (r.ok) { toast('Shivo Cloud is ready'); side(); show(); } else toast(j.error || "Couldn't set up");
      };
      $('#flList').innerHTML = ''; $('#flDrop').hidden = true;
      return;
    }
    $('#flDrop').hidden = trash;
    const pct = st.quota ? Math.min(100, (st.used / st.quota) * 100) : 0;
    const devs = (await (await fetch('/api/files/devices')).json().catch(() => ({}))).devices || [];
    el.innerHTML = `<div class="bm-h"><h2>Shivo Cloud</h2><small class="bm-hint">${svg('lock')}Encrypted</small></div>
      <div class="fl-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <p class="bm-note">${size(st.used || 0)} of ${size(st.quota || 0)} used</p>
      <div class="bm-h" style="margin-top:14px"><h2>Devices</h2></div>
      ${devs.map((d) => `<div class="file"><span class="ext">${d.admin ? 'PC' : (d.kind || 'DEV').slice(0, 4).toUpperCase()}</span>
        <div class="meta"><div class="n">${esc(d.name)}</div><div class="s">${d.last_seen ? 'Seen ' + ago(d.last_seen) : 'Added ' + ago(d.created)}</div></div>
        ${d.admin ? '' : `<button class="ibtn" data-unlink="${esc(d.id)}" aria-label="Remove">${svg('trash')}</button>`}</div>`).join('')}
      <p class="bm-note">Add an iPhone: on the phone, Shivo Labs › Files › Connect, on the same Wi-Fi as this PC.</p>
      <details class="bm-more"><summary>${svg('lock')}Recovery code</summary>
        <p class="bm-note">Keep this somewhere safe. Without it, files can't be read if this PC and your phones are lost.</p>
        <button class="tbtn" id="flShowCode">Show</button><code class="fl-code" id="flCode"></code></details>`;
    root.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Remove this device? It loses access to Shivo Cloud.')) return;
      await post('/api/files/device-remove', { id: b.dataset.unlink }); toast('Removed'); side();
    }));
    $('#flShowCode').onclick = async () => { $('#flCode').textContent = (await (await fetch('/api/files/recovery')).json()).code; };
  }

  // ---------- the list
  async function show() {
    if (!st?.ready) return;
    $('#flDrop').hidden = trash;
    $('#flTrash').innerHTML = trash ? `${svg('back')}Files` : `${svg('trash')}Trash`;
    $('#flNew').hidden = trash;
    $('#flCrumbs').innerHTML = trash ? '<b>Trash</b>'
      : [{ id: '', name: 'Shivo Cloud' }, ...path].map((p, i, a) => i === a.length - 1 ? `<b>${esc(p.name)}</b>` : `<button class="tbtn" data-go="${esc(p.id)}">${esc(p.name)}</button><span>›</span>`).join('');
    root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => open(b.dataset.go)));
    const r = await fetch(trash ? '/api/files/trash' : `/api/files/list?parent=${encodeURIComponent(folder)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('#flList').innerHTML = `<p class="emptyt">${esc(j.error || "Couldn't reach Shivo Cloud")}</p>`; return; }
    const items = j.items || [];
    $('#flList').innerHTML = items.length ? items.map((f) => `
      <div class="file fl-row${f.kind === 'file' && isImg(f.name) ? ' img' : ''}" data-id="${esc(f.id)}">
        <button class="fl-open" data-open="${esc(f.id)}" data-kind="${f.kind}">
          <span class="ext">${f.kind === 'folder' ? svg('folder') : esc(ext(f.name))}</span>
          <div class="meta"><div class="n">${esc(f.name)}</div><div class="s">${f.kind === 'folder' ? 'Folder' : size(f.size)} · ${ago(trash ? f.deleted : f.mtime)}</div></div></button>
        ${trash ? `<button class="tbtn" data-restore="${esc(f.id)}">Restore</button>`
          : `<button class="ibtn" data-more="${esc(f.id)}" aria-label="More">${svg('dots')}</button>
             ${menuFor === f.id ? `<div class="bm-devmenu"><button class="tbtn" data-ren="${esc(f.id)}">Rename</button><button class="tbtn" data-del="${esc(f.id)}">Delete</button></div>` : ''}`}
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
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { menuFor = ''; await post('/api/files/delete', { id: b.dataset.del }); toast('Moved to the Trash'); show(); side(); }));
    root.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { await post('/api/files/restore', { id: b.dataset.restore }); toast('Restored'); show(); }));
  }
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
  $('#flTrash').onclick = () => { trash = !trash; menuFor = ''; show(); };

  side().then(show);
  const timer = setInterval(() => { if (!busy && !menuFor && document.visibilityState === 'visible') show(); }, 15000);
  return () => clearInterval(timer);
}
