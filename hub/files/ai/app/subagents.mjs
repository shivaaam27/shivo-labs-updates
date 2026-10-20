// Helper agents for delegate_task, in the same format Claude Code uses for its subagents:
// built-in types (explore, plan, general) and custom ones from .claude/agents/*.md files
// (YAML front matter: name, description, tools, disallowedTools, model, effort, maxTurns,
// background, permissionMode, skills, omitClaudeMd; the text below it is the helper's instructions).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

// Tools a look-only helper gets, and the ones a helper that does work gets.
export const LOOK = ["read_file", "list_files", "search_files", "fetch_url", "search_web"];
export const DO = [...LOOK, "write_file", "edit_file", "notebook_edit", "run_command", "check_process", "wait_for_process", "stop_process", "preview_start"];
const QUIET = new Set([...LOOK, "check_process", "wait_for_process"]); // change nothing

// Claude Code's tool names in a custom agent's "tools:" line, mapped to this app's.
const NAMES = {
  Read: "read_file", Write: "write_file", Edit: "edit_file", MultiEdit: "edit_file", Glob: "list_files", LS: "list_files", Grep: "search_files",
  Bash: "run_command", PowerShell: "run_command", BashOutput: "check_process", KillShell: "stop_process", KillBash: "stop_process",
  WebFetch: "fetch_url", WebSearch: "search_web", NotebookRead: "read_file", NotebookEdit: "notebook_edit",
};
const ALIASES = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };

const unq = (s) => String(s).replace(/^(["'])(.*)\1$/, "$2");
// "Read, Grep" or a YAML list -> ["Read", "Grep"]; null when not given (meaning "inherit all").
export const toList = (v) => v == null || v === "" ? null
  : (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim().replace(/\(.*\)$/, "").trim()).filter(Boolean);

// A small YAML front matter reader: key: value, lists (- item, or [a, b]), and block text (> or |).
export function parseFrontmatter(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(String(text || ""));
  if (!m) return { data: {}, body: String(text || "") };
  const lines = m[1].split(/\r?\n/), data = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1], val = kv[2].replace(/\s+#.*$/, "").trim();
    if (["", ">", "|", ">-", "|-", ">+", "|+"].includes(val)) {
      const items = [], block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^\s*-\s/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        if (!/^\s/.test(lines[i + 1]) && /^[A-Za-z_][\w-]*\s*:/.test(lines[i + 1])) break;
        i++;
        const li = /^\s*-\s+(.*)$/.exec(lines[i]);
        if (li && val === "") items.push(unq(li[1].trim())); else block.push(lines[i].trim());
      }
      data[key] = items.length ? items : val.startsWith("|") ? block.join("\n").trim() : block.filter(Boolean).join(" ").trim();
    } else if (/^\[.*\]$/.test(val)) data[key] = val.slice(1, -1).split(",").map((s) => unq(s.trim())).filter(Boolean);
    else if (/^(true|false)$/i.test(val)) data[key] = /^true$/i.test(val);
    else if (/^\d+$/.test(val)) data[key] = Number(val);
    else data[key] = unq(val);
  }
  return { data, body: m[2] };
}

// Custom helpers: .claude/agents in the project folder and the folders above it (the closest wins),
// then the user's own ~/.claude/agents. Subfolders are read too.
export function loadAgents(workDir, home = homedir()) {
  const roots = [];
  for (let d = workDir; d; d = dirname(d)) { roots.push(join(d, ".claude", "agents")); if (dirname(d) === d) break; }
  roots.push(join(home, ".claude", "agents"));
  const seen = new Set(), out = [];
  const files = (dir, depth = 0, acc = []) => {
    let list = []; try { list = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of list) {
      if (acc.length >= 200) break;
      if (e.isDirectory() && depth < 3 && e.name !== "node_modules" && !e.name.startsWith(".")) files(join(dir, e.name), depth + 1, acc);
      else if (e.isFile() && /\.md$/i.test(e.name)) acc.push(join(dir, e.name));
    }
    return acc;
  };
  for (const root of [...new Set(roots)]) {
    if (!existsSync(root)) continue;
    for (const file of files(root)) {
      let text = ""; try { text = readFileSync(file, "utf8"); } catch { continue; }
      const { data, body } = parseFrontmatter(text);
      const name = String(data.name || basename(file, ".md")).trim();
      const description = String(data.description || "").replace(/\s+/g, " ").trim();
      if (!name || !description || seen.has(name.toLowerCase())) continue; // like Claude Code: a description is required
      seen.add(name.toLowerCase());
      out.push({
        name, description: description.slice(0, 400), file,
        tools: toList(data.tools), disallowedTools: toList(data.disallowedTools) || [],
        model: data.model ? String(data.model).trim() : "", effort: data.effort ? String(data.effort).trim().toLowerCase() : "",
        maxTurns: Number(data.maxTurns) || 0, background: data.background === true,
        permissionMode: data.permissionMode ? String(data.permissionMode).trim() : "",
        skills: toList(data.skills) || [], omitClaudeMd: data.omitClaudeMd === true,
        prompt: String(body || "").trim().slice(0, 30000),
      });
    }
  }
  return out;
}

// Which helper the AI asked for. Custom helpers with the same name as a built-in one win (closest wins).
export function findHelper(want, agents = []) {
  const w = String(want || "").trim().toLowerCase() || "explore";
  const def = agents.find((a) => a.name.toLowerCase() === w);
  if (def) return { kind: "custom", def };
  if (w === "explore" || w === "research") return { kind: "explore" };
  if (w === "plan") return { kind: "plan" };
  if (w === "general" || w === "general-purpose" || w === "worker") return { kind: "general" };
  return { error: `No helper called "${want}". Use explore, plan or general${agents.length ? `, or a custom helper: ${agents.map((a) => a.name).join(", ")}` : ""}.` };
}

// The tool names a helper may use. mcpNames: the chat's connector tools (a custom helper can name a
// whole connector with mcp__name). readOnly: plan mode, or permissionMode: plan.
export function helperToolNames(found, mcpNames = [], readOnly = false) {
  const isMcp = (w) => /^mcp__/i.test(w);
  const mcpMatch = (w, n) => n === w || n.startsWith(w + "__");
  let names;
  if (found.kind === "explore" || found.kind === "plan") names = [...LOOK];
  else if (found.kind === "general") names = [...DO, ...mcpNames];
  else {
    const want = found.def.tools;
    if (!want) names = [...DO, ...mcpNames];
    else {
      names = [];
      for (const w of want) {
        if (isMcp(w)) names.push(...mcpNames.filter((n) => mcpMatch(w, n)));
        else { const n = NAMES[w] || w; if (DO.includes(n) || n === "notebook_edit") names.push(n); }
      }
    }
    const no = found.def.disallowedTools || [];
    names = names.filter((n) => !no.some((w) => (isMcp(w) ? mcpMatch(w, n) : (NAMES[w] || w) === n)));
    if (/^plan$/i.test(found.def.permissionMode)) readOnly = true;
  }
  if (readOnly) names = names.filter((n) => QUIET.has(n));
  return [...new Set(names)];
}
export const changesThings = (names) => names.some((n) => !QUIET.has(n));

// The model a helper uses: its own (sonnet / opus / haiku / fable, a full id, or provider:model) when
// that can be used here, otherwise the chat's model.
export function helperModel(found, chatModel, { models = [], canUse = () => true } = {}) {
  const raw = String(found.def?.model || "").trim(), m = raw.toLowerCase();
  if (!m || m === "inherit") return chatModel;
  const fam = /opus|sonnet|haiku|fable/.exec(m)?.[0];
  const id = ALIASES[m] || (models.includes(m) ? m : null) || (m.includes(":") ? raw : null) || (fam ? ALIASES[fam] : null);
  return id && canUse(id) ? id : chatModel;
}

// The helper's own instructions. Helpers start fresh: only this, their brief, and the basics.
export function helperSystem(found, { workDir, env = "", memory = [], skillTexts = [] }) {
  const where = `Working folder: ${workDir}. ${env}`.trim();
  if (found.kind === "explore") return `You are a research helper for a coding assistant on Windows. ${where}\n` +
    "Investigate with your tools (several look-only steps in one reply run at the same time), then reply with a concise, specific report: file paths, line numbers, findings. You cannot change anything.";
  if (found.kind === "plan") return `You are a planning helper for a coding assistant on Windows. ${where}\n` +
    "Investigate the code with your read-only tools, then reply with a concrete, numbered plan: which files to change and how, in what order, what to check at the end (build, tests, the browser), and the risks. No code beyond small snippets. You cannot change anything.";
  const base = found.kind === "general"
    ? "You are a helper agent for a coding assistant on Windows. You were given one self-contained job: do it yourself with your tools."
    : found.def.prompt || `You are the "${found.def.name}" helper: ${found.def.description}`;
  const parts = [base, "", where,
    "Work carefully: read files before editing them, keep changes to what the job asks for, and check your work (run the build or tests when there are any).",
    "Commands run in a non-interactive Windows PowerShell: use flags that skip questions (--yes, -Force), and background: true for servers. To find files use list_files, never a recursive Get-ChildItem.",
    "When you're done, reply with a short report for the assistant that sent you (it can't see your steps): what you changed (file paths), what you checked and the result, and anything left or uncertain."];
  if (!found.def?.omitClaudeMd && memory.length) parts.push("\n# Project instructions (CLAUDE.md files; follow them)", ...memory.map((m) => `\n## ${m.path}\n${m.text}`));
  if (skillTexts.length) parts.push("\n# Skills", ...skillTexts);
  return parts.join("\n");
}

// What the main AI is told about helpers.
export function helpersPrompt(agents = []) {
  return [
    "\n# Helpers (delegate_task)",
    "Hand a self-contained job to a helper: it works on its own with a fresh context and returns a written report, so this conversation stays focused. Pick the type with agent:",
    "- explore (default): reads and searches files and the web, changes nothing. For broad research across many files.",
    "- plan: read-only research that ends in a concrete step-by-step plan.",
    "- general: can also create and edit files and run commands, with the same folders, permission checks and undo as you. For a separate piece of work you can describe completely.",
    ...(agents.length ? ["Custom helpers (from .claude/agents; use the name as agent, and pick one when its description fits the job):", ...agents.map((a) => `- ${a.name}: ${a.description}`)] : []),
    "Helpers don't see this conversation: put everything they need in the brief (files, goal, constraints, what to report). Several delegate_task calls in one reply run at the same time; never give two helpers the same files to change. " +
      "With background: true the call returns at once so you can keep working; the report arrives later as an automatic message, and your reply waits for running helpers before it ends. Check a helper's changes before relying on them.",
  ].join("\n");
}
