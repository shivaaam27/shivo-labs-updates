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
// Four tabs: Remote (on a phone; on a tablet or PC it stays on the left), Watch (what to watch, the TV's apps, Get apps),
// Family (messages, reminders, dates, calls, photos, each with its own settings) and TV (health, inputs, the TV's own
// settings and features). Settings and lists open as sheets from the bottom.
import { deviceName } from '../engine/beam.js';
import * as pass from '../engine/id.js';
import * as live from '../engine/live.js';
import * as atv from './atvremote.js';
import { makeRemote } from './remote.js';
import { mountFamily, mountHealth, mountShop, mountSport, mountTogether, sheet, featureSheet, loadMods } from './family.js';

const PORT = 8799;
const RELAY = 'https://shivo-tv.ishivamparmar.workers.dev';   // tv/relay; finds the TV by this phone's key fingerprint
const OLD_RELAY = 'shivo-tv-relay-test.ishivamparmar.workers.dev';   // its name until 20 Oct 2026 (deleted 21 Oct; saved addresses are moved)
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
  chev: svg('<path d="M9 6l6 6-6 6"/>'),
  spark: svg('<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M6 18l2.8-2.8M15.2 8.8 18 6"/>'),
  pip: svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="6.5" height="5" rx="1.2"/>'),
  shield: svg('<path d="M12 3.5 19 6v5.5c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  ball: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5l3.6 2.6-1.4 4.2H9.8l-1.4-4.2zM12 7.5V3.5M15.6 10.1l3.9-1.3M14.2 14.3l2.4 3.4M9.8 14.3l-2.4 3.4M8.4 10.1 4.5 8.8"/>'),
  bag: svg('<path d="M5 8h14l-1.2 11.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>'),
  pulse: svg('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>'),
};
// the big services whose rows are worth showing (no rows from the apps the TV maker put on)
const BIG = [/youtube/, /netflix/, /amazonvideo/, /disneyplus/, /showmax/, /spotify/, /apple\.atve/, /hbo|\.max\b/, /google\.android\.videos/];
const HIDE = /tvlauncher|launcherx|setupwraith|com\.android\.vending|tcl\.settings|tclhome_passive|webview_shell|android\.tv\.settings/;

export function mountTv(root, { toast = () => {}, haptic = () => {}, ai = null, setup = null } = {}) {
  const buzz = (k = 'light') => { try { haptic(k); } catch {} };
  let tvs = []; try { tvs = JSON.parse(localStorage.getItem('sl.tv') || '[]'); } catch {}
  const save = () => { try { localStorage.setItem('sl.tv', JSON.stringify(tvs)); } catch {} };
  // TVs paired before the relay's new name keep its old address: it moves to the new one (TV 1.0.19 connects there)
  if (tvs.some((t) => t.relay?.includes(OLD_RELAY))) { tvs.forEach((t) => { if (t.relay) t.relay = t.relay.replace(OLD_RELAY, new URL(RELAY).host); }); save(); }
  let cur = tvs[0] || null, apps = [], now = [], shelves = [], inputs = [], hist = [], dev = {}, timer = 0, alive = false, pairing = null;
  const OLD_TAB = { foryou: 'watch', apps: 'watch', features: 'tv', inputs: 'tv', more: 'tv' };
  let tab = 'watch';
  try { const t = localStorage.getItem('sl.tvTab') || 'watch'; tab = OLD_TAB[t] || t; } catch {}
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
  async function get(u, ms, post, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    // a body goes as plain text (no extra round trip for the browser's permission check); the TV reads it as JSON
    try { return await fetch(u, { method: post || body != null ? 'POST' : 'GET', signal: ctl.signal, cache: 'no-store', ...(body != null ? { body } : {}) }); }
    finally { clearTimeout(t); }
  }
  // one request to the TV (at home, or through the relay); gives the Response itself, for pictures that are not JSON
  async function send(path, q = {}, { host, ms = 6000, post = false, body } = {}) {
    let r = null;
    if (host) r = await get(url(host, path, q), ms, post, body).catch(() => null);   // pairing: only ever on the Wi-Fi
    else {
      // at home: straight to the TV; away: the relay, with a quick look every half minute whether the TV is near again
      const tryHome = !away || !hasRelay() || Date.now() - lastHome > 30000;
      if (tryHome) { lastHome = Date.now(); r = await get(url(cur.host, path, q), away ? 1500 : Math.min(ms, hasRelay() ? 2500 : ms), post, body).catch(() => null); }
      if (r) { if (away) { away = false; paintWhere(); } }
      else if (hasRelay()) {
        r = await get(relayUrl(path, q), ms + 4000, post, body).catch(() => null);
        if (r && r.status !== 503 && !away) { away = true; paintWhere(); }
      }
    }
    if (!r) throw new Error(hasRelay() && !host ? "Can't reach the TV. Check it is on and has internet." : "Can't reach the TV. Check it is on, showing Shivo Labs, and on the same Wi-Fi as this phone.");
    if (r.status === 401) throw Object.assign(new Error('This phone is no longer paired with the TV. Pair it again.'), { unpaired: true });
    if (r.status === 503) throw new Error('The TV is off or has no internet right now.');
    return r;
  }
  async function call(path, q = {}, opts = {}) { return await (await send(path, q, opts)).json(); }
  // the same, to another paired TV (Watch together): straight to it on the Wi-Fi, else through the relay
  async function callOn(t, path, q = {}, { post = false, body, ms = 6000 } = {}) {
    if (!t.kh && t.key) { try { t.kh = await sha(t.key); } catch {} }
    const qq = new URLSearchParams({ ...q, k: t.key });
    let r = t.host ? await get(`http://${t.host}:${PORT}${path}?${qq}`, 2500, post, body).catch(() => null) : null;
    if (!r && (t.relay || t.kh)) r = await get(`${t.relay || `${RELAY}/k/${t.kh}`}${path}?${qq}`, ms + 4000, post, body).catch(() => null);
    if (!r || !r.ok) throw new Error(`Can't reach ${t.name || 'the other TV'}`);
    return r.json();
  }
  // where the phone reaches the TV from, under the TV's name
  const whereText = () => offline ? 'Not connected' : away ? 'Connected from anywhere' : `Connected · ${cur.host}`;
  function paintWhere() {
    const w = root.querySelector('#tvWhere'); if (w) w.textContent = whereText();
    rmt.refresh();
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
    if (blobs.has(path)) { const u = blobs.get(path); if (u) img.src = u; else img.dispatchEvent(new Event('error')); return; }   // '' = the TV has none
    try {
      let r = await fetch(base(path), { cache: 'force-cache' }).catch(() => null);
      if (!r && !away && hasRelay()) r = await fetch(relayUrl(path), { cache: 'force-cache' }).catch(() => null);
      if (!r || !r.ok) throw 0;
      const u = URL.createObjectURL(await r.blob()); blobs.set(path, u); img.src = u;
    } catch { blobs.set(path, ''); img.dispatchEvent(new Event('error')); }
  }
  const pics = (el = root) => (el || root).querySelectorAll('img[data-tvpic]:not([src])').forEach(pic);
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
        <div id="tvMine"></div>
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
    if (!pairing) { checkNet(); mineTvs(); }
    // the TVs that joined this phone's Shivo Labs (UNIFY-PLAN.md, 23 Oct 2026): no code, from any network; the TV
    // checks this phone's signature against shivo-id (Remote.java /pair/pass)
    async function mineTvs() {
      const box = root.querySelector('#tvMine');
      if (!box || !pass.passFor('tv')) return;
      const mine = (await pass.companyDevices().catch(() => [])).filter((d) => d.kind === 'tv' && d.tv?.id);
      if (!mine.length || !box.isConnected) return;
      box.innerHTML = `<section class="tvp-far"><b>Your TVs</b><small>They joined your Shivo Labs, so no code is needed. Works on Wi-Fi or mobile data.</small>
        ${mine.map((t) => `<button class="btn pri tvp-btn" data-mine="${esc(t.id)}">Connect ${esc(t.name)}</button>`).join('')}</section>`;
      box.querySelectorAll('[data-mine]').forEach((b) => (b.onclick = async () => {
        const t = mine.find((x) => x.id === b.dataset.mine);
        b.disabled = true; b.textContent = 'Connecting…';
        try {
          const s = await pass.signFor('tv.' + t.id);
          const r = await fetch(`${t.tv.url}/p/${t.tv.id}/pair/pass?${new URLSearchParams({ a: s.device, b: s.ts, c: s.sig })}`, { cache: 'no-store' })
            .catch(() => { throw new Error("Can't reach the internet. Check this phone's connection."); });
          const j = await r.json().catch(() => ({}));
          if (!j.ok) throw new Error(j.error || (r.status === 503 ? 'The TV is off or has no internet right now.' : 'That did not work. Try again.'));
          cur = { host: j.host || '', key: j.key, name: j.name || t.name, relay: j.relay || '' }; away = false;
          tvs = [cur, ...tvs.filter((x) => x.host !== cur.host || !cur.host)]; save();
          buzz('success'); toast('Connected to ' + cur.name); await refresh(true); rmt.afterPair();
        } catch (e) { b.disabled = false; b.textContent = 'Connect ' + t.name; paintPairErr(e.message); }
      }));
    }
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
          buzz('success'); toast('Connected to ' + cur.name); await refresh(true); rmt.afterPair();
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
          pairing = null; buzz('success'); toast('Paired with ' + cur.name); await refresh(true); rmt.afterPair();
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
        <div><b>Nothing playing</b></div></section>`;
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
  // a row in a grouped list (like iPhone Settings): an icon, a title and a line, an arrow when it opens something
  const row = (attrs, ic, t, sub = '', more = true) => `<button class="tvs-row go" ${attrs}><span class="tvs-ic">${ic}</span>
    <span class="tvs-t"><b>${esc(t)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${more ? IC.chev : ''}</button>`;
  const appTiles = () => appList().map((a) => `<button class="tvx-app${a.banner ? '' : ' ic'}" data-open="${esc(a.pkg)}">
    <span class="tvx-app-p">${a.banner ? `<img data-tvpic="/banner/${esc(a.pkg)}" alt="" onerror="this.closest('.tvx-app').classList.add('ic');this.remove()">` : ''}<img class="tvx-app-i" data-tvpic="/icon/${esc(a.pkg)}" alt="" onerror="this.remove()"></span>
    <span class="tvx-app-l">${esc(a.label)}</span></button>`).join('');
  const inputRows = () => inputs.map((x) => row(`data-input="${esc(x.id)}"`, /hdmi/i.test(x.label) ? IC.hdmi : IC.input, x.label, 'Switch the TV to this', false)).join('');
  function contentHtml() {
    if (tab === 'family') return '<div id="tvFam"><div class="tvx-wait"><p>Asking the TV…</p></div></div>';
    if (tab === 'tv') {
      return `<div id="tvHealth"></div>
        ${inputs.length ? `<h3 class="tvx-h">Inputs</h3><div class="tvs-group">${inputRows()}</div>` : ''}
        <h3 class="tvx-h">On the TV</h3><div class="tvs-group">
          ${row('data-code', IC.phone, 'Add a phone', 'A one-time code for someone else’s phone')}
          ${row('data-dream', IC.moon, 'Screensaver', 'Start it now', false)}
          ${row('data-shivo="settings"', IC.tv, 'Shivo Labs settings', 'Opens them on the TV', false)}
          ${row('data-tvupdate="1"', IC.spark, 'Update the TV', dev.version ? `Shivo Labs TV ${dev.version}` : 'Newest version', false)}</div>
        <h3 class="tvx-h">Features</h3><div class="tvs-group" id="tvFeat"><p class="tvs-wait">Asking the TV…</p></div>
        <h3 class="tvx-h">TV settings</h3><div class="tvs-group">
          ${row('data-setting="display"', IC.picture, 'Picture', 'Mode, resolution', false)}
          ${row('data-setting="sound"', IC.vol, 'Sound', 'Mode, output', false)}
          ${row('data-setting="network"', IC.wifi, 'Network', 'Wi-Fi, internet', false)}
          ${row('data-setting="bluetooth"', IC.remote, 'Remotes and Bluetooth', '', false)}
          ${row('data-setting="all"', IC.gear, 'All settings', 'Opens them on the TV', false)}</div>`;
    }
    // Watch: live sport, what was watched, the apps' own rows, the TV's apps (and Get apps), extras
    const rows = rowsOf(), w = watched();
    const contHtml = w.length ? `<h3 class="tvx-h">Continue watching</h3>
      <div class="tvx-strip">${w.map((h, i) => `<button class="tvx-thumb" data-resume="${i}"><span class="tvx-thumb-p">${histPic(h)}${pct(h) ? `<i class="tvx-thumb-bar"><i style="width:${pct(h)}%"></i></i>` : ''}</span>
        <b>${esc(h.title)}</b><small class="tvx-thumb-s">${esc(label(h.pkg))}</small></button>`).join('')}</div>` : '';
    const rowsHtml = rows.map((r) => `<h3 class="tvx-h">${esc(label(r.pkg))}<span>${esc(r.name)}</span></h3>
      <div class="tvx-strip">${r.items.slice(0, 14).map((it) => `<button class="tvx-thumb" data-uri="${esc(it.uri || '')}" data-pkg="${esc(r.pkg)}">
        <span class="tvx-thumb-p">${web(it.art) ? `<img src="${esc(web(it.art))}" alt="" loading="lazy">` : ''}</span><b>${esc(it.title)}</b></button>`).join('')}</div>`).join('');
    return `<div id="tvTogether"></div><div id="tvSport"></div>${contHtml}${rowsHtml}
      <h3 class="tvx-h tvf-h"><span class="tvf-ht">Apps on the TV</span><span class="tvf-hb"><button class="tvf-add" data-sheet="shop">${IC.plus}Get apps</button></span></h3>
      ${apps.length ? `<div class="tvx-apps">${appTiles()}</div>` : '<p class="tvx-none">The TV’s apps show here once it answers.</p>'}
      <h3 class="tvx-h">More</h3><div class="tvs-group">
        ${row('data-sheet="corner"', IC.pip, 'Video in a corner', 'A second YouTube video over what is on')}
        ${row('data-shivo="apps"', IC.grid, 'Apps page on the TV', 'All apps, on the TV’s screen', false)}</div>`;
  }
  // Layout: on a phone the Remote is the first tab (now playing, the remote, TV health) and the others below the tabs;
  // from 760 px (tablet, PC) the remote stays on the left, sized to fit the screen, and the tabs fill the right.
  const TABS = [['remote', 'Remote'], ['watch', 'Watch'], ['family', 'Family'], ['tv', 'TV']];
  const wide = () => matchMedia('(min-width: 760px)').matches;
  function paint() {
    if (tab === 'remote' && wide()) tab = 'watch';
    root.innerHTML = `<div class="tvx${tab === 'remote' ? ' tab-remote' : ''}">
        <section class="tvx-tv"><span class="tvx-tv-ic">${IC.tv}</span>
          <div><b>${esc(cur.name || 'TV')}</b><small><i class="dot${offline ? ' wait' : ''}"></i><span id="tvWhere">${esc(whereText())}</span></small></div>
          ${setup ? '<button class="tvx-setup" id="tvSetup">Set up a TV</button>' : ''}</section>
        <div class="seg tvx-seg">${TABS.map(([id, n]) => `<button data-tab="${id}" class="${tab === id ? 'on' : ''}">${n}</button>`).join('')}</div>
        ${offline ? `<div class="tvx-offline"><span>${IC.wifi}</span><div><b>Not connected to ${esc(cur.name || 'the TV')}</b><small>${esc(offline)} Showing what it had last time.</small></div><button class="btn sm" id="tvRetry">Try again</button></div>` : ''}
      <aside class="tvx-side">
        <div id="tvNow">${nowHtml()}</div>
        <div id="tvRemote"></div>
      </aside>
      <main class="tvx-main">
        <div class="tvx-content" id="tvContent">${tab === 'remote' ? '' : contentHtml()}</div>
        <button class="tvx-forget" id="tvForget">Forget this TV</button>
      </main>
    </div>`;
    wire();
    rmt.mount(root.querySelector('#tvRemote'));
    root.querySelector('#tvRetry')?.addEventListener('click', () => refresh(true));
    pics();
  }
  // ---- the remote: one card, like a real remote (remote.js) ----
  const rmt = makeRemote({ call, toast, buzz, port: PORT, cur: () => cur, away: () => away, dev: () => dev, openLive: () => openLive(), setTab: (t) => (t === 'inputs' ? inputsSheet() : setTab(t)) });
  function wire() {
    root.querySelector('#tvSetup')?.addEventListener('click', () => setup());
    wireNow();
    root.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    wireContent();
    root.querySelector('#tvForget').onclick = () => {
      rmt.forget(); dropCache(cur.host); offline = '';
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
  // what each tab asks the TV for itself (family.js): Watch its sport and Watch together, Family its lists, TV its health
  // and the list of the TV's own features (the family ones are in the Family tab, each with its own settings)
  const FAMILY_MODS = ['reminders', 'messages', 'birthdays', 'announce', 'photos', 'board', 'room', 'ai'];
  let famTab = null;
  // passwords for the TURN relay for a video call (the relay gives them only to a phone paired with this TV)
  const ice = async () => {
    if (!cur?.key && !cur?.kh) return [];
    const kh = cur.kh || await sha(cur.key);
    const r = await fetch(`${RELAY}/k/${kh}/turn`, { cache: 'no-store' });
    return r.ok ? ((await r.json()).iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53/.test(u)) })) : [];
  };
  const opts = () => ({ call, toast, buzz, pics, ai, ice, nowPlaying: () => playing()[0] || null, appsOnTv: () => apps, tvName: () => cur?.name || 'the TV' });
  function mountTab() {
    famTab?.stop(); famTab = null;
    const hl = root.querySelector('#tvHealth'); if (hl && !offline) mountHealth(hl, { call, toast, buzz });
    if (root.querySelector('#tvFeat')) paintFeatures();
    const sp = root.querySelector('#tvSport');
    if (sp) {
      const a = mountSport(sp, opts()), b = mountTogether(root.querySelector('#tvTogether'), { ...opts(), callOn, otherTvs: () => tvs.filter((t) => t !== cur && t.key), here: () => ({ now, hist }) });
      famTab = { stop() { a.stop(); b.stop(); } };
      return;
    }
    const el = root.querySelector('#tvFam'); if (el) famTab = mountFamily(el, opts());
  }
  // TV › Features: one row each, its state under the name; a tap opens its switch and settings from the bottom
  const FEAT_IC = { adblock: 'shield', today: 'sun', sport: 'ball', store: 'bag', corner: 'pip', health: 'pulse' };
  async function paintFeatures() {
    const box = root.querySelector('#tvFeat'); if (!box) return;
    try {
      const mods = (await loadMods(call, true)).filter((m) => !FAMILY_MODS.includes(m.id));
      if (!root.contains(box)) return;
      box.innerHTML = mods.map((m) => row(`data-feat="${esc(m.id)}"`, IC[FEAT_IC[m.id]] || IC.spark, m.name, `${m.on ? 'On' : 'Off'} · ${m.about}`)).join('');
      box.querySelectorAll('[data-feat]').forEach((b) => (b.onclick = () => { buzz(); featureSheet([b.dataset.feat], { call, toast, buzz, onChange: () => paintFeatures() }); }));
    } catch (e) { box.innerHTML = `<p class="tvs-wait">${esc(e.message)}</p>`; }
  }
  // ---- sheets from the bottom: inputs (the remote's Inputs button), Get apps, a video in a corner, a code ----
  function inputsSheet() {
    buzz();
    const el = sheet('Inputs', inputs.length ? `<div class="tvs-group">${inputRows()}</div>` : '<p class="tvx-none">This TV has no inputs to switch to.</p>', { done: true });
    el.querySelectorAll('[data-input]').forEach((b) => (b.onclick = () => { act('/input', { a: b.dataset.input }, 'Switching the TV'); el.close(); }));
  }
  function shopSheet() {
    const el = sheet('Get apps', '<div id="tvShopS"><p class="tvs-wait">Asking the TV…</p></div>', { done: true, wide: true });
    const s = mountShop(el.querySelector('#tvShopS'), { ...opts(), pics: () => pics(el) });
    return s;
  }
  function cornerSheet() {
    const el = sheet('Video in a corner', `<p class="tvs-p">A second YouTube video plays small in a corner of the TV, over whatever is on. Close it from here or with Back on the remote.</p>
      <input class="field" id="tvCornerUrl" placeholder="Paste a YouTube link" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url">
      <div class="tvs-btns"><button class="btn pri" data-corner="mute">In the corner</button><button class="btn" data-corner="sound">With sound</button></div>
      <button class="btn tvs-quiet" data-corner="close">Close the corner video</button>`, { done: true });
    el.querySelectorAll('[data-corner]').forEach((b) => (b.onclick = async () => {
      buzz();
      if (b.dataset.corner === 'close') { await act('/corner/close', {}, 'Closed'); return el.close(); }
      const u = el.querySelector('#tvCornerUrl').value.trim();
      const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/) || u.match(/^([A-Za-z0-9_-]{11})$/), t = u.match(/[?&]t=(\d+)/);
      if (!m) return toast('Paste a YouTube link');
      try { const r = await call('/corner', { a: m[1], b: t ? t[1] : 0, c: b.dataset.corner }, { post: true }); toast(r.ok ? 'Playing in the corner' : r.error || 'That did not work'); if (r.ok) el.close(); }
      catch (e) { toast(e.message); }
    }));
    setTimeout(() => el.querySelector('#tvCornerUrl')?.focus(), 320);
  }
  // a code for another phone: they type it in Shivo Labs › TV › Use a code from the TV (any network, 10 minutes)
  async function codeSheet() {
    buzz();
    const r = await act('/code', {}); if (!r?.code) return;
    const c = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
    const el = sheet('Add a phone', `<div class="tvs-code"><small>Code for one phone · 10 minutes</small><b>${esc(c)}</b>
      <span>On their phone: Shivo Labs › TV › Use a code from the TV. It works from any network.</span></div>
      <button class="btn pri" id="tvShare">Share the code</button>`, { done: true });
    el.querySelector('#tvShare').onclick = () => { const t = `Shivo Labs TV code: ${c}. In Shivo Labs open TV, then "Use a code from the TV".`; navigator.share ? navigator.share({ text: t }).catch(() => {}) : navigator.clipboard?.writeText(t).then(() => toast('Copied')).catch(() => toast(c)); };
  }
  function wireContent() {
    mountTab();
    root.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => act('/open', { a: b.dataset.open }, `Opening ${label(b.dataset.open)} on the TV`)));
    root.querySelectorAll('[data-input]').forEach((b) => (b.onclick = () => act('/input', { a: b.dataset.input }, 'Switching the TV')));
    root.querySelectorAll('[data-setting]').forEach((b) => (b.onclick = () => act('/setting', { a: b.dataset.setting }, 'Opening it on the TV')));
    root.querySelectorAll('[data-shivo]').forEach((b) => (b.onclick = () => act('/shivo', { a: b.dataset.shivo }, 'Opening it on the TV')));
    root.querySelectorAll('[data-tvupdate]').forEach((b) => (b.onclick = async () => {
      buzz();
      try {
        toast('Checking the TV…');
        const r = await call('/update', {}, { post: true, ms: 9000 });
        // TV 1.0.20+ says whether it already has the newest version; older TVs only say ok
        toast(!r.ok ? 'This TV needs Shivo Labs TV 1.0.10 for this button; it gets there by itself.'
          : r.newest === true ? `The TV has the newest version (${r.version}).`
          : r.newest === false ? `Version ${r.newVersion} is ${r.ready ? 'ready' : 'downloading'}. It installs by itself while the screensaver is on.`
          : 'The TV is getting the newest version. It installs by itself while the screensaver is on.');
      } catch (e) { toast(e.message); }
    }));
    root.querySelectorAll('[data-sheet]').forEach((b) => (b.onclick = () => { buzz(); ({ shop: shopSheet, corner: cornerSheet, inputs: inputsSheet })[b.dataset.sheet]?.(); }));
    root.querySelectorAll('[data-dream]').forEach((b) => (b.onclick = () => act('/dream', {}, 'Screensaver on')));
    root.querySelectorAll('[data-code]').forEach((b) => (b.onclick = () => codeSheet()));
    root.querySelectorAll('[data-resume]').forEach((b) => (b.onclick = () => resume(watched()[+b.dataset.resume])));
    root.querySelectorAll('.tvx-thumb:not([data-resume])').forEach((b) => (b.onclick = () => act(b.dataset.uri ? '/openUri' : '/open', { a: b.dataset.uri || b.dataset.pkg }, 'Playing on the TV').then(() => setTimeout(pollNow, 2500))));
  }
  function setTab(t) {
    if (t === 'remote' && wide()) t = 'watch';
    tab = t; try { localStorage.setItem('sl.tvTab', t); } catch {}
    buzz();
    root.querySelector('.tvx')?.classList.toggle('tab-remote', t === 'remote');
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'remote') { famTab?.stop(); famTab = null; const c = root.querySelector('#tvContent'); if (c) c.innerHTML = ''; window.scrollTo?.(0, 0); return; }
    const c = root.querySelector('#tvContent'); c.innerHTML = contentHtml(); c.classList.remove('in'); void c.offsetWidth; c.classList.add('in');
    wireContent(); pics();
  }
  // ---- Live view: the TV's screen about once a second, scrambled on the TV and unscrambled here ----
  // A key is made for each viewing (ECDH P-256 between this phone and the TV); the relay only sees scrambled bytes.
  // The 8 digits shown here come from the same key: they must match the red badge on the TV. (tv/home Live.java)
  const b64u = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  async function liveBegin() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const r = await call('/view/start', { a: b64u(pub) }, { post: true, ms: 9000 });
    if (!r.ok) throw new Error(r.error || "The TV couldn't start Live view.");
    const tvPub = await crypto.subtle.importKey('raw', unb64u(r.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: tvPub }, kp.privateKey, 256));
    const cat = (label) => { const l = new TextEncoder().encode(label), m = new Uint8Array(l.length + secret.length); m.set(l); m.set(secret, l.length); return m; };
    const aes = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', cat('shivo-live-v1')), 'AES-GCM', false, ['decrypt']);
    const n = String(new DataView(await crypto.subtle.digest('SHA-256', cat('shivo-live-sas'))).getUint32(0) % 100000000).padStart(8, '0');
    return { aes, sas: `${n.slice(0, 4)} ${n.slice(4)}` };
  }
  async function openLive() {
    if (document.getElementById('tvLiveBox')) return;
    buzz();
    if (!document.getElementById('tvLiveCss')) {
      const st = document.createElement('style'); st.id = 'tvLiveCss';
      st.textContent = `.tvl{position:fixed;inset:0;z-index:9999;background:#000;color:#eceee9;display:flex;flex-direction:column;font:15px/1.4 system-ui,sans-serif}
        .tvl-top{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top) + 10px) 16px 10px}.tvl-top b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .tvl-sas{font-variant-numeric:tabular-nums;letter-spacing:.06em;padding:4px 10px;border-radius:99px;background:#1d2a22;color:#9be3b0;font-size:13px}
        .tvl-x{border:0;border-radius:99px;padding:8px 16px;background:#2a2c2f;color:#eceee9;font:inherit}
        .tvl-view{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;position:relative}
        .tvl-view img{max-width:100%;max-height:100%;display:block;touch-action:none;user-select:none;-webkit-user-drag:none}
        .tvl-msg{position:absolute;left:16px;right:16px;text-align:center;color:#c9ccc6}
        .tvl-chip{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:5px 12px;border-radius:99px;background:rgba(30,31,34,.85);color:#c9ccc6;font-size:12.5px;white-space:nowrap}
        .tvl-hid{position:absolute;left:16px;right:16px;bottom:16px;padding:14px 16px;border-radius:16px;background:rgba(30,31,34,.92)}.tvl-hid b{display:block}.tvl-hid small{color:#9a9d97}
        .tvl-dot{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #fff;pointer-events:none;animation:tvlp .5s ease-out forwards}@keyframes tvlp{to{transform:scale(1.8);opacity:0}}
        .tvl-bar{display:flex;gap:10px;justify-content:center;padding:10px 16px 4px}.tvl-bar button{border:0;border-radius:99px;padding:9px 20px;background:#2a2c2f;color:#eceee9;font:inherit}
        .tvl-fine{margin:0;padding:6px 16px calc(env(safe-area-inset-bottom) + 12px);font-size:12px;color:#9a9d97;text-align:center}`;
      document.head.appendChild(st);
    }
    const box = document.createElement('div'); box.className = 'tvl'; box.id = 'tvLiveBox';
    box.innerHTML = `<div class="tvl-top"><b>${esc(cur.name || 'TV')}</b><span class="tvl-sas" id="tvlSas" hidden></span><button class="tvl-x" id="tvlX">Close</button></div>
      <div class="tvl-view" id="tvlView"><img id="tvlImg" alt="" hidden><p class="tvl-msg" id="tvlMsg">Connecting to the TV…</p><span class="tvl-chip" id="tvlChip" hidden></span><div class="tvl-hid" id="tvlHid" hidden></div></div>
      <div class="tvl-bar"><button data-lk="back">Back</button><button data-lk="home">Home</button></div>
      <p class="tvl-fine">Tap the picture to press there on the TV, swipe to scroll. ${away ? 'Uses mobile data: about 3 MB a minute. ' : ''}A small dot shows on the TV while you watch; the number above matches the one in the TV's Settings › Live view.</p>`;
    document.body.appendChild(box);
    const view = box.querySelector('#tvlView'), img = box.querySelector('#tvlImg'), msg = box.querySelector('#tvlMsg'), sasEl = box.querySelector('#tvlSas'), chip = box.querySelector('#tvlChip'), hid = box.querySelector('#tvlHid');
    let open = true, objUrl = '', sess = null, fails = 0, first = true, kick = null;
    // after a tap the next picture is asked for at once, not after the usual pause
    const soon = () => { if (kick) { const k = kick; kick = null; k(); } };
    const say = (t) => { msg.textContent = t || ''; msg.hidden = !t; };
    // a problem after the first picture: the last picture stays, with a small note on top
    const note = (t) => { if (img.hidden) return say(t); chip.textContent = t || ''; chip.hidden = !t; };
    box.querySelector('#tvlX').onclick = async () => { open = false; box.remove(); if (objUrl) URL.revokeObjectURL(objUrl); try { await call('/view/stop', {}, { post: true, ms: 4000 }); } catch {} };
    box.querySelectorAll('[data-lk]').forEach((b) => (b.onclick = () => { buzz(); call('/key', { a: b.dataset.lk }, { post: true }).then(() => setTimeout(soon, 400)).catch((e) => { note(e.message); setTimeout(() => note(''), 4000); }); }));
    // touch: a tap presses that spot on the TV, a drag swipes (places as fractions of the TV's screen)
    let down = null;
    const at = (e) => { const r = img.getBoundingClientRect(); if (!r.width || !r.height) return [NaN, NaN]; return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
    img.addEventListener('pointerdown', (e) => { down = at(e); });
    img.addEventListener('pointerup', (e) => {
      if (!down || !sess) return;
      const [x1, y1] = down, [x2, y2] = at(e), far = Math.hypot(x2 - x1, y2 - y1) > 0.04; down = null;
      if (![x1, y1, x2, y2].every(Number.isFinite)) return;   // no picture on screen yet
      const vr = view.getBoundingClientRect(), dot = document.createElement('i'); dot.className = 'tvl-dot';
      dot.style.left = `${e.clientX - vr.left}px`; dot.style.top = `${e.clientY - vr.top}px`;
      view.appendChild(dot); setTimeout(() => dot.remove(), 600);
      buzz();
      const f = (n) => n.toFixed(4);
      const req = far ? call('/view/swipe', { a: `${f(x1)},${f(y1)}`, b: `${f(x2)},${f(y2)}` }, { post: true }) : call('/view/tap', { a: f(x1), b: f(y1) }, { post: true });
      // (the app's toasts sit behind this full screen, so notes show on the picture)
      req.then(() => setTimeout(soon, 350));
      req.then((j) => { if (j && j.ok === false) { note('The TV did not take the tap. It may still be updating to the newest Shivo Labs TV.'); setTimeout(() => note(''), 4000); } })
        .catch((err) => { note(err.message); setTimeout(() => note(''), 4000); });
    });
    while (open) {
      const t0 = Date.now();
      try {
        if (document.hidden) { await nap(1000); continue; }
        if (!sess) {
          try { sess = await liveBegin(); } catch (e) { say(e.message || "The TV couldn't start Live view."); break; }   // no retry loop: Close, fix it, open again
          sasEl.textContent = sess.sas; sasEl.hidden = false; if (img.hidden) say('Waiting for the first picture…');
        }
        const resp = await send('/view/frame', first ? { a: '1' } : {}, { ms: 9000 });
        const type = resp.headers.get('content-type') || '';
        if (type.includes('json')) {
          const j = await resp.json();
          if (j.restart) { sess = null; first = true; sasEl.hidden = true; continue; }
          if (j.same) { fails = 0; note(''); await new Promise((r) => { kick = r; setTimeout(r, 500); }); kick = null; continue; }   // nothing changed on the TV
          // a missed picture now and then is normal (Android limits how often); say something only if it keeps happening
          if (++fails >= 4) note(j.error || 'The TV is slow to show its screen…');
          await nap(j.busy ? 300 : 1500); continue;
        }
        const buf = new Uint8Array(await resp.arrayBuffer());
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, sess.aes, buf.slice(12));
        if (!open) break;
        const u = URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
        img.src = u; img.hidden = false; say(''); fails = 0; note(''); first = false;
        if (objUrl) URL.revokeObjectURL(objUrl); objUrl = u;
        // video the TV keeps out of screen pictures: say what is playing instead of a black box
        if (type.includes('hidden')) {
          const p = playing()[0];
          hid.innerHTML = `<b>${esc(p?.title || 'A video is playing')}</b><small>${esc(label(p?.pkg) || 'This app')} keeps its video out of screen pictures. Tap, Back and Home still work.</small>`;
          hid.hidden = false;
        } else hid.hidden = true;
      } catch (e) {
        if (!open) break;
        if (++fails >= 3) note(e.message || "Can't reach the TV.");
        await nap(2000);
      }
      await new Promise((r) => { kick = r; setTimeout(r, Math.max(100, 700 - (Date.now() - t0))); }); kick = null;
    }
  }
  async function act(path, q, msg) {
    buzz();
    try { const r = await call(path, q, { post: true }); if (r.ok === false) throw new Error("The TV couldn't do that"); if (msg) toast(msg); return r; }
    catch (e) { toast(e.message); }
  }
  // ---- the live card on the Lock Screen and in the Dynamic Island while something plays on the TV ----
  // (kits/app-native/live-activity/extension/ShivoTVCard.swift). Its buttons go to the TV by themselves, with the
  // address, key and relay given here; the text is refreshed from here whenever the app asks the TV what plays.
  // Starts when something plays, stays while it is paused, goes when nothing has played for two looks.
  let card = false, cardWas = '', cardGone = 0, cardTimer = 0, sharedWas = '';
  const cardPic = { id: '', b64: '' };
  async function tinyPic(path) {   // a picture small enough for the card (Apple allows a card 4 KB in all)
    try {
      const r = await send(path, {}, { ms: 5000 }); if (!r.ok) return '';
      const bmp = await createImageBitmap(await r.blob());
      for (const [px, q] of [[84, 0.6], [64, 0.5], [48, 0.45]]) {
        const c = document.createElement('canvas'); c.width = c.height = px;
        const side = Math.min(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, px, px);
        const b64 = c.toDataURL('image/jpeg', q).split(',')[1];
        if (b64.length * 0.75 <= 1800) return b64;
      }
    } catch {}
    return '';
  }
  async function tvCard(list) {
    if (!cur?.key) return;
    const p = (list || []).find((x) => x.playing) || (card ? (list || [])[0] : null);
    const tv = JSON.stringify({ h: cur.host || '', k: cur.key, r: cur.relay || (cur.kh ? `${RELAY}/k/${cur.kh}` : '') });
    // the widget and Control Centre buttons: the address always, what plays when something does
    const share = (f) => { const k = JSON.stringify(f); if (k !== sharedWas) { sharedWas = k; live.shareTv(f); } };
    if (!p) {
      share({ tv, title: '', subtitle: cur.name || '', playing: false });
      if (card && ++cardGone >= 2) { card = false; cardWas = ''; cardGone = 0; live.done('tv', {}, 0); }
      return;
    }
    cardGone = 0;
    const id = p.art || `icon/${p.pkg}`;
    if (cardPic.id !== id) { cardPic.id = id; cardPic.b64 = await tinyPic(`/${id.split('?')[0]}`); }
    const fields = {
      title: p.title, subtitle: `${label(p.pkg) || 'Playing'} on ${cur.name || 'the TV'}`, icon: 'tv.fill', tag: 'TV',
      playing: !!p.playing, muted: !!dev.muted, thumb: cardPic.b64,
      tv,
    };
    share({ tv, title: fields.title, subtitle: fields.subtitle, thumb: fields.thumb, playing: fields.playing });
    const was = JSON.stringify(fields);
    if (card && was === cardWas) return;   // nothing new: the card isn't touched
    cardWas = was; card = true;
    live.show('tv', { reuse: true, ...fields });   // reuse: a card still up from before the app was closed
  }
  const cardPoll = () => { if (card && cur && !document.hidden) call('/now', {}, { ms: 4000 }).then(tvCard).catch(() => {}); };

  let lastNowKey = '', lastHist = 0;
  async function pollNow() {
    try {
      const n = await call('/now', {}, { ms: 4000 });
      tvCard(n);
      // the watch history only changes when what plays changes: asked for then, or every half minute
      const nowKey = JSON.stringify(n.map((p) => p.title));
      const h = nowKey !== lastNowKey || Date.now() - lastHist > 30000 ? await call('/history', {}, { ms: 4000 }).catch(() => hist) : hist;
      if (h !== hist) lastHist = Date.now();
      lastNowKey = nowKey;
      const hChanged = JSON.stringify(h.slice(0, 3).map((x) => [x.title, x.vid])) !== JSON.stringify(hist.slice(0, 3).map((x) => [x.title, x.vid]));
      hist = h;
      if (hChanged && tab === 'watch') { const c = root.querySelector('#tvContent'); if (c) { c.innerHTML = contentHtml(); wireContent(); pics(); } }
      if (hChanged || JSON.stringify(n.map((p) => [p.title, p.playing])) !== JSON.stringify(now.map((p) => [p.title, p.playing]))) {
        now = n; const box = root.querySelector('#tvNow'); if (box) { box.innerHTML = nowHtml(); wireNow(); pics(); }
      }
    } catch (e) { if (alive && cur && apps.length && !e.unpaired) { offline = e.message; now = []; lastTry = Date.now(); paint(); } }
  }

  let lastTry = 0, slow = 0;
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
      tvCard(now);
      if (!cur.relay) learnRelay();
    } catch (e) {
      if (e.unpaired) { if (card) { card = false; live.done('tv', {}, 0); } tvs = tvs.filter((t) => t.host !== cur.host); save(); dropCache(cur.host); cur = null; offline = ''; return paintPair(e.message); }
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
    start() { clearInterval(cardTimer); if (!wide() && tab !== 'remote') { tab = 'remote'; } alive = true; refresh(!apps.length); clearInterval(timer); timer = setInterval(() => { if (!alive || !cur || document.hidden) return; if (offline) { if (Date.now() - lastTry > 10000) refresh(true); } else if (apps.length && (!away || ++slow % 2 === 0)) pollNow(); }, 5000); },
    // elsewhere in the app the TV card still follows what plays, less often
    stop() { alive = false; clearInterval(timer); clearInterval(cardTimer); cardTimer = setInterval(cardPoll, 15000); famTab?.stop(); stopFind?.(); stopFind = null; scanning = false; rmt.stop(); },
  };
}
