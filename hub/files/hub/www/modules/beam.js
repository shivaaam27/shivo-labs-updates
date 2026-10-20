// Beam's PC screen inside the hub: your phones and tablets as cards (pick one or several, or drop files on one),
// send files and text to them, see what came in, set up a new one.
// The installed Beam (tray) is the engine; the hub server's /api/beam/* reads and fills its folders.
import qrcode from '/shared/qrcode.mjs';

const ICON = {
  up: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  text: '<path d="M5 6h14M5 12h14M5 18h9"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
const size = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
const ext = (n) => (n.match(/\.([a-z0-9]{1,4})$/i)?.[1] || 'file').toUpperCase();
const isImg = (n) => /\.(jpe?g|png|gif|heic|heif|webp|mov|mp4)$/i.test(n);
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'x-hub': '1' }, body });
// a device drawn in its own shape: iPhone, iPad, Android phone, Android tablet
const SHAPE = {
  iphone: '<rect x="13" y="4" width="22" height="40" rx="5"/><rect x="20.5" y="7" width="7" height="2.4" rx="1.2" class="f"/>',
  android: '<rect x="13" y="4" width="22" height="40" rx="3.5"/><circle cx="24" cy="8.4" r="1.3" class="f"/>',
  ipad: '<rect x="6" y="7" width="36" height="34" rx="4"/><circle cx="24" cy="9.6" r=".9" class="f"/>',
  tablet: '<rect x="3" y="11" width="42" height="26" rx="3.5"/><circle cx="6.2" cy="24" r=".9" class="f"/>',
};
const shape = (k) => `<svg viewBox="0 0 48 48" class="bm-shape">${SHAPE[k] || SHAPE.iphone}</svg>`;
const KIND = { iphone: 'iPhone', ipad: 'iPad', android: 'Android phone', tablet: 'Tablet' };
const names = (list) => list.length < 3 ? list.join(' and ') : `${list.length} devices`;

export function mountBeam(root, { esc, toast, openModule }) {
  let st = null, pairMode = 'shortcut', timer = 0, sending = 0, menuFor = '';
  // the devices files go to (several allowed); none chosen = all of them
  let picked = new Set(); try { picked = new Set(JSON.parse(localStorage.getItem('beam.picked')) || []); } catch {}
  const savePicked = () => { try { localStorage.setItem('beam.picked', JSON.stringify([...picked])); } catch {} };
  root.innerHTML = `
    <div class="bm-grid">
      <div class="bm-col">
        <div class="card bm-card bm-devs" id="bmDevCard">
          <div class="bm-h"><h2>Your devices</h2><small class="bm-hint" id="bmDevHint"></small></div>
          <div class="bm-devlist" id="bmDevs"></div>
        </div>
        <label class="bm-drop card" id="bmDrop">
          <input type="file" id="bmPick" multiple hidden>
          <span class="mod-ic">${svg('up')}</span>
          <b id="bmDropT">Drop files to send to iPhone</b><small id="bmDropS">or click to choose · or copy files and press Ctrl+V here</small>
        </label>
        <div class="card bm-card">
          <div class="bm-h"><h2>Waiting to be collected</h2><span class="count" id="bmCount"></span></div>
          <div id="bmWaiting"></div>
          <details class="bm-more"><summary>${svg('text')}Send text instead</summary>
            <textarea id="bmText" placeholder="Paste or type text to send"></textarea>
            <button class="btn sm" id="bmTextBtn">Send text</button></details>
        </div>
        <div class="card bm-card">
          <div class="bm-h"><h2>Received</h2><button class="tbtn" id="bmFolder">${svg('folder')}Open folder</button></div>
          <label class="bm-links">Links from your phone open in <select id="bmBrowser"><option value="">Default browser</option></select></label>
          <div id="bmReceived"></div>
        </div>
      </div>
      <div class="bm-col">
        <div class="card bm-card bm-pair">
          <div class="bm-h"><h2>Set up iPhone</h2></div>
          <div class="seg" id="bmSeg"><button data-m="shortcut" class="on">Share menu</button><button data-m="web">Safari app</button></div>
          <div class="bm-qr" id="bmQr"></div>
          <ol class="bm-steps" id="bmSteps"></ol>
          <p class="bm-note" id="bmNote"></p>
        </div>
        <div class="card bm-card">
          <div class="bm-h"><h2>Folders in Shivo Cloud</h2><button class="tbtn" id="bmAddFolder">${svg('folder')}Add folder</button></div>
          <p class="bm-note">Kept in sync with Shivo Cloud, so they open on your phone with this PC off.</p>
          <div id="bmFolders"></div>
        </div>
        <div class="card bm-card">
          <label class="bm-links"><input type="checkbox" id="bmAwake"> Keep this PC available while plugged in</label>
          <p class="bm-note">The screen still turns off. On battery the PC sleeps as usual.</p>
        </div>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);

  // ---------- status (polled while the page is open)
  async function load() {
    try { st = await (await fetch('/api/beam/status')).json(); } catch { return; }
    paint();
  }
  function paint() {
    const pill = document.getElementById('pageState');
    // (the relay is what lets a phone find this PC from anywhere, and at home when beam.local doesn't answer)
    if (pill) pill.innerHTML = st.running ? `<i class="dot"></i>${esc(st.host)}${st.relay?.connected ? ' · reachable from anywhere' : ''}` : `<button class="tbtn" id="bmStart">Start Beam</button>`;
    document.getElementById('bmStart')?.addEventListener('click', () => openModule('beam', true));
    const aw = $('#bmAwake'); if (aw && document.activeElement !== aw) aw.checked = st.awake !== false;
    const devs = st.devices || [];
    for (const id of picked) if (!devs.some((d) => d.id === id)) picked.delete(id);
    if (!renaming) paintDevices(devs);
    busy();
    const all = [...st.waiting.map((f) => ({ ...f, to: '', who: devs.length ? 'Any device' : '' })),
      ...devs.flatMap((d) => d.waiting.map((f) => ({ ...f, to: d.id, who: d.name })))].sort((a, b) => b.at - a.at);
    $('#bmCount').textContent = all.length || '';
    $('#bmWaiting').innerHTML = all.length
      ? all.map((f) => `<div class="file${isImg(f.name) ? ' img' : ''}"><span class="ext">${esc(ext(f.name))}</span><div class="meta"><div class="n">${esc(f.name)}</div><div class="s">${f.who ? `<span class="bm-for">${esc(f.who)}</span> · ` : ''}${size(f.size)} · ${ago(f.at)}</div></div><button class="ibtn" data-rm="${esc(f.name)}" data-to="${esc(f.to)}" aria-label="Remove">${svg('x')}</button></div>`).join('')
        + `<p class="bm-tip">On the phone or tablet, open Beam in the Shivo Labs app (or run <b>Get from PC</b>).</p>`
      : `<p class="emptyt">Nothing waiting. Files you drop here wait until the device collects them.</p>`;
    root.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { await post(`/api/beam/remove?name=${encodeURIComponent(b.dataset.rm)}&to=${encodeURIComponent(b.dataset.to)}`); load(); }));
    $('#bmReceived').innerHTML = st.received.length
      ? st.received.map((f) => `<button class="file${isImg(f.name) ? ' img' : ''}" data-rv="${esc(f.name)}"><span class="ext">${esc(ext(f.name))}</span><div class="meta"><div class="n">${esc(f.name)}</div><div class="s">${size(f.size)} · ${ago(f.at)}</div></div></button>`).join('')
      : `<p class="emptyt">From iPhone: Share, then Send to PC. Files land in Downloads\\Beam.</p>`;
    root.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = () => post(`/api/beam/reveal?name=${encodeURIComponent(b.dataset.rv)}`)));
    paintPair();
  }
  let renaming = false;
  function paintDevices(devs) {
    $('#bmDevHint').textContent = devs.length ? (picked.size ? 'Click again to unselect' : devs.length > 1 ? 'None chosen: files go to all of them' : 'Drop files on it, or below') : '';
    if (!devs.length) {
      $('#bmDevs').innerHTML = `<p class="emptyt">Phones and tablets show here after they open Beam once. Set one up on the right.</p>`;
      return;
    }
    $('#bmDevs').innerHTML = devs.map((d) => `
      <div class="bm-dev${picked.has(d.id) ? ' on' : ''}${d.nearby ? ' near' : ''}" data-dev="${esc(d.id)}" title="${esc(KIND[d.kind] || 'Device')}">
        <button class="bm-devpick" data-pick="${esc(d.id)}">
          ${shape(d.kind)}${d.waiting.length ? `<span class="bm-badge">${d.waiting.length}</span>` : ''}
          <b class="bm-devname">${esc(d.name)}</b>
          <small>${d.nearby ? '<i class="dot"></i>Nearby' : `Seen ${ago(d.seen)}`}</small>
        </button>
        <button class="bm-devmore" data-more="${esc(d.id)}" aria-label="Rename or remove">&#8943;</button>
        ${menuFor === d.id ? `<div class="bm-devmenu"><button class="tbtn" data-ren="${esc(d.id)}">Rename</button><button class="tbtn" data-forget="${esc(d.id)}">Remove</button></div>` : ''}
      </div>`).join('');
    root.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.pick; picked.has(id) ? picked.delete(id) : picked.add(id); savePicked(); menuFor = ''; paint();
    }));
    root.querySelectorAll('[data-more]').forEach((b) => (b.onclick = () => { menuFor = menuFor === b.dataset.more ? '' : b.dataset.more; paint(); }));
    root.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = () => rename(b.dataset.ren)));
    root.querySelectorAll('[data-forget]').forEach((b) => (b.onclick = async () => {
      await post('/api/beam/device', JSON.stringify({ id: b.dataset.forget, remove: true }));
      picked.delete(b.dataset.forget); savePicked(); menuFor = ''; toast('Removed. It comes back if it opens Beam again.'); load();
    }));
    // drop straight onto a device
    root.querySelectorAll('.bm-dev').forEach((el) => {
      el.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('drag'); };
      el.ondragleave = () => el.classList.remove('drag');
      el.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drag'); sendFiles([...e.dataTransfer.files].filter((f) => f.size || f.type), [el.dataset.dev]); };
    });
  }
  function rename(id) {
    const card = root.querySelector(`[data-dev="${CSS.escape(id)}"]`), name = card?.querySelector('.bm-devname');
    if (!name) return;
    renaming = true; menuFor = '';
    card.querySelector('.bm-devmenu')?.remove();
    name.contentEditable = 'plaintext-only'; name.focus();
    document.getSelection().selectAllChildren(name);
    const done = async (save) => {
      name.onblur = name.onkeydown = null; name.contentEditable = 'false';
      if (save && name.textContent.trim()) await post('/api/beam/device', JSON.stringify({ id, name: name.textContent.trim() }));
      renaming = false; load();
    };
    name.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); };
    name.onclick = (e) => e.stopPropagation();
    name.onblur = () => done(true);
  }
  // who a send goes to: the chosen devices (or the ones given), else any device
  // who a send goes to: the chosen devices, or all of them when none is chosen (never "whichever asks first")
  const chosen = () => { const all = st?.devices || [], p = all.filter((d) => picked.has(d.id)); return p.length ? p : all; };
  const label = (ids) => {
    const all = st?.devices || [], d = all.filter((x) => ids.includes(x.id)).map((x) => x.name);
    return !d.length ? 'your phone' : d.length > 1 && d.length === all.length ? 'all your devices' : names(d);
  };
  function paintPair() {
    const url = pairMode === 'shortcut' ? st.shortcut : pairMode === 'web' ? st.web : st.webIp;
    const steps = pairMode === 'shortcut'
      ? ['Point the iPhone Camera at this code and tap the link.', 'Tap <b>Add Shortcut</b>.', 'Share anything, then <b>Send to PC</b>. The first time, click Accept on the PC.']
      : ['Point the iPhone Camera at this code and tap the link.', 'In Safari, tap Share, then <b>Add to Home Screen</b>.', 'Open Beam on the iPhone to send and receive.'];
    if (url) { const q = qrcode(0, 'M'); q.addData(url); q.make(); $('#bmQr').innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); }
    else $('#bmQr').innerHTML = '<p class="emptyt">Start Beam once to make the link.</p>';
    $('#bmSteps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
    $('#bmNote').innerHTML = `Set up on the same Wi-Fi as this PC. After that it also works away from home.${pairMode === 'web' ? ' <button class="tbtn" id="bmIp">Link won\'t open? Use the IP address</button>' : ''}${st.trusted ? ` ${st.trusted} iPhone${st.trusted > 1 ? 's' : ''} trusted.` : ''}`;
    $('#bmIp')?.addEventListener('click', () => { pairMode = 'web-ip'; paintPair(); });
  }
  $('#bmSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; pairMode = b.dataset.m; root.querySelectorAll('#bmSeg button').forEach((x) => x.classList.toggle('on', x === b)); st && paintPair(); };

  // ---------- sending
  async function sendFiles(list, ids = chosen().map((d) => d.id)) {
    if (!list.length) return;
    sending += list.length; busy();
    let ok = 0;
    for (const f of list) {
      try { const r = await post(`/api/beam/send?name=${encodeURIComponent(f.name)}&to=${encodeURIComponent(ids.join(','))}`, f); if (r.ok) ok++; } catch {}
      sending--; busy();
    }
    toast(ok === list.length ? `${ok} item${ok > 1 ? 's' : ''} ready for ${label(ids)}.` : `${list.length - ok} couldn't be added`);
    load();
  }
  function busy() {
    $('#bmDrop').classList.toggle('busy', sending > 0);
    $('#bmDropT').textContent = sending ? `Preparing ${sending} item${sending > 1 ? 's' : ''}…` : `Drop files to send to ${label(chosen().map((d) => d.id))}`;
    $('#bmDropS').textContent = sending ? '' : 'or click to choose · or copy files and press Ctrl+V here';
  }
  const drop = $('#bmDrop');
  $('#bmPick').onchange = (e) => { sendFiles([...e.target.files]); e.target.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); sendFiles([...e.dataTransfer.files].filter((f) => f.size || f.type)); };
  $('#bmTextBtn').onclick = async () => {
    const t = $('#bmText').value; if (!t.trim()) return toast('Type or paste some text first');
    const ids = chosen().map((d) => d.id);
    const r = await post(`/api/beam/text?to=${encodeURIComponent(ids.join(','))}`, t);
    if (r.ok) { $('#bmText').value = ''; toast(`Text ready for ${label(ids)}`); load(); } else toast("Couldn't add the text");
  };
  $('#bmFolder').onclick = () => post('/api/beam/reveal');

  // ---------- folders on the phone (Files app): Beam always, plus the ones added here
  function paintFolders(f) {
    const row = (name, path, removable, missing) => `<div class="file"><span class="ext">${svg('folder')}</span>
      <div class="meta"><div class="n">${esc(name)}</div><div class="s">${missing ? 'Not found on this PC' : esc(path)}</div></div>
      ${removable ? `<button class="ibtn" data-unshare="${esc(path)}" aria-label="Remove">${svg('x')}</button>` : ''}</div>`;
    $('#bmFolders').innerHTML = row('Beam', f.beam, false) + f.list.map((x) => row(x.name, x.path, true, x.missing)).join('');
    root.querySelectorAll('[data-unshare]').forEach((b) => (b.onclick = async () => {
      const r = await post('/api/beam/folders', JSON.stringify({ remove: b.dataset.unshare }));
      if (r.ok) { toast('No longer synced. The copy in Shivo Cloud stays.'); loadFolders(); }
    }));
  }
  const loadFolders = () => fetch('/api/beam/folders').then((r) => r.json()).then(paintFolders).catch(() => {});
  $('#bmAddFolder').onclick = async () => {
    const r = await post('/api/beam/folders', JSON.stringify({ add: true }));
    const j = await r.json().catch(() => ({}));
    if (j.ok) { toast('Added. It syncs to Shivo Cloud in a moment.'); loadFolders(); }
    else if (j.error) toast(j.error);
  };
  loadFolders();
  $('#bmAwake').onchange = async (e) => {
    const r = await post('/api/beam/awake', JSON.stringify({ on: e.target.checked }));
    toast(r.ok ? (e.target.checked ? 'This PC stays available while plugged in' : 'This PC sleeps as usual') : "Couldn't save that");
  };
  // which browser opens links shared from the phone (Safari > Share > Beam / Send to PC)
  fetch('/api/beam/browsers').then((r) => r.json()).then(({ chosen, list }) => {
    const sel = $('#bmBrowser');
    sel.insertAdjacentHTML('beforeend', list.map((b) => `<option value="${esc(b.exe)}">${esc(b.name)}</option>`).join(''));
    sel.value = list.some((b) => b.exe === chosen) ? chosen : '';
    sel.onchange = async () => {
      const r = await post('/api/beam/browser', JSON.stringify({ exe: sel.value }));
      toast(r.ok ? (sel.value ? `Links will open in ${sel.selectedOptions[0].text}` : 'Links will open in your default browser') : "Couldn't save that");
    };
  }).catch(() => {});

  // Ctrl+V: files and whole folders copied in Explorer (the hub reads Windows' clipboard, so folders and big files work);
  // a copied picture (e.g. a screenshot) comes from the page's own clipboard instead
  async function onPaste(e) {
    if (e.target.closest?.('input, textarea, [contenteditable="plaintext-only"]')) return;
    const own = [...(e.clipboardData?.files || [])];
    e.preventDefault();
    sending++; busy();
    let n = 0;
    const ids = chosen().map((d) => d.id);
    try { n = (await (await post(`/api/beam/paste?to=${encodeURIComponent(ids.join(','))}`)).json()).count || 0; } catch {}
    sending--; busy();
    if (n) { toast(`${n} item${n > 1 ? 's' : ''} ready for ${label(ids)}.`); load(); }
    else if (own.length) sendFiles(own);
    else toast('Copy files or folders first (select them, Ctrl+C), then press Ctrl+V here');
  }
  document.addEventListener('paste', onPaste);

  load(); timer = setInterval(load, 3000);
  return () => { clearInterval(timer); document.removeEventListener('paste', onPaste); };  // called when leaving the page
}
