// Who this PC is and which modules it may open (DISTRIBUTION-PLAN.md, id/worker). An installed copy joins a customer
// once with an invite code: it makes its own key pair, sends the public half to shivo-id and gets a signed pass (24 hours)
// listing its modules. The pass is renewed by itself every few hours with the PC's key; offline it keeps working for
// 7 days after it ran out. The hub shows and opens only the modules in the pass, and fetches a module's program files
// (its "pack") the first time the pass has it. Shivam's PC (the repo, "repo" mode) opens everything and needs no pass.
// Kept in %APPDATA%\Shivo Labs\id\device.json (HUB_ID_DIR for tests): the device id, its private key, the last pass.
// The Owner page (customers, codes, modules) works only on a PC that holds the owner key (%USERPROFILE%\.fabra-labs-ai\
// shivo-id\admin.json, made by id/setup.mjs); the key never goes to the page.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { state as upd, signedOk, restartHub } from "./update.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = join(here, "..");
const ROOT = join(HUB, "..");
export const ID_API = process.env.HUB_ID_API || "https://shivo-id.ishivamparmar.workers.dev";
const DIR = process.env.HUB_ID_DIR || join(process.env.APPDATA || homedir(), "Shivo Labs", "id");
const FILE = join(DIR, "device.json");
const ADMIN_FILE = process.env.HUB_ID_ADMIN || join(homedir(), ".fabra-labs-ai", "shivo-id", "admin.json");
const INSTALLED = join(ROOT, "installed.json");      // the modules whose packs are on this PC (written by the installer)
const ENROL = join(ROOT, "enrol.json");              // the code typed in the setup window, used at the first start
// the repo needs no pass (HUB_ID_FORCE=1 tests the installed behaviour from the repo)
const FREE = upd.mode === "repo" && !process.env.HUB_ID_FORCE;
const GRACE = 7 * 86400e3, RENEW = 6 * 3600e3;
const PACKS = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(HUB, "packs.json"), "utf8"))).filter(([k]) => !k.startsWith("_")));

const passKey = (() => { try { return createPublicKey({ key: JSON.parse(readFileSync(process.env.HUB_ID_KEY || join(HUB, "id-key.json"), "utf8")), format: "jwk" }); } catch { return null; } })();
// the pass's contents if its signature is ours; null otherwise
export function readPass(p) {
  try {
    const [data, sig] = String(p).split(".");
    if (!passKey || !verify("sha256", Buffer.from(data), { key: passKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))) return null;
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch { return null; }
}

let dev = null;
const load = () => { if (dev) return dev; try { dev = JSON.parse(readFileSync(FILE, "utf8")); } catch { dev = null; } return dev; };
function save(d) { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE + ".tmp", JSON.stringify(d)); renameSync(FILE + ".tmp", FILE); dev = d; }
export const status = { error: passKey || FREE ? null : "This copy has no pass key (hub/id-key.json)", fetching: [], lastRenew: 0, enrolling: false };

// the modules this PC may use: null = all of them (the repo); otherwise a Set (empty without a valid pass)
export function allowed() {
  if (FREE) return null;
  const p = load()?.pass && readPass(load().pass);
  if (!p || p.device !== load().device || Date.now() > p.exp + GRACE) return new Set();
  return new Set(p.modules);
}
export const may = (id) => { const a = allowed(); return !a || a.has(id); };
export const isOwner = () => existsSync(ADMIN_FILE);

// shivo-id's clock, not this PC's: a PC set to the wrong time zone is hours off and would never get a new pass
async function serverNow() {
  try { const r = await fetch(ID_API + "/now", { signal: AbortSignal.timeout(15000) }); const j = await r.json(); if (j.now) return j.now; } catch {}
  return Date.now();
}
async function post(path, body) {
  let r;
  try { r = await fetch(ID_API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error("Can't reach Shivo Labs. Check the internet; it keeps trying."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `shivo-id answered ${r.status}`); e.status = r.status; e.removed = !!j.removed; throw e; }
  return j;
}

export async function enrol(code) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const r = await post("/enrol", { code, kind: "pc", name: hostname(), key: publicKey.export({ format: "jwk" }), version: upd.version });
  save({ device: r.device, key: privateKey.export({ format: "jwk" }), pass: r.pass, customer: r.customer });
  status.error = null; status.lastRenew = Date.now();
  await ensurePacks();
  restartHub();   // start this PC's modules (their background parts start with the hub)
  return { ok: true, customer: r.customer, modules: r.modules };
}

export async function renew() {
  const d = load(); if (!d?.device) return;
  const before = [...(allowed() || [])].sort().join();
  try {
    const ts = await serverNow();
    const sig = sign("sha256", Buffer.from(`${d.device}.${ts}`), { key: createPrivateKey({ key: d.key, format: "jwk" }), dsaEncoding: "ieee-p1363" }).toString("base64url");
    const r = await post("/pass", { device: d.device, ts, sig, version: upd.version });
    save({ ...d, pass: r.pass }); status.error = null; status.lastRenew = Date.now();
  } catch (e) {
    status.error = e.message;
    if (e.removed) save({ ...d, pass: null });   // removed by the owner: no modules from now on
  }
  await afterChange(before);
}

// the pass changed what this PC may use: fetch the packs it doesn't have yet, then restart the hub so it starts only
// the allowed modules' background parts (Beam, Mirror, sync)
async function afterChange(before) {
  const got = await ensurePacks();
  if (got || before !== [...(allowed() || [])].sort().join()) restartHub();
}

// ---------- packs: a module's program files, from shivo-id (only with a pass that has it), checked against the signed index
const installed = () => { try { return JSON.parse(readFileSync(INSTALLED, "utf8")).modules || []; } catch { return []; } };
export const hasPack = (id) => upd.mode === "repo" || !PACKS[id] || installed().includes(id);   // (the repo has every module)
const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { windowsHide: true, timeout: 900000 }, (e, out, err) => (e ? no(new Error(String(err || e.message).trim())) : ok(out))));
let busy = null;
export function ensurePacks() { return (busy ??= fetchPacks().finally(() => { busy = null; })); }
async function fetchPacks() {
  if (FREE || upd.mode === "repo") return false;
  const want = [...(allowed() || [])].filter((m) => PACKS[m] && !installed().includes(m));
  if (!want.length) return false;
  status.fetching = want;
  try {
    const get = async (n) => { const r = await fetch(`${ID_API}/packs/${n}`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`Couldn't get the list of modules (${r.status})`); return r.text(); };
    const [text, sig] = await Promise.all([get("index.json"), get("index.sig")]);
    if (!signedOk(text, sig)) throw new Error("The list of modules isn't signed by Shivo Labs");
    const index = JSON.parse(text);
    const work = join(process.env.LOCALAPPDATA || tmpdir(), "Shivo Labs", "packs");
    let got = 0;
    for (const m of want) {
      const info = index.packs?.[m];
      if (!info) { status.error = `${m} isn't published yet`; continue; }   // not a reason to restart (that looped)
      rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
      const zip = join(work, `${m}.zip`);
      const r = await fetch(`${ID_API}/packs/${m}.zip?pass=${encodeURIComponent(load().pass)}`, { signal: AbortSignal.timeout(900000) });
      if (!r.ok) throw new Error(`Couldn't download ${m} (${r.status})`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(zip));
      const h = createHash("sha256").update(readFileSync(zip)).digest("hex");
      if (h !== info.sha256) throw new Error(`The ${m} download was damaged. It will try again later.`);
      const q = (s) => `'${s.replace(/'/g, "''")}'`;
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${q(zip)}, ${q(join(work, "x"))}); ` +
        `robocopy ${q(join(work, "x"))} ${q(ROOT)} /E /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { exit 1 } else { exit 0 }`]);
      writeFileSync(INSTALLED, JSON.stringify({ modules: [...new Set([...installed(), m])] }));
      got++;
    }
    rmSync(work, { recursive: true, force: true });
    if (got === want.length) status.error = null;
    return got > 0;
  } catch (e) { status.error = e.message; return false; } finally { status.fetching = []; }
}

export function startId() {
  try { startIdNow(); } catch (e) { status.error = e.message; }   // never let this stop the hub
}
function startIdNow() {
  if (FREE) return;
  if (!existsSync(INSTALLED) && upd.mode === "installed") {
    // an install from before packs (everything was copied): what is on disk counts as installed
    writeFileSync(INSTALLED, JSON.stringify({ modules: Object.keys(PACKS).filter((m) => m !== "core" && PACKS[m].some((p) => existsSync(join(ROOT, p)))) }));
  }
  // the code typed in the setup window joins this PC at its first start (also a reinstall with a new code); offline,
  // it tries again every minute and the window says it's setting up meanwhile
  const join_ = async () => {
    if (status.enrolling) return;
    status.enrolling = true;
    try { await enrol(JSON.parse(readFileSync(ENROL, "utf8")).code); rmSync(ENROL, { force: true }); }
    catch (e) { status.error = e.message; if (e.status === 404 || e.status === 400) rmSync(ENROL, { force: true }); }
    finally { status.enrolling = false; }
  };
  if (existsSync(ENROL)) { join_().catch(() => {}); const t = setInterval(() => (existsSync(ENROL) ? join_().catch(() => {}) : clearInterval(t)), 60e3); }
  else renew().catch(() => {});
  setInterval(() => renew().catch(() => {}), RENEW);
  // a pack that couldn't be fetched (offline, not published yet) is tried again every 15 minutes
  setInterval(() => ensurePacks().then((got) => got && restartHub()).catch(() => {}), 15 * 60e3);
}

// ---------- the hub's own API: /api/id (this PC) and /api/owner/* (the Owner page)
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = async (req) => { let s = ""; for await (const c of req) s += c; try { return JSON.parse(s || "{}"); } catch { return {}; } };
export async function idApi(req, res, path) {
  if (path === "/api/id" && req.method === "GET") {
    const p = load()?.pass && readPass(load().pass), a = allowed();
    const enrolling = !FREE && (status.enrolling || existsSync(ENROL));
    return json(res, 200, { free: FREE, enrolling, needCode: !FREE && !enrolling && (!load()?.device || !load()?.pass), customer: p?.name || load()?.customer || null,
      modules: a ? [...a] : null, expires: p?.exp || null, error: status.error, fetching: status.fetching, owner: isOwner(), api: ID_API }), true;
  }
  // the Chat screen joins this PC's customer team with the pass (chat/README.md "Teams"); POST, so only the hub's own page
  if (path === "/api/id/chatpass" && req.method === "POST") {
    const pass = load()?.pass, p = pass && readPass(pass);
    return json(res, 200, { pass: !FREE && p && p.device === load().device && p.modules.includes("chat") ? pass : null }), true;
  }
  if (path === "/api/id/enrol" && req.method === "POST") {
    const { code } = await readJson(req);
    try { return json(res, 200, await enrol(String(code || ""))), true; }
    catch (e) { return json(res, e.status === 404 ? 400 : 502, { error: e.status === 404 ? "That code is wrong or has expired" : e.message }), true; }
  }
  if (path.startsWith("/api/owner/")) {
    if (!isOwner()) return json(res, 403, { error: "Only on the owner's PC" }), true;
    const a = JSON.parse(readFileSync(ADMIN_FILE, "utf8"));
    const body = req.method === "POST" ? JSON.stringify(await readJson(req)) : undefined;
    const r = await fetch((a.url || ID_API) + "/admin/" + path.slice(11), { method: req.method, headers: { authorization: "Bearer " + a.key, "content-type": "application/json" }, body, signal: AbortSignal.timeout(20000) });
    return json(res, r.status, await r.json().catch(() => ({ error: `shivo-id answered ${r.status}` }))), true;
  }
  return false;
}
