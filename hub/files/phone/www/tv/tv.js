// TV inside the phone app: use a TV that runs the Shivo Labs home screen, over the shared Wi-Fi.
// The TV app answers on port 8799 (tv/home/src/labs/shivo/tv/Remote.java). The first time, the phone asks the TV
// for a code, the TV shows 6 digits on screen and the person types them here; the phone then gets its own key
// (kept on this phone, sent as ?k=). From any other network: on the TV, Settings › Connect a phone shows a 6-letter
// code; typed here it goes through the relay (/c/<CODE>/pair/far) and the TV gives this phone its key the same way.
// Away from home (mobile data, another Wi-Fi) the phone goes through our relay on Cloudflare (tv/relay): the TV keeps
// a link open to it, and the TV still checks this phone's key itself. The TV gives its relay address at pairing and
// in /hello; the phone tries the TV directly first and uses the relay only when that fails.
// What works: what is playing (pause, play, skip), volume and mute, Home, your apps (open them on the TV), the TV's
// rows (YouTube's picks...), inputs. The full remote (arrows, OK, Back, typing) needs the next app build.
// Layout: one column on a phone; on an iPad or any wide screen the controls sit on the left, the content on the right.
import { deviceName } from '../engine/beam.js';
import * as atv from './atvremote.js';

const PORT = 8799;
const RELAY = 'https://shivo-tv-relay-test.ishivamparmar.workers.dev';   // tv/relay; finds the TV by this phone's key fingerprint
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  tv: svg('<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M12 17v4"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
  pause: svg('<path d="M8 5.5v13M16 5.5v13"/>'),
  next: svg('<path d="M6 6l8 6-8 6zM18 6v12"/>'),
  prev: svg('<path d="M18 6l-8 6 8 6zM6 6v12"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  home: svg('<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>'),
  vol: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/>'),
  mute: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  hdmi: svg('<path d="M4 8h16v5l-2 3H6l-2-3z"/><path d="M8 11h8"/>'),
  input: svg('<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M12 17v4"/>'),
  phone: svg('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  remote: svg('<rect x="7" y="2.5" width="10" height="19" rx="5"/><circle cx="12" cy="8" r="2"/><path d="M10 14h4M10 17h4"/>'),
  back: svg('<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>'),
  playpause: svg('<path d="M5 6v12l7-6zM15 6v12M19 6v12"/>'),
  pointer: svg('<path d="M5 3.5l13 6.2-5.6 1.7-1.7 5.6z"/><path d="M12.6 12.6l5.4 5.4"/>'),
  kbd: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'), down: svg('<path d="M6 9l6 6 6-6"/>'), left: svg('<path d="M15 6l-6 6 6 6"/>'), right: svg('<path d="M9 6l6 6-6 6"/>'),
  wifi: svg('<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.2" r=".9"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
  picture: svg('<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M7 14l3-3.5 2.5 2.5 2-2L17 14M8 21h8"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>'),
};
// the big services whose rows are worth showing (no rows from the apps the TV maker put on)
const BIG = [/youtube/, /netflix/, /amazonvideo/, /disneyplus/, /showmax/, /spotify/, /apple\.atve/, /hbo|\.max\b/, /google\.android\.videos/];
const HIDE = /tvlauncher|launcherx|setupwraith|com\.android\.vending|tcl\.settings|tclhome_passive|webview_shell|android\.tv\.settings/;

export function mountTv(root, { toast = () => {}, haptic = () => {} } = {}) {
  const buzz = (k = 'light') => { try { haptic(k); } catch {} };
  let tvs = []; try { tvs = JSON.parse(localStorage.getItem('sl.tv') || '[]'); } catch {}
  const save = () => { try { localStorage.setItem('sl.tv', JSON.stringify(tvs)); } catch {} };
  let cur = tvs[0] || null, apps = [], now = [], shelves = [], inputs = [], hist = [], dev = {}, timer = 0, alive = false, pairing = null;
  let tab = 'foryou';
  try { tab = localStorage.getItem('sl.tvTab') || 'foryou'; } catch {}
  const blobs = new Map();   // pictures fetched from the TV, kept while the app is open
  // what the TV had the last time it answered, so the screen still opens (and can be looked through) with no connection
  const cacheKey = () => cur?.host || cur?.kh || '';
  const readCache = () => { try { return (JSON.parse(localStorage.getItem('sl.tvcache') || '{}'))[cacheKey()] || null; } catch { return null; } };
  const writeCache = () => { try { const all = JSON.parse(localStorage.getItem('sl.tvcache') || '{}'); all[cacheKey()] = { apps, dev, shelves, inputs, hist }; localStorage.setItem('sl.tvcache', JSON.stringify(all)); } catch {} };
  const dropCache = (host) => { try { const all = JSON.parse(localStorage.getItem('sl.tvcache') || '{}'); delete all[host]; localStorage.setItem('sl.tvcache', JSON.stringify(all)); } catch {} };
  let offline = '';   // why the TV can't be reached right now ('' = connected)

  let away = false, lastHome = 0;   // away: going through the relay; lastHome: when the TV was last tried directly
  // the owner's first name, from this phone's name in Shivo Labs ("Shivam's iPhone" -> Shivam): the TV greets them
  const firstName = () => {
    const n = (deviceName() || '').trim(), m = n.match(/^(.+?)['’]s\b/);
    const f = m ? m[1] : /^(my |the )?(iphone|ipad|android|phone|galaxy|pixel)\b/i.test(n) ? '' : n.split(/\s+/)[0];
    return (f || '').slice(0, 24);
  };
  const qs = (q) => new URLSearchParams({ ...q, ...(cur?.key ? { k: cur.key } : {}), ...(cur?.key && firstName() ? { n: firstName() } : {}) });
  const url = (host, path, q = {}) => `http://${host}:${PORT}${path}?${qs(q)}`;
  const relayUrl = (path, q = {}) => `${cur.relay || `${RELAY}/k/${cur.kh}`}${path}?${qs(q)}`;
  const hasRelay = () => !!(cur?.relay || cur?.kh);
  const base = (path, q) => away && hasRelay() ? relayUrl(path, q) : url(cur.host, path, q);
  async function get(u, ms, post) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(u, { method: post ? 'POST' : 'GET', signal: ctl.signal, cache: 'no-store' }); }
    finally { clearTimeout(t); }
  }
  async function call(path, q = {}, { host, ms = 6000, post = false } = {}) {
    let r = null;
    if (host) r = await get(url(host, path, q), ms, post).catch(() => null);   // pairing: only ever on the Wi-Fi
    else {
      // at home: straight to the TV; away: the relay, with a quick look every half minute whether the TV is near again
      const tryHome = !away || !hasRelay() || Date.now() - lastHome > 30000;
      if (tryHome) { lastHome = Date.now(); r = await get(url(cur.host, path, q), away ? 1500 : Math.min(ms, hasRelay() ? 2500 : ms), post).catch(() => null); }
      if (r) { if (away) { away = false; paintWhere(); } }
      else if (hasRelay()) { r = await get(relayUrl(path, q), ms + 4000, post).catch(() => null); if (r && r.status !== 503 && !away) { away = true; paintWhere(); } }
    }
    if (!r) throw new Error(hasRelay() && !host ? "Can't reach the TV. Check it is on and has internet." : "Can't reach the TV. Check it is on, showing Shivo Labs, and on the same Wi-Fi as this phone.");
    if (r.status === 401) throw Object.assign(new Error('This phone is no longer paired with the TV. Pair it again.'), { unpaired: true });
    if (r.status === 503) throw new Error('The TV is off or has no internet right now.');
    return await r.json();
  }
  // where the phone reaches the TV from, under the TV's name
  const whereText = () => offline ? 'Not connected' : away ? 'Connected from anywhere' : `Connected · ${cur.host}`;
  function paintWhere() {
    const w = root.querySelector('#tvWhere'); if (w) w.textContent = whereText();
    const box = root.querySelector('#tvRemote'); if (box) { box.innerHTML = remoteHtml(); wireRemote(); }
  }
  // the relay address, for phones paired before the relay existed (the TV gives it to a paired phone in /hello)
  async function learnRelay() {
    if (!cur || away) return;
    try {
      const hi = await call('/hello', {}, { ms: 3000 });
      if (hi.relay && hi.relay !== cur.relay) { cur.relay = hi.relay; tvs = [cur, ...tvs.filter((t) => t.host !== cur.host)]; save(); }
    } catch {}
  }
  // the TV's pictures, fetched with the key and shown from memory
  async function pic(img) {
    const path = img.dataset.tvpic;
    if (blobs.has(path)) { img.src = blobs.get(path); return; }
    try {
      let r = await fetch(base(path), { cache: 'force-cache' }).catch(() => null);
      if (!r && !away && hasRelay()) r = await fetch(relayUrl(path), { cache: 'force-cache' }).catch(() => null);
      if (!r || !r.ok) throw 0;
      const u = URL.createObjectURL(await r.blob()); blobs.set(path, u); img.src = u;
    } catch { img.dispatchEvent(new Event('error')); }
  }
  const pics = () => root.querySelectorAll('img[data-tvpic]:not([src])').forEach(pic);
  const web = (a) => /^https?:/.test(a || '') ? a : '';
  const label = (pkg) => apps.find((a) => a.pkg === pkg)?.label || '';
  // what was watched, newest first; a YouTube video has its own thumbnail and resumes at the same point
  const watched = () => hist.filter((h) => apps.some((a) => a.pkg === h.pkg)).slice(0, 10);
  const histPic = (h) => h.vid ? `<img src="https://i.ytimg.com/vi/${esc(h.vid)}/mqdefault.jpg" alt="" loading="lazy">`
    : `<img data-tvpic="/${h.art && h.art.startsWith('np/') ? esc(h.art) : `banner/${esc(h.pkg)}`}" alt="" onerror="this.remove()">`;
  const pct = (h) => h.len > 0 ? Math.min(100, Math.round(100 * h.pos / h.len)) : 0;
  function resume(h) {
    if (!h) return;
    const url = h.vid ? `https://www.youtube.com/watch?v=${h.vid}${h.pos > 30000 ? `&t=${Math.floor(h.pos / 1000)}s` : ''}` : '';
    (url ? act('/openIn', { a: h.pkg, b: url }, 'Continuing on the TV') : act('/open', { a: h.pkg }, 'Opening on the TV')).then(() => setTimeout(pollNow, 2500));
  }

  // ---- TVs found on the Wi-Fi (our TV app, or any Google TV for the remote), by address ----
  const found = new Map();
  let stopFind = null;
  let scanning = false;
  const addFound = (host, name) => {
    found.set(host, { ...(found.get(host) || {}), host, name, shivo: true });
    const list = root.querySelector('#tvFound'); if (list) list.innerHTML = foundHtml();
    wireFound();
  };
  async function knock() {
    if (scanning) return;
    scanning = true;
    // the networks to try: where TVs were before, then the ones home routers use most (incl. 4G routers and hotspots)
    const nets = [...new Set([...tvs.map((t) => t.host.split('.').slice(0, 3).join('.')),
      '192.168.1', '192.168.0', '192.168.8', '192.168.100', '10.0.0', '192.168.2', '192.168.43', '192.168.88', '10.0.1', '192.168.10', '172.20.10'])];
    const hello = async (host) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1100);
      try { const r = await fetch(`http://${host}:${PORT}/hello`, { signal: ctl.signal, cache: 'no-store' }); const j = await r.json(); if (j.app === 'shivo-tv') addFound(host, j.name); } catch {} finally { clearTimeout(t); }
    };
    for (const net of nets) {
      if (!scanning || pairing || !root.querySelector('#tvFound')) break;
      for (let a = 1; a < 255; a += 64) await Promise.all(Array.from({ length: Math.min(64, 255 - a) }, (_, i) => hello(`${net}.${a + i}`)));
      if ([...found.values()].some((t) => t.shivo)) break;
    }
    scanning = false;
    if (![...found.values()].some((t) => t.shivo) && !pairing) { lookedLong = true; const l = root.querySelector('#tvFound'); if (l) l.innerHTML = foundHtml(); root.querySelector('#tvHost')?.classList.add('tvp-hi'); }
  }
  async function findTvs() {
    knock();
    if (stopFind) return;
    stopFind = await atv.browse((s) => {
      const t = found.get(s.host) || { host: s.host, name: s.name, shivo: false, google: false };
      if (/shivotv/.test(s.type)) { t.shivo = true; t.name = s.name.replace(/^Shivo Labs on /, ''); } else { t.google = true; if (!t.shivo) t.name = s.name; }
      found.set(s.host, t);
      const list = root.querySelector('#tvFound'); if (list) list.innerHTML = foundHtml();
      wireFound();
    });
  }
  let lookedLong = false, cellular = false;
  // pairing needs the TV's Wi-Fi (once): on mobile data, say so instead of looking forever
  async function checkNet() {
    try {
      const st = await window.Capacitor?.Plugins?.Network?.getStatus();
      const c = !!st && st.connectionType !== 'wifi' && st.connectionType !== 'unknown';
      if (c !== cellular) { cellular = c; const list = root.querySelector('#tvFound'); if (list) { list.innerHTML = foundHtml(); wireFound(); } }
    } catch {}
  }
  const foundHtml = () => cellular && !found.size ? `<div class="tvp-help"><b>This phone is on mobile data</b>
      <p>On the TV, open Shivo Labs › Settings › <em>Connect a phone</em>. Type the code it shows below.</p></div>`
    : [...found.values()].filter((t) => t.shivo).map((t) => `<button class="tvp-tvrow" data-host="${esc(t.host)}">${IC.tv}<span><b>${esc(t.name)}</b><small>${esc(t.host)}</small></span>${IC.right}</button>`).join('')
    || (!lookedLong ? `<p class="tvp-looking">${IC.wifi}Looking for TVs on your Wi-Fi…</p>`
      // nothing found after a while: almost always the iPhone's Local Network switch, or another Wi-Fi
      : `<div class="tvp-help"><b>No TV found yet</b>
          <p>On this iPhone: <em>Settings › Privacy &amp; Security › Local Network</em>, turn <em>Shivo Labs</em> on.</p>
          <p>Check the phone is on the same Wi-Fi as the TV (not mobile data or a guest network).</p>
          <p>Or type the TV's address below. On the TV it's in <em>Shivo Labs › Settings › This TV</em>.</p></div>`);
  function wireFound() {
    root.querySelectorAll('[data-host]').forEach((b) => (b.onclick = () => { const f = root.querySelector('#tvHost'); if (f) { f.value = b.dataset.host; root.querySelector('#tvStart').click(); } }));
  }

  const paintPairErr = (m) => { const e = root.querySelector('#tvErr'); if (e) { e.textContent = m; e.hidden = false; } };
  // ---- not paired yet ----
  function paintPair(err = '') {
    root.innerHTML = `<div class="tvp">
      <div class="tvp-art"><span class="tvp-tv">${IC.tv}</span><span class="tvp-ph">${IC.phone}</span></div>
      <h2 class="tvp-h">${pairing ? 'Type the code on your TV' : 'Connect your TV'}</h2>
      <p class="tvp-p">${pairing ? `${esc(pairing.name)} is showing a 6-digit code now.` : 'Use your Shivo Labs TV from here: what is playing, the volume, your apps.'}</p>
      ${pairing ? `
        <input class="tvp-code" id="tvCode" inputmode="numeric" maxlength="7" placeholder="000000" autocomplete="one-time-code">
        <button class="btn pri tvp-btn" id="tvFinish">Pair</button>
        <button class="tvp-link" id="tvBack">Get a new code</button>`
      : `
        <div class="tvp-found" id="tvFound">${foundHtml()}</div>
        <section class="tvp-far">
          <b>Use a code from the TV</b>
          <small>Works on Wi-Fi or mobile data. On the TV: Shivo Labs › Settings › Connect a phone.</small>
          <input class="tvp-code" id="tvFar" maxlength="7" autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck="false" placeholder="ABC 123">
          <button class="btn pri tvp-btn" id="tvFarGo">Connect</button>
        </section>
        <p class="tvp-or">Or type the TV's address (same Wi-Fi):</p>
        <ol class="tvp-steps" hidden>
          <li><b>1</b><span>On the TV, open the Shivo Labs home screen.</span></li>
          <li><b>2</b><span>Find its address in <em>Settings › This TV</em>. It looks like 192.168.1.9.</span></li>
          <li><b>3</b><span>Type it here. The TV then shows a code.</span></li>
        </ol>
        <input class="field tvp-host" id="tvHost" type="text" inputmode="url" placeholder="192.168.1.9" value="${esc(cur?.host || '')}" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="btn pri tvp-btn" id="tvStart">Show the code on the TV</button>`}
      <p class="tvp-err" id="tvErr" ${err ? '' : 'hidden'}>${esc(err)}</p>
      <p class="tvp-foot">Pair once on the TV's Wi-Fi (the code on the TV screen means only someone in the room can pair). After that it works from anywhere.</p>
    </div>`;
    wireFound();
    if (!pairing) checkNet();
    const farGo = root.querySelector('#tvFarGo');
    if (farGo) {
      const far = root.querySelector('#tvFar');
      const go = async () => {
        if (farGo.disabled) return;
        const c = far.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (c.length !== 6) return toast('The code on the TV has 6 letters and numbers');
        farGo.disabled = true; farGo.textContent = 'Connecting…';
        try {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
          const r = await fetch(`${RELAY}/c/${c}/pair/far?${new URLSearchParams({ a: deviceName() || 'A phone' })}`, { method: 'POST', signal: ctl.signal, cache: 'no-store' })
            .finally(() => clearTimeout(t)).catch(() => { throw new Error("Can't reach the internet. Check this phone's connection."); });
          const j = await r.json().catch(() => ({}));
          if (!j.ok) throw new Error(j.error || (r.status === 503 ? 'The TV is off or has no internet right now.' : 'That did not work. Show a new code on the TV.'));
          cur = { host: j.host || '', key: j.key, name: j.name || 'TV', relay: j.relay || '' }; away = false;
          tvs = [cur, ...tvs.filter((x) => x.host !== cur.host || !cur.host)]; save();
          buzz('success'); toast('Connected to ' + cur.name); await refresh(true); autoRemote().then(() => paintWhere()).catch(() => {});
        } catch (e) { farGo.disabled = false; farGo.textContent = 'Connect'; paintPairErr(e.message); }
      };
      farGo.onclick = go;
      far.oninput = () => { const v = far.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); far.value = v.length > 3 ? v.slice(0, 3) + ' ' + v.slice(3, 6) : v; if (v.length === 6) go(); };
      far.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    }
    if (!pairing) {
      findTvs();   // when nothing turns up, knock() says why and brings the address field forward
    }
    const startBtn = root.querySelector('#tvStart');
    if (startBtn) {
      const go = async () => {
        const host = root.querySelector('#tvHost').value.trim().replace(/[,\s]+/g, '.').replace(/\.{2,}/g, '.').replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
        if (!host) return toast("Type the TV's address first");
        startBtn.disabled = true; startBtn.textContent = 'Asking the TV…';
        try {
          const hi = await call('/hello', {}, { host, ms: 5000 });
          if (hi.app !== 'shivo-tv') throw new Error('That address is not a TV with Shivo Labs.');
          await call('/pair/start', { a: deviceName() || 'A phone' }, { host, post: true });
          pairing = { host, name: hi.name }; buzz(); paintPair();
          setTimeout(() => root.querySelector('#tvCode')?.focus(), 250);
        } catch (e) { paintPair(e.message); }
      };
      startBtn.onclick = go;
      root.querySelector('#tvHost').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    }
    const fin = root.querySelector('#tvFinish');
    if (fin) {
      const go = async () => {
        const code = root.querySelector('#tvCode').value.replace(/\D/g, '');
        if (code.length !== 6) return toast('The code has 6 digits');
        fin.disabled = true; fin.textContent = 'Pairing…';
        try {
          const r = await call('/pair/finish', { a: code }, { host: pairing.host, post: true });
          if (!r.ok) throw new Error(r.error || 'Pairing failed');
          cur = { host: pairing.host, key: r.key, name: pairing.name, relay: r.relay || '' }; away = false;
          tvs = [cur, ...tvs.filter((t) => t.host !== cur.host)]; save();
          pairing = null; buzz('success'); toast('Paired with ' + cur.name); await refresh(true); autoRemote().then(() => paintWhere()).catch(() => {});
        } catch (e) { paintPair(e.message); }
      };
      fin.onclick = go;
      const ci = root.querySelector('#tvCode');
      ci.oninput = () => { if (ci.value.replace(/\D/g, '').length === 6) go(); };
      ci.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      root.querySelector('#tvBack').onclick = async () => { const h = pairing.host; pairing = null; paintPair(); root.querySelector('#tvHost').value = h; root.querySelector('#tvStart').click(); };
    }
  }

  // ---- paired ----
  const rowsOf = () => shelves.filter((r) => BIG.some((re) => re.test(r.pkg)))
    .map((r) => ({ ...r, items: r.items.filter((i) => i.title && i.title.trim()) })).filter((r) => r.items.length > 1)
    .sort((a, b) => (/youtube/.test(b.pkg) ? 1 : 0) - (/youtube/.test(a.pkg) ? 1 : 0));
  // the big services first (in the order of BIG), then TV apps, then the rest; A to Z within each
  const rank = (a) => { const i = BIG.findIndex((re) => re.test(a.pkg)); return i >= 0 ? i : a.tv ? 50 : 60; };
  const appList = () => apps.filter((a) => !HIDE.test(a.pkg)).sort((a, b) => (rank(a) - rank(b)) || a.label.localeCompare(b.label));
  const playing = () => now.filter((p) => apps.some((a) => a.pkg === p.pkg));

  function nowHtml() {
    const p = playing()[0];
    if (!p) {
      const h = watched()[0];
      if (!h) return `<section class="tvx-now empty"><span class="tvx-now-ic">${IC.remote}</span>
        <div><b>Nothing playing</b><small>Open an app or a video below and it plays on the TV.</small></div></section>`;
      return `<section class="tvx-now">
        <div class="tvx-now-art">${histPic(h).replace('mqdefault', 'hq720').replace('loading="lazy"', `onerror="if(this.src.includes('hq720'))this.src=this.src.replace('hq720','mqdefault')"`)}<i></i>
          <div class="tvx-now-t"><small>Continue watching · ${esc(label(h.pkg))}</small><b>${esc(h.title)}</b>${h.sub ? `<span>${esc(h.sub)}</span>` : ''}</div></div>
        ${pct(h) ? `<div class="tvx-track"><i style="width:${pct(h)}%"></i></div>` : ''}
        <div class="tvx-now-b"><button class="btn pri tvx-cont" data-resume="0">${IC.play}Continue on the TV</button></div>
      </section>`;
    }
    const done = pct(p);
    return `<section class="tvx-now">
      <div class="tvx-now-art">${p.art ? `<img data-tvpic="/${esc(p.art.split('?')[0])}" alt="">` : `<img class="ic" data-tvpic="/icon/${esc(p.pkg)}" alt="">`}<i></i>
        <div class="tvx-now-t"><small>${p.playing ? 'Playing' : 'Paused'} on the TV · ${esc(label(p.pkg))}</small><b>${esc(p.title)}</b>${p.sub ? `<span>${esc(p.sub)}</span>` : ''}</div></div>
      ${done ? `<div class="tvx-track"><i style="width:${done}%"></i></div>` : ''}
      <div class="tvx-now-b">
        <button class="tvx-btn" data-media="prev" aria-label="Previous">${IC.prev}</button>
        <button class="tvx-btn big" data-media="${p.playing ? 'pause' : 'play'}" aria-label="${p.playing ? 'Pause' : 'Play'}">${p.playing ? IC.pause : IC.play}</button>
        <button class="tvx-btn" data-media="next" aria-label="Next">${IC.next}</button></div>
    </section>`;
  }
  function contentHtml() {
    if (tab === 'apps') {
      return `<div class="tvx-apps">${appList().map((a) => `<button class="tvx-app${a.banner ? '' : ' ic'}" data-open="${esc(a.pkg)}">
        <span class="tvx-app-p">${a.banner ? `<img data-tvpic="/banner/${esc(a.pkg)}" alt="" onerror="this.closest('.tvx-app').classList.add('ic');this.remove()">` : ''}<img class="tvx-app-i" data-tvpic="/icon/${esc(a.pkg)}" alt="" onerror="this.remove()"></span>
        <span class="tvx-app-l">${esc(a.label)}</span></button>`).join('')}</div>`;
    }
    if (tab === 'more') {
      const sc = (attr, ic, t, s) => `<button class="tvx-input" ${attr}><span>${ic}</span><b>${t}</b><small>${s}</small></button>`;
      return `<h3 class="tvx-h">On the TV</h3><div class="tvx-inputs">
        ${sc('data-code', IC.phone, 'Add a phone', 'A code for someone else’s phone')}
        ${sc('data-shivo="settings"', IC.tv, 'Shivo Labs settings', 'Our settings on the TV')}
        ${sc('data-dream', IC.moon, 'Screensaver', 'Start it now')}
        ${sc('data-shivo="apps"', IC.grid, 'All apps', 'The apps page on the TV')}</div>
        <h3 class="tvx-h">TV settings</h3><div class="tvx-inputs">
        ${sc('data-setting="display"', IC.picture, 'Picture', 'Mode, resolution')}
        ${sc('data-setting="sound"', IC.vol, 'Sound', 'Mode, output')}
        ${sc('data-setting="network"', IC.wifi, 'Network', 'Wi-Fi, internet')}
        ${sc('data-setting="bluetooth"', IC.remote, 'Remotes', 'Bluetooth')}
        ${sc('data-setting="all"', IC.gear, 'All settings', 'Everything else')}</div>
        <div id="tvCodeBox"></div>`;
    }
    if (tab === 'inputs') {
      return inputs.length ? `<div class="tvx-inputs">${inputs.map((x) => `<button class="tvx-input" data-input="${esc(x.id)}"><span>${/hdmi/i.test(x.label) ? IC.hdmi : IC.input}</span><b>${esc(x.label)}</b><small>Switch the TV to this</small></button>`).join('')}</div>`
        : '<p class="tvx-none">This TV has no inputs to switch to.</p>';
    }
    const rows = rowsOf(), w = watched();
    const contHtml = w.length ? `<h3 class="tvx-h">Continue watching</h3>
      <div class="tvx-strip">${w.map((h, i) => `<button class="tvx-thumb" data-resume="${i}"><span class="tvx-thumb-p">${histPic(h)}${pct(h) ? `<i class="tvx-thumb-bar"><i style="width:${pct(h)}%"></i></i>` : ''}</span>
        <b>${esc(h.title)}</b><small class="tvx-thumb-s">${esc(label(h.pkg))}</small></button>`).join('')}</div>` : '';
    if (!rows.length && w.length) return contHtml;
    if (!rows.length) return '<p class="tvx-none">Nothing to suggest yet. Apps like YouTube fill this in once they have been opened on the TV.</p>';
    return contHtml + rows.map((r) => `<h3 class="tvx-h">${esc(label(r.pkg))}<span>${esc(r.name)}</span></h3>
      <div class="tvx-strip">${r.items.slice(0, 14).map((it) => `<button class="tvx-thumb" data-uri="${esc(it.uri || '')}" data-pkg="${esc(r.pkg)}">
        <span class="tvx-thumb-p">${web(it.art) ? `<img src="${esc(web(it.art))}" alt="" loading="lazy">` : ''}</span><b>${esc(it.title)}</b></button>`).join('')}</div>`).join('');
  }
  function paint() {
    const v = dev.volMax ? Math.round(100 * dev.vol / dev.volMax) : 0;
    root.innerHTML = `<div class="tvx">
      <aside class="tvx-side">
        <section class="tvx-tv"><span class="tvx-tv-ic">${IC.tv}</span>
          <div><b>${esc(cur.name || 'TV')}</b><small><i class="dot${offline ? ' wait' : ''}"></i><span id="tvWhere">${esc(whereText())}</span></small></div></section>
        <div id="tvNow">${nowHtml()}</div>
        <section class="tvx-ctl">
          <div class="tvx-vol">
            <button class="tvx-btn" data-vol="-1" aria-label="Quieter">${IC.minus}</button>
            <div class="tvx-vol-m"><div class="tvx-vol-top"><span>${dev.muted ? IC.mute : IC.vol}</span><b id="tvVolN">${dev.vol ?? '–'}</b></div><div class="tvx-track"><i id="tvVolBar" style="width:${v}%"></i></div></div>
            <button class="tvx-btn" data-vol="1" aria-label="Louder">${IC.plus}</button>
          </div>
          <div class="tvx-quick">
            <button class="tvx-q" id="tvHome">${IC.home}<span>Home</span></button>
            <button class="tvx-q" id="tvMute">${IC.mute}<span>Mute</span></button>
            <button class="tvx-q" id="tvInputs">${IC.hdmi}<span>Inputs</span></button>
          </div>
        </section>
        <div id="tvRemote">${remoteHtml()}</div>
      </aside>
      <main class="tvx-main">
        ${offline ? `<div class="tvx-offline"><span>${IC.wifi}</span><div><b>Not connected to ${esc(cur.name || 'the TV')}</b><small>${esc(offline)} Showing what it had last time.</small></div><button class="btn sm" id="tvRetry">Try again</button></div>` : ''}
        <div class="seg tvx-seg">${[['foryou', 'For you'], ['apps', 'Apps'], ['inputs', 'Inputs'], ['more', 'Shortcuts']].map(([id, n]) => `<button data-tab="${id}" class="${tab === id ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="tvx-content" id="tvContent">${contentHtml()}</div>
        <button class="tvx-forget" id="tvForget">Forget this TV</button>
      </main>
    </div>`;
    wire();
    root.querySelector('#tvRetry')?.addEventListener('click', () => refresh(true));
    pics();
  }
  // ---- the full remote ----
  let rc = null, rcBusy = null, rcPair = null;
  function remoteHtml() {
    if (away) return `<section class="tvx-ctl tvx-remote"><div class="tvx-rrow">
        <button class="tvx-q" data-k="back">${IC.back}<span>Back</span></button><button class="tvx-q" data-k="home">${IC.home}<span>Home</span></button></div>
        <small class="tvx-fine">Arrows, typing and the pointer work at home, on the TV's Wi-Fi.</small></section>`;
    if (!atv.available()) return `<section class="tvx-ctl tvx-remote"><div class="tvx-rrow">
        <button class="tvx-q" data-k="back">${IC.back}<span>Back</span></button><button class="tvx-q" data-k="home">${IC.home}<span>Home</span></button>
        <button class="tvx-q" id="rcPointer">${IC.pointer}<span>Pointer</span></button></div>
        <small class="tvx-fine">Arrows and typing: the full remote in the Shivo Labs phone app.</small></section>`;
    if (rcPair) return `<section class="tvx-ctl tvx-rpair"><b>Type the code on the TV</b><small>The TV shows 6 characters (numbers and A–F).</small>
      <input class="tvp-code tvx-rcode" id="rcCode" maxlength="6" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="A1B2C3">
      <button class="btn pri" id="rcFinish">Pair the remote</button><button class="tvp-link" id="rcCancel">Cancel</button></section>`;
    if (!atv.isPaired(cur.host)) return `<section class="tvx-ctl tvx-rsetup"><span class="tvx-now-ic">${IC.remote}</span>
      <div><b>Full remote</b><small>Arrows, OK, Back and typing, in every app. Set it up once with a code on the TV.</small></div>
      <button class="btn pri" id="rcSetup">Set up the full remote</button></section>`;
    return `<section class="tvx-ctl tvx-remote">
      <div class="tvx-pad">
        <button class="tvx-pk up" data-k="up" aria-label="Up">${IC.up}</button><button class="tvx-pk left" data-k="left" aria-label="Left">${IC.left}</button>
        <button class="tvx-ok" data-k="ok" aria-label="OK">OK</button>
        <button class="tvx-pk right" data-k="right" aria-label="Right">${IC.right}</button><button class="tvx-pk down" data-k="down" aria-label="Down">${IC.down}</button>
      </div>
      <div class="tvx-rrow">
        <button class="tvx-q" data-k="back">${IC.back}<span>Back</span></button>
        <button class="tvx-q" data-k="home">${IC.home}<span>Home</span></button>
        <button class="tvx-q" data-k="playPause">${IC.playpause}<span>Play</span></button>
        <button class="tvx-q" id="rcKbd">${IC.kbd}<span>Type</span></button>
        <button class="tvx-q" id="rcPointer">${IC.pointer}<span>Pointer</span></button>
      </div>
      <form class="tvx-type" id="rcType" hidden><input class="field" id="rcText" placeholder="Type on the TV" autocomplete="off" autocorrect="off"><button class="btn pri sm">Send</button></form>
    </section>`;
  }
  async function remote() {
    if (rc) return rc;
    if (rcBusy) return rcBusy;
    rcBusy = atv.connect(cur.host, { onClose: () => { rc = null; } })
      .then(async (r) => { await r.ready; rc = r; return r; })
      .finally(() => { rcBusy = null; });
    return rcBusy;
  }
  // One code to pair: Google's remote pairing starts, our TV app's screen helper reads Google's code off the TV
  // (/atvcode, only for this paired phone) and the phone types it in itself. If the helper can't (an older TV app),
  // rcPair stays open and the code is typed by hand as before.
  async function autoRemote(say = () => {}) {
    if (!atv.available() || away || !cur?.host || atv.isPaired(cur.host)) return;
    const before = (await call('/atvcode', {}, { ms: 3000 }).catch(() => ({})))?.code || null;
    say('Asking the TV…');
    rcPair = await atv.pair(cur.host, deviceName() || 'Shivo Labs phone', say);
    say('Pairing the remote…');
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const r = await call('/atvcode', {}, { ms: 3000 }).catch(() => null);
      if (r && r.helper === false) break;
      if (r?.code && r.code !== before) {
        await rcPair.finish(r.code); rcPair = null; buzz('success'); toast('The full remote is ready'); return;
      }
    }
  }

  // ---- the air mouse: move the phone (or a finger on the pad) and a pointer moves on the TV; tap clicks ----
  function pointer() {
    if (away) return toast('The pointer works at home, on the TV’s Wi-Fi.');
    buzz();
    const sheet = document.createElement('div');
    sheet.className = 'tvx-pointer';
    sheet.innerHTML = `<div class="tvx-pt-top"><b>Pointer</b><button class="tvx-pt-x" aria-label="Close">${IC.back}</button></div>
      <div class="tvx-pt-pad" id="ptPad"><span>${IC.pointer}</span><p>${navigator.maxTouchPoints > 0 ? 'Point the phone at the TV and move it, or slide a finger here.' : 'Drag here with the mouse or touchpad.'}</p><small>${navigator.maxTouchPoints > 0 ? 'Tap to click · two fingers to scroll · Motion off to stop' : 'Click to click · drag with two fingers to scroll'}</small></div>
      <div class="tvx-pt-row"><button class="tvx-q" id="ptMotion">${IC.pointer}<span>Motion on</span></button><button class="tvx-q" data-pk="back">${IC.back}<span>Back</span></button><button class="tvx-q" data-pk="home">${IC.home}<span>Home</span></button></div>`;
    document.body.appendChild(sheet);
    const ws = new WebSocket(`ws://${cur.host}:${PORT}/mouse?${new URLSearchParams({ k: cur.key })}`);
    let dx = 0, dy = 0, raf = 0, motion = true, closed = false;
    const sendSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (ws.readyState === 1 && (Math.abs(dx) >= 1 || Math.abs(dy) >= 1)) { ws.send(`m ${dx.toFixed(1)} ${dy.toFixed(1)}`); dx = 0; dy = 0; } }); };
    const send = (m) => { if (ws.readyState === 1) ws.send(m); };
    ws.onerror = () => { if (!closed) toast('Can’t reach the TV’s pointer. Update Shivo Labs on the TV.'); };
    let src = 'none', nMotion = 0;   // where motion comes from, and whether readings arrive (for the fallback below)
    // the pad: slide moves, a quick tap clicks, two fingers scroll (pts: fingers on the pad, also "hold to point")
    const pad = sheet.querySelector('#ptPad'), pts = new Map();
    // Motion, while a thumb rests on the pad ("hold to point"; lift to stop). Turning left/right is the spin around
    // the up direction (gravity), so it works however the phone is held; tilting up/down is the spin across the phone.
    // Tiny shakes are ignored and the rest smoothed; slow turns move finely, fast ones far.
    let upv = [0, 0, 1], sx = 0, sy = 0;
    const curve = (v) => { const a = Math.abs(v); if (a < 1.2) return 0; const q = a - 1.2; return Math.sign(v) * (q < 20 ? q * (0.7 + q / 66) : q); };
    const onMotion = (e) => {
      nMotion++;
      const g = e.accelerationIncludingGravity, r = e.rotationRate;
      if (g && g.x != null) {
        const n = Math.hypot(g.x, g.y, g.z) || 1;
        let u = [g.x / n, g.y / n, g.z / n];
        if (u[2] + u[1] < 0) u = u.map((v) => -v);             // (iOS and Android disagree on the sign)
        upv = upv.map((v, i) => v * 0.85 + u[i] * 0.15);
      }
      if (!motion || !r) return;
      const t = (e.interval > 1 ? e.interval / 1000 : e.interval) || 0.016;
      const yaw = (r.beta || 0) * upv[0] + (r.gamma || 0) * upv[1] + (r.alpha || 0) * upv[2];   // degrees a second
      const pitch = (r.beta || 0);
      sx = sx * 0.4 + curve(yaw) * 0.6; sy = sy * 0.4 + curve(pitch) * 0.6;
      const K = 30;                                              // pixels per degree
      dx += -sx * t * K; dy += -sy * t * K; sendSoon();
    };
    // the phone's own sensor through the app (ShivoTls.motionStart, CoreMotion); the web's motion events as a fallback
    const T = window.Capacitor?.Plugins?.ShivoTls;
    let nativeSub = null;
    const startMotion = async () => {
      try {
        if (T?.motionStart) {
          if (!nativeSub) nativeSub = await T.addListener('motion', (m) => onMotion({ interval: 1 / 60,
            rotationRate: { alpha: m.rz, beta: m.rx, gamma: m.ry }, accelerationIncludingGravity: { x: m.gx, y: m.gy, z: m.gz } }));
          await T.motionStart();
          src = 'phone sensor';
          // no readings from the app's own sensor link: use the web view's motion events instead
          setTimeout(() => { if (!nMotion && src === 'phone sensor') { addEventListener('devicemotion', onMotion); src = 'web'; } }, 1200);
          return;
        }
        if (typeof DeviceMotionEvent?.requestPermission === 'function' && (await DeviceMotionEvent.requestPermission()) !== 'granted') throw 0;
        addEventListener('devicemotion', onMotion); src = 'web';
      } catch { motion = false; sheet.querySelector('#ptMotion span').textContent = 'Motion off'; }
    };
    const stopMotion = () => { removeEventListener('devicemotion', onMotion); T?.motionStop?.().catch(() => {}); nativeSub?.remove?.(); nativeSub = null; };
    startMotion();
    let down = 0, moved = 0;
    pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); if (pts.size === 1) { down = Date.now(); moved = 0; } });
    pad.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId); if (!p) return;
      const mx = e.clientX - p[0], my = e.clientY - p[1]; pts.set(e.pointerId, [e.clientX, e.clientY]); moved += Math.abs(mx) + Math.abs(my);
      if (pts.size >= 2) { send(`s ${(my * 3).toFixed(0)}`); return; }
      dx += mx * 2.6; dy += my * 2.6; sendSoon();
    });
    const up = (e) => { if (!pts.delete(e.pointerId)) return; if (!pts.size && moved < 12 && Date.now() - down < 300) { send('c'); buzz(); } };
    pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
    sheet.querySelector('#ptMotion').onclick = () => { motion = !motion; sheet.querySelector('#ptMotion span').textContent = motion ? 'Motion on' : 'Motion off'; if (motion) startMotion(); };
    sheet.querySelectorAll('[data-pk]').forEach((b) => (b.onclick = () => press(b.dataset.pk)));
    sheet.querySelector('.tvx-pt-x').onclick = () => { closed = true; send('h'); stopMotion(); try { ws.close(); } catch {} sheet.remove(); };
  }

  async function press(k) {
    buzz();
    // no Google remote here (laptop, away from home): Back and Home through our TV app, which works from anywhere
    if (!atv.available() || away) { if (k === 'back' || k === 'home') act('/key', { a: k }); return; }
    try { const r = await remote(); await r.key(atv.KEY[k]); }
    catch (e) { rc = null; toast(/certificate|refused|closed|failed/i.test(e.message) ? 'The TV no longer knows this phone. Set up the remote again.' : e.message); }
  }
  function wireRemote() {
    const box = root.querySelector('#tvRemote'); if (!box) return;
    const repaint = () => { box.innerHTML = remoteHtml(); wireRemote(); };
    box.querySelector('#rcSetup')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { await autoRemote((m) => { b.textContent = m; }); }
      catch (err) { b.disabled = false; b.textContent = 'Set up the full remote'; toast(err.message); }
      repaint(); if (rcPair) setTimeout(() => box.querySelector('#rcCode')?.focus(), 200);
    });
    box.querySelector('#rcPointer')?.addEventListener('click', () => pointer());
    box.querySelector('#rcFinish')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Pairing…';
      try { await rcPair.finish(box.querySelector('#rcCode').value); rcPair = null; buzz('success'); toast('The full remote is ready'); repaint(); }
      catch (err) { b.disabled = false; b.textContent = 'Pair the remote'; toast(err.message); }
    });
    box.querySelector('#rcCancel')?.addEventListener('click', () => { rcPair?.cancel(); rcPair = null; repaint(); });
    box.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => press(b.dataset.k)));
    const form = box.querySelector('#rcType');
    box.querySelector('#rcKbd')?.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) box.querySelector('#rcText').focus(); });
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = box.querySelector('#rcText').value; if (!t) return;
      try { const r = await remote(); await r.text(t); box.querySelector('#rcText').value = ''; buzz(); } catch (err) { toast(err.message); }
    });
  }
  function wire() {
    wireRemote();
    root.querySelector('#tvHome').onclick = () => act('/home', {}, 'Home on the TV');
    root.querySelector('#tvMute').onclick = () => act('/mute', {}).then((r) => { if (r) { dev.muted = r.muted; toast(r.muted ? 'TV muted' : 'Sound on'); } });
    root.querySelector('#tvInputs').onclick = () => setTab('inputs');
    root.querySelectorAll('[data-vol]').forEach((b) => (b.onclick = async () => {
      buzz();
      if (atv.available() && atv.isPaired(cur.host)) { press(b.dataset.vol === '1' ? 'volUp' : 'volDown'); }
      try {
        const r = await call('/volume', { a: b.dataset.vol }, { post: true }); dev.vol = r.vol;
        root.querySelector('#tvVolN').textContent = r.vol;
        root.querySelector('#tvVolBar').style.width = `${dev.volMax ? Math.round(100 * r.vol / dev.volMax) : 0}%`;
      } catch (e) { toast(e.message); }
    }));
    wireNow();
    root.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    wireContent();
    root.querySelector('#tvForget').onclick = () => {
      atv.forget(cur.host); dropCache(cur.host); rc?.close(); rc = null; offline = '';
      tvs = tvs.filter((t) => t.host !== cur.host); save(); cur = tvs[0] || null; apps = []; now = []; shelves = [];
      toast('This phone forgot the TV'); cur ? refresh(true) : paintPair();
    };
  }
  function wireNow() {
    root.querySelectorAll('#tvNow [data-resume]').forEach((b) => (b.onclick = () => resume(watched()[+b.dataset.resume])));
    root.querySelectorAll('[data-media]').forEach((b) => (b.onclick = () => {
      const p = playing()[0]; if (!p) return;
      act('/media', { a: p.pkg, b: b.dataset.media }).then(() => setTimeout(pollNow, 700));
    }));
  }
  function wireContent() {
    root.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => act('/open', { a: b.dataset.open }, `Opening ${label(b.dataset.open)} on the TV`)));
    root.querySelectorAll('[data-input]').forEach((b) => (b.onclick = () => act('/input', { a: b.dataset.input }, 'Switching the TV')));
    root.querySelectorAll('[data-setting]').forEach((b) => (b.onclick = () => act('/setting', { a: b.dataset.setting }, 'Opening it on the TV')));
    root.querySelectorAll('[data-shivo]').forEach((b) => (b.onclick = () => act('/shivo', { a: b.dataset.shivo }, 'Opening it on the TV')));
    root.querySelectorAll('[data-dream]').forEach((b) => (b.onclick = () => act('/dream', {}, 'Screensaver on')));
    root.querySelectorAll('[data-code]').forEach((b) => (b.onclick = async () => {
      // a code for another phone: they type it in Shivo Labs > TV > Use a code from the TV (any network, 10 minutes)
      const r = await act('/code', {}); if (!r?.code) return;
      const c = `${r.code.slice(0, 3)} ${r.code.slice(3)}`, box = root.querySelector('#tvCodeBox');
      box.innerHTML = `<section class="tvx-ctl tvx-codebox"><small>Code for another phone · 10 minutes</small><b>${esc(c)}</b>
        <span>On their phone: Shivo Labs › TV › Use a code from the TV.</span><button class="btn pri sm" id="tvShare">Share</button></section>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      box.querySelector('#tvShare').onclick = () => { const t = `Shivo Labs TV code: ${c}. In Shivo Labs open TV, then "Use a code from the TV".`; navigator.share ? navigator.share({ text: t }).catch(() => {}) : navigator.clipboard?.writeText(t).then(() => toast('Copied')); };
    }));
    root.querySelectorAll('[data-resume]').forEach((b) => (b.onclick = () => resume(watched()[+b.dataset.resume])));
    root.querySelectorAll('.tvx-thumb:not([data-resume])').forEach((b) => (b.onclick = () => act(b.dataset.uri ? '/openUri' : '/open', { a: b.dataset.uri || b.dataset.pkg }, 'Playing on the TV').then(() => setTimeout(pollNow, 2500))));
  }
  function setTab(t) {
    tab = t; try { localStorage.setItem('sl.tvTab', t); } catch {}
    buzz();
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    const c = root.querySelector('#tvContent'); c.innerHTML = contentHtml(); c.classList.remove('in'); void c.offsetWidth; c.classList.add('in');
    wireContent(); pics();
  }
  async function act(path, q, msg) {
    buzz();
    try { const r = await call(path, q, { post: true }); if (r.ok === false) throw new Error("The TV couldn't do that"); if (msg) toast(msg); return r; }
    catch (e) { toast(e.message); }
  }
  async function pollNow() {
    try {
      const n = await call('/now', {}, { ms: 4000 });
      const h = await call('/history', {}, { ms: 4000 }).catch(() => hist);
      const hChanged = JSON.stringify(h.slice(0, 3).map((x) => [x.title, x.vid])) !== JSON.stringify(hist.slice(0, 3).map((x) => [x.title, x.vid]));
      hist = h;
      if (hChanged && tab === 'foryou') { const c = root.querySelector('#tvContent'); if (c) { c.innerHTML = contentHtml(); wireContent(); pics(); } }
      if (hChanged || JSON.stringify(n.map((p) => [p.title, p.playing])) !== JSON.stringify(now.map((p) => [p.title, p.playing]))) {
        now = n; const box = root.querySelector('#tvNow'); if (box) { box.innerHTML = nowHtml(); wireNow(); pics(); }
      }
    } catch (e) { if (alive && cur && apps.length && !e.unpaired) { offline = e.message; now = []; lastTry = Date.now(); paint(); } }
  }

  let lastTry = 0;
  async function refresh(full = false) {
    if (!cur) return paintPair();
    lastTry = Date.now();
    if (!cur.kh && cur.key) { try { cur.kh = await sha(cur.key); save(); } catch {} }
    // with something remembered, show it at once instead of a waiting screen
    const old = readCache();
    if ((full || !apps.length) && old) { ({ apps, dev, shelves, inputs, hist } = { apps: [], dev: {}, shelves: [], inputs: [], hist: [], ...old }); now = []; if (!offline) paint(); }
    try {
      if (full || !apps.length || offline) {
        if (!old) root.innerHTML = `<div class="tvx-wait"><span class="tvx-tv-ic">${IC.tv}</span><p>Connecting to ${esc(cur.name || 'the TV')}…</p></div>`;
        [apps, dev, shelves, inputs, hist] = await Promise.all([call('/apps'), call('/device'), call('/shelves'), call('/inputs'), call('/history').catch(() => [])]);
        inputs.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        writeCache();
      }
      now = await call('/now');
      offline = '';
      paint();
      if (!cur.relay) learnRelay();
    } catch (e) {
      if (e.unpaired) { tvs = tvs.filter((t) => t.host !== cur.host); save(); dropCache(cur.host); cur = null; offline = ''; return paintPair(e.message); }
      if (old || apps.length) { offline = e.message; now = []; paint(); return; }   // the screen stays; only a banner says it is not connected
      root.innerHTML = `<div class="tvp"><div class="tvp-art off"><span class="tvp-tv">${IC.tv}</span></div>
        <h2 class="tvp-h">Can't reach ${esc(cur.name || 'the TV')}</h2><p class="tvp-p">${esc(e.message)}</p>
        <button class="btn pri tvp-btn" id="tvRetry">Try again</button><button class="tvp-link" id="tvOther">Use a different TV</button></div>`;
      root.querySelector('#tvRetry').onclick = () => refresh(true);
      root.querySelector('#tvOther').onclick = () => { cur = null; paintPair(); };
    }
  }

  return {
    // the screen is shown: fresh look, then what is playing every few seconds
    start() { alive = true; refresh(!apps.length); clearInterval(timer); timer = setInterval(() => { if (!alive || !cur || document.hidden) return; if (offline) { if (Date.now() - lastTry > 10000) refresh(true); } else if (apps.length) pollNow(); }, 5000); },
    stop() { alive = false; clearInterval(timer); stopFind?.(); stopFind = null; scanning = false; rc?.close(); rc = null; },
  };
}
