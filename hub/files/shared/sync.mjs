// The phone app only gets files inside phone/www, so what it shares with the laptop hub is kept in shared/ and copied here.
//   node shared/sync.mjs          copies every shared file to its phone copy
//   node shared/sync.mjs --check  lists files that differ (exit 1); the pre-commit hook runs this
// Change the file in shared/ first; never edit the phone copy.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["chat/chat.js", "chat/chat.css", "chat/demo.js"];   // shared/<file> -> phone/www/<file>
const check = process.argv.includes("--check");
const off = [];
for (const f of FILES) {
  const from = join(root, "shared", f), to = join(root, "phone", "www", f);
  const a = readFileSync(from), b = existsSync(to) ? readFileSync(to) : null;
  if (b && a.equals(b)) continue;
  if (check) { off.push(f); continue; }
  writeFileSync(to, a); console.log("copied shared/" + f + " -> phone/www/" + f);
}
if (check && off.length) { console.error("shared and phone copies differ: " + off.join(", ") + "\nChange the file in shared/, then run: node shared/sync.mjs"); process.exit(1); }
if (!check) console.log("phone copies match shared/");
