// Settings → GitHub & command line: which tools are installed, whether GitHub is signed in,
// the git name/email, and a GitHub sign-in that works without a terminal (browser code or token).
import { execFile, spawn } from "node:child_process";

const GH = () => process.env.FABRA_GH || "gh"; // overridable for tests (same as git.mjs)
// A .mjs stand-in for gh (tests) runs through node.
const gh = (args) => (/\.mjs$/i.test(GH()) ? [process.execPath, [GH(), ...args]] : [GH(), args]);
const runGh = (args, opt) => run(...gh(args), opt);
const run = (cmd, args, { input, timeout = 15000 } = {}) => new Promise((done) => {
  let child;
  try {
    child = execFile(cmd, args, { windowsHide: true, timeout, encoding: "utf8", shell: /\.(cmd|bat)$/i.test(cmd) && !args.length }, (err, out, errOut) =>
      done({ ok: !err, code: err?.code ?? 0, out: String(out || ""), err: String(errOut || ""), missing: err?.code === "ENOENT" }));
  } catch (e) { return done({ ok: false, out: "", err: e.message, missing: true }); }
  if (input !== undefined) child.stdin.end(input);
});
const firstLine = (s) => String(s || "").trim().split(/\r?\n/)[0] || "";

// gh auth status prints to stderr on older versions and stdout on newer ones.
export function parseGhStatus(text) {
  const t = String(text || "");
  const acct = /Logged in to (\S+) (?:account|as) (\S+)/i.exec(t);
  const scopes = /Token scopes:\s*(.+)/i.exec(t)?.[1]?.replace(/'/g, "").split(/,\s*/).filter(Boolean) || [];
  const proto = /Git operations protocol:\s*(\S+)/i.exec(t)?.[1] || "";
  return acct ? { signedIn: true, host: acct[1], user: acct[2].replace(/[()]/g, ""), scopes, protocol: proto } : { signedIn: false };
}

export async function cliStatus() {
  const [gh, ghAuth, git, name, email, node, python, npm, winget] = await Promise.all([
    runGh(["--version"]),
    runGh(["auth", "status", "--hostname", "github.com"]),
    run("git", ["--version"]),
    run("git", ["config", "--global", "user.name"]),
    run("git", ["config", "--global", "user.email"]),
    run(process.execPath, ["--version"]),
    run("python", ["--version"]),
    run("cmd.exe", ["/d", "/c", "npm", "--version"]),
    run("winget", ["--version"]),
  ]);
  const auth = gh.missing ? { signedIn: false } : parseGhStatus(ghAuth.out + "\n" + ghAuth.err);
  return {
    gh: gh.missing ? null : firstLine(gh.out).replace(/^gh version /, ""),
    github: auth,
    git: git.missing ? null : firstLine(git.out).replace(/^git version /, ""),
    gitName: firstLine(name.out), gitEmail: firstLine(email.out),
    tools: [["Node.js", node], ["Python", python], ["npm", npm], ["winget", winget]].map(([n, r]) => ({ name: n, version: r.ok ? firstLine(r.out + r.err).replace(/^Python /, "") : null })),
  };
}

// ---- GitHub sign-in in the browser (device code). One at a time.
// gh words the code line differently between versions ("First copy your one-time code: ABCD-1234" on
// older ones, "! One-time code (ABCD-1234) copied to clipboard" on newer ones), so match the code itself.
export function parseDeviceCode(text) {
  const t = String(text || "");
  return (/one-time code\W{1,6}([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(t) || /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(t))?.[1] || "";
}
let login = null; // { child, code, url, state: "waiting"|"done"|"failed", message, log }
export function loginState() {
  if (!login) return { state: "idle" };
  const { code, url, state, message } = login; return { state, code, url, message };
}
export function startWebLogin() {
  if (login?.state === "waiting") return loginState();
  login = { code: "", url: "https://github.com/login/device", state: "waiting", message: "", log: "" };
  const me = login;
  let child;
  try {
    child = spawn(...gh(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "repo,workflow,read:org,gist"]),
      { windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1", BROWSER: "none" } });
  } catch (e) { Object.assign(me, { state: "failed", message: "Couldn't start gh: " + e.message }); return loginState(); }
  me.child = child;
  const take = (d) => {
    me.log += d.toString();
    me.code = parseDeviceCode(me.log) || me.code;
    const u = /(https:\/\/github\.com\/login\/device)/.exec(me.log); if (u) me.url = u[1];
  };
  child.stdout.on("data", take); child.stderr.on("data", take);
  child.stdin.end("\n"); // "Press Enter to open github.com in your browser" (when it asks)
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15 * 60 * 1000);
  child.on("error", (e) => { clearTimeout(timer); Object.assign(me, { state: "failed", message: e.code === "ENOENT" ? "GitHub CLI (gh) isn't installed." : e.message }); });
  child.on("close", async (code) => {
    clearTimeout(timer);
    if (me.state !== "waiting") return;
    if (code === 0) { await runGh(["auth", "setup-git"]); Object.assign(me, { state: "done", message: "Signed in." }); }
    else Object.assign(me, { state: "failed", message: firstLine(me.log.split(/\r?\n/).filter((l) => /error|fail|denied|expired/i.test(l)).pop() || "Sign-in didn't finish.") });
  });
  return loginState();
}
export function cancelWebLogin() {
  if (login?.state === "waiting") { try { login.child?.kill(); } catch {} login.state = "failed"; login.message = "Cancelled."; }
  return loginState();
}

export async function tokenLogin(token) {
  token = String(token || "").trim();
  if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token)) throw new Error("That doesn't look like a GitHub token (they start with ghp_ or github_pat_).");
  const r = await runGh(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], { input: token + "\n", timeout: 30000 });
  if (r.missing) throw new Error("GitHub CLI (gh) isn't installed.");
  if (!r.ok) throw new Error(firstLine(r.err || r.out) || "GitHub didn't accept the token.");
  await runGh(["auth", "setup-git"]);
}

export async function logout() {
  const r = await runGh(["auth", "logout", "--hostname", "github.com"], { input: "y\n" });
  if (!r.ok && !/not logged in/i.test(r.err + r.out)) throw new Error(firstLine(r.err || r.out) || "Couldn't sign out.");
}

export async function setIdentity(name, email) {
  name = String(name || "").trim(); email = String(email || "").trim();
  if (name.length > 100 || email.length > 200 || /["\r\n]/.test(name + email)) throw new Error("That name or email isn't valid.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That email doesn't look right.");
  if (name) { const r = await run("git", ["config", "--global", "user.name", name]); if (!r.ok) throw new Error(firstLine(r.err) || "git refused the name."); }
  if (email) { const r = await run("git", ["config", "--global", "user.email", email]); if (!r.ok) throw new Error(firstLine(r.err) || "git refused the email."); }
}
