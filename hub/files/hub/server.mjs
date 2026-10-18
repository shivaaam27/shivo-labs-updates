// Shivo Labs hub: serves the home screen and starts modules. Node built-ins only (no npm install).
// Modules are listed in modules.json: adding a module is one entry there.
// Port 4800 (HUB_PORT to change it). Listens on this PC only.
import http from "node:http";
import net from "node:net";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { beamApi, startBeam, superviseBeam } from "./api/beam.mjs";
import { xtoolsApi } from "./api/xtools.mjs";
import { settingsApi } from "./api/settings.mjs";
import { mirrorApi, superviseMirror } from "./api/mirror.mjs";
import { businessApi } from "./api/business.mjs";
import { tvApi } from "./api/tv.mjs";
import { autoCheck } from "./api/update.mjs";
import { startPcLink } from "./api/pclink.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.HUB_PORT) || 4800;
// The shared look lives next to the hub in the repo; an installed copy carries it inside hub/shared.
const ROOTS = { "/shared/": [join(here, "shared"), join(here, "..", "shared")].find(existsSync), "/": join(here, "www") };
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon" };
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

// %ROOT% is the folder that holds hub\ (the repo here, the program folder when installed); %NODE% is the
// Node.js that comes with the install, or the one on this PC.
const ROOT = join(here, "..");
const NODE = existsSync(join(ROOT, "node", "node.exe")) ? join(ROOT, "node", "node.exe") : "node";
const env = (s) => s.replace(/%([^%]+)%/g, (m, k) => (k === "ROOT" ? ROOT : k === "NODE" ? NODE : process.env[k] ?? m));
// Test copies can point a module elsewhere, e.g. HUB_AI_PORT=4824 HUB_AI_EMBED=http://localhost:4824/ (never needed in normal use).
const modules = async () => JSON.parse(await readFile(join(here, "modules.json"), "utf8")).map((m) => {
  // "dir": where the module's program lives; the first folder that exists wins. "check" and "server" are inside it.
  if (Array.isArray(m.dir)) {
    const dir = m.dir.map(env).find((d) => existsSync(d)) || env(m.dir.at(-1));
    if (m.check) m.check = join(dir, m.check);
    if (m.server) m.server = m.server.map((a, i) => (i && !/^%|^[a-z]:\\/i.test(a) ? join(dir, a) : a));
  }
  const k = `HUB_${m.id.toUpperCase()}_`;
  if (process.env[k + "PORT"]) m.port = Number(process.env[k + "PORT"]);
  if (process.env[k + "EMBED"]) m.embed = process.env[k + "EMBED"];
  return m;
});
const portOpen = (port) => new Promise((ok) => {
  const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); ok(true); });
  s.on("error", () => ok(false)); s.setTimeout(400, () => { s.destroy(); ok(false); });
});
// What the home screen shows for each module: installed or not, and running (when it has a port).
async function status(m) {
  return { id: m.id, name: m.name, sub: m.sub, icon: m.icon || "", mark: !!m.mark, page: !!m.page, full: !!m.full, embed: m.embed || null, installed: !m.check || existsSync(env(m.check)), running: m.port ? await portOpen(m.port) : null };
}

const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

http.createServer(async (req, res) => {
  // only this PC, only this port (stops other web pages reaching the hub)
  if (!HOSTS.has(req.headers.host)) return send(res, 403, { error: "forbidden" });
  const url = new URL(req.url, `http://${req.headers.host}`);
  // anything that changes something must come from the hub's own page (other sites can't add this header)
  if (req.method !== "GET" && req.headers["x-hub"] !== "1") return send(res, 403, { error: "forbidden" });
  try {
    if (await beamApi(req, res, url.pathname, url)) return;
    if (await xtoolsApi(req, res, url.pathname, url)) return;
    if (await settingsApi(req, res, url.pathname)) return;
    if (await mirrorApi(req, res, url.pathname)) return;
    if (await businessApi(req, res, url.pathname)) return;
    if (await tvApi(req, res, url.pathname, url)) return;
    if (url.pathname === "/api/modules") return send(res, 200, await Promise.all((await modules()).map(status)));
    const open = url.pathname.match(/^\/api\/open\/([\w-]+)$/);
    if (open && req.method === "POST") {
      const m = (await modules()).find((x) => x.id === open[1]);
      if (m?.engine === "beam") return send(res, 200, { ok: await startBeam() });
      // a program the hub shows in its own window (Shivo Labs AI): start only its server, no window of its own
      if (m?.server) {
        if (m.port && await portOpen(m.port)) return send(res, 200, { ok: true });
        const [cmd, ...args] = m.server.map(env);
        spawn(cmd, args, { cwd: dirname(args.at(-1)), detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
        return send(res, 200, { ok: true });
      }
      if (!m?.start) return send(res, 404, { error: "No such module" });
      const [cmd, ...args] = m.start.map(env);
      spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
      return send(res, 200, { ok: true });
    }
    // static files
    const base = url.pathname.startsWith("/shared/") ? "/shared/" : "/";
    const root = ROOTS[base];
    const rel = decodeURIComponent(url.pathname.slice(base.length)) || "index.html";
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) return send(res, 403, { error: "forbidden" });
    if (!(await stat(file).catch(() => null))?.isFile()) return send(res, 404, "Not found", "text/plain");
    return send(res, 200, await readFile(file), TYPES[extname(file)] || "application/octet-stream");
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => { console.log(`Shivo Labs hub on http://localhost:${PORT}`); if (PORT === 4800) { superviseBeam(); superviseMirror(); autoCheck(); startPcLink(); } else if (process.env.HUB_PCLINK) startPcLink(); else if (process.env.HUB_MIRROR_NAME) superviseMirror(); })
  .on("error", (e) => console.log(e.code === "EADDRINUSE" ? `Port ${PORT} is busy; the hub may already be running.` : e.message));
