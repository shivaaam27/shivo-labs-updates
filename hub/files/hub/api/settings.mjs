// The hub's one Settings screen: start with Windows, updates, and where data is kept.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { state as upd, check, install, restartHub } from "./update.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = join(here, "..");
const STARTUP = join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Shivo Labs.lnk");
const ps = (script) => new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (e) => ok(!e)));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// where each part keeps its data (shown in Settings; nothing here is deleted by an update)
const PLACES = [
  ["Shivo Labs AI", "Chats, settings and your API key", join(homedir(), ".fabra-labs-ai")],
  ["Beam", "Paired iPhones and the send list", join(process.env.APPDATA || "", "Beam")],
  ["Beam", "Files received from iPhones", join(homedir(), "Downloads", "Beam")],
  ["X Tools", "Your apps, Apple ID and the Linux it uses", join(process.env.LOCALAPPDATA || "", "Fabra Labs")],
  ["Business", "Your business data", join(process.env.APPDATA || "", "Shivo Labs", "Business")],
];

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = async (req) => { let s = ""; for await (const c of req) s += c; try { return JSON.parse(s || "{}"); } catch { return {}; } };
const updateView = () => ({ mode: upd.mode, version: upd.version, checking: upd.checking, installing: upd.installing, error: upd.error, lastCheck: upd.lastCheck,
  available: upd.available && { version: upd.available.version, notes: upd.available.notes, restart: !!upd.available.restart }, aiHandOff: upd.aiHandOff || null, ui: upd.ui, build: upd.build || null, updatedAt: upd.updatedAt || null });

export async function settingsApi(req, res, path) {
  if (!path.startsWith("/api/settings")) return false;
  const what = path.slice("/api/settings".length);
  if (req.method === "GET" && (what === "" || what === "/")) {
    return json(res, 200, { startup: existsSync(STARTUP), update: updateView(), places: PLACES.map(([app, what, p]) => ({ app, what, path: p, exists: existsSync(p) })) }), true;
  }
  // the version Shivo Labs AI is running now (null: not running); its page in the hub reloads when this changes
  if (req.method === "GET" && what === "/ai") {
    let version = null;
    try { version = (await (await fetch(`http://127.0.0.1:${Number(process.env.HUB_AI_PORT) || 4823}/api/update`, { signal: AbortSignal.timeout(1500) })).json()).current || null; } catch {}
    return json(res, 200, { version }), true;
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
  if (what === "/startup") {  // start quietly with Windows (so iPhones can always send files with Beam)
    const { on } = await readJson(req);
    const vbs = join(HUB, "Shivo Labs.vbs"), ico = join(HUB, "shivo-labs.ico");
    const ok = on
      ? await ps(`$l=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(STARTUP)}); $l.TargetPath=${q(join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"))}; $l.Arguments=${q(`"${vbs}" /background`)}; $l.WorkingDirectory=${q(HUB)}; $l.IconLocation=${q(ico)}; $l.Description='Shivo Labs'; $l.Save()`)
      : await ps(`Remove-Item -LiteralPath ${q(STARTUP)} -Force -ErrorAction SilentlyContinue`);
    return json(res, 200, { ok, startup: existsSync(STARTUP) }), true;
  }
  if (what === "/check") { await check(); return json(res, 200, updateView()), true; }
  if (what === "/install") return json(res, 200, await install()), true;
  if (what === "/restart") { json(res, 200, { ok: true }); restartHub(); return true; }
  if (what === "/reveal") {  // open one of the data folders above in Explorer
    const { i } = await readJson(req);
    const p = PLACES[Number(i)]?.[2];
    if (p && existsSync(p)) spawn("explorer.exe", [p], { detached: true, stdio: "ignore" }).unref();
    return json(res, 200, { ok: !!p }), true;
  }
  return json(res, 404, { error: "Not found" }), true;
}
