// Updates for Shivo Labs (the hub and everything installed with it).
//  - "repo" mode (this folder is a git checkout, e.g. Shivam's PC): new commits on GitHub; installing runs `git pull`.
//  - "installed" mode (installed by installer\install.ps1): over the air, like the phone app. Every change pushed to
//    main is published by .github/workflows/hub-ota.yml to the public repo shivo-labs-updates (folder hub/): the files,
//    and manifest.json listing each file's SHA-256, signed with the key in GitHub's secrets (hub\update-key.xml is the
//    public half). Every 15 minutes an install checks it, downloads only the files that differ (each one checked),
//    backs up what it replaces, installs by itself, and restarts only what the change touches. If the hub doesn't
//    come back, the backup is put back (engines/restart.mjs).
// Nothing is installed while Shivo Labs AI has a chat or scheduled task working.
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
const UPDATES = process.env.HUB_UPDATE_BASE || "https://raw.githubusercontent.com/shivaaam27/shivo-labs-updates";
const UPDATES_HEAD = process.env.HUB_UPDATE_HEAD || "https://api.github.com/repos/shivaaam27/shivo-labs-updates/commits/main";
const WORK = join(process.env.LOCALAPPDATA || tmpdir(), "Shivo Labs", "update");
const AI_UPDATE = "http://127.0.0.1:4823/api/update";

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
const signedOk = (text, sig) => { try { return verify("sha256", Buffer.from(text), publicKey(), Buffer.from(String(sig).trim(), "base64")); } catch { return false; } };
const buildOf = (v) => Number(String(v).split(".")[2]) || 0;   // "1.0.412" -> 412 (the number of commits)
// The same file counts as the same with Windows or Linux line endings (installer/ota-build.mjs hashes the same way).
export const fileHash = (buf) => createHash("sha256").update(buf.subarray(0, 8000).includes(0) ? buf : Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

export const state = { mode: MODE, version: version(), checking: false, available: null, error: null, lastCheck: 0, installing: false, ui: null };
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
    return;
  }
  const [h, when] = (await git("log", "-1", "--format=%h|%cI")).split("|");
  state.ui = h; state.build = Number(await git("rev-list", "--count", "HEAD")); state.updatedAt = when;
}
stamp().catch(() => {});

export async function check() {
  if (state.checking) return state;
  state.checking = true; state.error = null;
  try {
    if (MODE === "repo") {
      await git("fetch", "--quiet", "origin", "main");
      const behind = Number(await git("rev-list", "--count", "HEAD..origin/main"));
      const notes = behind ? (await git("log", "--format=%s", "-n", "6", "HEAD..origin/main")).split("\n") : [];
      const files = behind ? (await git("diff", "--name-only", "HEAD", "origin/main")).split("\n").filter(Boolean) : [];
      state.available = behind ? { version: `${behind} new change${behind > 1 ? "s" : ""}`, notes, restart: needsRestart(files) } : null;
    } else {
      const u = await latest();
      state.available = u && buildOf(u.m.version) > buildOf(state.version)
        ? { version: u.m.version, notes: [].concat(u.m.notes || []), manifest: u.m, base: u.base, restart: true } : null;
    }
  } catch (e) { state.error = e.message || String(e); }
  state.checking = false; state.lastCheck = Date.now();
  return state;
}

// The newest update, pinned to one commit of the updates repo so the list and the files always match. null: none yet.
async function latest() {
  let ref = "main";
  try { const r = await fetch(UPDATES_HEAD, { headers: { accept: "application/vnd.github.sha" }, signal: AbortSignal.timeout(15000) }); if (r.ok) ref = (await r.text()).trim(); } catch {}
  const base = `${UPDATES}/${ref}/hub/`;
  const get = async (name) => { const r = await fetch(base + name, { signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null; if (!r.ok) throw new Error(`The update server answered ${r.status}`); return r.text(); };
  const [text, sig] = await Promise.all([get("manifest.json"), get("manifest.sig")]);
  if (!text || !sig) return null;
  if (!signedOk(text, sig)) throw new Error("An update was found but it isn't signed by Shivo Labs, so it was ignored.");
  return { m: JSON.parse(text), base };
}

// Stop a program by part of its command line (the AI server or Beam's engine after their code changed); the hub
// starts them again (Beam within a minute, the AI app when it is next opened).
const stopMatching = (part) => new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${part.replace(/'/g, "''")}') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
  { windowsHide: true, timeout: 30000 }, () => ok()));

async function aiBusy() {
  try { return !!(await (await fetch(AI_UPDATE, { signal: AbortSignal.timeout(3000) })).json()).busy; } catch { return false; }  // not running: not busy
}

// Restart the hub server (the window reconnects by itself). The Beam engine and the AI server keep running.
// A separate restarter (engines/restart.mjs) waits for this hub to let go of its port, starts the new one on the
// same port, checks it answers and retries if not, logging to %LOCALAPPDATA%\Shivo Labs\logs\restart.log.
// (It used to be a fixed 2 s wait and one try: when the old hub was slow to quit, the new one gave up silently.)
export function restartHub(backup) {
  const port = Number(process.argv[2] || process.env.HUB_PORT) || 4800;
  const args = [join(HUB, "engines", "restart.mjs"), String(port), join(HUB, "server.mjs"), ...(backup ? [backup, ROOT] : [])];
  spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => process.exit(0), 300);
}

export async function install() {
  if (state.installing) return { ok: false, error: "Already installing" };
  if (!state.available) return { ok: false, error: "No update to install" };
  if (await aiBusy()) return { ok: false, busy: true, error: "Shivo Labs AI is still working on a chat or scheduled task. Install when it's finished." };
  state.installing = true;
  try {
    if (MODE === "repo") {
      const dirty = await git("status", "--porcelain", "--untracked-files=no");
      if (dirty) throw new Error("This folder has changes that aren't saved to git, so it wasn't updated. Ask Claude to look at it.");
      const before = await git("rev-parse", "HEAD");
      await git("pull", "--rebase", "--quiet", "origin", "main");
      const files = (await git("diff", "--name-only", before, "HEAD")).split("\n").filter(Boolean);
      if (needsRestart(files)) { restartHub(); return { ok: true, restarting: true }; }
      // screens only: nothing to restart; open windows refresh themselves when they see the new version
      await stamp();
      state.available = null; state.installing = false;
      if (files.some((f) => f.startsWith("ai/app/"))) handAiUpdate().catch(() => {});
      return { ok: true, reload: true };
    }
    // installed: only the files that differ, each checked against the signed list
    const { manifest: m, base } = state.available;
    const changed = [];
    for (const [rel, sha] of Object.entries(m.files)) {
      let h = null; try { h = fileHash(readFileSync(join(ROOT, ...rel.split("/")))); } catch {}
      if (h !== sha) changed.push(rel);
    }
    let before = {}; try { before = JSON.parse(readFileSync(join(ROOT, "files.json"), "utf8")).files || {}; } catch {}
    const removed = Object.keys(before).filter((rel) => !(rel in m.files));
    rmSync(WORK, { recursive: true, force: true });
    const stage = join(WORK, "stage"), backup = join(WORK, "backup");
    const queue = [...changed];
    const one = async () => {
      for (let rel; (rel = queue.shift());) {
        const r = await fetch(base + "files/" + rel.split("/").map(encodeURIComponent).join("/"), { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`Download failed (${r.status})`);
        let buf = Buffer.from(await r.arrayBuffer());
        if (fileHash(buf) !== m.files[rel]) throw new Error("A downloaded file was damaged. It will try again later.");
        if (/\.(vbs|cmd|bat)$/i.test(rel)) buf = Buffer.from(buf.toString("latin1").replace(/\r?\n/g, "\r\n"), "latin1");   // Windows scripts want CRLF
        const p = join(stage, ...rel.split("/")); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf);
      }
    };
    await Promise.all(Array.from({ length: 6 }, one));
    // back up what is replaced or removed, then swap the new files in
    for (const rel of [...changed, ...removed, "version.txt", "files.json"]) {   // (with the version, so a put-back retries later)
      const from = join(ROOT, ...rel.split("/"));
      if (existsSync(from)) { const to = join(backup, ...rel.split("/")); mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
    }
    for (const rel of changed) { const to = join(ROOT, ...rel.split("/")); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(stage, ...rel.split("/")), to); }
    for (const rel of removed) rmSync(join(ROOT, ...rel.split("/")), { force: true });
    writeFileSync(join(ROOT, "version.txt"), m.version);
    writeFileSync(join(ROOT, "files.json"), JSON.stringify({ version: m.version, built: m.built, files: m.files }));
    state.version = m.version; await stamp();
    // restart only what runs the changed code
    const all = [...changed, ...removed];
    if (all.some((f) => f.startsWith("ai/app/"))) await stopMatching(join(ROOT, "ai", "app"));
    if (all.some((f) => f.startsWith("beam/") || f === "hub/engines/beam_host.py")) await stopMatching(join(ROOT, "hub", "engines", "beam_host.py"));
    if (needsRestart(all)) { restartHub(backup); return { ok: true, restarting: true }; }
    state.available = null; state.installing = false;
    return { ok: true, reload: true };
  } catch (e) { state.installing = false; return { ok: false, error: e.message || String(e) }; }
}

// ---------- Shivo Labs AI on Shivam's PC: the live app (Documents\Shivo Labs AI\fabra-labs-ai) installs its
// updates from the "updates" folder next to it, through its own "Update ready" button. When this repo has a newer
// ai\app (after a pull), hand it over with ai\release.ps1 (its checks, then the copy), so updating needs no command.
// On installs (no live folder) the AI app is part of the hub's own update package instead.
const AI_LIVE = process.env.HUB_AI_LIVE || join(process.env.USERPROFILE || "", "Documents", "Shivo Labs AI"); // HUB_AI_LIVE: tests only
const readVer = (f) => { try { return JSON.parse(readFileSync(f, "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } };
const sameFile = (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
const run = (cmd, args, cwd) => new Promise((ok) => execFile(cmd, args, { cwd, windowsHide: true, timeout: 600000 }, (e, out, err) => ok({ ok: !e, out: String(out || "") + String(err || "") })));
let aiBusyHanding = false;
export async function handAiUpdate() {
  if (MODE !== "repo" || aiBusyHanding || !existsSync(join(AI_LIVE, "fabra-labs-ai"))) return null;
  const repoVer = readVer(join(ROOT, "ai", "app", "version.json"));
  const handed = readVer(join(AI_LIVE, "updates", "version.json"));
  const live = readVer(join(AI_LIVE, "fabra-labs-ai", "version.json"));
  if (!newer(repoVer, live)) { state.aiHandOff = null; return null; } // the AI app is up to date
  if (!newer(repoVer, handed)) return state.aiHandOff || null;           // handed over already, waiting for its "Update ready"
  aiBusyHanding = true;
  try {
    // new packages: add them to the live app first (adding packages doesn't disturb it)
    if (!sameFile(join(ROOT, "ai", "app", "package.json"), join(AI_LIVE, "fabra-labs-ai", "package.json"))) {
      writeFileSync(join(AI_LIVE, "fabra-labs-ai", "package.json"), readFileSync(join(ROOT, "ai", "app", "package.json")));
      const lock = join(ROOT, "ai", "app", "package-lock.json");
      if (existsSync(lock)) writeFileSync(join(AI_LIVE, "fabra-labs-ai", "package-lock.json"), readFileSync(lock));
      const n = await run("npm.cmd", ["install", "--omit=dev", "--no-audit", "--no-fund"], join(AI_LIVE, "fabra-labs-ai"));
      if (!n.ok) { state.aiHandOff = { version: repoVer, error: "Couldn't add the new packages for Shivo Labs AI." }; return state.aiHandOff; }
    }
    const r = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "ai", "release.ps1"), "-SkipInstaller", "-Runtime", AI_LIVE], ROOT);
    state.aiHandOff = r.ok ? { version: repoVer } : { version: repoVer, error: (r.out.match(/[^\r\n]*(failed|error|refuse)[^\r\n]*/i)?.[0] || "The checks didn't pass.").trim() };
    return state.aiHandOff;
  } finally { aiBusyHanding = false; }
}

// Checks every 15 minutes. Installed copies install every update by themselves, like the phone app (open windows refresh
// quietly, or show "Updating Shivo Labs..." for a moment while the hub restarts). On Shivam's PC (repo) screen changes
// install by themselves and ones that need a restart wait for "Install and restart" in Settings.
async function checkAndApply() {
  await check();
  if (!state.available || state.installing) return;
  if (MODE === "installed" || !state.available.restart) await install().catch(() => {});
}
export function autoCheck() {
  setTimeout(() => handAiUpdate().catch(() => {}), 10000); // e.g. right after the hub restarted with a pull
  setTimeout(() => checkAndApply().catch(() => {}), 30000);
  setInterval(() => checkAndApply().catch(() => {}), 15 * 60 * 1000);
  setInterval(() => handAiUpdate().catch(() => {}), 15 * 60 * 1000);
}
