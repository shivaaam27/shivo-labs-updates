// Shivo Cloud sync on the PC (files/PLAN.md, phase 2): PC folders and Shivo Cloud folders kept the same, both ways.
// Pairs: the Beam folder (Downloads\Beam <-> "Beam" at Shivo Cloud's top) and every folder added on the Beam page
// (Folders on your phone, %APPDATA%\Beam\phone-folders.json: <path> <-> "<name>" at the top).
//   up:    a new or changed file on the PC is uploaded (encrypted by files.mjs); one deleted on the PC goes to the
//          Shivo Cloud Trash.
//   down:  what the phone (or another PC) added or changed is downloaded; what it deleted goes to the Recycle Bin.
//   both changed the same file since the last sync: both are kept ("name (from Shivo Cloud).ext").
// What was synced is remembered in sync.json next to cloud.json, so nothing goes twice. Runs in the main hub only:
// every 20 s, sooner when a file changes on the PC (fs.watch), and only while Shivo Cloud is set up.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync, createReadStream, createWriteStream, watch, rmSync, realpathSync } from "node:fs";
import { join, dirname, basename, extname, relative, sep } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as F from "./files.mjs";
import * as C from "./files-crypto.mjs";

const FILES_DIR = process.env.HUB_FILES_DIR || join(process.env.APPDATA || homedir(), "Shivo Labs", "Files");
const SYNC = join(FILES_DIR, "sync.json");
const BEAM_HOME = join(process.env.APPDATA || homedir(), "Beam");
const BEAM_INBOX = process.env.HUB_SYNC_BEAM || join(homedir(), "Downloads", "Beam");
const SKIP = /^(\.|~\$)|\.part$|^desktop\.ini$|^thumbs\.db$/i;

export const syncState = { running: false, last: 0, error: "", up: 0, down: 0, busy: "" };

// ---------- what is synced with what
function pairs() {
  const out = [{ name: "Beam", local: BEAM_INBOX }];
  try {
    for (const f of JSON.parse(readFileSync(join(BEAM_HOME, "phone-folders.json"), "utf8")) || []) {
      if (f?.path && existsSync(f.path) && !out.some((p) => p.name.toLowerCase() === String(f.name).toLowerCase())) out.push({ name: String(f.name || basename(f.path)), local: f.path });
    }
  } catch {}
  return out;
}

// ---------- remembered state: per pair, the cloud folder id and every synced entry (by path inside the pair)
let st = null;
function loadState() {
  if (st) return st;
  try { st = JSON.parse(readFileSync(SYNC, "utf8")); } catch { st = {}; }
  st.seq ??= 0; st.pairs ??= {};
  return st;
}
function saveState() {
  mkdirSync(FILES_DIR, { recursive: true });
  writeFileSync(SYNC + ".tmp", JSON.stringify(st)); renameSync(SYNC + ".tmp", SYNC);
}
// entries: rel ("a/b.jpg", forward slashes) -> { id, kind, size, mtime (local, ms), version }
const P = (name) => (loadState().pairs[name] ??= { root: "", entries: {} });

// ---------- local files
function scan(root) {
  const out = new Map();   // rel -> { kind, size, mtime }
  const walk = (dir) => {
    let list = []; try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (SKIP.test(e.name)) continue;
      const full = join(dir, e.name), rel = relative(root, full).split(sep).join("/");
      try {
        const s = statSync(full);
        if (e.isDirectory()) { out.set(rel, { kind: "folder", size: 0, mtime: 0 }); walk(full); }
        else if (e.isFile()) out.set(rel, { kind: "file", size: s.size, mtime: Math.floor(s.mtimeMs) });
      } catch {}
    }
  };
  walk(root);
  return out;
}
const toRecycleBin = (path) => process.env.HUB_SYNC_NO_RECYCLE ? Promise.resolve(rmSync(path, { recursive: true, force: true })) : new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:SHIVO_DEL; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`],
  { windowsHide: true, timeout: 60000, env: { ...process.env, SHIVO_DEL: path } }, () => ok()));
const conflictName = (rel) => { const e = extname(rel); return rel.slice(0, rel.length - e.length) + " (from Shivo Labs Cloud)" + e; };

// ---------- the cloud side
async function ensureRoot(pair) {
  const p = P(pair.name);
  if (p.root) {
    try { const it = await F.apiJson("/v1/item/" + p.root); if (!it.deleted) return p.root; } catch {}
    p.root = ""; p.entries = {};
  }
  const top = await F.list("");
  const found = top.find((x) => x.kind === "folder" && x.name.toLowerCase() === pair.name.toLowerCase());
  const s = F.load();
  p.root = found ? found.id : (await F.apiJson("/v1/folders", { method: "POST", body: { parent: "", name: C.encName(s.masterKey, pair.name) } })).id;
  saveState();
  return p.root;
}
// the cloud folder id for a folder inside a pair (created when missing)
async function cloudFolder(pair, relDir) {
  const p = P(pair.name);
  if (!relDir) return p.root;
  if (p.entries[relDir]?.kind === "folder") return p.entries[relDir].id;
  const parent = await cloudFolder(pair, relDir.includes("/") ? relDir.slice(0, relDir.lastIndexOf("/")) : "");
  const name = relDir.split("/").pop(), s = F.load();
  const existing = (await F.list(parent)).find((x) => x.kind === "folder" && x.name === name);
  const id = existing ? existing.id : (await F.apiJson("/v1/folders", { method: "POST", body: { parent, name: C.encName(s.masterKey, name) } })).id;
  p.entries[relDir] = { id, kind: "folder", size: 0, mtime: 0, version: 0 };
  return id;
}
async function downloadTo(id, path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), "." + randomBytes(6).toString("hex") + ".part");
  try {
    const { item, stream } = await F.download(id);
    await pipeline(stream, createWriteStream(tmp));
    renameSync(tmp, path);   // (replaces an older copy in one step)
    return item;
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

// ---------- one round: down first (so a phone's change is never mistaken for a local deletion), then up
async function round() {
  const s = F.load(); if (!s) return;
  await F.claimRequests().catch(() => {});   // files sent through request links, so they come down like any other
  const all = pairs();
  for (const pair of all) { mkdirSync(pair.local, { recursive: true }); await ensureRoot(pair); }
  const byRoot = new Map(all.map((p) => [P(p.name).root, p]));

  // ---- down: everything that changed in Shivo Cloud since last time
  const state = loadState();
  for (let more = true; more; ) {
    const j = await F.apiJson("/v1/changes?since=" + state.seq);
    for (const raw of j.items) {
      const it = F.readable(raw);
      // which pair, and where inside it
      let pair = byRoot.get(it.parent), rel = it.name;
      if (!pair) {
        for (const p of all) {
          const e = Object.entries(P(p.name).entries).find(([, v]) => v.kind === "folder" && v.id === it.parent);
          if (e) { pair = p; rel = e[0] + "/" + it.name; break; }
        }
      }
      if (!pair || byRoot.has(it.id)) continue;   // not inside a synced folder (or a pair's own folder)
      const p = P(pair.name);
      const known = Object.entries(p.entries).find(([, v]) => v.id === it.id);
      const local = join(pair.local, ...rel.split("/"));
      if (it.deleted) {
        if (known) {
          const was = join(pair.local, ...known[0].split("/"));
          try { const ls = statSync(was); if (known[1].kind === "folder" || (ls.size === known[1].size && Math.floor(ls.mtimeMs) === known[1].mtime)) await toRecycleBin(was); } catch {}
          for (const k of Object.keys(p.entries)) if (k === known[0] || k.startsWith(known[0] + "/")) delete p.entries[k];
          syncState.down++;
        }
        continue;
      }
      if (known && known[0] !== rel) {   // renamed or moved in Shivo Labs Cloud
        const from = join(pair.local, ...known[0].split("/"));
        try { mkdirSync(dirname(local), { recursive: true }); renameSync(from, local); } catch {}
        for (const k of Object.keys(p.entries)) if (k === known[0] || k.startsWith(known[0] + "/")) { p.entries[rel + k.slice(known[0].length)] = p.entries[k]; delete p.entries[k]; }
      }
      if (it.kind === "folder") { mkdirSync(local, { recursive: true }); p.entries[rel] = { ...(p.entries[rel] || {}), id: it.id, kind: "folder", size: 0, mtime: 0, version: 0 }; continue; }
      const e = p.entries[rel];
      if (e && e.version === it.version) continue;   // ours: nothing new
      let target = local;
      if (existsSync(local)) {
        const ls = statSync(local);
        const changedHere = !e || ls.size !== e.size || Math.floor(ls.mtimeMs) !== e.mtime;
        if (changedHere && !(e === undefined && ls.size === it.size)) target = join(pair.local, ...conflictName(rel).split("/"));   // both changed: keep both
        else if (!e && ls.size === it.size) { p.entries[rel] = { id: it.id, kind: "file", size: ls.size, mtime: Math.floor(ls.mtimeMs), version: it.version }; continue; }   // first sync, same file
      }
      syncState.busy = "Downloading " + it.name;
      await downloadTo(it.id, target);
      const ns = statSync(target);
      if (target === local) p.entries[rel] = { id: it.id, kind: "file", size: ns.size, mtime: Math.floor(ns.mtimeMs), version: it.version };
      syncState.down++;
    }
    state.seq = j.seq; more = j.more; saveState();
  }

  // ---- up: what changed on the PC
  for (const pair of all) {
    const p = P(pair.name), here = scan(pair.local);
    // deleted on the PC (only what was synced before and is gone now)
    for (const [rel, e] of Object.entries(p.entries)) {
      if (here.has(rel) || !p.entries[rel]) continue;
      await F.apiJson("/v1/item/" + e.id, { method: "DELETE" }).catch(() => {});
      for (const k of Object.keys(p.entries)) if (k === rel || k.startsWith(rel + "/")) delete p.entries[k];
      syncState.up++;
    }
    // new and changed (folders first, by path order)
    for (const [rel, f] of [...here].sort((a, b) => a[0].localeCompare(b[0]))) {
      const e = p.entries[rel];
      if (f.kind === "folder") { if (!e) await cloudFolder(pair, rel); continue; }
      if (e && e.size === f.size && e.mtime === f.mtime) continue;
      const full = join(pair.local, ...rel.split("/"));
      // still being written (a Beam transfer, a copy): wait for the next round
      if (Date.now() - f.mtime < 3000) continue;
      const parent = await cloudFolder(pair, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
      syncState.busy = "Uploading " + basename(full);
      const it = await F.upload(parent, rel.split("/").pop(), f.size, createReadStream(full), e?.id);
      p.entries[rel] = { id: it.id, kind: "file", size: f.size, mtime: f.mtime, version: it.version };
      saveState();
      syncState.up++;
    }
  }
  saveState();
}

// ---------- running it
let timer = 0, working = false, again = false, watchers = [];
async function tick() {
  if (working) { again = true; return; }
  working = true; syncState.running = true;
  try { await round(); syncState.error = ""; syncState.last = Date.now(); }
  catch (e) { syncState.error = String(e.message || e); }
  finally {
    working = false; syncState.busy = "";
    if (again) { again = false; setTimeout(tick, 1000); }
  }
}
function rewatch() {
  for (const w of watchers) try { w.close(); } catch {}
  watchers = [];
  for (const pair of pairs()) {
    // (the folder's full long name: Node's Windows watcher aborts the whole process on an 8.3 short name like SHIVAM~1)
    try { mkdirSync(pair.local, { recursive: true }); watchers.push(watch(realpathSync.native(pair.local), { recursive: true }, (_, f) => { if (f && !SKIP.test(basename(String(f)))) { clearTimeout(timer); timer = setTimeout(tick, 4000); } })); } catch {}
  }
}
export function startFilesSync() {
  F.passLoop();   // a customer PC joins its company's Cloud with its pass, and gets the key
  const loop = () => { if (F.load()) tick(); };
  setTimeout(() => { rewatch(); loop(); }, 5000);
  setInterval(loop, 20000);
  setInterval(rewatch, 5 * 60000);   // (folders added on the Beam page)
}
export const syncNow = () => { if (F.load()) tick(); };
export const syncPairs = () => pairs().map((p) => ({ name: p.name, local: p.local }));
