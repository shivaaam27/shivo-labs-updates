// Beam away from home: keeps this PC connected to the Cloudflare relay (beam/relay) and passes the phone's requests on
// to Beam's engine on this PC, the way the TV app does. The phone reaches the PC from any network, and finds it at home
// without relying on beam.local. The relay stores nothing; the engine checks each phone's key (beam.py, via_relay).
//   - one websocket to wss://<relay>/pc/<id>?s=<secret> (id, secret in %APPDATA%\Beam\relay.json, made by the engine)
//   - for each request: the same call to the engine on 127.0.0.1, with the secret only this hub knows ("local")
//   - bodies go in pieces, at most WINDOW unanswered, so a big file never piles up in memory on either side
// Reconnects by itself (a PC waking from sleep, Wi-Fi changing); a connection that has gone quiet is dropped and redone.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import http from "node:http";
import { checkPhone } from "./id.mjs";

const HOME = () => join(process.env.APPDATA || homedir(), "Beam");
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const WINDOW = 24;
const PASS = ["content-type", "content-length", "x-name", "x-ext", "x-beam-id", "x-beam-name", "x-beam-kind", "x-beam-key"];
const BACK = ["content-type", "content-length", "content-disposition", "x-remaining", "x-kind"];

export const relayState = { connected: false, since: 0, id: "", url: "", error: "" };

const frame = (rid, bytes) => { const out = Buffer.allocUnsafe(4 + bytes.length); out.writeUInt32BE(rid, 0); bytes.copy(out, 4); return out; };

export function startBeamRelay() {
  let ws = null, stopped = false, delay = 2000, quiet = 0, beat = 0, tries = 0;
  const reqs = new Map();   // request number -> { http, out, resumeRes, ended }

  function connect() {
    if (stopped) return;
    const port = (readJson(join(HOME(), "config.json")) || {}).port || 8765;
    const id = readJson(join(HOME(), "relay.json"));
    if (!id?.id || !id.secret || !id.local) {   // the engine writes it when it first starts
      relayState.error = "waiting for Beam to start"; return setTimeout(connect, 3000);
    }
    relayState.id = id.id; relayState.url = id.url;
    const url = id.url.replace(/^http/, "ws") + `/pc/${id.id}?s=${id.secret}`;
    let sock;
    try { sock = new WebSocket(url); } catch (e) { relayState.error = String(e.message || e); return setTimeout(connect, delay = Math.min(delay * 2, 60000)); }
    sock.binaryType = "arraybuffer";
    ws = sock; let openedAt = 0;
    const drop = () => {
      if (ws !== sock) return; ws = null;
      relayState.connected = false; clearInterval(beat);
      for (const [, r] of reqs) { try { r.http.destroy(); } catch {} }
      reqs.clear();
      if (openedAt && Date.now() - openedAt > 30000) delay = 2000;
      if (!stopped) setTimeout(connect, delay = Math.min(delay * 1.7, 30000));
    };
    sock.onopen = () => {
      openedAt = Date.now(); relayState.connected = true; relayState.since = openedAt; relayState.error = ""; quiet = Date.now();
      // the relay answers "ping" without waking; if nothing comes back for a minute the connection is dead: redo it
      clearInterval(beat);
      beat = setInterval(() => {
        if (Date.now() - quiet > 70000) { try { sock.close(); } catch {} return drop(); }
        try { sock.send("ping"); } catch {}
      }, 25000);
    };
    sock.onclose = drop;
    sock.onerror = (e) => { relayState.error = String(e.message || "connection failed"); };
    sock.onmessage = (ev) => {
      quiet = Date.now();
      if (typeof ev.data === "string") {
        if (ev.data === "pong") return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        control(sock, m, port, id.local);
      } else {
        const buf = Buffer.from(ev.data);
        if (buf.length < 5) return;
        const rid = buf.readUInt32BE(0), r = reqs.get(rid);
        if (!r) return;
        r.http.write(buf.subarray(4), () => { try { sock.send(JSON.stringify({ t: "ack", rid })); } catch {} });
      }
    };
  }

  function control(sock, m, port, local) {
    const send = (o) => { try { sock.send(JSON.stringify(o)); } catch {} };
    if (m.t === "req" && m.path === "/pass-key") return passKey(m, port, local, send);
    if (m.t === "req") {
      const headers = { "x-beam-relay": local };
      for (const k of PASS) if (m.headers?.[k]) headers[k] = String(m.headers[k]);
      const hasBody = m.method === "POST" || m.method === "PUT";
      if (!hasBody) delete headers["content-length"];
      const rq = http.request({ host: "127.0.0.1", port, method: m.method, path: m.path + (m.query ? "?" + m.query : ""), headers }, (res) => {
        const out = {};
        for (const k of BACK) if (res.headers[k]) out[k] = res.headers[k];
        send({ t: "res", rid: m.rid, status: res.statusCode, headers: out });
        r.res = res;
        res.on("data", (chunk) => {
          for (let i = 0; i < chunk.length; i += 256 * 1024) {
            try { sock.send(frame(m.rid, chunk.subarray(i, i + 256 * 1024))); } catch {}
            if (++r.out >= WINDOW) res.pause();
          }
        });
        res.on("end", () => { send({ t: "end", rid: m.rid }); reqs.delete(m.rid); });
        res.on("error", () => { send({ t: "err", rid: m.rid, error: "The PC stopped sending" }); reqs.delete(m.rid); });
      });
      const r = { http: rq, out: 0, res: null };
      reqs.set(m.rid, r);
      rq.on("error", (e) => {
        if (!reqs.has(m.rid)) return;   // (already answered)
        send({ t: "err", rid: m.rid, error: e.code === "ECONNREFUSED" ? "Beam is not running on the PC" : "The PC closed the connection (" + (e.code || e.message) + ")" });
        reqs.delete(m.rid);
      });
      if (!hasBody) rq.end();
    } else if (m.t === "end") {
      reqs.get(m.rid)?.http.end();
    } else if (m.t === "ack") {
      const r = reqs.get(m.rid);
      if (r) { r.out = Math.max(0, r.out - 1); if (r.out < WINDOW && r.res?.isPaused()) r.res.resume(); }
    } else if (m.t === "cancel") {
      const r = reqs.get(m.rid); if (r) { try { r.http.destroy(); r.res?.destroy(); } catch {} reqs.delete(m.rid); }
    }
  }

  // a phone of this PC's company that has never met it on the home Wi-Fi (UNIFY-PLAN.md, 23 Oct 2026): it signs
  // "beam.<this PC's relay id>.<ts>" with its Shivo Labs device key; checked here against shivo-id, it gets its key from
  // the engine (/passkey, a call only the hub can make), as it would on the home Wi-Fi
  async function passKey(m, port, local, send) {
    const q = new URLSearchParams(m.query || "");
    const answer = (status, body) => { const b = Buffer.from(JSON.stringify(body)); send({ t: "res", rid: m.rid, status, headers: { "content-type": "application/json" } }); try { ws?.send(frame(m.rid, b)); } catch {} send({ t: "end", rid: m.rid }); };
    try {
      const phone = await checkPhone(q.get("device") || "", q.get("ts") || "", q.get("sig") || "", `beam.${relayState.id}`);
      if (!phone) return answer(403, { error: "This phone isn't part of this PC's Shivo Labs" });
      const r = await fetch(`http://127.0.0.1:${port}/passkey?bid=${encodeURIComponent(q.get("bid") || "")}&bkind=${encodeURIComponent(q.get("bkind") || "")}&bname=${encodeURIComponent(q.get("bname") || phone.name || "")}`,
        { method: "POST", headers: { "x-beam-hub": local }, signal: AbortSignal.timeout(8000) });
      answer(r.status, await r.json().catch(() => ({ error: "Beam on the PC answered " + r.status })));
    } catch (e) { answer(502, { error: "The PC couldn't check this phone: " + (e.message || e) }); }
  }

  connect();
  return () => { stopped = true; try { ws?.close(); } catch {} clearInterval(beat); };
}

// when a phone is removed on the PC, its key stops working (the engine deletes it)
export async function revokeKey(did) {
  const port = (readJson(join(HOME(), "config.json")) || {}).port || 8765;
  const id = readJson(join(HOME(), "relay.json"));
  if (!id?.local) return;
  await fetch(`http://127.0.0.1:${port}/revoke?did=${encodeURIComponent(did)}`, { method: "POST", headers: { "x-beam-hub": id.local }, signal: AbortSignal.timeout(4000) }).catch(() => {});
}
