// The `fabra` terminal command.
//   fabra              open Shivo Labs AI with the current folder linked
//   fabra "do this"    same, with your request ready in the message box (press Enter to send)
//   fabra <folder>     open with that folder linked
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FABRA_PORT || 4823);
const args = process.argv.slice(2);
if (args[0] === "-h" || args[0] === "--help" || args[0] === "/?") {
  console.log(`Shivo Labs AI
  fabra              open the app with this folder linked
  fabra "request"    same, with your request ready to send
  fabra <folder>     open the app with that folder linked`);
  process.exit(0);
}
let cwd = process.cwd(), prompt = "";
if (args.length === 1 && existsSync(resolve(args[0])) && statSync(resolve(args[0])).isDirectory()) cwd = resolve(args[0]);
else prompt = args.join(" ");

const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/api/update`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
if (!(await up())) {
  console.log("Starting Shivo Labs AI…");
  const start = existsSync(join(here, "launcher.mjs")) ? "launcher.mjs" : "server.mjs";
  spawn(process.execPath, [join(here, start)], { cwd: here, env: process.env, detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}
const url = `http://localhost:${PORT}/?cwd=${encodeURIComponent(cwd)}` + (prompt ? `&prompt=${encodeURIComponent(prompt)}` : "");
const profile = join(homedir(), ".fabra-labs-ai", "edge");
spawn("cmd", ["/c", "start", "", "msedge", `--app=${url}`, "--window-size=1280,860", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
const ps = join(here, "set-taskbar-id.ps1");
if (existsSync(ps)) spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps], { detached: true, stdio: "ignore", windowsHide: true }).unref();
console.log(`Opened Shivo Labs AI in ${cwd}`);
