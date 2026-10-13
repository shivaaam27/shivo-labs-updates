// Other AI providers (Google Gemini, OpenRouter, Groq), alongside Claude.
// They all speak the same "chat completions" format, so one translator covers them.
// The chat is always stored in Claude's format (session.messages); each request is translated
// to the provider's format, and each reply is translated back. So tools, permissions, undo,
// previews and the rest of the app work the same whichever model is chosen.
// Model ids in the app look like "gemini:<model>" or "openrouter:<model>".

export const PROVIDERS = {
  gemini: { name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey", note: "Free tier with daily limits. On the free tier Google may use what you send to improve its products." },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys", note: "One key for many models, including free open-source ones (names ending in :free)." },
  groq: { name: "Groq", base: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", note: "Very fast open-source models, free tier with limits." },
};

// Rate limits (HTTP 429): a daily quota (Google: quotaId "...PerDay...") or a per-minute one,
// with the wait Google suggests (RetryInfo "retryDelay": "26s").
// Google's 429 is sometimes exact (seen live, Oct 2026): "Rate limit exceeded for model gemini-3.6-flash
// (limit: 20 requests per day on Free Tier). Please retry in 8h46m51s". It can name another model:
// asking for gemini-3.5-flash returned 3.6-flash's limit, so they share one allowance.
// Other times it only says "You exceeded your current quota" (kind: null).
export function limitInfo(raw) {
  const t = String(raw || "");
  const per = /limit:\s*\d+\s+(requests?|tokens?)\s+per\s+(day|minute)/i.exec(t);
  const r = /retry in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?/i.exec(t);
  const retrySec = r && (r[1] || r[2] || r[3]) ? Math.ceil((+r[1] || 0) * 3600 + (+r[2] || 0) * 60 + (+r[3] || 0)) : null;
  const model = (/for model\s+([\w.\-]+)/i.exec(t) || [])[1] || null;
  const kind = per ? (per[2].toLowerCase() === "day" ? "day" : "minute") : /PerDay/i.test(t) ? "day" : /PerMinute/i.test(t) ? "minute" : null;
  return { kind, daily: kind === "day", retrySec, model };
}
// Smaller requests for other providers (their free tiers limit tokens per minute, and each request
// re-sends the whole chat): tool results older than the last `keep` messages are shortened to
// their start and end. Only our own tool results are touched: the model's own steps (and Gemini's
// raw steps, which Google requires unchanged) are left as they are. The saved chat keeps everything.
export function trimHistory(messages, keep = 6, max = 1200) {
  const cut = (t) => t.length <= max ? t : `${t.slice(0, max * 0.6)}\n…(shortened: ${t.length} characters; run the tool again if you need all of it)…\n${t.slice(-max * 0.3)}`;
  return messages.map((m, i) => {
    if (i >= messages.length - keep || m.role !== "user" || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      if (typeof b.content === "string" && b.content.length > max) { changed = true; return { ...b, content: cut(b.content) }; }
      if (Array.isArray(b.content)) {
        const c = b.content.map((x) => x.type === "text" && x.text?.length > max ? (changed = true, { ...x, text: cut(x.text) })
          : x.type === "image" || x.type === "document" ? (changed = true, { type: "text", text: "(An older screenshot/document was removed to keep the request small. Take or open it again if needed.)" }) : x);
        return { ...b, content: c };
      }
      return b;
    });
    return changed ? { ...m, content } : m;
  });
}
export const isClaude = (model) => /^claude-/.test(model);
export function splitModel(id) {
  const i = String(id || "").indexOf(":");
  if (i < 0) return null;
  const provider = id.slice(0, i), model = id.slice(i + 1);
  return PROVIDERS[provider] && model ? { provider, model } : null;
}

// The provider's live list of models (so we never guess names). Also checks the key.
export async function listModels(provider, key) {
  const p = PROVIDERS[provider]; if (!p) throw new Error("Unknown provider");
  // OpenRouter's model list is public, so check the key itself first.
  if (provider === "openrouter") {
    const k = await fetch(p.base + "/key", { headers: { Authorization: "Bearer " + key } });
    if (!k.ok) throw new Error(k.status === 401 || k.status === 403 ? "OpenRouter rejected this key." : `OpenRouter answered ${k.status}. Try again later.`);
  }
  const r = await fetch(p.base + "/models", { headers: { Authorization: "Bearer " + key } });
  if (r.status === 401 || r.status === 403 || r.status === 400) throw new Error(`${p.name} rejected this key.`);
  if (!r.ok) throw new Error(`${p.name} answered ${r.status}. Try again later.`);
  const j = await r.json();
  const ids = (j.data || j.models || []).map((m) => String(m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
  // Gemini also lists embedding, image and audio models: keep the ones that can chat.
  return [...new Set(ids)].filter((id) => !/:batch$/.test(id)).filter((id) => provider !== "gemini" || (/gemini|gemma/i.test(id) && !/embed|image|tts|audio|live|vision-only|aqa|transcribe|banana|robotics|computer-use|omni|customtools/i.test(id))).sort();
}

// Tool schemas: some providers reject JSON Schema keywords they don't support.
function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["$schema", "additionalProperties", "default", "examples", "$id", "$comment"].includes(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, cleanSchema(pv)])) : cleanSchema(v);
  }
  return out;
}
const toTools = (tools) => tools.filter((t) => t.input_schema && t.name).map((t) => ({
  type: "function",
  function: { name: t.name, description: String(t.description || "").slice(0, 1000), parameters: cleanSchema(t.input_schema) },
}));

const textOf = (c) => typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const imagesOf = (c) => Array.isArray(c) ? c.filter((b) => b.type === "image" && b.source?.type === "base64") : [];
const imgPart = (b) => ({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });

// Claude-format conversation -> chat-completions messages.
export function toMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      // (thinking, compaction and Claude's own web-search blocks only mean something to Claude)
      if (!text && !calls.length) continue;
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
    const later = []; // pictures from tool results go in a user message after the tool answers
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      let t = textOf(b.content);
      if (Array.isArray(b.content) && b.content.some((x) => x.type === "document")) t += "\n(A PDF/Office document was attached here, but this model can't read documents directly. Use read_file or a script to extract the text.)";
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERROR: " : "") + (t || "(done)") });
      later.push(...imagesOf(b.content));
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      else if (b.type === "image" && b.source?.type === "base64") parts.push(imgPart(b));
      else if (b.type === "document") parts.push({ type: "text", text: "(A document was attached, but this model can't read it directly. Use read_file or a script to extract the text.)" });
    }
    if (later.length) parts.push({ type: "text", text: "(Screenshot from the last tool:)" }, ...later.map(imgPart));
    if (parts.length) out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
  }
  return out;
}

// ---------- Gemini through Google's Interactions API (Google's recommended API for new work,
// docs checked Oct 2026). Stateless: store=false, the full history is sent each time. The
// model's own steps (thoughts with signatures, function calls) are kept exactly as received in
// message.raw and sent back unchanged, as Google requires.
const GEMINI_URL = process.env.FABRA_GEMINI_URL || "https://generativelanguage.googleapis.com/v1beta/interactions"; // (overridable for tests)
const LEVEL = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
// (Google rejects empty text items: "Missing text in content of type text", seen live.)
const gItem = (b) => b.type === "text" ? (b.text ? { type: "text", text: b.text } : null)
  : b.type === "image" && b.source?.type === "base64" ? { type: "image", mime_type: b.source.media_type, data: b.source.data }
  : b.type === "document" && b.source?.type === "base64" ? { type: "document", mime_type: b.source.media_type, data: b.source.data } : null;
const tidyStep = (st) => {
  const out = { ...st };
  for (const k of ["summary", "content"]) if (Array.isArray(out[k])) { out[k] = out[k].filter((c) => c.type !== "text" || c.text); if (!out[k].length) delete out[k]; }
  return out;
};
export function toGeminiSteps(messages) {
  const steps = [], names = new Map(); // tool names, for function_result steps
  for (const x of messages) if (x.role === "assistant" && Array.isArray(x.content)) for (const b of x.content) if (b.type === "tool_use") names.set(b.id, b.name);
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
    if (m.role === "assistant") {
      if (Array.isArray(m.raw?.gemini)) { steps.push(...m.raw.gemini.map(tidyStep)); continue; } // as received (minus empty text, which Google rejects)
      for (const b of blocks) {
        if (b.type === "text" && b.text) steps.push({ type: "model_output", content: [{ type: "text", text: b.text }] });
        else if (b.type === "tool_use") steps.push({ type: "function_call", id: b.id, name: b.name, arguments: b.input ?? {} });
      }
      continue;
    }
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const items = (Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }]).map(gItem).filter(Boolean);
      steps.push({ type: "function_result", call_id: b.tool_use_id, name: names.get(b.tool_use_id), result: items.length ? items : [{ type: "text", text: "(no output)" }], ...(b.is_error ? { is_error: true } : {}) });
    }
    const content = blocks.filter((x) => x.type !== "tool_result").map(gItem).filter(Boolean);
    if (content.length) steps.push({ type: "user_input", content });
  }
  return steps;
}
const noSearch = new Set(); // models whose key can't use Google Search
async function geminiStep({ key, model, system, messages, tools, maxTokens, effort, signal, onText, onTextDone, onThought, search = !noSearch.has(model), thinking = true }) {
  const body = {
    model, system_instruction: system, input: toGeminiSteps(messages), store: false, stream: true,
    tools: [...tools.filter((t) => t.input_schema && t.name).map((t) => ({ type: "function", name: t.name, description: String(t.description || "").slice(0, 1000), parameters: cleanSchema(t.input_schema) })), ...(search ? [{ type: "google_search" }] : [])],
    generation_config: { max_output_tokens: maxTokens, ...(thinking ? { thinking_level: LEVEL[effort] || "medium", thinking_summaries: "auto" } : {}) },
  };
  // Stall guard: if Google sends nothing for 2 minutes, cancel and report it as "overloaded" (503),
  // so the fallback retries on the next model instead of waiting forever.
  const ctl = new AbortController(); let stalled = false, idle;
  const poke = () => { clearTimeout(idle); idle = setTimeout(() => { stalled = true; ctl.abort(); }, 120e3); };
  signal?.addEventListener("abort", () => ctl.abort(), { once: true }); poke();
  const stallErr = () => { const e = new Error("Google Gemini didn't answer for 2 minutes."); e.status = 503; e.provider = true; return e; };
  let r;
  try { r = await fetch(GEMINI_URL, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) }); }
  catch (e) { clearTimeout(idle); if (stalled) throw stallErr(); throw e; }
  if (!r.ok) clearTimeout(idle); // an immediate error answer: no stall to watch for
  if (!r.ok) {
    const raw = await r.text().catch(() => ""); let msg = ""; try { const j = JSON.parse(raw); msg = (Array.isArray(j) ? j[0] : j)?.error?.message || ""; } catch {}
    // Some models don't take thinking settings, or search together with our tools: retry without.
    // Google Search isn't included on the free tier (seen live, Oct 2026: every request with it gets 429
    // "exceeded your current quota"). Retry without it, and remember for this model.
    if (search && ((r.status === 429 && !limitInfo(raw).kind) || (r.status === 400 && /search|tool/i.test(msg)))) { noSearch.add(model); return geminiStep({ key, model, system, messages, tools, maxTokens, effort, signal, onText, onTextDone, onThought, search: false, thinking }); }
    if (r.status === 400 && thinking && /think/i.test(msg)) return geminiStep({ key, model, system, messages, tools, maxTokens, effort, signal, onText, onTextDone, onThought, search, thinking: false });
    const e = new Error(r.status === 429 ? `Google Gemini: limit reached (the free tier has per-minute and daily limits). Wait a bit or pick another model. ${msg}`
      : r.status === 401 || r.status === 403 ? "Google Gemini rejected the key. Check it in Settings." : `Google Gemini error ${r.status}: ${msg || r.statusText}`);
    e.status = r.status; e.provider = true; e.fallback = r.status === 400 || r.status === 404; e.limit = r.status === 429 ? limitInfo(raw) : null; e.raw = raw.slice(0, 3000); throw e;
  }
  const steps = []; let usage = {}, status = "", textOpen = false;
  const dec = new TextDecoder(); let buf = "";
  try {
  for await (const chunk of r.body) {
    poke();
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const l = line.trim(); if (!l.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(l.slice(5).trim()); } catch { continue; }
      // The live API names events in "event_type" (the docs show "type"): accept both.
      const et = ev.event_type || ev.type;
      if (et === "error" || ev.error) { const e = new Error("Google Gemini: " + (ev.error?.message || ev.message || "error")); e.provider = true; e.status = ev.error?.code; throw e; }
      if (et === "step.start") steps[ev.index] = { ...(ev.step || {}) };
      else if (et === "step.delta") {
        const s = (steps[ev.index] ||= {}), d = ev.delta || {};
        if (d.type === "text") {
          if (s.type === "thought") { onThought?.(d.text || ""); (s.summary ||= []).push({ type: "text", text: d.text || "" }); }
          else { const c = (s.content ||= []); if (c.at(-1)?.type === "text") c.at(-1).text += d.text || ""; else c.push({ type: "text", text: d.text || "" }); if (s.type !== "user_input") { textOpen = true; onText?.(d.text || ""); } }
        } else if (d.type === "thought" || d.type === "thought_summary") {
          const t = d.text || d.content?.text || (typeof d.summary === "string" ? d.summary : "") || "";
          if (t) { onThought?.(t); const sm = (s.summary ||= []); if (sm.at(-1)?.type === "text") sm.at(-1).text += t; else sm.push({ type: "text", text: t }); }
        }
        // Seen live (Oct 2026): {"type":"arguments_delta","arguments":"{...}"}; the docs show {"type":"arguments","partial_arguments":...}.
        else if (/^arguments/.test(d.type || "")) s._args = (s._args || "") + (d.arguments ?? d.partial_arguments ?? "");
        else if (d.type === "thought_signature") s.signature = (s.signature || "") + (d.signature || "");
        else for (const [k, v] of Object.entries(d)) if (k !== "type") s[k] = typeof v === "string" && typeof s[k] === "string" ? s[k] + v : v;
      } else if (et === "step.stop") {
        const s = steps[ev.index];
        if (s?._args !== undefined) { if (s._args) { try { s.arguments = JSON.parse(s._args); } catch { s.arguments = null; } } delete s._args; }
        if (s?.type === "model_output" && textOpen) { onTextDone?.(); textOpen = false; }
      } else if (et === "interaction.completed" || et === "interaction.status_update") {
        const it = ev.interaction || ev; usage = it.usage || usage; status = it.status || status;
      }
    }
  }
  } catch (e) { if (stalled) throw stallErr(); throw e; } finally { clearTimeout(idle); }
  if (textOpen) onTextDone?.();
  const own = steps.filter((s) => s && !["user_input", "function_result"].includes(s.type));
  const content = [];
  for (const s of own) {
    if (s.type === "model_output") { const t = (s.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""); if (t) content.push({ type: "text", text: t }); }
    else if (s.type === "function_call") content.push({ type: "tool_use", id: s.id, name: s.name, input: s.arguments });
  }
  if (!content.length) content.push({ type: "text", text: "(The model returned an empty reply.)" });
  return {
    model: `gemini:${model}`, content, raw: { gemini: own },
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : /incomplete|max/i.test(status) ? "max_tokens" : "end_turn",
    usage: { input_tokens: usage.total_input_tokens || 0, output_tokens: (usage.total_output_tokens || 0) + (usage.total_thought_tokens || 0) },
  };
}

// ---------- Gemini free-tier limits: pacing and automatic fallback between models.
// Google limits each model three ways at once: requests per minute, tokens per minute, requests
// per day. Its 429 says only "You exceeded your current quota" (seen live, Oct 2026), so we don't
// guess from the error. Instead we use the known free-tier limits (from the user's AI Studio
// "Rate limits" page, Oct 2026) and our own log:
//  - before sending, wait if this request would go over the per-minute requests or tokens
//    (shared across all chats), so most per-minute refusals never happen;
//  - a model is "done for today" only when it has used its daily allowance (successful requests),
//    or is still refused after waiting out three full minutes (e.g. used outside this app);
//  - "overloaded" (503) skips it for 2 minutes; "no longer available" (404) skips it for good.
export const geminiRank = (id) => {
  const v = Number((/(\d+(?:\.\d+)?)/.exec(id) || [0, 0])[1]);
  const tier = /pro/.test(id) ? 3 : /flash-lite|lite/.test(id) ? 1 : /flash/.test(id) ? 2 : /gemma/.test(id) ? 0 : 1;
  return tier * 100 + v - (/preview|latest/.test(id) ? 0.01 : 0);
};
export const prettyGemini = (id) => String(id).replace(/^gemini-/, "Gemini ").replace(/^gemma-/, "Gemma ").replace(/-preview$/, " (preview)").replace(/-it$/, "").replace(/-/g, " ").replace(/\b(flash|lite|pro|latest)\b/g, (w) => w[0].toUpperCase() + w.slice(1));
// Free tier, per model: requests/minute, tokens/minute, requests/day.
export function freeLimits(m) {
  if (/gemma/.test(m)) return { rpm: 30, tpm: 16000, rpd: 14400 };
  if (/flash-lite|lite/.test(m)) return { rpm: 15, tpm: 250000, rpd: 500 };
  return { rpm: 5, tpm: 250000, rpd: 20 }; // Flash and anything unknown: the strictest
}
// Rough size of a request in tokens (about 4 characters per token; a picture is about 1,500).
export function estimateTokens({ system = "", messages = [], tools = [] }) {
  let chars = String(system).length + JSON.stringify(tools).length, pics = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") { if (typeof v === "string") chars += v.length; return; }
    if ((v.type === "image" || v.type === "document") && (v.source?.data || v.data)) { pics++; return; }
    for (const [k, x] of Object.entries(v)) if (k !== "signature") walk(x);
  };
  walk(messages);
  return Math.ceil(chars / 4) + pics * 1500;
}
const pacificDay = (t = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(t);
export function nextPacificMidnight(t = Date.now()) {
  const day = pacificDay(t); let x = t;
  while (pacificDay(x) === day) x += 15 * 60e3;
  return x - (x % (15 * 60e3)); // within 15 minutes after the reset
}
export function makeGeminiLimits(file, fs) {
  let st = { day: "", counts: {}, out: {}, gone: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch {}
  st.gone ||= {};
  const win = new Map(); // model -> [{ t, tok }] sent in the last minute (all chats)
  const busy = new Map(); // model -> until when it's skipped (overloaded at Google)
  const fresh = () => { if (st.day !== pacificDay()) st = { day: pacificDay(), counts: {}, out: {}, gone: st.gone }; };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(st)); } catch {} };
  const recent = (m) => { const r = (win.get(m) || []).filter((x) => x.t > Date.now() - 60e3); win.set(m, r); return r; };
  return {
    usedToday: (m) => (fresh(), st.counts[m] || 0),
    isOut: (m) => (fresh(), Boolean(st.gone[m]) || (st.out[m] || 0) > Date.now() || (busy.get(m) || 0) > Date.now()),
    isGone: (m) => Boolean(st.gone[m]),
    whyOut: (m) => st.gone[m] ? "gone" : (busy.get(m) || 0) > Date.now() ? "busy" : "daily",
    resetAt: () => nextPacificMidnight(),
    setBusy: (m) => busy.set(m, Date.now() + 120e3),
    setGone(m) { st.gone[m] = Date.now(); save(); },
    setDailyOut(m) { fresh(); st.out[m] = nextPacificMidnight(); save(); },
    // Seconds to wait before sending `tok` tokens to m, so the per-minute limits aren't crossed
    // (0 = send now; Infinity = this request is too big for this model's per-minute token limit).
    waitFor(m, tok) {
      const L = freeLimits(m), r = recent(m);
      if (tok > L.tpm) return Infinity;
      let need = 0, sum = r.reduce((a, x) => a + x.tok, 0), i = 0;
      // Drop the oldest requests from the window (by waiting) until both limits fit.
      while ((r.length - i >= L.rpm || sum + tok > L.tpm) && i < r.length) { need = r[i].t + 60.5e3 - Date.now(); sum -= r[i].tok; i++; }
      return Math.max(0, Math.ceil(need / 1000));
    },
    sent(m, tok) { recent(m).push({ t: Date.now(), tok }); },
    // At most the request just refused in the last minute: the per-minute limit can't be the cause.
    quietMinute: (m) => recent(m).length <= 1,
    ok(m) { fresh(); st.counts[m] = (st.counts[m] || 0) + 1; save(); if (st.counts[m] >= freeLimits(m).rpd) { st.out[m] = nextPacificMidnight(); save(); } },
  };
}
const sleep = (sec, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, sec * 1000);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
});
// Run one step on the first Gemini model in `chain` that can take it.
export async function geminiWithFallback(limits, chain, args, { onWait, onSwitch } = {}) {
  const tok = estimateTokens(args);
  let tried = null, lastErr = null, why = "daily";
  for (const m of chain) {
    if (limits.isOut(m)) { if (!tried) why = limits.whyOut(m); continue; }
    if (limits.waitFor(m, tok) === Infinity) { why = "big"; continue; } // too large for this model's per-minute tokens
    if (tried && tried !== m) onSwitch?.(tried, m, why);
    tried = m;
    let refused = 0;
    while (true) {
      const w = limits.waitFor(m, tok);
      if (w > 0) { onWait?.(m, w); await sleep(w, args.signal); }
      limits.sent(m, tok);
      try {
        const msg = await chatStep({ ...args, provider: "gemini", model: m });
        limits.ok(m); msg.usedModel = m; return msg;
      } catch (e) {
        if (args.signal?.aborted) throw e;
        lastErr = e;
        if (e.status === 404 || /no longer available|not found/i.test(e.message)) { limits.setGone(m); why = "gone"; break; }
        if (e.status >= 500) { limits.setBusy(m); why = "busy"; break; }
        if (e.status !== 429) throw e;
        // Google said exactly which limit: act on it.
        if (e.limit?.kind === "day") { limits.setDailyOut(m); if (e.limit.model && e.limit.model !== m) limits.setDailyOut(e.limit.model); why = "daily"; break; }
        if (e.limit?.kind === "minute") { const w2 = Math.min(70, Math.max(5, e.limit.retrySec || 61)); onWait?.(m, w2); await sleep(w2, args.signal); continue; }
        // Refused although our pacing says it fits. If this model had a busy minute (other chats,
        // or use outside the app), wait it out and try again; a second refusal after a quiet
        // minute means the daily allowance is used up.
        if (++refused > 1 && limits.quietMinute(m)) { limits.setDailyOut(m); why = "daily"; break; }
        if (refused > 3) { limits.setDailyOut(m); why = "daily"; break; }
        onWait?.(m, 61, "check"); await sleep(61, args.signal);
      }
    }
  }
  const at = new Date(limits.resetAt()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (why === "busy") { const e = new Error("Google's Gemini models are overloaded right now. Try again in a few minutes, or pick Claude."); e.provider = true; e.status = 503; throw e; }
  if (why === "big") { const e = new Error("This chat has grown too big for Gemini's free per-minute limit. Start a new chat, or pick Claude for this one."); e.provider = true; e.status = 429; throw e; }
  const e = new Error(`All your Gemini models have used their free requests for today. They reset at about ${at} (your time). Pick Claude or another model to keep going.`);
  e.provider = true; e.status = 429; e.allOut = true; e.cause = lastErr; throw e;
}

// One step of the conversation: send it, stream the reply, and return it in Claude's shape
// ({ content, stop_reason, usage }) so the agent loop handles it like any Claude reply.
export async function chatStep(args) {
  if (args.provider === "gemini" && !args.compat) {
    // (No fallback to Google's OpenAI-compatible endpoint: it can't carry thought signatures, so after
    // the first tool call it fails with a misleading error. Tested live, Oct 2026.)
    return await geminiStep({ ...args, maxTokens: args.maxTokens || 16000 });
  }
  return compatStep(args);
}
async function compatStep({ provider, key, model, system, messages, tools, maxTokens = 16000, signal, onText, onTextDone }) {
  const p = PROVIDERS[provider];
  const body = { model, messages: toMessages(system, messages), stream: true, max_tokens: maxTokens, stream_options: { include_usage: true } };
  if (tools?.length) { body.tools = toTools(tools); body.tool_choice = "auto"; }
  const r = await fetch(p.base + "/chat/completions", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, ...(provider === "openrouter" ? { "HTTP-Referer": "https://shivolabs.local", "X-Title": "Shivo Labs AI" } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => ""); let msg = ""; try { const j = JSON.parse(raw); msg = (Array.isArray(j) ? j[0] : j)?.error?.message || ""; } catch {}
    const e = new Error(r.status === 429 ? `${p.name}: limit reached (free tiers have per-minute and daily limits). Wait a bit or pick another model. ${msg}`
      : r.status === 401 || r.status === 403 ? `${p.name} rejected the key. Check it in Settings.` : `${p.name} error ${r.status}: ${msg || r.statusText}`);
    e.status = r.status; e.provider = true; e.limit = r.status === 429 ? limitInfo(raw) : null; e.raw = raw.slice(0, 3000); throw e;
  }
  let text = "", finish = null, usage = {}, textOpen = false;
  const calls = []; // by index: { id, name, args }
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const l = line.trim(); if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim(); if (data === "[DONE]") continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) { const e = new Error(`${p.name}: ${j.error.message || "error"}`); e.provider = true; throw e; }
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0]; if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) { text += d.content; textOpen = true; onText?.(d.content); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        const c = (calls[i] ||= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  if (textOpen) onTextDone?.();
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls.filter(Boolean)) {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = null; } // null: the loop answers "invalid tool input"
    content.push({ type: "tool_use", id: c.id || "call_" + Math.random().toString(36).slice(2, 12), name: c.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "(The model returned an empty reply.)" });
  const hasCalls = content.some((b) => b.type === "tool_use");
  return {
    model: `${provider}:${model}`, content,
    stop_reason: finish === "length" ? "max_tokens" : hasCalls ? "tool_use" : "end_turn",
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}
