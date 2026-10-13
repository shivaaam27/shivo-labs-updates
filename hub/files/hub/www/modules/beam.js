// Beam's PC screen inside the hub: send files and text to the iPhone, see what came in, set up an iPhone.
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

export function mountBeam(root, { esc, toast, openModule }) {
  let st = null, pairMode = 'shortcut', timer = 0, sending = 0;
  root.innerHTML = `
    <div class="bm-grid">
      <div class="bm-col">
        <label class="bm-drop card" id="bmDrop">
          <input type="file" id="bmPick" multiple hidden>
          <span class="mod-ic">${svg('up')}</span>
          <b id="bmDropT">Drop files to send to iPhone</b><small id="bmDropS">or click to choose · or copy files and press Ctrl+V here</small>
        </label>
        <div class="card bm-card">
          <div class="bm-h"><h2>Waiting for iPhone</h2><span class="count" id="bmCount"></span></div>
          <div id="bmWaiting"></div>
          <details class="bm-more"><summary>${svg('text')}Send text instead</summary>
            <textarea id="bmText" placeholder="Paste or type text for the iPhone"></textarea>
            <button class="btn sm" id="bmTextBtn">Send text</button></details>
        </div>
        <div class="card bm-card">
          <div class="bm-h"><h2>Received</h2><button class="tbtn" id="bmFolder">${svg('folder')}Open folder</button></div>
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
    if (pill) pill.innerHTML = st.running ? `<i class="dot"></i>${esc(st.host)}` : `<button class="tbtn" id="bmStart">Start Beam</button>`;
    document.getElementById('bmStart')?.addEventListener('click', () => openModule('beam', true));
    $('#bmCount').textContent = st.waiting.length || '';
    $('#bmWaiting').innerHTML = st.waiting.length
      ? st.waiting.map((f) => `<div class="file${isImg(f.name) ? ' img' : ''}"><span class="ext">${esc(ext(f.name))}</span><div class="meta"><div class="n">${esc(f.name)}</div><div class="s">${size(f.size)} · ${ago(f.at)}</div></div><button class="ibtn" data-rm="${esc(f.name)}" aria-label="Remove">${svg('x')}</button></div>`).join('')
        + `<p class="bm-tip">On the iPhone, run <b>Get from PC</b> or open the Beam page.</p>`
      : `<p class="emptyt">Nothing waiting. Files you drop here wait until the iPhone collects them.</p>`;
    root.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { await post(`/api/beam/remove?name=${encodeURIComponent(b.dataset.rm)}`); load(); }));
    $('#bmReceived').innerHTML = st.received.length
      ? st.received.map((f) => `<button class="file${isImg(f.name) ? ' img' : ''}" data-rv="${esc(f.name)}"><span class="ext">${esc(ext(f.name))}</span><div class="meta"><div class="n">${esc(f.name)}</div><div class="s">${size(f.size)} · ${ago(f.at)}</div></div></button>`).join('')
      : `<p class="emptyt">From iPhone: Share, then Send to PC. Files land in Downloads\\Beam.</p>`;
    root.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = () => post(`/api/beam/reveal?name=${encodeURIComponent(b.dataset.rv)}`)));
    paintPair();
  }
  function paintPair() {
    const url = pairMode === 'shortcut' ? st.shortcut : pairMode === 'web' ? st.web : st.webIp;
    const steps = pairMode === 'shortcut'
      ? ['Point the iPhone Camera at this code and tap the link.', 'Tap <b>Add Shortcut</b>.', 'Share anything, then <b>Send to PC</b>. The first time, click Accept on the PC.']
      : ['Point the iPhone Camera at this code and tap the link.', 'In Safari, tap Share, then <b>Add to Home Screen</b>.', 'Open Beam on the iPhone to send and receive.'];
    if (url) { const q = qrcode(0, 'M'); q.addData(url); q.make(); $('#bmQr').innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); }
    else $('#bmQr').innerHTML = '<p class="emptyt">Start Beam once to make the link.</p>';
    $('#bmSteps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
    $('#bmNote').innerHTML = `iPhone and PC need the same network: home Wi-Fi or the iPhone's Personal Hotspot. No internet needed.${pairMode === 'web' ? ' <button class="tbtn" id="bmIp">Link won\'t open? Use the IP address</button>' : ''}${st.trusted ? ` ${st.trusted} iPhone${st.trusted > 1 ? 's' : ''} trusted.` : ''}`;
    $('#bmIp')?.addEventListener('click', () => { pairMode = 'web-ip'; paintPair(); });
  }
  $('#bmSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; pairMode = b.dataset.m; root.querySelectorAll('#bmSeg button').forEach((x) => x.classList.toggle('on', x === b)); st && paintPair(); };

  // ---------- sending
  async function sendFiles(list) {
    if (!list.length) return;
    sending += list.length; busy();
    let ok = 0;
    for (const f of list) {
      try { const r = await post(`/api/beam/send?name=${encodeURIComponent(f.name)}`, f); if (r.ok) ok++; } catch {}
      sending--; busy();
    }
    toast(ok === list.length ? `${ok} item${ok > 1 ? 's' : ''} ready. On iPhone run "Get from PC".` : `${list.length - ok} couldn't be added`);
    load();
  }
  function busy() {
    $('#bmDrop').classList.toggle('busy', sending > 0);
    $('#bmDropT').textContent = sending ? `Preparing ${sending} item${sending > 1 ? 's' : ''}…` : 'Drop files to send to iPhone';
    $('#bmDropS').textContent = sending ? '' : 'or click to choose · or copy files and press Ctrl+V here';
  }
  const drop = $('#bmDrop');
  $('#bmPick').onchange = (e) => { sendFiles([...e.target.files]); e.target.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); sendFiles([...e.dataTransfer.files].filter((f) => f.size || f.type)); };
  $('#bmTextBtn').onclick = async () => {
    const t = $('#bmText').value; if (!t.trim()) return toast('Type or paste some text first');
    const r = await post('/api/beam/text', t);
    if (r.ok) { $('#bmText').value = ''; toast('Text ready for iPhone'); load(); } else toast("Couldn't add the text");
  };
  $('#bmFolder').onclick = () => post('/api/beam/reveal');

  // Ctrl+V: files and whole folders copied in Explorer (the hub reads Windows' clipboard, so folders and big files work);
  // a copied picture (e.g. a screenshot) comes from the page's own clipboard instead
  async function onPaste(e) {
    if (e.target.closest?.('input, textarea')) return;
    const own = [...(e.clipboardData?.files || [])];
    e.preventDefault();
    sending++; busy();
    let n = 0;
    try { n = (await (await post('/api/beam/paste')).json()).count || 0; } catch {}
    sending--; busy();
    if (n) { toast(`${n} item${n > 1 ? 's' : ''} ready. On iPhone run "Get from PC".`); load(); }
    else if (own.length) sendFiles(own);
    else toast('Copy files or folders first (select them, Ctrl+C), then press Ctrl+V here');
  }
  document.addEventListener('paste', onPaste);

  load(); timer = setInterval(load, 3000);
  return () => { clearInterval(timer); document.removeEventListener('paste', onPaste); };  // called when leaving the page
}
