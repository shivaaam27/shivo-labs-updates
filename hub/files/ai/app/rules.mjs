// Permission rules and hooks, in the same format as Claude Code's settings.json.
// Read from (later ones add to earlier): ~/.claude/settings.json, ~/.fabra-labs-ai/settings.json,
// <project>/.claude/settings.json and <project>/.claude/settings.local.json.
//   "permissions": { "allow": ["Bash(npm run test*)"], "ask": ["Edit(src/**)"], "deny": ["Read(.env)"] }
//   "hooks": { "PreToolUse": [{ "matcher": "Bash|Edit", "hooks": [{ "type": "command", "command": "..." }] }] }
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";

// Claude Code tool names -> this app's tool names.
const ALIAS = { Bash: "run_command", PowerShell: "run_command", Edit: "edit_file", MultiEdit: "edit_file", Write: "write_file", Read: "read_file", Glob: "list_files", Grep: "search_files", WebFetch: "web_fetch", WebSearch: "web_search", Task: "delegate_task", Agent: "delegate_task", TodoWrite: "update_plan" };
const REVERSE = {}; for (const [k, v] of Object.entries(ALIAS)) REVERSE[v] ||= k;

export function settingsFiles(workDir, dataDir) {
  const list = [join(homedir(), ".claude", "settings.json"), join(dataDir, "settings.json")];
  if (workDir) list.push(join(workDir, ".claude", "settings.json"), join(workDir, ".claude", "settings.local.json"));
  return list;
}

export function loadRules(workDir, dataDir) {
  const out = { allow: [], ask: [], deny: [], hooks: {}, files: [], errors: [] };
  for (const f of settingsFiles(workDir, dataDir)) {
    if (!existsSync(f)) continue;
    let s; try { s = JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, "")); } catch (e) { out.errors.push(`${f}: ${e.message}`); continue; }
    out.files.push(f);
    for (const k of ["allow", "ask", "deny"]) for (const r of s.permissions?.[k] || []) out[k].push(String(r));
    for (const [ev, groups] of Object.entries(s.hooks || {})) (out.hooks[ev] ||= []).push(...(Array.isArray(groups) ? groups : []));
  }
  return out;
}

const glob = (pat) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*") + "$", "i");

function matches(rule, name, input, workDir) {
  const m = /^([\w-]+)(?:\((.*)\))?$/s.exec(rule.trim()); if (!m) return false;
  const tool = ALIAS[m[1]] || m[1];
  if (tool !== name && !(tool.endsWith("*") && name.startsWith(tool.slice(0, -1)))) return false;
  const pat = m[2]; if (pat === undefined || pat === "" || pat === "*") return true;
  if (name === "run_command") {
    const cmd = String(input.command || "").trim();
    const p = pat.endsWith(":*") ? pat.slice(0, -2) + "*" : pat;
    return new RegExp("^" + p.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") + "$", "i").test(cmd);
  }
  if (name === "web_fetch" && pat.startsWith("domain:")) {
    try { const h = new URL(String(input.url)).hostname; const d = pat.slice(7); return h === d || h.endsWith("." + d); } catch { return false; }
  }
  const raw = input.path ?? input.url ?? input.query ?? input.pattern;
  if (raw === undefined) return false;
  if (name === "web_search" || name === "web_fetch") return glob(pat).test(String(raw));
  const abs = resolve(workDir, String(raw)).replace(/\\/g, "/");
  let p = pat.replace(/\\/g, "/");
  if (p.startsWith("~/")) p = homedir().replace(/\\/g, "/") + p.slice(1);
  if (/^[A-Za-z]:\//.test(p) || p.startsWith("//")) return glob(p).test(abs);
  const rel = relative(workDir, abs.replace(/\//g, "\\")).replace(/\\/g, "/");
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  p = p.replace(/^\.?\//, "");
  return glob(p).test(rel) || (!p.includes("/") && glob(p).test(rel.split("/").pop()));
}

// "deny" | "ask" | "allow" | null (no rule applies). Deny wins, then ask, then allow.
export function decide(rules, name, input, workDir) {
  for (const k of ["deny", "ask", "allow"]) {
    const r = rules[k].find((x) => matches(x, name, input || {}, workDir));
    if (r) return { decision: k, rule: r };
  }
  return null;
}

// Run the hooks for one event. Returns { block, reason, context }.
// A hook blocks by exiting with code 2 (its error output is the reason) or by printing
// {"decision":"block","reason":"..."}; anything else it prints is passed on as context.
export async function runHooks(rules, event, payload, { workDir, toolName } = {}) {
  const groups = rules.hooks[event] || [];
  const result = { block: false, reason: "", context: "" };
  for (const g of groups) {
    if (toolName && g.matcher && g.matcher !== "*") {
      let re; try { re = new RegExp("^(?:" + g.matcher + ")$"); } catch { continue; }
      if (!re.test(toolName) && !re.test(REVERSE[toolName] || "")) continue;
    }
    for (const h of g.hooks || []) {
      if (h.type !== "command" || !h.command) continue;
      const r = await new Promise((done) => {
        const child = exec(h.command, { cwd: workDir, timeout: (Number(h.timeout) || 60) * 1000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: workDir, FABRA_PROJECT_DIR: workDir } },
          (err, stdout, stderr) => done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
        child.stdin?.end(JSON.stringify({ hook_event_name: event, cwd: workDir, ...payload, tool_name: payload.tool_name && (REVERSE[payload.tool_name] || payload.tool_name) }));
      });
      let j = null; try { j = JSON.parse(r.stdout.trim()); } catch {}
      if (r.code === 2 || j?.decision === "block" || j?.hookSpecificOutput?.permissionDecision === "deny") {
        result.block = true;
        result.reason += (r.stderr.trim() || j?.reason || j?.hookSpecificOutput?.permissionDecisionReason || "Blocked by a hook.") + "\n";
      } else if (r.stdout.trim() && !j) result.context += r.stdout.trim() + "\n";
      else if (j?.hookSpecificOutput?.additionalContext) result.context += j.hookSpecificOutput.additionalContext + "\n";
    }
  }
  result.reason = result.reason.trim(); result.context = result.context.trim();
  return result;
}
