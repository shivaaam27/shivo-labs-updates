// Updates for Shivo Labs: ONE update for everything, the hub's files, Shivo Labs AI and every module, installed in one
// go by itself, like the phone app. Nothing else (the AI app included) shows or installs updates of its own.
//  - "repo" mode (this folder is a git checkout, e.g. Shivam's PC): new commits on GitHub's main; installing runs
//    `git pull`. Shivo Labs AI runs from its own live folder (Documents\Shivo Labs AI\fabra-labs-ai, outside the repo):
//    when the pulled ai\app has a newer version, the hub hands it over (ai\release.ps1 -SkipInstaller, its checks) and
//    has the AI app install it, as part of the same update.
//  - "installed" mode (installed by installer\install.ps1): over the air. installer\publish-hub-ota.ps1 (on Shivam's PC)
//    puts each update in R2 through shivo-id (ota/hub/): head.json (the newest version, small), <version>/manifest.json
//    listing each file's SHA-256, signed with the laptop update key (hub\update-key.xml is the public half), and every
//    file by its SHA-256. The AI app and the modules' files are in the same list (each install keeps only the modules
//    its pass has, hub/packs.json). An install downloads only the files that differ (each one checked), backs up what
//    it replaces, installs by itself, and restarts only what the change touches. If the hub doesn't come back, the
//    backup is put back (engines/restart.mjs).
// When: right away. The hub keeps a connection open to the Cloudflare shelf (/u/ws); publishing an update tells every
// laptop at once. It also looks by itself: every 2 minutes on Shivam's PC (git fetch), every 15 minutes on installs.
// One answer: update() checks every part and installs what it finds; a second call while one runs joins it, so
// Settings' "Check for updates" never says "Up to date" while something is still to come. Shivo Labs AI's part waits
// while it has a chat or scheduled task working ("Updating as soon as your chat finishes"), then installs; chats and
// settings are kept (they live in ~\.fabra-labs-ai).
import { spawn, execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = join(here, "..");
const ROOT = join(HUB, "..");
const MODE = existsSync(join(ROOT, ".git")) ? "repo" : "installed";
const OTA = process.env.HUB_OTA_BASE || "https://shivo-id.ishivamparmar.workers.dev/ota";
const WORK = join(process.env.LOCALAPPDATA || tmpdir(), "Shivo Labs", "update");
const DONE_FILE = process.env.HUB_UPDATE_DONE || join(dirname(WORK), "last-update.json");   // HUB_UPDATE_DONE: tests only
const AI = `http://127.0.0.1:${Number(process.env.HUB_AI_PORT) || 4823}`;
const AI_UPDATE = AI + "/api/update";
const SIGNAL = process.env.HUB_UPDATE_SIGNAL || "wss://shivo-labs-shelf.ishivamparmar.workers.dev/u/ws";
const PORT = Number(process.argv[2] || process.env.HUB_PORT) || 4800;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export const version = () => {
  for (const f of [join(ROOT, "version.txt"), join(ROOT, "installer", "version.txt")]) {
    try { return readFileSync(f, "utf8").trim(); } catch {}
  }
  return "0.0.0";
};
const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const git = (...args) => new Promise((ok, no) => execFile("git", ["-C", ROOT, ...args], { windowsHide: true, timeout: 60000 }, (e, out, err) => (e ? no(new Error((err || e.message).trim())) : ok(out.trim()))));

// the public key is .NET's XML format (Modulus, Exponent); Node reads it as a JWK
function publicKey() {
  const xml = readFileSync(join(HUB, "update-key.xml"), "utf8");
  const b64url = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const n = xml.match(/<Modulus>([^<]+)</)[1], e = xml.match(/<Exponent>([^<]+)</)[1];
  return createPublicKey({ key: { kty: "RSA", n: b64url(n), e: b64url(e) }, format: "jwk" });
}
export const signedOk = (text, sig) => { try { return verify("sha256", Buffer.from(text), publicKey(), Buffer.from(String(sig).trim(), "base64")); } catch { return false; } };
const buildOf = (v) => Number(String(v).split(".")[2]) || 0;   // "1.0.412" -> 412 (the number of commits)
// Which module's pack a file belongs to (hub/packs.json). An install with installed.json (made by the installer and
// hub/api/id.mjs) holds core plus the packs its pass allows: updates leave the other modules' files alone.
const PACKS = Object.entries(JSON.parse(readFileSync(join(HUB, "packs.json"), "utf8"))).filter(([k]) => !k.startsWith("_"));
const packOf = (rel) => PACKS.find(([, pre]) => pre.some((p) => rel.startsWith(p)))?.[0] || "core";
const kept = () => { try { const m = JSON.parse(readFileSync(join(ROOT, "installed.json"), "utf8")).modules || []; return (rel) => { const p = packOf(rel); return p === "core" || m.includes(p); }; } catch { return () => true; } };
// The same file counts as the same with Windows or Linux line endings (installer/ota-build.mjs hashes the same way).
export const fileHash = (buf) => createHash("sha256").update(buf.subarray(0, 8000).includes(0) ? buf : Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

// The one update state, shown by Settings. phase: "idle", "checking", "updating", or "waiting" (Shivo Labs AI's part
// waits for a working chat). done: the last update installed ({ version, at }), kept across restarts.
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
export const state = { mode: MODE, version: version(), phase: "idle", error: null, lastCheck: 0, available: null, done: readJson(DONE_FILE), ai: null, ui: null };
// Files the running server has loaded: a change to one of these needs a restart. Anything else (the screens in
// hub/www, shared/, modules.json, docs, other apps) is picked up by a quiet page refresh, like the phone app's updates.
const SERVER_CODE = /^hub\/(server\.mjs|api\/|engines\/)/;
const needsRestart = (files) => files.some((f) => SERVER_CODE.test(f));
// the version the screens are at (the commit, in repo mode); open windows refresh when it changes
// In repo mode the visible version is a build number that grows with every update (the number of commits),
// like a phone app's build, plus when that update was made: e.g. "1.0 (build 412) · 13 Oct, 13:41".
async function stamp() {
  if (MODE !== "repo") {
    state.ui = state.version; state.build = buildOf(state.version) || null;
    try { state.updatedAt = JSON.parse(readFileSync(join(ROOT, "files.json"), "utf8")).built || null; } catch {}
  } else {
    const [h, when] = (await git("log", "-1", "--format=%h|%cI")).split("|");
    state.ui = h; state.build = Number(await git("rev-list", "--count", "HEAD")); state.updatedAt = when;
  }
  state.ai = aiVersion();
}
stamp().catch(() => {});
const label = () => (state.build ? `1.0 (build ${state.build})` : state.version);
function markDone() {
  state.done = { version: label(), at: Date.now() };
  try { mkdirSync(dirname(DONE_FILE), { recursive: true }); writeFileSync(DONE_FILE, JSON.stringify(state.done)); } catch {}
}
// A plain message for what went wrong (the details stay in state.detail).
const plain = (e) => {
  const m = String(e?.message || e);
  if (!m.startsWith("Shivo Labs AI") && /could not resolve host|unable to access|timed out|timeout|ENOTFOUND|ECONN|fetch failed|network/i.test(m)) return "Couldn't reach the update server. It tries again by itself.";
  return m;
};

// ---------- update(): check every part, install what is new, one answer
let running = null;
export function update(opts = {}) { return (running ??= runUpdate(opts).finally(() => { running = null; })); }
export const check = update;   // (Settings' "Check for updates" is the same complete update)

async function runUpdate({ manual } = {}) {
  clearTimeout(aiRetry); aiRetry = null;
  if (manual) aiFailed = null;   // a press of "Check for updates" tries an AI version that failed before once more
  state.phase = "checking"; state.error = null; state.detail = null;
  let hub = null, reload = false;
  try {
    // 1. the hub's files (with the modules and, on installs, Shivo Labs AI)
    hub = MODE === "repo" ? await repoBehind() : await otaNewer();
    state.lastCheck = Date.now();
    if (hub) {
      state.available = hub; state.phase = "updating";
      const r = MODE === "repo" ? await pullRepo(hub) : await installOta(hub);
      if (r.waiting) { state.available = null; return waitForAi(); }
      if (r.restarting) return { ok: true, found: true, restarting: true };   // the new hub finishes the rest at its start
      reload = true; state.available = null;
    }
    // 2. Shivo Labs AI on Shivam's PC (installs carry it in the files above)
    const ai = await updateAi();
    if (ai === "waiting") return waitForAi();
    if (hub || ai === "done") markDone();
    state.phase = "idle";
    const found = !!hub || ai === "done";
    if (manual && !found && state.done) state.done.seen = true;   // you looked again: "Up to date" from now on, not "Updated to"
    return { ok: true, found, reload };
  } catch (e) {
    state.error = plain(e); state.detail = String(e?.message || e); state.phase = "idle"; state.available = null;
    return { ok: false, found: !!hub, reload, error: state.error };
  } finally { state.ai = aiVersion(); }
}
// Shivo Labs AI is busy: the rest is done, its part follows as soon as no chat or scheduled task is working
function waitForAi() {
  state.phase = "waiting";
  aiRetry = setTimeout(() => update().catch(() => {}), 20000);
  return { ok: true, found: true, waiting: true };
}

// repo mode: how far this checkout is behind GitHub's main
async function repoBehind() {
  await git("fetch", "--quiet", "origin", "main");
  const behind = Number(await git("rev-list", "--count", "HEAD..origin/main"));
  if (!behind) return null;
  const files = (await git("diff", "--name-only", "HEAD", "origin/main")).split("\n").filter(Boolean);
  return { version: `${behind} new change${behind > 1 ? "s" : ""}`, files };
}
async function pullRepo() {
  const dirty = await git("status", "--porcelain", "--untracked-files=no");
  if (dirty) throw new Error("This folder has changes that aren't saved to git, so it wasn't updated. Ask Claude to look at it.");
  const before = await git("rev-parse", "HEAD");
  await git("pull", "--rebase", "--quiet", "origin", "main");
  const files = (await git("diff", "--name-only", before, "HEAD")).split("\n").filter(Boolean);
  await stamp();
  if (needsRestart(files)) { markDone(); restartHub(); return { restarting: true }; }   // the new hub hands the AI over (and the TV app) at its start
  if (files.some((f) => f.startsWith("tv/home/"))) publishTv().catch(() => {});
  return {};   // screens only: nothing to restart; open windows refresh themselves when they see the new version
}

// installed mode: the newest update. head.json (small) says which version is newest; only when it is newer than this
// install is that version's list (about 1 MB) fetched and checked. Files are fetched by their SHA-256 (base + "f/" +
// sha), so the list and the files always match.
async function otaNewer() {
  const get = async (path) => { const r = await fetch(`${OTA}/hub/${path}`, { cache: "no-store", signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null; if (!r.ok) throw new Error(`The update server answered ${r.status}`); return r.text(); };
  const head = await get(`head.json?t=${Date.now()}`);
  if (!head) return null;
  const v = JSON.parse(head).version;
  if (!(buildOf(v) > buildOf(state.version))) return null;
  const [text, sig] = await Promise.all([get(`${v}/manifest.json`), get(`${v}/manifest.sig`)]);
  if (!text || !sig) return null;
  if (!signedOk(text, sig)) throw new Error("An update was found but it isn't signed by Shivo Labs, so it was ignored.");
  const m = JSON.parse(text);
  return { version: m.version, manifest: m, base: `${OTA}/hub/` };
}

// Stop a program by part of its command line (the AI server or Beam's engine after their code changed); the hub
// starts them again (Beam within a minute, the AI app straight away if it was on).
const stopMatching = (part) => new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${part.replace(/'/g, "''")}') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
  { windowsHide: true, timeout: 30000 }, () => ok()));

// what Shivo Labs AI says about itself (null: not running): { current, available, busy }
const aiStatus = async () => { try { return await (await fetch(AI_UPDATE, { cache: "no-store", signal: AbortSignal.timeout(3000) })).json(); } catch { return null; } };
// start the AI server again (the hub's own "open" call, as when you open the module)
const startAi = () => fetch(`http://127.0.0.1:${PORT}/api/open/ai`, { method: "POST", headers: { "x-hub": "1" }, signal: AbortSignal.timeout(10000) }).catch(() => {});

// Restart the hub server (the window reconnects by itself). The Beam engine and the AI server keep running.
// A separate restarter (engines/restart.mjs) waits for this hub to let go of its port, starts the new one on the
// same port, checks it answers and retries if not, logging to %LOCALAPPDATA%\Shivo Labs\logs\restart.log.
export function restartHub(backup) {
  const args = [join(HUB, "engines", "restart.mjs"), String(PORT), join(HUB, "server.mjs"), ...(backup ? [backup, ROOT] : [])];
  spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => process.exit(0), 300);
}

// installed: only the files that differ, each checked against the signed list
async function installOta({ manifest: m, base }) {
  const changed = [], keep = kept();
  for (const [rel, sha] of Object.entries(m.files)) {
    if (!keep(rel)) continue;
    let h = null; try { h = fileHash(readFileSync(join(ROOT, ...rel.split("/")))); } catch {}
    if (h !== sha) changed.push(rel);
  }
  let before = {}; try { before = JSON.parse(readFileSync(join(ROOT, "files.json"), "utf8")).files || {}; } catch {}
  const removed = Object.keys(before).filter((rel) => !(rel in m.files) && keep(rel));
  const all = [...changed, ...removed];
  const aiChanged = all.some((f) => f.startsWith("ai/app/"));
  // Shivo Labs AI restarts when its files change: not while a chat or scheduled task is working (nothing is touched yet)
  if (aiChanged && (await aiStatus())?.busy) return { waiting: true };
  rmSync(WORK, { recursive: true, force: true });
  const stage = join(WORK, "stage"), backup = join(WORK, "backup");
  const queue = [...changed];
  const one = async () => {
    for (let rel; (rel = queue.shift());) {
      const r = await fetch(base + "f/" + m.files[rel], { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`Download failed (${r.status})`);
      let buf = Buffer.from(await r.arrayBuffer());
      if (fileHash(buf) !== m.files[rel]) throw new Error("A downloaded file was damaged. It will try again later.");
      if (/\.(vbs|cmd|bat)$/i.test(rel)) buf = Buffer.from(buf.toString("latin1").replace(/\r?\n/g, "\r\n"), "latin1");   // Windows scripts want CRLF
      const p = join(stage, ...rel.split("/")); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf);
    }
  };
  await Promise.all(Array.from({ length: 6 }, one));
  // back up what is replaced or removed, then swap the new files in
  for (const rel of [...all, "version.txt", "files.json"]) {   // (with the version, so a put-back retries later)
    const from = join(ROOT, ...rel.split("/"));
    if (existsSync(from)) { const to = join(backup, ...rel.split("/")); mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
  }
  for (const rel of changed) { const to = join(ROOT, ...rel.split("/")); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(stage, ...rel.split("/")), to); }
  for (const rel of removed) rmSync(join(ROOT, ...rel.split("/")), { force: true });
  writeFileSync(join(ROOT, "version.txt"), m.version);
  writeFileSync(join(ROOT, "files.json"), JSON.stringify({ version: m.version, built: m.built, files: m.files }));
  state.version = m.version; await stamp();
  // restart only what runs the changed code
  // the AI server: stopped, and started again straight away if it was on (its page in the hub reloads by itself)
  if (aiChanged) { const was = !!(await aiStatus()); await stopMatching(join(ROOT, "ai", "app")); if (was) await startAi(); }
  if (all.some((f) => f.startsWith("beam/") || f === "hub/engines/beam_host.py")) await stopMatching(join(ROOT, "hub", "engines", "beam_host.py"));
  if (needsRestart(all)) { markDone(); restartHub(backup); return { restarting: true }; }
  return {};
}

// ---------- Shivo Labs AI on Shivam's PC: the live app (Documents\Shivo Labs AI\fabra-labs-ai, outside the repo)
// installs from the "updates" folder next to it. When the pulled ai\app is newer, the hub hands it over with
// ai\release.ps1 -SkipInstaller (its checks, then the copy) and asks the live app to install it as soon as no chat or
// scheduled task is working (the AI app backs up, copies, adds new packages, restarts itself and goes back to the old
// version if the new one doesn't start). On installs (no live folder) the AI app is part of the hub's files instead.
const AI_LIVE = process.env.HUB_AI_LIVE || join(process.env.USERPROFILE || "", "Documents", "Shivo Labs AI"); // HUB_AI_LIVE: tests only
const LIVE_APP = join(AI_LIVE, "fabra-labs-ai");
const readVer = (f) => { try { return JSON.parse(readFileSync(f, "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } };
const aiVersion = () => (MODE === "repo" && existsSync(LIVE_APP) ? readVer(join(LIVE_APP, "version.json")) : existsSync(join(ROOT, "ai", "app", "version.json")) ? readVer(join(ROOT, "ai", "app", "version.json")) : null);
// Packages a Node app's package.json lists that aren't in its node_modules.
const missingDeps = (dir) => { try { return Object.keys(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies || {}).filter((d) => !existsSync(join(dir, "node_modules", d, "package.json"))); } catch { return []; } };
const sameFile = (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
// Runs a program and never throws: { ok, out }. (Node refuses to start .cmd files such as npm.cmd directly since
// 2024; that error used to be thrown here and swallowed, so the AI app silently stayed on 2.0.19 from 20 to 23 Oct.)
const run = (cmd, args, cwd) => new Promise((ok) => {
  try { execFile(cmd, args, { cwd, windowsHide: true, timeout: 600000 }, (e, out, err) => ok({ ok: !e, out: String(out || "") + String(err || "") + (e && !err ? e.message : "") })); }
  catch (e) { ok({ ok: false, out: String(e?.message || e) }); }
});
const npm = (args, cwd) => run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args}`], cwd);
const lastLine = (out, re) => (out.match(re)?.[0] || out.trim().split(/\r?\n/).filter(Boolean).pop() || "").trim().slice(0, 200);
let aiRetry = null, aiFailed = null;

// "none" (nothing to do), "done" (installed now) or "waiting" (a chat is working); throws with a plain message
async function updateAi() {
  if (MODE !== "repo" || !existsSync(LIVE_APP)) return "none";
  const want = readVer(join(ROOT, "ai", "app", "version.json"));
  if (!newer(want, readVer(join(LIVE_APP, "version.json")))) return "none";
  if (aiFailed === want) throw new Error(`Shivo Labs AI ${want} didn't start, so the version before it was put back. Your chats are fine.`);
  state.phase = "updating";
  // 1. hand it over (once per version)
  if (newer(want, readVer(join(AI_LIVE, "updates", "version.json")))) {
    // new packages: added to the live app first (adding packages doesn't disturb it). Also when a package the app
    // lists is missing (an earlier install failed after package.json was already copied).
    if (!sameFile(join(ROOT, "ai", "app", "package.json"), join(LIVE_APP, "package.json")) || missingDeps(LIVE_APP).length) {
      writeFileSync(join(LIVE_APP, "package.json"), readFileSync(join(ROOT, "ai", "app", "package.json")));
      const lock = join(ROOT, "ai", "app", "package-lock.json");
      if (existsSync(lock)) writeFileSync(join(LIVE_APP, "package-lock.json"), readFileSync(lock));
      const n = await npm("install --omit=dev --no-audit --no-fund", LIVE_APP);
      if (!n.ok) throw new Error(`Shivo Labs AI ${want}: its new parts couldn't be added (${lastLine(n.out, /[^\r\n]*ERR[^\r\n]*/)}). It tries again by itself.`);
    }
    const r = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "ai", "release.ps1"), "-SkipInstaller", "-Runtime", AI_LIVE], ROOT);
    if (!r.ok) throw new Error(`Shivo Labs AI ${want} didn't pass its checks: ${lastLine(r.out, /[^\r\n]*(failed|error|refuse)[^\r\n]*/i)}`);
  }
  // 2. install it in the live app now, unless a chat or scheduled task is working
  let u = await aiStatus();
  if (!u) {   // not running: start it in the background (as opening it does), then install
    await startAi();
    for (let i = 0; i < 40 && !(u = await aiStatus()); i++) await sleep(1000);
    if (!u) throw new Error("Shivo Labs AI didn't start, so its update waits. It tries again by itself.");
  }
  if (u.busy) return "waiting";
  if (u.current === want) return "done";
  let res;
  try {
    const { token } = await (await fetch(AI + "/api/token", { signal: AbortSignal.timeout(3000) })).json();
    res = await fetch(AI + "/api/update/install", { method: "POST", headers: { "content-type": "application/json", "x-fabra-token": token }, body: "{}", signal: AbortSignal.timeout(300000) });
  } catch (e) { throw new Error(`Shivo Labs AI ${want} didn't install (${e.message}). It tries again by itself.`); }
  if (res.status === 409) return "waiting";
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || `Shivo Labs AI ${want} didn't install (${res.status}). It tries again by itself.`);
  // the AI app restarts itself on the new version (and goes back to the old one if it doesn't start)
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const s = await aiStatus();
    if (s?.current === want) return "done";
    if (s && i > 20 && s.current !== want) break;   // it answers, but on the old version: it was put back
  }
  aiFailed = want;
  throw new Error(`Shivo Labs AI ${want} didn't start, so the version before it was put back. Your chats are fine.`);
}

// ---------- The TV app on Shivam's PC (the one with the TV signing key): a new tv\home\version.json on GitHub's main is
// published to the TVs by itself (tv\home\publish.ps1), so nobody has to remember it (21 Oct: 1.0.19 sat unpublished).
// Safe at any hour: TVs on 1.0.19+ install only under the screensaver. Only what is on GitHub is published: skipped
// while tv/home here differs from origin/main. A failed publish is tried again after an hour.
const TV_KEY = join(process.env.USERPROFILE || "", ".fabra-labs-ai", "android-build", "shivo-tv.keystore");
const TV_FEED = process.env.HUB_TV_FEED || "https://shivo-id.ishivamparmar.workers.dev/ota/tv/latest.json";   // HUB_TV_FEED, HUB_TV_DRYRUN: tests only
let tvBusy = false;
export async function publishTv() {
  if (MODE !== "repo" || tvBusy || !existsSync(TV_KEY)) return null;
  let want = 0; try { want = Number(JSON.parse(readFileSync(join(ROOT, "tv", "home", "version.json"), "utf8")).code) || 0; } catch {}
  if (!want) return null;
  if (state.tvPublish?.code === want && (state.tvPublish.ok || Date.now() - state.tvPublish.at < 60 * 60 * 1000)) return state.tvPublish;
  let live = 0; try { live = Number((await (await fetch(`${TV_FEED}?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) })).json()).code) || 0; } catch { return null; }
  if (live >= want) return null;   // (GitHub keeps this file up to 5 minutes: publish.ps1 checks again itself)
  tvBusy = true;
  try {
    await git("fetch", "--quiet", "origin", "main");
    if (await git("status", "--porcelain", "--", "tv/home") || await git("diff", "--name-only", "origin/main", "--", "tv/home")) return null;
    const r = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "tv", "home", "publish.ps1"), ...(process.env.HUB_TV_DRYRUN ? ["-DryRun"] : [])], ROOT);
    if (/Another TV publish is running/.test(r.out)) return null;   // someone else is sending it: look again next time
    const ok = r.ok || /already have code/i.test(r.out);
    state.tvPublish = { code: want, ok, at: Date.now(),
      error: ok ? null : (r.out.match(/[^\r\n]*(failed|error|could not|refuse)[^\r\n]*/i)?.[0] || "The TV app didn't publish.").trim() };
    return state.tvPublish;
  } finally { tvBusy = false; }
}

// The signal from Cloudflare: one connection, kept open (a "ping" every 4 minutes so routers don't drop it), opened
// again after a drop (5 s, growing to 5 minutes while offline). Each message names the newest laptop update; when it is
// newer than this copy (on this PC: whenever one is published), update now. R2 can lag a moment behind the signal, so
// an install that doesn't see the update yet tries again a few times.
// the same connection also says when the phone asks a PC to renew its apps (pclink.mjs sets ask)
export const signal = { on: false, ask: null };
function listen() {
  if (typeof WebSocket !== "function" || !SIGNAL || SIGNAL === "off") return;
  let wait = 5000, ping = null, lastAt = null;
  const open = () => {
    let ws; try { ws = new WebSocket(SIGNAL); } catch { setTimeout(open, wait); return; }
    ws.onopen = () => { wait = 5000; signal.on = true; signal.ask?.(null); ping = setInterval(() => { try { ws.send("ping"); } catch {} }, 4 * 60 * 1000); };
    ws.onmessage = async (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }   // "pong"
      if (m.type === "ask") return signal.ask?.(m.pc);
      if (m.type !== "update") return;
      const first = lastAt === null; if (m.at === lastAt) return; lastAt = m.at;
      const wanted = MODE === "installed" ? m.hub && buildOf(m.hub) > buildOf(state.version) : !first;
      if (!wanted) return;
      for (let i = 0; i < 8; i++) {
        const r = await update().catch(() => ({}));
        if (r.found || MODE === "repo") return;
        if (buildOf(m.hub) <= buildOf(state.version)) return;
        await sleep(15000);
      }
    };
    ws.onclose = () => { signal.on = false; clearInterval(ping); setTimeout(open, wait); wait = Math.min(wait * 2, 5 * 60 * 1000); };
    ws.onerror = () => {};   // onclose follows
  };
  open();
}

export function autoCheck() {
  // the first look starts at once (a hub that just restarted after an update finishes it here, AI part included)
  state.phase = "checking";
  const go = () => update().catch(() => {});
  setTimeout(go, 2000);
  setInterval(go, (MODE === "repo" ? 2 : 15) * 60 * 1000);
  setTimeout(() => publishTv().catch(() => {}), 60000);
  setInterval(() => publishTv().catch(() => {}), 15 * 60 * 1000);
  listen();
}
