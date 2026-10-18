// X Tools inside the hub. The installed X Tools' engine (Engine.ps1) runs in a hidden PowerShell started by
// xtools-bridge.ps1; this file passes the page's commands to it and streams its events (progress, the
// Apple 2FA code question) back to the page. The Apple password only passes through, never stored or logged.
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { hostname } from "node:os";
import { listUsb, describe, watch as watchDevices } from "./idevice.mjs";
import { startPairHost } from "./pairhost.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The hub's own copy of the X Tools engine, refreshed from this repo each time it starts (x-tools/installer/src).
// No update.json: X Tools no longer updates itself; it changes with the repo like the rest of the hub.
const ENGINE_DIR = join(process.env.LOCALAPPDATA || "", "Shivo Labs", "xtools-engine");
const SRC = join(here, "..", "..", "x-tools", "installer", "src");
const ENGINE_FILES = [["host", "Engine.ps1"], ["Engine", "provision.sh"], ["", "version.txt"], ["host", "update-key.xml"]];
const WIFI_SH = join(here, "..", "..", "x-tools", "wifi", "wifi.sh");   // Wi-Fi installs (x-tools/wifi/README.md)
function syncEngine() {
  mkdirSync(ENGINE_DIR, { recursive: true });
  for (const [dir, name] of ENGINE_FILES) copyFileSync(join(SRC, dir, name), join(ENGINE_DIR, name));
  if (existsSync(WIFI_SH)) copyFileSync(WIFI_SH, join(ENGINE_DIR, "wifi.sh"));
}
const INCOMING = join(process.env.LOCALAPPDATA || "", "Fabra Labs", "incoming");  // .ipa files added in the hub
const COMMANDS = new Set(["status", "setup", "device", "signIn", "signOut", "install", "renew", "forget", "findIpas", "version", "answer", "cancel", "summary", "wifiPhones"]);
// X Tools allows one user at a time (it drives the iPhone and Linux); someone else holds it: the old separate X Tools
// window, another Shivo Labs window, or a test copy of the hub.
const BUSY = "X Tools is already in use somewhere else on this PC (another Shivo Labs window, a test copy, or the old X Tools window). Close it, then try again.";

let bridge = null, seq = 0, buf = "", stopWanted = false;
const pending = new Map(), listeners = new Set();
const broadcast = (evt) => { const line = `data: ${JSON.stringify(evt)}\n\n`; for (const res of listeners) res.write(line); };

// ---------- the device, live (idevice.mjs, Apple's device service; no engine needed for the cable)
// A phone on the cable comes first. When several are plugged in, the one already shown stays, otherwise the last one
// plugged in. With none on the cable, a phone set up for Wi-Fi that is awake on this Wi-Fi is shown instead
// (link: "wifi"; installs and renews then go over Wi-Fi). The page hears every change at once.
const dev = { current: null, view: undefined, watcher: null, busy: null, again: false };   // view undefined: not looked yet
async function refreshDevice() {
  if (dev.busy) { dev.again = true; return dev.busy; }
  dev.busy = (async () => {
    let usb = [];
    try { usb = await listUsb(); } catch {}   // Apple's device service isn't running: nothing is connected
    const cur = usb.find((d) => d.udid === dev.current?.udid) || usb[usb.length - 1] || null;
    let view = null;
    if (!cur) view = await wifiView();
    else {
      try {
        const d = await describe(cur);
        view = { udid: d.udid, name: d.name, kind: d.kind, model: d.model, ios: d.ios, apps: d.apps, expiry: d.expiry };
      } catch (e) {   // not trusted yet (locked, or "Trust" not tapped)
        view = { udid: cur.udid, name: "Your device", kind: "iPhone", untrusted: true, error: String(e.message || e) };
      }
    }
    if (cur && view && !view.untrusted) view.wifi = wifiReady.get(view.udid) ?? null;
    const changed = JSON.stringify(view) !== JSON.stringify(dev.view);
    dev.current = cur; dev.view = view;
    if (changed) broadcast({ event: "device", data: view });
    if (cur && view && !view.untrusted && !wifiReady.has(view.udid)) wifiPair(view.udid, view.name);
    return view;
  })();
  try { return await dev.busy; }
  finally { dev.busy = null; if (dev.again) { dev.again = false; refreshDevice(); } }
}
// With nothing on the cable: a phone set up for Wi-Fi, if one answers. Looked for at most every 20 s while one is
// found and every 60 s while none is (a miss searches this PC's whole networks), or now after an install. Needs the
// engine (Linux), so only while the X Tools page is open.
const wifiSeen = { at: 0, view: null };
async function wifiView(now = false) {
  if (!listeners.size) return null;
  if (!now && Date.now() - wifiSeen.at < (wifiSeen.view ? 20000 : 60000)) return wifiSeen.view;
  wifiSeen.at = Date.now();
  let view = null;
  try {
    const p = (await call("wifiPhones", { look: true }) || []).find((x) => x.reachable);
    if (p) view = { udid: p.udid, name: p.name || "iPhone", kind: "iPhone", apps: await call("wifiApps", { udid: p.udid }), expiry: {}, link: "wifi", wifi: true };
  } catch {}
  wifiSeen.view = view;
  return view;
}

// A trusted phone on the cable is quietly set up for Wi-Fi installs (once; nothing shows on the phone). After that
// X Tools can install and renew it without the cable while it is awake on the same Wi-Fi (x-tools/wifi/README.md).
const wifiReady = new Map();   // udid -> true (set up) | false (couldn't: Linux not ready yet, etc.)
function wifiPair(udid, name) {
  wifiReady.set(udid, null);
  call("wifiPair", { udid, name }).then(() => wifiReady.set(udid, true), () => wifiReady.delete(udid))
    .finally(() => { if (dev.view?.udid === udid) { dev.view = { ...dev.view, wifi: wifiReady.get(udid) ?? null }; broadcast({ event: "device", data: dev.view }); } });
}
// Pair without a cable (iOS 27; x-tools/wifi/README.md): this PC shows up on the iPhone under Settings > Developer >
// Paired Macs > Other Devices; the person taps it and types the code the page shows. One at a time; the page hears
// "pair" events: {step}, {pin}, {paired}, {error}.
const pairing = { host: null };
async function pairStart() {
  if (pairing.host) return;
  await call("wifiTools");   // the programs in Linux (downloaded the first time)
  const name = `Shivo Labs (${hostname().slice(0, 18)})`;
  pairing.host = startPairHost({ name, onEvent: (e) => {
    if (e.announce) e = { step: "waiting", name };
    broadcast({ event: "pair", data: e });
    if (e.paired) {
      call("wifiRemember", { udid: e.paired.udid, name: e.paired.name }).catch(() => {})
        .finally(() => { wifiSeen.at = 0; refreshDevice(); });
    }
    if (e.ok || e.error || e.paired) { const h = pairing.host; pairing.host = null; if (!e.paired) h?.stop(); }
  } });
}
function pairStop() { pairing.host?.stop(); pairing.host = null; }

// For "Your PC" in the phone app (pclink.mjs): renew every X Tools app that is on this phone, over Wi-Fi. Shivo Labs
// goes last: renewing it closes it on the phone. onStatus gets plain-words progress. Returns the names renewed.
export async function renewPhoneApps(udid, onStatus = () => {}) {
  try {
    onStatus("Looking for your iPhone on the Wi-Fi");
    const onPhone = (await call("wifiApps", { udid })) || [];
    const isOn = (a) => onPhone.some((x) => x.bundleId === a.bundleId || (x.bundleId.startsWith("XTL-") && x.bundleId.endsWith("." + a.bundleId)));
    const todo = ((await call("status"))?.apps || []).filter(isOn)
      .sort((a, b) => (a.bundleId === "com.shivolabs.labs") - (b.bundleId === "com.shivolabs.labs"));
    if (!todo.length) throw new Error("No apps from X Tools on this iPhone.");
    for (const [i, a] of todo.entries()) {
      // iOS won't close an app that is on screen to install it ("termination resistance"): the phone app hears this,
      // steps aside to the Home Screen (ShivoNative.goHome), and then the install can go ahead
      if (a.bundleId === "com.shivolabs.labs") { onStatus("Closing Shivo Labs to update it"); await new Promise((r) => setTimeout(r, 10000)); }
      onStatus(`Renewing ${a.name}${todo.length > 1 ? ` (${i + 1} of ${todo.length})` : ""}`);
      await call("renew", { bundleId: a.bundleId, udid, wifi: true });
    }
    return todo.map((a) => a.name);
  } finally { if (bridge && !listeners.size && !pending.size) bridge.stdin.end(); }   // let go of the engine again
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

// ---------- from the source (a PC with the Shivo Labs repo, e.g. Shivam's): build the iPhone app here (xtool in
// WSL, phone/local-build) and send the phone app's screens over the air (phone/install/Publish-OTA.ps1), without
// GitHub's build minutes. One job at a time; its lines go to the page as "dev" events.
const REPO = join(here, "..", "..");
const DEV = { build: join(REPO, "phone", "local-build", "build.ps1"), ota: join(REPO, "phone", "install", "Publish-OTA.ps1"),
  hub: join(REPO, "installer", "publish-hub-ota.ps1") };   // the laptop app's update for installed copies (no GitHub)
const IPA_OUT = join(process.env.USERPROFILE || "", "Downloads", "ShivoLabs.ipa");
const devJob = { kind: null, proc: null, tail: [], started: 0, result: null };
const devAvailable = () => existsSync(join(REPO, ".git")) && existsSync(DEV.build) && existsSync(DEV.ota);
const devState = () => ({ available: devAvailable(), running: devJob.kind, started: devJob.started, tail: devJob.tail.slice(-40), result: devJob.result });
function devRun(kind) {
  if (!devAvailable()) throw new Error("This PC doesn't have the Shivo Labs source.");
  if (devJob.proc) throw new Error(devJob.kind === "build" ? "The iPhone app is still being built." : devJob.kind === "hub" ? "The laptop update is still being sent." : "The phone update is still being sent.");
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DEV[kind], ...(kind === "build" ? ["-Out", IPA_OUT] : [])],
    { windowsHide: true, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  Object.assign(devJob, { kind, proc: p, tail: [], started: Date.now(), result: null });
  let part = "";
  const onData = (chunk) => {
    part += chunk;
    const lines = part.split(/\r?\n|\r/); part = lines.pop();
    for (let l of lines) {
      l = l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();   // (no terminal colours)
      if (!l.trim()) continue;
      devJob.tail.push(l); if (devJob.tail.length > 400) devJob.tail.splice(0, 200);
      broadcast({ event: "dev", data: { kind, line: l } });
    }
  };
  p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  const finish = (ok) => {
    if (devJob.proc !== p) return;
    devJob.proc = null; devJob.kind = null;
    devJob.result = { kind, ok, at: Date.now(), path: kind === "build" && ok ? IPA_OUT : null, tail: devJob.tail.slice(-40) };
    broadcast({ event: "dev", data: { kind, done: true, ...devJob.result } });
  };
  p.on("exit", (code) => finish(code === 0 && (kind !== "build" || existsSync(IPA_OUT))));
  p.on("error", () => finish(false));
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
    listeners.add(res); req.on("close", () => { listeners.delete(res); if (!listeners.size) { watchStop(); pairStop(); } });
    watchStart();
    if (dev.view !== undefined) res.write(`data: ${JSON.stringify({ event: "device", data: dev.view })}\n\n`);
    return true;
  }
  if (what === "dev" && req.method === "GET") return json(res, 200, { ok: true, data: devState() }), true;
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
  if (what === "pair/start" || what === "pair/stop") {
    try { what === "pair/start" ? await pairStart() : pairStop(); return json(res, 200, { ok: true }), true; }
    catch (e) { pairStop(); return json(res, 200, { ok: false, error: String(e.message || e) }), true; }
  }
  if (what === "dev/build" || what === "dev/ota" || what === "dev/hub") {
    try { devRun(what.slice(4)); return json(res, 200, { ok: true, data: devState() }), true; }
    catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }), true; }
  }
  try {
    if (what === "device") {   // look again now; ?wifi=now also looks on Wi-Fi at once (after an install), else as above
      if (url.searchParams.get("wifi") === "now") wifiSeen.at = 0;
      return json(res, 200, { ok: true, data: await refreshDevice() }), true;
    }   // look again now (e.g. after an install)
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
