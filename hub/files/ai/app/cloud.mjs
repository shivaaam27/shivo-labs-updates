// Cloud tasks: Claude Managed Agents. The task runs in its own workspace on Anthropic's servers,
// so it keeps going when this PC sleeps or the app closes. Same service the phone app uses
// (phone/www/engine/agents.js); here it runs in the server with the user's own API key.
// The chat's cloud session id is kept in the chat's session file, so a chat can be continued,
// and files the agent puts in /mnt/session/outputs are downloaded into the chat's folder.
//
// Following a turn survives drops: the event stream is reopened and the session's event list is
// read again, skipping what was already shown (events have ids). If the app restarts while a task
// runs (session.cloudStatus "running"), the server picks it up again (followCloud) and the page
// shows it like any chat that kept working while the window was closed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { costOf } from "./agent.mjs";

const API = "https://api.anthropic.com";
const BETA = "managed-agents-2026-04-01"; // the Files API is generally available now: no beta header of its own
const H = (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": BETA, "content-type": "application/json" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(key, method, path, body, signal) {
  const r = await fetch(API + path, { method, headers: H(key), body: body ? JSON.stringify(body) : undefined, signal });
  if (!r.ok) { let m = r.statusText; try { const j = await r.json(); m = j.error?.message || m; } catch {} throw Object.assign(new Error(m), { status: r.status }); }
  return r.status === 204 ? {} : r.json();
}

const SYSTEM = `You are Shivo Labs AI, working on a task the user handed you from their PC, in your own cloud workspace.
- Work on your own. Ask a question only if something truly blocks you.
- Put anything the user should receive (web pages, documents, data, images, code) in /mnt/session/outputs. They are downloaded to the user's PC when you finish. Prefer self-contained files.
- Check your work before you say you are done (open files, run them, look for errors).
- Finish with a short plain-language summary: what you made, the choices you made, and the file names.`;

// Environment + agent ids are made once and reused (they're saved objects). They belong to the API key's
// organisation, so they're kept per key: switching to another key never reuses ids it can't see.
function cache(dataDir, key) {
  const f = join(dataDir, "cloud.json");
  const k = "key-" + createHash("sha256").update(key).digest("hex").slice(0, 16);
  const read = () => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };
  const write = (j) => writeFileSync(f, JSON.stringify(j, null, 2));
  return {
    get: (n) => read()[k]?.[n],
    set: (n, v) => { const j = read(); (j[k] ||= {})[n] = v; write(j); },
    clear: () => { const j = read(); delete j[k]; write(j); },
  };
}
async function ensure(key, dataDir, model) {
  const c = cache(dataDir, key);
  let env = c.get("env");
  if (!env) {
    env = (await call(key, "POST", "/v1/environments", { name: "shivo-labs-desktop", config: { type: "cloud", networking: { type: "limited", allow_package_managers: true, allow_mcp_servers: false } } })).id;
    c.set("env", env);
  }
  const ak = "agent." + model + ".v1";
  let agent = c.get(ak);
  if (!agent) {
    const a = await call(key, "POST", "/v1/agents", {
      name: "Shivo Labs desktop", model, system: SYSTEM,
      tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_allow" } }, configs: [{ name: "web_search", enabled: true }, { name: "web_fetch", enabled: true }] }],
    });
    agent = { id: a.id, version: a.version }; c.set(ak, agent);
  }
  return { env, agent, forget: c.clear };
}

async function* sse(res) {
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) { try { yield JSON.parse(data); } catch {} }
    }
  }
}

const textOf = (c) => (Array.isArray(c) ? c.map((x) => x.text || "").join("") : String(c || ""));
const toolName = { bash: "run_command", write: "write_file", edit: "edit_file", read: "read_file", glob: "find_files", grep: "search_files" };

// $ for a hosted session (cumulative). The session reports its own list cost (cents); if not, estimate:
// tokens at list price plus $0.08 per active hour.
const sessionCost = (model, u = {}) => (u.list_cost?.amount != null ? Number(u.list_cost.amount) / 100 : costOf(model, u) + (u.active_seconds || 0) * 0.08 / 3600);

// all events of a session, oldest first (the list is paged)
async function listEvents(key, id, signal) {
  const all = []; let page = null;
  for (let i = 0; i < 50; i++) {
    const r = await call(key, "GET", `/v1/sessions/${id}/events?limit=100${page ? `&page=${encodeURIComponent(page)}` : ""}`, null, signal);
    all.push(...(r.data || []));
    page = r.next_page; if (!page) break;
  }
  return all;
}

// Follow the current turn to its end: the live stream, plus the event list after any drop.
// Only the events after the latest user.message belong to this turn.
async function follow({ key, id, model, send, signal, session, save, addUsage }) {
  const seen = new Set(session.cloudSeen || []);
  let final = null, said = "", lastCost = session.cloudCost || 0, drops = 0;
  const handle = (e) => {
    if (!e || typeof e !== "object" || (e.id && seen.has(e.id))) return;
    if (e.id) seen.add(e.id);
    switch (e.type) {
      case "agent.message": { const t = textOf(e.content); if (t) { send({ type: "delta", text: (said ? "\n\n" : "") + t }); send({ type: "text_done" }); said += (said ? "\n\n" : "") + t; } break; }
      // the cloud tools call the file "file_path"; the page's file cards expect "path"
      case "agent.tool_use": if ((e.name === "write" || e.name === "edit") && String(e.input?.file_path || "").startsWith("/mnt/session/outputs/")) (session.cloudExpect ||= []).push(basename(e.input.file_path));
        send({ type: "tool", id: e.id, name: toolName[e.name] || e.name, input: e.input?.file_path && !e.input.path ? { ...e.input, path: e.input.file_path } : e.input }); break;
      case "agent.tool_result": send({ type: "tool_result", id: e.tool_use_id, isError: !!e.is_error, text: textOf(e.content).slice(0, 4000) }); break;
      case "session.usage": { const c = sessionCost(model, e.usage); if (c > lastCost) { addUsage(c - lastCost, {}, model); lastCost = c; session.cloudCost = c; send({ type: "usage" }); } break; }
      case "session.status_rescheduled": send({ type: "status", text: "The cloud workspace is restarting on Anthropic's side. It carries on by itself…" }); break;
      case "session.status_idle": { const t = e.stop_reason?.type; if (t !== "requires_action") final = t === "budget_reached" ? "budget" : "done"; break; }
      case "session.error": {
        // retrying: Anthropic is trying again, keep waiting. exhausted: this turn failed, the task can take a new message. terminal: the task has ended.
        const r = e.error?.retry_status?.type, kind = e.error?.type || "";
        const msg = kind === "billing_error" ? "Your Claude API credits ran out, so the cloud task paused. Add credits at platform.claude.com, then send a message."
          : kind === "model_overloaded_error" ? "Claude is overloaded right now." : (e.error?.message || "The cloud task hit an error.");
        if (r === "retrying") send({ type: "status", text: msg + " Retrying…" });
        else { final = r === "terminal" ? "ended" : "error"; send({ type: "error", text: msg }); }
        break;
      }
      case "session.status_terminated": final = "ended"; send({ type: "error", text: "The cloud task has ended (it was stopped or archived), so it can't continue. Start a new chat to run another task." }); break;
    }
  };
  const remember = () => { session.cloudSeen = [...seen].slice(-3000); save(); };

  while (!final && !signal.aborted) {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    signal.addEventListener("abort", stop, { once: true });
    try {
      // open the stream first, then catch up from the list, so nothing falls in between
      const stream = await fetch(`${API}/v1/sessions/${id}/events/stream`, { headers: { ...H(key), accept: "text/event-stream" }, signal: ctl.signal });
      if (!stream.ok) throw Object.assign(new Error("Couldn't follow the cloud task (" + stream.status + ")."), { status: stream.status });
      const evs = await listEvents(key, id, ctl.signal);
      let from = 0; for (let i = evs.length - 1; i >= 0; i--) if (evs[i].type === "user.message") { from = i + 1; break; }
      for (const e of evs.slice(from)) { handle(e); if (final) break; }
      remember();
      if (!final) for await (const e of sse(stream)) { if (e?.type === "user.message") continue; handle(e); if (e?.id && seen.size % 20 === 0) remember(); if (final) break; }
    } catch (err) {
      if (signal.aborted) break;
      if (err.status === 404) { final = "ended"; send({ type: "error", text: "This cloud task no longer exists on Anthropic's side. Start a new chat to run another task." }); break; }
    } finally { ctl.abort(); signal.removeEventListener("abort", stop); }
    if (!final && !signal.aborted) {
      // the connection dropped (sleep, network): reconnect and catch up
      if (++drops === 1) send({ type: "status", text: "Lost the connection to the cloud task. Reconnecting…" });
      await sleep(Math.min(30000, 2000 * drops));
    }
  }
  remember();
  return { final, said, cost: lastCost };
}

// bring the agent's output files down to this PC (all pages; files already downloaded are skipped)
async function download({ key, id, workDir, session, save, send }) {
  const got = new Set(session.cloudFiles || []);
  const listAll = async () => {
    const files = []; let after = null;
    for (let p = 0; p < 20; p++) {
      const r = await call(key, "GET", `/v1/files?scope_id=${encodeURIComponent(id)}&limit=100${after ? `&after_id=${after}` : ""}`);
      files.push(...(r.data || [])); if (!r.has_more || !r.last_id) break; after = r.last_id;
    }
    return files;
  };
  // New outputs are listed a few seconds after the task goes idle. Wait until every output file this turn
  // wrote is listed (names seen in its write/edit steps), or, if it made them another way, until the list
  // stops changing. At most about 20 s.
  const expected = new Set(session.cloudExpect || []);
  let fresh = [], prev = -1;
  for (let i = 0; i < 10; i++) {
    if (i) await sleep(2000);
    const files = await listAll();
    fresh = files.filter((f) => !got.has(f.id));
    const names = new Set(fresh.map((f) => basename(f.filename || f.name || "")));
    if (expected.size ? [...expected].every((n) => names.has(n)) : i > 0 && files.length === prev) break;
    prev = files.length;
  }
  session.cloudExpect = [];
  if (!fresh.length) return "";
  const dir = join(workDir, "cloud-output"); mkdirSync(dir, { recursive: true });
  const names = [];
  for (const f of fresh) {
    let name = basename(f.filename || f.name || f.id);
    // never overwrite a different file with the same name
    for (let n = 2; existsSync(join(dir, name)); n++) { const ext = extname(name); name = basename(f.filename || f.id, ext) + ` (${n})` + ext; }
    const r = await fetch(`${API}/v1/files/${f.id}/content`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (!r.ok) continue;
    writeFileSync(join(dir, name), Buffer.from(await r.arrayBuffer())); names.push(name); got.add(f.id);
  }
  session.cloudFiles = [...got]; save();
  if (!names.length) return "";
  const tid = "cloud_" + Date.now();
  send({ type: "tool", id: tid, name: "download_cloud_files", input: { folder: dir } });
  send({ type: "tool_result", id: tid, isError: false, text: "Saved to " + dir + ":\n" + names.join("\n") });
  return `\n\n(Files saved on this PC in ${dir}: ${names.join(", ")})`;
}

async function finishTurn({ key, id, workDir, session, save, send, r, capDollars }) {
  session.cloudStatus = r.final === "budget" ? "budget" : r.final === "ended" ? "ended" : "idle";
  save();
  if (r.final === "budget") send({ type: "error", text: `The task stopped at its $${capDollars} cap. Send a message and it continues with another $${capDollars}.` });
  let said = r.said;
  try { said += await download({ key, id, workDir, session, save, send }); }
  catch (e) { send({ type: "error", text: "Couldn't download the task's files: " + (e.message || e) }); }
  session.messages.push({ role: "assistant", content: [{ type: "text", text: said || "(The cloud task finished without a message.)" }] });
  save();
}

// One turn: send the message, then follow. Streams into the normal chat events: delta / text_done / tool / tool_result / status.
export async function cloudTurn({ key, dataDir, session, prompt, model, workDir, capDollars = 5, send, signal, save, addUsage }) {
  if (session.cloudStatus === "ended") { delete session.cloudId; session.cloudSeen = []; session.cloudFiles = []; session.cloudCost = 0; }
  let { env, agent, forget } = await ensure(key, dataDir, model);
  if (!session.cloudId) {
    send({ type: "status", text: "Starting a cloud workspace…" });
    const body = () => ({
      agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: env, title: prompt.slice(0, 80) || "Shivo Labs task",
      budget: { type: "limit", max_list_cost: { amount: String(Math.round(capDollars * 100)), currency: "USD" } },
      metadata: { app: "shivo-labs", from: "desktop" },
    });
    let s;
    try { s = await call(key, "POST", "/v1/sessions", body(), signal); }
    catch (e) {
      // saved workspace/agent ids gone (archived, other organisation): make new ones once
      if (e.status !== 404 && e.status !== 400) throw e;
      forget(); ({ env, agent } = await ensure(key, dataDir, model));
      s = await call(key, "POST", "/v1/sessions", body(), signal);
    }
    session.cloudId = s.id; session.cloudSeen = []; session.cloudFiles = []; session.cloudCost = 0; save();
  } else if (session.cloudStatus === "budget") {
    // a task that stopped at its cap only takes new messages after the cap is raised
    const cap = Math.ceil(((session.cloudCost || 0) + capDollars) * 100);
    await call(key, "POST", `/v1/sessions/${session.cloudId}`, { budget: { type: "limit", max_list_cost: { amount: String(cap), currency: "USD" } } }, signal);
    send({ type: "status", text: `Raised this task's cap to $${(cap / 100).toFixed(2)}.` });
  }
  const id = session.cloudId;
  signal.addEventListener("abort", () => { call(key, "POST", `/v1/sessions/${id}/events`, { events: [{ type: "user.interrupt" }] }).catch(() => {}); }, { once: true });
  await call(key, "POST", `/v1/sessions/${id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] }, signal);
  session.cloudStatus = "running"; save();
  send({ type: "status", text: "Working in the cloud. It keeps going if you close the app." });
  const r = await follow({ key, id, model, send, signal, session, save, addUsage });
  if (signal.aborted) { session.cloudStatus = "idle"; save(); return { status: "stopped", cost: r.cost }; }
  await finishTurn({ key, id, workDir, session, save, send, r, capDollars });
  return { status: r.final || "done", cost: r.cost };
}

// Pick up a task that was still working when the app closed: follow it to the end without sending anything.
export async function followCloud({ key, session, model, workDir, send, signal, save, addUsage, capDollars = 5 }) {
  const id = session.cloudId;
  session.cloudSeen = []; // the page rebuilds the whole turn from what is sent now, so replay all of it
  send({ type: "status", text: "Catching up with the cloud task…" });
  const r = await follow({ key, id, model, send, signal, session, save, addUsage });
  if (signal.aborted) return { status: "stopped", cost: r.cost };
  await finishTurn({ key, id, workDir, session, save, send, r, capDollars });
  return { status: r.final || "done", cost: r.cost };
}
