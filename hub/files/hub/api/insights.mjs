// Insights: the website's visitor numbers (shivolabs.com), the same as the phone app's Insights.
// GET /api/insights?range=7d asks the Cloudflare shelf (/s/<READ>/insights), which asks the website with its key, so
// this PC never holds that key. Needs the shelf set up (shelf/setup.mjs: ~\.fabra-labs-ai\shelf\config.json).
// The last answer per range is kept on disk, so the page opens at once and still shows something offline.
// Test copies only: HUB_INSIGHTS_SITE + HUB_INSIGHTS_TOKEN ask a website directly (e.g. the site's `npm run dev`).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HOME = join(process.env.USERPROFILE || "", ".fabra-labs-ai");
const CFG = join(HOME, "shelf", "config.json");
const KEEP = join(HOME, "insights");
const RANGES = new Set(["24h", "7d", "30d", "90d", "12m"]);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return null; } };
// what the screen says when the cloud can't be reached (the shelf's own reasons are already plain)
const plain = (e) => (/fetch failed|network|timeout|aborted|ENOTFOUND|ECONN/i.test(String(e?.message || e)) ? "Check the internet connection and try again." : String(e?.message || e));
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

function source(range) {
  if (process.env.HUB_INSIGHTS_SITE) return { url: `${process.env.HUB_INSIGHTS_SITE}/api/apps/insights?range=${range}`, headers: { authorization: `Bearer ${process.env.HUB_INSIGHTS_TOKEN || ""}` } };
  const cfg = readJson(CFG);
  if (!cfg?.url || !cfg?.read) return null;
  return { url: `${cfg.url}/s/${cfg.read}/insights?range=${range}`, headers: {} };
}

export async function insightsApi(req, res, path, url) {
  if (path !== "/api/insights" || req.method !== "GET") return false;
  const range = RANGES.has(url.searchParams.get("range")) ? url.searchParams.get("range") : "7d";
  const kept = join(KEEP, `${range}.json`);
  const src = source(range);
  if (!src) return send(res, 200, { error: "setup", message: "Insights need Shivo Labs' Cloudflare shelf on this PC." }), true;
  try {
    const r = await fetch(src.url, { headers: { accept: "application/json", ...src.headers }, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`answered ${r.status}`); }
    if (!r.ok || j.error) throw new Error(j.error || `answered ${r.status}`);
    try { mkdirSync(KEEP, { recursive: true }); writeFileSync(kept, text); } catch {}
    send(res, 200, j);
  } catch (e) {
    const old = readJson(kept);
    // the last numbers seen, marked as such; otherwise the reason
    if (old) send(res, 200, { ...old, stale: String(e.message || e) });
    else send(res, 200, { error: "offline", message: plain(e) });
  }
  return true;
}
