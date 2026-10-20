// Shivo Cloud encryption on the laptop (files/FORMAT.md): names, wrapped file keys, SC1 file contents, joining a phone.
import { randomBytes, createCipheriv, createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { Transform } from "node:stream";

export const CHUNK = 1048576;            // plain bytes per chunk
export const PART = 8388608;             // encrypted bytes per upload part
const MAGIC = Buffer.from([0x53, 0x43, 0x31, 0x00]);   // "SC1\0"

export const b64u = (b) => Buffer.from(b).toString("base64url");
export const unb64u = (s) => Buffer.from(String(s), "base64url");

function seal(key, plain, aad, nonce = randomBytes(12)) {
  const c = createCipheriv("aes-256-gcm", key, nonce); c.setAAD(Buffer.from(aad));
  return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
}
function open(key, box, aad) {
  const nonce = box.subarray(0, 12), tag = box.subarray(box.length - 16), body = box.subarray(12, box.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce); d.setAAD(Buffer.from(aad)); d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

// ---------- names and keys
export const encName = (master, name) => "n1." + b64u(seal(master, Buffer.from(String(name), "utf8"), "shivo-name"));
export function decName(master, v) {
  if (!String(v).startsWith("n1.")) throw new Error("not a name");
  return open(master, unb64u(String(v).slice(3)), "shivo-name").toString("utf8");
}
export const wrapKey = (master, fileKey) => "k1." + b64u(seal(master, fileKey, "shivo-key"));
export function unwrapKey(master, v) {
  if (!String(v).startsWith("k1.")) throw new Error("not a key");
  return open(master, unb64u(String(v).slice(3)), "shivo-key");
}

// ---------- recovery code: the master key in base32 (RFC 4648, no padding), groups of 4
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function recoveryCode(master) {
  let bits = 0, v = 0, out = "";
  for (const byte of master) { v = (v << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join("-");
}
export function fromRecoveryCode(code) {
  const s = String(code).toUpperCase().replace(/[^A-Z2-7]/g, ""); let bits = 0, v = 0; const out = [];
  for (const ch of s) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  if (out.length !== 32) throw new Error("That recovery code isn't complete.");
  return Buffer.from(out);
}

// ---------- SC1 contents
export const encryptedSize = (plain) => 16 + plain + 16 * Math.max(1, Math.ceil(plain / CHUNK));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

// plain bytes in, SC1 bytes out
export function encryptStream(fileKey, prefix = randomBytes(8)) {
  const header = Buffer.concat([MAGIC, u32(CHUNK), prefix]);
  let buf = Buffer.alloc(0), i = 0, started = false;
  const chunk = (plain, last) => {
    const c = createCipheriv("aes-256-gcm", fileKey, Buffer.concat([prefix, u32(i)]));
    c.setAAD(Buffer.concat([header, u32(i), Buffer.from([last ? 1 : 0])]));
    i++;
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  return new Transform({
    transform(data, _, done) {
      if (!started) { started = true; this.push(header); }
      buf = Buffer.concat([buf, data]);
      // keep at least one byte back: the last chunk is only known at the end
      while (buf.length > CHUNK) { this.push(chunk(buf.subarray(0, CHUNK), false)); buf = buf.subarray(CHUNK); }
      done();
    },
    flush(done) {
      if (!started) this.push(header);
      this.push(chunk(buf, true));
      done();
    },
  });
}

// SC1 bytes in, plain bytes out; fails if anything was changed or cut off
export function decryptStream(fileKey) {
  let buf = Buffer.alloc(0), header = null, prefix, size, i = 0, sawLast = false;
  const step = (bytes, last) => {
    const d = createDecipheriv("aes-256-gcm", fileKey, Buffer.concat([prefix, u32(i)]));
    d.setAAD(Buffer.concat([header, u32(i), Buffer.from([last ? 1 : 0])]));
    d.setAuthTag(bytes.subarray(bytes.length - 16));
    const out = Buffer.concat([d.update(bytes.subarray(0, bytes.length - 16)), d.final()]);
    i++; return out;
  };
  return new Transform({
    transform(data, _, done) {
      try {
        buf = Buffer.concat([buf, data]);
        if (!header) {
          if (buf.length < 16) return done();
          header = buf.subarray(0, 16);
          if (!header.subarray(0, 4).equals(MAGIC)) throw new Error("Not a Shivo Cloud file");
          size = header.readUInt32BE(4); prefix = header.subarray(8, 16); buf = buf.subarray(16);
        }
        // a full chunk is only certainly not the last when more bytes follow it
        while (buf.length > size + 16) { this.push(step(buf.subarray(0, size + 16), false)); buf = buf.subarray(size + 16); }
        done();
      } catch (e) { done(e); }
    },
    flush(done) {
      try {
        if (!header) throw new Error("Not a Shivo Cloud file");
        if (sawLast) return done();
        this.push(step(buf, true)); sawLast = true; done();
      } catch (e) { done(new Error("The file is damaged or incomplete (" + e.message + ")")); }
    },
  });
}

// ---------- joining a phone: ECDH P-256 + HKDF-SHA256 + AES-GCM
export function joinBox(phonePubB64u, payload) {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const secret = ecdh.computeSecret(unb64u(phonePubB64u));
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.from("shivo-files-join"), Buffer.from("v1"), 32));
  return { pub: b64u(ecdh.getPublicKey(null, "uncompressed")), box: b64u(seal(key, Buffer.from(JSON.stringify(payload)), "shivo-join")) };
}
// (the phone's side, for tests)
export function joinOpen(phoneEcdh, res) {
  const secret = phoneEcdh.computeSecret(unb64u(res.pub));
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.from("shivo-files-join"), Buffer.from("v1"), 32));
  return JSON.parse(open(key, unb64u(res.box), "shivo-join").toString("utf8"));
}

// ---------- share links (files/FORMAT.md, "Sharing"): the file's name sealed with its own key, so the share page
// (which gets the file key from the link, after the #) can show it
export const shareName = (fileKey, name) => "s1." + b64u(seal(fileKey, Buffer.from(String(name), "utf8"), "shivo-share-name"));

// ---------- request-files links: a P-256 key pair per request; uploaders seal each file's name and key to its public
// key (r1. = ephemeral public key (65) || nonce || ciphertext || tag); the owner opens them with the private key
export function requestPair() {
  const e = createECDH("prime256v1"); e.generateKeys();
  return { pub: e.getPublicKey(null, "uncompressed"), priv: e.getPrivateKey() };
}
export function openRequestBox(priv, v, aad) {
  if (!String(v).startsWith("r1.")) throw new Error("not a request box");
  const raw = unb64u(String(v).slice(3)), e = createECDH("prime256v1"); e.setPrivateKey(priv);
  const key = Buffer.from(hkdfSync("sha256", e.computeSecret(raw.subarray(0, 65)), Buffer.from("shivo-request"), Buffer.from("v1"), 32));
  return open(key, raw.subarray(65), aad);
}
