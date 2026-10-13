// Beam inside the hub. The installed Beam keeps running in the background (tray) as the engine that talks
// to the iPhone; this is its PC screen. It uses the same folders as beam/app/beam/beam.py:
//   send list  %APPDATA%\Beam\outbox   (the iPhone pulls from here)
//   received   Downloads\Beam
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { readFile, readdir, stat, link, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import dgram from "node:dgram";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
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
async function publish(tmp, name) {
  const stem = name.slice(0, name.length - extname(name).length), ext = extname(name);
  for (let n = 0; ; n++) {
    const final = join(OUTBOX, n ? `${stem} (${n})${ext}` : name);
    try { await link(tmp, final); await unlink(tmp).catch(() => {}); return basename(final); }
    catch (e) {
      if (e.code === "EEXIST") continue;
      if (existsSync(final)) continue;
      await rename(tmp, final); return basename(final);
    }
  }
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
export async function startBeam() {
  const cfg = await config();
  if (await portOpen(cfg.port || 8765)) return true;
  if (!(await prepare())) return false;
  spawn(PYW, [HOST_PY], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  return true;
}
export const beamEngine = { python: PYW, host: HOST_PY };
// The iPhone must always be able to reach the PC: start the engine with the hub and bring it back if it stops.
export function superviseBeam() {
  setTimeout(() => startBeam().then(addToExplorer).catch(() => {}), 1500);
  setInterval(() => startBeam().catch(() => {}), 60000);
}

// ---------- Explorer: right-click a file or folder > "Send to iPhone (Beam)" (any PC, this user only, no admin).
// On Windows 10 it is in the menu itself; on Windows 11 under "Show more options" (the new short menu only takes apps
// signed with a code-signing certificate). Selecting several files runs it once per file; beam_host.py combines them
// into one notice. Written each time the hub starts, so it always points at this install's Python and Beam.
function addToExplorer() {
  const ico = join(here, "..", "shivo-labs.ico");
  const cmd = `"${PYW}" "${HOST_PY}" send "%1"`;
  for (const cls of ["*", "Directory"]) {
    const key = `HKCU\\Software\\Classes\\${cls}\\shell\\ShivoLabsBeam`;
    run("reg.exe", ["add", key, "/ve", "/d", "Send to iPhone (Beam)", "/f"]);
    run("reg.exe", ["add", key, "/v", "Icon", "/d", ico, "/f"]);
    run("reg.exe", ["add", key, "/v", "MultiSelectModel", "/d", "Player", "/f"]);
    run("reg.exe", ["add", key + "\\command", "/ve", "/d", cmd, "/f"]);
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
      waiting: await files(OUTBOX), received: await files(INBOX, 8),
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
    try { await pipeline(req, createWriteStream(tmp)); return json(res, 200, { name: await publish(tmp, cleanName(url.searchParams.get("name"))) }), true; }
    catch (e) { await unlink(tmp).catch(() => {}); return json(res, 500, { error: String(e.message || e) }), true; }
  }
  if (what === "text") {  // pasted text goes over as a .txt, like Beam's "Send clipboard"
    let text = ""; for await (const c of req) { text += c; if (text.length > 5e6) break; }
    if (!text.trim()) return json(res, 400, { error: "Nothing to send" }), true;
    const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
    const tmp = join(OUTBOX, "." + randomBytes(6).toString("hex"));
    await writeFile(tmp, text, "utf8");
    return json(res, 200, { name: await publish(tmp, `Clipboard ${p2(d.getHours())}.${p2(d.getMinutes())}.txt`) }), true;
  }
  if (what === "remove") {  // take a file off the send list
    await unlink(join(OUTBOX, cleanName(url.searchParams.get("name")))).catch(() => {});
    return json(res, 200, { ok: true }), true;
  }
  if (what === "paste" && req.method === "POST") {  // Ctrl+V on the Beam page: files and folders copied in Explorer
    const paths = await clipboardPaths();
    if (!paths.length || !(await prepare())) return json(res, 200, { count: 0 }), true;
    await run(PYW, [HOST_PY, "add", ...paths]);
    return json(res, 200, { count: paths.length }), true;
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
