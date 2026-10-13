// Apple binary property lists ("bplist00"), the format AirPlay uses for its request and reply bodies.
// parse(buf) -> JS value; build(value) -> Buffer.
// Types: dict (plain object), array, string, integer (number or BigInt), real (Real wrapper or
// non-integer number), boolean, data (Buffer), date (Date). Integers are written unsigned-friendly.

export class Real { constructor(v) { this.value = v; } }   // force a float for whole numbers (e.g. 60.0)
export class Uid { constructor(v) { this.value = v; } }

export function parse(buf) {
  if (buf.length < 40 || buf.toString("latin1", 0, 8) !== "bplist00") throw new Error("not a binary plist");
  const t = buf.length - 32;
  const offSize = buf[t + 6], refSize = buf[t + 7];
  const count = Number(buf.readBigUInt64BE(t + 8)), top = Number(buf.readBigUInt64BE(t + 16)), tableAt = Number(buf.readBigUInt64BE(t + 24));
  const uint = (at, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[at + i]; return v; };
  const offsets = []; for (let i = 0; i < count; i++) offsets.push(uint(tableAt + i * offSize, offSize));
  const depth = new Set();
  function obj(ref) {
    if (ref >= count) throw new Error("bad plist reference");
    if (depth.has(ref)) throw new Error("plist loop");
    depth.add(ref);
    try { return read(offsets[ref]); } finally { depth.delete(ref); }
  }
  function lenAt(at, info) {   // returns [length, start of content]
    if (info !== 0xf) return [info, at + 1];
    const m = buf[at + 1]; if ((m >> 4) !== 1) throw new Error("bad plist length");
    const n = 1 << (m & 0xf); return [uint(at + 2, n), at + 2 + n];
  }
  function read(at) {
    const m = buf[at], hi = m >> 4, info = m & 0xf;
    switch (hi) {
      case 0x0: return info === 0x8 ? false : info === 0x9 ? true : null;
      case 0x1: {
        const n = 1 << info;
        if (n === 8) { const v = buf.readBigInt64BE(at + 1); return v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : v; }
        if (n === 16) return buf.readBigUInt64BE(at + 9);
        return uint(at + 1, n);
      }
      case 0x2: return info === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
      case 0x3: return new Date((buf.readDoubleBE(at + 1) + 978307200) * 1000);
      case 0x4: { const [n, s] = lenAt(at, info); return Buffer.from(buf.subarray(s, s + n)); }
      case 0x5: { const [n, s] = lenAt(at, info); return buf.toString("latin1", s, s + n); }
      case 0x6: { const [n, s] = lenAt(at, info); const b = Buffer.from(buf.subarray(s, s + n * 2)); b.swap16(); return b.toString("utf16le"); }
      case 0x8: return new Uid(uint(at + 1, info + 1));
      case 0xa: { const [n, s] = lenAt(at, info); const a = []; for (let i = 0; i < n; i++) a.push(obj(uint(s + i * refSize, refSize))); return a; }
      case 0xd: {
        const [n, s] = lenAt(at, info); const o = {};
        for (let i = 0; i < n; i++) o[String(obj(uint(s + i * refSize, refSize)))] = obj(uint(s + (n + i) * refSize, refSize));
        return o;
      }
      default: throw new Error("unsupported plist type 0x" + m.toString(16));
    }
  }
  return obj(top);
}

export function build(value) {
  const objs = [];   // encoded bodies, filled after children are known
  const add = (v) => {
    const i = objs.length; objs.push(null);
    let refs = null;
    if (Array.isArray(v)) refs = v.map(add);
    else if (v && typeof v === "object" && !(v instanceof Uint8Array) && !(v instanceof Date) && !(v instanceof Real) && !(v instanceof Uid)) {
      const ks = Object.keys(v).filter((k) => v[k] !== undefined);
      refs = [...ks.map(add), ...ks.map((k) => add(v[k]))];
      objs[i] = { dict: ks.length, refs }; return i;
    }
    objs[i] = refs ? { arr: v.length, refs } : { v };
    return i;
  };
  add(value);
  const n = objs.length;
  const refSize = n < 256 ? 1 : n < 65536 ? 2 : 4;
  const uintB = (x, size) => { const b = Buffer.alloc(size); for (let i = size - 1; i >= 0; i--) { b[i] = Number(BigInt(x) & 0xffn); x = BigInt(x) >> 8n; } return b; };
  const head = (hi, len) => len < 15 ? Buffer.from([(hi << 4) | len]) : Buffer.concat([Buffer.from([(hi << 4) | 0xf]), intObj(len)]);
  const intObj = (x) => {
    x = BigInt(x);
    if (x < 0n) { const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(x, 1); return b; }
    if (x < 0x100n) return Buffer.from([0x10, Number(x)]);
    if (x < 0x10000n) { const b = Buffer.alloc(3); b[0] = 0x11; b.writeUInt16BE(Number(x), 1); return b; }
    if (x < 0x100000000n) { const b = Buffer.alloc(5); b[0] = 0x12; b.writeUInt32BE(Number(x), 1); return b; }
    if (x < 0x8000000000000000n) { const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(x, 1); return b; }
    const b = Buffer.alloc(17); b[0] = 0x14; b.writeBigUInt64BE(x, 9); return b;
  };
  const enc = (o) => {
    if (o.dict !== undefined) return Buffer.concat([head(0xd, o.dict), ...o.refs.map((r) => uintB(r, refSize))]);
    if (o.arr !== undefined) return Buffer.concat([head(0xa, o.arr), ...o.refs.map((r) => uintB(r, refSize))]);
    const v = o.v;
    if (v === null || v === undefined) return Buffer.from([0x00]);
    if (v === true) return Buffer.from([0x09]);
    if (v === false) return Buffer.from([0x08]);
    if (typeof v === "bigint") return intObj(v);
    if (typeof v === "number") {
      if (Number.isInteger(v)) return intObj(v);
      const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v, 1); return b;
    }
    if (v instanceof Real) { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v.value, 1); return b; }
    if (v instanceof Uid) { const b = uintB(v.value, 4); return Buffer.concat([Buffer.from([0x83]), b]); }
    if (v instanceof Date) { const b = Buffer.alloc(9); b[0] = 0x33; b.writeDoubleBE(v.getTime() / 1000 - 978307200, 1); return b; }
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(0x4, v.length), Buffer.from(v)]);
    const s = String(v);
    if (/^[\x00-\x7f]*$/.test(s)) return Buffer.concat([head(0x5, s.length), Buffer.from(s, "latin1")]);
    const u = Buffer.from(s, "utf16le"); u.swap16();
    return Buffer.concat([head(0x6, u.length / 2), u]);
  };
  const parts = [Buffer.from("bplist00", "latin1")];
  const offsets = []; let pos = 8;
  for (const o of objs) { const b = enc(o); offsets.push(pos); parts.push(b); pos += b.length; }
  const offSize = pos < 256 ? 1 : pos < 65536 ? 2 : 4;
  const tableAt = pos;
  for (const off of offsets) parts.push(uintB(off, offSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize; trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(n), 8); trailer.writeBigUInt64BE(0n, 16); trailer.writeBigUInt64BE(BigInt(tableAt), 24);
  parts.push(trailer);
  return Buffer.concat(parts);
}
