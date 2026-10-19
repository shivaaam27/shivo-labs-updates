// Connector tools on demand, like Claude Code's tool search. When connectors bring many tools, their
// full definitions aren't put in front of the AI at every step (that costs tokens and makes it pick
// worse). It gets find_tools instead, whose description lists the tool names, and loads the ones it
// needs by keywords or by name.
// - Claude: every connector tool is still sent, marked defer_loading; find_tools answers with
//   tool_reference blocks and the API loads those definitions in place, so the prompt cache stays intact.
// - Other models: only the loaded tools are sent; find_tools adds to the chat's loaded list.

// Load everything straight away when it's small; search when there are more tools than this.
export const DEFER_COUNT = 10, DEFER_CHARS = 16000;
export const shouldDefer = (defs = []) => defs.length > DEFER_COUNT || JSON.stringify(defs).length > DEFER_CHARS;

const SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Keywords (e.g. \"chrome screenshot\", \"github pull request\"), or select:<name>[,<name>…] to load exact tools" },
    limit: { type: "integer", description: "Most tools to load for keywords (default 5)" },
  },
  required: ["query"],
};
export const FIND_TOOLS = { name: "find_tools", description: "Load connector tools before using them.", input_schema: SCHEMA };

// mcp__<connector>__<tool> -> [connector, tool]
function split(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? [m[1], m[2]] : ["", name];
}

// find_tools with the names of the tools it can load, grouped by connector.
export function findToolsDef(defs) {
  const groups = new Map();
  for (const d of defs) {
    const [c, t] = split(d.name);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(t);
  }
  let list = [...groups].map(([c, ts]) => `- ${c || "other"}: ${ts.join(", ")}`).join("\n");
  if (list.length > 6000) list = [...groups].map(([c, ts]) => `- ${c || "other"} (${ts.length} tools)`).join("\n");
  return {
    name: "find_tools",
    description: "Load connector tools before using them. Their full definitions aren't loaded yet, to keep each step small. " +
      "Search with keywords, or load exact tools with select:<name>[,<name>…] (the short name or the full mcp__connector__tool name). " +
      "Loaded tools can be called straight after and stay loaded for the rest of the chat. Load all you'll need in one go.\n" +
      "Connector tools you can load (full name: mcp__<connector>__<tool>):\n" + list,
    input_schema: SCHEMA,
  };
}

// The tools that match a find_tools query: select:<names>, or the best keyword matches.
export function searchTools(defs, query, limit = 5) {
  const q = String(query || "").trim();
  const sel = /^select:(.*)$/is.exec(q);
  if (sel) {
    const want = sel[1].split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    return defs.filter((d) => { const n = d.name.toLowerCase(); return want.some((w) => n === w || n.endsWith("__" + w)); });
  }
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!words.length) return [];
  const scored = defs.map((d) => {
    const [c, t] = split(d.name.toLowerCase());
    const parts = t.split(/[_\-.]+/), desc = String(d.description || "").toLowerCase();
    const props = Object.keys(d.input_schema?.properties || {}).join(" ").toLowerCase();
    let score = 0;
    for (const w of words) {
      if (parts.includes(w)) score += 4;
      else if (t.includes(w)) score += 2;
      if (c.includes(w)) score += 1;
      if (desc.includes(w)) score += 1;
      if (props.includes(w)) score += 0.5;
    }
    return { d, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.d.name.localeCompare(b.d.name));
  if (!scored.length) return [];
  // Only the close matches: "chrome screenshot" shouldn't load every Chrome tool.
  const bar = Math.max(1, scored[0].score * 0.4);
  return scored.filter((x) => x.score >= bar).slice(0, Math.max(1, limit)).map((x) => x.d);
}

// Tool names the chat already loaded through tool references (Claude). Each one needs a definition in
// every later request, or the API refuses it.
export function referencedTools(messages = []) {
  const out = new Set();
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === "tool_result" && Array.isArray(b.content))
      for (const c of b.content) if (c.type === "tool_reference" && c.tool_name) out.add(c.tool_name);
  }
  return out;
}

// The connector part of a request's tool list.
// loaded: tools another model loaded in this chat (sent in full for every model).
export function connectorTools(defs = [], { claude = true, loaded = new Set(), messages = [] } = {}) {
  const refs = referencedTools(messages), out = [];
  if (!shouldDefer(defs)) out.push(...defs);
  else {
    out.push(findToolsDef(defs));
    if (claude) out.push(...defs.map((d) => loaded.has(d.name) ? d : { ...d, defer_loading: true }));
    else out.push(...defs.filter((d) => loaded.has(d.name) || refs.has(d.name)));
  }
  // A tool loaded earlier whose connector isn't connected now (switched off, failed, still starting).
  if (claude) {
    const have = new Set(defs.map((d) => d.name));
    for (const n of refs) if (!have.has(n)) out.push({ name: n, description: "(This connector tool isn't connected right now.)", input_schema: { type: "object", properties: {} }, defer_loading: true });
  }
  return out;
}
