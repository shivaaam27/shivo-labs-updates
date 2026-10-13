// Business: our own ERP (business/), shown in the hub. Everything under /api/business/ is handled by
// business/server/api.ts (definitions, records, import, setup, stock movements; see business/FRAME.md).
// It is TypeScript; Node 22.18+ runs it directly (type stripping), so it is loaded only when first used.
// Data: %APPDATA%\Shivo Labs\Business\business.db for the real hub (port 4800), business-test.db for any other port.
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const API = join(here, "..", "..", "business", "server", "api.ts");
export const BUSINESS_DIR = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Shivo Labs", "Business");
const MAX_BODY = 10 * 1024 * 1024; // CSV imports can be a few MB
let api = null;

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  // read to the end even when too large (leaving the loop early would close the connection before the reply)
  for await (const c of req) {
    size += c.length;
    if (size <= MAX_BODY) chunks.push(c);
  }
  if (size > MAX_BODY) return { error: [413, "The data sent is too large (over 10 MB)"] };
  const s = Buffer.concat(chunks).toString("utf8");
  if (!s.trim()) return { body: {} };
  try { return { body: JSON.parse(s) }; } catch { return { error: [400, "The request was not valid JSON"] }; }
}

export async function businessApi(req, res, path) {
  if (path !== "/api/business" && !path.startsWith("/api/business/")) return false;
  if (!api) {
    try {
      const mod = await import(pathToFileURL(API).href);
      // which database: the real one only for the real hub
      const file = join(BUSINESS_DIR, req.socket.localPort === 4800 ? "business.db" : "business-test.db");
      api ??= mod.createApi(file);
    } catch (e) {
      return json(res, 500, { error: `Shivo Labs Business could not start (needs Node 22.18 or newer): ${e.message}` }), true;
    }
  }
  let body;
  if (req.method === "POST") {
    const r = await readBody(req);
    if (r.error) return json(res, r.error[0], { error: r.error[1] }), true;
    body = r.body;
  }
  const url = new URL(req.url, "http://localhost");
  const reply = await api.call({ method: req.method, path, query: url.searchParams, body, headers: req.headers });
  return json(res, reply.status, reply.body), true;
}
