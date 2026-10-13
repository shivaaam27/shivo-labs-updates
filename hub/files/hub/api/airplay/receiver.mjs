// AirPlay screen-mirroring receiver in plain Node: the iPhone's Control Center > Screen Mirroring >
// "Shivo Labs" streams its screen here over Wi-Fi. Works with any iOS version that can mirror to an
// Apple TV (this speaks the Apple TV 3 protocol, like UxPlay and LetsView).
//
// What happens, in order (protocol details follow UxPlay, lib/raop_handlers.h, GPL-3.0):
//   mDNS      _airplay._tcp + _raop._tcp adverts (mdns.mjs)
//   RTSP 7000 GET /info, POST /pair-setup + /pair-verify (ed25519/x25519, AES-CTR),
//             POST /fp-setup x2 (FairPlay, playfair.mjs), SETUP (keys, timing port, then the
//             video stream type 110), RECORD, GET/SET_PARAMETER, POST /feedback (heartbeat), TEARDOWN
//   TCP 7100  the video: 128-byte header + payload. Codec packets (type 1) carry SPS/PPS in clear;
//             video packets (type 0) are AES-128-CTR encrypted, NAL units with 4-byte lengths.
//   UDP 7011  timing (NTP-style requests to the phone every 3 s)
//   UDP 6000/6001 audio (accepted and dropped for now)
// Each frame goes out through onFrame({ codec, key, ts, data }) as Annex-B (start codes).
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostname, homedir } from "node:os";
import * as plist from "./bplist.mjs";
import { playfairDecrypt, fpSetupReply } from "./playfair.mjs";
import { createResponder, txtData } from "./mdns.mjs";

const VERSION = "220.68", MODEL = "AppleTV3,2", PI = "2e388006-13ba-4041-9a67-25dd4a43d536";
const FEATURES = [0x5A7FFEE6, 0x0];           // bit 7 screen mirroring, bit 27 legacy pairing
const DEFAULT_PORTS = { rtsp: 7000, mirror: 7100, timing: 7011, audioData: 6000, audioControl: 6001 };
const SC = Buffer.from([0, 0, 0, 1]);
const hex = (n) => "0x" + (n >>> 0).toString(16).toUpperCase();

// ---- identity: a stable device id and a stable ed25519 key, so the phone sees the same receiver every time
function identity(dataDir, name) {
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, "airplay-key.pem");
  let priv;
  try { priv = crypto.createPrivateKey(readFileSync(keyFile, "utf8")); }
  catch { priv = crypto.generateKeyPairSync("ed25519").privateKey; try { writeFileSync(keyFile, priv.export({ format: "pem", type: "pkcs8" })); } catch {} }
  const pub = crypto.createPublicKey(priv);
  const pk = Buffer.from(pub.export({ format: "jwk" }).x, "base64url");
  const h = crypto.createHash("sha256").update("shivo-labs-mirror:" + hostname() + (name === "Shivo Labs" ? "" : ":" + name)).digest();
  const mac = Buffer.from(h.subarray(0, 6)); mac[0] = (mac[0] & 0xfe) | 0x02;   // a private (locally administered) address
  return { priv, pk, mac };
}
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex"), ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const rawX = (k) => k.export({ format: "der", type: "spki" }).subarray(-32);
const sha512 = (...parts) => { const h = crypto.createHash("sha512"); for (const p of parts) h.update(p); return h.digest(); };
const ctr = (key, iv) => crypto.createCipheriv("aes-128-ctr", key, iv);

export function createReceiver({ name = "Shivo Labs", dataDir = join(process.env.LOCALAPPDATA || homedir(), "Shivo Labs", "mirror"),
  width = 1920, height = 1080, fps = 60, ports = {}, discover = true, log = () => {}, onFrame = () => {}, onState = () => {} } = {}) {
  const PORTS = { ...DEFAULT_PORTS, ...ports };
  const id = identity(dataDir, name);
  const deviceId = [...id.mac].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
  const features = `${hex(FEATURES[0])},${hex(FEATURES[1])}`;
  const featuresNum = (BigInt(FEATURES[1]) << 32n) | BigInt(FEATURES[0]);
  const pkHex = id.pk.toString("hex");
  const airplayTxt = txtData({ deviceid: deviceId, features, pw: "false", flags: "0x4", model: MODEL, pk: pkHex, pi: PI, srcvers: VERSION, vv: "2" });
  const raopTxt = txtData({ ch: "2", cn: "0,1,2,3", da: "true", et: "0,3,5", vv: "2", ft: features, am: MODEL, md: "0,1,2", rhd: "5.6.0.0",
    pw: "false", sr: "44100", ss: "16", sv: "false", tp: "UDP", txtvers: "1", sf: "0x4", vs: VERSION, vn: "65537", pk: pkHex });
  const hostLabel = "Shivo-Labs-" + id.mac.toString("hex").slice(-6).toUpperCase();
  const mdns = createResponder({ host: hostLabel, log, services: [
    { instance: name, type: "_airplay._tcp.local", port: PORTS.rtsp, txt: airplayTxt },
    { instance: `${id.mac.toString("hex").toUpperCase()}@${name}`, type: "_raop._tcp.local", port: PORTS.rtsp, txt: raopTxt },
  ] });

  const st = { running: false, client: null, phase: "idle", width: 0, height: 0, codec: null, paused: false };
  const setState = (patch) => { Object.assign(st, patch); onState({ ...st }); };
  let rtspServer = null, mirrorServer = null, timingSock = null, audioSocks = [], active = null;   // active: the connection that is mirroring

  // ---------- RTSP
  function handleConn(sock) {
    const conn = { sock, remote: (sock.remoteAddress || "").replace(/^::ffff:/, ""), buf: Buffer.alloc(0), ecdh: null, ourX: null, theirX: null, theirEd: null,
      verified: false, keyMsg: null, aesKey: null, timingPort: 0, timer: null, streamKey: null, streamIv: null, lastFeedback: Date.now(), client: null };
    sock.setNoDelay(true);
    sock.on("data", (d) => {
      conn.buf = Buffer.concat([conn.buf, d]);
      for (;;) {
        const end = conn.buf.indexOf("\r\n\r\n");
        if (end < 0) { if (conn.buf.length > 65536) sock.destroy(); return; }
        const head = conn.buf.toString("latin1", 0, end).split("\r\n");
        const [method, url, proto] = head[0].split(" ");
        const headers = {};
        for (const l of head.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        const len = Number(headers["content-length"] || 0);
        if (conn.buf.length < end + 4 + len) return;
        const body = conn.buf.subarray(end + 4, end + 4 + len);
        conn.buf = conn.buf.subarray(end + 4 + len);
        let reply;
        try { reply = request(conn, method, url, proto || "RTSP/1.0", headers, body); }
        catch (e) { log(`${method} ${url}: ${e.message}`); reply = { code: 500, text: "Internal Server Error" }; }
        if (!reply) continue;
        const h = [`${reply.proto || proto || "RTSP/1.0"} ${reply.code || 200} ${reply.text || "OK"}`];
        const hdrs = { ...(reply.headers || {}) };
        if (headers.cseq !== undefined) { hdrs["Server"] = "AirTunes/" + VERSION; hdrs["CSeq"] = headers.cseq; if (method !== "RECORD" && !hdrs["Audio-Jack-Status"]) hdrs["Audio-Jack-Status"] = "connected; type=digital"; }
        const out = reply.body ? Buffer.from(reply.body) : null;
        hdrs["Content-Length"] = String(out ? out.length : 0);
        for (const [k, v] of Object.entries(hdrs)) h.push(`${k}: ${v}`);
        sock.write(Buffer.concat([Buffer.from(h.join("\r\n") + "\r\n\r\n", "latin1"), ...(out ? [out] : [])]));
        if (reply.close) { sock.end(); return; }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => { if (active === conn) endSession("the phone disconnected"); clearInterval(conn.timer); });
  }

  const bin = (obj) => ({ body: plist.build(obj), headers: { "Content-Type": "application/x-apple-binary-plist" } });
  const octets = (b) => ({ body: b, headers: { "Content-Type": "application/octet-stream" } });

  function request(conn, method, url, proto, headers, body) {
    const path = (url || "").split("?")[0];
    if (method !== "POST" || path !== "/feedback") log(`${conn.remote} ${method} ${url}`);
    if (method === "GET" && path === "/info") return info(headers, body, url);
    if (method === "OPTIONS") return { headers: { Public: "SETUP, RECORD, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER" } };
    if (method === "POST" && path === "/pair-setup") { if (body.length !== 32) return { code: 400, text: "Bad Request" }; return octets(id.pk); }
    if (method === "POST" && path === "/pair-verify") return pairVerify(conn, body);
    if (method === "POST" && path === "/fp-setup") { const r = fpSetupReply(body, conn); return r ? octets(r) : { code: 501, text: "Not Implemented" }; }
    if (method === "POST" && path === "/feedback") { conn.lastFeedback = Date.now(); return {}; }
    if (method === "POST" && path === "/audioMode") return {};
    if (method === "SETUP") return setup(conn, headers, body);
    if (method === "RECORD") return { headers: { "Audio-Latency": "11025", "Audio-Jack-Status": "connected; type=analog" } };
    if (method === "GET_PARAMETER") {
      if (body.toString("latin1").startsWith("volume")) return { body: Buffer.from("volume: 0.000000\r\n"), headers: { "Content-Type": "text/parameters" } };
      return {};
    }
    if (method === "SET_PARAMETER" || method === "FLUSH") return {};
    if (method === "TEARDOWN") {
      let types = [];
      try { types = (plist.parse(body).streams || []).map((s) => Number(s.type)); } catch {}
      if (!types.length || types.includes(110)) { if (active === conn) endSession("mirroring stopped on the phone"); }
      return { headers: { Connection: "close" } };
    }
    return { code: 501, text: "Not Implemented" };
  }

  function info(headers, body, url) {
    let qualifier = null;
    if ((headers["content-type"] || "").includes("application/x-apple-binary-plist")) {
      try { qualifier = plist.parse(body).qualifier?.[0]; } catch {}
    }
    if (headers.cseq === undefined) qualifier = /txtAirPlay/.test(url) ? "txtAirPlay" : /txtRAOP/.test(url) ? "txtRAOP" : null;
    const res = {};
    if (qualifier === "txtAirPlay") res.txtAirPlay = airplayTxt;
    if (qualifier === "txtRAOP") res.txtRAOP = raopTxt;
    if (headers["content-type"]) return bin(res);
    Object.assign(res, { deviceID: deviceId, macAddress: deviceId, pk: id.pk, features: featuresNum, name, pi: PI, vv: 2, statusFlags: 68,
      keepAliveLowPower: 1, sourceVersion: VERSION, keepAliveSendStatsAsBody: true, model: MODEL });
    if (headers.cseq === undefined) return bin(res);
    Object.assign(res, {
      initialVolume: new plist.Real(0),
      audioLatencies: [100, 101].map((type) => ({ type, inputLatencyMicros: 0, audioType: "default", outputLatencyMicros: false })),
      audioFormats: [100, 101].map((type) => ({ audioOutputFormats: 0x3fffffc, type, audioInputFormats: 0x3fffffc })),
      displays: [{ uuid: "e0ff8a27-6738-3d56-8a16-cc53aacee925", widthPhysical: 0, heightPhysical: 0, width, height, widthPixels: width, heightPixels: height,
        rotation: false, refreshRate: new plist.Real(1 / fps), maxFPS: fps, overscanned: false, features: 14 }],
    });
    return bin(res);
  }

  function pairVerify(conn, body) {
    if (body.length < 4) return { code: 400, text: "Bad Request" };
    if (body[0] === 1) {
      if (body.length !== 4 + 32 + 32) return { code: 400, text: "Bad Request" };
      conn.theirX = Buffer.from(body.subarray(4, 36)); conn.theirEd = Buffer.from(body.subarray(36, 68));
      const ours = crypto.generateKeyPairSync("x25519");
      conn.ourX = rawX(ours.publicKey);
      conn.ecdh = crypto.diffieHellman({ privateKey: ours.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, conn.theirX]), format: "der", type: "spki" }) });
      const sig = crypto.sign(null, Buffer.concat([conn.ourX, conn.theirX]), id.priv);
      const c = ctr(sha512("Pair-Verify-AES-Key", conn.ecdh).subarray(0, 16), sha512("Pair-Verify-AES-IV", conn.ecdh).subarray(0, 16));
      return octets(Buffer.concat([conn.ourX, c.update(sig)]));
    }
    if (body[0] === 0) {
      if (body.length !== 4 + 64 || !conn.ecdh) return { code: 400, text: "Bad Request" };
      const c = ctr(sha512("Pair-Verify-AES-Key", conn.ecdh).subarray(0, 16), sha512("Pair-Verify-AES-IV", conn.ecdh).subarray(0, 16));
      c.update(Buffer.alloc(64));                              // the first 64 bytes of keystream were used for our signature
      const sig = c.update(body.subarray(4, 68));
      const ok = crypto.verify(null, Buffer.concat([conn.theirX, conn.ourX]), crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, conn.theirEd]), format: "der", type: "spki" }), sig);
      if (!ok) { log("pairing: the phone's signature didn't check out"); return { code: 470, text: "Connection Authorization Required", close: true }; }
      conn.verified = true;
      return octets(Buffer.alloc(0));
    }
    return { code: 400, text: "Bad Request" };
  }

  function setup(conn, headers, body) {
    let req = {};
    try { req = plist.parse(body); } catch { return { code: 400, text: "Bad Request" }; }
    const res = {};
    if (Buffer.isBuffer(req.ekey) && Buffer.isBuffer(req.eiv)) {
      if (!conn.keyMsg) { log("SETUP before the FairPlay exchange"); return { code: 400, text: "Bad Request" }; }
      takeOver(conn);
      let key = playfairDecrypt(conn.keyMsg, req.ekey.subarray(0, 72));
      const ua = headers["user-agent"] || "";
      if (conn.ecdh && !/AirMyPC/.test(ua)) key = sha512(key, conn.ecdh).subarray(0, 16);
      conn.aesKey = Buffer.from(key);
      conn.timingPort = Number(req.timingPort || 0);
      conn.client = { name: req.name || "iPhone", model: req.model || "", deviceId: req.deviceID || "", osVersion: req.osBuildVersion || req.sourceVersion || "" };
      active = conn;
      startTiming(conn);
      setState({ client: conn.client, phase: "connecting", width: 0, height: 0, codec: null, paused: false });
      log(`${conn.client.name} (${conn.client.model}) is connecting from ${conn.remote}`);
      res.timingPort = PORTS.timing;
      res.eventPort = 0;
    }
    if (Array.isArray(req.streams)) {
      res.streams = [];
      for (const s of req.streams) {
        const type = Number(s.type);
        if (type === 110) {
          if (!conn.aesKey) return { code: 400, text: "Bad Request" };
          if (active !== conn) { takeOver(conn); active = conn; startTiming(conn); setState({ client: conn.client, phase: "connecting", paused: false }); }
          const sid = BigInt.asUintN(64, BigInt(s.streamConnectionID ?? 0)).toString();
          conn.streamKey = sha512("AirPlayStreamKey" + sid, conn.aesKey).subarray(0, 16);
          conn.streamIv = sha512("AirPlayStreamIV" + sid, conn.aesKey).subarray(0, 16);
          res.streams.push({ dataPort: PORTS.mirror, type: 110 });
        } else if (type === 96) {
          res.streams.push({ dataPort: PORTS.audioData, controlPort: PORTS.audioControl, type: 96 });
        } else return { code: 400, text: "Bad Request", close: true };
      }
    }
    return bin(res);
  }

  // ---------- timing: ask the phone for its clock every 3 s (it expects a receiver that does)
  function startTiming(conn) {
    clearInterval(conn.timer);
    if (!conn.timingPort || !timingSock) return;
    const ask = () => {
      const p = Buffer.alloc(32); p[0] = 0x80; p[1] = 0xd2; p[2] = 0x00; p[3] = 0x07;
      const now = Date.now(), sec = Math.floor(now / 1000) + 2208988800, frac = Math.floor(((now % 1000) / 1000) * 2 ** 32);
      p.writeUInt32BE(sec >>> 0, 24); p.writeUInt32BE(frac >>> 0, 28);
      timingSock.send(p, conn.timingPort, conn.remote, () => {});
    };
    ask(); conn.timer = setInterval(ask, 3000);
  }

  // one phone at a time: a new one takes over (like UxPlay -nohold)
  function takeOver(conn) {
    if (!active || active === conn) return;
    const old = active; endSession("another device took over"); try { old.sock.destroy(); } catch {}
  }

  function endSession(why) {
    const c = active; active = null;
    if (c) clearInterval(c.timer);
    log(why);
    setState({ phase: "idle", client: null, paused: false });
  }

  // ---------- the video connection
  function handleMirror(sock) {
    const conn = active;
    if (!conn || !conn.streamKey || (sock.remoteAddress || "").replace(/^::ffff:/, "") !== conn.remote) { sock.destroy(); return; }
    const cipher = ctr(conn.streamKey, conn.streamIv);   // one continuous keystream for the whole connection
    let buf = Buffer.alloc(0), codec = null, pending = null;   // pending: SPS/PPS waiting for the next picture
    setState({ phase: "streaming" });
    sock.setNoDelay(true);
    sock.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 128) {
        const size = buf.readUInt32LE(0);
        if (size > 64 * 1024 * 1024) { log("video: bad packet size"); sock.destroy(); return; }
        if (buf.length < 128 + size) break;
        const head = buf.subarray(0, 128), payload = buf.subarray(128, 128 + size);
        buf = buf.subarray(128 + size);
        try { packet(head, payload); } catch (e) { log("video: " + e.message); }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => { if (active === conn && st.phase === "streaming") setState({ phase: "connected" }); });

    function packet(head, payload) {
      const type = head[4], option = head[6];
      const ntp = head.readBigUInt64LE(8);
      const ts = Number(((ntp >> 32n) * 1000n + (((ntp & 0xffffffffn) * 1000n) >> 32n)) & 0xffffffffn);
      if (type === 0) {
        const plain = cipher.update(payload);
        // 4-byte big-endian lengths -> start codes
        const nals = [];
        for (let i = 0; i + 4 <= plain.length;) {
          const n = plain.readUInt32BE(i);
          if (n <= 0 || i + 4 + n > plain.length) { log("video: a picture didn't decode (key mismatch?)"); return; }
          nals.push(plain.subarray(i + 4, i + 4 + n)); i += 4 + n;
        }
        const key = nals.some((n) => codec === "h265" ? (((n[0] >> 1) & 0x3f) >= 16 && ((n[0] >> 1) & 0x3f) <= 21) : (n[0] & 0x1f) === 5);
        const parts = [];
        if (pending) { parts.push(pending); pending = null; }
        for (const n of nals) parts.push(SC, n);
        if (codec) onFrame({ codec, key: key || parts.length > nals.length * 2, ts, data: Buffer.concat(parts) });
        if (st.phase !== "streaming" || st.paused) setState({ phase: "streaming", paused: false });
      } else if (type === 1) {
        const w = head.readFloatLE(56), h = head.readFloatLE(60);
        if (option === 0x56 || option === 0x5e) { setState({ paused: true }); }
        if (!payload.length) { log("video: the phone wants a codec this receiver didn't offer"); return; }
        if (payload.subarray(4, 8).toString("latin1") === "hvc1") {
          codec = "h265";
          let p = 0x75; const sets = [];
          for (const marker of [0xa0, 0xa1, 0xa2]) {          // VPS, SPS, PPS
            if (payload[p] !== marker) { log("video: unexpected H.265 setup data"); return; }
            const n = payload.readUInt16BE(p + 3); p += 5; sets.push(SC, payload.subarray(p, p + n)); p += n;
          }
          pending = Buffer.concat(sets);
        } else {
          codec = "h264";
          const spsLen = payload.readUInt16BE(6), sps = payload.subarray(8, 8 + spsLen);
          const ppsLen = payload.readUInt16BE(9 + spsLen), pps = payload.subarray(11 + spsLen, 11 + spsLen + ppsLen);
          pending = Buffer.concat([SC, sps, SC, pps]);
        }
        if (w && h && (w !== st.width || h !== st.height || codec !== st.codec)) { log(`video: ${codec.toUpperCase()} ${w}x${h}`); }
        setState({ width: w, height: h, codec });
      }
      // type 2 (old keep-alive) and 5 (stream statistics) carry nothing we need
    }
  }

  return {
    get state() { return { ...st }; },
    deviceId,
    start() {
      if (st.running) return;
      rtspServer = net.createServer(handleConn);
      rtspServer.on("error", (e) => log(`port ${PORTS.rtsp}: ${e.message}`));
      rtspServer.listen(PORTS.rtsp, "0.0.0.0");
      mirrorServer = net.createServer(handleMirror);
      mirrorServer.on("error", (e) => log(`port ${PORTS.mirror}: ${e.message}`));
      mirrorServer.listen(PORTS.mirror, "0.0.0.0");
      timingSock = dgram.createSocket("udp4");
      timingSock.on("error", (e) => log(`timing port: ${e.message}`));
      timingSock.on("message", () => {});
      timingSock.bind(PORTS.timing, "0.0.0.0");
      audioSocks = [PORTS.audioData, PORTS.audioControl].map((port) => {
        const s = dgram.createSocket("udp4"); s.on("error", () => {}); s.on("message", () => {}); s.bind(port, "0.0.0.0"); return s;
      });
      if (discover) mdns.start();
      setState({ running: true, phase: "idle" });
      log(`Ready: "${name}" (${deviceId})`);
      // a phone that stops sending its heartbeat for 20 s is gone
      this._watch = setInterval(() => { if (active && Date.now() - active.lastFeedback > 20000) { const c = active; endSession("the phone stopped answering"); try { c.sock.destroy(); } catch {} } }, 5000);
    },
    stop() {
      if (!st.running) return;
      clearInterval(this._watch);
      if (active) { try { active.sock.destroy(); } catch {} endSession("receiver stopped"); }
      if (discover) mdns.stop();
      for (const s of [rtspServer, mirrorServer]) try { s.close(); } catch {}
      for (const s of [timingSock, ...audioSocks]) try { s.close(); } catch {}
      rtspServer = mirrorServer = timingSock = null; audioSocks = [];
      setState({ running: false, phase: "idle" });
    },
  };
}
