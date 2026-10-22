// Who this PC is and which modules it may open (DISTRIBUTION-PLAN.md, id/worker). An installed copy joins a customer
// once with an invite code: it makes its own key pair, sends the public half to shivo-id and gets a signed pass (24 hours)
// listing its modules. The pass is renewed by itself every few hours with the PC's key; offline it keeps working for
// 7 days after it ran out. The hub shows and opens only the modules in the pass, and fetches a module's program files
// (its "pack") the first time the pass has it. Shivam's PC (the repo, "repo" mode) opens everything and needs no pass.
// Kept in %APPDATA%\Shivo Labs\id\device.json (HUB_ID_DIR for tests): the device id, its private key, the last pass.
// The Owner page (customers, codes, modules) works only on a PC that holds the owner key (%USERPROFILE%\.fabra-labs-ai\
// shivo-id\admin.json, made by id/setup.mjs); the key never goes to the page.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname, tmpdir, release } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { state as upd, signedOk, restartHub } from "./update.mjs";
import { download } from "./download.mjs";

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
// this PC's pass when it has that module (for its server: Chat, Cloud); null on the repo or without it
export function passWith(mod) {
  if (FREE) return null;
  const pass = load()?.pass, p = pass && readPass(pass);
  return p && p.device === load().device && p.modules.includes(mod) && Date.now() < p.exp ? pass : null;
}
export const isOwner = () => existsSync(ADMIN_FILE);

// the owner's PC holds the key that signs passes (made by id/setup.mjs, also in shivo-id): it signs itself a pass that
// sets up and owns Shivam's own Chat team in one click, no setup code (chat/README.md "Teams"). Made fresh each time
// Chat asks and good for 10 minutes; shivo-id never puts "owner" in a pass, so no other PC can have one.
const PASS_KEY = process.env.HUB_ID_PASSKEY || join(homedir(), ".fabra-labs-ai", "shivo-id", "pass-key.json");
function ownerChatPass() {
  const now = Date.now();
  const body = { v: 1, device: "owner-" + createHash("sha256").update(hostname()).digest("hex").slice(0, 12), kind: "pc", customer: "owner",
    name: "Shivo Labs", modules: ["chat"], owner: true, iat: now, exp: now + 10 * 60e3 };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  const key = createPrivateKey({ key: JSON.parse(readFileSync(PASS_KEY, "utf8")), format: "jwk" });
  return `${data}.${sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

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

// ---------- joining by QR (UNIFY-PLAN.md, 23 Oct 2026): instead of typing the code, this PC asks shivo-id to be added
// and shows that as a QR; a phone that is already joined scans it and approves it, and this PC joins that phone's
// customer. Checked every few seconds by the code screen; a join lasts 10 minutes, then the screen asks for a new one.
let joining = null;   // {join, check, link, expires, key: this PC's new private key (JWK)}
async function joinStart() {
  if (joining && joining.expires > Date.now() + 60e3) return joining;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const r = await post("/join/new", { kind: "pc", name: hostname(), key: publicKey.export({ format: "jwk" }), version: upd.version });
  joining = { ...r, key: privateKey.export({ format: "jwk" }) };
  return joining;
}
async function joinCheck() {
  if (!joining) return { expired: true };
  const ts = await serverNow();
  const sig = sign("sha256", Buffer.from(`wait.${joining.join}.${ts}`), { key: createPrivateKey({ key: joining.key, format: "jwk" }), dsaEncoding: "ieee-p1363" }).toString("base64url");
  let r;
  try { r = await post("/join/wait", { join: joining.join, ts, sig }); }
  catch (e) { if (e.status === 404) { joining = null; return { expired: true }; } throw e; }
  if (r.waiting) return { waiting: true };
  save({ device: r.device, key: joining.key, pass: r.pass, customer: r.customer });
  joining = null; status.error = null; status.lastRenew = Date.now();
  await ensurePacks();
  restartHub();   // start this PC's modules, as after typing the code
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

// ---------- check-ins (UNIFY-PLAN.md, 23 Oct 2026): every 15 minutes while the hub runs, this PC tells shivo-id it is
// there, with its version and its last update result, for the Owner pages (online, version, update problems)
// (also its Beam relay address, so its company's phones find it from anywhere: /devices in shivo-id)
const beamRelay = () => { try { const r = JSON.parse(readFileSync(join(process.env.APPDATA || homedir(), "Beam", "relay.json"), "utf8")); return r.id && r.url ? { id: r.id, url: r.url } : undefined; } catch { return undefined; } };
// a request signed with this PC's key: {device, ts, sig} over "<what>.<device>.<ts>"
async function signedBy(what) {
  const d = load(); if (!d?.device) throw new Error("This PC hasn't joined Shivo Labs");
  const ts = await serverNow();
  return { device: d.device, ts, sig: sign("sha256", Buffer.from(`${what}.${d.device}.${ts}`), { key: createPrivateKey({ key: d.key, format: "jwk" }), dsaEncoding: "ieee-p1363" }).toString("base64url") };
}
async function alive() {
  const d = load(); if (!d?.device || !d.pass) return;
  try {
    const build = Number(release().split(".")[2]) || 0;
    await post("/alive", { ...(await signedBy("alive")), version: upd.version, info: { app: "laptop", os: `Windows ${build >= 22000 ? 11 : 10}`, beam: beamRelay(),
      update: { ok: !upd.error, msg: upd.error || (upd.available ? `Update ${upd.available.version} waiting` : ""), at: upd.lastCheck } } });
  } catch (e) { if (e.removed) renew().catch(() => {}); }   // removed by the owner: the renew takes the modules away
}

// ---------- the devices of this PC's company (UNIFY-PLAN.md): a phone of the same company asking for Beam away from
// home is checked against its key here (hub/api/beamrelay.mjs). Asked of shivo-id at most once a minute.
let company = { at: 0, list: [] };
async function companyDevices() {
  if (Date.now() - company.at > 60e3) company = { at: Date.now(), list: (await post("/devices", await signedBy("devices"))).devices || [] };
  return company.list;
}
// is this a phone of this PC's company, with Cloud (Beam is part of it), that signed "<text>.<ts>" just now? -> its row
export async function checkPhone(device, ts, sig, text) {
  if (Math.abs((await serverNow()) - Number(ts)) > 10 * 60e3) return null;
  let list = await companyDevices().catch(() => []);
  let p = list.find((x) => x.id === device);
  // a phone that joined a moment ago: ask again, but at most every 10 seconds (unknown phones can't make it hammer shivo-id)
  if (!p && Date.now() - company.at > 10e3) { company.at = 0; list = await companyDevices().catch(() => []); p = list.find((x) => x.id === device); }
  if (!p || p.kind !== "phone" || !p.modules?.includes("files")) return null;
  try { return verify("sha256", Buffer.from(`${text}.${ts}`), { key: createPublicKey({ key: p.key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(String(sig), "base64url")) ? p : null; } catch { return null; }
}

// ---------- the owner's own PC running from the repo (FREE: it opens everything without a pass) joins shivo-id too, as
// a device of the owner customer, so it checks in, shows on the Owner pages and lets its own phones use Beam from
// anywhere. Made with the owner key (admin.json): a one-use code for the owner customer, used at once.
async function ownerJoin() {
  if (load()?.device) return;
  const a = JSON.parse(readFileSync(ADMIN_FILE, "utf8")), base = a.url || ID_API, h = { authorization: "Bearer " + a.key, "content-type": "application/json" };
  const st = await (await fetch(base + "/admin/state", { headers: h, signal: AbortSignal.timeout(20000) })).json();
  const own = st.customers?.find((c) => c.owner); if (!own) return;
  const c = await (await fetch(base + "/admin/code", { method: "POST", headers: h, body: JSON.stringify({ customer: own.id, uses: 1, days: 1, label: "This PC" }), signal: AbortSignal.timeout(20000) })).json();
  if (!c.code) return;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const r = await post("/enrol", { code: c.code, kind: "pc", name: hostname(), key: publicKey.export({ format: "jwk" }), version: upd.version });
  save({ device: r.device, key: privateKey.export({ format: "jwk" }), pass: r.pass, customer: r.customer });
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
    // a pack that broke off halfway stays here (named after its checksum) and the next try carries on from there
    const work = join(process.env.LOCALAPPDATA || tmpdir(), "Shivo Labs", "packs");
    mkdirSync(work, { recursive: true });
    let got = 0;
    for (const m of want) {
      const info = index.packs?.[m];
      if (!info) { status.error = `${m} isn't published yet`; continue; }   // not a reason to restart (that looped)
      const zip = join(work, `${m}-${info.sha256.slice(0, 12)}.zip`), x = join(work, "x");
      const url = `${ID_API}/packs/${m}.zip?pass=${encodeURIComponent(load().pass)}`;
      const sum = () => createHash("sha256").update(readFileSync(zip)).digest("hex");
      try { await download(url, zip); } catch (e) { throw new Error(`Couldn't download ${m} (${e.status || e.message}). It will carry on later.`); }
      if (sum() !== info.sha256) {   // a damaged or out-of-date part: once more from zero
        rmSync(zip, { force: true });
        await download(url, zip);
        if (sum() !== info.sha256) { rmSync(zip, { force: true }); throw new Error(`The ${m} download was damaged. It will try again later.`); }
      }
      rmSync(x, { recursive: true, force: true });
      const q = (s) => `'${s.replace(/'/g, "''")}'`;
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${q(zip)}, ${q(x)}); ` +
        `robocopy ${q(x)} ${q(ROOT)} /E /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { exit 1 } else { exit 0 }`]);
      writeFileSync(INSTALLED, JSON.stringify({ modules: [...new Set([...installed(), m])] }));
      rmSync(zip, { force: true }); rmSync(x, { recursive: true, force: true });
      got++;
    }
    if (got === want.length) rmSync(work, { recursive: true, force: true });
    if (got === want.length) status.error = null;
    return got > 0;
  } catch (e) { status.error = e.message; return false; } finally { status.fetching = []; }
}

export function startId() {
  try { startIdNow(); } catch (e) { status.error = e.message; }   // never let this stop the hub
}
function startIdNow() {
  if (FREE) {
    if (!isOwner()) return;
    const go = () => ownerJoin().then(() => renew()).catch(() => {});
    go(); setInterval(go, RENEW);
    setTimeout(alive, 60e3); setInterval(alive, 15 * 60e3);
    return;
  }
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
    catch (e) {
      status.error = e.message;
      if (e.status === 404 || e.status === 400) {   // a code that can't be used (any more): a PC that joined before carries on with that
        rmSync(ENROL, { force: true });
        if (load()?.device) renew().catch(() => {});
      }
    }
    finally { status.enrolling = false; }
  };
  if (existsSync(ENROL)) { join_().catch(() => {}); const t = setInterval(() => (existsSync(ENROL) ? join_().catch(() => {}) : clearInterval(t)), 60e3); }
  else renew().catch(() => {});
  setInterval(() => renew().catch(() => {}), RENEW);
  setTimeout(alive, 60e3); setInterval(alive, 15 * 60e3);
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
    if (isOwner() && existsSync(PASS_KEY)) return json(res, 200, { pass: ownerChatPass() }), true;
    const pass = load()?.pass, p = pass && readPass(pass);
    return json(res, 200, { pass: !FREE && p && p.device === load().device && p.modules.includes("chat") ? pass : null }), true;
  }
  if (path === "/api/id/enrol" && req.method === "POST") {
    const { code } = await readJson(req);
    try { return json(res, 200, await enrol(String(code || ""))), true; }
    catch (e) { return json(res, e.status === 404 ? 400 : 502, { error: e.status === 404 ? "That code is wrong or has expired" : e.message }), true; }
  }
  // the code screen's QR: start a join (or keep the current one), then ask every few seconds whether a phone approved it
  if (path === "/api/id/join" && req.method === "POST") {
    try { const j = await joinStart(); return json(res, 200, { link: j.link, check: j.check, expires: j.expires }), true; }
    catch (e) { return json(res, 502, { error: e.message }), true; }
  }
  if (path === "/api/id/join/wait" && req.method === "POST") {
    try { return json(res, 200, await joinCheck()), true; }
    catch (e) { return json(res, 502, { error: e.message }), true; }
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
