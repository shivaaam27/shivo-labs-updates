// One AI across the PC's modules (UNIFY-PLAN.md phase 3): the hub is a connector (MCP, the standard Claude Code and
// Shivo Labs AI use) at http://localhost:4800/mcp, so the AI app can do things in Cloud, Chat, the TV, Beam and X Tools,
// like Search does on the phone (phone/www/engine/tools.js). Shivo Labs AI adds it by itself (ai/app/mcp.mjs); its own
// permission setting decides whether each step asks first.
// Each tool calls the hub's own API (the same checks as the pages: only modules this PC's pass has). Answers are short
// JSON text. Plain JSON over HTTP POST (MCP's Streamable HTTP without a stream), JSON-RPC 2.0.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { may } from "./id.mjs";

const LINK = join(process.env.APPDATA || homedir(), "Shivo Labs", "chat-link.json");   // the Chat page's sign-in on this PC
const CHAT_SERVER = "https://shivo-labs-chat.ishivamparmar.workers.dev";
const str = { type: "string" };
const T = (name, mod, description, properties = {}, required = []) => ({ name, mod, description, inputSchema: { type: "object", properties, required } });

const TOOLS = [
  T("pc_devices", null, "The user's Shivo Labs devices (this PC, other PCs, phones, TVs) with when each was last online."),
  T("cloud_search", "files", "Find files and folders in the user's Shivo Labs Cloud (their encrypted cloud storage) by name. Returns where each is and, when it is synced to this PC, its path here (readable with the file tools).", { query: str }, ["query"]),
  T("cloud_list", "files", "List a folder in Shivo Labs Cloud. folder: a path like \"Docs/Trip\"; empty for the top.", { folder: str }),
  T("cloud_add", "files", "Copy a file from this PC into Shivo Labs Cloud. file: its full path on this PC; folder: a Cloud folder path (empty for the top).", { file: str, folder: str }, ["file"]),
  T("cloud_share_link", "files", "Make a download link for a Cloud file or folder (a folder's link is a .zip of it as it is now). days: how long it works (default 7); password: optional.", { path: str, days: { type: "integer" }, password: str }, ["path"]),
  T("cloud_move", "files", "Move a Cloud file or folder into another folder (\"\" for the top).", { path: str, to: str }, ["path", "to"]),
  T("cloud_delete", "files", "Move a Cloud file or folder to the Shivo Labs Cloud Trash (kept 30 days).", { path: str }, ["path"]),
  T("chat_overview", "chat", "The user's team Chat (Shivo Labs Chat): chats and groups, newest first, with unread counts and the last message."),
  T("chat_read", "chat", "Read the latest messages of one team Chat conversation, by group name or person name.", { chat: str, count: { type: "integer" } }, ["chat"]),
  T("chat_search", "chat", "Search the team Chat messages for words.", { query: str }, ["query"]),
  T("chat_send", "chat", "Send a team Chat message to a group or a person (by name).", { to: str, text: str }, ["to", "text"]),
  T("tv_list", "tv", "The Android / Google TVs this PC knows on the home Wi-Fi, and whether each is on."),
  T("tv_remote", "tv", "Press a remote key on a TV: up, down, left, right, ok, back, home, menu, volup, voldown, mute, power, play, next, prev, ff, rew, input, settings, search. tv: its name or address (default: the only one).", { key: str, tv: str }, ["key"]),
  T("tv_type", "tv", "Type text on a TV (into a search box that is open on it).", { text: str, tv: str }, ["text"]),
  T("tv_apps", "tv", "The apps on a TV.", { tv: str }),
  T("tv_open_app", "tv", "Open an app on a TV, by its name (e.g. YouTube, Netflix).", { app: str, tv: str }, ["app"]),
  T("beam_status", "files", "Beam: the phones this PC sends to, files waiting to go to them, and the latest files received from them."),
  T("beam_send", "files", "Send a file from this PC to the user's phones with Beam (it appears in Shivo Labs on the phone). file: its full path on this PC.", { file: str }, ["file"]),
  T("xtools_status", "xtools", "X Tools (installs iPhone apps from this PC with a free Apple ID): the apps, their days left before they must be renewed (7-day limit), and whether an iPhone is plugged in or nearby."),
  T("xtools_renew", "xtools", "Renew the X Tools apps on the plugged-in or nearby iPhone for another 7 days (one app by its name, or all). Runs in the background; a Windows notification says when it is done.", { app: str }),
];

// ---------- the hub's own API
let base = "http://localhost:4800";
async function hub(path, body, raw) {
  const r = await fetch(base + path, body === undefined && !raw ? {} : { method: "POST", headers: { "x-hub": "1", ...(raw ? {} : { "content-type": "application/json" }) }, body: raw || JSON.stringify(body), duplex: raw ? "half" : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `The hub answered ${r.status}`);
  return j;
}
const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : undefined);

// ---------- Cloud paths ("Docs/Trip/a.pdf") to items
async function find(path, want) {
  const parts = String(path || "").split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  let parent = "", it = { id: "", kind: "folder", name: "Your files" };
  for (const [i, p] of parts.entries()) {
    const items = (await hub("/api/files/list?parent=" + encodeURIComponent(parent))).items || [];
    it = items.find((x) => x.name === p) || items.find((x) => x.name.toLowerCase() === p.toLowerCase());
    if (!it) throw new Error(`No "${p}" in ${parts.slice(0, i).join("/") || "the top of Shivo Labs Cloud"}. Use cloud_search to find it.`);
    parent = it.id;
  }
  if (want && it.kind !== want) throw new Error(`"${path}" is a ${it.kind}, not a ${want}.`);
  return it;
}
const short = (x) => ({ name: x.name, kind: x.kind, size: x.kind === "file" ? x.size : undefined, changed: when(x.mtime), in: x.where });

// ---------- Chat, with the sign-in the Chat page made on this PC (signing in again here would sign that page out)
const chatCfg = () => { try { return JSON.parse(readFileSync(LINK, "utf8")); } catch { return {}; } };
async function chatApi(path, body) {
  const c = chatCfg();
  if (!c.token) throw new Error("Open Chat in Shivo Labs on this PC once, then try again.");
  const r = await fetch((c.server || CHAT_SERVER).replace(/\/$/, "") + "/api/" + path, { method: body ? "POST" : "GET",
    headers: { authorization: "Bearer " + c.token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "Chat's sign-in on this PC has ended. Open Chat in Shivo Labs once, then try again." : j.error || `Chat answered ${r.status}`);
  return j;
}
async function chats() {
  const s = await chatApi("sync"), name = (id) => s.users.find((u) => u.id === id)?.name || "Someone";
  const other = (c) => (c.members || []).find((m) => m.user !== s.me)?.user;
  return { name, people: s.users.filter((u) => u.id !== s.me && !u.removed), list: s.chats.map((c) => ({ id: c.id, kind: c.kind, unread: c.unread || 0, last: c.last,
    title: c.kind !== "dm" ? c.name || "Chat" : other(c) ? name(other(c)) : "Notes to self" })) };
}
const pick = (list, want) => { const w = String(want || "").toLowerCase().trim(); return list.find((c) => c.title.toLowerCase() === w) || list.find((c) => c.title.toLowerCase().includes(w)); };
const said = (name, m) => ({ from: name(m.user), at: when(m.ts), text: m.text || (m.file ? `[${m.file.voice ? "voice note" : "file: " + m.file.name}]` : "") });

// ---------- TVs
async function tvPick(want) {
  const tvs = (await hub("/api/tv/status")).tvs || [];
  if (!tvs.length) throw new Error("No TV is set up on this PC yet (Shivo Labs › TV).");
  const w = String(want || "").toLowerCase().trim();
  const t = w ? tvs.find((x) => x.ip === w || String(x.name || "").toLowerCase().includes(w)) : tvs.length === 1 ? tvs[0] : tvs.find((x) => x.online) || tvs[0];
  if (!t) throw new Error(`No TV called "${want}". TVs: ${tvs.map((x) => x.name || x.ip).join(", ")}`);
  return t;
}

async function run(name, i = {}) {
  switch (name) {
    case "pc_devices": {
      const { companyDevices } = await import("./id.mjs");
      const list = await companyDevices().catch((e) => { throw new Error("Couldn't reach Shivo Labs: " + e.message); });
      return { devices: list.map((d) => ({ name: d.name, kind: d.kind, lastOnline: when(d.lastSeen), online: !!d.lastSeen && Date.now() - d.lastSeen < 20 * 60e3 })) };
    }
    case "cloud_search": {
      const { cloudDir } = await import("./files-sync.mjs");
      const items = (await hub("/api/files/search?q=" + encodeURIComponent(i.query || ""))).items || [];
      return { count: items.length, items: items.slice(0, 25).map((x) => {
        const local = join(cloudDir(), ...(x.where ? x.where.split(" › ") : []), x.name);
        return { ...short(x), pcPath: existsSync(local) ? local : undefined };
      }) };
    }
    case "cloud_list": {
      const f = await find(i.folder, "folder");
      return { folder: i.folder || "/", items: ((await hub("/api/files/list?parent=" + encodeURIComponent(f.id))).items || []).slice(0, 100).map(short) };
    }
    case "cloud_add": {
      const file = String(i.file || "");
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error("No file at " + file);
      const f = await find(i.folder, "folder");
      const r = await fetch(`${base}/api/files/upload?parent=${encodeURIComponent(f.id)}&name=${encodeURIComponent(basename(file))}`,
        { method: "POST", headers: { "x-hub": "1", "content-length": String(statSync(file).size) }, body: createReadStream(file), duplex: "half" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "The upload failed");
      return { added: j.name, folder: i.folder || "/" };
    }
    case "cloud_share_link": {
      const it = await find(i.path);
      const days = Number(i.days) > 0 ? Number(i.days) : 7;
      const j = await hub(it.kind === "folder" ? "/api/files/share-folder" : "/api/files/share", { id: it.id, days, password: i.password || undefined });
      return { link: j.link, of: it.kind === "folder" ? `${j.name} (the folder as it is now)` : it.name, days };
    }
    case "cloud_move": {
      const it = await find(i.path), to = await find(i.to, "folder");
      await hub("/api/files/move", { id: it.id, parent: to.id });
      return { moved: it.name, to: i.to || "/" };
    }
    case "cloud_delete": {
      const it = await find(i.path);
      await hub("/api/files/delete", { id: it.id });
      return { trashed: it.name };
    }
    case "chat_overview": {
      const { list, name: who } = await chats();
      return { chats: list.sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0)).slice(0, 15).map((c) => ({ chat: c.title, group: c.kind !== "dm", unread: c.unread, last: c.last ? said(who, c.last) : null })) };
    }
    case "chat_search": {
      const { list, name: who } = await chats();
      const r = await chatApi("search?q=" + encodeURIComponent(String(i.query || "")));
      return { messages: (r.messages || []).slice(0, 20).map((m) => ({ chat: list.find((c) => c.id === m.chat)?.title || "", ...said(who, m) })) };
    }
    case "chat_read": case "chat_send": {
      const { list, name: who, people } = await chats();
      const want = name === "chat_send" ? i.to : i.chat;
      let c = pick(list, want);
      // a person in the team with no direct chat yet: start one (the same as clicking their name in Chat)
      const w = String(want || "").toLowerCase().trim();
      const p = !c && w && (people.find((u) => u.name.toLowerCase() === w) || people.find((u) => u.name.toLowerCase().includes(w)));
      if (p && name === "chat_send") c = { id: (await chatApi("act", { type: "chat.dm", user: p.id })).chat, title: p.name };
      if (p && name === "chat_read") return { chat: p.name, messages: [] };
      if (!c) return { error: `No chat called "${want}"`, chats: list.map((x) => x.title).slice(0, 30) };
      if (name === "chat_read") {
        const r = await chatApi(`messages?chat=${encodeURIComponent(c.id)}&limit=${Math.max(1, Math.min(40, Number(i.count) || 15))}`);
        return { chat: c.title, messages: (r.messages || []).filter((m) => !m.deleted && m.kind !== "system").map((m) => said(who, m)) };
      }
      const text = String(i.text || "").trim().slice(0, 4000); if (!text) return { error: "Empty message" };
      await chatApi("act", { type: "send", chat: c.id, text, cid: "ai" + Date.now() });
      return { sent: text, to: c.title };
    }
    case "tv_list": return { tvs: ((await hub("/api/tv/status")).tvs || []).map((t) => ({ name: t.name || t.model || "TV", address: t.ip, on: t.online })) };
    case "tv_remote": {
      const t = await tvPick(i.tv), key = String(i.key || "").toLowerCase().replace(/[^a-z]/g, "");
      const j = await hub("/api/tv/key", { ip: t.ip, key });
      if (!j.ok) throw new Error(`"${i.key}" isn't a key the TV remote has, or ${t.name || "the TV"} didn't answer.`);
      return { pressed: key, tv: t.name || t.ip };
    }
    case "tv_type": { const t = await tvPick(i.tv); await hub("/api/tv/key", { ip: t.ip, text: String(i.text || "") }); return { typed: true, tv: t.name || t.ip }; }
    case "tv_apps": {
      const t = await tvPick(i.tv);
      return { tv: t.name || t.ip, apps: ((await hub("/api/tv/apps?ip=" + encodeURIComponent(t.ip))).apps || []).filter((a) => a.open && a.on).map((a) => a.label).slice(0, 120) };
    }
    case "tv_open_app": {
      const t = await tvPick(i.tv), w = String(i.app || "").toLowerCase().trim();
      const apps = (await hub("/api/tv/apps?ip=" + encodeURIComponent(t.ip))).apps || [];
      const apps2 = apps.filter((x) => x.on), label = (x) => String(x.label || "").toLowerCase();
      const a = apps2.find((x) => label(x) === w) || apps2.find((x) => label(x).includes(w)) || apps2.find((x) => x.pkg === i.app);
      if (!a) return { error: `No app called "${i.app}" on ${t.name || "the TV"}`, apps: apps2.map((x) => x.label).slice(0, 60) };
      const j = await hub("/api/tv/app", { ip: t.ip, pkg: a.pkg, do: "open" });
      if (j.ok === false) throw new Error(j.error || "The TV didn't open it");
      return { opened: a.label, tv: t.name || t.ip };
    }
    case "beam_status": {
      const s = await hub("/api/beam/status");
      return { phones: (s.devices || []).map((d) => ({ name: d.name, lastSeen: d.seen ? when(d.seen * 1000) : undefined })),
        waitingToSend: (s.waiting || []).map((f) => f.name), receivedLately: (s.received || []).map((f) => f.name) };
    }
    case "beam_send": {
      const file = String(i.file || "");
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error("No file at " + file);
      const r = await fetch(`${base}/api/beam/send?name=${encodeURIComponent(basename(file))}`, { method: "POST", headers: { "x-hub": "1" }, body: createReadStream(file), duplex: "half" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Beam couldn't take the file");
      return { sending: j.name || basename(file), note: "It is on the phone's list; it arrives when the phone opens Shivo Labs or Beam." };
    }
    case "xtools_status": {
      const s = await hub("/api/xtools/tray");
      return { plugged: s.device ? `${s.device.name}${s.device.untrusted ? " (locked or not trusted yet)" : ""}` : null, nearby: s.near.map((p) => p.name),
        apps: s.apps.map((a) => ({ name: a.name, daysLeft: a.daysLeft })), working: s.job?.label || (s.job ? "yes" : null) };
    }
    case "xtools_renew": {
      let bundleId;
      if (i.app) {
        const s = await hub("/api/xtools/tray"), w = String(i.app).toLowerCase();
        bundleId = s.apps.find((a) => a.name.toLowerCase() === w || a.name.toLowerCase().includes(w))?.bundleId;
        if (!bundleId) return { error: `No X Tools app called "${i.app}"`, apps: s.apps.map((a) => a.name) };
      }
      await hub("/api/xtools/tray/renew", bundleId ? { bundleId } : {});
      return { started: true, note: "Renewing in the background; a Windows notification says when it is done." };
    }
  }
  throw new Error("Unknown tool " + name);
}

// ---------- MCP over HTTP (JSON-RPC 2.0)
const INFO = "Shivo Labs on this PC: the user's Cloud files, team Chat, TVs, Beam (files to and from their phones) and X Tools (their iPhone apps).";
async function answer(msg) {
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result }), fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  if (msg.id === undefined) return null;   // a notification: nothing to answer
  switch (msg.method) {
    case "initialize": return ok({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "shivo-labs", version: "1.0.0" }, instructions: INFO });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS.filter((t) => !t.mod || may(t.mod)).map(({ mod, ...t }) => t) });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === msg.params?.name);
      if (!t || (t.mod && !may(t.mod))) return fail(-32602, "Unknown tool " + msg.params?.name);
      try { const out = await run(t.name, msg.params?.arguments || {}); return ok({ content: [{ type: "text", text: JSON.stringify(out) }], isError: !!out?.error }); }
      catch (e) { return ok({ content: [{ type: "text", text: String(e.message || e) }], isError: true }); }
    }
  }
  return fail(-32601, "Unknown method " + msg.method);
}
export async function mcpApi(req, res, path, port) {
  if (path === "/api/chat/link" && req.method === "POST") {   // the Chat page's sign-in, kept for chat_* (hub.js sends it)
    let s = ""; for await (const c of req) { s += c; if (s.length > 4000) break; }
    let b = {}; try { b = JSON.parse(s); } catch {}
    const now = chatCfg();
    if (String(b.token || "") !== (now.token || "") || String(b.server || "") !== (now.server || "")) {
      mkdirSync(dirname(LINK), { recursive: true });
      writeFileSync(LINK, JSON.stringify({ token: String(b.token || ""), server: /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(b.server || "") ? b.server : "" }));
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
    return true;
  }
  if (path !== "/mcp") return false;
  base = `http://localhost:${port}`;
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return true; }
  let s = ""; for await (const c of req) { s += c; if (s.length > 2e6) break; }
  let body; try { body = JSON.parse(s); } catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); return true; }
  const out = Array.isArray(body) ? (await Promise.all(body.map(answer))).filter(Boolean) : await answer(body);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); res.end(); return true; }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(out));
  return true;
}
