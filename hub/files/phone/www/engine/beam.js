// Beam inside the phone app: send photos and files to the PC, and receive what the PC sends.
// Talks straight to Beam on the PC over the shared Wi-Fi (beam.local:8765, or the PC's own addresses it told us last
// time). Nothing goes online. The first time, Beam on the PC asks its owner to accept this phone (like AirDrop).
// Received photos and videos go into Photos; other files go into the Files app
// (On My iPhone > Shivo Labs > Beam).
//
// Finding the PC does not depend on one name any more. Each time, the phone tries beam.local and the PC's addresses it
// remembers at once, and if none answers it goes through the Beam relay on Cloudflare (the PC stays connected to it),
// which works from any network, and when beam.local is slow, blocked or iOS's Local Network permission was reset by an
// update. The phone gets the relay address and its own key when the PC accepts it over the home Wi-Fi (the answer to
// /ping); the relay never sees more than the PC lets through.
import { plugin } from './native.js';

export const SHARE_URL = 'https://shivamparmar.vercel.app/beam';
let host = 'beam.local';
export const setHost = (h) => {
  const n = String(h || 'beam.local').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '') || 'beam.local';
  if (n !== host) { host = n; route.at = 0; }
};

const RK = 'sl.beamRelay';   // { url, id, key }: this PC's relay address and this phone's key
const LK = 'sl.beamLan';     // the PC's addresses on the home network, as it last told us
const rd = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
// where requests go now: 'lan' (a base address on the home Wi-Fi) or 'relay'; at = when it was last confirmed
const route = { mode: 'lan', base: '', at: 0 };
const lanBase = (h) => `http://${h}:8765`;
const relayBase = (r) => `${r.url}/p/${r.id}`;
const base = () => route.base || lanBase(host);
export const viaRelay = () => route.mode === 'relay';

// Who this is, so the PC can show it as its own card and send files to it alone: a random id kept on this device,
// and its kind (iphone, ipad, android, tablet). Sent in the address, because downloads can't carry headers.
export function deviceKind() {
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/Android/.test(ua)) return Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'android';
  return Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'iphone';
}
// iOS's own id for this app on this phone (identifierForVendor, via the Device add-on in newer builds) stays the
// same when the app is reinstalled; the random id kept in storage could be wiped, and the PC then listed the
// phone again. The PC also joins ids from the same Wi-Fi address, so switching over doesn't make a new card.
let fixedId = '';
plugin('Device')?.getId?.().then((r) => {
  const id = String(r?.identifier || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 18).toLowerCase();
  if (id) { fixedId = id; try { localStorage.setItem('sl.beamId', id); } catch {} }
}).catch(() => {});
function deviceId() {
  if (fixedId) return fixedId;
  try {
    let id = localStorage.getItem('sl.beamId');
    if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('sl.beamId', id); }
    return id;
  } catch { return ''; }
}
// The name this device shows on the PC (set on the Beam screen; the PC owner can also rename it on its card)
export const deviceName = () => { try { return localStorage.getItem('sl.beamName') || ''; } catch { return ''; } };
export const setDeviceName = (n) => { try { localStorage.setItem('sl.beamName', String(n || '').trim().slice(0, 40)); } catch {} };
const who = (path) => {
  const id = deviceId(); if (!id) return path;
  const name = deviceName(), key = rd(RK)?.key;
  return path + (path.includes('?') ? '&' : '?') + 'bid=' + id + '&bkind=' + deviceKind() + (name ? '&bname=' + encodeURIComponent(name) : '') + (key ? '&k=' + encodeURIComponent(key) : '');
};

const NOT_ACCEPTED = 'Not accepted on the PC yet. Click Accept on the PC, then try again.';
const REFUSED = 'The PC did not accept this phone. Try again and click Accept on the PC.';
const cantReach = () => new Error(rd(RK)?.key
  ? "Can't reach your PC. Check Shivo Labs is open on it and that it is online."
  : "Can't reach Beam. Check Shivo Labs is open on the PC and both are on the same Wi-Fi (once is enough: after that your PC is found from anywhere).");

// one try of /ping at a base address: the PC's answer, { denied: status } when it answered but didn't accept us, or null
async function probe(b, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(b + who('/ping'), { signal: ctl.signal, cache: 'no-store' });
    if (r.status === 403 || r.status === 401) return { denied: r.status };
    if (!r.ok) return null;
    const j = await r.json(); return j && j.ok ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}
const firstOf = (list) => new Promise((done) => {
  let left = list.length, denied = null;
  if (!left) return done(null);
  for (const p of list) p.then((v) => {
    if (v && !v.denied) return done(v);
    if (v?.denied) denied = v;
    if (--left === 0) done(denied);
  });
});
// remember what the PC told us: its relay address and (once) our key, and its addresses on the home network
function learn(j) {
  if (!j) return;
  if (Array.isArray(j.lan)) wr(LK, j.lan.slice(0, 4));
  if (j.relay?.id) { const old = rd(RK) || {}; wr(RK, { url: j.relay.url, id: j.relay.id, key: j.key || old.key || '' }); }
}

// "Your PC" in the Files app (newer builds, ShivoFiles extension): it needs where the PC is and this phone's key.
// Handed over once per app start, and again when they change; it also makes Files look at the PC's folders again.
let sharedSig = '';
function shareWithFiles(pc) {
  const N = plugin('ShivoNative'), R = rd(RK);
  if (!N?.beamShare || !R?.key) return;
  const bases = [...new Set([route.mode === 'lan' ? route.base : '', ...(rd(LK) || []).map(lanBase), lanBase(host), R.url && R.id ? relayBase(R) : ''].filter(Boolean))];
  const sig = JSON.stringify([bases, R.key, pc]);
  if (sig === sharedSig) return;
  sharedSig = sig;
  N.info().then((i) => i.beamFiles && N.beamShare({ bases, key: R.key, bid: deviceId(), pc: pc || 'Your PC' })).catch(() => { sharedSig = ''; });
}

// Find the PC now: the home Wi-Fi first (beam.local and its last known addresses, all at once), then the relay.
// Returns the PC's answer to /ping, or null. A phone that has been accepted before gives the Wi-Fi only a few seconds;
// a new one waits as long as asked, since the PC's owner may be clicking Accept.
let resolving = null;
export function resolve(ms = 8000) {
  return resolving ??= (async () => {
    const R = rd(RK);
    const lan = [lanBase(host), ...(rd(LK) || []).filter((ip) => ip !== host).map(lanBase)];
    const hit = await firstOf(lan.map((b) => probe(b, R?.key ? Math.min(ms, 3500) : ms).then((j) => (j && !j.denied ? { ...j, _base: b } : j))));
    if (hit && !hit.denied) { route.mode = 'lan'; route.base = hit._base; route.at = Date.now(); route.denied = 0; learn(hit); shareWithFiles(hit.pc); return hit; }
    if (R?.key && R.url && R.id) {
      const j = await probe(relayBase(R), 10000);
      if (j && !j.denied) { route.mode = 'relay'; route.base = relayBase(R); route.at = Date.now(); route.denied = 0; learn(j); shareWithFiles(j.pc); return j; }
    }
    route.denied = hit?.denied || 0;
    return null;
  })().finally(() => { resolving = null; });
}
// away from home we sit on the relay; check now and then whether the home Wi-Fi is back (without making anyone wait)
let lastLan = 0;
function maybeHome() {
  if (route.mode !== 'relay' || Date.now() - lastLan < 60000) return;
  lastLan = Date.now(); resolve(3500).catch(() => {});
}

async function once(path, opts, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(base() + who(path), { ...opts, signal: ctl.signal, cache: 'no-store' }); }
  finally { clearTimeout(t); }
}
async function call(path, opts = {}, ms = 8000) {
  if (!route.at) { if (!(await resolve(ms))) throw denial() || cantReach(); }   // first call since the app opened: find the PC (home Wi-Fi or relay)
  else maybeHome();
  let r;
  try { r = await once(path, opts, ms); }
  catch (e) {
    if (e.name !== 'AbortError' && !(e instanceof TypeError)) throw e;
    if (!(await resolve(ms))) throw denial() || cantReach();   // it moved (or the Wi-Fi changed): find it again, once
    try { r = await once(path, opts, ms); } catch (e2) {
      if (e2.name === 'AbortError' || e2 instanceof TypeError) throw cantReach();
      throw e2;
    }
  }
  if (r.status === 403) throw new Error(NOT_ACCEPTED);
  if (r.status === 401) throw new Error(viaRelay() ? 'This phone is not set up for use away from home. Open Beam once on the same Wi-Fi as your PC.' : REFUSED);
  if (viaRelay() && r.status >= 502 && r.status <= 504) {   // the relay is fine but the PC isn't there
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'Your PC is not online.');
  }
  if (viaRelay() && r.status === 413) throw new Error((await r.json().catch(() => ({}))).error || 'Too big to send away from home.');
  return r;
}
const denial = () => (route.denied === 403 ? new Error(NOT_ACCEPTED) : route.denied === 401 ? new Error(REFUSED) : null);

// Is Beam there? Returns the PC's name. The first call may wait while the owner clicks Accept,
// so the default wait is long; background checks pass a short one.
export async function ping(ms = 75000) {
  const j = await resolve(ms);
  if (!j) throw denial() || cantReach();
  return j.pc || 'PC';
}

export async function waiting(ms = 75000) {
  const r = await call('/outbox', {}, ms);
  const list = r.ok ? await r.json() : [];
  return list.filter((it) => it.size > 0);   // an empty entry is a file an older Beam was still copying
}

// Send files (from an <input type=file>) one by one; onStep(done, total, name) for progress. Older builds only:
// newer ones send through iOS's upload service (sendNative). A send that drops on the way is tried twice more.
export async function send(files, onStep) {
  let n = 0;
  for (const f of files) {
    onStep?.(n, files.length, f.name);
    for (let attempt = 1; ; attempt++) {
      try {
        const fd = new FormData(); fd.append('file', f, f.name);
        const r = await call('/upload', { method: 'POST', body: fd }, 10 * 60000);
        if (!r.ok) throw new Error((await r.text()) || 'Upload failed');
        break;
      } catch (e) {
        if (attempt >= 3 || /accept/i.test(e.message || '')) throw e;
        await new Promise((ok) => setTimeout(ok, 1500 * attempt));
      }
    }
    n++;
  }
  return n;
}

// Files already on the phone (the pickers' and the Share menu's copies) go to iOS's own upload service (ShivoNative
// .beamSend, newer builds): it keeps sending with the phone locked or another app in front, tries a dropped file
// again, and moves the live card. Resolves when every file is sent or has failed: { sent, failed }.
export async function sendReady() {
  const N = plugin('ShivoNative'); if (!N) return false;
  try { return !!(await N.info()).beamSend; } catch { return false; }
}
export async function sendNative(list, onStep, opts = {}) {
  const N = plugin('ShivoNative');
  await ping(75000);   // the PC is there (and a new phone is accepted) before the files are handed over
  const before = (await N.beamSendStatus().catch(() => ({}))).id;   // (the last send's result isn't this one's)
  return new Promise((resolve, reject) => {
    let h1, h2, over = false, look = 0;
    const finish = (s) => {
      if (over) return; over = true; h1?.remove?.(); h2?.remove?.(); clearInterval(look);
      resolve({ sent: (s.sent || []).length, failed: s.failed || [] });
    };
    // it may end while the app is asleep (the message to the page is then missed): look every few seconds
    look = setInterval(() => N.beamSendStatus().then((s) => { if (s.id && s.id !== before && !s.active) finish(s); }).catch(() => {}), 3000);
    Promise.resolve(N.addListener('beamSendProgress', (e) => onStep?.(e.done, e.total, e.name, e.size))).then((h) => { h1 = h; });
    Promise.resolve(N.addListener('beamSendFinished', finish)).then((h) => { h2 = h; });
    N.beamSend({ files: list.map((f) => ({ path: f.path, name: f.name })), url: base() + who('/upload'),
      to: opts.to || 'your PC', look: opts.look || 'auto', accent: opts.accent || '#7FB08B' })
      .catch((e) => { if (!over) { over = true; h1?.remove?.(); h2?.remove?.(); clearInterval(look); reject(e); } });
  });
}

// The whole batch through iOS's own download service (ShivoNative.beamBatch, newer builds): it keeps going while
// the app is in the background or closed, and the native side saves each file, tells the PC and moves the live card.
// Here we only start it (or join one already running) and wait for the end. Older builds use receiveAll below.
export async function batchReady() {
  const N = plugin('ShivoNative'); if (!N) return false;
  try { return !!(await N.info()).beamBatch; } catch { return false; }
}
// Batches this page started (a batch it didn't start, still "active", is left over from before the app was closed,
// renewed or updated: iOS may have dropped its downloads, and older native builds then wait for it forever)
const ownBatches = new Set();
let stuckId = '';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
export async function receiveBatch(items, onStep, opts = {}) {
  const N = plugin('ShivoNative');
  let st = await N.beamStatus().catch(() => ({}));
  if (st.active && !ownBatches.has(st.id)) {
    // a leftover: give it 20 s to show it is still moving; if not, it's stuck and the caller saves the plain way
    if (st.id === stuckId) return { stuck: true, done: 0, photos: 0, failed: [] };
    const first = st.done;
    for (let i = 0; i < 10 && st.active && st.done === first; i++) { await sleep(2000); st = await N.beamStatus().catch(() => ({})); }
    if (st.active && st.done === first) { stuckId = st.id; return { stuck: true, done: 0, photos: 0, failed: [] }; }
  }
  if (!st.active) {
    const already = new Set(seenList().map((x) => x.k)), fresh = [];
    for (const it of items) {
      if (already.has(sig(it))) await call('/done?name=' + encodeURIComponent(it.name), { method: 'POST' }).catch(() => {});
      else fresh.push(it);
    }
    if (!fresh.length) return { done: 0, photos: 0, failed: [] };
    await N.beamBatch({
      items: fresh.map((it) => ({ url: base() + who('/file/' + encodeURIComponent(it.name)), done: base() + who('/done?name=' + encodeURIComponent(it.name)),
        name: it.name, kind: it.kind || 'file', size: it.size || 0 })),
      from: opts.from || 'your PC', look: opts.look || 'auto', accent: opts.accent || '#7FB08B',
    });
    const now = await N.beamStatus().catch(() => ({}));
    if (now.id) ownBatches.add(now.id);
  }
  return new Promise((resolve) => {
    let h1, h2, over = false;
    const finish = (s) => {
      if (over) return; over = true; h1?.remove?.(); h2?.remove?.();
      for (const x of s.saved || []) markSaved({ name: x.name, size: x.size });
      resolve({ done: (s.saved || []).length, photos: (s.saved || []).filter((x) => x.saved === 'photos').length, failed: s.failed || [] });
    };
    Promise.resolve(N.addListener('beamProgress', (e) => onStep?.(e.done, e.total, e.name, e.size))).then((h) => { h1 = h; });
    Promise.resolve(N.addListener('beamFinished', finish)).then((h) => { h2 = h; });
    N.beamStatus().then((s) => { if (s.id && !s.active) finish(s); }).catch(() => {});   // it may have ended while we weren't listening
  });
}

// Save everything waiting on the PC: photos and videos to Photos, the rest to Files.
// Each file gets a time budget that grows with its size; one that fails is left on the PC and the rest carry on.
// What this phone just saved (name + size, kept 10 minutes), so a file the PC failed to drop
// from its list is never saved twice.
const SEEN_KEY = 'sl.beamSaved';
const seenList = () => { try { const now = Date.now(); return (JSON.parse(localStorage.getItem(SEEN_KEY)) || []).filter((x) => now - x.t < 10 * 60000); } catch { return []; } };
const sig = (it) => `${it.name}|${it.size}`;
const markSaved = (it) => { try { const l = seenList(); l.push({ k: sig(it), t: Date.now() }); localStorage.setItem(SEEN_KEY, JSON.stringify(l.slice(-500))); } catch {} };
const limit = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('took too long')), ms))]);
// How long one file may take before we stop waiting: 2 minutes plus a second per MB, so a big video on
// slow Wi-Fi isn't given up on (it would still finish in the background, then be fetched a second time).
export const saveBudget = (size = 0) => 120000 + Math.ceil(size / 1e6) * 1000;
// items: the list the caller just fetched (saves asking the PC twice); fetched here when left out.
export async function receiveAll(onStep, items) {
  const N = plugin('ShivoNative'), FS = plugin('Filesystem'), M = plugin('Media');
  if (!N && !FS) throw new Error('Saving files only works in the installed app.');
  items = items || await waiting(); let done = 0, photos = 0; const failed = [];
  const already = new Set(seenList().map((x) => x.k));
  for (const it of items) {
    if (already.has(sig(it))) { await call('/done?name=' + encodeURIComponent(it.name), { method: 'POST' }).catch(() => {}); continue; }
    onStep?.(done + failed.length, items.length, it.name, it.size);
    const budget = saveBudget(it.size);
    const url = base() + who('/file/' + encodeURIComponent(it.name));
    try {
      if (N) {   // our own add-on: plain download, then Photos or Files
        const r = await limit(N.saveFromURL({ url, name: it.name, kind: it.kind }), budget);
        if (r.saved === 'photos') photos++;
      } else if (it.kind === 'media' && M) {
        const rel = 'beam-tmp/' + it.name;
        await limit(FS.downloadFile({ url, path: rel, directory: 'CACHE', recursive: true }), budget);
        const { uri } = await FS.getUri({ path: rel, directory: 'CACHE' });
        await limit(/\.(mov|mp4|m4v|avi|mkv|webm|3gp)$/i.test(it.name) ? M.saveVideo({ path: uri }) : M.savePhoto({ path: uri }), 60000);
        FS.deleteFile({ path: rel, directory: 'CACHE' }).catch(() => {});
        photos++;
      } else await limit(FS.downloadFile({ url, path: 'Beam/' + it.name, directory: 'DOCUMENTS', recursive: true }), budget);
      markSaved(it);
      await call('/done?name=' + encodeURIComponent(it.name), { method: 'POST' }).catch(() => {});
      done++;
    } catch (e) { failed.push(`${it.name}: ${e.message || e}`); }
  }
  return { done, photos, failed };
}
