// iPhones and iPads plugged into this PC, straight from Apple's own device service (usbmuxd, the "Apple Mobile Device
// Service" that comes with iTunes / Apple Devices, at 127.0.0.1:27015; X Tools needs it anyway). Plain Node, no
// extra programs. Used by X Tools to:
//   - know at once when a device is plugged in or pulled out (watch), and which one (USB only: an iPhone that is
//     only reachable over Wi-Fi doesn't count as plugged in);
//   - tell an iPhone from an iPad and read its name (lockdown GetValue);
//   - list the apps actually installed on it (installation_proxy Browse), so X Tools shows only what's on it.
// Talking to a device uses the pairing this PC already has with it (the "Trust" tap); the pairing record comes from
// usbmuxd itself (ReadPairRecord), as Apple's own tools do.
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import * as bplist from "./airplay/bplist.mjs";

// ---------- XML property lists (usbmuxd and lockdown speak these)
const escX = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function toXml(v) {
  if (Array.isArray(v)) return `<array>${v.map(toXml).join("")}</array>`;
  if (Buffer.isBuffer(v)) return `<data>${v.toString("base64")}</data>`;
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (v && typeof v === "object") return `<dict>${Object.entries(v).map(([k, x]) => `<key>${escX(k)}</key>${toXml(x)}`).join("")}</dict>`;
  return `<string>${escX(v)}</string>`;
}
const plistXml = (v) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${toXml(v)}</plist>`);
const unX = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
export function parsePlist(buf) {
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") return bplist.parse(buf);
  const s = buf.toString("utf8");
  const re = /<(\/?)(dict|array|key|string|integer|real|data|date|true|false)(\s*\/)?>([^<]*)/g;
  const stack = [], keys = []; let root, m;
  const put = (v) => {
    const top = stack[stack.length - 1];
    if (!top) root = v; else if (Array.isArray(top)) top.push(v); else top[keys.pop()] = v;
  };
  while ((m = re.exec(s))) {
    const [, close, tag, self, text] = m;
    if (close) { if (tag === "dict" || tag === "array") put(stack.pop()); continue; }
    if (tag === "dict" || tag === "array") { if (self) put(tag === "dict" ? {} : []); else stack.push(tag === "dict" ? {} : []); continue; }
    if (tag === "true" || tag === "false") { put(tag === "true"); continue; }
    // value tags: the text is right after the opening tag
    if (tag === "key") keys.push(unX(text));
    else if (tag === "string") put(unX(text));
    else if (tag === "integer") put(Number(text));
    else if (tag === "real") put(parseFloat(text));
    else if (tag === "data") put(Buffer.from(text.replace(/\s+/g, ""), "base64"));
    else if (tag === "date") put(new Date(text));
    if (!self) re.lastIndex = s.indexOf(`</${tag}>`, re.lastIndex) + tag.length + 3;
  }
  // with a self-closing value inside a dict, the key was already pushed: nothing else to do
  return root;
}

// ---------- usbmuxd: [len u32 LE][version 1][type 8 = plist][tag][xml plist]
let tagN = 0;
function muxConnect() {
  return new Promise((ok, no) => {
    const s = net.connect(27015, "127.0.0.1", () => ok(s));
    s.once("error", no);
    s.setTimeout(15000, () => s.destroy(new Error("Apple's device service didn't answer")));
  });
}
function muxSend(s, msg) {
  const body = plistXml({ ClientVersionString: "shivo-labs", ProgName: "shivo-labs", kLibUSBMuxVersion: 3, ...msg });
  const h = Buffer.alloc(16); h.writeUInt32LE(16 + body.length, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(8, 8); h.writeUInt32LE(++tagN, 12);
  s.write(Buffer.concat([h, body]));
}
// reads usbmuxd messages from a socket; onMsg gets each parsed plist
function muxReader(s, onMsg) {
  let buf = Buffer.alloc(0);
  const feed = (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= buf.readUInt32LE(0)) {
      const n = buf.readUInt32LE(0), msg = parsePlist(buf.subarray(16, n)); buf = buf.subarray(n);
      if (onMsg(msg) === false) { s.off("data", feed); if (buf.length) s.unshift(buf); return; }
    }
  };
  s.on("data", feed);
}
async function muxRequest(msg) {
  const s = await muxConnect();
  return new Promise((ok, no) => {
    s.once("error", no);
    muxReader(s, (m) => { s.end(); ok(m); return false; });
    muxSend(s, msg);
  });
}

// USB devices only: [{ deviceId, udid }]
export async function listUsb() {
  const r = await muxRequest({ MessageType: "ListDevices" });
  return (r.DeviceList || []).map((d) => d.Properties || {}).filter((p) => p.ConnectionType === "USB")
    .map((p) => ({ deviceId: p.DeviceID, udid: p.SerialNumber }));
}

// Plugged-in / pulled-out events as they happen: emits "attach" { deviceId, udid } and "detach" { deviceId }.
// Reconnects by itself if Apple's service restarts.
export function watch() {
  const ev = new EventEmitter(); let stopped = false, sock = null;
  const start = async () => {
    try {
      sock = await muxConnect(); sock.setTimeout(0);
      muxReader(sock, (m) => {
        if (m.MessageType === "Attached" && m.Properties?.ConnectionType === "USB") ev.emit("attach", { deviceId: m.DeviceID, udid: m.Properties.SerialNumber });
        if (m.MessageType === "Detached") ev.emit("detach", { deviceId: m.DeviceID });
      });
      sock.on("close", () => { if (!stopped) setTimeout(start, 3000); });
      sock.on("error", () => {});
      muxSend(sock, { MessageType: "Listen" });
    } catch { if (!stopped) setTimeout(start, 5000); }
  };
  start();
  ev.stop = () => { stopped = true; sock?.destroy(); };
  return ev;
}

// A plain connection to a port on the device (through usbmuxd).
async function connectPort(deviceId, port) {
  const s = await muxConnect();
  await new Promise((ok, no) => {
    s.once("error", no);
    muxReader(s, (m) => { if (m.Number === 0) ok(); else no(new Error(m.Number === 3 ? "The device refused the connection" : `usbmuxd error ${m.Number}`)); return false; });
    muxSend(s, { MessageType: "Connect", DeviceID: deviceId, PortNumber: ((port & 0xff) << 8) | (port >> 8) });
  });
  s.setTimeout(0);
  return s;
}

// ---------- lockdown / services: [len u32 BE][xml plist]
function plistChannel(sock) {
  let buf = Buffer.alloc(0); const waiting = [], queued = []; let ended = null;   // queued: answers nobody asked for yet
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0), msg = parsePlist(buf.subarray(4, 4 + n)); buf = buf.subarray(4 + n);
      const w = waiting.shift(); if (w) w.ok(msg); else queued.push(msg);
    }
  };
  const fail = (e) => { ended = e; while (waiting.length) waiting.shift().no(e); };
  const onClose = () => fail(new Error("The device closed the connection"));
  sock.on("data", onData); sock.on("error", fail); sock.on("close", onClose);
  return {
    // hand the connection over (for switching it to TLS): this channel stops reading it
    release() { sock.off("data", onData); sock.off("error", fail); sock.off("close", onClose); return sock; },
    send(msg) { const b = plistXml(msg), h = Buffer.alloc(4); h.writeUInt32BE(b.length); sock.write(Buffer.concat([h, b])); },
    next(ms = 20000) {
      if (queued.length) return Promise.resolve(queued.shift());
      if (ended) return Promise.reject(ended);
      return new Promise((ok, no) => { const t = setTimeout(() => no(new Error("The device didn't answer")), ms); waiting.push({ ok: (m) => { clearTimeout(t); ok(m); }, no: (e) => { clearTimeout(t); no(e); } }); });
    },
    async ask(msg, ms) { this.send(msg); return this.next(ms); },
    close() { sock.destroy(); },
  };
}
// TLS with this PC's pairing certificate. The device's certificates are old-style (SHA-1), hence SECLEVEL=0.
function upgrade(sock, pair) {
  return new Promise((ok, no) => {
    const t = tls.connect({ socket: sock, cert: pair.HostCertificate, key: pair.HostPrivateKey, rejectUnauthorized: false,
      ciphers: "ALL:@SECLEVEL=0", minVersion: "TLSv1", maxVersion: "TLSv1.3" }, () => ok(t));
    t.once("error", no);
  });
}

// A short session: name, kind (iPhone / iPad), and the user's installed apps. Throws if the device isn't trusted.
export async function describe(dev, { apps = true } = {}) {
  const rec = await muxRequest({ MessageType: "ReadPairRecord", PairRecordID: dev.udid });
  if (!rec.PairRecordData) throw new Error("This PC isn't trusted by the device yet: unlock it and tap Trust.");
  const pair = parsePlist(Buffer.from(rec.PairRecordData));
  const lock = plistChannel(await connectPort(dev.deviceId, 62078));
  let lockTls = null;
  try {
    const name = (await lock.ask({ Label: "shivo-labs", Request: "GetValue", Key: "DeviceName" })).Value || "Device";
    const kind = (await lock.ask({ Label: "shivo-labs", Request: "GetValue", Key: "DeviceClass" })).Value || "iPhone";
    const model = (await lock.ask({ Label: "shivo-labs", Request: "GetValue", Key: "ProductType" })).Value || "";
    const ios = (await lock.ask({ Label: "shivo-labs", Request: "GetValue", Key: "ProductVersion" })).Value || "";
    const out = { udid: dev.udid, name: String(name).replace(/’/g, "'"), kind, model, ios, link: "usb" };
    if (!apps) return out;
    // installed apps: a session, then the installation service
    const ses = await lock.ask({ Label: "shivo-labs", Request: "StartSession", HostID: pair.HostID, SystemBUID: pair.SystemBUID });
    if (ses.Error) throw new Error(ses.Error === "InvalidHostID" ? "This PC isn't trusted by the device yet: unlock it and tap Trust." : ses.Error);
    if (ses.EnableSessionSSL) lockTls = plistChannel(await upgrade(lock.release(), pair));
    const L = lockTls || lock;
    const svc = await L.ask({ Label: "shivo-labs", Request: "StartService", Service: "com.apple.mobile.installation_proxy" });
    if (!svc.Port) throw new Error("The device didn't open its app list (" + (svc.Error || "no port") + ")");
    let sock = await connectPort(dev.deviceId, svc.Port);
    if (svc.EnableServiceSSL) sock = await upgrade(sock, pair);
    const ip = plistChannel(sock);
    ip.send({ Command: "Browse", ClientOptions: { ApplicationType: "User", ReturnAttributes: ["CFBundleIdentifier", "CFBundleDisplayName", "CFBundleName", "CFBundleShortVersionString", "CFBundleVersion"] } });
    const list = [];
    for (;;) {
      const m = await ip.next(30000);
      for (const a of m.CurrentList || []) list.push({ bundleId: a.CFBundleIdentifier, name: a.CFBundleDisplayName || a.CFBundleName || a.CFBundleIdentifier, version: a.CFBundleShortVersionString || a.CFBundleVersion || "" });
      if (m.Status === "Complete" || m.Error) break;
    }
    ip.close();
    out.apps = list;
    // signing expiry per app: the provisioning profiles on the device (misagent). A profile is a signed blob with an
    // XML plist inside; the app it belongs to is in its application-identifier ("TEAMID.bundle.id").
    out.expiry = {};
    try {
      const mis = await L.ask({ Label: "shivo-labs", Request: "StartService", Service: "com.apple.misagent" });
      if (mis.Port) {
        let ms = await connectPort(dev.deviceId, mis.Port);
        if (mis.EnableServiceSSL) ms = await upgrade(ms, pair);
        const mc = plistChannel(ms);
        const r = await mc.ask({ MessageType: "CopyAll", ProfileType: "Provisioning" }, 20000);
        for (const blob of r.Payload || []) {
          const t = Buffer.from(blob).toString("latin1"), a = t.indexOf("<?xml"), b = t.indexOf("</plist>");
          if (a < 0 || b < 0) continue;
          const p = parsePlist(Buffer.from(t.slice(a, b + 8), "latin1"));
          const appId = String(p.Entitlements?.["application-identifier"] || ""), bundle = appId.slice(appId.indexOf(".") + 1);
          const exp = p.ExpirationDate instanceof Date ? p.ExpirationDate.getTime() : 0;
          if (bundle && exp > (out.expiry[bundle] || 0)) out.expiry[bundle] = exp;
        }
        mc.close();
      }
    } catch {}
    return out;
  } finally { lockTls?.close(); lock.close(); }
}
