// X Tools in the Windows notification area (UNIFY-PLAN.md phase 3): a small icon that works without the hub window.
// The icon itself is hub/engines/tray.ps1 (Windows PowerShell with Windows' own NotifyIcon, so there is no unsigned
// .exe for Smart App Control to block). It asks the hub every few seconds what to show (GET /api/xtools/tray, in
// xtools.mjs) and sends what is chosen in its menu back. Notices (a renew finished or failed) are kept here and shown
// by the icon as Windows notifications. Only the main hub (port 4800) starts it, and only with X Tools.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "engines", "tray.ps1");
const ICON = join(here, "..", "shivo-labs.ico");
const VBS = join(here, "..", "Shivo Labs.vbs");

// ---------- notices for the icon: { id, title, text, ok }
let seq = 0;
const notices = [];
export function notify(title, text = "", ok = true) {
  notices.push({ id: ++seq, title: String(title).slice(0, 63), text: String(text).slice(0, 250), ok });
  if (notices.length > 20) notices.splice(0, notices.length - 20);
}
export const noticesSince = (since) => notices.filter((n) => n.id > since);
export const lastNotice = () => seq;
export const tray = { on: false };

// ---------- the icon's process: started with the hub, again if it stops (one copy at a time: tray.ps1 holds a lock)
export function startTray(port = 4800) {
  if (!existsSync(SCRIPT) || process.platform !== "win32") return;
  tray.on = true;
  let fails = 0;
  const run = () => {
    const started = Date.now();
    const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", SCRIPT,
      "-Hub", `http://localhost:${port}`, "-Icon", ICON, "-Vbs", VBS], { windowsHide: true, stdio: "ignore" });
    p.on("error", () => {});
    // exit 3: another copy already shows the icon (an earlier hub's), nothing to do. Otherwise start it again.
    p.on("exit", (code) => {
      if (code === 3) return setTimeout(run, 5 * 60000);
      fails = Date.now() - started < 60000 ? fails + 1 : 0;
      setTimeout(run, Math.min(30000 * 2 ** fails, 30 * 60000));
    });
  };
  run();
}
