// Shivo Labs AI: a local coding assistant billed to your Claude API credits.
import express from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, execFile, execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  Anthropic, TOOLS, SERVER_TOOLS, serverToolsFor, DEPTHS, WRITE_TOOLS, HELPER_TOOLS, costOf, makeToolRunner, systemPrompt,
  stopBackgroundProcesses, loadMemory, loadAutoMemory, listNotes, loadCommands, listProcesses, killProcess, lineDiff, loadSkills, resetShell, environment,
} from "./agent.mjs";
import { loadAgents, findHelper, helperToolNames, helperModel, helperSystem, changesThings } from "./subagents.mjs";
import { connectorTools, searchTools, FIND_TOOLS } from "./toolsearch.mjs";
import { userTermOpen, userTermSubscribe, userTermInput, userTermResize, userTermClose, closeUserTerms, ptyReady } from "./pty.mjs";
import { relayFor, probePort } from "./relay.mjs";
import { cloudTurn, followCloud } from "./cloud.mjs";
import { cliStatus, loginState, startWebLogin, cancelWebLogin, tokenLogin, logout as ghLogout, setIdentity } from "./cli.mjs";
import { toolSecretNotes, initSecrets, secretsReady, secretNames, listSecrets, setSecret, envFor, scrub, secretValue, protectValues, unprotectValues } from "./secrets.mjs";
import { loadRules, decide, runHooks, settingsFiles } from "./rules.mjs";
import { makeConnectors } from "./mcp.mjs";
import { makeMcpAuth } from "./mcpauth.mjs";
import { gitInfo, prStatus, fileDiff, addWorktree, removeWorktree } from "./git.mjs";
import { PROVIDERS, isClaude, splitModel, listModels, chatStep, makeGeminiLimits, geminiWithFallback, geminiRank, freeLimits, trimHistory } from "./providers.mjs";
import { STUDIO_TOOLS, makeArtifacts, renderArtifact, exportPdf, exportDocx, exportPptx, exportXlsx, makeBrowser, OFFICE, officeToPdf } from "./studio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The development copy runs on its own port with its own data (FABRA_PORT / FABRA_DATA).
const PORT = Number(process.env.FABRA_PORT) || 4823;
const dataDir = process.env.FABRA_DATA || join(homedir(), ".fabra-labs-ai");
const sessionsDir = join(dataDir, "sessions");
mkdirSync(sessionsDir, { recursive: true });

// The keys can be saved from the app's Settings; they live only in this Windows user's folder,
// each one encrypted with Windows DPAPI (stored as "dpapi:<base64>", only this user on this PC can
// unlock it), and are never sent back to the page in full. While the app runs they are kept unlocked in memory.
const configFile = join(dataDir, "config.json");
const SEALED = "dpapi:";
const unlocked = new Map(); // "dpapi:..." -> key
const keyPaths = (cfg) => [["apiKey"], ["research", "braveKey"], ...Object.keys(cfg.providers || {}).map((p) => ["providers", p, "key"])];
const getAt = (o, path) => path.reduce((x, k) => x?.[k], o);
const setAt = (o, path, v) => { const last = path.at(-1), parent = path.slice(0, -1).reduce((x, k) => x?.[k], o); if (parent) parent[last] = v; };
function readRawConfig() {
  try { return JSON.parse(readFileSync(configFile, "utf8").replace(/^﻿/, "")); } catch { return {}; } // (a BOM from Notepad/PowerShell is fine)
}
function loadConfig() {
  const cfg = readRawConfig();
  for (const p of keyPaths(cfg)) { const v = getAt(cfg, p); if (typeof v === "string" && v.startsWith(SEALED)) setAt(cfg, p, unlocked.get(v) || ""); }
  return cfg;
}
// Writes config.json with every key encrypted. If Windows can't encrypt (very unusual), the key is kept as before so nothing breaks.
async function saveConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg)), todo = {};
  const known = new Map([...unlocked].map(([sealed, plain]) => [plain, sealed]));
  for (const [i, p] of keyPaths(out).entries()) {
    const v = getAt(out, p);
    if (typeof v !== "string" || !v || v.startsWith(SEALED)) continue;
    if (known.has(v)) setAt(out, p, known.get(v)); else todo[i] = v;
  }
  if (Object.keys(todo).length) {
    try {
      const enc = await protectValues(todo), paths = keyPaths(out);
      for (const [i, plain] of Object.entries(todo)) if (enc[i]) { const sealed = SEALED + enc[i]; unlocked.set(sealed, plain); setAt(out, paths[+i], sealed); }
    } catch (e) { console.error("Keys couldn't be encrypted, kept as they were:", e.message); }
  }
  writeFileSync(configFile, JSON.stringify(out, null, 2));
}
// On start: unlock the saved keys, and encrypt any key an older version saved in plain text.
await (async () => {
  const raw = readRawConfig(), sealed = {};
  for (const [i, p] of keyPaths(raw).entries()) { const v = getAt(raw, p); if (typeof v === "string" && v.startsWith(SEALED)) sealed[i] = v.slice(SEALED.length); }
  if (Object.keys(sealed).length) {
    try { const out = await unprotectValues(sealed); for (const [i, b64] of Object.entries(sealed)) if (typeof out[i] === "string") unlocked.set(SEALED + b64, out[i]); }
    catch (e) { console.error("Saved keys couldn't be unlocked:", e.message); }
  }
  const plain = keyPaths(raw).some((p) => { const v = getAt(raw, p); return typeof v === "string" && v && !v.startsWith(SEALED); });
  if (plain) await saveConfig(loadConfig());
})();
let apiKey = loadConfig().apiKey || process.env.ANTHROPIC_API_KEY || "";
const maskKey = (k) => (k ? `sk-ant-…${k.slice(-4)}` : null);

// Usage is kept in a small file so totals survive restarts.
const usageFile = join(dataDir, "usage.json");
const monthKey = () => new Date().toISOString().slice(0, 7);
function loadUsage() {
  try { return JSON.parse(readFileSync(usageFile, "utf8")); } catch { return { budget: 100, months: {} }; }
}
// The credits period (24 Oct 2026): Anthropic's free monthly credits come back on the day of the month they were granted, not on
// the 1st, so the meter counts from `resetDay` (default 1; set in Usage & credits). `u.cycle` is the period now running; a finished
// one moves to `u.cycles`. `months` keeps the calendar-month history as before.
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function cycleBounds(resetDay, now = new Date()) {
  const at = (y, m) => new Date(y, m, Math.min(resetDay, new Date(y, m + 1, 0).getDate()));
  let start = at(now.getFullYear(), now.getMonth());
  if (start > now) start = at(now.getFullYear(), now.getMonth() - 1);
  return { start, end: at(start.getFullYear(), start.getMonth() + 1) };
}
const emptyCycle = (start) => ({ start, cost: 0, input: 0, output: 0, cacheRead: 0, requests: 0, byModel: {} });
function rollCycle(u) {   // brings u.cycle up to the period that is running now; true when u changed
  u.resetDay = Math.min(31, Math.max(1, Math.floor(Number(u.resetDay)) || 1));
  const key = dayKey(cycleBounds(u.resetDay).start);
  if (!u.cycle) {
    const m = u.months[monthKey()];   // first time: the month so far, when credits come back on the 1st
    u.cycle = u.resetDay === 1 && m ? { ...emptyCycle(key), ...JSON.parse(JSON.stringify(m)), start: key } : emptyCycle(key);
    return true;
  }
  if (u.cycle.start !== key) {
    (u.cycles ||= {})[u.cycle.start] = u.cycle;
    for (const k of Object.keys(u.cycles).sort().slice(0, -12)) delete u.cycles[k];
    u.cycle = emptyCycle(key);
    return true;
  }
  return false;
}
function addUsage(cost, usage = {}, model = "") {
  const u = loadUsage();
  rollCycle(u);
  for (const m of [(u.months[monthKey()] ||= { cost: 0, input: 0, output: 0, cacheRead: 0, requests: 0, byModel: {} }), u.cycle]) {
    m.cost += cost || 0;
    m.input += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    m.output += usage.output_tokens || 0;
    m.cacheRead += usage.cache_read_input_tokens || 0;
    m.requests += 1;
    if (model) m.byModel[model] = (m.byModel[model] || 0) + (cost || 0);
  }
  writeFileSync(usageFile, JSON.stringify(u, null, 2));
}

// Each chat's conversation is saved so it can continue after a restart.
const safeId = (id) => String(id || "").replace(/[^\w-]/g, "");
const sessionFile = (id) => join(sessionsDir, safeId(id) + ".json");
function loadSession(id) {
  try { return JSON.parse(readFileSync(sessionFile(id), "utf8")); } catch { return null; }
}
function saveSession(id, s) { writeFileSync(sessionFile(id), JSON.stringify(s)); }

const app = express();
// ---------- Security
// The app's controls (/api) only answer the app itself:
//  - the Host must be this machine on this port (blocks DNS-rebinding sites);
//  - a request from a browser page must come from the app's own address;
//  - anything that changes something needs a secret token created at each launch.
// Previews and artifacts are served from a SEPARATE port (contentApp below), so a page shown in the
// preview can never call these controls, even if it contains hostile scripts.
const TOKEN = crypto.randomBytes(24).toString("hex");
const APP_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const CONTENT_PORT = PORT + 10;
app.use((req, res, next) => {
  if (!APP_HOSTS.has(String(req.headers.host || "").toLowerCase())) return res.status(403).send("Forbidden");
  if (req.path.startsWith("/api/")) {
    const origin = req.headers.origin;
    if (origin && !APP_HOSTS.has(origin.replace(/^https?:\/\//, "").toLowerCase())) return res.status(403).json({ error: "Forbidden" });
    if (req.method !== "GET" && req.headers["x-fabra-token"] !== TOKEN) return res.status(403).json({ error: "Forbidden" });
  }
  next();
});
app.use(express.json({ limit: "25mb" }));
// Attach any file to a chat: it is saved under the app's data folder and the agent is told the path.
app.post("/api/attach", express.raw({ type: () => true, limit: "100mb" }), (req, res) => {
  const chatId = safeId(req.query.chatId);
  if (!chatId) return res.status(400).json({ error: "no chat" });
  let name = "file"; try { name = decodeURIComponent(String(req.headers["x-file-name"] || "file")); } catch {}
  name = basename(name.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120) || "file";
  const dir = join(dataDir, "attachments", chatId); mkdirSync(dir, { recursive: true });
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "", stem = ext ? name.slice(0, -ext.length) : name;
  let p = join(dir, name), n = 1; while (existsSync(p)) p = join(dir, `${stem} (${n++})${ext}`);
  writeFileSync(p, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  res.json({ path: p, name: basename(p) });
});
app.use(express.static(join(here, "public")));
// The page gets the token from here; other sites can't read it (no CORS, Origin and Host checked).
app.get("/api/token", (_req, res) => res.json({ token: TOKEN, contentPort: CONTENT_PORT }));

// ---------- Content server: local files, artifacts and Office previews, on their own port.
// It has no controls at all. HTML pages get a tiny helper so the app can switch on editing and
// read back the edited page by messaging (postMessage), which works safely across the two ports.
const contentApp = express();
const CONTENT_HOSTS = new Set([`localhost:${CONTENT_PORT}`, `127.0.0.1:${CONTENT_PORT}`]);
contentApp.use((req, res, next) => (CONTENT_HOSTS.has(String(req.headers.host || "").toLowerCase()) ? next() : res.status(403).send("Forbidden")));
const EDIT_HELPER = `(() => {
  const app = [${[...APP_HOSTS].map((h) => JSON.stringify("http://" + h)).join(",")}];
  if (window.parent === window) return;
  let pickOn = false, pickBox = null;
  const pickSel = (el) => { const parts = []; while (el && el.nodeType === 1 && parts.length < 4) { if (el.id) { parts.unshift("#" + el.id); break; } let s = el.tagName.toLowerCase(); const cl = [...el.classList].slice(0, 2); if (cl.length) s += "." + cl.join("."); const sib = el.parentElement ? [...el.parentElement.children].filter((x) => x.tagName === el.tagName) : []; if (sib.length > 1) s += ":nth-of-type(" + (sib.indexOf(el) + 1) + ")"; parts.unshift(s); el = el.parentElement; } return parts.join(" > "); };
  const pickMove = (e) => { const r = e.target.getBoundingClientRect(); Object.assign(pickBox.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", display: "block" }); };
  const pickStop = () => { pickOn = false; if (pickBox) pickBox.remove(); pickBox = null; removeEventListener("mousemove", pickMove, true); removeEventListener("click", pickClick, true); removeEventListener("keydown", pickKey, true); };
  const pickReply = (msg) => { pickStop(); for (const o of app) parent.postMessage(msg, o); };
  function pickClick(e) { e.preventDefault(); e.stopPropagation(); pickReply({ fabra: "picked", selector: pickSel(e.target), html: e.target.outerHTML.slice(0, 1500) }); }
  function pickKey(e) { if (e.key === "Escape") { e.preventDefault(); pickReply({ fabra: "picked", cancelled: true }); } }
  const pickStart = () => { if (pickOn) return; pickOn = true; pickBox = document.createElement("div"); pickBox.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,.12);border-radius:3px;display:none"; document.documentElement.appendChild(pickBox); addEventListener("mousemove", pickMove, true); addEventListener("click", pickClick, true); addEventListener("keydown", pickKey, true); };
  addEventListener("message", (e) => { if (!app.includes(e.origin) || !e.data || e.data.fabra !== "pick") return; if (e.data.on) pickStart(); else pickStop(); });
  const logTo = (level, args) => { try { const text = args.map((a) => { try { return typeof a === "string" ? a : a instanceof Error ? (a.stack || a.message) : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 2000); for (const o of app) parent.postMessage({ fabra: "log", level, text }, o); } catch {} };
  for (const lv of ["error", "warn", "log", "info"]) { const o = console[lv]; console[lv] = function (...a) { logTo(lv, a); return o.apply(this, a); }; }
  addEventListener("error", (e) => { if (e.message) logTo("error", [e.message + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "")]); });
  addEventListener("unhandledrejection", (e) => logTo("error", ["Unhandled promise rejection: " + ((e.reason && e.reason.message) || e.reason)]));
  addEventListener("message", (e) => {
    if (!app.includes(e.origin) || !e.data || !e.data.fabra) return;
    const d = e.data;
    if (d.fabra === "edit") {
      document.designMode = d.on ? "on" : "off";
      if (d.on) document.addEventListener("input", () => parent.postMessage({ fabra: "dirty" }, e.origin), { once: true });
    }
    if (d.fabra === "cmd") {
      window.focus();
      try { document.execCommand("styleWithCSS", false, true); document.execCommand(d.cmd, false, d.value == null ? null : d.value); } catch (x) {}
      parent.postMessage({ fabra: "dirty" }, e.origin);
    }
    if (d.fabra === "html") {
      const was = document.designMode; document.designMode = "off";
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script[data-fabra-helper]").forEach((s) => s.remove());
      clone.querySelectorAll("[data-fabra-ui],[data-fabra-deck]").forEach((s) => s.remove());
      clone.querySelectorAll("[class]").forEach((x) => { const k = x.getAttribute("class").split(" ").filter((c) => c && c.indexOf("fd-") !== 0).join(" "); if (k) x.setAttribute("class", k); else x.removeAttribute("class"); });
      document.designMode = was;
      parent.postMessage({ fabra: "html", id: d.id, html: "<!doctype html>\\n" + clone.outerHTML }, e.origin);
    }
  });
})();`;
contentApp.get("/__fabra_helper.js", (_req, res) => res.type("js").send(EDIT_HELPER));
// A page that can't be shown inside the panel opens in the user's own browser (web addresses only).
const openExternal = (u) => { if (/^https?:\/\//i.test(u)) spawn("explorer.exe", [u], { detached: true, stdio: "ignore" }).unref(); };
// The AI's hidden browser stays open between replies of a chat (its tabs survive), and closes after 10 idle minutes.
const keptBrowsers = new Map(); // chatId -> { b, timer }
function takeBrowser(chatId) {
  const k = keptBrowsers.get(chatId);
  if (!k) return null;
  clearTimeout(k.timer);
  return k.b;
}
function keepBrowser(chatId, b) {
  const old = keptBrowsers.get(chatId);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => { keptBrowsers.delete(chatId); b.close(); }, 10 * 60 * 1000);
  timer.unref?.();
  keptBrowsers.set(chatId, { b, timer });
}
const withHelper = (html) => {
  const tag = `<script data-fabra-helper src="/__fabra_helper.js"></script>`;
  // First thing in the page, so the preview console also catches errors from scripts that run while it loads.
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + tag);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html); // keep the doctype first, or the page renders in quirks mode
  return doctype ? doctype[0] + tag + html.slice(doctype[0].length) : tag + html;
};
const contentBase = `http://127.0.0.1:${CONTENT_PORT}`;

const running = new Map(); // chatId -> AbortController
const inbox = new Map(); // chatId -> messages the user sent while the chat was working

// Voice input: tidy the raw speech-to-text before it's sent (like the Claude app does):
// drop ums and repeats, fix punctuation and obvious mishearings, keep the meaning and wording.
app.post("/api/clean-voice", async (req, res) => {
  const text = String(req.body.text || "").slice(0, 8000);
  if (!apiKey || !text.trim()) return res.json({ text });
  try {
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const m = await client.messages.create({
      model: "claude-haiku-5-5", max_tokens: 4000, output_config: { effort: "low" },
      system: "You clean up dictated text from speech recognition before it is sent to a coding assistant. Remove filler words (um, uh, like, you know), false starts and accidental repeats; add punctuation, capitals and paragraph breaks; fix words that were clearly misheard from context (e.g. 'cloud app' -> 'Claude app', 'scene option' -> 'seen option'). Keep the speaker's own words, meaning, tone and every request; do not answer it, summarise, add anything or make it formal. Reply with only the cleaned text.",
      messages: [{ role: "user", content: text }],
    }, { timeout: 15000 });
    const c = costOf("claude-haiku-5-5", m.usage); addUsage(c, m.usage, "claude-haiku-5-5");
    const out = m.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    res.json({ text: out || text });
  } catch { res.json({ text }); }
});

// A short chat title written from the first message (like Claude Code does for new sessions).
app.post("/api/title", async (req, res) => {
  const text = String(req.body.text || "").slice(0, 1500);
  const folder = String(req.body.folder || "").slice(0, 80);
  if (!apiKey || !text.trim()) return res.json({ text: "" });
  try {
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const m = await client.messages.create({
      model: "claude-haiku-5-5", max_tokens: 40, output_config: { effort: "low" },
      system: "You name chats. Given the first message a user sent to a coding assistant, write a short title that says what the chat is about: 2 to 6 plain words, sentence case, no quotes, no full stop, no emoji. Describe the task (e.g. 'Fix login button on mobile', 'Company profile layout'), do not answer it. Reply with only the title.",
      messages: [{ role: "user", content: (folder ? `Project folder: ${folder}\n\n` : "") + text }],
    }, { timeout: 12000 });
    const c = costOf("claude-haiku-5-5", m.usage); addUsage(c, m.usage, "claude-haiku-5-5");
    let out = m.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim().split("\n")[0];
    out = out.replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, "").slice(0, 60);
    res.json({ text: out });
  } catch { res.json({ text: "" }); }
});

// Next-step suggestion: guess what the user will most likely say next, shown as a grey chip they can accept.
app.post("/api/suggest", async (req, res) => {
  const ask = String(req.body.ask || "").slice(0, 1500);
  const reply = String(req.body.reply || "").slice(-2500);
  if (!apiKey || !reply.trim()) return res.json({ text: "" });
  try {
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const m = await client.messages.create({
      model: "claude-haiku-5-5", max_tokens: 60, output_config: { effort: "low" },
      system: "You predict what a user will type next in a chat with a coding assistant. You are given the user's last message and the assistant's reply. Write the single most likely next message the USER would send, in the user's voice: short, plain, under 12 words (e.g. 'Run the tests', 'Yes, go ahead', 'Make the heading bigger'). If the assistant asked a question or offered options, answer with the most likely choice. If there is no obvious next step, or the reply was just a greeting or a finished answer with nothing to follow up, reply exactly NONE. Never write the assistant's side, never explain, no quotes.",
      messages: [{ role: "user", content: `User's last message:\n${ask}\n\nAssistant's reply:\n${reply}` }],
    }, { timeout: 15000 });
    const c = costOf("claude-haiku-5-5", m.usage); addUsage(c, m.usage, "claude-haiku-5-5");
    let out = m.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim().split("\n")[0];
    out = out.replace(/^["'“”‘’`\s]+|["'“”‘’`\s]+$/g, "");
    if (!out || /^none\b/i.test(out) || out.length > 110) out = "";
    res.json({ text: out });
  } catch { res.json({ text: "" }); }
});

app.post("/api/interject", (req, res) => {
  const { chatId, text } = req.body;
  if (!running.has(chatId)) return res.status(409).json({ error: "not running" });
  if (!inbox.has(chatId)) inbox.set(chatId, []);
  inbox.get(chatId).push(String(text || ""));
  res.json({ ok: true });
});
const approvals = new Map(); // permission request id -> resolver
const allowAlways = new Map(); // chatId -> tools the user allowed for the rest of the chat

app.post("/api/permission", (req, res) => {
  const resolver = approvals.get(req.body.reqId);
  if (resolver) resolver(["allow", "always", "deny"].includes(req.body.answer) ? req.body.answer : "deny");
  res.json({ ok: Boolean(resolver) });
});
// The user's answer to an ask_user question.
app.post("/api/answer", (req, res) => {
  const resolver = approvals.get(req.body.reqId);
  if (resolver) resolver(String(req.body.answer || "").slice(0, 4000) || "(no answer)");
  res.json({ ok: Boolean(resolver) });
});

// ---------- Terminal panel: commands the user types themselves, streamed live.
const userTerms = new Map(); // id -> child process
app.post("/api/term", (req, res) => {
  const cwd = String(req.body.cwd || "");
  const command = String(req.body.command || "");
  if (!command.trim()) return res.status(400).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const id = crypto.randomUUID();
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: existsSync(cwd) ? cwd : homedir(), windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" },
  });
  userTerms.set(id, child);
  const out = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  out({ type: "start", id });
  child.stdout.on("data", (d) => out({ type: "out", text: d.toString() }));
  child.stderr.on("data", (d) => out({ type: "out", text: d.toString() }));
  child.on("close", (code) => { userTerms.delete(id); out({ type: "exit", code }); res.end(); });
  child.on("error", (e) => { out({ type: "out", text: e.message }); res.end(); });
});
app.post("/api/term/stop", (req, res) => {
  const c = userTerms.get(req.body.id);
  if (c) spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
  res.json({ ok: Boolean(c) });
});
// The real terminal panel (pty.mjs + xterm.js in the page): one live PowerShell per chat that keeps its folder,
// answers prompts and draws full-screen programs. The page falls back to the one-command panel above without it.
app.post("/api/uterm/open", (req, res) => {
  if (!ptyReady()) return res.status(501).json({ error: "no pty" });
  const cwd = String(req.body.cwd || "");
  try {
    const id = userTermOpen({ key: String(req.body.key || "default").slice(0, 100), cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      env: { ...process.env, FORCE_COLOR: "1" }, cols: Number(req.body.cols) || 100, rows: Number(req.body.rows) || 24 });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/api/uterm/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const off = userTermSubscribe(String(req.query.id || ""), (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  if (!off) { res.write(`data: ${JSON.stringify({ type: "gone" })}\n\n`); return res.end(); }
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { off(); clearInterval(ping); });
});
app.post("/api/uterm/input", (req, res) => res.json({ ok: userTermInput(String(req.body.id || ""), String(req.body.data ?? "").slice(0, 100000)) }));
app.post("/api/uterm/resize", (req, res) => res.json({ ok: userTermResize(String(req.body.id || ""), Number(req.body.cols), Number(req.body.rows)) }));
app.post("/api/uterm/close", (req, res) => res.json({ ok: userTermClose(String(req.body.id || "")) }));
app.use("/vendor/xterm", express.static(join(here, "node_modules", "@xterm", "xterm")));
app.use("/vendor/xterm-fit", express.static(join(here, "node_modules", "@xterm", "addon-fit")));

app.get("/api/status", (_req, res) => {
  res.json({ hasKey: Boolean(apiKey), key: maskKey(apiKey), home: homedir() });
});

// Save or remove the API key. Checks it with Anthropic first (listing models is free).
app.post("/api/key", async (req, res) => {
  const key = String(req.body.key || "").trim();
  if (!key) {
    const cfg = loadConfig(); delete cfg.apiKey;
    await saveConfig(cfg);
    apiKey = process.env.ANTHROPIC_API_KEY || "";
    return res.json({ ok: true, key: maskKey(apiKey) });
  }
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) return res.status(400).json({ error: "That doesn't look like a Claude API key. It should start with sk-ant-." });
  try {
    await new Anthropic({ apiKey: key, maxRetries: 0 }).models.list({ limit: 1 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      return res.status(400).json({ error: "Anthropic rejected this key. Create a new one and try again." });
    if (e instanceof Anthropic.APIConnectionError)
      return res.status(400).json({ error: "Couldn't reach Anthropic to check the key. Are you online?" });
  }
  const cfg = loadConfig(); cfg.apiKey = key;
  await saveConfig(cfg);
  apiKey = key;
  res.json({ ok: true, key: maskKey(apiKey) });
});

// Other providers' keys (Gemini, OpenRouter, Groq). Saving one checks it and stores the live model list.
const providerKey = (p) => loadConfig().providers?.[p]?.key || "";
// Research: how deep to search (Claude's web tools use this), and an optional Brave Search key for search_web.
initSecrets(join(dataDir, "secrets.json"));
app.get("/api/secrets", async (_req, res) => { await secretsReady(); res.json(listSecrets()); });
app.post("/api/secrets", async (req, res) => {
  if (req.body.fromGh) { // the GitHub connector preset: reuse this PC's GitHub sign-in
    const tok = await new Promise((done) => execFile(process.env.FABRA_GH || "gh", ["auth", "token"], { windowsHide: true, timeout: 15000 }, (e, out) => done(e ? "" : String(out).trim())));
    if (!tok) return res.status(400).json({ error: "GitHub isn't signed in on this PC." });
    try { await setSecret("GITHUB_TOKEN", tok); return res.json({ ok: true, name: "GITHUB_TOKEN" }); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  try { const name = await setSecret(req.body.name, req.body.value); res.json({ ok: true, name }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// GitHub & command line (Settings).
app.get("/api/cli", async (_req, res) => res.json(await cliStatus()));
app.get("/api/gh/login", (_req, res) => res.json(loginState()));
app.post("/api/gh/login", async (req, res) => {
  if (req.body.cancel) return res.json(cancelWebLogin());
  if (req.body.token) { try { await tokenLogin(req.body.token); return res.json({ state: "done", message: "Signed in." }); } catch (e) { return res.status(400).json({ error: e.message }); } }
  res.json(startWebLogin());
});
app.post("/api/gh/logout", async (_req, res) => { try { await ghLogout(); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post("/api/git/identity", async (req, res) => { try { await setIdentity(req.body.name, req.body.email); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
// search_web's main source: Anthropic's web search run by Haiku (basic tool version: Haiku supports
// it and it's quicker). Returns [{ title, url, snippet }]; the cost goes into the usage meter.
async function claudeSearch(query, signal) {
  if (!apiKey) return [];
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const m = await client.messages.create({
    model: "claude-haiku-5-5", max_tokens: 300,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    messages: [{ role: "user", content: `Search the web for: ${String(query).slice(0, 400)}\nReply only "ok".` }],
  }, { signal });
  const c = costOf("claude-haiku-5-5", m.usage); addUsage(c, m.usage, "claude-haiku-5-5");
  return m.content.filter((b) => b.type === "web_search_tool_result" && Array.isArray(b.content)).flatMap((b) => b.content)
    .filter((r) => r.type === "web_search_result" && r.url).map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.page_age ? `Updated ${r.page_age}` : "" }));
}
const researchCfg = () => loadConfig().research || {};
const researchDepth = () => (DEPTHS[researchCfg().depth] ? researchCfg().depth : "normal");
app.get("/api/research", (_req, res) => res.json({
  depth: researchDepth(),
  depths: Object.fromEntries(Object.entries(DEPTHS).map(([k, v]) => [k, { label: v.label, note: v.note, uses: v.uses }])),
  brave: researchCfg().braveKey ? "…" + researchCfg().braveKey.slice(-4) : null,
}));
app.post("/api/research", async (req, res) => {
  const cfg = loadConfig(); cfg.research ||= {};
  if (req.body.depth !== undefined) {
    if (!DEPTHS[req.body.depth]) return res.status(400).json({ error: "Unknown depth." });
    cfg.research.depth = req.body.depth;
  }
  if (req.body.braveKey !== undefined) {
    const k = String(req.body.braveKey || "").trim();
    if (k && !/^[\w.\-]{16,200}$/.test(k)) return res.status(400).json({ error: "That doesn't look like a Brave Search key." });
    if (k) cfg.research.braveKey = k; else delete cfg.research.braveKey;
  }
  await saveConfig(cfg);
  res.json({ ok: true });
});
const geminiLimits = makeGeminiLimits(join(dataDir, "gemini-limits.json"), { readFileSync, writeFileSync });
// The order Gemini falls back in: the chosen model first, then the user's other ticked models, best first.
function geminiChain(start) {
  const fav = loadConfig().providers?.gemini?.favorites || [];
  return [start, ...fav.filter((m) => m !== start).sort((a, b) => geminiRank(b) - geminiRank(a))];
}
// Suggested models when a Gemini key is first added: the Flash models (best free quality) then Flash-Lite (bigger free allowance).
const geminiDefaults = (models) => [...models.filter((m) => /flash/.test(m) && !/lite|latest|preview/.test(m)).sort((a, b) => geminiRank(b) - geminiRank(a)).slice(0, 5),
  ...models.filter((m) => /flash-lite/.test(m) && !/latest|preview/.test(m)).sort((a, b) => geminiRank(b) - geminiRank(a)).slice(0, 2)];
app.get("/api/providers", (_req, res) => {
  const cfg = loadConfig().providers || {};
  res.json(Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, keyUrl: p.keyUrl, note: p.note,
    key: cfg[id]?.key ? "…" + cfg[id].key.slice(-4) : null, models: cfg[id]?.models || [], favorites: cfg[id]?.favorites || [],
    ...(id === "gemini" ? { today: Object.fromEntries((cfg[id]?.models || []).map((m) => [m, { used: geminiLimits.usedToday(m), out: geminiLimits.isOut(m), why: geminiLimits.isOut(m) ? geminiLimits.whyOut(m) : "", limit: freeLimits(m).rpd }])), resetAt: geminiLimits.resetAt() } : {}) })));
});
app.post("/api/providers", async (req, res) => {
  const id = String(req.body.provider || ""); if (!PROVIDERS[id]) return res.status(400).json({ error: "Unknown provider." });
  const cfg = loadConfig(); cfg.providers ||= {};
  if (req.body.favorites) { // which of its models show in the model menu
    if (!cfg.providers[id]) return res.status(400).json({ error: "Add the key first." });
    cfg.providers[id].favorites = (Array.isArray(req.body.favorites) ? req.body.favorites : []).map(String).filter((m) => cfg.providers[id].models.includes(m)).slice(0, 12);
    await saveConfig(cfg); return res.json({ ok: true });
  }
  const key = String(req.body.key || "").trim();
  if (!key) { delete cfg.providers[id]; await saveConfig(cfg); return res.json({ ok: true }); }
  if (!/^[\w.\-:]{16,300}$/.test(key)) return res.status(400).json({ error: "That doesn't look like an API key." });
  let models;
  try { models = await listModels(id, key); } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
  if (!models.length) return res.status(400).json({ error: "The key works, but no chat models were listed for it." });
  const old = cfg.providers[id]?.favorites || [];
  const keep = old.filter((m) => models.includes(m));
  cfg.providers[id] = { key, models, favorites: keep.length ? keep : id === "gemini" ? geminiDefaults(models) : [] };
  await saveConfig(cfg);
  res.json({ ok: true, models });
});

app.get("/api/usage", (_req, res) => {
  const u = loadUsage();
  if (rollCycle(u)) writeFileSync(usageFile, JSON.stringify(u, null, 2));
  const b = cycleBounds(u.resetDay);
  res.json({ budget: u.budget, month: monthKey(), current: u.cycle, cycleStart: dayKey(b.start), cycleEnd: dayKey(b.end), resetDay: u.resetDay, months: u.months });
});

// The credits came back: a fresh period from now, resetting on `day` of the month (today's day when none is given).
app.post("/api/usage/reset", (req, res) => {
  const u = loadUsage();
  rollCycle(u);
  const d = Math.floor(Number(req.body?.day));
  u.resetDay = d >= 1 && d <= 31 ? d : new Date().getDate();
  if (u.cycle && u.cycle.requests) (u.cycles ||= {})[`${u.cycle.start}~${dayKey()}`] = u.cycle;
  u.cycle = emptyCycle(dayKey(cycleBounds(u.resetDay).start));
  writeFileSync(usageFile, JSON.stringify(u, null, 2));
  const b = cycleBounds(u.resetDay);
  res.json({ ok: true, resetDay: u.resetDay, cycleStart: dayKey(b.start), cycleEnd: dayKey(b.end) });
});

app.post("/api/budget", (req, res) => {
  const u = loadUsage();
  u.budget = Math.max(1, Number(req.body.budget) || 100);
  writeFileSync(usageFile, JSON.stringify(u, null, 2));
  res.json({ ok: true, budget: u.budget });
});

// Simple folder browser for picking a project.
app.get("/api/folders", (req, res) => {
  const dir = resolve(req.query.path || join(homedir(), "Documents"));
  try {
    const folders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    res.json({ path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, folders });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Fork: a copy of a chat's saved conversation under a new chat id, so both can carry on separately.
app.post("/api/fork", (req, res) => {
  const from = safeId(req.body.from), to = safeId(req.body.to);
  if (!from || !to) return res.status(400).json({ error: "Missing chat." });
  const s = loadSession(from); if (s) saveSession(to, s);
  res.json({ ok: true, hasSession: !!s });
});

// Keep the computer awake (no sleep) while the app is open, until switched off. A small hidden
// PowerShell holds a Windows "system required" request; stopping it lets the PC sleep normally again.
let awake = null;
app.get("/api/awake", (_req, res) => res.json({ on: !!awake }));
app.post("/api/awake", (req, res) => {
  if (req.body.on && !awake) {
    const ps = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; while ($true) { Start-Sleep 60 }`;
    awake = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true, stdio: "ignore" });
    awake.on("exit", () => { awake = null; });
  } else if (!req.body.on && awake) { try { awake.kill(); } catch {} awake = null; }
  res.json({ on: !!awake });
});

// The normal Windows "Select folder" window (Explorer style, see pick-folder.ps1),
// so a folder anywhere on the PC can be chosen.
let pickingFolder = false;
app.post("/api/pick-folder", (req, res) => {
  if (pickingFolder) return res.status(409).json({ error: "A folder window is already open." });
  const start = String(req.body?.start || "");
  pickingFolder = true;
  execFile("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", join(here, "pick-folder.ps1")],
    { env: { ...process.env, FABRA_PICK_START: start }, timeout: 10 * 60 * 1000, windowsHide: true, encoding: "utf8" },
    (err, stdout) => {
      pickingFolder = false;
      if (err && !stdout) return res.status(500).json({ error: "Couldn't open the folder window." });
      const path = String(stdout || "").trim();
      res.json(path ? { path } : { cancelled: true });
    });
});

// ---------- Git panel (see git.mjs). Reading is GET; making or removing a copy needs the token like any change.
const gitCwd = (req) => String(req.query.cwd || "");
app.get("/api/git", async (req, res) => res.json(await gitInfo(gitCwd(req), { light: req.query.light === "1" })));
app.get("/api/git/pr", async (req, res) => res.json(await prStatus(gitCwd(req))));
app.get("/api/git/diff", async (req, res) => res.json(await fileDiff(gitCwd(req), String(req.query.path || ""))));
app.post("/api/git/worktree", async (req, res) => {
  const r = await addWorktree(String(req.body.cwd || ""), req.body.name);
  res.status(r.error ? 400 : 200).json(r);
});
app.post("/api/git/worktree/remove", async (req, res) => {
  const r = await removeWorktree(String(req.body.cwd || ""), String(req.body.path || ""), req.body.force === true);
  res.status(r.error ? 400 : 200).json(r);
});

// Open a localhost link, a file, or a project folder in Explorer, VS Code or a terminal.
app.post("/api/open", (req, res) => {
  const target = String(req.body.target || "").replace(/"/g, "");
  const how = req.body.how || "default";
  const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(target);
  if (!isLocalUrl && !existsSync(target)) return res.status(400).json({ error: "Not found." });
  if (how === "explorer") spawn("explorer.exe", [target], { detached: true });
  else if (how === "code") exec(`code "${target}"`);
  else if (how === "terminal") exec(`start "" /D "${target}" powershell -NoExit`);
  else exec(`start "" "${target}"`);
  res.json({ ok: true });
});

// Serve local mockup files (HTML, images, CSS, JS) so the preview panel can show
// them; relative links inside a mockup keep working because the path is in the URL.
const WEB_FILES = /\.(html?|css|js|mjs|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|webm|pdf)$/i;
contentApp.get(/^\/fs\/(.+)$/, (req, res) => {
  const p = resolve(String(req.params[0]).replace(/\//g, "\\"));
  if (!WEB_FILES.test(p) || !existsSync(p) || !statSync(p).isFile()) return res.status(404).send("Not found");
  if (/\.html?$/i.test(p)) return res.type("html").send(withHelper(readFileSync(p, "utf8")));
  res.sendFile(p, { dotfiles: "allow" }); // chat workspaces live under .fabra-labs-ai
});

app.post("/api/stop", (req, res) => {
  running.get(req.body.chatId)?.abort();
  res.json({ ok: true });
});

// ---------- Connectors (MCP)
// Remote connectors that need a sign-in send the browser back here (mcpauth.mjs).
const mcpAuth = makeMcpAuth(dataDir, `http://localhost:${PORT}/api/mcp/oauth/callback`);
const connectors = makeConnectors(dataDir, { secret: secretValue, auth: mcpAuth });
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const openInBrowser = (url) => spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, windowsHide: true }).unref();
const connectorCfg = (name, cwd) => connectors.configsFor(cwd || "")[name] || connectors.load().mcpServers?.[name];
const mask = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v).length > 6 ? String(v).slice(0, 3) + "…" + String(v).slice(-2) : "…"]));
app.get("/api/connectors", async (req, res) => {
  await mcpAuth.ready(); // so "signed in" is right straight after the app starts
  const cwd = req.query.cwd ? String(req.query.cwd) : "";
  const own = connectors.load().mcpServers || {};
  const all = connectors.configsFor(cwd);
  // Secrets in env and headers are never sent back in full.
  const list = Object.entries({ ...Object.fromEntries(Object.entries(own).map(([n, c]) => [n, { ...c, source: "app" }])), ...all })
    .map(([name, c]) => ({ name, source: c.source, disabled: !!c.disabled, kind: c.url ? "remote" : "local", url: c.url, command: c.command, args: c.args, env: mask(c.env), headers: mask(c.headers), headersHelper: c.headersHelper,
      signedIn: c.url ? mcpAuth.signedIn(connectors.urlOf(c)) : false, usesSignIn: c.url ? mcpAuth.usesSignIn(connectors.urlOf(c)) : false }));
  res.json(list);
});
app.post("/api/connectors", (req, res) => {
  const { name, config, remove, disabled } = req.body;
  const n = String(name || "").trim();
  if (!/^[\w-]{1,40}$/.test(n)) return res.status(400).json({ error: "Use a short name with letters, numbers, - or _." });
  const all = connectors.load(); all.mcpServers ||= {};
  if (remove) delete all.mcpServers[n];
  else if (typeof disabled === "boolean" && all.mcpServers[n]) all.mcpServers[n].disabled = disabled;
  else {
    const c = config || {};
    if (!c.url && !c.command) return res.status(400).json({ error: "Give either a command (local connector) or a URL (remote connector)." });
    // Keep existing secrets if the form left them masked/blank.
    const prev = all.mcpServers[n] || {};
    all.mcpServers[n] = c.url
      ? { type: "http", url: c.url, headers: { ...(prev.headers || {}), ...(c.headers || {}) } }
      : { command: c.command, args: c.args || [], env: { ...(prev.env || {}), ...(c.env || {}) } };
  }
  connectors.save(all); res.json({ ok: true });
});
app.post("/api/connectors/test", async (req, res) => {
  const cfg = connectorCfg(req.body.name, req.body.cwd);
  if (!cfg) return res.status(404).json({ error: "Not found" });
  res.json(await connectors.test(req.body.name, cfg));
});
// Sign in to a remote connector: the service's page opens in the browser; the user presses Allow and
// lands on the callback below. Already signed in (or no sign-in needed): just says so.
app.post("/api/connectors/signin", async (req, res) => {
  const cfg = connectorCfg(req.body.name, req.body.cwd);
  if (!cfg?.url) return res.status(404).json({ error: "Only remote connectors (with an address) can sign in." });
  await mcpAuth.ready();
  const url = connectors.urlOf(cfg);
  connectors.forget(url);
  const r = await connectors.test(req.body.name, cfg);
  if (r.ok) return res.json({ ok: true, tools: r.tools.length });
  const page = mcpAuth.waitingUrl(url);
  if (!page || !/^https:\/\//i.test(page)) return res.status(400).json({ error: r.error || "This connector didn't offer a sign-in." });
  openInBrowser(page);
  res.json({ ok: false, waiting: true });
});
app.post("/api/connectors/signout", async (req, res) => {
  const cfg = connectorCfg(req.body.name, req.body.cwd);
  if (!cfg?.url) return res.status(404).json({ error: "Not found" });
  const url = connectors.urlOf(cfg);
  await mcpAuth.signOut(url); connectors.forget(url);
  res.json({ ok: true });
});
// A browser extension's Chrome Web Store page (a connector that works through one), opened in Chrome itself when it's
// installed, since that's where the extension must go; otherwise in the default browser. Store pages only.
app.post("/api/open-store", (req, res) => {
  const url = String(req.body.url || "");
  if (!/^https:\/\/chromewebstore\.google\.com\/detail\/[\w-]+\/[a-p]{32}$/.test(url)) return res.status(400).json({ error: "Not a Chrome Web Store page." });
  const chrome = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean).map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe")).find((p) => existsSync(p));
  if (chrome) spawn(chrome, [url], { detached: true, windowsHide: false }).unref(); else openInBrowser(url);
  res.json({ ok: true, chrome: !!chrome });
});
// The browser comes back here from the service's sign-in page (a plain page, opened outside the app).
app.get("/api/mcp/oauth/callback", async (req, res) => {
  const page = (title, text) => res.type("html").send(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 20px;color:#1d1d1b"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></body>`);
  if (req.query.error) return page("Sign-in not finished", `The service said: ${String(req.query.error_description || req.query.error).slice(0, 300)}. You can close this tab and try again.`);
  try {
    const url = await mcpAuth.finish(req.query.state, req.query.code);
    connectors.forget(url);
    page("Signed in", "Shivo Labs AI can use this connector now. You can close this tab and go back to the app.");
  } catch (e) { page("Sign-in not finished", String(e.message || e).slice(0, 400)); }
});

// ---------- Local web servers running on this PC (for the preview's quick switcher).
// Lists listening ports, skips Windows' own services and this app, then asks each one for a
// page title so the list reads like "cos-system · localhost:3000".
const SYSTEM_PROCS = new Set(["system", "svchost", "lsass", "wininit", "services", "spoolsv", "msedge", "chrome", "searchhost", "searchindexer", "mdnsresponder", "onedrive", "dropbox", "steam", "discord", "teams", "ms-teams", "slack", "zoom", "nvcontainer", "nvidia web helper", "jhi_service", "lghub", "adobe desktop service", "claude", "code", "msmpeng", "wslservice", "wslhost", "vmmem", "com.docker.backend", "explorer", "taskhostw", "sihost", "msedgewebview2", "pcloud", "googledrivefs", "icloud", "spotify", "whatsapp", "telegram", "lghub_agent"]);
let portsCache = { at: 0, list: [] };
app.get("/api/ports", async (_req, res) => {
  if (Date.now() - portsCache.at < 4000) return res.json(portsCache.list);
  const ps = `Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') -and $_.LocalPort -ge 1024 } | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "$($_.LocalPort)|$($p.ProcessName)|$($_.OwningProcess)" } | Sort-Object -Unique`;
  // execFile, not exec: no cmd.exe in between to break the command apart at its | characters.
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 15000 }, async (err, out) => {
    const seen = new Set();
    const candidates = String(out || "").split(/\r?\n/).map((l) => l.trim().split("|"))
      // Skip this app (including its preview relays) and Windows/desktop programs.
      .filter(([p, n, pid]) => p && Number(pid) !== process.pid && !SYSTEM_PROCS.has(String(n || "").toLowerCase()))
      .filter(([p]) => !seen.has(p) && seen.add(p)).slice(0, 40);
    // Ask each one for its page title. A slow server (e.g. still compiling) is kept;
    // a port that doesn't speak HTTP at all (a database, say) is dropped.
    let list = (await Promise.all(candidates.map(async ([port, proc]) => {
      try {
        // Vite and newer Node servers often listen on ::1 only, so ask on whichever address answers.
        const host = (await probePort(port)) === "::1" ? "[::1]" : "127.0.0.1";
        const r = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000), redirect: "follow" });
        const type = r.headers.get("content-type") || "";
        let title = "";
        if (type.includes("html")) title = (/<title[^>]*>([^<]{0,120})<\/title>/i.exec((await r.text()).slice(0, 20000))?.[1] || "").trim();
        else r.body?.cancel();
        return { port: Number(port), process: proc, title, status: r.status };
      } catch (e) {
        return e?.name === "TimeoutError" || e?.name === "AbortError" ? { port: Number(port), process: proc, title: "", slow: true } : null;
      }
    }))).filter(Boolean);
    // Another running copy of this app (e.g. the main one while testing a dev copy) and its
    // preview relays: drop every port belonging to a process that serves "Shivo Labs AI" (or "Fabra Labs AI", before the rename).
    const pidOf = new Map(candidates.map(([p, , pid]) => [Number(p), pid]));
    const appPids = new Set(list.filter((s) => s.title === "Shivo Labs AI" || s.title === "Fabra Labs AI").map((s) => pidOf.get(s.port)));
    list = list.filter((s) => !appPids.has(pidOf.get(s.port))).sort((a, b) => a.port - b.port);
    // One entry per program: frameworks like Next.js open extra internal ports; keep the main (lowest) one.
    const shownPids = new Set();
    list = list.filter((s) => { const pid = pidOf.get(s.port); if (shownPids.has(pid)) return false; shownPids.add(pid); return true; });
    portsCache = { at: Date.now(), list };
    res.json(list);
  });
});

// ---------- Preview relay for local dev servers that refuse to be embedded.
app.get("/api/relay", async (req, res) => {
  try { res.json({ port: await relayFor(req.query.port) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---------- Office previews: converted to PDF once per file version, one at a time
// (Office doesn't like being driven twice at once).
const previewsDir = join(dataDir, "previews");
mkdirSync(previewsDir, { recursive: true });
let officeQueue = Promise.resolve();
function officePreview(p) {
  const key = crypto.createHash("sha1").update(p + statSync(p).mtimeMs).digest("hex").slice(0, 16);
  const out = join(previewsDir, key + ".pdf");
  if (existsSync(out)) return Promise.resolve(out);
  const job = officeQueue.then(() => (existsSync(out) ? out : officeToPdf(p, out)));
  officeQueue = job.catch(() => {});
  return job;
}
contentApp.get("/office-preview", async (req, res) => {
  const p = resolve(String(req.query.path || ""));
  if (!OFFICE.test(p) || !existsSync(p)) return res.status(404).send("File not found");
  try { res.sendFile(await officePreview(p), { dotfiles: "allow" }); }
  catch (e) { res.status(500).type("text").send(String(e.message || e)); }
});

// ---------- Artifacts
const artifacts = makeArtifacts(dataDir);
const baseUrl = `http://localhost:${PORT}`;
app.get("/api/artifacts", (_req, res) => res.json(artifacts.list().filter((m) => !m.deleted)));
app.get("/api/artifact/:id", (req, res) => {
  const m = artifacts.get(req.params.id);
  m ? res.json(m) : res.status(404).json({ error: "Not found" });
});
app.delete("/api/artifact/:id", (req, res) => res.json({ ok: artifacts.remove(req.params.id) }));
// The page itself: /artifact/<id> (latest) or /artifact/<id>/<version>
contentApp.get(["/artifact/:id", "/artifact/:id/:v"], (req, res) => {
  try {
    const { meta, content } = artifacts.read(req.params.id, req.params.v);
    res.type("html").send(withHelper(renderArtifact(meta, content)));
  } catch { res.status(404).send("Artifact not found"); }
});

// Saving edits made by hand in the preview panel: a new artifact version, or the file itself.
app.post("/api/save-edit", (req, res) => {
  const { artifactId, path, html } = req.body;
  if (typeof html !== "string" || !html.trim()) return res.status(400).json({ error: "Nothing to save." });
  try {
    if (artifactId) {
      const cur = artifacts.get(artifactId);
      const m = artifacts.update(artifactId, html, { by: "user", note: "Edited by hand", type: ["html", "slides", "sheet"].includes(cur?.type) ? cur.type : "document" });
      // Let the AI know on the next message.
      if (m.chatId) { const s = loadSession(m.chatId); if (s) { s.note = `(Note: the user edited the artifact "${m.title}" (id ${m.id}) by hand; it is now version ${m.versions.length}. Use read_artifact before changing it.)`; saveSession(m.chatId, s); } }
      return res.json({ ok: true, version: m.versions.length });
    }
    const p = resolve(String(path || ""));
    if (!/\.html?$/i.test(p) || !existsSync(p)) return res.status(400).json({ error: "Only existing HTML files can be saved." });
    writeFileSync(p, html);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Export to PDF or Word into the user's Downloads folder, then show it.
app.post("/api/export", async (req, res) => {
  const { artifactId, version, path, format } = req.body;
  if (!["pdf", "docx", "pptx", "xlsx"].includes(format)) return res.status(400).json({ error: "Format must be pdf, docx, pptx or xlsx." });
  try {
    let url, html, title, raw;
    if (artifactId) {
      const { meta, content } = artifacts.read(artifactId, version);
      title = meta.title; url = `${contentBase}/artifact/${meta.id}${version ? "/" + version : ""}`; html = renderArtifact(meta, content); raw = content;
    } else {
      const p = resolve(String(path || ""));
      if (!existsSync(p)) return res.status(400).json({ error: "File not found." });
      title = p.split(/[\\/]/).pop().replace(/\.\w+$/, "");
      url = `${contentBase}/fs/` + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
      html = readFileSync(p, "utf8");
    }
    const downloads = join(homedir(), "Downloads");
    mkdirSync(downloads, { recursive: true });
    const base = title.replace(/[<>:"/\\|?*]+/g, "").trim().slice(0, 80) || "Document";
    let out = join(downloads, `${base}.${format}`);
    for (let i = 2; existsSync(out); i++) out = join(downloads, `${base} (${i}).${format}`);
    if (format === "pdf") await exportPdf(url, out);
    else if (format === "pptx") await exportPptx(raw ?? html, out);
    else if (format === "xlsx") await exportXlsx(raw ?? html, out);
    else await exportDocx(html, out, title);
    spawn("explorer.exe", ["/select,", out], { detached: true });
    res.json({ ok: true, file: out });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Skills the app can use (its own folder is where new ones are created).
const skillsDir = join(dataDir, "skills");
mkdirSync(skillsDir, { recursive: true });
// Files for the @ list in the message box: git's list when the folder is a repository (fast, skips ignored
// files), otherwise a short walk. Cached per folder for 20 seconds; best matches first.
const fileLists = new Map(); // folder -> { at, files }
function folderFiles(dir) {
  const c = fileLists.get(dir);
  if (c && Date.now() - c.at < 20000) return Promise.resolve(c.files);
  return new Promise((done) => {
    execFile("git", ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: dir, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, (e, out) => {
      let files = !e && out.trim() ? out.split(/\r?\n/).filter(Boolean).slice(0, 50000) : null;
      if (!files) {
        files = [];
        const walk = (d, rel, depth) => {
          if (files.length >= 5000 || depth > 6) return;
          let list = []; try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const x of list) {
            if (/^(node_modules|\.git|dist|build|\.next|__pycache__|\.venv|venv)$/.test(x.name)) continue;
            const r = rel ? rel + "/" + x.name : x.name;
            if (x.isDirectory()) walk(join(d, x.name), r, depth + 1); else files.push(r);
          }
        };
        walk(dir, "", 0);
      }
      fileLists.set(dir, { at: Date.now(), files });
      done(files);
    });
  });
}
app.get("/api/files", async (req, res) => {
  const dir = String(req.query.cwd || ""), q = String(req.query.q || "").toLowerCase().replace(/\\/g, "/");
  if (!dir || !existsSync(dir)) return res.json([]);
  const files = await folderFiles(dir);
  const dirs = [...new Set(files.flatMap((f) => { const p = f.split("/"); return p.slice(0, -1).map((_, i) => p.slice(0, i + 1).join("/") + "/"); }))];
  const score = (f) => {
    const l = f.toLowerCase(), name = l.replace(/\/$/, "").split("/").pop();
    if (!q) return f.endsWith("/") ? 1 : 2 - f.split("/").length * 0.01;
    if (name.startsWith(q)) return 5 - l.length * 0.001;
    if (name.includes(q)) return 4 - l.length * 0.001;
    if (l.includes(q)) return 3 - l.length * 0.001;
    let i = 0; for (const ch of l) if (ch === q[i]) i++; // letters in order (fuzzy)
    return i === q.length ? 1 - l.length * 0.001 : 0;
  };
  res.json([...dirs, ...files].map((f) => [f, score(f)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 30).map((x) => x[0]));
});
app.get("/api/skills", (req, res) => res.json({ dir: skillsDir, skills: loadSkills(req.query.cwd ? String(req.query.cwd) : "", skillsDir) }));

// Custom slash commands and CLAUDE.md files for a folder.
app.get("/api/commands", (req, res) => res.json(loadCommands(req.query.cwd ? String(req.query.cwd) : "")));
app.get("/api/memory", (req, res) => {
  const cwd = req.query.cwd ? String(req.query.cwd) : "";
  res.json(cwd ? loadMemory(cwd).map((m) => ({ path: m.path, chars: m.text.length })) : []);
});
// Auto memory: notes the AI keeps by itself between chats, in Claude Code's memory folder for the project. On unless switched off.
const autoMemoryOn = () => loadConfig().memory?.auto !== false;
app.get("/api/automemory", (req, res) => {
  const cwd = req.query.cwd ? String(req.query.cwd) : "";
  if (!cwd) return res.json({ on: autoMemoryOn() });
  const m = loadAutoMemory(cwd), notes = listNotes(m.dir);
  res.json({ on: autoMemoryOn(), dir: m.dir, index: m.index, exists: m.exists, count: notes.length, notes });
});
app.post("/api/automemory", async (req, res) => {
  const cfg = loadConfig(); cfg.memory ||= {};
  cfg.memory.auto = !!req.body.on;
  await saveConfig(cfg);
  res.json({ ok: true, on: cfg.memory.auto });
});
// Permission rules and hooks that apply to a folder (for /permissions).
app.get("/api/rules", (req, res) => {
  const cwd = req.query.cwd ? String(req.query.cwd) : "";
  const r = loadRules(cwd, dataDir);
  res.json({ allow: r.allow, ask: r.ask, deny: r.deny, hooks: Object.fromEntries(Object.entries(r.hooks).map(([k, v]) => [k, v.reduce((n, g) => n + (g.hooks?.length || 0), 0)])), files: r.files, errors: r.errors, candidates: settingsFiles(cwd, dataDir) });
});

// Background processes (dev servers) the agent started.
app.get("/api/processes", (_req, res) => res.json(listProcesses()));
app.post("/api/kill", (req, res) => res.json({ ok: killProcess(req.body.pid) }));

// Undo: put back the files a reply changed, from the snapshot taken before it.
const checkpointsDir = join(dataDir, "checkpoints");
mkdirSync(checkpointsDir, { recursive: true });
app.post("/api/undo", (req, res) => {
  const file = join(checkpointsDir, safeId(req.body.checkpointId) + ".json");
  if (!existsSync(file)) return res.status(404).json({ error: "This checkpoint is no longer available." });
  const cp = JSON.parse(readFileSync(file, "utf8"));
  const restored = [];
  for (const [p, b64] of Object.entries(cp.files)) {
    try {
      if (b64 === null) { if (existsSync(p)) unlinkSync(p); }
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(b64, "base64")); }
      restored.push(p);
    } catch {}
  }
  unlinkSync(file);
  // Tell the AI on the next message, so it doesn't assume its changes are still there.
  const s = loadSession(cp.chatId);
  if (s) { s.note = `(Note: the user undid your file changes from an earlier reply. These files were restored to how they were before: ${restored.join(", ")})`; saveSession(cp.chatId, s); }
  res.json({ ok: true, restored });
});

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
const FAST_MODELS = new Set(["claude-opus-5-5"]); // fast mode: same model, quicker replies, 2x price
const READ_ONLY_TOOLS = TOOLS.filter((t) => !WRITE_TOOLS.has(t.name));
const STUDIO_NAMES = new Set(STUDIO_TOOLS.map((t) => t.name));
const STUDIO_READ_TOOLS = STUDIO_TOOLS.filter((t) => ["read_artifact", "browser", "view_file"].includes(t.name));
// Tools that only look, so several in one reply can run at the same time (view_file stays out: it may
// open Office, which shouldn't run twice at once).
const PARALLEL_TOOLS = new Set(["read_file", "list_files", "search_files", "fetch_url", "search_web", "check_process", "wait_for_process", "watch_process", "read_artifact", "use_skill", "delegate_task", "find_tools"]);
// Optional API features; if the account rejects them, we retry once without.
let useExtras = true;

// Working chats, kept after the page closes (see send() in /api/chat).
const liveTurns = new Map(); // chatId -> { events, subs, done }
app.get("/api/chat/live", (_req, res) => res.json([...liveTurns].filter(([, t]) => !t.claimed).map(([chatId, t]) => ({ chatId, done: t.done, events: t.events.length, auto: t.auto || undefined }))));
app.get("/api/chat/attach", (req, res) => {
  const live = liveTurns.get(String(req.query.chatId || ""));
  if (!live) return res.status(404).json({ error: "That chat isn't working any more." });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  for (const ev of live.events.slice(Math.max(0, Number(req.query.from) || 0))) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (live.done) { // delivered now: forget it shortly
    live.claimed = true; setTimeout(() => { if (liveTurns.get(req.query.chatId) === live) liveTurns.delete(req.query.chatId); }, 120000);
    return res.end();
  }
  live.subs.add(res);
  res.on("close", () => live.subs.delete(res));
});

// Cloud tasks that were still working when the app closed: follow them again on start. Each gets a live
// turn like a chat that kept working with the window closed, so the page shows it (pickUpLiveChats).
function catchUpCloud() {
  if (!apiKey) return;
  let files = []; try { files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    const chatId = f.slice(0, -5);
    const session = loadSession(chatId);
    if (!session?.cloudId || session.cloudStatus !== "running" || running.has(chatId) || liveTurns.has(chatId)) continue;
    const live = { events: [], subs: new Set(), done: false };
    const send = (obj) => {
      const last = live.events.at(-1);
      if (obj.type === "delta" && last?.type === "delta") last.text += obj.text; else live.events.push({ ...obj });
      const line = `data: ${JSON.stringify(obj)}\n\n`;
      for (const r of live.subs) if (!r.writableEnded) r.write(line);
    };
    const abort = new AbortController();
    running.set(chatId, abort); liveTurns.set(chatId, live);
    const model = session.cloudModel || "claude-sonnet-5-5", started = Date.now();
    followCloud({ key: apiKey, session, model, workDir: session.workDir, send, signal: abort.signal, save: () => saveSession(chatId, session), addUsage })
      .then((r) => send(r.status === "stopped" ? { type: "stopped" } : { type: "result", cost: r.cost, turns: 1, ms: Date.now() - started, usage: {}, checkpointId: null, contextTokens: 0, model }))
      .catch((e) => { if (!abort.signal.aborted) send({ type: "error", text: "Cloud task: " + friendlyError(e) }); })
      .finally(() => {
        running.delete(chatId);
        send({ type: "done" }); live.done = true;
        const seen = live.subs.size > 0; if (seen) live.claimed = true;
        for (const r of live.subs) r.end();
        live.subs.clear();
        setTimeout(() => { if (liveTurns.get(chatId) === live) liveTurns.delete(chatId); }, seen ? 120000 : 6 * 3600000);
      });
  }
}
app.post("/api/chat", async (req, res) => {
  const { chatId, prompt, cwd, images, mode } = req.body;
  const attachRoot = join(dataDir, "attachments");
  const files = (Array.isArray(req.body.files) ? req.body.files : []).filter((f) => f && typeof f.path === "string" && !relative(attachRoot, f.path).startsWith("..") && !isAbsolute(relative(attachRoot, f.path)) && existsSync(f.path));
  // A Claude model, or "<provider>:<model>" for Gemini / OpenRouter / Groq (needs that provider's key).
  const other = splitModel(req.body.model);
  const model = MODELS.includes(req.body.model) ? req.body.model : other && providerKey(other.provider) ? req.body.model : "claude-sonnet-5-5";
  // Team mode: a Claude model plans first and checks the work at the end; the chosen model does the work.
  const team = req.body.team && MODELS.includes(req.body.team.planner) && MODELS.includes(req.body.team.checker) ? req.body.team : null;
  const effort = EFFORTS.includes(req.body.effort) ? req.body.effort : "medium";
  const fast = req.body.fast === true && FAST_MODELS.has(model);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  // Every event is kept (deltas merged) while the chat works, so the page can close and reopen
  // without stopping it: /api/chat/attach replays what was missed, then follows live.
  const live = { events: [], subs: new Set([res]), done: false };
  const send = (obj) => {
    const last = live.events.at(-1);
    if (obj.type === "delta" && last?.type === "delta") last.text += obj.text;
    else if (obj.type === "term" && last?.type === "term" && last.id === obj.id) { last.text += obj.text; if (last.text.length > 200000) last.text = last.text.slice(-100000); }
    else live.events.push({ ...obj });
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const r of live.subs) if (!r.writableEnded) r.write(line);
  };
  const finish = () => {
    send({ type: "done" }); live.done = true;
    // Seen to the end by an open page: forget it soon. Nobody watching: keep it (6 hours) so the
    // page can show the finished reply when it's opened again.
    const seen = live.subs.size > 0; if (seen) live.claimed = true;
    for (const r of live.subs) r.end();
    live.subs.clear();
    setTimeout(() => { if (liveTurns.get(chatId) === live) liveTurns.delete(chatId); }, seen ? 120000 : 6 * 3600000);
  };

  if (!apiKey && (isClaude(model) || team)) { send({ type: "error", text: team ? "Team mode plans and checks with Claude, so it needs your Claude API key. Add it in Settings." : "No API key yet. Open Settings (bottom-left) and add your key." }); return finish(); }
  if (running.has(chatId)) { send({ type: "error", text: "This chat is still working. Stop it first." }); return finish(); }

  // No folder linked: give the chat its own private workspace, like a scratch folder.
  const scratch = !cwd;
  const workDir = cwd || join(dataDir, "workspaces", safeId(chatId));
  if (scratch) mkdirSync(workDir, { recursive: true });
  if (!existsSync(workDir) || !statSync(workDir).isDirectory()) {
    send({ type: "error", text: "That project folder no longer exists. Link another folder." });
    return finish();
  }
  const extraDirs = (Array.isArray(req.body.extraDirs) ? req.body.extraDirs : []).filter((d) => existsSync(d));

  // Continue the saved conversation, unless the app started a fresh one.
  let session = req.body.sessionId ? loadSession(chatId) : null;
  // gen identifies this conversation; a new one (e.g. after a folder change) gets a new gen,
  // so the app knows older messages can't be edited against it.
  if (!session || session.workDir !== workDir) session = { workDir, messages: [], gen: Date.now() };
  session.gen ||= Date.now();
  // Editing an earlier message: keep only the conversation before that prompt.
  // session.prompts holds where each of the user's messages starts, so we can cut exactly there.
  session.prompts ||= [];
  if (Number.isInteger(req.body.rewindTo)) {
    const k = req.body.rewindTo, cut = session.prompts[k];
    if (cut === undefined || cut > session.messages.length) {
      send({ type: "error", text: "This chat can't be rewound that far. Start a new chat instead." });
      return finish();
    }
    session.messages = session.messages.slice(0, cut);
    session.prompts = session.prompts.slice(0, k);
    // a cloud task can't be rewound: the edited message starts a fresh cloud workspace
    if (session.cloudId) { delete session.cloudId; session.cloudStatus = "idle"; session.cloudSeen = []; session.cloudFiles = []; session.cloudCost = 0; }
    delete session.note;
  }
  const rules = loadRules(workDir, dataDir); // permission rules and hooks (settings.json)
  for (const e of rules.errors) send({ type: "error", text: "A settings file couldn't be read: " + e });
  const memory = loadMemory(workDir, extraDirs);
  const skills = loadSkills(workDir, skillsDir);
  const agents = loadAgents(workDir); // custom helpers from .claude/agents
  await secretsReady();
  // Auto memory (not for scratch chats: their folder is thrown away with the chat).
  const autoMem = !scratch && autoMemoryOn() ? loadAutoMemory(workDir) : null;
  let system = systemPrompt({ workDir, extraDirs, scratch, memory, skills, depth: researchDepth(), secrets: secretNames(), toolSecrets: toolSecretNotes(), autoMemory: autoMem, agents }) +
    (mode === "plan" ? "\n\nPLAN MODE: Only read and investigate. Do not change any files or run commands. End with a clear step-by-step plan for the user to approve." : "") +
    // Other providers' free tiers allow few requests per minute, and every reply is one request:
    // ask for fewer, fuller turns (several tool calls at once).
    (!isClaude(model) ? "\n\nWORK IN FEW TURNS: each of your replies costs one request, and this model has a small per-minute request limit. " +
      "Whenever actions don't depend on each other, make several tool calls in the same reply: e.g. read all the files you need at once, write all new files at once (one write_file call per file, together), run independent checks together. " +
      "Don't spend a reply only on update_plan: update the plan in the same reply as real work, and only when something changes. Don't re-read a file you just wrote. Before replying, think about everything you can do in this turn." : "");

  const content = [];
  for (const img of images || []) {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(img);
    if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  if (files.length) content.push({ type: "text", text: "The user attached " + (files.length > 1 ? "these files" : "this file") + " (saved on this PC):\n" + files.map((f) => `- ${f.name}: ${f.path}`).join("\n") +
    "\nOpen them yourself: view_file for PDFs and Word, Excel or PowerPoint files, read_file for text and code, PowerShell or Python for anything else (zip, csv, audio...). Don't ask the user to paste their contents." });
  // @mentions picked from the @ list in the message box: the file's text goes along (like Claude Code), or a pointer when it's big or not text.
  const mentions = [...new Set([...String(prompt || "").matchAll(/(?:^|\s)@("[^"]+"|[^\s"]+)/g)].map((m) => m[1].replace(/^"|"$/g, "").replace(/[.,;:!?)]+$/, "")))].slice(0, 10);
  for (const m of mentions) {
    const p = resolve(workDir, m); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { content.push({ type: "text", text: `The user mentioned the folder @${m} (${p}).` }); continue; }
    if (!st.isFile()) continue;
    let text = null; try { if (st.size <= 100000) { text = readFileSync(p, "utf8"); if (text.includes("\u0000")) text = null; } } catch {}
    content.push({ type: "text", text: text === null
      ? `The user mentioned the file @${m} (${p}, ${Math.round(st.size / 1024)} KB). Open it with read_file or view_file.`
      : `The user mentioned the file @${m} (${p}). Its contents:\n\`\`\`\n${text}\n\`\`\`` });
  }
  if (session.note) { content.push({ type: "text", text: session.note }); delete session.note; }
  if (rules.hooks.UserPromptSubmit) {
    const h = await runHooks(rules, "UserPromptSubmit", { session_id: chatId, prompt: String(prompt || "") }, { workDir });
    if (h.block) { send({ type: "error", text: "A hook stopped this message: " + h.reason }); return finish(); }
    if (h.context) content.push({ type: "text", text: "(Added by a hook) " + h.context });
  }
  content.push({ type: "text", text: String(prompt || "") });
  session.prompts.push(session.messages.length);
  session.messages.push({ role: "user", content });
  saveSession(chatId, session);
  // promptIndex is this message's exact position, used when the user edits it later.
  send({ type: "session", sessionId: chatId, model, cwd: workDir, memory: memory.map((m) => m.path), promptIndex: session.prompts.length - 1, gen: session.gen });

  const abort = new AbortController();
  running.set(chatId, abort);
  liveTurns.set(chatId, live);
  // A turn the app started by itself (watch_process): nobody holds this request, the page attaches to it.
  if (req.body.auto) { live.auto = String(prompt || "").slice(0, 300); live.subs.delete(res); res.end(); }
  // Closing the window no longer stops the chat (Stop and Esc still do). Scheduled runs keep the old rule.
  res.on("close", () => { live.subs.delete(res); if (req.body.unattended && !res.writableEnded) abort.abort(); });

  // Cloud task: runs on Anthropic's servers (Managed Agents) instead of on this PC.
  if (req.body.cloud && !apiKey) { send({ type: "error", text: "Cloud tasks run on Claude, so they need your Claude API key. Add it in Settings, or switch off \"Run as a cloud task\"." }); running.delete(chatId); return finish(); }
  if (req.body.cloud && apiKey) {
    session.cloudModel = isClaude(model) ? model : "claude-sonnet-5-5";
    const started = Date.now();
    try {
      const r = await cloudTurn({ key: apiKey, dataDir, session, prompt: String(prompt || ""), model: isClaude(model) ? model : "claude-sonnet-5-5", workDir,
        capDollars: Math.min(50, Math.max(0.5, Number(req.body.cloudCap) || 5)), send, signal: abort.signal, save: () => saveSession(chatId, session), addUsage });
      send(r.status === "stopped" ? { type: "stopped" } : { type: "result", cost: r.cost, turns: 1, ms: Date.now() - started, usage: {}, checkpointId: null, contextTokens: 0, model });
    } catch (e) { if (!abort.signal.aborted) send({ type: "error", text: "Cloud task: " + friendlyError(e) }); }
    finally { running.delete(chatId); finish(); }
    return;
  }

  // Connectors for this chat (not in plan mode, where nothing should change).
  // They connect in the background: the reply starts at once (connections already open are ready
  // straight away), and a slow connector's tools join from the next step once it's connected.
  let mcp = { defs: [], has: () => false };
  // Many connector tools are loaded only when needed (find_tools, toolsearch.mjs). Claude loads them in
  // place through tool references; tools another model loaded stay in this list for the chat.
  const loadedTools = new Set(session.loadedTools || []);
  // A Chrome connector (chrome-devtools-mcp) drives a real Chrome: say how to use it for the jobs people
  // want it for, like making images on sites the user is signed in to.
  const useConnectors = (m) => {
    mcp = m;
    if (running.get(chatId) === abort) for (const s of m.status.filter((x) => !x.ok)) send({ type: "error", text: `The "${s.name}" connector couldn't connect: ${s.error}` });
    if (m.defs.some((d) => /^mcp__chrome[^_]*__/i.test(d.name))) system += "\n\nCHROME: the mcp__chrome… tools drive a real Chrome window where the user is signed in to their sites. " +
      "To make an image with Gemini (gemini.google.com) or ChatGPT (chatgpt.com) there: open the site in a new page, type the user's request into its message box and send it, " +
      "wait until the image has finished (take a snapshot or screenshot to check; it can take a minute), then use the site's own download button so the file lands in the user's Downloads folder, and give the full path. " +
      "If the site asks the user to sign in or confirm something, stop and tell them; never type passwords. Only use this Chrome for what the user asked.";
  };
  if (mode !== "plan" && Object.keys(connectors.configsFor(workDir)).length) {
    const loading = connectors.toolsFor(workDir).then(useConnectors,
      (e) => { if (running.get(chatId) === abort) send({ type: "error", text: "Connectors failed to load: " + (e.message || e) }); });
    await Promise.race([loading, new Promise((r) => setTimeout(r, 1500))]);
  }
  // Stop ends the current step at once, even one that doesn't listen for it (connectors, the
  // browser, helpers): the step is answered "Stopped by the user." and the reply ends.
  const stopped = new Promise((_, rej) => abort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
  stopped.catch(() => {});

  const client = new Anthropic({ apiKey, maxRetries: 3 });
  // Snapshot each file the first time this reply changes it, so the user can undo.
  const snapshot = new Map();
  const onBeforeWrite = (p) => {
    if (!snapshot.has(p)) snapshot.set(p, existsSync(p) ? readFileSync(p).toString("base64") : null);
  };
  let activeToolId = null; // which step the live terminal output belongs to
  // A dev server this reply (or one of its helpers) started is answering: open it in the preview (not this app's own address).
  // A web address (not this app's own), a file path or artifact:<id> goes to the preview panel.
  const previewTo = (url) => { try { if (live.done) return; if (/^https?:/i.test(url) && Number(new URL(url).port) === Number(PORT)) return; send({ type: "preview", url }); } catch {} };
  // Folders this reply may change. It grows when the user allows a new folder mid-chat.
  const inside = (d, p) => { const r = relative(d, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  // skillsDir: so it can create skills; the auto memory folder: so it can keep its notes.
  const allowedDirs = [workDir, ...extraDirs, skillsDir, ...(autoMem ? [autoMem.dir] : [])];
  const isAllowed = (p) => allowedDirs.some((d) => inside(d, p));
  const runTool = makeToolRunner({
    workDir, allowedDirs, chatId, openExternal, shellFile: join(dataDir, "shells", safeId(chatId)), onBeforeWrite,
    // watch_process: when the job needs attention later, start a new turn in this chat by itself.
    onWatch: req.body.unattended ? null : (ev) => autoTurn(chatId, { cwd, extraDirs, model: req.body.model, effort, mode: mode === "plan" ? "ask" : mode, fast: req.body.fast }, ev.text), searchKey: () => researchCfg().braveKey || "", viaClaude: claudeSearch, secretEnv: envFor, scrub,
    onOutput: (chunk) => send({ type: "term", id: activeToolId, text: chunk }),
    // A dev server this reply started is answering: open it in the preview (not this app's own address).
    onPreview: (url) => previewTo(url),
  });

  // ask_user: show the question with buttons in the app and wait for the answer.
  async function askUser(input) {
    // Scheduled runs have nobody watching: don't wait for an answer.
    if (req.body.unattended) return "(No one is available to answer: this is a scheduled task. Make the most sensible choice and say which you made.)";
    const reqId = crypto.randomUUID();
    const options = (Array.isArray(input.options) ? input.options : []).map(String).slice(0, 6);
    send({ type: "question", reqId, question: String(input.question || ""), options, multiple: !!input.multiple });
    const answer = await new Promise((done) => {
      approvals.set(reqId, done);
      abort.signal.addEventListener("abort", () => done("(The user stopped the chat without answering.)"), { once: true });
    });
    approvals.delete(reqId);
    send({ type: "answered", reqId, answer });
    return answer;
  }
  const helperRunner = makeToolRunner({ workDir, allowedDirs: [], searchKey: () => researchCfg().braveKey || "", viaClaude: claudeSearch, scrub });

  // Instead of failing, ask the user to allow a folder outside the linked ones.
  async function askAccess(dir) {
    if (req.body.unattended) return false;
    const a = await askUser({ question: `Allow access to ${dir}? It's outside this chat's linked folders.`, options: ["Allow", "Deny"] });
    if (!/^allow/i.test(a)) return false;
    allowedDirs.push(dir); send({ type: "dir_added", dir });
    return true;
  }
  // PowerShell commands that change files outside the linked folders: ask first (even in Auto-edit).
  const CHANGES = /\b(Remove-Item|rm|del|erase|rd|rmdir|Move-Item|mv|move|Copy-Item|cp|copy|xcopy|robocopy|Rename-Item|ren|Set-Content|Add-Content|Clear-Content|Out-File|New-Item|ni|mkdir|md|Expand-Archive|Compress-Archive|Export-Csv)\b|(^|[^2])>{1,2}\s*[^$&\s]/i;
  function outsidePaths(cmd) {
    const env = { USERPROFILE: homedir(), HOME: homedir(), APPDATA: process.env.APPDATA || "", LOCALAPPDATA: process.env.LOCALAPPDATA || "", TEMP: tmpdir(), TMP: tmpdir() };
    const text = String(cmd || "")
      .replace(/\$env:(\w+)/gi, (m, k) => env[k.toUpperCase()] ?? m)
      .replace(/%(\w+)%/g, (m, k) => env[k.toUpperCase()] ?? m)
      .replace(/(^|[\s"'(])~(?=[\\/])/g, (m, a) => a + homedir());
    const found = new Set();
    for (const m of text.matchAll(/[A-Za-z]:[\\/][^"'`\r\n|;<>*?]*/g)) {
      const p = resolve(m[0].replace(/\s+-\w.*$/, "").trim()); // cut off a following -Parameter
      if (!isAllowed(p) && !isAllowed(dirname(p)) && relative(tmpdir(), p).startsWith("..")) found.add(p);
    }
    return [...found];
  }
  async function checkCommand(cmd) {
    if (!CHANGES.test(String(cmd || ""))) return true;
    const paths = outsidePaths(cmd); if (!paths.length) return true;
    if (req.body.unattended) return false;
    const a = await askUser({ question: `This command may change files outside the linked folders:\n${paths.slice(0, 4).join("\n")}\nRun it?`, options: ["Run it", "Allow these folders for this chat", "Don't run"] });
    if (/^allow/i.test(a)) { // link the folders, so it doesn't ask about them again
      for (const p of paths) {
        const dir = existsSync(p) && statSync(p).isDirectory() ? p : dirname(p);
        if (dirname(dir) === dir) continue; // never a whole drive
        if (!isAllowed(dir)) { allowedDirs.push(dir); send({ type: "dir_added", dir }); }
      }
      return true;
    }
    return /^run/i.test(a);
  }

  // Artifacts and the hidden browser.
  let browser = takeBrowser(chatId); // the browser and its tabs are kept between this chat's replies
  async function runStudioTool(name, input) {
    try {
      if (name === "create_artifact") {
        const m = artifacts.create({ title: input.title, type: input.type, content: String(input.content || ""), chatId });
        send({ type: "artifact", id: m.id, title: m.title, kind: m.type, version: 1 });
        return { text: `Created artifact "${m.title}" (id ${m.id}). It is open in the user's side panel. View it yourself with the browser tool at artifact:${m.id}.`, isError: false };
      }
      if (name === "update_artifact") {
        const m = artifacts.update(input.id, String(input.content || ""), { note: input.note });
        send({ type: "artifact", id: m.id, title: m.title, kind: m.type, version: m.versions.length });
        return { text: `Saved version ${m.versions.length} of "${m.title}".`, isError: false };
      }
      if (name === "read_artifact") {
        const { meta, version, content } = artifacts.read(input.id);
        return { text: `"${meta.title}" (${meta.type}), version ${version}:\n\n${content}`, isError: false };
      }
      if (name === "view_file") {
        const p = resolve(workDir, String(input.path || ""));
        if (!existsSync(p)) return { text: `File not found: ${p}`, isError: true };
        const size = statSync(p).size;
        const img = /\.(png|jpe?g|gif|webp)$/i.exec(p);
        if (img) {
          if (size > 5e6) return { text: "That image is over 5 MB; resize it first (e.g. with Python's PIL).", isError: true };
          const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[img[1].toLowerCase()];
          return { text: `Image ${p}`, content: [{ type: "text", text: `Image ${p}` }, { type: "image", source: { type: "base64", media_type: type, data: readFileSync(p).toString("base64") } }], isError: false };
        }
        let pdf = null;
        if (/\.pdf$/i.test(p)) pdf = p;
        else if (OFFICE.test(p)) { send({ type: "status", text: "Opening it with Microsoft Office…" }); pdf = await officePreview(p); }
        else return { text: "view_file handles images, PDFs and Office files. Use read_file for text.", isError: true };
        if (statSync(pdf).size > 30e6) return { text: "That document is over 30 MB, too big to view at once.", isError: true };
        return {
          text: `Document ${p}`,
          content: [{ type: "text", text: `Document ${p}` }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: readFileSync(pdf).toString("base64") } }],
          isError: false,
        };
      }
      if (name === "browser") {
        browser ||= makeBrowser({ baseUrl: contentBase });
        const content = await browser.run(input);
        return { text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n"), content, isError: false };
      }
    } catch (e) { return { text: String(e.message || e), isError: true }; }
    return { text: `Unknown tool ${name}`, isError: true };
  }

  // One request to any model (no streaming), with its cost counted.
  let cacheOk = true;
  async function callOnce(useModel, { system, messages, tools, effort: eff = "low", signal = abort.signal }) {
    let m;
    const o = splitModel(useModel);
    if (o?.provider === "gemini") m = await geminiWithFallback(geminiLimits, geminiChain(o.model), { key: providerKey("gemini"), system, messages, tools, effort: eff, signal }, geminiNotices);
    else if (o) m = await chatStep({ provider: o.provider, key: providerKey(o.provider), model: o.model, system, messages, tools, effort: eff, signal });
    else {
      // The prompt cache keeps a helper's growing conversation cheap; dropped if the account refuses it.
      const body = { model: useModel, max_tokens: 16000, output_config: { effort: eff }, system, messages,
        tools: [...tools, ...(tools.some((t) => t.name === "search_web") ? [serverToolsFor(researchDepth())[0]] : [])], ...(cacheOk ? { cache_control: { type: "ephemeral" } } : {}) };
      try { m = await client.messages.create(body, { signal }); }
      catch (e) {
        if (!(cacheOk && e instanceof Anthropic.BadRequestError && /cache/i.test(e.message))) throw e;
        cacheOk = false; delete body.cache_control; m = await client.messages.create(body, { signal });
      }
    }
    const c = costOf(useModel, m.usage); totalCost += c; addUsage(c, m.usage, useModel); send({ type: "usage" });
    return m;
  }
  // A short read-only investigation by any model: used by delegate_task helpers, and by the
  // team planner and checker.
  async function miniAgent(useModel, system, task, eff = "low") {
    const msgs = [{ role: "user", content: task }];
    for (let i = 0; i < 25; i++) {
      if (abort.signal.aborted) return "Stopped by the user.";
      const m = await callOnce(useModel, { system, messages: msgs, tools: HELPER_TOOLS, effort: eff });
      msgs.push({ role: "assistant", content: m.content, ...(m.raw ? { raw: m.raw } : {}) });
      const uses = m.content.filter((b) => b.type === "tool_use" && b.input);
      if (m.stop_reason === "pause_turn") continue;
      if (!uses.length) return m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") || "(no report)";
      // A helper only looks, so all of its steps in one reply run at the same time.
      send({ type: "status", text: `Helper: ${[...new Set(uses.map((u) => u.name.replace("_", " ")))].join(", ")}…` });
      const results = await Promise.all(uses.map(async (u) => {
        const out = await helperRunner(u.name, u.input, abort.signal);
        return { type: "tool_result", tool_use_id: u.id, content: out.text, is_error: out.isError || undefined };
      }));
      msgs.push({ role: "user", content: results });
    }
    return "The helper ran out of steps before finishing.";
  }

  // Helpers (delegate_task): explore / plan only look; general and custom helpers (.claude/agents) can
  // change things, through the same checks as the chat's own steps (permission rules, ask mode, hooks,
  // folder access, undo), each with its own shell so its cd doesn't move the chat. Background helpers
  // run while the chat carries on; their reports arrive as automatic messages, and the reply waits for
  // them before it ends. Stop (or the reply ending) stops every helper.
  const helperStop = new AbortController();
  abort.signal.addEventListener("abort", () => helperStop.abort(), { once: true });
  const helperStopped = new Promise((_, rej) => helperStop.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
  helperStopped.catch(() => {});
  const bgHelpers = new Map(), helperNotes = [];
  let helperCount = 0;
  async function startHelper(t) {
    const found = findHelper(t.input.agent, agents);
    if (found.error) return { text: found.error, isError: true };
    const names = helperToolNames(found, mcp.defs.map((d) => d.name));
    const write = changesThings(names);
    if (mode === "plan" && write) return { text: "Plan mode: only look-only helpers (explore, plan) can run now.", isError: true };
    const n = ++helperCount;
    const label = found.def?.name || (found.kind === "plan" ? "Planner" : "Helper");
    const shellFile = write ? join(dataDir, "shells", `${safeId(chatId)}~h${n}`) : null;
    const via = { label, prefix: `h${n}_`, allowed: new Set(names), show: write, activeId: null, signal: helperStop.signal, loaded: new Set() };
    if (names.some((x) => x.startsWith("mcp__"))) via.allowed.add("find_tools"); // offered only when its connector tools are many
    via.runTool = write ? makeToolRunner({ workDir, allowedDirs, chatId, openExternal, shellFile, onBeforeWrite, searchKey: () => researchCfg().braveKey || "", viaClaude: claudeSearch, secretEnv: envFor, scrub,
      onOutput: (chunk) => send({ type: "term", id: via.activeId, text: chunk }), onPreview: previewTo }) : helperRunner;
    const want = (found.def?.skills || []).map((s) => s.toLowerCase());
    const skillTexts = skills.filter((s) => want.includes(s.name.toLowerCase())).map((s) => { try { return `\n## ${s.name} (folder: ${s.dir})\n${readFileSync(s.file, "utf8")}`; } catch { return ""; } }).filter(Boolean);
    const useModel = helperModel(found, model, { models: MODELS, canUse: (id) => isClaude(id) ? !!apiKey : !!(splitModel(id) && providerKey(splitModel(id).provider)) });
    via.model = useModel;
    const eff = EFFORTS.includes(found.def?.effort) ? found.def.effort : found.kind === "explore" ? "low" : found.kind === "plan" ? "medium" : effort;
    const job = agentLoop({ useModel, eff, via, task: String(t.input.task || ""),
      system: helperSystem(found, { workDir, env: environment(workDir), memory, skillTexts }),
      tools: () => [...TOOLS.filter((d) => via.allowed.has(d.name)), ...connectorTools(mcp.defs.filter((d) => via.allowed.has(d.name)), { claude: isClaude(useModel), loaded: via.loaded })],
      maxSteps: Math.min(150, Math.max(1, Number(found.def?.maxTurns) || (write ? 60 : 25))) })
      .finally(() => { if (shellFile) resetShell(shellFile); });
    const bg = t.input.background === true || (found.def?.background === true && t.input.background !== false);
    if (!bg) return { text: await job, isError: false };
    bgHelpers.set(n, { label, id: t.id });
    job.then((r) => [r, false], (e) => ["The helper failed: " + friendlyError(e), true]).then(([report, bad]) => {
      bgHelpers.delete(n);
      if (helperStop.signal.aborted) return;
      report = scrub(String(report));
      helperNotes.push(`(Automatic message: background helper #${n} (${label}) has finished${bad ? " with an error" : ""}. Its report:)\n${capText(report, 30000)}`);
      send({ type: "helper_done", id: t.id, isError: bad, text: report.slice(0, 4000) });
    });
    return { text: `Started helper #${n} (${label}) in the background. Carry on with other work; its report will arrive as an automatic message when it's done, and your reply waits for it before ending.`, isError: false, pending: true };
  }
  async function agentLoop({ useModel, system, task, tools, maxSteps, eff, via }) {
    const msgs = [{ role: "user", content: task }];
    for (let i = 0; i < maxSteps; i++) {
      if (via.signal.aborted) return "Stopped by the user.";
      const m = await Promise.race([callOnce(useModel, { system, messages: msgs, tools: typeof tools === "function" ? tools() : tools, effort: eff, signal: via.signal }), helperStopped]);
      msgs.push({ role: "assistant", content: m.content, ...(m.raw ? { raw: m.raw } : {}) });
      if (m.stop_reason === "pause_turn") continue;
      const uses = m.content.filter((b) => b.type === "tool_use");
      if (!uses.length) return m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") || "(no report)";
      if (!via.show) send({ type: "status", text: `${via.label}: ${[...new Set(uses.map((u) => u.name.replace("_", " ")))].join(", ")}…` });
      // Look-only steps next to each other run at the same time (all of them for a look-only helper); others alone, in order.
      const results = [], together = (u) => !via.show || PARALLEL_TOOLS.has(u.name);
      for (let a = 0; a < uses.length;) {
        let b = a;
        if (together(uses[a])) while (b + 1 < uses.length && together(uses[b + 1])) b++;
        results.push(...await Promise.all(uses.slice(a, b + 1).map((u) => helperStep(u, via))));
        a = b + 1;
      }
      msgs.push({ role: "user", content: results });
    }
    return `${via.label} ran out of steps (limit ${maxSteps}) before finishing. Check what it did so far.`;
  }
  async function helperStep(u, via) {
    const id = via.prefix + u.id, t = { id, name: u.name, input: u.input };
    if (via.show) send({ type: "tool", id, name: u.name, input: u.input, helper: via.label });
    let out;
    try {
      out = !via.allowed.has(u.name) ? { text: `${u.name} isn't one of this helper's tools. It has: ${[...via.allowed].join(", ")}.`, isError: true }
        : await Promise.race([handleTool(t, via), helperStopped]);
    } catch (e) { out = { text: via.signal.aborted ? "Stopped by the user." : "This step failed: " + String(e?.message || e), isError: true }; }
    finally { if (via.activeId === id) via.activeId = null; }
    out.text = capText(out.text, 30000);
    if (Array.isArray(out.content)) out.content = out.content.map((c) => c.type === "text" ? { type: "text", text: capText(c.text, 30000) } : c);
    if (via.show) send({ type: "tool_result", id, isError: out.isError, text: out.text.slice(0, 4000), diff: out.diff, path: out.path });
    return { type: "tool_result", tool_use_id: u.id, content: out.content || out.text, is_error: out.isError || undefined };
  }
  // The reply is about to end but background helpers are still working: wait for one to finish (or a message from the user).
  async function waitForHelpers() {
    send({ type: "status", text: `Waiting for background helper${bgHelpers.size > 1 ? "s" : ""} (${[...bgHelpers].map(([n, h]) => `#${n} ${h.label}`).join(", ")})…` });
    while (bgHelpers.size && !helperNotes.length && !inbox.get(chatId)?.length) {
      if (abort.signal.aborted) throw new Error("aborted");
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // Ask mode: wait for the user's OK in the app before changing anything.
  async function permitted(name, input, force = false, helper = null) {
    // Connector tools can change things in other services, so "ask first" covers them too.
    // force: a permission rule says "ask" (even in Auto-edit).
    if (req.body.unattended && force) return false;
    // Its own notes (auto memory) never need an OK.
    if (!force && autoMem && (name === "write_file" || name === "edit_file") && input?.path && inside(autoMem.dir, resolve(workDir, String(input.path)))) return true;
    if (!force && (mode !== "ask" || !(WRITE_TOOLS.has(name) || name.startsWith("mcp__")) || allowAlways.get(chatId)?.has(name))) return true;
    const reqId = crypto.randomUUID();
    send({ type: "permission", reqId, tool: name, input, ...(helper ? { helper } : {}) });
    const answer = await new Promise((done) => {
      approvals.set(reqId, done);
      abort.signal.addEventListener("abort", () => done("deny"), { once: true });
    });
    approvals.delete(reqId);
    send({ type: "answered", reqId, answer });
    if (answer === "always") {
      if (!allowAlways.has(chatId)) allowAlways.set(chatId, new Set());
      allowAlways.get(chatId).add(name);
    }
    return answer !== "deny";
  }

  const started = Date.now();
  let totalCost = 0, steps = 0, stopHooks = 0, wrapUps = 0;
  let usedModel = model; // what actually answered (Gemini may fall back to another model)
  const geminiNotices = {
    onWait: (m, sec, kind) => send({ type: "status", text: kind === "check" ? `Gemini refused this request; waiting ${sec}s to see if it's the per-minute or the daily limit…` : `Pacing for Gemini's per-minute limit (${sec}s)…` }),
    onSwitch: (from, to, why) => send({ type: "fallback", from: `gemini:${from}`, to: `gemini:${to}`, why }),
  };
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  let contextTokens = 0;
  function resultEvent() {
    let checkpointId = null;
    if (snapshot.size) {
      checkpointId = crypto.randomUUID();
      writeFileSync(join(checkpointsDir, checkpointId + ".json"), JSON.stringify({ chatId, files: Object.fromEntries(snapshot) }));
    }
    return { type: "result", cost: totalCost, turns: steps, ms: Date.now() - started, usage: totals, checkpointId, contextTokens, model: usedModel };
  }

  // Old screenshots and documents from tool steps are re-sent with every request and cost a
  // lot. Once there are more than 4, keep only the latest 2 (done in one go, so the prompt
  // cache is only rebuilt occasionally).
  function pruneMedia() {
    const found = [];
    for (const msg of session.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) if (b.type === "tool_result" && Array.isArray(b.content))
        b.content.forEach((c, i) => { if (c.type === "image" || c.type === "document") found.push([b, i]); });
    }
    if (found.length <= 4) return;
    for (const [b, i] of found.slice(0, -2)) b.content[i] = { type: "text", text: "(An older screenshot/document was removed to save tokens. View it again if needed.)" };
  }

  // A single tool result (a big web page from the Chrome connector, a huge file or log) could
  // fill the whole context window and leave the chat unable to answer. Cap the text of each
  // result; the AI is told it was cut so it can ask for a smaller piece.
  const RESULT_CAP = 60000; // characters, about 15k tokens
  function capText(t, cap = RESULT_CAP) {
    t = String(t ?? "");
    return t.length <= cap ? t : t.slice(0, cap) + `

(Result cut: it was ${t.length.toLocaleString("en")} characters, only the first ${cap.toLocaleString("en")} are shown. Ask for a smaller part, e.g. search the page or read a section.)`;
  }
  // A chat that already went over the limit: shrink older tool results (and drop old pictures)
  // so it can carry on instead of failing on every message.
  function shrinkHistory(cap) {
    let changed = 0;
    for (const msg of session.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type !== "tool_result") continue;
        if (typeof b.content === "string") { if (b.content.length > cap) { b.content = capText(b.content, cap); changed++; } }
        else if (Array.isArray(b.content)) b.content = b.content.map((c) => {
          if (c.type === "text" && c.text.length > cap) { changed++; return { type: "text", text: capText(c.text, cap) }; }
          if (c.type === "image" || c.type === "document") { changed++; return { type: "text", text: "(An older screenshot/document was removed to make room.)" }; }
          return c;
        });
      }
    }
    return changed;
  }

  // The optional features are dropped for this chat only when a request is refused; the app-wide
  // switch goes off only once a retry without them works (so they really were the cause).
  let extrasOn = useExtras, extrasDropped = false;
  function requestBody() {
    pruneMedia();
    const body = {
      model,
      max_tokens: 32000,
      system: [{ type: "text", text: system }],
      tools: [...(mode === "plan" ? READ_ONLY_TOOLS : TOOLS), ...(mode === "plan" ? STUDIO_READ_TOOLS : STUDIO_TOOLS), ...connectorTools(mcp.defs, { claude: isClaude(model), loaded: loadedTools, messages: session.messages }), ...serverToolsFor(researchDepth())],
      messages: session.messages.map(({ raw, ...m }) => m), // raw: another provider's own steps, not for Claude
      output_config: { effort },
      thinking: { type: "adaptive", display: "summarized" }, // a readable summary of its reasoning
      cache_control: { type: "ephemeral" },
    };
    if (extrasOn) {
      // Long chats are summarised automatically instead of hitting the context limit;
      // if a model declines a request, it falls back to another model automatically.
      body.betas = ["compact-2026-01-12"];
      body.context_management = { edits: [{ type: "compact_20260112" }] };
      if (model !== "claude-haiku-5-5") { body.betas.push("server-side-fallback-2026-07-01"); body.fallbacks = "default"; }
    }
    if (fast) { body.betas = [...(body.betas || []), "fast-mode-2026-02-01"]; body.speed = "fast"; }
    return body;
  }

  async function handleTool(t, via = null) {
    if (abort.signal.aborted || via?.signal.aborted) return { text: "Stopped by the user.", isError: true };
    if (typeof t.input !== "object" || t.input === null) return { text: "Invalid tool input. Try again.", isError: true };
    // Missing required inputs get a clear answer (other models slip up here more than Claude).
    const def = [...TOOLS, ...STUDIO_TOOLS, ...mcp.defs, FIND_TOOLS].find((d) => d.name === t.name);
    const missing = (def?.input_schema?.required || []).filter((k) => t.input[k] === undefined || t.input[k] === null);
    if (missing.length) return { text: `Missing required input: ${missing.join(", ")}. The ${t.name} tool takes: ${Object.keys(def.input_schema.properties || {}).join(", ")}. Try again with all required inputs.`, isError: true };
    // Permission rules from settings.json: deny always wins, "ask" asks even in Auto-edit,
    // "allow" skips the question.
    const rule = decide(rules, t.name, t.input, workDir);
    if (rule?.decision === "deny") return { text: `Blocked by the permission rule "${rule.rule}". Don't try to get around it; tell the user if you need it.`, isError: true };
    if (rule?.decision !== "allow" && !(await permitted(t.name, t.input, rule?.decision === "ask", via?.label))) return { text: "The user declined this action. Ask them what to do instead.", isError: true };
    if (rules.hooks.PreToolUse) {
      const h = await runHooks(rules, "PreToolUse", { session_id: chatId, tool_name: t.name, tool_input: t.input }, { workDir, toolName: t.name });
      if (h.block) return { text: "A hook blocked this step: " + h.reason, isError: true };
    }
    const out = await runToolInner(t, via);
    // Connector, browser and artifact results don't go through the tool runner's scrub, so hide
    // any saved secret value here too, before the AI or the screen sees it.
    out.text = scrub(out.text);
    if (Array.isArray(out.content)) out.content = out.content.map((c) => c.type === "text" ? { ...c, text: scrub(c.text) } : c);
    if (rules.hooks.PostToolUse && !abort.signal.aborted) {
      const h = await runHooks(rules, "PostToolUse", { session_id: chatId, tool_name: t.name, tool_input: t.input, tool_response: String(out.text || "").slice(0, 20000) }, { workDir, toolName: t.name });
      const note = h.reason || h.context;
      if (note) { out.text = String(out.text ?? "") + "\n\n(Hook) " + note; if (Array.isArray(out.content) && !out.content.some((c) => c.type === "tool_reference")) out.content = [...out.content, { type: "text", text: "(Hook) " + note }]; }
    }
    return out;
  }
  async function runToolInner(t, via = null) {
    if (mcp.has(t.name)) return mcp.call(t.name, t.input);
    if (t.name === "find_tools") return findTools(t.input, via);
    if (!via) { // the chat's own tools; helpers have none of these
    if (t.name === "delegate_task") return startHelper(t);
    if (STUDIO_NAMES.has(t.name)) return runStudioTool(t.name, t.input);
    if (t.name === "schedule_task" && req.body.unattended && ["create", "update"].includes(t.input.action)) return { text: "A scheduled task can't create or change scheduled tasks itself.", isError: true };
    if (t.name === "schedule_task") { try { return { text: scheduleTool(t.input, { cwd: scratch ? "" : workDir, model, effort }), isError: false }; } catch (e) { return { text: String(e.message || e), isError: true }; } }
    if (t.name === "notify") { notify(String(t.input.title || "Shivo Labs AI").slice(0, 100), String(t.input.body || "").slice(0, 300), { chatId }); return { text: "Notification sent.", isError: false }; }
    if (t.name === "ask_user") return { text: "The user answered: " + (await askUser(t.input)), isError: false };
    if (t.name === "use_skill") {
      const s = skills.find((x) => x.name.toLowerCase() === String(t.input.name || "").toLowerCase());
      return s
        ? { text: `Skill "${s.name}" (its folder, for any files it mentions: ${s.dir})\n\n${readFileSync(s.file, "utf8")}`, isError: false }
        : { text: `No skill called "${t.input.name}". Available: ${skills.map((x) => x.name).join(", ") || "none"}`, isError: true };
    }
    }
    // For file changes, remember the file before so the app can show a diff.
    let target = null, before = null;
    if ((t.name === "write_file" || t.name === "edit_file" || t.name === "notebook_edit") && t.input.path) {
      target = resolve(workDir, String(t.input.path));
      if (!isAllowed(target) && !(await askAccess(dirname(target))))
        return { text: `The user didn't allow access to ${dirname(target)}. Save somewhere inside the linked folders, or ask them.`, isError: true };
      try { before = existsSync(target) && statSync(target).isFile() ? readFileSync(target, "utf8") : ""; } catch { before = ""; }
    }
    if (t.name === "run_command" && !(await checkCommand(t.input.command)))
      return { text: "The user declined: this command would change files outside the linked folders. Ask them first, or work inside the linked folders.", isError: true };
    if (via) via.activeId = t.id; else activeToolId = t.id;
    const out = await (via ? via.runTool : runTool)(t.name, t.input, via ? via.signal : abort.signal);
    if (target && !out.isError) {
      try { out.diff = lineDiff(before, readFileSync(target, "utf8")); out.path = target; } catch {}
    }
    return out;
  }

  // find_tools: load connector tools on demand. Claude gets them through tool references (only those
  // blocks may be in the result); other models get them in the tool list from the next request on.
  function findTools(input, via = null) {
    const pool = via ? mcp.defs.filter((d) => via.allowed.has(d.name)) : mcp.defs;
    if (!pool.length) return { text: "No connector is connected right now, so there are no tools to load.", isError: true };
    const limit = Math.min(25, Math.max(1, Math.round(Number(input.limit)) || 5));
    const names = searchTools(pool, input.query, limit).map((d) => d.name);
    if (!names.length) return { text: `No connector tool matched "${input.query}". Try other words, or select:<name> with a name from find_tools' list.`, isError: false };
    if (isClaude(via ? via.model : model)) return { text: "Loaded: " + names.join(", "), content: names.map((n) => ({ type: "tool_reference", tool_name: n })), isError: false };
    const set = via ? via.loaded : loadedTools;
    for (const n of names) set.add(n);
    if (!via) session.loadedTools = [...loadedTools];
    return { text: `Loaded: ${names.join(", ")}. You can call them now.`, isError: false };
  }

  // Close any tool calls left without an answer, so the next API request is valid.
  function closeOpenTools(reason) {
    const last = session.messages.at(-1);
    if (last?.role !== "assistant") return;
    const open = last.content.filter((b) => b.type === "tool_use");
    if (open.length) session.messages.push({ role: "user", content: open.map((t) => ({ type: "tool_result", tool_use_id: t.id, content: reason, is_error: true })) });
  }

  // Hand over anything the user typed while we were working. Returns true if there was something.
  function drainInbox() {
    const waiting = inbox.get(chatId) || [], notes = helperNotes.splice(0); // notes: reports from background helpers
    if (!waiting.length && !notes.length) return false;
    inbox.delete(chatId);
    const blocks = [...notes.map((text) => ({ type: "text", text })), ...waiting.map((t) => ({ type: "text", text: `(The user sent this while you were working: ${t})` }))];
    const last = session.messages.at(-1);
    if (last?.role === "user") last.content.push(...blocks); // after any tool results, as the API requires
    else session.messages.push({ role: "user", content: blocks });
    saveSession(chatId, session);
    if (waiting.length) send({ type: "interjected", count: waiting.length });
    return true;
  }

  // Team mode, step 1: the planner reads the project and writes a plan the worker follows.
  let plan = "", reviews = 0, unresolved = false;
  const teamStep = (name, input, text) => { const id = "team_" + crypto.randomUUID().slice(0, 8); send({ type: "tool", id, name, input }); send({ type: "tool_result", id, isError: false, text }); };
  try {
    if (team) {
      send({ type: "status", text: `Planning with ${team.planner.replace("claude-", "")}…` });
      plan = await Promise.race([stopped, miniAgent(team.planner, `You are the planner in a team of AI models working on Windows. Working folder: ${workDir}. Another model (${model}) will do the work, following your plan exactly, and a reviewer will check it. Investigate only as much as needed with your read-only tools, then reply with a short numbered plan: which files to change and how, what to check at the end (tests, the browser, the console), and any traps. No code beyond small snippets.`,
        `The user's request:\n${String(prompt || "")}`, "medium")]);
      teamStep("team_plan", { model: team.planner }, plan);
      session.messages.at(-1).content.push({ type: "text", text: `(Plan from the planner. Follow it, and say if you have to deviate:)\n${plan}` });
      saveSession(chatId, session);
    }
    for (let turn = 0; turn < 80; turn++) {
      if (abort.signal.aborted) throw new Error("aborted");
      drainInbox();
      let message;
      for (let attempt = 0; ; attempt++) {
        try {
          if (!isClaude(model)) {
            const o = splitModel(model), body = requestBody();
            const args = { provider: o.provider, key: providerKey(o.provider), model: o.model, system: body.system[0].text, messages: trimHistory(session.messages),
              tools: body.tools.filter((t) => t.input_schema), maxTokens: 16000, effort, signal: abort.signal,
              onThought: (t) => { if (t.trim()) send({ type: "thinking", text: t }); },
              onText: (d) => send({ type: "delta", text: d }), onTextDone: () => send({ type: "text_done" }) };
            message = o.provider === "gemini" ? await geminiWithFallback(geminiLimits, geminiChain(o.model), args, geminiNotices) : await chatStep(args);
            if (message.usedModel && `gemini:${message.usedModel}` !== usedModel) { usedModel = `gemini:${message.usedModel}`; send({ type: "model_used", model: usedModel }); }
            break;
          }
          const stream = client.beta.messages.stream(requestBody(), { signal: abort.signal });
          stream.on("text", (delta) => send({ type: "delta", text: delta }));
          stream.on("contentBlock", (block) => {
            if (block.type === "text") send({ type: "text_done" });
            else if (block.type === "thinking") { if (block.thinking?.trim()) send({ type: "thinking", text: block.thinking }); }
            else if (block.type === "server_tool_use") send({ type: "tool", id: block.id, name: block.name, input: block.input });
            else if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
              const c = block.content;
              const text = Array.isArray(c) ? c.map((r) => `${r.title || ""}  ${r.url || ""}`).join("\n")
                : c?.error_code ? "Error: " + c.error_code : c?.url || "Fetched";
              send({ type: "tool_result", id: block.tool_use_id, isError: Boolean(c?.error_code), text });
            }
          });
          message = await stream.finalMessage();
          if (extrasDropped) useExtras = false;
          break;
        } catch (e) {
          if (abort.signal.aborted) throw e;
          // Over the context limit (usually one huge tool result): shrink old results and retry.
          if (e instanceof Anthropic.BadRequestError && /prompt is too long/i.test(e.message) && attempt < 3) {
            if (shrinkHistory([20000, 4000, 1000][attempt])) {
              saveSession(chatId, session);
              send({ type: "status", text: "This chat got too long; shortening old step results and trying again…" });
              continue;
            }
          }
          // Retry once without the optional features if the request shape was rejected.
          if (e.provider) throw e; // other providers: the message already says what went wrong
          // (Not for used-up credits: that has nothing to do with the request's shape.)
          if (e instanceof Anthropic.BadRequestError && extrasOn && attempt === 0 && !/credit balance/i.test(e.message)) { extrasOn = false; extrasDropped = true; continue; }
          // A tool input that couldn't be parsed: ask again (a couple of times).
          if (!(e instanceof Anthropic.APIError) && attempt < 2) continue;
          throw e;
        }
      }

      steps++;
      const cost = costOf(message.model || model, message.usage);
      totalCost += cost;
      for (const k of Object.keys(totals)) totals[k] += message.usage?.[k] || 0;
      const u = message.usage || {};
      contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      addUsage(cost, message.usage, model);
      send({ type: "usage" }); // the credits meter updates after every step, not just at the end

      if (message.stop_reason === "refusal") {
        send({ type: "error", text: "Claude declined this request. Try rephrasing it." });
        break;
      }

      // Keep the full content (including thinking and compaction blocks) unchanged.
      session.messages.push({ role: "assistant", content: message.content, ...(message.raw ? { raw: message.raw } : {}) });
      saveSession(chatId, session);

      if (message.stop_reason === "pause_turn") continue;
      const toolUses = message.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) {
        if (drainInbox()) continue; // a late message keeps it going
        if (bgHelpers.size) { await waitForHelpers(); if (drainInbox()) continue; }
        // Sometimes the model stops right after its last tool step without writing anything, or its
        // answer is cut off by the length limit. Ask once for the closing summary so the user gets a report.
        const said = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (wrapUps < 1 && steps > 1 && (!said || message.stop_reason === "max_tokens")) {
          wrapUps++;
          session.messages.push({ role: "user", content: [{ type: "text", text: said ? "(Your reply was cut off. Continue from where you stopped, briefly.)" : "(You stopped without a final message. Briefly summarise for the user what you did, what changed, and anything left to do.)" }] });
          saveSession(chatId, session);
          continue;
        }
        // Team mode, step 3: the checker reviews the work (at most 2 rounds of fixes).
        if (team && reviews < 3 && !(reviews >= 1 && !unresolved)) {
          reviews++;
          send({ type: "status", text: `Checking the work with ${team.checker.replace("claude-", "")}…` });
          const finalText = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
          const changed = [...snapshot.keys()];
          const verdict = await Promise.race([stopped, miniAgent(team.checker, `You are the reviewer in a team of AI models on Windows. Working folder: ${workDir}. Check the worker's result against the request and the plan: read the changed files, look for bugs, missing parts and broken code. Be strict but practical. Start your reply with exactly APPROVED or CHANGES NEEDED, then (if changes are needed) a short numbered list of concrete fixes.`,
            `Request:\n${String(prompt || "")}\n\nPlan:\n${plan || "(none)"}\n\nFiles the worker changed:\n${changed.join("\n") || "(none)"}\n\nThe worker's final message:\n${finalText}`, "medium")]);
          teamStep("team_review", { model: team.checker, round: reviews }, verdict);
          unresolved = /^\W*CHANGES NEEDED/i.test(verdict);
          if (unresolved && reviews >= 2) send({ type: "error", text: "The reviewer still found problems after 2 rounds of fixes. Read its notes above, then reply with what to do, or switch off Team mode and let Claude do it." });
          if (unresolved && reviews < 2) {
            session.messages.push({ role: "user", content: [{ type: "text", text: `(The reviewer found problems. Fix them, then summarise what you changed:)\n${verdict}` }] });
            saveSession(chatId, session);
            continue;
          }
        }
        // Stop hooks can send it back to work (e.g. "tests are failing"), at most 3 times.
        if (rules.hooks.Stop && stopHooks < 3) {
          const h = await runHooks(rules, "Stop", { session_id: chatId, stop_hook_active: stopHooks > 0 }, { workDir });
          if (h.block) { stopHooks++; session.messages.push({ role: "user", content: [{ type: "text", text: "(A Stop hook says you're not finished) " + h.reason }] }); send({ type: "status", text: "A hook asked for more work…" }); continue; }
        }
        break;
      }
      if (message.stop_reason === "max_tokens") {
        session.messages.push({ role: "user", content: toolUses.map((t) => ({ type: "tool_result", tool_use_id: t.id, is_error: true, content: "Your output was cut off. Split the work into smaller pieces." })) });
        continue;
      }

      async function runOne(t) {
        send({ type: "tool", id: t.id, name: t.name, input: t.input });
        let out;
        // Any unexpected failure becomes a normal error result, so every tool call always gets
        // an answer and the conversation can't be left broken.
        try { out = await Promise.race([handleTool(t), stopped]); }
        catch (e) { out = { text: abort.signal.aborted ? "Stopped by the user." : "This step failed: " + String(e?.message || e), isError: true }; }
        finally { if (activeToolId === t.id) activeToolId = null; }
        out.text = capText(out.text);
        if (Array.isArray(out.content)) { const n = out.content.filter((c) => c.type === "text").length || 1; out.content = out.content.map((c) => c.type === "text" ? { type: "text", text: capText(c.text, Math.floor(RESULT_CAP / n)) } : c); }
        // Browser results carry a screenshot: the AI sees it, the app shows it in the step.
        const image = out.content?.find((b) => b.type === "image");
        send({ type: "tool_result", id: t.id, isError: out.isError, pending: out.pending || undefined, text: out.text.slice(0, 4000), image: image ? `data:${image.source.media_type};base64,${image.source.data}` : undefined, diff: out.diff, path: out.path });
        return { type: "tool_result", tool_use_id: t.id, content: out.content || out.text, is_error: out.isError || undefined };
      }
      // Steps that only look (read, search, fetch, helpers) and sit next to each other run at the
      // same time; anything that changes something, asks the user or drives the browser runs alone,
      // in order. Results go back in the order the AI asked for them.
      const results = [];
      for (let i = 0; i < toolUses.length;) {
        let j = i;
        if (PARALLEL_TOOLS.has(toolUses[i].name)) while (j + 1 < toolUses.length && PARALLEL_TOOLS.has(toolUses[j + 1].name)) j++;
        results.push(...await Promise.all(toolUses.slice(i, j + 1).map(runOne)));
        i = j + 1;
      }
      session.messages.push({ role: "user", content: results });
      saveSession(chatId, session);
    }
    send(resultEvent());
  } catch (e) {
    if (abort.signal.aborted) {
      closeOpenTools("Stopped by the user.");
      saveSession(chatId, session);
      send({ type: "stopped" });
    } else {
      closeOpenTools("This step was interrupted by an error.");
      // Drop the unanswered message so the user can simply try again.
      if (session.messages.at(-1)?.role === "user" && session.messages.length - 1 === session.prompts.at(-1)) {
        session.messages.pop(); session.prompts.pop();
        send({ type: "dropped" }); // the app marks that message as not sent
      }
      saveSession(chatId, session);
      send({ type: "error", text: friendlyError(e) });
    }
    send(resultEvent());
  } finally {
    // Background helpers end with the reply.
    for (const h of bgHelpers.values()) send({ type: "helper_done", id: h.id, isError: true, text: "Stopped before it finished." });
    helperStop.abort();
    running.delete(chatId);
    // A message typed in the final moment wasn't read: give it back so it isn't lost.
    const late = inbox.get(chatId);
    // afterStop: the user stopped it with a follow-up waiting, so the app sends that follow-up next.
    if (late?.length) send({ type: "unsent", texts: late, afterStop: abort.signal.aborted });
    inbox.delete(chatId);
    if (browser) keepBrowser(chatId, browser);
    finish();
  }
});

// Start a turn in a chat by itself (a watched background process needs attention). Waits until the chat is idle.
async function autoTurn(chatId, opts, text, tries = 0) {
  if (running.has(chatId)) { if (tries < 1800) setTimeout(() => autoTurn(chatId, opts, text, tries + 1), 2000); return; }
  try {
    const r = await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-fabra-token": TOKEN },
      body: JSON.stringify({ chatId, prompt: text, cwd: opts.cwd || "", extraDirs: opts.extraDirs || [], model: opts.model, effort: opts.effort, mode: opts.mode, fast: opts.fast, sessionId: chatId, auto: true }),
    });
    await r.text();
  } catch {}
}

function friendlyError(e) {
  if (e?.provider) return String(e.message);
  if (e instanceof Anthropic.AuthenticationError) return "The API key isn't valid. Open Settings and add a fresh key.";
  if (e instanceof Anthropic.PermissionDeniedError) return "This key isn't allowed to do that. Check the key's organization on platform.claude.com.";
  if (e instanceof Anthropic.RateLimitError) return "Too many requests right now. Wait a minute and try again.";
  if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) return "Your API credits are used up. Add credits at platform.claude.com → Billing.";
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection.";
  if (e instanceof Anthropic.InternalServerError) return "Anthropic's servers had a problem. Try again in a moment.";
  if (e instanceof Anthropic.APIError) return `API error ${e.status}: ${e.message}`;
  return String(e?.message || e);
}

// ---------- Scheduled tasks
// Each task is a prompt that runs on a schedule while the app is open, through the normal
// chat engine (so it can use every tool). Results are kept as runs and announced as notifications.
const schedFile = join(dataDir, "schedules.json");
const loadScheds = () => { try { return JSON.parse(readFileSync(schedFile, "utf8")); } catch { return []; } };
const saveScheds = (s) => writeFileSync(schedFile, JSON.stringify(s, null, 2));
const notices = []; // { id, at, title, body, chatId? }
const notify = (title, body, extra = {}) => { notices.push({ id: crypto.randomUUID(), at: Date.now(), title, body, ...extra }); if (notices.length > 100) notices.shift(); };

function nextRun(t, from = Date.now()) {
  if (t.when?.type === "once") return t.ran ? null : Number(t.when.at) || null;
  if (t.when?.type === "interval") return (t.lastRun || from) + Math.max(5, Number(t.when.minutes) || 60) * 60000;
  // daily at HH:MM on chosen weekdays (0 = Sunday)
  const [h, m] = String(t.when?.time || "09:00").split(":").map(Number);
  const days = Array.isArray(t.when?.days) && t.when.days.length ? t.when.days : [0, 1, 2, 3, 4, 5, 6];
  const d = new Date(from); d.setSeconds(0, 0);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d); c.setDate(d.getDate() + i); c.setHours(h, m, 0, 0);
    if (c.getTime() > from && days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

async function runSchedule(t) {
  const chatId = `sched-${t.id}-${Date.now()}`;
  const run = { chatId, at: Date.now(), status: "running", text: "", tools: [], cost: 0 };
  const all = loadScheds(); const cur = all.find((x) => x.id === t.id); if (!cur) return;
  cur.runs = [run, ...(cur.runs || [])].slice(0, 20); cur.lastRun = run.at; saveScheds(all);
  try {
    const r = await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-fabra-token": TOKEN },
      body: JSON.stringify({ chatId, prompt: t.prompt, cwd: t.cwd || "", model: t.model, effort: t.effort || "medium", mode: "auto", unattended: true }),
    });
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "", err = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) {
        if (!p.startsWith("data: ")) continue;
        const ev = JSON.parse(p.slice(6));
        if (ev.type === "delta") run.text += ev.text;
        else if (ev.type === "text_done") run.text += "\n\n";
        else if (ev.type === "tool") run.tools.push(`${ev.name}: ${JSON.stringify(ev.input).slice(0, 120)}`);
        else if (ev.type === "result") run.cost = ev.cost || 0;
        else if (ev.type === "error") err = ev.text;
      }
    }
    run.status = err ? "failed" : "done"; if (err) run.text += `\n\nError: ${err}`;
  } catch (e) { run.status = "failed"; run.text += "\n\nError: " + (e.message || e); }
  run.text = run.text.trim().slice(0, 20000);
  const after = loadScheds(); const c2 = after.find((x) => x.id === t.id);
  if (c2) { c2.runs = (c2.runs || []).map((x) => (x.chatId === chatId ? run : x)); if (c2.when?.type === "once") { c2.ran = true; c2.enabled = false; } saveScheds(after); }
  notify(`${t.name}: ${run.status === "done" ? "finished" : "failed"}`, run.text.replace(/\s+/g, " ").slice(0, 160), { scheduleId: t.id, chatId });
}

const runningScheds = new Set();
setInterval(() => {
  for (const t of loadScheds()) {
    if (!t.enabled || runningScheds.has(t.id)) continue;
    const due = nextRun(t, t.lastRun || t.created || Date.now() - 60000);
    if (due && due <= Date.now()) {
      runningScheds.add(t.id);
      runSchedule(t).finally(() => runningScheds.delete(t.id));
    }
  }
}, 30000);

app.get("/api/schedules", (_req, res) => res.json(loadScheds().map((t) => ({ ...t, next: t.enabled ? nextRun(t, t.lastRun || Date.now()) : null, running: runningScheds.has(t.id) }))));
// Save a task from the Scheduled screen or from the AI (schedule_task). Returns the task, or { error }.
function saveSchedule(b) {
  const all = loadScheds();
  if (!String(b.name || "").trim() || !String(b.prompt || "").trim()) return { error: "Give the task a name and say what it should do." };
  const w = b.when || {};
  const when = w.type === "interval" ? { type: "interval", minutes: Math.max(5, Number(w.minutes) || 60) }
    : w.type === "once" ? { type: "once", at: Number(new Date(w.at)) }
    : { type: "daily", time: /^\d{1,2}:\d{2}$/.test(w.time) ? w.time : "09:00", days: (w.days || []).map(Number).filter((d) => d >= 0 && d <= 6) };
  if (when.type === "once" && !(when.at > Date.now())) return { error: "A one-time task needs a time in the future (local date and time, e.g. 2026-10-21T09:00)." };
  const t = {
    id: b.id || crypto.randomUUID().slice(0, 8), name: String(b.name).slice(0, 80), prompt: String(b.prompt),
    cwd: b.cwd || "", model: MODELS.includes(b.model) ? b.model : "claude-sonnet-5-5", effort: EFFORTS.includes(b.effort) ? b.effort : "medium",
    when, enabled: b.enabled !== false, created: Date.now(),
  };
  const i = all.findIndex((x) => x.id === t.id);
  // Keep history and last run when editing; a changed schedule starts counting from now.
  if (i >= 0) { t.runs = all[i].runs; t.created = all[i].created; t.lastRun = Date.now(); all[i] = t; } else { t.lastRun = Date.now(); all.push(t); }
  saveScheds(all);
  return t;
}
app.post("/api/schedules", (req, res) => {
  const t = saveSchedule(req.body);
  if (t.error) return res.status(400).json(t);
  res.json(t);
});
// The AI managing scheduled tasks itself (schedule_task tool).
function scheduleTool(input, { cwd, model, effort }) {
  const when = (t) => t.when?.type === "interval" ? `every ${t.when.minutes} min` : t.when?.type === "once" ? `once at ${new Date(t.when.at).toLocaleString("en-GB")}` : `daily at ${t.when?.time}${t.when?.days?.length && t.when.days.length < 7 ? " on days " + t.when.days.join(",") : ""}`;
  const line = (t) => `- ${t.id}: ${t.name} (${when(t)}${t.enabled ? "" : ", off"}${t.cwd ? ", in " + t.cwd : ""})`;
  const a = String(input.action || "list");
  const find = () => { const t = loadScheds().find((x) => x.id === input.id); if (!t) throw new Error(`No task ${input.id}. Use action list to see the ids.`); return t; };
  if (a === "list") { const all = loadScheds(); return all.length ? "Scheduled tasks (they run while the app is open):\n" + all.map(line).join("\n") : "No scheduled tasks."; }
  if (a === "delete") { const t = find(); saveScheds(loadScheds().filter((x) => x.id !== t.id)); return `Deleted "${t.name}".`; }
  if (a === "run") {
    const t = find(); if (runningScheds.has(t.id)) return "It's already running.";
    runningScheds.add(t.id); runSchedule(t).finally(() => runningScheds.delete(t.id));
    return `Started "${t.name}" now; its result arrives as a notification.`;
  }
  if (a !== "create" && a !== "update") throw new Error("action is create, update, list, delete or run.");
  const old = a === "update" ? find() : null;
  const given = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && v !== null && k !== "action"));
  const t = saveSchedule({ ...(old || { cwd, model, effort }), ...given });
  if (t.error) throw new Error(t.error);
  return `${a === "create" ? "Created" : "Updated"} the scheduled task:\n${line(t)}\nIt runs by itself while Shivo Labs AI is open, and its result arrives as a notification (also under Scheduled).`;
}
app.delete("/api/schedules/:id", (req, res) => { saveScheds(loadScheds().filter((t) => t.id !== req.params.id)); res.json({ ok: true }); });
app.post("/api/schedules/:id/run", (req, res) => {
  const t = loadScheds().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Not found" });
  if (runningScheds.has(t.id)) return res.status(409).json({ error: "It's already running." });
  runningScheds.add(t.id); runSchedule(t).finally(() => runningScheds.delete(t.id));
  res.json({ ok: true });
});
app.get("/api/notifications", (req, res) => res.json(notices.filter((n) => n.at > Number(req.query.since || 0))));

// ---------- Updates
// A tested update is placed in ../updates (a full copy of the app plus version.json) by the Shivo Labs hub, which
// also asks for the install (hub/api/update.mjs; the page shows nothing about updates). Installing refuses while a chat
// or scheduled task is working, copies the files over, then starts the new version and quits. Chats, settings and
// usage live in dataDir, so nothing is lost.
const updatesDir = process.env.FABRA_UPDATES || join(here, "..", "updates");
const readVersion = (dir) => { try { return JSON.parse(readFileSync(join(dir, "version.json"), "utf8")); } catch { return { version: "0.0.0" }; } };
const newer = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
app.get("/api/update", (_req, res) => {
  const current = readVersion(here), next = readVersion(updatesDir);
  res.json({ current: current.version, available: newer(next.version, current.version) ? next : null, busy: running.size + runningScheds.size > 0 });
});

// Safe mode note: left by launcher.mjs when an update wouldn't start and the old version was put back.
app.get("/api/safe-mode", (_req, res) => {
  const f = join(dataDir, "safe-mode.json");
  try { const n = JSON.parse(readFileSync(f, "utf8")); rmSync(f, { force: true }); res.json(n); } catch { res.json(null); }
});

function copyTree(from, to) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) { mkdirSync(b, { recursive: true }); copyTree(a, b); }
    else writeFileSync(b, readFileSync(a));
  }
}

let server, contentServer;
// Stop everything this app started (dev servers, terminal commands, connector programs).
function cleanupChildren() {
  stopBackgroundProcesses();
  for (const c of userTerms.values()) { try { spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true }); } catch {} }
  closeUserTerms();
  connectors.closeAll();
  try { awake?.kill(); } catch {}
}
app.post("/api/update/install", (req, res) => {
  const next = readVersion(updatesDir);
  if (!newer(next.version, readVersion(here).version)) return res.status(400).json({ error: "No update available." });
  if (running.size || runningScheds.size) return res.status(409).json({ error: "A chat or scheduled task is still working. Try again when it's finished." });
  // Back up the current version first, so a failed update can be undone completely.
  const backup = join(dataDir, "update-backup");
  try {
    rmSync(backup, { recursive: true, force: true }); mkdirSync(backup, { recursive: true });
    copyTree(here, backup);
    const oldPkg = readFileSync(join(here, "package.json"), "utf8");
    copyTree(updatesDir, here);
    // New packages only when the update needs them, or when a listed package is missing (an earlier install failed).
    const deps = Object.keys(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies || {});
    if (readFileSync(join(here, "package.json"), "utf8") !== oldPkg || deps.some((d) => !existsSync(join(here, "node_modules", d, "package.json")))) {
      execSync("npm install --omit=dev --no-audit --no-fund", { cwd: here, stdio: "ignore", windowsHide: true, timeout: 300000 });
    }
  } catch (e) {
    try { copyTree(backup, here); } catch {} // put the old version back
    return res.status(500).json({ error: "The update couldn't be installed, so nothing was changed: " + String(e.message || e).slice(0, 200) });
  }
  // Tell launcher.mjs an update is being tried: if it crashes before starting, it goes back.
  try { writeFileSync(join(dataDir, "update-pending.json"), JSON.stringify({ dir: here, version: next.version, from: readVersion(backup).version })); } catch {}
  res.json({ ok: true, version: next.version });
  // Start the new version once this one has let go of its ports.
  setTimeout(() => {
    cleanupChildren();
    server.close(); contentServer?.close();
    const start = existsSync(join(here, "launcher.mjs")) ? "launcher.mjs" : "server.mjs";
    spawn(process.execPath, [join(here, start)], { cwd: here, env: process.env, detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(() => process.exit(0), 300);
  }, 300);
});

process.on("SIGINT", () => { cleanupChildren(); process.exit(0); });

// Retry briefly if a port is still held (e.g. the previous version is just quitting).
function listenOn(appToRun, port, label, attempt = 0) {
  const s = appToRun.listen(port, "127.0.0.1", () => console.log(`Shivo Labs AI ${readVersion(here).version} ${label} on port ${port}`));
  s.on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    if (attempt < 20) setTimeout(() => { const again = listenOn(appToRun, port, label, attempt + 1); if (appToRun === app) server = again; else contentServer = again; }, 500);
    else console.log(`Port ${port} is busy; Shivo Labs AI may already be running.`);
  });
  return s;
}
// Started properly: the update (if any) worked, so safe mode isn't needed any more.
setTimeout(() => { if (server?.listening) rmSync(join(dataDir, "update-pending.json"), { force: true }); }, 8000);

// The `fabra` terminal command: a small fabra.cmd in the data folder's bin, added to the
// user's PATH once (new terminals pick it up). Only for the real app, not test copies.
if (PORT === 4823 && !process.env.FABRA_DATA) {
  try {
    const bin = join(dataDir, "bin"); mkdirSync(bin, { recursive: true });
    const cmd = `@echo off\r\n"${process.execPath}" "${join(here, "fabra-cli.mjs")}" %*\r\n`;
    const f = join(bin, "fabra.cmd");
    if (!existsSync(f) || readFileSync(f, "utf8") !== cmd) writeFileSync(f, cmd);
    const ps = `$b='${bin.replace(/'/g, "''")}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not (("$p" -split ';') -contains $b)) { [Environment]::SetEnvironmentVariable('Path', (("$p".TrimEnd(';'), $b) -join ';').TrimStart(';'), 'User') }`;
    execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true }, () => {});
  } catch {}
}
server = listenOn(app, PORT, "is running");
  setTimeout(catchUpCloud, 3000); // cloud tasks that kept working while the app was closed
contentServer = listenOn(contentApp, CONTENT_PORT, "previews");
