// Beam inside the hub. The installed Beam keeps running in the background (tray) as the engine that talks
// to the iPhone; this is its PC screen. It uses the same folders as beam/app/beam/beam.py:
//   send list  %APPDATA%\Beam\outbox   (the iPhone pulls from here)
//   received   Downloads\Beam
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { readFile, readdir, stat, link, rename, unlink, writeFile, copyFile, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import dgram from "node:dgram";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { randomBytes, createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import net from "node:net";

const HOME = join(process.env.APPDATA || homedir(), "Beam");
const OUTBOX = join(HOME, "outbox");
const INBOX = join(homedir(), "Downloads", "Beam");
const SHORTCUT_URL = "https://www.icloud.com/shortcuts/6d7b833ce6604d239fd92e8bc1079494";

const config = async () => { try { return JSON.parse(await readFile(join(HOME, "config.json"), "utf8")); } catch { return {}; } };
const portOpen = (port) => new Promise((ok) => {
  const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); ok(true); });
  s.on("error", () => ok(false)); s.setTimeout(400, () => { s.destroy(); ok(false); });
});
// the PC's address on the home network, chosen like Beam does: the interface Windows would route through
// (a UDP "connect" sends nothing). Skips virtual adapters such as WSL's.
const lanIp = () => new Promise((ok) => {
  const s = dgram.createSocket("udp4");
  s.on("error", () => { s.close(); ok("127.0.0.1"); });
  s.connect(9, "192.168.0.1", () => { const a = s.address().address; s.close(); ok(a); });
});
const cleanName = (n) => basename(String(n || "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 180) || "file";

async function files(dir, max = 50) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith(".") || name.endsWith(".part")) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isFile()) out.push({ name, size: s.size, at: s.mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

// Give a finished temp file its real name in one step, like Beam's publish(): the iPhone never sees half a file.
async function publish(tmp, name, dir = OUTBOX) {
  const stem = name.slice(0, name.length - extname(name).length), ext = extname(name);
  for (let n = 0; ; n++) {
    const final = join(dir, n ? `${stem} (${n})${ext}` : name);
    try { await link(tmp, final); await unlink(tmp).catch(() => {}); return basename(final); }
    catch (e) {
      if (e.code === "EEXIST") continue;
      if (existsSync(final)) continue;
      await rename(tmp, final); return basename(final);
    }
  }
}

// ---------- your devices (beam.py keeps devices.json: each phone, tablet or browser that checked in, with its name,
// kind and when it was last seen). Each has its own waiting folder outbox\d-<id>; loose files in outbox are for
// any device. Names you give a device here, and devices you remove, are kept in device-names.json.
const NAMES = join(HOME, "device-names.json");
const devDir = (id) => join(OUTBOX, "d-" + String(id).replace(/[^A-Za-z0-9-]/g, "_"));
const KIND_NAME = { iphone: "iPhone", ipad: "iPad", android: "Android", tablet: "Tablet" };
const readJsonFile = async (p) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return {}; } };
async function deviceList() {
  const seen = await readJsonFile(join(HOME, "devices.json")), names = await readJsonFile(NAMES);
  const now = Date.now() / 1000, out = [];
  for (const [id, d] of Object.entries(seen)) {
    const n = names[id] || {};
    if (n.hidden && !(d.seen > n.hidden)) continue;   // removed (it comes back if it checks in again later)
    // a name given on the PC card or on the device itself: whichever was set last
    const name = (n.name && (n.at || 0) >= (d.named || 0) ? n.name : d.name || n.name) || KIND_NAME[d.kind] || "Phone";
    out.push({ id, name, kind: d.kind || "", seen: (d.seen || 0) * 1000,
      nearby: now - (d.seen || 0) < 45, waiting: await files(devDir(id)) });
  }
  // two iPhones both called "iPhone": the one seen first keeps the name, the other becomes "iPhone 2" (rename on its card)
  const taken = {};
  for (const d of [...out].sort((a, b) => (seen[a.id].first || a.seen) - (seen[b.id].first || b.seen) || a.id.localeCompare(b.id))) {
    const n = (taken[d.name.toLowerCase()] = (taken[d.name.toLowerCase()] || 0) + 1);
    if (n > 1) d.name += " " + n;
  }
  return out.sort((a, b) => b.seen - a.seen);
}
// which devices a request is for: ?to=<id>,<id> (only known ones); none means any device
async function targets(param) {
  const ids = String(param || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length) return [];
  const known = new Set((await deviceList()).map((d) => d.id));
  return ids.filter((id) => known.has(id));
}
// a finished temp file onto the waiting list of each device (hard links: no extra disk space), or any device
async function publishTo(tmp, name, ids) {
  if (!ids.length) return publish(tmp, name);
  let last = name;
  for (const id of ids) {
    const dir = devDir(id); await mkdir(dir, { recursive: true });
    const part = join(dir, "." + randomBytes(6).toString("hex"));
    await link(tmp, part).catch(() => copyFile(tmp, part));
    last = await publish(part, name, dir);
  }
  await unlink(tmp).catch(() => {});
  return last;
}

// ---------- the engine: hub/engines/beam_host.py (runs beam.py from this repo; no tray app, no window)
const here = dirname(fileURLToPath(import.meta.url));
const HOST_PY = join(here, "..", "engines", "beam_host.py");
const ENV_DIR = join(process.env.LOCALAPPDATA || homedir(), "Shivo Labs", "beam-env");  // its own Python packages
// An install brings its own Python with zeroconf (python\ next to hub\); otherwise the hub makes ENV_DIR once.
const BUNDLED = join(here, "..", "..", "python", "pythonw.exe");
const PYW = existsSync(BUNDLED) ? BUNDLED : join(ENV_DIR, "Scripts", "pythonw.exe");
const run = (cmd, args) => new Promise((ok) => {
  const p = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
  p.on("error", () => ok(false)); p.on("exit", (code) => ok(code === 0));
});
let preparing = null;
// zeroconf's speed-up modules are unsigned .pyd files that Smart App Control blocks on many PCs; its plain-Python modules
// sit next to them and are used once the .pyd files are gone (slower, but Beam only needs it to be found on the Wi-Fi).
function plainZeroconf() {
  const site = existsSync(BUNDLED) ? join(dirname(BUNDLED), "Lib", "site-packages") : join(ENV_DIR, "Lib", "site-packages");
  const walk = (dir) => { let list = []; try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".pyd")) { try { rmSync(p); } catch {} } } };
  walk(join(site, "zeroconf"));
}
// First run only: a private Python environment with zeroconf (so iPhones find the PC as beam.local).
function prepare() {
  if (existsSync(PYW)) { plainZeroconf(); return Promise.resolve(true); }
  return (preparing ??= (async () => {
    const made = await run("py", ["-3", "-m", "venv", ENV_DIR]) || await run("python", ["-m", "venv", ENV_DIR]);
    if (!made) return false;
    await run(join(ENV_DIR, "Scripts", "python.exe"), ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "zeroconf"]);
    plainZeroconf();
    return existsSync(PYW);
  })().finally(() => { preparing = null; }));
}
// The code the engine should be running: the same sum beam_host.py writes into engine.json when it starts. When the
// hub is updated (beam.py or beam_host.py changed), the engine still running the old code is restarted.
const BEAM_PY = join(here, "..", "..", "beam", "app", "beam", "beam.py");
const engineCode = () => { try { return createHash("sha256").update(readFileSync(BEAM_PY)).update(readFileSync(HOST_PY)).digest("hex"); } catch { return ""; } };
// every running Beam engine (not one-off "send" or "add" runs from the right-click menu)
const stopEngines = () => new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -match 'beam_host\.py"?\s*$' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
  { windowsHide: true, timeout: 30000 }, () => ok()));
let managing = false, restartedFor = "";   // managing: this is the hub that looks after the engine (port 4800)
export async function startBeam() {
  const cfg = await config(), port = cfg.port || 8765;
  if (await portOpen(port)) {
    const want = managing ? engineCode() : "";
    if (!want || restartedFor === want) return true;
    let running = {}; try { running = JSON.parse(await readFile(join(HOME, "engine.json"), "utf8")); } catch {}
    if (running.code === want) { restartedFor = want; return true; }
    restartedFor = want;   // once per version, so a PC that can't write engine.json isn't restarted every minute
    await stopEngines();
    for (let i = 0; i < 40 && await portOpen(port); i++) await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await prepare())) return false;
  spawn(PYW, [HOST_PY], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  return true;
}
export const beamEngine = { python: PYW, host: HOST_PY };
// The iPhone must always be able to reach the PC: start the engine with the hub and bring it back if it stops.
export function superviseBeam() {
  managing = true;
  setTimeout(() => startBeam().then(addToExplorer).catch(() => {}), 1500);
  setInterval(() => { startBeam().catch(() => {}); addToExplorer(true).catch(() => {}); }, 60000);
  // a new phone, or a new name: into the right-click menu at once (it used to wait for the next minute)
  let soon = 0;
  try {
    mkdirSync(HOME, { recursive: true });
    watch(HOME, (_, file) => {
      if (!/^(devices|device-names).json$/.test(String(file))) return;
      clearTimeout(soon); soon = setTimeout(() => addToExplorer().catch(() => {}), 800);
    }).on("error", () => {});
  } catch {}
}
// ---------- Explorer (any PC, this user only, no admin; on Windows 11 under "Show more options"). Selecting several
// files runs the command once per file; beam_host.py combines them into one notice.
// Right-click > "Send to Beam" > one of your devices, or "All my devices". Rewritten when the device
// list or names change (and at start, so it always points at this install).
// Only the hub that looks after Beam writes it (never a test copy), one write at a time. A short sum of the menu is
// kept in the registry with it, so a menu that is out of date, or was changed by something else, is put right.
let explorerQueue = Promise.resolve();
const regSig = (key) => new Promise((ok) => execFile("reg.exe", ["query", key, "/v", "ShivoSig"], { windowsHide: true },
  (e, out) => ok((String(out || "").match(/ShivoSig\s+REG_SZ\s+(\S+)/) || [])[1] || "")));
// verify: also compare with what Windows has (every minute); otherwise only when the devices or names changed
let explorerLast = "";
function addToExplorer(verify = false) {
  if (!managing) return Promise.resolve();
  const go = () => writeExplorer(verify);
  return (explorerQueue = explorerQueue.then(go, go));
}
async function writeExplorer(verify) {
  const list = await deviceList().catch(() => []);
  const sig = createHash("sha256").update(JSON.stringify([PYW, HOST_PY, list.map((d) => [d.id, d.name])])).digest("hex").slice(0, 16);
  if (!verify && sig === explorerLast) return;
  explorerLast = sig;
  if ((await regSig("HKCU\\Software\\Classes\\*\\shell\\ShivoLabsBeam")) === sig &&
      (await regSig("HKCU\\Software\\Classes\\Directory\\shell\\ShivoLabsBeam")) === sig) return;
  const ico = join(here, "..", "shivo-labs.ico");
  const cmd = (to) => `"${PYW}" "${HOST_PY}" send ${to ? `--to ${to} ` : ""}"%1"`;
  const items = [
    ...list.map((d) => [d.name, cmd(d.id)]),
    ...(list.length > 1 ? [["All my devices", cmd(list.map((d) => d.id).join(","))]] : []),
    ...(list.length ? [] : [["My phone or tablet", cmd("")]]),   // before any device has checked in
  ];
  for (const cls of ["*", "Directory"]) {
    const key = `HKCU\\Software\\Classes\\${cls}\\shell\\ShivoLabsBeam`;
    await run("reg.exe", ["delete", key, "/f"]);
    await run("reg.exe", ["add", key, "/v", "MUIVerb", "/d", "Send to Beam", "/f"]);
    await run("reg.exe", ["add", key, "/v", "Icon", "/d", ico, "/f"]);
    await run("reg.exe", ["add", key, "/v", "SubCommands", "/d", "", "/f"]);
    for (const [i, [label, c]] of items.entries()) {
      const sub = `${key}\\shell\\${String(i).padStart(2, "0")}`;
      await run("reg.exe", ["add", sub, "/v", "MUIVerb", "/d", label, "/f"]);
      await run("reg.exe", ["add", sub, "/v", "MultiSelectModel", "/d", "Player", "/f"]);
      await run("reg.exe", ["add", sub + "\\command", "/ve", "/d", c, "/f"]);
    }
    await run("reg.exe", ["add", key, "/v", "ShivoSig", "/d", sig, "/f"]);   // last: only a complete menu counts as written
  }
}

// Ctrl+V on the Beam page: whatever was copied in Explorer (files or whole folders) goes to the iPhone's list.
function clipboardPaths() {
  return new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
    "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }"], { windowsHide: true, timeout: 15000 },
    (e, out) => ok(e ? [] : String(out).split("\n").map((l) => l.trim()).filter(Boolean))));
}

// ---------- "Accept files from an iPhone?" (asked by the engine, answered in the hub window)
const asks = new Map();  // id -> { ip, at, done(ok) }
let lastLook = 0, askSeq = 0;
const openWindow = () => spawn("wscript.exe", [join(here, "..", "Shivo Labs.vbs")], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

// Handles /api/beam/...; returns false if the path isn't Beam's.
export async function beamApi(req, res, path, url) {
  if (!path.startsWith("/api/beam/")) return false;
  const what = path.slice("/api/beam/".length);
  if (req.method === "GET" && what === "status") {
    const cfg = await config(), port = cfg.port || 8765;
    const ip = await lanIp();
    return json(res, 200, {
      running: await portOpen(port), host: `${hostname()}.local`, ip, trusted: (cfg.trusted || []).length,
      shortcut: SHORTCUT_URL, web: cfg.token ? `http://${hostname()}.local:${port}/p/${cfg.token}` : null,
      webIp: cfg.token ? `http://${ip}:${port}/p/${cfg.token}` : null,
      waiting: await files(OUTBOX), received: await files(INBOX, 8), devices: await deviceList(),
    }), true;
  }
  if (req.method === "GET" && what === "asks") {  // the hub page checks for questions every couple of seconds
    lastLook = Date.now();
    return json(res, 200, [...asks].map(([id, a]) => ({ id, ip: a.ip }))), true;
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
  if (what === "ask") {  // from the engine; waits for the answer, declines after a minute
    let body = ""; for await (const c of req) body += c;
    const { ip } = JSON.parse(body || "{}");
    const id = String(++askSeq);
    // nobody is looking at the hub: open its window so the question is seen
    if (Date.now() - lastLook > 5000) openWindow();
    const ok = await new Promise((done) => {
      asks.set(id, { ip: String(ip || "?"), done });
      setTimeout(() => done(false), 60000);
    });
    asks.delete(id);
    return json(res, 200, { ok }), true;
  }
  if (what === "answer") {
    let body = ""; for await (const c of req) body += c;
    const { id, ok } = JSON.parse(body || "{}");
    asks.get(String(id))?.done(!!ok);
    return json(res, 200, { ok: true }), true;
  }
  if (what === "start") return json(res, 200, { ok: await startBeam() }), true;
  mkdirSync(OUTBOX, { recursive: true });
  if (what === "send") {  // body = the file's bytes, ?name=
    const tmp = join(OUTBOX, "." + randomBytes(6).toString("hex"));
    try { await pipeline(req, createWriteStream(tmp)); return json(res, 200, { name: await publishTo(tmp, cleanName(url.searchParams.get("name")), await targets(url.searchParams.get("to"))) }), true; }
    catch (e) { await unlink(tmp).catch(() => {}); return json(res, 500, { error: String(e.message || e) }), true; }
  }
  if (what === "text") {  // pasted text goes over as a .txt, like Beam's "Send clipboard"
    let text = ""; for await (const c of req) { text += c; if (text.length > 5e6) break; }
    if (!text.trim()) return json(res, 400, { error: "Nothing to send" }), true;
    const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
    const tmp = join(OUTBOX, "." + randomBytes(6).toString("hex"));
    await writeFile(tmp, text, "utf8");
    return json(res, 200, { name: await publishTo(tmp, `Clipboard ${p2(d.getHours())}.${p2(d.getMinutes())}.txt`, await targets(url.searchParams.get("to"))) }), true;
  }
  if (what === "remove") {  // take a file off the send list
    const [dev] = await targets(url.searchParams.get("to"));
    await unlink(join(dev ? devDir(dev) : OUTBOX, cleanName(url.searchParams.get("name")))).catch(() => {});
    return json(res, 200, { ok: true }), true;
  }
  if (what === "paste" && req.method === "POST") {  // Ctrl+V on the Beam page: files and folders copied in Explorer
    const paths = await clipboardPaths();
    if (!paths.length || !(await prepare())) return json(res, 200, { count: 0 }), true;
    const to = await targets(url.searchParams.get("to"));
    await run(PYW, [HOST_PY, "add", ...(to.length ? ["--to", to.join(",")] : []), ...paths]);
    return json(res, 200, { count: paths.length }), true;
  }
  if (what === "device") {   // rename a device, or remove it from the list
    let body = ""; for await (const c of req) body += c;
    const { id, name, remove } = JSON.parse(body || "{}");
    const names = await readJsonFile(NAMES), n = names[id] || {};
    if (typeof name === "string" && name.trim()) { n.name = name.trim().slice(0, 40); n.at = Date.now() / 1000; }
    if (remove) { n.hidden = Date.now() / 1000; rmSync(devDir(id), { recursive: true, force: true }); }
    names[id] = n; await mkdir(HOME, { recursive: true }); await writeFile(NAMES, JSON.stringify(names));
    addToExplorer().catch(() => {});
    return json(res, 200, { ok: true }), true;
  }
  if (what === "reveal") {  // open Downloads\Beam, or show one received file in it
    mkdirSync(INBOX, { recursive: true });
    const name = url.searchParams.get("name");
    const args = name ? ["/select,", join(INBOX, cleanName(name))] : [INBOX];
    spawn("explorer.exe", args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    return json(res, 200, { ok: true }), true;
  }
  return json(res, 404, { error: "Not found" }), true;
}
