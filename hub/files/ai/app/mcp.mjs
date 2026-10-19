// Connectors (MCP servers), the same standard Claude Code uses.
// Sources: the app's own list (Settings → Connectors) and a project's .mcp.json.
// Local servers run as programs (stdio); remote ones are reached over HTTP. Tools appear to the
// AI as mcp__<server>__<tool>. Connections are reused and closed when idle.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

// ${secret:NAME} (a secret saved in Settings), ${NAME} and ${NAME:-default} (a secret or an environment
// variable, the same expansion Claude Code's .mcp.json uses) are filled in when connecting, so tokens
// don't have to sit in connector settings in plain text.
export function expandVars(value, secret = () => undefined) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{(secret:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, isSecret, name, dflt) => {
    const v = secret(name) ?? (isSecret ? undefined : process.env[name]);
    return v ?? dflt ?? (isSecret ? "" : m);
  });
}
const expandAll = (o, secret) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, expandVars(v, secret)]));

// auth: sign-ins for remote connectors (mcpauth.mjs). A connector with its own Authorization header
// (a token) never uses it.
export function makeConnectors(dataDir, { secret = () => undefined, auth = null } = {}) {
  const file = join(dataDir, "connectors.json");
  const load = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { mcpServers: {} }; } };
  const save = (c) => writeFileSync(file, JSON.stringify(c, null, 2));
  const live = new Map(); // key -> { client, tools, lastUsed, error }

  // All servers for a chat: the app's own plus the project's .mcp.json (project wins on a name clash).
  function configsFor(workDir) {
    const out = {};
    for (const [n, c] of Object.entries(load().mcpServers || {})) if (!c.disabled) out[n] = { ...c, source: "app" };
    const proj = workDir && join(workDir, ".mcp.json");
    if (proj && existsSync(proj)) {
      try { for (const [n, c] of Object.entries(JSON.parse(readFileSync(proj, "utf8")).mcpServers || {})) out[n] = { ...c, source: "project", cwd: workDir }; } catch {}
    }
    return out;
  }

  // Claude Code's headersHelper: a command that prints headers (JSON, or "Name: value" lines).
  function helperHeaders(cfg) {
    if (!cfg.headersHelper) return {};
    const text = execSync(cfg.headersHelper, { cwd: cfg.cwd || process.cwd(), windowsHide: true, timeout: 20000, encoding: "utf8" }).trim();
    try { return JSON.parse(text); } catch {}
    return Object.fromEntries(text.split(/\r?\n/).map((l) => l.split(/:\s*/)).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(": ").trim()]));
  }

  // A connector that's still starting is shared, not started a second time.
  const starting = new Map();
  function connect(name, rawCfg) {
    const k = name + JSON.stringify(rawCfg);
    if (!starting.has(k)) starting.set(k, connectNow(name, rawCfg).finally(() => starting.delete(k)));
    return starting.get(k);
  }
  async function connectNow(name, rawCfg) {
    const cfg = { ...rawCfg, url: expandVars(rawCfg.url, secret), command: expandVars(rawCfg.command, secret),
      args: (rawCfg.args || []).map((a) => expandVars(a, secret)), env: expandAll(rawCfg.env, secret), headers: expandAll(rawCfg.headers, secret) };
    const key = name + JSON.stringify(cfg);
    const have = live.get(key);
    if (have?.client) { have.lastUsed = Date.now(); return have; }
    const client = new Client({ name: "fabra-labs-ai", version: "1.0.0" });
    let transport;
    if (cfg.url || cfg.type === "http" || cfg.type === "sse") {
      const headers = { ...(cfg.headers || {}), ...helperHeaders(cfg) };
      // A header whose secret isn't saved expands to "Bearer ": leave it out, so sign-in can be used instead.
      for (const k of Object.keys(headers)) if (/^authorization$/i.test(k) && !/^\S+\s+\S/.test(String(headers[k]).trim())) delete headers[k];
      const hasToken = Object.keys(headers).some((k) => /^authorization$/i.test(k));
      if (auth && !hasToken) await auth.ready();
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers }, ...(auth && !hasToken ? { authProvider: auth.provider(cfg.url) } : {}) });
    } else {
      transport = new StdioClientTransport({
        command: cfg.command, args: cfg.args || [], cwd: cfg.cwd,
        env: { ...process.env, ...(cfg.env || {}) }, stderr: "ignore",
      });
    }
    const entry = { key, url: cfg.url, client: null, tools: [], lastUsed: Date.now(), error: null, needsAuth: false };
    try {
      await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out connecting")), 30000))]);
      const { tools } = await client.listTools();
      entry.client = client; entry.tools = tools || [];
      // A server that crashes or drops the line is forgotten, so the next use connects again.
      client.onclose = () => { if (live.get(key) === entry) live.delete(key); };
    } catch (e) {
      entry.error = String(e.message || e).slice(0, 300);
      if (e instanceof UnauthorizedError || /\b401\b|unauthori[sz]ed/i.test(entry.error)) {
        entry.needsAuth = !!cfg.url;
        entry.error = auth && cfg.url ? "needs you to sign in (Settings → Connectors → Sign in)" : "the service refused the sign-in details (check the token)";
      }
      try { await client.close(); } catch {}
    }
    live.set(key, entry);
    if (entry.error) setTimeout(() => live.get(key) === entry && live.delete(key), 60000); // retry after a minute
    return entry;
  }

  // Close connections nobody has used for 10 minutes.
  setInterval(() => {
    for (const [k, e] of live) if (e.client && Date.now() - e.lastUsed > 600000) { e.client.close().catch(() => {}); live.delete(k); }
  }, 60000).unref();

  return {
    load, save,
    configsFor,
    // Connect to every server for this chat; returns tool definitions for the API and a caller.
    async toolsFor(workDir) {
      const cfgs = configsFor(workDir), defs = [], routes = new Map(), status = [];
      await Promise.all(Object.entries(cfgs).map(async ([name, cfg]) => {
        const e = await connect(name, cfg);
        status.push({ name, source: cfg.source, ok: !e.error, error: e.error, needsAuth: e.needsAuth, tools: e.tools.length });
        for (const t of e.tools) {
          let full = `mcp__${safeName(name)}__${safeName(t.name)}`.slice(0, 64);
          // Names are cut to the API's 64-character limit; keep them unique.
          for (let i = 2; routes.has(full); i++) full = full.slice(0, 60) + "_" + i;
          routes.set(full, { name, cfg, tool: t.name });
          defs.push({ name: full, description: `[${name} connector] ${t.description || t.name}`.slice(0, 1024), input_schema: t.inputSchema || { type: "object", properties: {} } });
        }
      }));
      return {
        defs, status,
        has: (n) => routes.has(n),
        async call(n, input) {
          const r = routes.get(n);
          // Look the connection up each time: if it was closed for being idle, this reconnects.
          const e = await connect(r.name, r.cfg);
          if (!e.client) throw new Error(e.error || "the connector isn't connected");
          let res;
          try { res = await e.client.callTool({ name: r.tool, arguments: input || {} }); }
          catch (err) {
            // Not retried here: the server may already have done it. Drop the connection so the
            // next call starts a fresh one, and let the AI decide whether to try again.
            if (live.get(e.key) === e) { live.delete(e.key); e.client.close().catch(() => {}); }
            throw new Error(`The "${r.name}" connector failed: ${String(err?.message || err).slice(0, 300)}. It will reconnect on the next try.`);
          }
          const content = [];
          for (const c of res.content || []) {
            if (c.type === "text") content.push({ type: "text", text: c.text });
            else if (c.type === "image") content.push({ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } });
            else if (c.type === "resource" && c.resource?.text) content.push({ type: "text", text: c.resource.text });
          }
          const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "(no text result)";
          return { text, content: content.length ? content : undefined, isError: !!res.isError };
        },
      };
    },
    // Close every connection (used before the app restarts for an update).
    closeAll() { for (const e of live.values()) e.client?.close().catch(() => {}); live.clear(); },
    async test(name, cfg) { const e = await connect(name, cfg); return { ok: !e.error, error: e.error, needsAuth: e.needsAuth, tools: e.tools.map((t) => t.name) }; },
    // Forget cached connections (and failures) for an address, e.g. right after signing in or out.
    forget(url) { for (const [k, e] of live) if (e.url === url) { e.client?.close().catch(() => {}); live.delete(k); } },
    // The address a connector really uses (with ${secret:...} filled in), for sign-in.
    urlOf(cfg) { return expandVars(cfg?.url, secret); },
  };
}
