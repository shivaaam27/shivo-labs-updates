// Mirror: the iPhone's screen in the hub, wirelessly, on any iOS version (AirPlay screen mirroring).
// The receiver is plain JavaScript inside the hub (airplay/receiver.mjs): no extra program, so Windows
// Smart App Control has nothing to block. It advertises "Shivo Labs" on the Wi-Fi, takes the iPhone's
// mirroring stream and hands over whole H.264/H.265 frames, which go to the page as a binary stream and
// are decoded there by the PC's graphics chip (WebCodecs). The latest full picture and the frames after it
// are kept, so a page that opens mid-stream shows the phone at once.
//
// When a phone connects, the picture opens by itself in a floating window (engines/mirror-window.ps1: a real
// window hosted by Windows PowerShell with Microsoft's signed WebView2 files; always on top, phone-shaped).
//
// A preview copy can run next to the real one: HUB_MIRROR_NAME="Shivo Labs Dev" HUB_MIRROR_PORTS=7200 gives
// another receiver with its own name, ports (7200, 7300, 7211, 6200, 6201) and identity.
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createReceiver } from "./airplay/receiver.mjs";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = process.env.HUB_MIRROR_NAME || "Shivo Labs";
const BASE = Number(process.env.HUB_MIRROR_PORTS) || 0;
const PORTS = BASE ? { rtsp: BASE, mirror: BASE + 100, timing: BASE + 11, audioData: BASE - 1000, audioControl: BASE - 999 } : {};
const DATA = join(process.env.LOCALAPPDATA || homedir(), "Shivo Labs", "mirror" + (NAME === "Shivo Labs" ? "" : "-" + NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")));
// The screen size we tell the phone we have. It fits its picture inside it, so a square "screen" gives a sharp
// picture both upright and sideways (a TV-shaped 1920x1080 makes an upright phone only ~500 pixels wide).
const [W, H] = (process.env.HUB_MIRROR_SIZE || "1920x1920").split("x").map(Number);

const state = { wanted: false, lastFrameAt: 0, frames: 0, log: [], rx: { running: false, phase: "idle" }, view: null };
const log = (s) => { for (const l of String(s).split(/\r?\n/)) if (l.trim()) { state.log.push(new Date().toTimeString().slice(0, 8) + "  " + l.trim().slice(0, 300)); if (state.log.length > 200) state.log.shift(); } };

// ---------- settings (just one for now)
const SETTINGS = join(DATA, "settings.json");
let settings = { autoFloat: true };
try { settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS, "utf8")) }; } catch {}
const saveSettings = () => { try { mkdirSync(DATA, { recursive: true }); writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch {} };

let receiver = null, lastPhase = "idle";
function rx() {
  if (!receiver) receiver = createReceiver({ name: NAME, dataDir: DATA, ports: PORTS, width: W, height: H, log, onFrame: emit, onState });
  return receiver;
}
function onState(s) {
  state.rx = s;
  if (s.phase === "idle") { gop = []; if (lastPhase !== "idle") { setTimeout(() => { if (state.rx.phase === "idle") closeFloat(); }, 3000); float.closedByUser = false; } }
  if (s.phase === "streaming" && lastPhase !== "streaming" && settings.autoFloat && !float.closedByUser) openFloat();
  lastPhase = s.phase;
}
function start() { try { rx().start(); state.wanted = true; return true; } catch (e) { log("couldn't start: " + e.message); return false; } }
function stop() { state.wanted = false; receiver?.stop(); closeFloat(); }
// always on in the real hub (and in a named preview copy): an iPhone can find the receiver whenever the hub runs
export function superviseMirror() { setTimeout(() => { start(); if (!webview2()) fetchWebview2(); }, 2500); }

// ---------- frames -> pages (length-prefixed binary over a long HTTP response)
const clients = new Set();     // { res, needKey }
let gop = [], gopBytes = 0;                   // the latest key frame and the frames after it, for pages that join mid-stream
const rate = { n: 0, bytes: 0, at: Date.now(), fps: 0, kbps: 0 };
const packFrame = (f) => {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(9 + f.data.length, 0); head[4] = (f.key ? 1 : 0) | (f.codec === "h265" ? 2 : 0);
  head.writeUInt32BE(f.ts >>> 0, 5); head.writeUInt32BE(f.arrived >>> 0, 9);
  return Buffer.concat([head, f.data]);
};
function emit(f) {
  f.arrived = Date.now() >>> 0;
  state.frames++; state.lastFrameAt = Date.now();
  rate.n++; rate.bytes += f.data.length;
  const dt = Date.now() - rate.at;
  if (dt >= 1000) { rate.fps = Math.round(rate.n * 1000 / dt); rate.kbps = Math.round(rate.bytes * 8 / dt); rate.n = 0; rate.bytes = 0; rate.at = Date.now(); }
  // the last full picture and everything after it (the phone rarely sends a new full one), up to ~60 MB
  if (f.key) { gop = [f]; gopBytes = f.data.length; } else if (gop.length && gopBytes < 60e6) { gop.push(f); gopBytes += f.data.length; }
  const buf = packFrame(f);
  for (const c of clients) {
    if (c.res.writableEnded) { clients.delete(c); continue; }
    if (c.needKey && !f.key) continue;
    if (c.res.writableLength > 4e6) { c.needKey = true; continue; } // falling behind: skip to the next full picture
    c.needKey = false; c.res.write(buf);
  }
}

// ---------- the floating window
const float = { proc: null, closedByUser: false, closing: false, wantedOpen: false };
// Microsoft's WebView2 files: an installed copy carries them next to the hub (..\wv2). The repo (Shivam's PC) fetches
// them once with installer\get-webview2.ps1 (fixed version, signature checked) into %LOCALAPPDATA%\Shivo Labs\wv2;
// a NuGet package cache is used too if there is one.
const WV2 = join(process.env.LOCALAPPDATA || homedir(), "Shivo Labs", "wv2");
const hasWv2 = (d) => ["Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.Wpf.dll", "WebView2Loader.dll"].every((f) => existsSync(join(d, f)));
function webview2() {
  for (const d of [join(HUB, "..", "wv2"), WV2]) if (hasWv2(d)) return { lib: d, loader: d };
  const pkg = join(homedir(), ".nuget", "packages", "microsoft.web.webview2");
  try {
    const v = readdirSync(pkg).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (v && existsSync(join(pkg, v, "lib", "net462", "Microsoft.Web.WebView2.Wpf.dll"))) return { lib: join(pkg, v, "lib", "net462"), loader: join(pkg, v, "runtimes", "win-x64", "native") };
  } catch {}
  return null;
}
let wv2Fetch = null;
function fetchWebview2() {
  const script = join(HUB, "..", "installer", "get-webview2.ps1");
  if (!existsSync(script)) return Promise.resolve(false);
  return (wv2Fetch ??= new Promise((ok) => {
    log("floating window: getting Microsoft's WebView2 files");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", WV2, "-Cache", WV2 + "-cache"],
      { windowsHide: true, timeout: 300000 }, (e, out, err) => {
        wv2Fetch = null;
        if (e) log("floating window: couldn't get WebView2 (" + String(err || e.message).trim().split(/\r?\n/)[0] + ")");
        ok(hasWv2(WV2));
      });
  }));
}
function openFloat() {
  if (float.proc) return true;
  const wv = webview2();
  if (!wv) {   // the repo without the files yet: fetch them, then open (if the phone is still there)
    fetchWebview2().then((ok) => { if (ok && !float.proc && (state.rx.phase === "streaming" || float.wantedOpen)) openFloat(); else if (!ok) log("floating window: Microsoft's WebView2 files weren't found"); });
    float.wantedOpen = true;
    return true;
  }
  float.wantedOpen = false;
  const port = process.env.HUB_PORT || process.argv[2] || 4800;
  const aspect = state.rx.width && state.rx.height ? state.rx.width / state.rx.height : 886 / 1920;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", join(HUB, "engines", "mirror-window.ps1"),
    "-Url", `http://localhost:${port}/mirror-float.html`, "-Lib", wv.lib, "-Loader", wv.loader, "-DataDir", DATA,
    "-Icon", join(HUB, "shivo-labs.ico"), "-Aspect", aspect.toFixed(4)];
  const p = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  float.proc = p; float.closing = false;
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  p.on("exit", (code) => {
    if (float.proc === p) float.proc = null;
    if (code && err.trim()) log("floating window: " + err.trim().split(/\r?\n/)[0]);
    if (!float.closing && state.rx.phase !== "idle") float.closedByUser = true;   // closed by hand: not again this session
  });
  p.on("error", (e) => log("floating window: " + e.message));
  log("floating window opened");
  return true;
}
function closeFloat() { float.wantedOpen = false; if (!float.proc) return; float.closing = true; try { float.proc.kill(); } catch {} float.proc = null; }

// ---------- firewall: Node must be allowed to take connections from the Wi-Fi (asked once, Windows confirms)
const ps = (cmd) => new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true }, (e, out) => ok(e ? "" : String(out))));
const NODE = process.execPath.replace(/'/g, "''");
let fw = { ok: true, at: 0, busy: false };   // checked in the background (PowerShell takes a few seconds), at most once a minute
function refreshFirewall() {
  if (fw.busy) return; fw.busy = true;
  ps(`$r = Get-NetFirewallApplicationFilter -Program '${NODE}' -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }; ` +
    `[bool]($r | Where-Object Action -eq 'Allow') -and -not [bool]($r | Where-Object Action -eq 'Block')`)
    .then((o) => { fw = { ok: /True/.test(o), at: Date.now(), busy: false }; });
}
const firewallOk = () => { if (Date.now() - fw.at > 60000) refreshFirewall(); return fw.ok; };
function addFirewall() {
  // allow this Node for the local network only; drop Windows' own "block" entries for it (made when its prompt was cancelled)
  const rule = `Get-NetFirewallApplicationFilter -Program '${NODE}' | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule; ` +
    `New-NetFirewallRule -DisplayName 'Shivo Labs Mirror' -Direction Inbound -Program '${NODE}' -RemoteAddress LocalSubnet -Action Allow -Profile Any`;
  spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${rule.replace(/"/g, '`"')}"`], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 1e5) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

export async function mirrorApi(req, res, path) {
  if (!path.startsWith("/api/mirror/")) return false;
  const what = path.slice("/api/mirror/".length);
  if (req.method === "GET" && what === "status") {
    const s = state.rx, v = state.view && Date.now() - state.view.at < 3000 ? state.view : null;
    return json(res, 200, { installed: true, running: !!s.running, name: NAME, phase: s.phase, client: s.client?.name || null, paused: !!s.paused,
      codec: s.codec, width: s.width, height: s.height, receiving: Date.now() - state.lastFrameAt < 2500, frames: state.frames,
      float: !!float.proc, autoFloat: settings.autoFloat, speed: { phoneFps: Date.now() - state.lastFrameAt < 1500 ? rate.fps : 0, kbps: Date.now() - state.lastFrameAt < 1500 ? rate.kbps : 0, ...(v || {}) },
      firewall: firewallOk(), log: state.log.slice(-40) }), true;
  }
  if (req.method === "GET" && what === "stream") {  // binary frames: [len u32][flags u8][ts u32][arrived u32][Annex-B data]
    res.socket?.setNoDelay(true);   // send each picture at once (without this Windows holds small writes back ~40-200 ms)
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.flushHeaders();
    const c = { res, needKey: false };
    for (const f of gop) res.write(packFrame(f));
    clients.add(c);
    req.on("close", () => clients.delete(c));
    return true;
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
  if (what === "start") return json(res, 200, { ok: start() }), true;
  if (what === "stop") { stop(); return json(res, 200, { ok: true }), true; }
  if (what === "firewall") { addFirewall(); setTimeout(() => { fw.at = 0; refreshFirewall(); }, 8000); return json(res, 200, { ok: true }), true; }
  if (what === "float") {
    const { open } = await readJson(req);
    if (open) { float.closedByUser = false; return json(res, 200, { ok: openFloat() }), true; }
    float.closedByUser = state.rx.phase !== "idle"; closeFloat(); return json(res, 200, { ok: true }), true;
  }
  if (what === "settings") {
    const b = await readJson(req);
    if (typeof b.autoFloat === "boolean") { settings.autoFloat = b.autoFloat; saveSettings(); }
    return json(res, 200, settings), true;
  }
  if (what === "seen") {   // how the picture is keeping up where it is shown (for the speed numbers)
    const b = await readJson(req);
    state.view = { where: String(b.where || ""), decoder: String(b.decoder || ""), inFps: +b.inFps || 0, drawFps: +b.drawFps || 0, lagMs: +b.lagMs || 0, queue: +b.queue || 0, at: Date.now() };
    return json(res, 200, { ok: true }), true;
  }
  return json(res, 404, { error: "Not found" }), true;
}
