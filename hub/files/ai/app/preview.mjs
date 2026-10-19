// Dev servers for the preview panel, like Claude Code's preview_start: the project's servers are
// described in .claude/launch.json (the same file Claude Code uses), the AI starts one by name, the
// app waits until it answers and opens it in the preview by itself. A server started some other way
// (run_command with background: true) is opened too, as soon as it prints a local address and answers.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probePort } from "./relay.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, "");

// The first local address a program printed ("Local: http://localhost:5173/"), as a localhost URL.
const URL_RE = /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[^\s'"`<>)\]*]*)?/i;
export function localUrl(text) {
  const m = URL_RE.exec(stripAnsi(text));
  if (!m) return null;
  const path = (m[3] || "/").replace(/[.,;:!?]+$/, "") || "/";
  return { port: Number(m[2]), url: `${m[1].toLowerCase()}://localhost:${m[2]}${path}` };
}

// Wait until something answers on the port (127.0.0.1 or ::1). Gives up when `alive()` turns false.
export async function waitForPort(port, { ms = 90000, alive = () => true, signal } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end && !signal?.aborted && alive()) {
    if (await probePort(port)) return true;
    await sleep(500);
  }
  return false;
}

// launch.json may have comments and trailing commas (it's JSONC, like VS Code's).
export function parseJsonc(text) {
  text = String(text).replace(/^\uFEFF/, "");
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const EXAMPLE = '{ "version": "0.0.1", "configurations": [ { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 } ] }';

// A free port at or after `from` (nothing answering on 127.0.0.1 or ::1).
async function freePortFrom(from) {
  for (let p = from; p < from + 100 && p < 65536; p++) if (!(await probePort(p, 300))) return p;
  throw new Error(`No free port found after ${from}.`);
}

// --port 5173, --port=5173 and -p 5173 in the arguments follow the port that was picked.
function rewritePort(args, to) {
  return args.map((a, i) => /^--port=\d+$/.test(a) ? `--port=${to}` : /^\d+$/.test(a) && (args[i - 1] === "--port" || args[i - 1] === "-p") ? String(to) : a);
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
export function launchCommand(cfg, root, port) {
  const sub = (s) => String(s).replaceAll("${workspaceFolder}", root);
  const cwd = cfg.cwd ? resolve(root, sub(cfg.cwd)) : root;
  const env = { ...(cfg.env && typeof cfg.env === "object" ? cfg.env : {}) };
  if (port) env.PORT = String(port);
  let args = [...(cfg.runtimeArgs || []), ...(cfg.program ? [cfg.program] : []), ...(cfg.args || [])].map(sub);
  if (port && Number(cfg.port) && port !== Number(cfg.port)) args = rewritePort(args, port);
  const exe = cfg.runtimeExecutable ? sub(cfg.runtimeExecutable) : "node";
  return [`Set-Location -LiteralPath ${q(cwd)}`,
    ...Object.entries(env).filter(([k]) => /^\w+$/.test(k)).map(([k, v]) => `$env:${k} = ${q(v)}`),
    `& ${q(exe)}${args.length ? " " + args.map(q).join(" ") : ""}`].join("; ");
}

export const PREVIEW_TOOLS = [{
  name: "preview_start",
  description:
    "Start one of the project's dev servers and open it in the app's preview panel. Servers are described in .claude/launch.json in the project folder " +
    "(the same file Claude Code uses). If the server is already running from this app, it is just opened again; if its port is taken, a free one is picked (unless \"autoPort\": false). " +
    "It waits until the server answers, then opens it. If there's no launch.json yet, create it first, for example " + EXAMPLE +
    ". Fields per configuration: name, runtimeExecutable (npm, pnpm, node, python…), runtimeArgs, port, cwd (relative to the project), env, autoPort, program + args (a script run with node), url (the page to open).",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Which configuration to start (default: the first one)" },
      folder: { type: "string", description: "Project folder holding .claude/launch.json (default: the working folder)" },
    },
  },
}];

const started = new Map(); // launch.json + name -> { pid, port, url }

export function previewHandlers({ abs, background, startBackground, onPreview }) {
  return {
    async preview_start({ name, folder }, signal) {
      const root = abs(folder || ".");
      const file = join(root, ".claude", "launch.json");
      if (!existsSync(file)) throw new Error(`There's no ${file} yet. Create it with write_file first, for example:\n${EXAMPLE}\n(runtimeExecutable and runtimeArgs are the command that starts the dev server; port is where it listens.) Then call preview_start again.`);
      let conf; try { conf = parseJsonc(readFileSync(file, "utf8")); } catch (e) { throw new Error(`Couldn't read ${file}: ${e.message}`); }
      const list = (Array.isArray(conf?.configurations) ? conf.configurations : []).filter((c) => c && typeof c === "object");
      if (!list.length) throw new Error(`${file} has no "configurations". Example:\n${EXAMPLE}`);
      const cfg = name ? list.find((c) => String(c.name).toLowerCase() === String(name).toLowerCase()) : list[0];
      if (!cfg) throw new Error(`No configuration named "${name}" in ${file}. There are: ${list.map((c) => c.name).join(", ")}.`);
      const label = cfg.name || "server", key = file.toLowerCase() + "#" + label;
      const open = (url) => { try { onPreview?.(url); } catch {} };

      // Already running from this app: open it again.
      const had = started.get(key), hadP = had && background.get(had.pid);
      if (hadP && hadP.child.exitCode === null && (await probePort(had.port))) { open(had.url); return `${label} is already running (process ${had.pid}) at ${had.url}; opened it in the preview.`; }

      // Only a page to open, nothing to start.
      if (!cfg.runtimeExecutable && !cfg.program) {
        if (!cfg.url) throw new Error(`Configuration "${label}" needs runtimeExecutable (e.g. "npm") and runtimeArgs (e.g. ["run","dev"]), or a program, or a url.`);
        open(cfg.url); return `Opened ${cfg.url} in the preview.`;
      }

      let port = Number(cfg.port) || 0, moved = "";
      if (port && (await probePort(port))) {
        if (cfg.autoPort === false) throw new Error(`Port ${port} is already in use by another program, and "autoPort" is false. Stop that program (or pick another port), then try again.`);
        const was = port; port = await freePortFrom(port + 1); moved = ` (port ${was} was busy, so it uses ${port})`;
      }
      const reply = await startBackground(launchCommand(cfg, root, port), signal);
      const pid = Number(/process (\d+)/.exec(reply)?.[1]);
      const p = background.get(pid);
      if (!p) return reply;

      // Wait for it to answer: on the address it prints (servers like Vite pick their own port when
      // one is busy), or else on the configured port.
      const until = Date.now() + 90000;
      let url = null;
      while (Date.now() < until && !signal?.aborted && p.child.exitCode === null) {
        const printed = localUrl(p.output.slice(0, 50000));
        const tryPort = printed?.port || port;
        if (tryPort && (await probePort(tryPort))) {
          url = cfg.url ? String(cfg.url).replace(/:\d+/, `:${tryPort}`) : printed && printed.port === tryPort ? printed.url : `http://localhost:${tryPort}/`;
          break;
        }
        await sleep(500);
      }
      const out = (s) => { s = stripAnsi(s).trim(); return s.length > 4000 ? "…" + s.slice(-4000) : s || "(no output)"; };
      if (!url) {
        if (p.child.exitCode !== null) throw new Error(`${label} stopped before it answered (exit code ${p.child.exitCode}). Its output:\n${out(p.output)}`);
        if (signal?.aborted) return `Stopped waiting. ${label} keeps starting in the background (process ${pid}).`;
        return `${label} started (process ${pid})${moved} but nothing answered within 90 seconds. Read its output with check_process ${pid} or wait with wait_for_process. Output so far:\n${out(p.output)}`;
      }
      started.set(key, { pid, port: Number(new URL(url).port), url });
      p.previewed = true;
      open(url);
      p.read = p.total;
      return `${label} is running (process ${pid})${moved} at ${url} and is open in the preview panel. Stop it with stop_process ${pid}. Output so far:\n${out(p.output)}`;
    },
  };
}
