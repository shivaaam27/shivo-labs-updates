// Native iPhone updates that install by themselves. An app made with a free Apple ID can only be installed by the
// paired PC over the same Wi-Fi (the internet route can't carry an app install), so nobody should have to keep a
// phone awake for it: the hub (port 4800) keeps the installs that wait for a phone and does them as soon as the phone
// answers on this Wi-Fi, quietly, with nothing to press. An install waits when
//   - a newer build of an app X Tools put on the phone is on this PC (e.g. a new Downloads\ShivoLabs.ipa);
//   - an app's 7 days are nearly up (2 days or less left): it is renewed;
//   - a renew was asked for while the phone was away (xtools.mjs hands it over, hooks.wait).
// Every minute: a quick knock on the phone's pairing port at its last address (like Your PC, pclink.mjs); every 15
// minutes while work waits, a search of the network for a phone that moved. Near: each app is installed in turn,
// Shivo Labs last (an app that is on screen isn't closed by iOS; the install then fails and is tried again later).
// A failure waits 5, 10, 20, 30, then 60 minutes before the next try. The list is kept in
// %LOCALAPPDATA%\Shivo Labs\waiting-installs.json; the X Tools page shows it (GET /api/xtools/waiting).
import { readFileSync, writeFileSync, mkdirSync, statSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import net from "node:net";
import { quietCall, xtoolsBusy, hooks } from "./xtools.mjs";
import { notify } from "./tray.mjs";

const FL = join(process.env.LOCALAPPDATA || "", "Fabra Labs");
const STORE = join(FL, "state.json");   // X Tools' apps: name, bundle id, kept copy (File), when installed
const WIFI = join(FL, "wifi.json");     // the phones set up for Wi-Fi, with their last address
const LIST = join(process.env.LOCALAPPDATA || "", "Shivo Labs", "waiting-installs.json");
const SHIVO = "com.shivolabs.labs";
const BACKOFF = [5, 10, 20, 30, 60];
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return null; } };
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
const log = (...a) => console.log("[waiting installs]", ...a);

// items: { udid, bundleId, name, why, since, tries, next, error }; done: the last few that landed;
// dropped: "udid|bundleId" -> the InstalledAt for which a renew isn't needed on that phone (the app isn't on it)
let st = { items: [], done: [], dropped: {} };
const save = () => { try { mkdirSync(dirname(LIST), { recursive: true }); writeFileSync(LIST, JSON.stringify(st, null, 1)); } catch {} };
const apps = () => readJson(STORE)?.Apps || [];
const phones = () => readJson(WIFI) || {};
const phoneName = (udid) => String(phones()[udid]?.name || "your iPhone").replace(/’/g, "'");
const appName = (bundleId) => apps().find((a) => a.BundleId === bundleId)?.Name || bundleId;

function wait(udid, bundleId, why) {
  let it = st.items.find((x) => x.udid === udid && x.bundleId === bundleId);
  if (!it) { it = { udid, bundleId, name: appName(bundleId), why, since: Date.now(), tries: 0, next: 0, error: "" }; st.items.push(it); log("waits:", it.name, "for", phoneName(udid), `(${why})`); }
  else if (why === "new build" || why === "asked") { it.why = why; it.next = 0; }
  save();
  return { name: it.name, phone: phoneName(udid) };
}

// does the phone answer on its pairing port (Apple's 49152) at this address
const knock = (ip, ms = 1500) => new Promise((ok) => {
  if (!ip) return ok(false);
  const s = net.connect({ host: ip, port: 49152 }); const done = (v) => { s.destroy(); ok(v); };
  s.setTimeout(ms, () => done(false)); s.once("connect", () => done(true)); s.once("error", () => done(false));
});

// ---------- what should wait
const daysLeft = (a) => 7 - Math.floor((Date.now() - Date.parse(a.InstalledAt)) / 86400000);
function renewsDue() {
  for (const a of apps()) {
    if (!a.InstalledAt || daysLeft(a) > 2) continue;
    for (const udid of Object.keys(phones())) {
      if (st.dropped[`${udid}|${a.BundleId}`] === a.InstalledAt) continue;
      if (!st.items.some((x) => x.udid === udid && x.bundleId === a.BundleId)) wait(udid, a.BundleId, "renew");
    }
  }
}
// newer builds: X Tools' own search (it reads each .ipa's bundle id); asked for at start, when an .ipa changes in
// Downloads, and every 6 hours
let lookForBuilds = true, lastBuildLook = 0;
async function newBuilds() {
  if (!lookForBuilds && Date.now() - lastBuildLook < 6 * 3600000) return;
  const found = await quietCall("findIpas");
  lookForBuilds = false; lastBuildLook = Date.now();
  for (const a of apps()) {
    const kept = mtime(a.File);
    if ((found || []).some((f) => f.bundleId === a.BundleId && mtime(f.path) > kept + 1000))
      for (const udid of Object.keys(phones())) wait(udid, a.BundleId, "new build");
  }
}

// ---------- doing them
let busy = false, lastSearch = 0;
async function tick() {
  if (busy || xtoolsBusy() || !apps().length || !Object.keys(phones()).length) return;   // (no X Tools apps or phones: nothing to do)
  busy = true;
  try {
    renewsDue();
    await newBuilds().catch((e) => log("couldn't look for new builds:", e.message || e));   // (tried again next round)
    const due = st.items.filter((x) => x.next <= Date.now());
    for (const udid of [...new Set(due.map((x) => x.udid))]) {
      if (xtoolsBusy()) break;
      let near = await knock(phones()[udid]?.ip);
      // the phone may have a new address: search the network now and then (it saves the new one)
      if (!near && Date.now() - lastSearch > 15 * 60000) {
        lastSearch = Date.now();
        const p = ((await quietCall("wifiPhones", { look: true }).catch(() => [])) || []).find((x) => x.udid === udid);
        near = !!p?.reachable;
      }
      if (near) await installAll(udid, due.filter((x) => x.udid === udid));
    }
  } catch (e) { log("couldn't look:", e.message || e); }
  finally { busy = false; }
}

async function installAll(udid, items) {
  let onPhone = null;
  try { onPhone = (await quietCall("wifiApps", { udid })) || []; } catch { return; }   // gone again: next time
  const isOn = (b) => onPhone.some((x) => x.bundleId === b || (x.bundleId.startsWith("XTL-") && x.bundleId.endsWith("." + b)));
  items.sort((a, b) => (a.bundleId === SHIVO) - (b.bundleId === SHIVO));
  for (const it of items) {
    // X Tools only updates its apps that are on this phone (an install asked for by hand goes ahead regardless)
    if (it.why !== "asked" && !isOn(it.bundleId)) {
      const a = apps().find((x) => x.BundleId === it.bundleId);
      if (a) st.dropped[`${udid}|${it.bundleId}`] = a.InstalledAt;
      st.items = st.items.filter((x) => x !== it); save();
      continue;
    }
    log("installing", it.name, "on", phoneName(udid), `(${it.why}, try ${it.tries + 1})`);
    try {
      await quietCall("renew", { bundleId: it.bundleId, udid, wifi: true });
      st.items = st.items.filter((x) => x !== it);
      st.done = [{ name: it.name, phone: phoneName(udid), why: it.why, at: Date.now() }, ...st.done].slice(0, 5);
      log("installed", it.name);
      notify(it.why === "new build" ? "Updated" : "Renewed for 7 days", `${it.name} on ${phoneName(udid)}`);
    } catch (e) {
      it.tries++; it.error = String(e.message || e).slice(0, 200);
      it.next = Date.now() + BACKOFF[Math.min(it.tries - 1, BACKOFF.length - 1)] * 60000;
      log("not yet:", it.name, "-", it.error);
      // (an app on screen can't be replaced, so a try or two failing is normal: say so only after an hour of tries)
      if (it.tries === 4) notify(`${it.name} hasn't updated yet`, `${it.error} It keeps trying while ${phoneName(udid)} is on this Wi-Fi.`, false);
    }
    save();
  }
}

export function startAutoInstall() {
  st = { items: [], done: [], dropped: {}, ...(readJson(LIST) || {}) };
  hooks.wait = wait;
  hooks.waiting = () => ({
    items: st.items.map((x) => ({ name: x.name, phone: phoneName(x.udid), why: x.why, since: x.since, tries: x.tries, error: x.error })),
    done: st.done,
  });
  // a new build in Downloads (where the iPhone build puts it): look for newer builds on the next round
  try {
    let t = 0;
    watch(join(process.env.USERPROFILE || "", "Downloads"), (_, f) => {
      if (!/\.ipa$/i.test(String(f || ""))) return;
      clearTimeout(t); t = setTimeout(() => { lookForBuilds = true; tick(); }, 20000);   // (let the file finish writing)
    });
  } catch {}
  setTimeout(tick, 30000);
  setInterval(tick, 60000);
}
