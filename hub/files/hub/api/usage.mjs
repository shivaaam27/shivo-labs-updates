// What Shivo Labs uses on Cloudflare, against the free plan's limits (UNIFY-PLAN.md phase 4), for the Owner page:
// requests per day (all Workers together, and per Worker), Durable Objects, the shelf's KV store, the databases (D1),
// R2 storage and operations this month, and each customer's Cloud space. On the owner's PC only. Read with Cloudflare's
// own analytics (GraphQL) and the R2 usage API, with a token from CLOUDFLARE_API_TOKEN, ~\.fabra-labs-ai\cloudflare-token.txt
// (a token with Account Analytics: Read and R2: Read), or else wrangler's sign-in on this PC.
// Every hour the owner's PC looks, and a Windows notification says when anything passes 70% (once a day per item).
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { notify } from "./tray.mjs";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "d2c4cc5329a5be4efaf74e6cbe7d9504";
const BUCKETS = ["shivo-labs-files", "shivo-labs-packs", "shivo-labs-chat-files"];
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// the free plan (Cloudflare's docs, checked 23 Oct 2026); daily ones reset at midnight UTC (3 am in Dar es Salaam)
export const LIMITS = {
  requests: { name: "Requests to the Workers", limit: 100000, per: "day" },
  doRequests: { name: "Durable Object requests", limit: 100000, per: "day" },
  kvReads: { name: "Shelf reads (KV)", limit: 100000, per: "day" },
  kvWrites: { name: "Shelf writes (KV)", limit: 1000, per: "day" },
  d1Read: { name: "Database rows read (D1)", limit: 5000000, per: "day" },
  d1Written: { name: "Database rows written (D1)", limit: 100000, per: "day" },
  storage: { name: "Storage (R2)", limit: 10 * 1024 ** 3, per: "total", bytes: true },
  classA: { name: "Uploads and lists (R2)", limit: 1000000, per: "month" },
  classB: { name: "Downloads (R2)", limit: 10000000, per: "month" },
};
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "UploadPart", "UploadPartCopy", "ListMultipartUploads", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);

// ---------- the token
let tok = { value: "", at: 0 };
const run = (cmd, args, opts) => new Promise((ok) => execFile(cmd, args, { windowsHide: true, timeout: 60000, ...opts }, (e, out) => ok(e ? "" : String(out))));
async function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const f = join(homedir(), ".fabra-labs-ai", "cloudflare-token.txt");
  // wrangler's sign-in first where the repo is (it can read everything); the token file otherwise
  if (!existsSync(join(REPO, "id", "worker", "wrangler.toml")) && existsSync(f)) return readFileSync(f, "utf8").trim();
  if (tok.value && Date.now() - tok.at < 20 * 60000) return tok.value;
  // wrangler's own sign-in (it refreshes it when needed); runs in the repo's id/worker folder where wrangler is set up
  const out = await run(process.platform === "win32" ? "cmd.exe" : "npx", process.platform === "win32" ? ["/c", "npx", "wrangler", "auth", "token"] : ["wrangler", "auth", "token"], { cwd: join(REPO, "id", "worker") });
  const t = out.trim().split(/\s+/).pop() || "";
  if (!/^[\w.-]{20,}$/.test(t) && existsSync(f)) return readFileSync(f, "utf8").trim();
  if (!/^[\w.-]{20,}$/.test(t)) throw new Error("No Cloudflare sign-in on this PC (wrangler login, or ~\\.fabra-labs-ai\\cloudflare-token.txt).");
  tok = { value: t, at: Date.now() };
  return t;
}
const cf = async (t, path, body) => {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error("Cloudflare: " + (j.errors?.[0]?.message || r.status));
  return j;
};

// ---------- reading it (kept 10 minutes)
let cache = { at: 0, data: null };
export async function usage(fresh = false) {
  if (!fresh && cache.data && Date.now() - cache.at < 10 * 60000) return cache.data;
  const t = await token(), now = new Date(), day = now.toISOString().slice(0, 10), iso = now.toISOString();
  const week = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), month = day.slice(0, 8) + "01";
  const q = `{ viewer { accounts(filter: {accountTag: "${ACCOUNT}"}) {
    w: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: "${day}T00:00:00Z", datetime_leq: "${iso}"}) { sum { requests errors } dimensions { scriptName } }
    days: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: "${week}T00:00:00Z", datetime_leq: "${iso}"}) { sum { requests } dimensions { date } }
    d: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {date_geq: "${day}", date_leq: "${day}"}) { sum { requests } }
    kv: kvOperationsAdaptiveGroups(limit: 20, filter: {date_geq: "${day}", date_leq: "${day}"}) { sum { requests } dimensions { actionType } }
    d1: d1AnalyticsAdaptiveGroups(limit: 10, filter: {date_geq: "${day}", date_leq: "${day}"}) { sum { rowsRead rowsWritten } }
    r2: r2OperationsAdaptiveGroups(limit: 200, filter: {datetime_geq: "${month}T00:00:00Z", datetime_leq: "${iso}"}) { sum { requests } dimensions { actionType } }
  } } }`;
  const a = (await cf(t, "/graphql", { query: q })).data?.viewer?.accounts?.[0] || {};
  const sum = (rows, f) => (rows || []).reduce((n, x) => n + (f(x) || 0), 0);
  const workers = {}; for (const x of a.w || []) if (x.dimensions.scriptName && x.dimensions.scriptName !== "__unknown__") workers[x.dimensions.scriptName] = (workers[x.dimensions.scriptName] || 0) + x.sum.requests;
  const days = {}; for (const x of a.days || []) days[x.dimensions.date] = (days[x.dimensions.date] || 0) + x.sum.requests;
  const kv = (type) => sum((a.kv || []).filter((x) => x.dimensions.actionType === type), (x) => x.sum.requests);
  let storage = 0; const buckets = {};
  for (const b of BUCKETS) {
    try { const u = (await cf(t, `/accounts/${ACCOUNT}/r2/buckets/${b}/usage`)).result || {}; buckets[b] = Number(u.payloadSize || 0) + Number(u.metadataSize || 0); storage += buckets[b]; } catch (e) { buckets[b] = String(e.message); }
  }
  const used = {
    requests: sum(a.w, (x) => x.sum.requests), doRequests: sum(a.d, (x) => x.sum.requests), kvReads: kv("read"), kvWrites: kv("write") + kv("delete"),
    d1Read: sum(a.d1, (x) => x.sum.rowsRead), d1Written: sum(a.d1, (x) => x.sum.rowsWritten), storage,
    classA: sum((a.r2 || []).filter((x) => CLASS_A.has(x.dimensions.actionType)), (x) => x.sum.requests),
    classB: sum((a.r2 || []).filter((x) => !CLASS_A.has(x.dimensions.actionType) && x.dimensions.actionType !== "DeleteObject"), (x) => x.sum.requests),
  };
  const items = Object.entries(LIMITS).map(([k, l]) => ({ id: k, ...l, used: used[k], pct: Math.round((used[k] / l.limit) * 1000) / 10 }));
  // each customer's Cloud space (the Files Worker's own list; only on a PC with the create key)
  let customers = [];
  try {
    const r = await fetch(`http://localhost:${process.env.HUB_PORT || 4800}/api/files/admin/accounts`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) customers = ((await r.json()).accounts || []).map((c) => ({ name: c.name || "Shivo Labs", used: c.used || 0, quota: c.quota || 0, devices: c.devices || 0, plan: c.planName || c.plan }));
  } catch {}
  cache = { at: Date.now(), data: { at: Date.now(), items, workers, days, buckets, customers, errors: sum(a.w, (x) => x.sum.errors) } };
  return cache.data;
}

// ---------- every hour: a notification when something passes 70% (once a day for each)
const warned = {};
export function startUsageWatch() {
  const look = async () => {
    try {
      const u = await usage(true), today = new Date().toISOString().slice(0, 10);
      for (const it of u.items) {
        if (it.pct < 70 || warned[it.id] === today) continue;
        warned[it.id] = today;
        notify(`Cloudflare: ${it.name} at ${Math.round(it.pct)}%`, `Free limit ${it.per === "total" ? "" : "per " + it.per + " "}reached at 100%. See Shivo Labs › Owner › Cloudflare.`, false);
      }
    } catch {}
  };
  setTimeout(look, 2 * 60000); setInterval(look, 60 * 60000);
}
