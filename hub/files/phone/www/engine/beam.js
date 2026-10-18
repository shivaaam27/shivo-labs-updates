// Beam inside the phone app: send photos and files to the PC, and receive what the PC sends.
// Talks straight to Beam on the PC over the shared Wi-Fi (beam.local:8765). Nothing goes online.
// The first time, Beam on the PC asks its owner to accept this phone (like AirDrop).
// Received photos and videos go into Photos; other files go into the Files app
// (On My iPhone > Shivo Labs > Beam).
import { plugin } from './native.js';

export const SHARE_URL = 'https://shivamparmar.vercel.app/beam';
let host = 'beam.local';
export const setHost = (h) => { host = String(h || 'beam.local').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '') || 'beam.local'; };
const base = () => `http://${host}:8765`;

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
  const name = deviceName();
  return path + (path.includes('?') ? '&' : '?') + 'bid=' + id + '&bkind=' + deviceKind() + (name ? '&bname=' + encodeURIComponent(name) : '');
};

async function call(path, opts = {}, ms = 8000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(base() + who(path), { ...opts, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 403) throw new Error('Not accepted on the PC yet. Click Accept on the PC, then try again.');
    if (r.status === 401) throw new Error('The PC did not accept this phone. Try again and click Accept on the PC.');
    return r;
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof TypeError) throw new Error("Can't reach Beam. Check Beam is open on the PC and both are on the same Wi-Fi.");
    throw e;
  } finally { clearTimeout(t); }
}

// Is Beam there? Returns the PC's name. The first call may wait while the owner clicks Accept,
// so the default wait is long; background checks pass a short one.
export async function ping(ms = 75000) {
  const r = await call('/ping', {}, ms);
  if (!r.ok) throw new Error('Beam answered ' + r.status);
  return (await r.json()).pc || 'PC';
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
export async function receiveBatch(items, onStep, opts = {}) {
  const N = plugin('ShivoNative');
  const st = await N.beamStatus().catch(() => ({}));
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
