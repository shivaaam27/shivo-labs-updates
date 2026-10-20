// Real terminals for the AI (gap 2): a PowerShell in a pseudo-console (ConPTY), so interactive
// tools work: prompts can be answered, menus moved with arrow keys, colours and full-screen apps drawn.
// A headless xterm keeps the screen, so the AI reads exactly what a person would see.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

let pty = null, Terminal = null, loadError = "";
try { pty = require("@lydell/node-pty"); Terminal = require("@xterm/headless").Terminal; }
catch (e) { loadError = e.message; }

const sessions = new Map(); // id -> { p, term, owner, command, exited, lastData }
let nextId = 1;

const KEYS = {
  enter: "\r", tab: "\t", "shift+tab": "\x1b[Z", esc: "\x1b", escape: "\x1b", backspace: "\x7f", delete: "\x1b[3~", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
  y: "y", n: "n", q: "q",
};
function keyBytes(k) {
  const s = String(k).trim().toLowerCase().replace(/\s+/g, "");
  if (KEYS[s] !== undefined) return KEYS[s];
  const m = /^ctrl\+([a-z\[\]\\])$/.exec(s);
  if (m) return String.fromCharCode(m[1].toUpperCase().charCodeAt(0) - 64);
  if (/^f([1-9]|1[0-2])$/.test(s)) return ["\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS", "\x1b[15~", "\x1b[17~", "\x1b[18~", "\x1b[19~", "\x1b[20~", "\x1b[21~", "\x1b[23~", "\x1b[24~"][+s.slice(1) - 1];
  throw new Error(`Unknown key "${k}". Use e.g. Enter, Tab, Esc, Up, Down, Left, Right, Backspace, Space, PageUp, Ctrl+C, F1.`);
}

function screen(s) {
  const b = s.term.buffer.active, out = [];
  for (let i = 0; i < s.term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
  const text = out.join("\n").replace(/\n+$/, "");
  const cur = `(cursor at row ${b.cursorY + 1}, column ${b.cursorX + 1})`;
  return (text || "(blank screen)") + "\n" + cur + (s.exited !== null ? `\n(The terminal has closed, exit code ${s.exited}.)` : "");
}

// Wait until the output has been quiet for `quiet` ms (the program is waiting for input), or `max` ms.
function settle(s, max = 3000, quiet = 600, signal) {
  return new Promise((done) => {
    const t0 = Date.now();
    const tick = () => {
      if (signal?.aborted || s.exited !== null || Date.now() - s.lastData >= quiet || Date.now() - t0 >= max) return done();
      setTimeout(tick, 100);
    };
    setTimeout(tick, Math.min(quiet, 300));
  });
}

export const PTY_TOOLS = [
  {
    name: "terminal_open",
    description:
      "Open a real interactive terminal (PowerShell in a pseudo-console) for programs that ask questions, use arrow-key menus, need a TTY or draw full-screen " +
      "(e.g. npm create, ssh, python REPL, git rebase -i, wizards). Returns an id and the screen. Prefer run_command for ordinary commands. " +
      "Close it with terminal_close when done.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Optional first command to type and run (Enter is added)." },
        cols: { type: "integer", description: "Width, default 120" },
        rows: { type: "integer", description: "Height, default 30" },
      },
    },
  },
  {
    name: "terminal_send",
    description:
      "Type into an open terminal and/or press keys, then return the screen once the program goes quiet. " +
      "`text` is typed as-is (add a key Enter to submit). `keys` are pressed after the text, in order: Enter, Tab, Esc, Up, Down, Left, Right, Backspace, Space, PageUp, PageDown, Ctrl+C, Ctrl+D, F1-F12. " +
      "Read the screen before answering a prompt; never type passwords the user hasn't given you.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        text: { type: "string" },
        keys: { type: "array", items: { type: "string" } },
        wait_seconds: { type: "number", description: "Longest to wait for the output to settle, default 3, max 120" },
      },
      required: ["id"],
    },
  },
  {
    name: "terminal_read",
    description: "Read the current screen of an open terminal (optionally after waiting for output to settle). Use it to follow a long-running program.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" }, wait_seconds: { type: "number", description: "Wait up to this long for output to settle first, default 0" } },
      required: ["id"],
    },
  },
  {
    name: "terminal_close",
    description: "Close an open terminal and everything running in it.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
];

// owner: the chat id, so one chat can't drive another chat's terminal. onRaw streams the raw output (with colours) to the app.
export function ptyHandlers({ owner, cwd, env, onRaw = () => {} }) {
  const get = (id) => {
    const s = sessions.get(Number(id));
    if (!s || s.owner !== owner) throw new Error(`No open terminal ${id}. Open one with terminal_open.`);
    return s;
  };
  return {
    async terminal_open({ command, cols = 120, rows = 30 }, signal) {
      if (!pty) throw new Error("The terminal part isn't installed (" + loadError + "). Use run_command instead.");
      if ([...sessions.values()].filter((s) => s.owner === owner && s.exited === null).length >= 4) throw new Error("This chat already has 4 terminals open; close one first.");
      cols = Math.min(300, Math.max(40, cols)); rows = Math.min(100, Math.max(10, rows));
      const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
      const p = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"], { name: "xterm-256color", cols, rows, cwd: cwd(), env: { ...env(), TERM: "xterm-256color" } });
      const id = nextId++;
      const s = { p, term, owner, command: command || "", exited: null, lastData: Date.now() };
      sessions.set(id, s);
      p.onData((d) => { s.lastData = Date.now(); term.write(d); onRaw(d); });
      p.onExit(({ exitCode }) => { s.exited = exitCode ?? 0; setTimeout(() => { if (sessions.get(id) === s) sessions.delete(id); term.dispose(); }, 10 * 60000); });
      await settle(s, 6000, 800, signal);
      if (command) { p.write(command + "\r"); s.lastData = Date.now(); await settle(s, 5000, 800, signal); }
      return `Terminal ${id} is open.\n${screen(s)}`;
    },
    async terminal_send({ id, text, keys = [], wait_seconds = 3 }, signal) {
      const s = get(id);
      if (s.exited !== null) return screen(s);
      const bytes = (text ? String(text) : "") + (Array.isArray(keys) ? keys : [keys]).map(keyBytes).join("");
      if (!bytes) throw new Error("Give text or keys to send.");
      s.lastData = Date.now(); s.p.write(bytes);
      await settle(s, Math.min(120, Math.max(0.5, wait_seconds)) * 1000, 700, signal);
      return screen(s);
    },
    async terminal_read({ id, wait_seconds = 0 }, signal) {
      const s = get(id);
      if (wait_seconds > 0) await settle(s, Math.min(120, wait_seconds) * 1000, 700, signal);
      return screen(s);
    },
    terminal_close({ id }) {
      const s = get(id);
      killSession(Number(id), s);
      return `Closed terminal ${id}.`;
    },
  };
}

function killSession(id, s) {
  try { require("node:child_process").spawn("taskkill", ["/pid", String(s.p.pid), "/T", "/F"], { windowsHide: true }); } catch {}
  try { s.p.kill(); } catch {}
  sessions.delete(id);
}
export function closeTerminals(owner) { for (const [id, s] of sessions) if (!owner || s.owner === owner) killSession(id, s); }
export function listTerminals() { return [...sessions].map(([id, s]) => ({ id, owner: s.owner, command: s.command, open: s.exited === null })); }

// ---- The user's own terminal panel: one live PowerShell per chat (key), drawn by xterm.js in the page.
// Output is kept (last ~300 KB) so the panel shows it again after switching chats or reloading.
const userTerms = new Map(); // id -> { p, key, buf, subs:Set, exited }
export function userTermOpen({ key, cwd, env, cols = 100, rows = 24 }) {
  if (!pty) throw new Error("The terminal part isn't installed (" + loadError + ").");
  for (const [id, s] of userTerms) if (s.key === key && s.exited === null) { try { s.p.resize(cols, rows); } catch {} return id; }
  const p = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"], {
    name: "xterm-256color", cols: Math.min(400, Math.max(20, cols)), rows: Math.min(200, Math.max(5, rows)), cwd, env: { ...env, TERM: "xterm-256color" },
  });
  const id = "u" + nextId++;
  const s = { p, key, buf: "", subs: new Set(), exited: null };
  userTerms.set(id, s);
  p.onData((d) => { s.buf += d; if (s.buf.length > 300000) s.buf = s.buf.slice(-200000); for (const f of s.subs) f({ type: "out", data: d }); });
  p.onExit(({ exitCode }) => { s.exited = exitCode ?? 0; for (const f of s.subs) f({ type: "exit", code: s.exited }); setTimeout(() => userTerms.delete(id), 60000); });
  return id;
}
export function userTermSubscribe(id, fn) {
  const s = userTerms.get(id); if (!s) return null;
  fn({ type: "out", data: s.buf }); if (s.exited !== null) fn({ type: "exit", code: s.exited });
  s.subs.add(fn); return () => s.subs.delete(fn);
}
export function userTermInput(id, data) { const s = userTerms.get(id); if (!s || s.exited !== null) return false; s.p.write(String(data)); return true; }
export function userTermResize(id, cols, rows) { const s = userTerms.get(id); if (!s || s.exited !== null) return false; try { s.p.resize(Math.min(400, Math.max(20, cols | 0)), Math.min(200, Math.max(5, rows | 0))); } catch {} return true; }
export function userTermClose(id) {
  const s = userTerms.get(id); if (!s) return false;
  try { require("node:child_process").spawn("taskkill", ["/pid", String(s.p.pid), "/T", "/F"], { windowsHide: true }); } catch {}
  try { s.p.kill(); } catch {}
  userTerms.delete(id); return true;
}
export function closeUserTerms() { for (const id of [...userTerms.keys()]) userTermClose(id); }
export const ptyReady = () => Boolean(pty);
