// Restarts the hub after an update: waits until the old hub has let go of its port, starts the new one,
// checks that it answers, and tries again if it doesn't. Runs on its own (started detached by update.mjs).
// Everything it does goes to %LOCALAPPDATA%\Shivo Labs\logs\restart.log.
//   node restart.mjs <port> <path to server.mjs> [<backup folder> <install folder>]
// With a backup (an over-the-air update just replaced files): if the new hub never answers, the backed-up files are
// put back and the old version is started instead.
import net from "node:net";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const port = Number(process.argv[2]) || 4800;
const server = process.argv[3], backup = process.argv[4], root = process.argv[5];
const logDir = join(process.env.LOCALAPPDATA || homedir(), "Shivo Labs", "logs");
const log = (s) => { try { mkdirSync(logDir, { recursive: true }); appendFileSync(join(logDir, "restart.log"), `${new Date().toISOString()}  [${port}] ${s}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portBusy = () => new Promise((ok) => {
  const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); ok(true); });
  s.on("error", () => ok(false)); s.setTimeout(500, () => { s.destroy(); ok(false); });
});
const answers = async () => { try { return (await fetch(`http://localhost:${port}/api/modules`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };

log("restart requested");
// 1. the old hub quits a moment after asking for the restart; wait up to 20 s for its port to be free
for (let i = 0; i < 40 && await portBusy(); i++) await sleep(500);
if (await portBusy()) log("the old hub still holds the port after 20 s; starting anyway (the new one waits and retries)");

const putBack = (from, to) => { for (const e of readdirSync(from, { withFileTypes: true })) { const a = join(from, e.name), b = join(to, e.name); if (e.isDirectory()) { mkdirSync(b, { recursive: true }); putBack(a, b); } else copyFileSync(a, b); } };

// 2. start the new hub; if it doesn't answer, try again (up to 3 times; a 4th time with the old files put back)
for (let attempt = 1; attempt <= (backup ? 4 : 3); attempt++) {
  if (attempt === 4) { try { putBack(backup, root); log('the update did not start: the previous files are back'); } catch (e) { log('putting the previous files back failed: ' + e.message); } }
  const p = spawn(process.execPath, [server, String(port)], { cwd: dirname(server), detached: true, stdio: "ignore", windowsHide: true });
  p.on("error", (e) => log(`couldn't start node: ${e.message}`));
  p.unref();
  log(`attempt ${attempt}: started (pid ${p.pid})`);
  for (let i = 0; i < 30; i++) { await sleep(500); if (await answers()) { log(`attempt ${attempt}: the hub answers. Done.`); process.exit(0); } }
  log(`attempt ${attempt}: no answer within 15 s`);
  try { process.kill(p.pid); } catch {}
  await sleep(2000);
}
log("gave up after 3 attempts; open Shivo Labs from the Desktop to start it");
process.exit(1);
