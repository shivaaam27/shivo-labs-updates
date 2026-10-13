// X Tools inside the hub. The installed X Tools' engine (Engine.ps1) runs in a hidden PowerShell started by
// xtools-bridge.ps1; this file passes the page's commands to it and streams its events (progress, the
// Apple 2FA code question) back to the page. The Apple password only passes through, never stored or logged.
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { listUsb, describe, watch as watchDevices } from "./idevice.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The hub's own copy of the X Tools engine, refreshed from this repo each time it starts (x-tools/installer/src).
// No update.json: X Tools no longer updates itself; it changes with the repo like the rest of the hub.
const ENGINE_DIR = join(process.env.LOCALAPPDATA || "", "Shivo Labs", "xtools-engine");
const SRC = join(here, "..", "..", "x-tools", "installer", "src");
const ENGINE_FILES = [["host", "Engine.ps1"], ["Engine", "provision.sh"], ["", "version.txt"], ["host", "update-key.xml"]];
function syncEngine() {
  mkdirSync(ENGINE_DIR, { recursive: true });
  for (const [dir, name] of ENGINE_FILES) copyFileSync(join(SRC, dir, name), join(ENGINE_DIR, name));
}
const INCOMING = join(process.env.LOCALAPPDATA || "", "Fabra Labs", "incoming");  // .ipa files added in the hub
const COMMANDS = new Set(["status", "setup", "device", "signIn", "signOut", "install", "renew", "forget", "findIpas", "version", "answer", "cancel", "summary"]);
// X Tools allows one user at a time (it drives the iPhone and Linux); someone else holds it: the old separate X Tools
// window, another Shivo Labs window, or a test copy of the hub.
const BUSY = "X Tools is already in use somewhere else on this PC (another Shivo Labs window, a test copy, or the old X Tools window). Close it, then try again.";

let bridge = null, seq = 0, buf = "", stopWanted = false;
const pending = new Map(), listeners = new Set();
const broadcast = (evt) => { const line = `data: ${JSON.stringify(evt)}\n\n`; for (const res of listeners) res.write(line); };

// ---------- the plugged-in device, live (idevice.mjs, Apple's device service; no engine needed)
// Only USB counts: an iPhone that is only reachable over Wi-Fi is not "connected". When several are plugged in,
// the one already shown stays, otherwise the last one plugged in. The page hears every change at once.
const dev = { current: null, view: undefined, watcher: null, busy: null, again: false };   // view undefined: not looked yet
async function refreshDevice() {
  if (dev.busy) { dev.again = true; return dev.busy; }
  dev.busy = (async () => {
    let usb = [];
    try { usb = await listUsb(); } catch {}   // Apple's device service isn't running: nothing is connected
    const cur = usb.find((d) => d.udid === dev.current?.udid) || usb[usb.length - 1] || null;
    let view = null;
    if (cur) {
      try {
        const d = await describe(cur);
        view = { udid: d.udid, name: d.name, kind: d.kind, model: d.model, ios: d.ios, apps: d.apps, expiry: d.expiry };
      } catch (e) {   // not trusted yet (locked, or "Trust" not tapped)
        view = { udid: cur.udid, name: "Your device", kind: "iPhone", untrusted: true, error: String(e.message || e) };
      }
    }
    const changed = JSON.stringify(view) !== JSON.stringify(dev.view);
    dev.current = cur; dev.view = view;
    if (changed) broadcast({ event: "device", data: view });
    return view;
  })();
  try { return await dev.busy; }
  finally { dev.busy = null; if (dev.again) { dev.again = false; refreshDevice(); } }
}
function watchStart() {
  if (dev.watcher) return;
  let t = 0;
  const soon = () => { clearTimeout(t); t = setTimeout(refreshDevice, 700); };   // a device announces itself in a burst
  dev.watcher = watchDevices();
  dev.watcher.on("attach", soon); dev.watcher.on("detach", soon);
  // an untrusted device becomes trusted without a plug event: look again while one waits for "Trust"
  dev.poll = setInterval(() => { if (listeners.size && dev.view?.untrusted) refreshDevice(); }, 3000);
  refreshDevice();
}
function watchStop() { dev.watcher?.stop(); dev.watcher = null; clearInterval(dev.poll); }

function start() {
  if (bridge) return bridge;
  if (!existsSync(join(SRC, "host", "Engine.ps1"))) throw new Error("The X Tools engine is missing from the Shivo Labs folder.");
  syncEngine();
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", join(here, "xtools-bridge.ps1"), "-EngineDir", ENGINE_DIR], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    // after the restart that Linux setup needs, Windows reopens the hub on X Tools
    env: { ...process.env, SHIVO_REOPEN: `wscript.exe "${join(here, "..", "Shivo Labs.vbs")}" /open:xtools` } });
  bridge = p; buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.event === "busy") { for (const [, w] of pending) w.reject(new Error(BUSY)); pending.clear(); continue; }
      if (m.event) { broadcast(m); continue; }
      const w = pending.get(m.id); if (!w) continue;
      pending.delete(m.id);
      m.ok ? w.resolve(m.data) : w.reject(new Error(m.error || "Something went wrong."));
      if (stopWanted && !pending.size) { stopWanted = false; p.stdin.end(); }
    }
  });
  p.on("exit", () => {
    if (bridge === p) bridge = null;
    for (const [, w] of pending) w.reject(new Error(BUSY));
    pending.clear();
  });
  p.on("error", () => {});
  return p;
}

function call(cmd, args) {
  stopWanted = false;
  const p = start(), id = String(++seq);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    p.stdin.write(JSON.stringify({ id, cmd, args: args ?? null }) + "\n");
  });
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = async (req) => { let s = ""; for await (const c of req) { s += c; if (s.length > 1e6) break; } return JSON.parse(s || "{}"); };
const cleanName = (n) => basename(String(n || "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 160) || "app.ipa";

// Handles /api/xtools/...; returns false if the path isn't X Tools'.
export async function xtoolsApi(req, res, path, url) {
  if (!path.startsWith("/api/xtools/")) return false;
  const what = path.slice("/api/xtools/".length);
  if (what === "events" && req.method === "GET") {  // progress and questions, as they happen
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": hello\n\n");
    listeners.add(res); req.on("close", () => { listeners.delete(res); if (!listeners.size) watchStop(); });
    watchStart();
    if (dev.view !== undefined) res.write(`data: ${JSON.stringify({ event: "device", data: dev.view })}\n\n`);
    return true;
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
  try {
    if (what === "device") return json(res, 200, { ok: true, data: await refreshDevice() }), true;   // look again now (e.g. after an install)
    if (what === "call") {
      const { cmd, args } = await readJson(req);
      if (!COMMANDS.has(cmd)) return json(res, 400, { ok: false, error: "Unknown command" }), true;
      return json(res, 200, { ok: true, data: await call(cmd, args) }), true;
    }
    if (what === "stop") {  // left the X Tools page: let go of the engine (and its lock) unless it's still working
      if (bridge) { if (pending.size) stopWanted = true; else bridge.stdin.end(); }
      return json(res, 200, { ok: true }), true;
    }
    if (what === "upload") {  // a dropped or chosen .ipa: keep a copy, then read its name and version
      const name = cleanName(url.searchParams.get("name"));
      if (!/\.ipa$/i.test(name)) return json(res, 400, { ok: false, error: "Choose an .ipa file." }), true;
      mkdirSync(INCOMING, { recursive: true });
      const file = join(INCOMING, name);
      try { await pipeline(req, createWriteStream(file)); }
      catch (e) { await unlink(file).catch(() => {}); throw e; }
      return json(res, 200, { ok: true, data: await call("summary", { path: file }) }), true;
    }
  } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }), true; }
  return json(res, 404, { error: "Not found" }), true;
}
