// Git panel: read-only repository info (branch, changed files, pull request) and safe
// "experiment copies" (git worktrees). Nothing here commits, pushes or deletes unsaved work
// unless the user explicitly says so. Commands run without a shell, so folder and file names
// can never be interpreted as commands.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const baseEnv = () => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0", // looking at a repo must never block the user's own git commands
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
  LC_ALL: "C", // English messages, so the few we recognise are reliable
});
const GH = () => process.env.FABRA_GH || "gh"; // overridable for tests

// Runs a program and always resolves: { ok, out, err, code, missing }.
function run(cmd, args, cwd, { timeout = 20000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, env: baseEnv(), timeout, maxBuffer, windowsHide: true, encoding: "utf8" }, (e, out, err) => {
      if (!e) return done({ ok: true, out: out || "", err: err || "", code: 0 });
      done({
        ok: false, out: out || "", err: String(err || e.message || "").trim(),
        code: typeof e.code === "number" ? e.code : null, missing: e.code === "ENOENT", timedOut: Boolean(e.killed),
      });
    });
  });
}
// -c core.fsmonitor=false: a repository's own settings must not be able to start programs just
// because we looked at it.
const git = (cwd, args, opts) => run("git", ["-c", "core.quotepath=false", "-c", "core.fsmonitor=false", ...args], cwd, opts);

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// One spelling per folder (Windows short names like SHIVAM~1, capitals, slashes) so paths can be compared.
const norm = (p) => {
  let r = resolve(String(p || ""));
  // If the folder is gone, canonicalise the nearest folder that still exists and keep the rest.
  const tail = [];
  for (let cur = r; ; ) {
    try { r = join(realpathSync.native(cur), ...tail.reverse()); break; } catch { /* go up one level */ }
    const up = dirname(cur);
    if (up === cur) break;
    tail.push(basename(cur)); cur = up;
  }
  return r.replace(/[\\/]+$/, "").toLowerCase();
};
const winPath = (p) => resolve(p); // git prints C:/x/y; this gives C:\x\y
const firstLine = (s) => String(s || "").split(/\r?\n/).find((l) => l.trim()) || "";

// "a b c d" -> first n pieces, then the remainder untouched (file names can contain spaces).
function splitN(s, n) {
  const out = [];
  let rest = s;
  for (let i = 0; i < n; i++) {
    const k = rest.indexOf(" ");
    if (k < 0) break;
    out.push(rest.slice(0, k)); rest = rest.slice(k + 1);
  }
  out.push(rest);
  return out;
}

const KIND = { M: "modified", T: "modified", A: "added", D: "deleted", R: "renamed", C: "copied" };
function parseStatus(text) {
  const r = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith("# branch.head ")) r.branch = p.slice(14);
    else if (p.startsWith("# branch.oid ")) r.oid = p.slice(13);
    else if (p.startsWith("# branch.upstream ")) r.upstream = p.slice(18);
    else if (p.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(p);
      if (m) { r.ahead = Number(m[1]); r.behind = Number(m[2]); }
    } else if (p[0] === "1" && p[1] === " ") {
      const f = splitN(p, 8);
      r.files.push(entry(f[1], f[8]));
    } else if (p[0] === "2" && p[1] === " ") {
      const f = splitN(p, 9);
      const e = entry(f[1], f[9]);
      e.orig = parts[++i] || "";
      r.files.push(e);
    } else if (p[0] === "u" && p[1] === " ") {
      const f = splitN(p, 10);
      r.files.push({ path: f[10], x: "U", y: "U", kind: "conflict", staged: false, unstaged: true });
    } else if (p[0] === "?" && p[1] === " ") {
      r.files.push({ path: p.slice(2), x: "?", y: "?", kind: "new", staged: false, unstaged: true });
    }
  }
  return r;
}
function entry(xy, path) {
  const x = xy[0], y = xy[1];
  const code = x !== "." ? x : y;
  return { path, x, y, kind: KIND[code] || "modified", staged: x !== ".", unstaged: y !== "." };
}

async function toplevel(cwd) {
  if (!cwd || !isDir(cwd)) return { error: "That folder doesn't exist." };
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.missing) return { gitMissing: true };
  if (!r.ok) {
    if (/not a git repository/i.test(r.err)) return { notRepo: true };
    if (/dubious ownership|safe\.directory/i.test(r.err))
      return { error: "Git doesn't trust this folder yet (it belongs to another Windows user). Run `git config --global --add safe.directory` for it in the terminal." };
    return { error: firstLine(r.err) || "Git couldn't read this folder." };
  }
  return { root: winPath(r.out.trim()) };
}

async function readStatus(root) {
  const r = await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], { timeout: 30000 });
  if (!r.ok) return { error: firstLine(r.err) || "Couldn't read the status." };
  return parseStatus(r.out);
}

function parseWorktrees(text) {
  const list = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { cur = null; continue; }
    const [k, ...rest] = line.split(" ");
    const v = rest.join(" ");
    if (k === "worktree") { cur = { path: winPath(v), branch: null, head: "", detached: false, locked: false, prunable: false, bare: false }; list.push(cur); }
    else if (!cur) continue;
    else if (k === "HEAD") cur.head = v.slice(0, 7);
    else if (k === "branch") cur.branch = v.replace(/^refs\/heads\//, "");
    else if (k === "detached") cur.detached = true;
    else if (k === "locked") cur.locked = true;
    else if (k === "prunable") cur.prunable = true;
    else if (k === "bare") cur.bare = true;
  }
  return list;
}
async function listWorktrees(root) {
  const r = await git(root, ["worktree", "list", "--porcelain"]);
  return r.ok ? parseWorktrees(r.out) : [];
}

// Strip any password or token from a remote address and work out the GitHub page, if it is one.
function remoteInfo(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let web = null, shown = s;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?\/?$/i.exec(s);
  const https = /^https?:\/\/(?:[^@/]+@)?github\.com\/(.+?)(?:\.git)?\/?$/i.exec(s);
  const slug = (ssh || https)?.[1];
  if (slug && /^[\w.-]+\/[\w.-]+$/.test(slug)) { web = "https://github.com/" + slug; shown = "github.com/" + slug; }
  else shown = s.replace(/\/\/[^@/]+@/, "//");
  return { shown, web };
}

// ---------- Public functions

// light: only branch + change count (for the small chip in the header).
export async function gitInfo(cwd, { light = false } = {}) {
  const top = await toplevel(cwd);
  if (!top.root) return { isRepo: false, ...top };
  const root = top.root;
  const st = await readStatus(root);
  if (st.error) return { isRepo: true, root, error: st.error };
  const hasCommits = !/^0+$/.test(st.oid || "") && st.oid !== "(initial)";
  const base = {
    isRepo: true, root, name: basename(root),
    branch: st.branch === "(detached)" ? null : st.branch, detached: st.branch === "(detached)",
    head: hasCommits ? String(st.oid).slice(0, 7) : "", hasCommits,
    upstream: st.upstream, ahead: st.ahead, behind: st.behind,
    total: st.files.length,
  };
  if (light) return base;

  const [num, log, remote, wts] = await Promise.all([
    hasCommits ? git(root, ["diff", "HEAD", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"]) : { ok: false, out: "" },
    hasCommits ? git(root, ["log", "-n", "6", "--pretty=format:%h%x1f%s%x1f%an%x1f%ar%x1e"]) : { ok: false, out: "" },
    git(root, ["config", "--get", "remote.origin.url"]),
    listWorktrees(root),
  ]);

  // numstat -z: "add<TAB>del<TAB>path", or for a rename "add<TAB>del<TAB>" followed by the old and new path.
  const counts = new Map();
  const recs = num.out.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(recs[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") { path = recs[i + 2] || ""; i += 2; }
    counts.set(path, { add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]) });
  }
  const files = st.files.slice(0, 300).map((f) => ({ ...f, ...(counts.get(f.path) || {}) }));
  const commits = log.out.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => {
    const [hash, subject, author, when] = c.split("\x1f");
    return { hash, subject, author, when };
  });

  // How many uncommitted changes does each experiment copy have? (small, parallel)
  const cur = norm(root);
  const worktrees = await Promise.all(wts.filter((w) => !w.bare).slice(0, 12).map(async (w, i) => {
    let dirty = 0;
    const exists = isDir(w.path);
    if (exists && !w.prunable) {
      const s = await git(w.path, ["status", "--porcelain", "--untracked-files=normal"], { timeout: 15000 });
      dirty = s.ok ? s.out.split(/\r?\n/).filter(Boolean).length : 0;
    }
    return { ...w, main: i === 0, current: norm(w.path) === cur, exists, dirty };
  }));

  return { ...base, files, truncated: st.files.length > files.length, commits, remote: remoteInfo(remote.ok ? remote.out : ""), worktrees };
}

// Pull request for the current branch, using the GitHub CLI (gh) the user already has signed in.
export async function prStatus(cwd) {
  const top = await toplevel(cwd);
  if (!top.root) return { state: "unknown" };
  const gh = GH();
  const ghArgs = ["pr", "view", "--json", "number,title,state,url,isDraft,reviewDecision,mergeable,baseRefName,statusCheckRollup"];
  // (a .mjs stand-in for gh can be used by the self-tests)
  const r = /\.m?js$/i.test(gh) ? await run(process.execPath, [gh, ...ghArgs], top.root, { timeout: 25000 }) : await run(gh, ghArgs, top.root, { timeout: 25000 });
  if (r.missing) return { state: "unavailable", reason: "gh-missing" };
  if (!r.ok) {
    const msg = r.err;
    if (/no pull requests? found/i.test(msg)) return { state: "none" };
    if (/none of the git remotes|no git remotes|unknown owner/i.test(msg)) return { state: "none", note: "no-github-remote" };
    if (/not logged in|not logged into|run:\s+gh auth login|HTTP 401|bad credentials|authentication (failed|required)|GH_TOKEN/i.test(msg)) return { state: "unavailable", reason: "gh-auth" };
    if (r.timedOut) return { state: "unavailable", reason: "timeout" };
    return { state: "unavailable", reason: "error", message: firstLine(msg).slice(0, 200) };
  }
  let j;
  try { j = JSON.parse(r.out); } catch { return { state: "unavailable", reason: "error", message: "gh gave an answer I couldn't read." }; }
  const checks = { pass: 0, fail: 0, pending: 0 };
  for (const c of j.statusCheckRollup || []) {
    const v = String(c.conclusion || c.state || c.status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) checks.pass++;
    else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"].includes(v)) checks.fail++;
    else checks.pending++;
  }
  const url = typeof j.url === "string" && /^https:\/\/github\.com\//i.test(j.url) ? j.url : null;
  return {
    state: String(j.state || "").toLowerCase(), // open | merged | closed
    number: j.number, title: String(j.title || ""), url, draft: Boolean(j.isDraft),
    review: String(j.reviewDecision || "").toLowerCase(), // approved | changes_requested | review_required | ""
    mergeable: String(j.mergeable || "").toLowerCase(), // mergeable | conflicting | unknown
    base: j.baseRefName || "", checks,
  };
}

// The changes in one file, as a unified diff. Only files git reports as changed are allowed.
export async function fileDiff(cwd, path) {
  const top = await toplevel(cwd);
  if (!top.root) return { error: "Not a git folder." };
  const root = top.root;
  const st = await readStatus(root);
  if (st.error) return { error: st.error };
  const f = st.files.find((x) => x.path === path);
  if (!f) return { error: "That file has no changes any more. Refresh the list." };
  const cap = (s) => (s.length > 400000 ? s.slice(0, 400000) + "\n… (cut off: the change is very large)" : s);

  if (f.kind === "new") {
    if (path.endsWith("/")) { // a whole new folder
      const l = await git(root, ["ls-files", "--others", "--exclude-standard", "--", path]);
      const names = l.out.split(/\r?\n/).filter(Boolean);
      return { text: `@@ new folder, ${names.length} file${names.length === 1 ? "" : "s"} @@\n` + names.slice(0, 200).map((n) => "+" + n).join("\n"), file: f };
    }
    const full = join(root, path);
    try {
      const size = statSync(full).size;
      if (size > 300000) return { text: "@@ new file, too large to show @@", file: f };
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return { text: "@@ new file (not text) @@", file: f };
      const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return { text: `@@ new file, ${lines.length} lines @@\n` + lines.map((l) => "+" + l).join("\n"), file: f };
    } catch (e) { return { error: "Couldn't read the file: " + e.message }; }
  }

  const paths = f.orig ? ["--", f.orig, f.path] : ["--", f.path];
  const flags = ["--no-color", "--no-ext-diff", "--no-textconv", "-U3", "-M"];
  let r = await git(root, ["diff", "HEAD", ...flags, ...paths]);
  if (!r.ok) r = await git(root, ["diff", "--cached", ...flags, ...paths]); // a repository with no commits yet
  if (!r.ok) return { error: firstLine(r.err) || "Couldn't get the changes." };
  if (f.orig && !r.out.includes("@@")) return { text: `@@ renamed from ${f.orig}, contents unchanged @@`, file: f };
  return { text: cap(r.out), file: f };
}

const slugOf = (name) => String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "").replace(/\.lock$/, "").slice(0, 40);

// Make an experiment copy: a new folder next to the project, on its own new branch.
export async function addWorktree(cwd, name) {
  const top = await toplevel(cwd);
  if (!top.root) return { error: "This isn't a git folder." };
  const slug = slugOf(name);
  if (!slug) return { error: "Give the copy a short name, using letters or numbers." };
  const branch = "experiment/" + slug;
  const ok = await git(top.root, ["check-ref-format", "--branch", branch]);
  if (!ok.ok) return { error: "That name can't be used. Try something simpler." };
  const wts = await listWorktrees(top.root);
  const main = wts[0]?.path || top.root;
  const dir = join(dirname(main), basename(main) + "-experiments", slug);
  if (existsSync(dir)) return { error: `A folder named "${slug}" already exists there. Pick another name.` };
  const head = await git(top.root, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return { error: "This project has no commits yet, so there's nothing to copy. Make a first commit, then try again." };
  const r = await git(top.root, ["worktree", "add", "-b", branch, dir, "HEAD"], { timeout: 120000 });
  if (!r.ok) {
    if (/already exists/i.test(r.err) && /branch/i.test(r.err)) return { error: `A branch called ${branch} already exists. Pick another name.` };
    return { error: firstLine(r.err.split("\n").filter((l) => !/^Preparing worktree/.test(l)).join("\n")) || "Git couldn't make the copy." };
  }
  return { ok: true, path: winPath(dir), branch };
}

// Remove an experiment copy. Refuses the main folder, the folder you're in, and locked copies.
// Without `force` git itself refuses if the copy holds changes that aren't saved anywhere else.
export async function removeWorktree(cwd, path, force = false) {
  const top = await toplevel(cwd);
  if (!top.root) return { error: "This isn't a git folder." };
  const wts = await listWorktrees(top.root);
  const i = wts.findIndex((w) => norm(w.path) === norm(path));
  if (i < 0) return { error: "That copy isn't part of this project." };
  const w = wts[i];
  if (i === 0) return { error: "That's the main project folder, not an experiment copy." };
  if (norm(w.path) === norm(top.root)) return { error: "You're looking at this copy right now. Open the main folder first." };
  if (w.locked) return { error: "This copy is locked, so it can't be removed here." };
  const mainRoot = wts[0].path;

  if (w.prunable || !isDir(w.path)) { // the folder is already gone; just forget it
    const p = await git(mainRoot, ["worktree", "prune"]);
    if (!p.ok) return { error: firstLine(p.err) || "Couldn't clean up." };
  } else {
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), w.path];
    const r = await git(mainRoot, args, { timeout: 120000 });
    if (!r.ok) {
      if (/modified or untracked files|contains modified/i.test(r.err)) return { error: "This copy has changes that aren't saved anywhere else.", dirty: true };
      if (/permission denied|being used by another process|in use/i.test(r.err))
        return { error: "Windows says something is still using this folder (VS Code, a terminal or a dev server?). Close it and try again." };
      return { error: firstLine(r.err) || "Git couldn't remove the copy." };
    }
  }
  // Tidy the branch too, but only an experiment branch and only if git says it's safe (never -D).
  let branchDeleted = false;
  if (w.branch && w.branch.startsWith("experiment/")) {
    const b = await git(mainRoot, ["branch", "-d", w.branch]);
    branchDeleted = b.ok;
  }
  return { ok: true, branch: w.branch, branchDeleted };
}
