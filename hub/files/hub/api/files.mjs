// Shivo Cloud on the laptop (files/PLAN.md): the hub's Files module talks to the Files API on Cloudflare
// (files/worker) and does all the encryption here (files-crypto.mjs, files/FORMAT.md). The account, this PC's device
// token and the master key live in %APPDATA%\Shivo Labs\Files\cloud.json (HUB_FILES_DIR for tests); they never go
// into the repo or to the server (the master key never leaves this PC except to a phone joining on the home Wi-Fi).
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, createReadStream, createWriteStream, readdirSync, statSync, openSync, writeSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { homedir, hostname } from "node:os";
import { Readable } from "node:stream";
import { randomBytes, createECDH } from "node:crypto";
import * as C from "./files-crypto.mjs";
import { passWith } from "./id.mjs";

export const FILES_API = process.env.HUB_FILES_API || "https://shivo-labs-files.ishivamparmar.workers.dev";
const DIR = process.env.HUB_FILES_DIR || join(process.env.APPDATA || homedir(), "Shivo Labs", "Files");
const STATE = join(DIR, "cloud.json");
// who may make a new account: a key held on the PCs that run Shivo Cloud (customer accounts come with billing)
const CREATE_KEY_FILE = process.env.HUB_FILES_CREATE_KEY || join(homedir(), ".fabra-labs-ai", "files", "create.key");

let state = null;
export function load() {
  if (state) return state;
  try { const s = JSON.parse(readFileSync(STATE, "utf8")); s.masterKey = C.unb64u(s.master); return (state = s); } catch { return null; }
}
function save(s) {
  mkdirSync(DIR, { recursive: true });
  const { masterKey, ...plain } = s;
  writeFileSync(STATE + ".tmp", JSON.stringify(plain)); renameSync(STATE + ".tmp", STATE);
  state = { ...plain, masterKey: C.unb64u(plain.master) };
}

class CloudError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path, { method = "GET", body, raw, headers = {} } = {}) {
  const s = load(); if (!s) throw new CloudError(409, "Shivo Labs Cloud isn't set up on this PC yet");
  const r = await fetch(s.api + path, {
    method, headers: { authorization: "Bearer " + s.token, ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), duplex: raw ? "half" : undefined,
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new CloudError(r.status, j.error || `Shivo Labs Cloud answered ${r.status}`); }
  return r;
}
export const apiJson = async (path, opts) => (await api(path, opts)).json();

// the names on the server are encrypted: these are the readable ones
export function readable(it) {
  const s = load(); let name;
  try { name = C.decName(s.masterKey, it.name); } catch { name = "(can't read this name)"; }
  return { id: it.id, parent: it.parent, kind: it.kind, name, size: it.size, mtime: it.mtime, version: it.version, deleted: it.deleted };
}
export async function list(parent = "") {
  const j = await apiJson("/v1/items?parent=" + encodeURIComponent(parent));
  return j.items.map(readable).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "folder" ? -1 : 1));
}
// a name not taken in the folder yet: "x.pdf", "x (1).pdf", ...
async function freeName(parent, name) {
  const taken = new Set((await list(parent)).map((x) => x.name.toLowerCase()));
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; ; n++) { const t = n ? `${stem} (${n})${ext}` : name; if (!taken.has(t.toLowerCase())) return t; }
}
const cleanName = (n) => String(n || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 200) || "Untitled";

// ---------- every live item at once (names readable), for search, the Shivo Cloud folder's first fill and folder links;
// kept 30 seconds, forgotten after any change made here
let every = null;
export async function allItems(fresh = false) {
  if (!fresh && every && Date.now() - every.at < 30000) return every.items;
  const out = new Map();
  for (let since = 0, more = true; more; ) { const j = await apiJson("/v1/changes?since=" + since); for (const it of j.items) out.set(it.id, it); since = j.seq; more = j.more; }
  const items = [...out.values()].filter((it) => !it.deleted).map(readable);
  every = { at: Date.now(), items };
  return items;
}
const byName = (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "folder" ? -1 : 1);
async function search(q) {
  const t = String(q || "").trim().toLowerCase(); if (!t) return [];
  const items = await allItems(), byId = new Map(items.map((it) => [it.id, it]));
  const where = (it) => { const p = []; for (let at = byId.get(it.parent); at && p.length < 20; at = byId.get(at.parent)) p.unshift(at.name); return p.join(" › "); };
  return items.filter((it) => it.name.toLowerCase().includes(t)).sort(byName).slice(0, 100).map((it) => ({ ...it, where: where(it) }));
}

// ---------- previews: a file decrypted for the page to show (pictures, PDFs, video, sound, text). Kept on this PC under
// %LOCALAPPDATA%\Shivo Labs\cloud-previews by id and version (up to 500 MB, oldest first out), so a second look is instant.
// Only types that can't run anything in the hub's page are shown inline; the rest download.
const VIEW_DIR = join(process.env.LOCALAPPDATA || DIR, "Shivo Labs", "cloud-previews");
const VIEW_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/mp4", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac" };
const TEXT = /\.(txt|md|csv|tsv|json|log|xml|svg|html?|css|js|mjs|ts|py|ps1|sh|bat|ini|yaml|yml|toml|sql)$/i;
export const viewType = (name) => VIEW_TYPES[(String(name).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase()] || (TEXT.test(name) ? "text/plain; charset=utf-8" : "");
async function viewFile(id) {
  const it = readable(await apiJson("/v1/item/" + id));
  if (it.kind !== "file") throw new CloudError(400, "Not a file");
  const type = viewType(it.name);
  if (!type) throw new CloudError(415, "No preview for this kind of file");
  if (it.size > 300 * 1048576) throw new CloudError(413, "Too big to preview. Download it instead.");
  mkdirSync(VIEW_DIR, { recursive: true });
  const file = join(VIEW_DIR, `${id}-${it.version}`);
  if (!existsSync(file)) {
    const { stream } = await download(id), tmp = file + ".part";
    try { await pipeline(stream, createWriteStream(tmp)); renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
    try {   // keep the folder under 500 MB
      const all = readdirSync(VIEW_DIR).map((n) => { const p = join(VIEW_DIR, n), s = statSync(p); return { p, size: s.size, t: s.mtimeMs }; }).sort((a, b) => b.t - a.t);
      let total = 0; for (const f of all) { total += f.size; if (total > 500 * 1048576 && f.p !== file) rmSync(f.p, { force: true }); }
    } catch {}
  }
  return { it, type, file };
}

// ---------- a link to a whole folder: a .zip of it as it is now, kept in "Shared links" at the top, shared like a file
// (the share page and the server stay as they are). Up to 2 GB.
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf, c = -1) => { for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c; };
async function shareFolder(id, days, password) {
  const items = await allItems(true), folder = items.find((x) => x.id === id);
  if (!folder || folder.kind !== "folder") throw new CloudError(404, "Folder not found");
  const kids = new Map(); for (const it of items) { const k = it.parent || ""; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(it); }
  const files = [], walk = (fid, rel) => { for (const it of kids.get(fid) || []) { const r = rel + it.name; if (it.kind === "folder") walk(it.id, r + "/"); else files.push({ it, r }); } };
  walk(id, "");
  if (!files.length) throw new CloudError(400, "This folder is empty");
  if (files.reduce((n, f) => n + f.it.size, 0) > 2 * 1073741824) throw new CloudError(413, "This folder is over 2 GB. Share smaller folders or single files.");
  const tmp = join(process.env.LOCALAPPDATA || DIR, "Shivo Labs", "share-" + randomBytes(6).toString("hex") + ".zip");
  mkdirSync(dirname(tmp), { recursive: true });
  const fd = openSync(tmp, "w"), central = []; let at = 0, closed = false;
  const put = (b) => { writeSync(fd, b); at += b.length; };
  try {
    // stored (no compression: photos and videos don't shrink), with the sizes and checksum after each file (data descriptor)
    for (const { it, r } of files) {
      const name = Buffer.from(r, "utf8"), head = Buffer.alloc(30), start = at;
      head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0808, 6); head.writeUInt16LE(0, 8);
      head.writeUInt32LE(dosTime(it.mtime), 10); head.writeUInt16LE(name.length, 26);
      put(head); put(name);
      let c = -1, n = 0;
      const { stream } = await download(it.id);
      for await (const chunk of stream) { c = crc32(chunk, c); n += chunk.length; put(chunk); }
      const crc = (c ^ -1) >>> 0, desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(n, 8); desc.writeUInt32LE(n, 12); put(desc);
      central.push({ name, crc, n, start, time: dosTime(it.mtime) });
    }
    const cdStart = at;
    for (const e of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(0, 10);
      h.writeUInt32LE(e.time, 12); h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.n, 20); h.writeUInt32LE(e.n, 24); h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE(e.start, 42); put(h); put(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(at - cdStart, 12); end.writeUInt32LE(cdStart, 16); put(end);
    closeSync(fd); closed = true;
    const s = load(), top = await list("");
    let box = top.find((x) => x.kind === "folder" && x.name === "Shared links");
    if (!box) box = readable(await apiJson("/v1/folders", { method: "POST", body: { parent: "", name: C.encName(s.masterKey, "Shared links") } }));
    const zipName = await freeName(box.id, cleanName(folder.name) + ".zip");
    const up = await upload(box.id, zipName, statSync(tmp).size, createReadStream(tmp));
    every = null;
    return { ...(await makeShare(up.id, days, password)), name: zipName };
  } finally { if (!closed) closeSync(fd); rmSync(tmp, { force: true }); }
}
function dosTime(ms) {
  const d = new Date(ms || Date.now());
  return (((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0;
}

// a plain stream up to Shivo Cloud: encrypted here, sent in 8 MiB parts
export async function upload(parent, name, size, plainStream, replaces) {
  const s = load(), fileKey = randomBytes(32);
  const body = { parent, name: C.encName(s.masterKey, name), key: C.wrapKey(s.masterKey, fileKey), size, stored: C.encryptedSize(size), replaces };
  const start = await apiJson("/v1/uploads", { method: "POST", body });
  const q = `?upload=${encodeURIComponent(start.upload)}&object=${encodeURIComponent(start.object)}`;
  const parts = []; let n = 0, pending = [], have = 0;
  const sendPart = async (buf) => {
    n++; const j = await apiJson(`/v1/uploads/${start.item}/${n}${q}`, { method: "PUT", raw: buf });
    parts.push({ n: j.n, etag: j.etag });
  };
  try {
    for await (const c of plainStream.pipe(C.encryptStream(fileKey))) {
      pending.push(c); have += c.length;
      while (have >= start.part) {
        const all = Buffer.concat(pending); await sendPart(all.subarray(0, start.part));
        pending = [all.subarray(start.part)]; have = pending[0].length;
      }
    }
    if (have || !parts.length) await sendPart(Buffer.concat(pending));
    return readable(await apiJson(`/v1/uploads/${start.item}/done`, { method: "POST", body: { upload: start.upload, object: start.object, parts, size, key: body.key } }));
  } catch (e) {
    await api(`/v1/uploads/${start.item}${q}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
}
// an item's plain bytes, as a stream (an older version when one is given)
export async function download(id, version) {
  const s = load(), it = await apiJson("/v1/item/" + id);
  if (it.kind !== "file") throw new CloudError(400, "Not a file");
  if (version && Number(version) !== it.version) {
    const v = (await apiJson(`/v1/item/${id}/versions`)).versions.find((x) => x.version === Number(version));
    if (!v) throw new CloudError(404, "That version is no longer kept");
    const r = await api(`/v1/item/${id}/versions/${v.version}/file`), item = readable(it);
    const dot = item.name.lastIndexOf("."), name = dot > 0 ? `${item.name.slice(0, dot)} (version ${v.version})${item.name.slice(dot)}` : `${item.name} (version ${v.version})`;
    return { item: { ...item, size: v.size, name }, stream: Readable.fromWeb(r.body).pipe(C.decryptStream(C.unwrapKey(s.masterKey, v.key))) };
  }
  const fileKey = C.unwrapKey(s.masterKey, it.key);
  const r = await api("/v1/file/" + id);
  return { item: readable(it), stream: Readable.fromWeb(r.body).pipe(C.decryptStream(fileKey)) };
}
// a file's versions, newest first (the current one first)
async function versions(id) {
  const j = await apiJson(`/v1/item/${id}/versions`);
  const row = (v, current) => ({ version: v.version, size: v.size, at: v.created, current });
  return [row(j.current, true), ...j.versions.map((v) => row(v, false))];
}

// ---------- share links and request-files links (files/FORMAT.md, "Sharing"). The key travels in the link after the
// #: the file's key for a share, the request's public key for a request. The server keeps neither in readable form.
const until = (days) => (Number(days) > 0 ? Date.now() + Number(days) * 86400000 : 0);
async function makeShare(id, days, password) {
  const s = load(), it = await apiJson("/v1/item/" + id);
  if (it.kind !== "file") throw new CloudError(400, "Only files can be shared");
  const fileKey = C.unwrapKey(s.masterKey, it.key);
  const j = await apiJson("/v1/shares", { method: "POST", body: { item: id, name: C.shareName(fileKey, readable(it).name), expires: until(days), password: password || undefined } });
  return { id: j.id, link: `${s.api}/s/${j.id}#${C.b64u(fileKey)}` };
}
async function shares() {
  const s = load(), out = [];
  for (const x of (await apiJson("/v1/shares")).shares) {
    let name = "(removed)", link = "";
    try { name = readable(await apiJson("/v1/item/" + x.item)).name; } catch {}
    try { link = `${s.api}/s/${x.id}#${C.b64u(C.unwrapKey(s.masterKey, x.key))}`; } catch {}
    out.push({ id: x.id, item: x.item, name, size: x.size, link, expires: x.expires, created: x.created, downloads: x.downloads, password: !!x.password });
  }
  return out;
}
async function makeRequest(folder, title, days) {
  const s = load();
  title = String(title || "").trim().slice(0, 80) || "Send files";
  if (!folder) folder = (await apiJson("/v1/folders", { method: "POST", body: { parent: "", name: C.encName(s.masterKey, await freeName("", cleanName(title))) } })).id;
  const k = C.requestPair();
  const j = await apiJson("/v1/requests", { method: "POST", body: { folder, title, pub: C.b64u(k.pub), priv: C.wrapKey(s.masterKey, k.priv), expires: until(days) } });
  return { id: j.id, folder, link: `${s.api}/r/${j.id}#${C.b64u(k.pub)}` };
}
async function requests() {
  const s = load(), out = [];
  for (const x of (await apiJson("/v1/requests")).requests) {
    let folder = "(removed)";
    try { folder = readable(await apiJson("/v1/item/" + x.folder)).name; } catch {}
    out.push({ id: x.id, title: x.title, folderId: x.folder, folder, link: `${s.api}/r/${x.id}#${x.pub}`, expires: x.expires, created: x.created, count: x.count });
  }
  return out;
}
// files sent through a request link arrive with their name and key sealed to the request's key: open them and seal
// them again with the master key, so every device of the account sees them (run by the sync loop and the Files page)
export async function claimRequests() {
  const s = load(); if (!s) return 0;
  let n = 0;
  for (const it of (await apiJson("/v1/unclaimed")).items) {
    let name, fileKey;
    try {
      const priv = C.unwrapKey(s.masterKey, it.priv);
      name = cleanName(C.openRequestBox(priv, it.name, "shivo-req-name").toString("utf8"));
      fileKey = C.openRequestBox(priv, it.key, "shivo-req-key");
      if (fileKey.length !== 32) throw new Error("bad key");
    } catch {   // sealed wrongly (not by our page): to the Trash, so it doesn't come back every round
      await apiJson("/v1/item/" + it.id, { method: "DELETE" }).catch(() => {});
      continue;
    }
    await apiJson("/v1/item/" + it.id, { method: "PATCH", body: { name: C.encName(s.masterKey, await freeName(it.parent, name)), key: C.wrapKey(s.masterKey, fileKey) } });
    n++;
  }
  return n;
}

// ---------- setting up, and phones joining
const createKey = () => { try { return readFileSync(CREATE_KEY_FILE, "utf8").trim(); } catch { return ""; } };
// Shivo Labs' own PCs (they hold the create key) make an account directly; a customer's PC uses the one-time setup code
// Shivo Labs gave them, plus the account's recovery code when the account already has files (a second or new PC)
async function setup(name, code, recovery) {
  if (load()) return load();
  // a customer's PC with Cloud in its Shivo Labs pass: no setup code needed
  if (!code && !createKey() && passWith("files")) {
    const s = await passSetup(name, recovery); if (s) return s;
    const e = new CloudError(409, "Waiting for another computer of your company to allow this one."); e.waiting = true; throw e;
  }
  let master = randomBytes(32);
  if (recovery) { try { master = C.fromRecoveryCode(recovery); } catch (e) { throw new CloudError(400, e.message); } }
  let r;
  if (code) r = await fetch(FILES_API + "/v1/enrol", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, recovery: !!recovery }) });
  else if (createKey()) r = await fetch(FILES_API + "/v1/account", { method: "POST", headers: { "x-create-key": createKey(), "content-type": "application/json" }, body: JSON.stringify({ name }) });
  else throw new CloudError(400, "Enter the setup code from Shivo Labs.");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new CloudError(r.status, j.error || "Couldn't set up Shivo Labs Cloud"); e.recovery = j.recovery; throw e; }
  const st = { api: FILES_API, account: j.account, device: j.device, token: j.token, master: C.b64u(master), created: Date.now() };
  if (recovery) {   // the recovery code must open this account's names
    const top = await (await fetch(FILES_API + "/v1/items?parent=", { headers: { authorization: "Bearer " + j.token } })).json().catch(() => ({ items: [] }));
    try { for (const it of (top.items || []).slice(0, 3)) C.decName(master, it.name); } catch {
      await fetch(FILES_API + "/v1/enrol/undo", { method: "POST", headers: { authorization: "Bearer " + j.token, "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => {});
      throw new CloudError(400, "That recovery code doesn't belong to this account.");
    }
  }
  save(st);
  return load();
}
// ---------- joining with the Shivo Labs pass (HOSTING-PLAN.md): a customer's PC whose pass has Cloud joins its
// company's account by itself, no setup code. The company's first PC makes the account's master key; a later PC asks
// for it, and another PC of the company allows it (the hub asks "Allow ... to open your Cloud files?"), which seals
// the key so only the new PC can open it. The server never sees it. The recovery code works instead, as before.
const PENDING = join(DIR, "pending.json");   // a PC waiting for the key: its token and its own one-time key pair
const CHECK = "shivo-check";                 // sealed with the master key on the server (kcheck): a key can be checked
const readPending = () => { try { return JSON.parse(readFileSync(PENDING, "utf8")); } catch { return null; } };
function writePending(p) {
  mkdirSync(DIR, { recursive: true });
  if (!p) return rmSync(PENDING, { force: true });
  writeFileSync(PENDING + ".tmp", JSON.stringify(p)); renameSync(PENDING + ".tmp", PENDING);
}
const keyOk = (master, kcheck) => { if (!kcheck) return true; try { return C.decName(master, kcheck) === CHECK; } catch { return false; } };
const authed = (st, path, body, method = body ? "POST" : "GET") => fetch(st.api + path, { method, headers: { authorization: "Bearer " + st.token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
async function passSetup(name, recovery) {
  const pass = passWith("files"); if (!pass) return null;
  const r = await fetch(FILES_API + "/v1/pass/enrol", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pass, name: name || hostname() }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new CloudError(r.status, j.error || "Couldn't set up Shivo Labs Cloud");
  const st = { api: FILES_API, account: j.account, device: j.device, token: j.token, created: Date.now() };
  if (recovery) {
    let master; try { master = C.fromRecoveryCode(recovery); } catch (e) { throw new CloudError(400, e.message); }
    const top = await (await authed(st, "/v1/items?parent=")).json().catch(() => ({ items: [] }));
    let ok = keyOk(master, j.kcheck);
    try { for (const it of (top.items || []).slice(0, 3)) C.decName(master, it.name); } catch { ok = false; }
    if (!ok) throw new CloudError(400, "That recovery code doesn't belong to this account.");
    save({ ...st, master: C.b64u(master) }); writePending(null); await ensureCheck();
    return load();
  }
  if (j.makeKey) {
    const master = randomBytes(32);
    if ((await authed(st, "/v1/kcheck", { check: C.encName(master, CHECK) })).ok) { save({ ...st, master: C.b64u(master) }); writePending(null); return load(); }
    // (another PC of the company was a moment faster: this one gets its key like any later PC)
  }
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const k = await authed(st, "/v1/keyreq", { pub: C.b64u(ecdh.getPublicKey(null, "uncompressed")) });
  if (!k.ok) throw new CloudError(k.status, (await k.json().catch(() => ({}))).error || "Couldn't ask for the key");
  writePending({ ...st, name: j.name, priv: C.b64u(ecdh.getPrivateKey()), kcheck: (await (await authed(st, "/v1/me")).json().catch(() => ({}))).kcheck || j.kcheck || "", asked: Date.now() });
  return null;
}
// the waiting PC: has another PC sent the key?
async function checkPending() {
  const p = readPending(); if (!p || load()) return;
  const r = await authed(p, "/v1/keyreq").catch(() => null); if (!r) return;
  if (r.status === 401) return writePending({ ...p, refused: true });   // refused: that PC was taken out of the account
  const j = await r.json().catch(() => ({}));
  if (j.state === "refused") return writePending({ ...p, refused: true });
  if (j.state !== "ready") return;
  const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(C.unb64u(p.priv));
  let got; try { got = C.joinOpen(ecdh, j); } catch { return; }
  const master = C.unb64u(got.master || "");
  if (master.length !== 32 || !keyOk(master, p.kcheck)) return;
  save({ api: p.api, account: p.account, device: p.device, token: p.token, master: got.master, created: p.created });
  writePending(null);
}
// a PC that has the key leaves the check word on the server once (accounts made before 21 Oct have none)
let checked = false;
async function ensureCheck() {
  const s = load(); if (!s || checked) return;
  const me = await apiJson("/v1/me").catch(() => null); if (!me) return;
  checked = true;
  if (!me.kcheck) await apiJson("/v1/kcheck", { method: "POST", body: { check: C.encName(s.masterKey, CHECK) } }).catch(() => {});
}
// the PCs that have the key: who is asking for it (shown as a question in the hub window)
let asking = { at: 0, list: [] };
async function keyRequests() {
  if (!load()) return [];
  if (Date.now() - asking.at > 8000) asking = { at: Date.now(), list: (await apiJson("/v1/keyreqs").catch(() => ({ requests: [] }))).requests || [] };
  return asking.list;
}
async function answerKey(id, ok) {
  const s = load(); if (!s) throw new CloudError(409, "Shivo Labs Cloud isn't set up on this PC");
  asking.at = 0;
  const k = (await apiJson("/v1/keyreqs")).requests.find((x) => x.id === id);
  if (!k) throw new CloudError(404, "That request is gone");
  if (!ok) return apiJson("/v1/keyreqs/" + id, { method: "DELETE" });
  const box = C.joinBox(k.pub, { master: s.master });
  return apiJson("/v1/keyreqs/" + id, { method: "POST", body: { pub: box.pub, box: box.box } });
}
// started with the sync loop: join by itself when the pass has Cloud, then wait for the key
export function passLoop() {
  const tick = async () => {
    try {
      if (load()) return ensureCheck();
      if (readPending()) return checkPending();
      if (passWith("files")) await passSetup(hostname());
    } catch {}
  };
  setTimeout(tick, 3000); setInterval(tick, 15000);
}

// ---------- Shivo Labs' customer list (the Worker checks the create key)
async function admin(path, method = "GET", body) {
  const r = await fetch(FILES_API + "/v1/admin/" + path, { method, headers: { "x-create-key": createKey(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new CloudError(r.status, j.error || `Shivo Labs Cloud answered ${r.status}`);
  return j;
}
// a phone joining on the home Wi-Fi (Beam's engine passes its request on): a device token of its own, and the master
// key, sealed with a key only that phone can work out (files/FORMAT.md, "Joining a phone")
async function joinPhone(pub, name, kind) {
  const s = load(); if (!s) throw new CloudError(409, "Set up Shivo Labs Cloud on the PC first (Files in Shivo Labs).");
  const d = await apiJson("/v1/devices", { method: "POST", body: { name: String(name || "Phone").slice(0, 60), kind } });
  return C.joinBox(pub, { account: s.account, device: d.device, token: d.token, master: s.master, api: s.api });
}

// ---------- the hub's /api/files/*
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = async (req) => { let b = ""; for await (const c of req) b += c; return JSON.parse(b || "{}"); };

export async function filesApi(req, res, path, url) {
  if (!path.startsWith("/api/files/")) return false;
  const what = path.slice("/api/files/".length);
  try {
    if (req.method === "GET" && what === "status") {
      const s = load();
      if (!s) {
        await checkPending().catch(() => {});
        if (load()) return json(res, 200, { ready: false, justJoined: true }), true;   // (the page asks again)
        const p = readPending();
        return json(res, 200, { ready: false, operator: !!createKey(), pass: !!passWith("files"), waiting: !!p && !p.refused, refused: !!p?.refused, company: p?.name || "" }), true;
      }
      const me = await apiJson("/v1/me").catch((e) => ({ error: e.message }));
      const { syncState, syncPairs } = await import("./files-sync.mjs");
      return json(res, 200, { ready: true, operator: !!createKey(), ...me, sync: { ...syncState, pairs: syncPairs() } }), true;
    }
    if (req.method === "GET" && what === "list") return json(res, 200, { items: await list(url.searchParams.get("parent") || "") }), true;
    if (req.method === "GET" && what === "path") {   // the folders above one, for the breadcrumb
      const out = []; let at = url.searchParams.get("id") || "";
      while (at && out.length < 50) { const it = readable(await apiJson("/v1/item/" + at)); out.unshift({ id: it.id, name: it.name }); at = it.parent; }
      return json(res, 200, { path: out }), true;
    }
    if (req.method === "GET" && what === "download") {
      const { item, stream } = await download(url.searchParams.get("id") || "", url.searchParams.get("version"));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(item.size), "cache-control": "no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}` });
      stream.on("error", () => res.destroy()); stream.pipe(res);
      return true;
    }
    if (req.method === "GET" && what === "search") return json(res, 200, { items: await search(url.searchParams.get("q")) }), true;
    if (req.method === "GET" && what === "view") {   // a preview, decrypted here (see viewFile)
      const { type, file } = await viewFile(url.searchParams.get("id") || "");
      res.writeHead(200, { "content-type": type, "content-length": String(statSync(file).size), "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff", "content-disposition": "inline" });
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
      return true;
    }
    if (req.method === "GET" && what === "trash") return json(res, 200, { items: (await apiJson("/v1/trash")).items.map(readable) }), true;
    if (req.method === "GET" && what === "devices") return json(res, 200, await apiJson("/v1/devices")), true;
    if (req.method === "GET" && what === "versions") return json(res, 200, { versions: await versions(url.searchParams.get("id") || "") }), true;
    if (req.method === "GET" && what === "shares") return json(res, 200, { shares: await shares() }), true;
    if (req.method === "GET" && what === "requests") { await claimRequests().catch(() => {}); return json(res, 200, { requests: await requests() }), true; }
    if (req.method === "GET" && what === "admin/accounts") return json(res, 200, await admin("accounts")), true;
    if (req.method === "GET" && what === "admin/devices") return json(res, 200, await admin(`accounts/${url.searchParams.get("id")}/devices`)), true;
    if (req.method === "GET" && what === "recovery") { const s = load(); return json(res, 200, { code: s ? C.recoveryCode(s.masterKey) : "" }), true; }
    // another PC of the company asks for the account's key (the hub window shows the question)
    if (req.method === "GET" && what === "asks") return json(res, 200, (await keyRequests()).map((k) => ({ id: k.id, name: k.name, kind: k.kind || "pc" }))), true;
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
    every = null;   // (something changes: search looks again)
    if (what === "answer") { const b = await readBody(req); await answerKey(String(b.id || ""), !!b.ok); return json(res, 200, { ok: true }), true; }

    if (what === "setup") {
      const b = await readBody(req);
      try { return json(res, 200, { ok: !!(await setup(b.name, String(b.code || "").trim(), String(b.recovery || "").trim())) }), true; }
      catch (e) { return json(res, e.status || 500, { error: e.message, recovery: !!e.recovery, waiting: !!e.waiting }), true; }
    }
    if (what === "sync") { (await import("./files-sync.mjs")).syncNow(); return json(res, 200, { ok: true }), true; }
    if (what === "upload") {   // body = the file; ?parent=&name=
      const parent = url.searchParams.get("parent") || "", size = Number(req.headers["content-length"]);
      if (!Number.isFinite(size)) return json(res, 411, { error: "Size missing" }), true;
      const replaces = url.searchParams.get("replaces");   // a new version of an existing file
      if (replaces) { const it = readable(await apiJson("/v1/item/" + replaces)); return json(res, 200, await upload(it.parent, it.name, size, req, replaces)), true; }
      const name = await freeName(parent, cleanName(url.searchParams.get("name")));
      return json(res, 200, await upload(parent, name, size, req)), true;
    }
    const b = await readBody(req), s = load();
    if (what === "mkdir") {
      const name = await freeName(b.parent || "", cleanName(b.name));
      return json(res, 200, readable(await apiJson("/v1/folders", { method: "POST", body: { parent: b.parent || "", name: C.encName(s.masterKey, name) } }))), true;
    }
    if (what === "rename") {
      const it = readable(await apiJson("/v1/item/" + b.id));
      const name = cleanName(b.name) === it.name ? it.name : await freeName(it.parent, cleanName(b.name));
      return json(res, 200, readable(await apiJson("/v1/item/" + b.id, { method: "PATCH", body: { name: C.encName(s.masterKey, name) } }))), true;
    }
    if (what === "move") return json(res, 200, readable(await apiJson("/v1/item/" + b.id, { method: "PATCH", body: { parent: b.parent || "" } }))), true;
    if (what === "delete") return json(res, 200, await apiJson("/v1/item/" + b.id, { method: "DELETE" })), true;
    if (what === "restore") return json(res, 200, readable(await apiJson(`/v1/item/${b.id}/restore`, { method: "POST" }))), true;
    if (what === "version-restore") return json(res, 200, readable(await apiJson(`/v1/item/${b.id}/versions/${Number(b.version)}/restore`, { method: "POST" }))), true;
    if (what === "admin/new") return json(res, 200, await admin("accounts", "POST", { name: b.name, plan: b.plan, paidUntil: b.paidUntil })), true;
    if (what === "admin/edit") { const { id, ...rest } = b; return json(res, 200, await admin("accounts/" + id, "PATCH", rest)), true; }
    if (what === "admin/code") return json(res, 200, await admin(`accounts/${b.id}/code`, "POST", {})), true;
    if (what === "admin/takedown") return json(res, 200, await admin("takedown", "POST", { link: b.link })), true;
    if (what === "share") return json(res, 200, await makeShare(b.id, b.days, b.password)), true;
    if (what === "share-folder") return json(res, 200, await shareFolder(String(b.id || ""), b.days, b.password)), true;
    if (what === "open-folder") {   // the Shivo Cloud folder on this PC, in Explorer
      const { cloudDir } = await import("./files-sync.mjs");
      mkdirSync(cloudDir(), { recursive: true });
      (await import("node:child_process")).spawn("explorer.exe", [cloudDir()], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
      return json(res, 200, { ok: true }), true;
    }
    if (what === "share-remove") return json(res, 200, await apiJson("/v1/shares/" + b.id, { method: "DELETE" })), true;
    if (what === "request") return json(res, 200, await makeRequest(b.folder || "", b.title, b.days)), true;
    if (what === "request-remove") return json(res, 200, await apiJson("/v1/requests/" + b.id, { method: "DELETE" })), true;
    if (what === "device-remove") return json(res, 200, await apiJson("/v1/devices/" + b.id, { method: "DELETE" })), true;
    if (what === "join") {   // from Beam's engine on this PC only (it checked the phone's Beam key, on the home Wi-Fi)
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(b.pub || "")) return json(res, 400, { error: "Bad key" }), true;
      return json(res, 200, await joinPhone(b.pub, b.name, b.kind)), true;
    }
    return json(res, 404, { error: "Not found" }), true;
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) }), true;
  }
}
