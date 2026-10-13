// A small mDNS (Bonjour) responder in plain Node: makes "Shivo Labs" appear in the iPhone's
// Screen Mirroring list. It answers questions on 224.0.0.251:5353 for the services it was given
// and announces them when started. Port 5353 is shared with Windows and Beam (SO_REUSEADDR).
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

const GROUP = "224.0.0.251", PORT = 5353;
const T_A = 1, T_PTR = 12, T_TXT = 16, T_SRV = 33, T_ANY = 255, C_IN = 1, FLUSH = 0x8000;

const lower = (s) => s.toLowerCase();
function encName(name) {
  const parts = name.replace(/\.$/, "").split(".");
  return Buffer.concat([...parts.map((p) => { const b = Buffer.from(p, "utf8"); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
}
// a name whose first label is kept whole (instance names like "Shivo Labs" or "AABB@Shivo Labs")
function encInstance(label, rest) { const b = Buffer.from(label, "utf8"); return Buffer.concat([Buffer.from([b.length]), b, encName(rest)]); }
function readName(buf, at) {
  const labels = []; let jumped = false, end = at, guard = 0;
  while (guard++ < 128) {
    const len = buf[at];
    if (len === undefined) throw new Error("short name");
    if (len === 0) { if (!jumped) end = at + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = at + 2; at = ((len & 0x3f) << 8) | buf[at + 1]; jumped = true; continue; }
    labels.push(buf.toString("utf8", at + 1, at + 1 + len)); at += 1 + len;
  }
  return [labels.join("."), end];
}
function rr(nameBuf, type, flush, ttl, rdata) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(C_IN | (flush ? FLUSH : 0), 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, h, rdata]);
}
export function txtData(obj) {
  return Buffer.concat(Object.entries(obj).map(([k, v]) => { const b = Buffer.from(`${k}=${v}`, "utf8"); return Buffer.concat([Buffer.from([b.length]), b]); }));
}
const ipv4s = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal && !/^169\.254\./.test(i.address));

// services: [{ instance: "Shivo Labs", type: "_airplay._tcp.local", port: 7000, txt: Buffer }]
export function createResponder({ host, services, log = () => {} }) {
  const hostName = `${host}.local`;
  let sock = null, timers = [], stopped = false;

  function records(ip, ttlScale = 1) {
    const ans = [];
    for (const s of services) {
      const inst = encInstance(s.instance, s.type);
      ans.push({ key: lower(s.type), type: T_PTR, buf: rr(encName(s.type), T_PTR, false, 4500 * ttlScale, inst) });
      const srv = Buffer.alloc(6); srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(s.port, 4);
      const instName = lower(`${s.instance}.${s.type}`);
      ans.push({ key: instName, type: T_SRV, buf: rr(inst, T_SRV, true, 120 * ttlScale, Buffer.concat([srv, encName(hostName)])) });
      ans.push({ key: instName, type: T_TXT, buf: rr(inst, T_TXT, true, 4500 * ttlScale, s.txt) });
      ans.push({ key: "_services._dns-sd._udp.local", type: T_PTR, buf: rr(encName("_services._dns-sd._udp.local"), T_PTR, false, 4500 * ttlScale, encName(s.type)) });
    }
    if (ip) ans.push({ key: lower(hostName), type: T_A, buf: rr(encName(hostName), T_A, true, 120 * ttlScale, Buffer.from(ip.split(".").map(Number))) });
    return ans;
  }
  function packet(answers, additionals, id = 0) {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(id, 0); h.writeUInt16BE(0x8400, 2); h.writeUInt16BE(answers.length, 6); h.writeUInt16BE(additionals.length, 10);
    return Buffer.concat([h, ...answers.map((a) => a.buf), ...additionals.map((a) => a.buf)]);
  }
  // pick the local address on the same network as the asker (so the iPhone gets a reachable IP)
  function ipFor(remote) {
    const all = ipv4s();
    if (remote) {
      const r = remote.split(".").map(Number);
      for (const i of all) {
        const a = i.address.split(".").map(Number), m = (i.netmask || "255.255.255.0").split(".").map(Number);
        if (a.every((x, k) => (x & m[k]) === (r[k] & m[k]))) return i.address;
      }
    }
    return all[0]?.address || null;
  }
  // one send at a time: the outgoing interface is a socket setting, and sends finish asynchronously
  const queue = []; let busy = false;
  function send(buf, address, port, iface) { queue.push({ buf, address, port, iface }); pump(); }
  function pump() {
    if (busy || !queue.length) return;
    const s = sock, q = queue.shift();
    if (!s) { queue.length = 0; return; }
    busy = true;
    try { if (q.iface) s.setMulticastInterface(q.iface); } catch {}
    s.send(q.buf, q.port, q.address, (e) => { if (e) log("mDNS send: " + e.message); busy = false; pump(); });
  }
  function announce(ttlScale = 1) {
    for (const i of ipv4s()) send(packet(records(i.address, ttlScale), []), GROUP, PORT, i.address);
  }
  function onQuery(msg, rinfo) {
    if (msg.length < 12) return;
    const id = msg.readUInt16BE(0), flags = msg.readUInt16BE(2), qd = msg.readUInt16BE(4);
    if (flags & 0x8000) return;    // a response, not a question
    let at = 12; const qs = [];
    try {
      for (let i = 0; i < qd; i++) {
        const [name, end] = readName(msg, at);
        const type = msg.readUInt16BE(end), cls = msg.readUInt16BE(end + 2);
        qs.push({ name: lower(name), type, unicast: !!(cls & 0x8000) }); at = end + 4;
      }
    } catch { return; }
    const ip = ipFor(rinfo.address);
    const all = records(ip);
    const answers = [], seen = new Set();
    let wantUnicast = rinfo.port !== PORT;
    for (const q of qs) {
      for (const r of all) {
        if (r.key !== q.name || (q.type !== T_ANY && q.type !== r.type)) continue;
        if (!seen.has(r.buf)) { seen.add(r.buf); answers.push(r); }
      }
      if (q.unicast) wantUnicast = true;
    }
    if (!answers.length) return;
    // helpful extras: for a PTR answer add SRV, TXT and A; for SRV add A
    const extra = [];
    for (const r of all) if (!seen.has(r.buf) && (r.type === T_SRV || r.type === T_TXT || r.type === T_A) &&
      answers.some((a) => a.type === T_PTR || (a.type === T_SRV && r.type === T_A))) extra.push(r);
    const legacy = rinfo.port !== PORT;
    const pkt = packet(answers, extra, legacy ? id : 0);
    if (legacy || wantUnicast) send(pkt, rinfo.address, rinfo.port);
    if (!legacy) send(pkt, GROUP, PORT, ip);
  }

  return {
    start() {
      stopped = false;
      sock = createSocket({ type: "udp4", reuseAddr: true });
      sock.on("message", onQuery);
      sock.on("error", (e) => log("mDNS error: " + e.message));
      sock.bind(PORT, () => {
        for (const i of ipv4s()) { try { sock.addMembership(GROUP, i.address); } catch (e) { log(`mDNS join ${i.address}: ${e.message}`); } }
        try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch {}
        announce();
        timers.push(setTimeout(() => announce(), 1000), setTimeout(() => announce(), 3000));
        // re-announce now and then (Wi-Fi changes, the phone waking up)
        timers.push(setInterval(() => announce(), 60000));
        log(`Discoverable on ${ipv4s().map((i) => i.address).join(", ") || "no network"}`);
      });
    },
    stop() {
      if (stopped || !sock) return; stopped = true;
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers = [];
      try { announce(0); } catch {}                // "goodbye": TTL 0
      const s = sock; setTimeout(() => { if (sock === s) sock = null; try { s.close(); } catch {} }, 500);
    },
    announce,
  };
}
