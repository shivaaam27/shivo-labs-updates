// Cable-free iPhone pairing (iOS 27), the Windows half (x-tools/wifi/README.md). The iPhone starts the pairing itself:
// it lists computers that announce "_remotepairing-pairable-host._tcp" on the Wi-Fi under Settings > Developer >
// Paired Macs > Other Devices. shivo-wifi (in X Tools' WSL distro) does the pairing, but the WSL side can't send
// announcements onto the home network, so this file does that (mDNS, plain Node) and passes the phone's connection
// through to shivo-wifi's port. The pairing itself (PIN, keys) stays in shivo-wifi.
//   startPairHost({ name, onEvent }) -> { stop() }; events: {announce}, {step}, {pin}, {paired}, {error}, {ok}
//   node hub/api/pairhost.mjs "Shivo Labs PC"   (a test: prints the events)
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";

const MDNS = "224.0.0.251";
const PAIR_DIR = "/root/.config/shivo-wifi";   // where the cable pairing goes too (wifi.sh)

// this PC's addresses on real networks (not WSL/Docker's own, loopback, link-local or VPN ranges)
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== "IPv4" || a.internal) continue;
    if (/^(169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a.address)) continue;
    out.push(a.address);
  }
  return out;
}

// ---------- DNS messages (just what mDNS answers need)
const label = (name) => Buffer.concat([...name.replace(/\.$/, "").split(".").map((p) => { const b = Buffer.from(p, "utf8"); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
function rr(name, type, flush, ttl, data) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(flush ? 0x8001 : 1, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(data.length, 8);
  return Buffer.concat([label(name), h, data]);
}
function response(records) {
  const h = Buffer.alloc(12); h.writeUInt16BE(0x8400, 2); h.writeUInt16BE(records.length, 6);
  return Buffer.concat([h, ...records]);
}
// the names asked about in a query (no compression is used by queries for these, except in rare cases: skipped)
function questions(msg) {
  const out = [];
  try {
    const qd = msg.readUInt16BE(4); let i = 12;
    const read = (at, depth = 0) => {
      const parts = [];
      while (at < msg.length) {
        const n = msg[at];
        if (n === 0) { at++; break; }
        if ((n & 0xc0) === 0xc0) { if (depth < 5) parts.push(read(((n & 0x3f) << 8) | msg[at + 1], depth + 1).name); at += 2; return { name: parts.join("."), at }; }
        parts.push(msg.toString("utf8", at + 1, at + 1 + n)); at += n + 1;
      }
      return { name: parts.join("."), at };
    };
    for (let q = 0; q < qd; q++) { const r = read(i); out.push(r.name.toLowerCase()); i = r.at + 4; }
  } catch {}
  return out;
}

export function startPairHost({ name = "Shivo Labs PC", onEvent = () => {} } = {}) {
  let stopped = false, sock = null, relay = null, timer = 0, ad = null;
  const ips = lanAddresses();
  const host = "ShivoLabsPC-" + Math.random().toString(16).slice(2, 8) + ".local";

  const recordsFor = (ip) => {
    const type = ad.type.replace(/\.$/, ""), inst = `${ad.instance}.${type}`;
    const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, ad.winPort >> 8, ad.winPort & 255]), label(host)]);
    const txt = Buffer.concat(ad.txt.map(([k, v]) => { const b = Buffer.from(`${k}=${v}`, "utf8"); return Buffer.concat([Buffer.from([b.length]), b]); }));
    return [
      rr(type, 12, false, 4500, label(inst)),
      rr("_services._dns-sd._udp.local", 12, false, 4500, label(type)),
      rr(inst, 33, true, 120, srv),
      rr(inst, 16, true, 4500, txt),
      rr(host, 1, true, 120, Buffer.from(ip.split(".").map(Number))),
    ];
  };
  const announce = () => {
    if (!sock || !ad) return;
    for (const ip of ips) { try { sock.setMulticastInterface(ip); sock.send(response(recordsFor(ip)), 5353, MDNS); } catch {} }
  };

  // 1. shivo-wifi in WSL: tells us its port and what to announce, then does the pairing
  const p = spawn("wsl.exe", ["-d", "FabraLabs", "-u", "root", "--", "env", "SHIVO_ANNOUNCE=windows", "/usr/local/bin/shivo-wifi", "host", name, PAIR_DIR],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.announce) start(m.announce); else onEvent(m);
    }
  });
  p.on("exit", () => stop());

  // 2. a port on Windows that passes the phone's connection to shivo-wifi (WSL's ports are on 127.0.0.1 here)
  function start(a) {
    relay = net.createServer((c) => {
      const w = net.connect(a.port, "127.0.0.1");
      c.pipe(w); w.pipe(c);
      c.on("error", () => w.destroy()); w.on("error", () => c.destroy());
    });
    relay.listen(0, () => {
      ad = { ...a, winPort: relay.address().port };
      onEvent({ announce: { name, port: ad.winPort, addresses: ips } });
      // 3. the announcement, and answers whenever the phone asks
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("message", (msg, r) => {
        if (msg.length < 12 || (msg.readUInt16BE(2) & 0x8000)) return;   // only queries
        const want = ad.type.replace(/\.$/, "").toLowerCase();
        if (questions(msg).some((q) => q === want || q.includes(ad.instance.toLowerCase()) || q === "_services._dns-sd._udp.local" || q === host.toLowerCase())) announce();
      });
      sock.on("error", () => {});
      sock.bind(5353, () => { for (const ip of ips) { try { sock.addMembership(MDNS, ip); } catch {} } announce(); });
      timer = setInterval(announce, 5000);
    });
  }

  function stop() {
    if (stopped) return; stopped = true;
    clearInterval(timer);
    try { sock?.close(); } catch {}
    try { relay?.close(); } catch {}
    try { p.kill(); } catch {}
  }
  return { stop };
}

if (process.argv[1] && process.argv[1].endsWith("pairhost.mjs")) {
  const h = startPairHost({ name: process.argv[2] || "Shivo Labs PC", onEvent: (e) => { console.log(JSON.stringify(e)); if (e.ok || e.error) setTimeout(() => process.exit(0), 500); } });
  process.on("SIGINT", () => { h.stop(); process.exit(0); });
}
