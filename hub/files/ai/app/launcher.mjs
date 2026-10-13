// Safe mode: starts the app and keeps an eye on it.
// Only right after an update (marked by update-pending.json, which the app removes once it
// has started properly): if the new version crashes before it's up, the backup of the old
// version is put back, a note is left for the app to show, and the app is started again.
// No packages needed, so it works even if the app's own files are broken.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.FABRA_DATA || join(homedir(), ".fabra-labs-ai");
const backup = join(dataDir, "update-backup");
const pendingFile = join(dataDir, "update-pending.json");
const ver = (d) => { try { return JSON.parse(readFileSync(join(d, "version.json"), "utf8")).version; } catch { return null; } };
function copyTree(from, to) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) { mkdirSync(b, { recursive: true }); copyTree(a, b); }
    else writeFileSync(b, readFileSync(a));
  }
}
// Is the pending update for this very folder and version?
function pendingHere() {
  try { const p = JSON.parse(readFileSync(pendingFile, "utf8")); return p.dir === here && p.version === ver(here) ? p : null; } catch { return null; }
}

function run() {
  let tail = "";
  const child = spawn(process.execPath, [join(here, "server.mjs")], { cwd: here, env: process.env, stdio: ["ignore", "inherit", "pipe"], windowsHide: true });
  child.stderr.on("data", (d) => { process.stderr.write(d); tail = (tail + d).slice(-4000); });
  child.on("exit", (code) => {
    if (code === 0) return process.exit(0);
    try { mkdirSync(dataDir, { recursive: true }); appendFileSync(join(dataDir, "crash.log"), `\n--- ${new Date().toISOString()} version ${ver(here)} exit ${code}\n${tail}`); } catch {}
    const p = pendingHere(), old = ver(backup);
    if (p && old && old === p.from && existsSync(join(backup, "server.mjs"))) {
      try {
        copyTree(backup, here);
        rmSync(pendingFile, { force: true });
        writeFileSync(join(dataDir, "safe-mode.json"), JSON.stringify({ failed: p.version, restored: old, at: Date.now(), error: tail.trim().split("\n").slice(-6).join("\n") }));
        return run();
      } catch {}
    }
    process.exit(code || 1);
  });
}
run();
