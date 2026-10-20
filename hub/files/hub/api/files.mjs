// Shivo Cloud on the laptop (files/PLAN.md): the hub's Files module talks to the Files API on Cloudflare
// (files/worker) and does all the encryption here (files-crypto.mjs, files/FORMAT.md). The account, this PC's device
// token and the master key live in %APPDATA%\Shivo Labs\Files\cloud.json (HUB_FILES_DIR for tests); they never go
// into the repo or to the server (the master key never leaves this PC except to a phone joining on the home Wi-Fi).
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import * as C from "./files-crypto.mjs";

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
  const s = load(); if (!s) throw new CloudError(409, "Shivo Cloud isn't set up on this PC yet");
  const r = await fetch(s.api + path, {
    method, headers: { authorization: "Bearer " + s.token, ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), duplex: raw ? "half" : undefined,
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new CloudError(r.status, j.error || `Shivo Cloud answered ${r.status}`); }
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
// an item's plain bytes, as a stream
export async function download(id) {
  const s = load(), it = await apiJson("/v1/item/" + id);
  if (it.kind !== "file") throw new CloudError(400, "Not a file");
  const fileKey = C.unwrapKey(s.masterKey, it.key);
  const r = await api("/v1/file/" + id);
  return { item: readable(it), stream: Readable.fromWeb(r.body).pipe(C.decryptStream(fileKey)) };
}

// ---------- setting up, and phones joining
async function setup(name) {
  if (load()) return load();
  let createKey = "";
  try { createKey = readFileSync(CREATE_KEY_FILE, "utf8").trim(); } catch {}
  if (!createKey) throw new CloudError(403, "Shivo Cloud isn't available on this PC yet.");
  const r = await fetch(FILES_API + "/v1/account", { method: "POST", headers: { "x-create-key": createKey, "content-type": "application/json" }, body: JSON.stringify({ name }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new CloudError(r.status, j.error || "Couldn't set up Shivo Cloud");
  save({ api: FILES_API, account: j.account, device: j.device, token: j.token, master: C.b64u(randomBytes(32)), created: Date.now() });
  return load();
}
// a phone joining on the home Wi-Fi (Beam's engine passes its request on): a device token of its own, and the master
// key, sealed with a key only that phone can work out (files/FORMAT.md, "Joining a phone")
async function joinPhone(pub, name, kind) {
  const s = load(); if (!s) throw new CloudError(409, "Set up Shivo Cloud on the PC first (Files in Shivo Labs).");
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
      if (!s) return json(res, 200, { ready: false }), true;
      const me = await apiJson("/v1/me").catch((e) => ({ error: e.message }));
      const { syncState, syncPairs } = await import("./files-sync.mjs");
      return json(res, 200, { ready: true, ...me, sync: { ...syncState, pairs: syncPairs() } }), true;
    }
    if (req.method === "GET" && what === "list") return json(res, 200, { items: await list(url.searchParams.get("parent") || "") }), true;
    if (req.method === "GET" && what === "path") {   // the folders above one, for the breadcrumb
      const out = []; let at = url.searchParams.get("id") || "";
      while (at && out.length < 50) { const it = readable(await apiJson("/v1/item/" + at)); out.unshift({ id: it.id, name: it.name }); at = it.parent; }
      return json(res, 200, { path: out }), true;
    }
    if (req.method === "GET" && what === "download") {
      const { item, stream } = await download(url.searchParams.get("id") || "");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(item.size), "cache-control": "no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}` });
      stream.on("error", () => res.destroy()); stream.pipe(res);
      return true;
    }
    if (req.method === "GET" && what === "trash") return json(res, 200, { items: (await apiJson("/v1/trash")).items.map(readable) }), true;
    if (req.method === "GET" && what === "devices") return json(res, 200, await apiJson("/v1/devices")), true;
    if (req.method === "GET" && what === "recovery") { const s = load(); return json(res, 200, { code: s ? C.recoveryCode(s.masterKey) : "" }), true; }
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;

    if (what === "setup") return json(res, 200, { ok: !!(await setup((await readBody(req)).name)) }), true;
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
