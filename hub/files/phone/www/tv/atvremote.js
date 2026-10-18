// The full TV remote: Google's own Android TV / Google TV remote protocol (v2), the one the Google TV app uses.
// Works with any Google/Android TV, in every app, without our TV app. Two encrypted connections, both with this
// phone's own certificate (made once, kept on the phone):
//   port 6467: pairing. The TV shows a 6-character code; the phone proves it saw it (a hash of both certificates
//              and the code), and from then on the TV trusts this phone's certificate.
//   port 6466: the remote. Key presses, text into the TV's keyboard, app links; the TV pings now and then.
// Messages are small protobufs, each preceded by its length (a varint). Based on the open protocol notes and
// androidtvremote2 (Apache-2.0): polo.proto and remotemessage.proto.
// The encrypted connection itself is native (plugin "ShivoTls": iOS Network.framework / Android SSLSocket),
// because a web view can't open raw TLS sockets with a client certificate. Certificates and hashing use
// node-forge (kit/forge.min.js, BSD), loaded the first time it's needed.
import { plugin } from '../engine/native.js';

const PAIR_PORT = 6467, REMOTE_PORT = 6466;
export const KEY = { up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, home: 3, volUp: 24, volDown: 25, mute: 164, power: 26,
  playPause: 85, next: 87, prev: 88, menu: 82, settings: 176, input: 178, del: 67, enter: 66, search: 84 };
// what this remote can do (the TV answers with what it supports): ping, keys, typing, power, volume, app links
const FEATURES = 1 | 2 | 4 | 32 | 64 | 512;

// ---------------- tiny protobuf ----------------
const te = new TextEncoder(), td = new TextDecoder();
function varint(n) { const out = []; n = Number(n); while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; }
const fld = (no, wt, bytes) => [...varint(no * 8 + wt), ...bytes];
const pInt = (no, v) => fld(no, 0, varint(v));
const pBytes = (no, b) => fld(no, 2, [...varint(b.length), ...b]);
const pStr = (no, s) => pBytes(no, [...te.encode(s)]);
const pMsg = (no, parts) => pBytes(no, parts.flat());
// decodes one message into { fieldNumber: [values] } (numbers, or Uint8Array for length-delimited)
function decode(b) {
  const out = {}; let i = 0;
  const rv = () => { let r = 0, m = 1, x; do { x = b[i++]; r += (x & 127) * m; m *= 128; } while (x & 128); return r; };
  while (i < b.length) {
    const key = rv(), no = Math.floor(key / 8), wt = key & 7;
    let v;
    if (wt === 0) v = rv();
    else if (wt === 2) { const n = rv(); v = b.subarray(i, i + n); i += n; }
    else if (wt === 5) { v = b.subarray(i, i + 4); i += 4; }
    else if (wt === 1) { v = b.subarray(i, i + 8); i += 8; }
    else break;
    (out[no] = out[no] || []).push(v);
  }
  return out;
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------------- the encrypted connection (native) ----------------
const tls = () => plugin('ShivoTls');
export const available = () => !!tls();
const conns = new Map();   // id -> { onMsg, onClose, buf }
let listening = false;
function listen() {
  if (listening || !tls()) return;
  listening = true;
  tls().addListener('data', ({ id, data }) => {
    const c = conns.get(id); if (!c) return;
    const add = unb64(data), buf = new Uint8Array(c.buf.length + add.length); buf.set(c.buf); buf.set(add, c.buf.length); c.buf = buf;
    // whole messages out of the stream (each starts with its length)
    for (;;) {
      let i = 0, n = 0, m = 1, x;
      do { if (i >= c.buf.length) return; x = c.buf[i++]; n += (x & 127) * m; m *= 128; } while (x & 128);
      if (c.buf.length < i + n) return;
      const msg = c.buf.slice(i, i + n); c.buf = c.buf.slice(i + n);
      try { c.onMsg(decode(msg)); } catch {}
    }
  });
  tls().addListener('closed', ({ id, error }) => { const c = conns.get(id); conns.delete(id); c?.onClose?.(error); });
}
async function open(host, port, id, onMsg, onClose) {
  listen();
  const r = await tls().connect({ host, port, p12: id.p12, pass: 'shivo', timeout: 8000 });
  conns.set(r.id, { onMsg, onClose, buf: new Uint8Array(0) });
  const send = (parts) => { const body = parts.flat(); return tls().write({ id: r.id, data: b64(new Uint8Array([...varint(body.length), ...body])) }); };
  return { id: r.id, peer: unb64(r.peerCert), send, close: () => { conns.delete(r.id); return tls().close({ id: r.id }).catch(() => {}); } };
}

// ---------------- this phone's certificate (made once) ----------------
let forgeP = null;
function loadForge() {
  if (window.forge) return Promise.resolve(window.forge);
  return forgeP || (forgeP = new Promise((ok, no) => {
    const s = document.createElement('script'); s.src = 'kit/forge.min.js'; s.onload = () => ok(window.forge); s.onerror = () => no(new Error('Could not load the encryption library'));
    document.head.appendChild(s);
  }));
}
export async function identity(onProgress = () => {}) {
  try { const saved = JSON.parse(localStorage.getItem('sl.atvId') || 'null'); if (saved?.p12 && saved?.cert) return saved; } catch {}
  onProgress('Preparing this phone for the TV (first time only)…');
  const forge = await loadForge();
  const keys = await new Promise((ok, no) => forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1, workerScript: 'kit/prime.worker.min.js' }, (e, k) => (e ? no(e) : ok(k))));
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'Shivo Labs' }, { name: 'organizationName', value: 'Shivo Labs' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, 'shivo', { algorithm: '3des', friendlyName: 'Shivo Labs' })).getBytes();
  const id = { p12: btoa(p12), cert: forge.pki.certificateToPem(cert) };
  try { localStorage.setItem('sl.atvId', JSON.stringify(id)); } catch {}
  return id;
}

// ---------------- pairing (port 6467) ----------------
const outer = (parts) => [pInt(1, 2), pInt(2, 200), ...parts];
const hexBytes = (h) => { if (h.length % 2) h = '0' + h; const out = []; for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16)); return out; };
/** Starts pairing: the TV shows a 6-character code. Returns { finish(code) } to complete it. */
export async function pair(host, clientName, onProgress) {
  if (!available()) throw new Error('The full remote needs the latest Shivo Labs app on this phone.');
  const id = await identity(onProgress);
  onProgress?.('Asking the TV for a code…');
  let step = null, fail = null;
  const wait = () => new Promise((ok, no) => { step = ok; fail = no; setTimeout(() => no(new Error('The TV did not answer. Is it on and on this Wi-Fi?')), 15000); });
  const c = await open(host, PAIR_PORT, id, (m) => {
    if (m[2]?.[0] !== 200) return fail?.(new Error(m[2]?.[0] === 402 ? 'That code was not right. Try again.' : 'The TV said no to pairing.'));
    if (m[11]) c.send(outer([pMsg(20, [pMsg(1, [pInt(1, 3), pInt(2, 6)]), pInt(3, 1)])]));         // options: a 6-character hex code, we type it
    else if (m[20]) c.send(outer([pMsg(30, [pMsg(1, [pInt(1, 3), pInt(2, 6)]), pInt(2, 1)])]));    // configuration
    else if (m[31]) step?.('code');                                                                 // the TV now shows the code
    else if (m[41]) step?.('paired');
  }, (err) => fail?.(new Error(err || 'The TV closed the connection.')));
  const shown = wait();
  await c.send(outer([pMsg(10, [pStr(1, 'atvremote'), pStr(2, clientName || 'Shivo Labs')])]));
  await shown;
  return {
    async finish(code) {
      code = String(code || '').trim().toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(code)) throw new Error('The code has 6 characters (0-9 and A-F).');
      const forge = await loadForge();
      const mine = forge.pki.certificateFromPem(id.cert).publicKey;
      const theirs = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.binary.raw.encode(c.peer))).publicKey;
      const md = forge.md.sha256.create();
      for (const bytes of [hexBytes(mine.n.toString(16)), hexBytes('0' + mine.e.toString(16)), hexBytes(theirs.n.toString(16)), hexBytes('0' + theirs.e.toString(16)), hexBytes(code.slice(2))])
        md.update(String.fromCharCode(...bytes));
      const hash = Uint8Array.from(md.digest().getBytes(), (ch) => ch.charCodeAt(0));
      if (hash[0] !== parseInt(code.slice(0, 2), 16)) throw new Error('That code was not right. Try again.');
      const done = wait();
      await c.send(outer([pMsg(40, [pBytes(1, [...hash])])]));
      await done;
      c.close();
      try { const p = JSON.parse(localStorage.getItem('sl.atvPaired') || '{}'); p[host] = Date.now(); localStorage.setItem('sl.atvPaired', JSON.stringify(p)); } catch {}
    },
    cancel: () => c.close(),
  };
}
export const isPaired = (host) => { try { return !!JSON.parse(localStorage.getItem('sl.atvPaired') || '{}')[host]; } catch { return false; } };
export const forget = (host) => { try { const p = JSON.parse(localStorage.getItem('sl.atvPaired') || '{}'); delete p[host]; localStorage.setItem('sl.atvPaired', JSON.stringify(p)); } catch {} };

// ---------------- the remote (port 6466) ----------------
/** Connects the remote. Returns { key(code, long), text(str), link(url), close(), ready }. */
export async function connect(host, { onState = () => {}, onClose = () => {} } = {}) {
  const id = await identity();
  let features = FEATURES, ime = { counter: 0, field: 0 }, readyOk;
  const ready = new Promise((ok) => { readyOk = ok; setTimeout(ok, 4000); });
  const c = await open(host, REMOTE_PORT, id, (m) => {
    if (m[1]) {   // the TV says what it supports: answer with what we use, and who we are
      const cfg = decode(m[1][0]); features = FEATURES & (cfg[1]?.[0] ?? FEATURES);
      c.send([pMsg(1, [pInt(1, features), pMsg(2, [pStr(1, 'Phone'), pStr(2, 'Shivo Labs'), pInt(3, 1), pStr(4, '1'), pStr(5, 'atvremote'), pStr(6, '1.0.0')])])]);
    } else if (m[2]) c.send([pMsg(2, [pInt(1, features)])]);
    else if (m[8]) { const p = decode(m[8][0]); c.send([pMsg(9, [pInt(1, p[1]?.[0] || 0)])]); }
    else if (m[21]) { const e = decode(m[21][0]); ime = { counter: e[1]?.[0] || 0, field: e[2]?.[0] || 0 }; }
    else if (m[40]) { onState({ on: !!decode(m[40][0])[1]?.[0] }); readyOk(); }
    else if (m[3]) onState({ error: true });
  }, (err) => onClose(err));
  return {
    ready,
    /** One press (or the start/end of a long press). */
    key: (code, dir = 3) => c.send([pMsg(10, [pInt(1, code), pInt(2, dir)])]),
    /** Types text into the field that has the TV's keyboard open. */
    text: (t) => { if (!t) return; const n = [...t].length - 1;
      return c.send([pMsg(21, [pInt(1, ime.counter), pInt(2, ime.field), pMsg(3, [pInt(1, 1), pMsg(2, [pInt(1, n), pInt(2, n), pStr(3, t)])])])]); },
    /** Opens an app link on the TV (e.g. a YouTube video address). */
    link: (url) => c.send([pMsg(90, [pStr(1, url)])]),
    close: () => c.close(),
  };
}

// ---------------- finding TVs on the Wi-Fi ----------------
/** Calls onFound({ name, host, port, type }) for Google TVs ("_androidtvremote2._tcp") and Shivo Labs TVs ("_shivotv._tcp"). */
export async function browse(onFound) {
  const t = tls(); if (!t?.browse) return () => {};
  const h = await t.addListener('found', (s) => onFound(s));
  await t.browse({ types: ['_androidtvremote2._tcp', '_shivotv._tcp'] }).catch(() => {});
  return () => { h?.remove?.(); t.stopBrowse?.().catch?.(() => {}); };
}
