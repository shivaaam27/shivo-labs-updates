// "Your PC" in the phone app: the phone sees that this PC's X Tools is on (from anywhere, through the Cloudflare
// shelf) and whether it is near (same network), and can ask it to renew its apps. This file:
//   - reports this PC to the shelf: its name, the phones set up for Wi-Fi, and which of them answer on the Wi-Fi now
//     (a quick knock on Apple's port 49152 at the phone's last address, every minute). It writes only when something
//     changes, plus every 15 minutes (the free plan allows ~1000 writes a day);
//   - looks for the phone app's requests every 20 seconds and carries them out (xtools.mjs renewPhoneApps); a phone
//     that isn't near yet is renewed as soon as it is.
// Only on a PC with the shelf set up (shelf/setup.mjs: ~\.fabra-labs-ai\shelf\config.json); otherwise it does nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import net from "node:net";
import { renewPhoneApps, work as xwork } from "./xtools.mjs";

const CFG = join(process.env.USERPROFILE || "", ".fabra-labs-ai", "shelf", "config.json");
const WIFI = join(process.env.LOCALAPPDATA || "", "Fabra Labs", "wifi.json");   // X Tools' phones set up for Wi-Fi
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return null; } };

// does something answer at ip:port within ms
const knock = (ip, port = 49152, ms = 1500) => new Promise((ok) => {
  if (!ip) return ok(false);
  const s = net.connect({ host: ip, port }); const done = (v) => { s.destroy(); ok(v); };
  s.setTimeout(ms, () => done(false)); s.once("connect", () => done(true)); s.once("error", () => done(false));
});

export function startPcLink() {
  const cfg = readJson(CFG);
  if (!cfg?.url || !cfg?.write) return;
  const id = ("pc-" + hostname()).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 60);
  const name = hostname();
  const W = { authorization: "Bearer " + cfg.write, "content-type": "application/json" };
  let last = "", lastAt = 0, busy = false;

  // (no knocking while a renew runs: a knock on the phone's pairing port in the middle of an install can break it)
  const seen = {};
  async function phones() {
    const w = readJson(WIFI) || {};
    return Promise.all(Object.entries(w).map(async ([udid, p]) => ({ udid, name: String(p.name || "iPhone"), nearby: busy || xwork.installing ? !!seen[udid] : (seen[udid] = await knock(p.ip)) })));
  }
  async function report(force = false, on = true) {
    try {
      const body = { id, name, on, phones: on ? await phones() : [] };
      const key = JSON.stringify(body);
      if (!force && key === last && Date.now() - lastAt < 15 * 60000) return;
      const r = await fetch(`${cfg.url}/w/pc`, { method: "PUT", headers: W, body: key });
      if (r.ok) { last = key; lastAt = Date.now(); }
    } catch {}   // offline: try again next time
  }
  const status = (askId, text, done = false, ok) =>
    fetch(`${cfg.url}/w/ask`, { method: "POST", headers: W, body: JSON.stringify({ id: askId, status: text, done, ok }) }).catch(() => {});

  async function work() {
    if (busy || xwork.installing) return; busy = true;
    try {
      const r = await fetch(`${cfg.url}/w/asks?pc=${encodeURIComponent(id)}`, { headers: W });
      if (!r.ok) return;
      for (const a of (await r.json()).asks || []) {
        const ip = (readJson(WIFI) || {})[a.udid]?.ip;
        if (!(seen[a.udid] = await knock(ip))) { if (a.status !== "Waiting for your iPhone to be near this PC") await status(a.id, "Waiting for your iPhone to be near this PC"); continue; }
        try {
          const names = await renewPhoneApps(a.udid, (t) => status(a.id, t));
          await status(a.id, `Renewed for 7 days: ${names.join(", ")}`, true, true);
        } catch (e) { await status(a.id, String(e.message || e), true, false); }
        report(true);
      }
    } catch {} finally { busy = false; }
  }

  report(true);
  setInterval(() => report(false), 60000);
  setInterval(work, 20000); work();
  const bye = () => { report(true, false); };
  process.once("SIGINT", bye); process.once("SIGTERM", bye);
}
