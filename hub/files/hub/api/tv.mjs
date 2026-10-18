// TV: Android TV and Google TV sets on the same Wi-Fi, run from the hub.
// Finds them (SSDP / DIAL, the way phones find a Chromecast), talks to them with Google's adb over Wi-Fi
// (the TV needs Developer options > USB debugging on, once), and:
//   - puts the Shivo Labs home screen on them (tv/home) and makes it the home screen, or gives the TV's own one back;
//   - lists every app, opens it, switches system apps off and on again (pm disable-user / enable: nothing is lost),
//     and uninstalls apps the user added;
//   - works as a remote (keys and typing) with a picture of the TV's screen.
// adb is Google's own program (signed by Google LLC); the hub downloads it from dl.google.com the first time.
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(HUB, "..");
const DATA = join(process.env.LOCALAPPDATA || homedir(), "Shivo Labs", "tv");
const ADB_URL = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
const PKG = "labs.shivo.tv";
// The stock home screens ours stands in for (Google TV, Android TV, older Android TV). Only ones on the TV are touched.
// Google TV's setup helper (setupwraith) also answers Home with a higher rank than any normal app, so it is switched off too
const STOCK = ["com.google.android.apps.tv.launcherx", "com.google.android.tvlauncher", "com.google.android.leanbacklauncher", "com.google.android.tungsten.setupwraith"];
// System parts that must never be switched off from here, even when they show up as apps.
const KEEP = new Set(["android", "com.android.systemui", "com.android.tv.settings", "com.android.settings", "com.google.android.gms",
  "com.google.android.gsf", "com.android.vending", "com.google.android.packageinstaller", "com.android.packageinstaller",
  "com.android.shell", "com.google.android.inputmethod.latin", "com.google.android.leanback.ime", "com.google.android.tungsten.setupwraith",
  "com.google.android.tv.remote.service", PKG, ...STOCK]);
const KEYS = { up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, home: 3, menu: 82, volup: 24, voldown: 25, mute: 164, power: 26,
  play: 85, rew: 89, ff: 90, next: 87, prev: 88, chup: 166, chdown: 167, input: 178, settings: 176, apps: 284, search: 84, guide: 172, info: 165, del: 67 };

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = async (req) => { let s = ""; for await (const c of req) s += c; try { return JSON.parse(s || "{}"); } catch { return {}; } };
const isIp = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s || "") && s.split(".").every((n) => Number(n) <= 255);
// adb's name for a TV: ip:5555 (older TVs, "USB debugging"), or ip:<port> when it uses Wireless debugging
const serials = new Map();
const serial = (ip) => serials.get(ip) || `${ip}:5555`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- remembered TVs
const FILE = join(DATA, "tvs.json");
let tvs = [];
try { tvs = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
const saveTvs = () => { try { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(tvs, null, 2)); } catch {} };
function remember(t) {
  const old = tvs.find((x) => x.ip === t.ip || (t.id && x.id === t.id));
  if (old) Object.assign(old, t); else tvs.push(t);
  saveTvs();
}

// ---------- adb: ours, or the one already on this PC
const adbState = { busy: false, error: "" };
function adbPath() {
  const places = [join(DATA, "platform-tools", "adb.exe"), join(homedir(), ".fabra-labs-ai", "android-build", "platform-tools", "adb.exe")];
  return places.find(existsSync) || null;
}
const ps = (script) => new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 120000 }, (e, out) => ok(e ? null : String(out).trim())));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
async function getAdb() {
  if (adbPath() || adbState.busy) return;
  adbState.busy = true; adbState.error = "";
  try {
    mkdirSync(DATA, { recursive: true });
    const zip = join(DATA, "platform-tools.zip");
    const r = await fetch(ADB_URL);
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    await writeFile(zip, Buffer.from(await r.arrayBuffer()));
    const tmp = join(DATA, "platform-tools-new");
    rmSync(tmp, { recursive: true, force: true });
    // unpack, then keep it only if adb.exe is really signed by Google
    const signer = await ps(`Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(tmp)} -Force; $s = Get-AuthenticodeSignature ${q(join(tmp, "platform-tools", "adb.exe"))}; if ($s.Status -eq 'Valid') { $s.SignerCertificate.Subject }`);
    if (!signer || !/O=Google LLC/.test(signer)) throw new Error("adb from Google didn't pass the signature check");
    rmSync(join(DATA, "platform-tools"), { recursive: true, force: true });
    await ps(`Move-Item -LiteralPath ${q(join(tmp, "platform-tools"))} -Destination ${q(join(DATA, "platform-tools"))}`);
    rmSync(tmp, { recursive: true, force: true }); rmSync(zip, { force: true });
    if (!adbPath()) throw new Error("adb could not be unpacked");
  } catch (e) { adbState.error = String(e.message || e); }
  adbState.busy = false;
}
// ADB_MDNS=0: the hub finds Wireless debugging itself (below), so adb's own auto-connect doesn't name TVs differently
const ADB_ENV = { ...process.env, ADB_MDNS: "0" };
function adb(args, { timeout = 20000, binary = false } = {}) {
  const exe = adbPath();
  if (!exe) return Promise.resolve({ ok: false, out: "", err: "adb is not set up yet" });
  return new Promise((ok) => execFile(exe, args, { windowsHide: true, timeout, env: ADB_ENV, maxBuffer: 64 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" },
    (e, out, err) => ok({ ok: !e, out: binary ? out : String(out || ""), err: String(err || (e && e.message) || "") })));
}
const sh = (ip, cmd, o) => adb(["-s", serial(ip), "shell", cmd], o);

// ---------- finding TVs: SSDP for DIAL devices, then a look at each one
const ipv4s = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal && !/^169\.254\./.test(i.address) && !/^172\.(1[6-9]|2\d|3[01])\./.test(i.address));
const portOpen = (ip, port, ms = 800) => new Promise((ok) => {
  const s = net.connect({ port, host: ip }, () => { s.destroy(); ok(true); });
  s.on("error", () => ok(false)); s.setTimeout(ms, () => { s.destroy(); ok(false); });
});
function ssdp(ms = 3500) {
  return new Promise((done) => {
    const found = new Map(), socks = [];
    const msg = Buffer.from("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n");
    for (const nic of ipv4s()) {
      const s = createSocket("udp4");
      s.on("error", () => {});
      s.on("message", (buf, from) => {
        const loc = /^location:\s*(.+)$/im.exec(String(buf))?.[1]?.trim();
        if (loc && !found.has(from.address)) found.set(from.address, loc);
      });
      s.bind(0, nic.address, () => { try { s.send(msg, 1900, "239.255.255.250"); setTimeout(() => s.send(msg, 1900, "239.255.255.250"), 400); } catch {} });
      socks.push(s);
    }
    setTimeout(() => { socks.forEach((s) => { try { s.close(); } catch {} }); done(found); }, ms);
  });
}
const tag = (xml, t) => new RegExp(`<${t}>([^<]*)</${t}>`, "i").exec(xml)?.[1]?.trim() || "";
async function lookAt(ip, location) {
  let name = "", maker = "", model = "", id = "";
  try {
    const xml = await (await fetch(location || `http://${ip}:8008/ssdp/device-desc.xml`, { signal: AbortSignal.timeout(2500) })).text();
    name = tag(xml, "friendlyName"); maker = tag(xml, "manufacturer"); model = tag(xml, "modelName"); id = tag(xml, "UDN").replace(/^uuid:/, "");
  } catch {}
  // Android TV and Google TV run Google's TV remote service on 6466/6467
  const android = await portOpen(ip, 6466) || await portOpen(ip, 6467);
  return { ip, name: name || ip, maker, model, id, android };
}
const scan = { busy: false, at: 0, found: [] };
async function find() {
  if (scan.busy) return;
  scan.busy = true;
  try {
    const seen = await ssdp();
    const looked = await Promise.all([...seen].map(([ip, loc]) => lookAt(ip, loc)));
    // remembered TVs that didn't answer SSDP (asleep, or SSDP blocked) are still tried directly
    for (const t of tvs) if (!seen.has(t.ip)) looked.push({ ...t, online: await portOpen(t.ip, 8008, 600) || await portOpen(t.ip, 5555, 600) });
    scan.found = looked.map((t) => ({ ...t, online: t.online ?? true })).filter((t) => t.android || tvs.some((x) => x.ip === t.ip));
    for (const t of scan.found) if (t.android && t.online) remember({ ip: t.ip, name: t.name, maker: t.maker, model: t.model, id: t.id });
    scan.at = Date.now();
  } finally { scan.busy = false; }
}

// ---------- Wireless debugging (Android 11+, Google TV): the TV announces it on mDNS with a port that changes
// each time it is switched on: _adb-tls-connect._tcp to connect, _adb-tls-pairing._tcp while the pairing code shows.
function readName(buf, at) {
  const labels = []; let jumped = false, end = at, guard = 0;
  while (guard++ < 128) {
    const len = buf[at];
    if (len === undefined) throw new Error("short");
    if (len === 0) { if (!jumped) end = at + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = at + 2; at = ((len & 0x3f) << 8) | buf[at + 1]; jumped = true; continue; }
    labels.push(buf.toString("utf8", at + 1, at + 1 + len)); at += 1 + len;
  }
  return [labels.join("."), end];
}
function mdnsPorts(ip, ms = 2500) {
  const types = ["_adb-tls-connect._tcp.local", "_adb-tls-pairing._tcp.local"];
  const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, types.length, 0, 0, 0, 0, 0, 0]),
    ...types.map((t) => Buffer.concat([...t.split(".").map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0, 0, 12, 0x80, 1])]))]);
  return new Promise((done) => {
    const out = { connect: 0, pairing: 0 }, socks = [];
    for (const nic of ipv4s()) {
      const s = createSocket("udp4");
      s.on("error", () => {});
      s.on("message", (buf, from) => {
        if (from.address !== ip) return;
        try {
          let at = 12;
          const qd = buf.readUInt16BE(4), n = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
          for (let i = 0; i < qd; i++) at = readName(buf, at)[1] + 4;
          for (let i = 0; i < n; i++) {
            const [name, e] = readName(buf, at);
            const type = buf.readUInt16BE(e), len = buf.readUInt16BE(e + 8);
            if (type === 33) {   // SRV: the port
              const port = buf.readUInt16BE(e + 10 + 4);
              if (name.includes("_adb-tls-connect")) out.connect = port;
              if (name.includes("_adb-tls-pairing")) out.pairing = port;
            }
            at = e + 10 + len;
          }
        } catch {}
      });
      s.bind(0, nic.address, () => { try { s.send(q, 5353, "224.0.0.251"); setTimeout(() => s.send(q, 5353, "224.0.0.251"), 700); } catch {} });
      socks.push(s);
    }
    setTimeout(() => { socks.forEach((s) => { try { s.close(); } catch {} }); done(out); }, ms);
  });
}

// ---------- one TV
async function devState(ip) {
  const r = await adb(["devices"]);
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith(serial(ip) + "\t"));
  return line ? line.split("\t")[1].trim() : "none";   // device | unauthorized | offline | none
}
// device: ready. unauthorized: waiting for OK on the TV. pair: Wireless debugging is on but this PC isn't paired yet.
// closed: the TV doesn't let PCs in yet (debugging off). noadb: adb is still being set up.
async function connect(ip) {
  if (!adbPath()) return { state: "noadb" };
  let st = await devState(ip);
  if (st === "device" || st === "unauthorized") return { state: st };
  if (st === "offline") await adb(["disconnect", serial(ip)]);
  // newer TVs: Wireless debugging
  const m = await mdnsPorts(ip);
  if (m.connect) {
    serials.set(ip, `${ip}:${m.connect}`);
    const r = await adb(["connect", serial(ip)], { timeout: 10000 });
    await sleep(600);
    st = await devState(ip);
    if (st === "device" || st === "unauthorized") return { state: st };
    await adb(["disconnect", serial(ip)]);
    return { state: "pair", pairing: m.pairing || 0, said: (r.out + r.err).trim() };
  }
  // older TVs: USB debugging opens port 5555
  serials.delete(ip);
  if (!(await portOpen(ip, 5555, 1500))) return { state: "closed" };
  const r = await adb(["connect", serial(ip)], { timeout: 10000 });
  await sleep(600);
  st = await devState(ip);
  return { state: st === "none" ? "closed" : st, said: (r.out + r.err).trim() };
}
// Pair with the 6-digit code the TV shows (Developer options > Wireless debugging > Pair device with pairing code).
async function pair(ip, code, port) {
  if (!/^\d{6}$/.test(String(code || ""))) return { ok: false, error: "The code is 6 numbers." };
  port = Number(port) || (await mdnsPorts(ip, 3000)).pairing;
  if (!port) return { ok: false, error: "Keep the pairing code showing on the TV, then try again." };
  const r = await adb(["pair", `${ip}:${port}`, String(code)], { timeout: 20000 });
  if (!/Successfully paired/i.test(r.out + r.err)) return { ok: false, error: /wrong|fail/i.test(r.out + r.err) ? "That code didn't work. Check it on the TV and try again." : (r.out + r.err).trim() || "Pairing failed" };
  await sleep(1500);
  return { ok: true, ...(await connect(ip)) };
}
async function info(ip) {
  const sep = "@@";
  const r = await sh(ip, ["getprop ro.product.manufacturer", "getprop ro.product.model", "getprop ro.build.version.release",
    `dumpsys package ${PKG} | grep -m1 versionCode`, "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tail -n 1",
    `pm list packages -d`].join(`; echo ${sep}; `));
  const [maker, model, android, ver, home, disabled] = r.out.split(sep).map((s) => s.trim());
  const code = Number(/versionCode=(\d+)/.exec(ver || "")?.[1] || 0);
  return { maker, model, android, home: { installed: code > 0, code, latest: latest()?.code || 0, active: (home || "").startsWith(PKG + "/"),
    stockOff: STOCK.some((p) => (disabled || "").includes("package:" + p)) } };
}

// ---------- the Shivo Labs home screen app (built from tv/home; an install carries it in tv\)
function apkFile() { return [join(ROOT, "tv", "home", "dist", "ShivoLabs-TV.apk"), join(ROOT, "tv", "ShivoLabs-TV.apk")].find(existsSync) || null; }
function latest() {
  for (const f of [join(ROOT, "tv", "home", "version.json"), join(ROOT, "tv", "version.json")]) { try { return JSON.parse(readFileSync(f, "utf8")); } catch {} }
  return null;
}
async function home(ip, what) {
  if (what === "install") {
    const apk = apkFile();
    if (!apk) return { ok: false, error: "The home screen app isn't on this PC yet." };
    const r = await adb(["-s", serial(ip), "install", "-r", apk], { timeout: 120000 });
    if (!/Success/.test(r.out)) return { ok: false, error: (r.out + r.err).trim().split(/\r?\n/).pop() || "Install failed" };
    // one-time permissions only adb can give: other apps' "continue watching" and rows, our screensaver
    // on/off, and seeing what is playing (a notification listener that reads only media sessions)
    await sh(ip, `pm grant ${PKG} android.permission.READ_TV_LISTINGS`);
    await sh(ip, `pm grant ${PKG} android.permission.WRITE_SECURE_SETTINGS`);
    // TCL TVs block apps from starting in the background unless allowed (their own APP_AUTO_START switch);
    // without it the watch history and the phone's connection stop when our screen is closed. Other TVs ignore it.
    await sh(ip, `cmd appops set ${PKG} APP_AUTO_START allow`);
    // the pairing code shows as a small card on top of what is playing (YouTube keeps playing)
    await sh(ip, `cmd appops set ${PKG} SYSTEM_ALERT_WINDOW allow`);
    // switched off and on, so Android starts the service again after an update
    await sh(ip, `cmd notification disallow_listener ${PKG}/${PKG}.NowPlaying`);
    await sh(ip, `cmd notification allow_listener ${PKG}/${PKG}.NowPlaying`);
    return { ok: true };
  }
  if (what === "make") {
    const on = pkgs(await sh(ip, "pm list packages -e"));
    for (const p of STOCK) if (on.has(p)) await sh(ip, `pm disable-user --user 0 ${p}`);
    await sh(ip, `cmd package set-home-activity ${PKG}/.Home`);
    await sh(ip, "input keyevent 3");
    return { ok: true };
  }
  if (what === "undo") {
    for (const p of STOCK) await sh(ip, `pm enable ${p}`);
    await sh(ip, "input keyevent 3");
    return { ok: true };
  }
  return { ok: false, error: "Unknown" };
}

// ---------- apps
const icons = new Map();   // `${ip}|${pkg}` -> png
const FILES = `/sdcard/Android/data/${PKG}/files`;
async function apps(ip) {
  const [all, sys, off] = await Promise.all([sh(ip, "pm list packages"), sh(ip, "pm list packages -s"), sh(ip, "pm list packages -d")]);
  const allS = pkgs(all), sysS = pkgs(sys), offS = pkgs(off);
  // names and icons from our app on the TV, when it's there
  let named = [];
  const asked = await sh(ip, `am broadcast -n ${PKG}/.Export`, { timeout: 30000 });
  if (/result=1/.test(asked.out)) {
    try { named = JSON.parse((await sh(ip, `cat ${FILES}/apps.json`)).out); } catch {}
  }
  const byPkg = new Map(named.map((a) => [a.pkg, a]));
  return [...allS].map((pkg) => {
    const n = byPkg.get(pkg);
    const system = sysS.has(pkg);
    // A system part with nothing to open (or one we can't name, before our app is on the TV) is kept on:
    // switching off the wrong one can stop the TV working.
    return { pkg, label: n?.label || nice(pkg), system, on: !offS.has(pkg), open: n ? n.open : null, tv: !!n?.tv, named: !!n,
      keep: KEEP.has(pkg) || pkg.startsWith("com.android.providers.") || (system && (!n || !n.open)) };
  }).sort((a, b) => a.label.localeCompare(b.label));
}
const pkgs = (r) => new Set(r.out.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(Boolean));
// a readable name from a package name when the TV can't tell us one: com.netflix.ninja -> Netflix
const NAMES = { "com.google.android.youtube.tv": "YouTube", "com.netflix.ninja": "Netflix", "com.amazon.amazonvideo.livingroom": "Prime Video",
  "com.disney.disneyplus": "Disney+", "com.spotify.tv.android": "Spotify", "com.google.android.youtube.tvmusic": "YouTube Music", "com.showmax.app": "Showmax",
  "com.google.android.apps.tv.launcherx": "Google TV home", "com.google.android.katniss": "Google Assistant", "com.android.vending": "Play Store" };
function nice(pkg) {
  if (NAMES[pkg]) return NAMES[pkg];
  const parts = pkg.split(".").filter((p) => !["com", "android", "google", "tv", "app", "apps", "org", "net"].includes(p));
  const w = parts.at(-1) || pkg;
  return w.charAt(0).toUpperCase() + w.slice(1);
}
async function icon(ip, pkg) {
  const k = ip + "|" + pkg;
  if (icons.has(k)) return icons.get(k);
  const r = await adb(["-s", serial(ip), "exec-out", "cat", `${FILES}/icons/${pkg}.png`], { binary: true, timeout: 8000 });
  const png = r.ok && r.out.length > 8 && r.out[1] === 0x50 ? r.out : null;
  icons.set(k, png);
  return png;
}
async function appDo(ip, pkg, what) {
  if (!/^[\w.]+$/.test(pkg)) return { ok: false, error: "Bad app" };
  if (what === "open") {
    const r = await sh(ip, `monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1 || monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    return { ok: !/No activities found|monkey aborted/i.test(r.out) || /Events injected: 1/.test(r.out) };
  }
  if (KEEP.has(pkg) && what !== "on") return { ok: false, error: "The TV needs this one, so it stays on." };
  if (what === "off") { const r = await sh(ip, `pm disable-user --user 0 ${pkg}`); return { ok: /disabled/.test(r.out), error: r.out.trim() }; }
  if (what === "on") { const r = await sh(ip, `pm enable ${pkg}`); return { ok: /enabled/.test(r.out), error: r.out.trim() }; }
  if (what === "uninstall") {
    const sys = (await sh(ip, `pm list packages -s ${pkg}`)).out.includes("package:" + pkg);
    if (sys) return { ok: false, error: "Apps that came with the TV can only be switched off." };
    const r = await adb(["-s", serial(ip), "uninstall", pkg], { timeout: 60000 });
    return { ok: /Success/.test(r.out), error: (r.out + r.err).trim() };
  }
  return { ok: false, error: "Unknown" };
}

// ---------- remote: one long-lived adb shell per TV, so a key press is quick
const shells = new Map();
function shellFor(ip) {
  let p = shells.get(ip);
  if (p && !p.killed && p.exitCode === null) return p;
  p = spawn(adbPath(), ["-s", serial(ip), "shell"], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  p.on("exit", () => shells.delete(ip)); p.on("error", () => shells.delete(ip));
  shells.set(ip, p);
  return p;
}
function press(ip, key) {
  const code = KEYS[key];
  if (!code || !adbPath()) return false;
  shellFor(ip).stdin.write(`input keyevent ${code}\n`);
  return true;
}
function type(ip, text) {
  if (!adbPath()) return false;
  // input text: spaces as %s, everything else quoted for the TV's shell
  const t = String(text).slice(0, 500).replace(/[^\x20-\x7e]/g, "").replace(/ /g, "%s").replace(/'/g, "'\\''");
  if (t) shellFor(ip).stdin.write(`input text '${t}'\n`);
  return true;
}

// ---------- the page's calls
export async function tvApi(req, res, path, url) {
  if (!path.startsWith("/api/tv/")) return false;
  const what = path.slice("/api/tv/".length);
  if (req.method === "GET") {
    const ip = url.searchParams.get("ip");
    if (what === "status") {
      if (!scan.at && !scan.busy) find();
      return json(res, 200, { adb: { ready: !!adbPath(), busy: adbState.busy, error: adbState.error }, scanning: scan.busy, scannedAt: scan.at,
        tvs: (scan.at ? scan.found : tvs.map((t) => ({ ...t, android: true, online: null }))), apk: !!apkFile(), latest: latest() }), true;
    }
    if (!isIp(ip)) return json(res, 400, { error: "Which TV?" }), true;
    if (what === "info") return json(res, 200, { ...(await connect(ip)), ...((await devState(ip)) === "device" ? await info(ip) : {}) }), true;
    if (what === "apps") return json(res, 200, { apps: await apps(ip) }), true;
    if (what === "icon") {
      const png = await icon(ip, url.searchParams.get("pkg") || "");
      if (!png) return json(res, 404, { error: "none" }), true;
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" }); res.end(png); return true;
    }
    if (what === "screen") {
      const r = await adb(["-s", serial(ip), "exec-out", "screencap", "-p"], { binary: true, timeout: 10000 });
      if (!r.ok || r.out.length < 100) return json(res, 503, { error: "No picture" }), true;
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(r.out); return true;
    }
    return json(res, 404, { error: "Not found" }), true;
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
  const b = await readJson(req);
  if (what === "find") { await find(); return json(res, 200, { tvs: scan.found }), true; }
  if (what === "adb") { getAdb(); return json(res, 200, { ok: true }), true; }
  if (!isIp(b.ip)) return json(res, 400, { error: "That isn't a TV address (like 192.168.1.20)." }), true;
  if (what === "add") {
    const t = await lookAt(b.ip);
    if (!t.android && !(await portOpen(b.ip, 5555))) return json(res, 200, { ok: false, error: "No Android TV answered at that address." }), true;
    remember({ ip: t.ip, name: t.name, maker: t.maker, model: t.model, id: t.id });
    scan.found = [...scan.found.filter((x) => x.ip !== t.ip), { ...t, android: true, online: true }];
    return json(res, 200, { ok: true, tv: t }), true;
  }
  if (what === "forget") {
    tvs = tvs.filter((t) => t.ip !== b.ip); saveTvs();
    scan.found = scan.found.filter((t) => t.ip !== b.ip);
    await adb(["disconnect", serial(b.ip)]);
    return json(res, 200, { ok: true }), true;
  }
  if (what === "connect") return json(res, 200, await connect(b.ip)), true;
  if (what === "pair") return json(res, 200, await pair(b.ip, b.code, b.port)), true;
  if (what === "home") return json(res, 200, await home(b.ip, b.do)), true;
  if (what === "app") return json(res, 200, await appDo(b.ip, String(b.pkg || ""), b.do)), true;
  if (what === "key") return json(res, 200, { ok: b.text != null ? type(b.ip, b.text) : press(b.ip, b.key) }), true;
  return json(res, 404, { error: "Not found" }), true;
}
