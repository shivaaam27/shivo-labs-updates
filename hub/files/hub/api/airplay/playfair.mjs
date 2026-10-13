// FairPlay "playfair" key unwrap for AirPlay screen mirroring, in plain JavaScript.
// A line-by-line port of UxPlay's lib/playfair (omg_hax.c, hand_garble.c, sap_hash.c,
// modified_md5.c, playfair.c; GPL-3.0). It runs inside the hub's signed Node, so no
// extra .exe or .dll is needed (Smart App Control blocks unsigned ones).
//
// C semantics kept on purpose: bytes live in Uint8Arrays (stores wrap to 8 bits),
// 32-bit words are little-endian, products that can pass 2^32 use Math.imul.

import * as T from './playfair-tables.mjs';

const rd32 = (a, o) => (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;
const wr32 = (a, o, v) => { a[o] = v; a[o + 1] = v >>> 8; a[o + 2] = v >>> 16; a[o + 3] = v >>> 24; };
const div = (a, b) => Math.floor(a / b);           // every dividend below is non-negative
const mul = (...x) => x.reduce((p, v) => Math.imul(p, v)) >>> 0;

// ---- omg_hax.c ----
function xorKey(inp, io, out, oo, key) { for (let i = 0; i < 16; i++) out[oo + i] = inp[io + i] ^ key[i]; }
const tableIndex = i => ((31 * i) % 0x28) << 8;            // into table_s1
const messageTableIndex = i => ((97 * i) % 144) << 8;      // into table_s2
const permuteTable2 = i => ((71 * i) % 144) << 8;          // into table_s4

function permuteBlock1(b) {
  const s3 = T.table_s3;
  b[0] = s3[b[0]]; b[4] = s3[0x400 + b[4]]; b[8] = s3[0x800 + b[8]]; b[12] = s3[0xc00 + b[12]];
  let t = b[13];
  b[13] = s3[0x100 + b[9]]; b[9] = s3[0xd00 + b[5]]; b[5] = s3[0x900 + b[1]]; b[1] = s3[0x500 + t];
  t = b[2]; b[2] = s3[0xa00 + b[10]]; b[10] = s3[0x200 + t];
  t = b[6]; b[6] = s3[0xe00 + b[14]]; b[14] = s3[0x600 + t];
  t = b[3]; b[3] = s3[0xf00 + b[7]]; b[7] = s3[0x300 + b[11]]; b[11] = s3[0x700 + b[15]]; b[15] = s3[0xb00 + t];
}

function permuteBlock2(b, round) {
  const s4 = T.table_s4, p = k => permuteTable2(round * 16 + k);
  b[0] = s4[p(0) + b[0]]; b[4] = s4[p(4) + b[4]]; b[8] = s4[p(8) + b[8]]; b[12] = s4[p(12) + b[12]];
  let t = b[13];
  b[13] = s4[p(13) + b[9]]; b[9] = s4[p(9) + b[5]]; b[5] = s4[p(5) + b[1]]; b[1] = s4[p(1) + t];
  t = b[2]; b[2] = s4[p(2) + b[10]]; b[10] = s4[p(10) + t];
  t = b[6]; b[6] = s4[p(6) + b[14]]; b[14] = s4[p(14) + t];
  t = b[3]; b[3] = s4[p(3) + b[7]]; b[7] = s4[p(7) + b[11]]; b[11] = s4[p(11) + b[15]]; b[15] = s4[p(15) + t];
}

// key schedule: 11 rounds x 16 bytes (four little-endian words per round)
function generateKeySchedule(material, mo = 0) {
  const ks = Array.from({ length: 11 }, () => new Uint8Array(16));
  const buf = new Uint8Array(16);
  xorKey(material, mo, buf, 0, T.t_key);
  let ti = 0;
  for (let round = 0; round < 11; round++) {
    const k = ks[round];
    k.set(buf.subarray(0, 4), 0);
    const t1 = tableIndex(ti), t2 = tableIndex(ti + 1), t3 = tableIndex(ti + 2), t4 = tableIndex(ti + 3);
    ti += 4;
    buf[0] ^= T.table_s1[t1 + buf[0x0d]] ^ T.index_mangle[round];
    buf[1] ^= T.table_s1[t2 + buf[0x0e]];
    buf[2] ^= T.table_s1[t3 + buf[0x0f]];
    buf[3] ^= T.table_s1[t4 + buf[0x0c]];
    k.set(buf.subarray(4, 8), 4);
    for (let i = 0; i < 4; i++) buf[4 + i] ^= buf[i];
    k.set(buf.subarray(8, 12), 8);
    for (let i = 0; i < 4; i++) buf[8 + i] ^= buf[4 + i];
    k.set(buf.subarray(12, 16), 12);
    for (let i = 0; i < 4; i++) buf[12 + i] ^= buf[8 + i];
  }
  return ks;
}

// block: Uint8Array view of exactly 16 bytes
function cycle(block, ks) {
  const s5 = T.table_s5, s6 = T.table_s6, s7 = T.table_s7, s8 = T.table_s8;
  for (let i = 0; i < 16; i++) block[i] ^= ks[10][i];
  permuteBlock1(block);
  for (let round = 0; round < 9; round++) {
    const k = ks[9 - round];
    let ab = (s5[block[3] ^ k[3]] ^ s6[block[2] ^ k[2]] ^ s8[block[0] ^ k[0]] ^ s7[block[1] ^ k[1]]) >>> 0;
    wr32(block, 0, ab);
    ab = (s6[block[6] ^ k[6]] ^ s5[block[7] ^ k[7]] ^ s8[block[4] ^ k[4]] ^ s7[block[5] ^ k[5]]) >>> 0;
    wr32(block, 4, ab);
    wr32(block, 8, (s5[block[11] ^ k[11]] ^ s6[block[10] ^ k[10]] ^ s7[block[9] ^ k[9]] ^ s8[block[8] ^ k[8]]) >>> 0);
    wr32(block, 12, (s5[block[15] ^ k[15]] ^ s6[block[14] ^ k[14]] ^ s7[block[13] ^ k[13]] ^ s8[block[12] ^ k[12]]) >>> 0);
    permuteBlock2(block, 8 - round);
  }
  for (let i = 0; i < 16; i++) block[i] ^= ks[0][i];
}

function decryptMessage(msg) {
  const out = new Uint8Array(128), buffer = new Uint8Array(16);
  const mode = msg[12];
  const s2 = T.table_s2, s9 = T.table_s9, s10 = T.table_s10;
  const mk = T.message_key.subarray(mode * 144, mode * 144 + 144);
  const iv = T.message_iv.subarray(mode * 16, mode * 16 + 16);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 16; j++) {
      if (mode === 3) buffer[j] = msg[(0x80 - 0x10 * i) + j];
      else if (mode === 2 || mode === 1 || mode === 0) buffer[j] = msg[(0x10 * (i + 1)) + j];
    }
    for (let j = 0; j < 9; j++) {
      const base = 0x80 - 0x10 * j;
      const M = (k, v) => s2[messageTableIndex(base + k) + v] ^ mk[base + k];
      buffer[0x0] = M(0x0, buffer[0x0]);
      buffer[0x4] = M(0x4, buffer[0x4]);
      buffer[0x8] = M(0x8, buffer[0x8]);
      buffer[0xc] = M(0xc, buffer[0xc]);
      let t = buffer[0x0d];
      buffer[0xd] = M(0xd, buffer[0x9]);
      buffer[0x9] = M(0x9, buffer[0x5]);
      buffer[0x5] = M(0x5, buffer[0x1]);
      buffer[0x1] = M(0x1, t);
      t = buffer[0x02];
      buffer[0x2] = M(0x2, buffer[0xa]);
      buffer[0xa] = M(0xa, t);
      t = buffer[0x06];
      buffer[0x6] = M(0x6, buffer[0xe]);
      buffer[0xe] = M(0xe, t);
      t = buffer[0x3];
      buffer[0x3] = M(0x3, buffer[0x7]);
      buffer[0x7] = M(0x7, buffer[0xb]);
      buffer[0xb] = M(0xb, buffer[0xf]);
      buffer[0xf] = M(0xf, t);
      // each word is written before the next is computed, exactly as in C
      for (let w = 0; w < 4; w++) {
        const o = w * 4;
        wr32(buffer, o, (s9[buffer[o]] ^ s9[0x100 + buffer[o + 1]] ^ s9[0x200 + buffer[o + 2]] ^ s9[0x300 + buffer[o + 3]]) >>> 0);
      }
    }
    buffer[0x0] = s10[(0x0 << 8) + buffer[0x0]];
    buffer[0x4] = s10[(0x4 << 8) + buffer[0x4]];
    buffer[0x8] = s10[(0x8 << 8) + buffer[0x8]];
    buffer[0xc] = s10[(0xc << 8) + buffer[0xc]];
    let t = buffer[0x0d];
    buffer[0xd] = s10[(0xd << 8) + buffer[0x9]];
    buffer[0x9] = s10[(0x9 << 8) + buffer[0x5]];
    buffer[0x5] = s10[(0x5 << 8) + buffer[0x1]];
    buffer[0x1] = s10[(0x1 << 8) + t];
    t = buffer[0x02];
    buffer[0x2] = s10[(0x2 << 8) + buffer[0xa]];
    buffer[0xa] = s10[(0xa << 8) + t];
    t = buffer[0x06];
    buffer[0x6] = s10[(0x6 << 8) + buffer[0xe]];
    buffer[0xe] = s10[(0xe << 8) + t];
    t = buffer[0x3];
    buffer[0x3] = s10[(0x3 << 8) + buffer[0x7]];
    buffer[0x7] = s10[(0x7 << 8) + buffer[0xb]];
    buffer[0xb] = s10[(0xb << 8) + buffer[0xf]];
    buffer[0xf] = s10[(0xf << 8) + t];
    if (mode === 2 || mode === 1 || mode === 0) {
      const prev = i > 0 ? msg.subarray(0x10 * i, 0x10 * i + 16) : iv;
      for (let j = 0; j < 16; j++) out[0x10 * i + j] = buffer[j] ^ prev[j];
    } else {
      const o = 0x70 - 0x10 * i;
      const prev = i < 7 ? msg.subarray(o, o + 16) : iv;
      for (let j = 0; j < 16; j++) out[o + j] = buffer[j] ^ prev[j];
    }
  }
  return out;
}

// ---- modified_md5.c ----
const SHIFT = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
// (int)(long long)((1LL << 32) * fabs(sin(i + 1))): the standard MD5 constants
const KMD5 = Uint32Array.from([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391]);
const rol = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

function modifiedMd5(orig, oo, keyIn) {
  const block = Uint8Array.from(orig.subarray(oo, oo + 64));
  const swapW = (a, b) => { for (let k = 0; k < 4; k++) { const t = block[a * 4 + k]; block[a * 4 + k] = block[b * 4 + k]; block[b * 4 + k] = t; } };
  let A = rd32(keyIn, 0), B = rd32(keyIn, 4), C = rd32(keyIn, 8), D = rd32(keyIn, 12);
  for (let i = 0; i < 64; i++) {
    let j;
    if (i < 16) j = i;
    else if (i < 32) j = (5 * i + 1) % 16;
    else if (i < 48) j = (3 * i + 5) % 16;
    else j = (7 * i) % 16;
    const input = ((block[4 * j] << 24) | (block[4 * j + 1] << 16) | (block[4 * j + 2] << 8) | block[4 * j + 3]) >>> 0;
    let Z = (A + input + KMD5[i]) >>> 0;
    let f;
    if (i < 16) f = (B & C) | (~B & D);
    else if (i < 32) f = (B & D) | (C & ~D);
    else if (i < 48) f = B ^ C ^ D;
    else f = C ^ (B | ~D);
    Z = rol((Z + (f >>> 0)) >>> 0, SHIFT[i]);
    Z = (Z + B) >>> 0;
    const tmp = D; D = C; C = B; B = Z; A = tmp;
    if (i === 31) {
      swapW(A & 15, B & 15);
      swapW(C & 15, D & 15);
      swapW((A & (15 << 4)) >>> 4, (B & (15 << 4)) >>> 4);
      swapW((A & (15 << 8)) >>> 8, (B & (15 << 8)) >>> 8);
      swapW((A & (15 << 12)) >>> 12, (B & (15 << 12)) >>> 12);
    }
  }
  const out = new Uint8Array(16);
  wr32(out, 0, (rd32(keyIn, 0) + A) >>> 0);
  wr32(out, 4, (rd32(keyIn, 4) + B) >>> 0);
  wr32(out, 8, (rd32(keyIn, 8) + C) >>> 0);
  wr32(out, 12, (rd32(keyIn, 12) + D) >>> 0);
  return out;
}

// ---- sap_hash.c + hand_garble.c ----
const rol8 = (x, c) => (((x << c) & 0xff) | ((x & 0xff) >> (8 - c))) & 0xff;   // returns unsigned char
const rol8x = (x, c) => { x &= 0xff; return ((x << c) | (x >> (8 - c))) >>> 0; };
const weirdRor8 = (x, c) => { x &= 0xff; return c === 0 ? 0 : (((x >> c) & 0xff) | ((x & 0xff) << (8 - c))) >>> 0; };
const weirdRol8 = (x, c) => { x &= 0xff; return c === 0 ? 0 : (((x << c) & 0xff) | ((x & 0xff) >> (8 - c))) >>> 0; };
const weirdRol32 = (x, c) => { x &= 0xff; return c === 0 ? 0 : ((x << c) ^ (x >> (8 - c))) >>> 0; };

function garble(b0, b1, b2, b3, b4) {
  let tmp, tmp2, tmp3, A, B, C, D, E, M, J, G, F, H, K, R, S, T_, U, V, W, X, Y, Z;
  b2[12] = 0x14 + (((b1[64] & 92) | (div(b1[99], 3) & 35)) & b4[rol8x(b4[b1[206] % 21], 4) % 21]);
  b1[4] = div(b1[99], 5) * div(b1[99], 5) * 2;
  b2[34] = 0xb8;
  b1[153] ^= (b2[b1[203] % 35] * b2[b1[203] % 35] * b1[190]);
  b0[3] -= (((b4[b1[205] % 21] >> 1) & 80) | 0xe6440);
  b0[16] = 0x93;
  b0[13] = 0x62;
  b1[33] -= (b4[b1[36] % 21] & 0xf6);
  tmp2 = b2[b1[67] % 35];
  b2[12] = 0x07;
  tmp = b0[b1[181] % 20];
  b1[2] -= 3136;
  b0[19] = b4[b1[58] % 21];
  b3[0] = 92 - b2[b1[32] % 35];
  b3[4] = b2[b1[15] % 35] + 0x9e;
  b1[34] += div(b4[((b2[b1[15] % 35] + 0x9e) & 0xff) % 21], 5);
  b0[19] += 0xfffffee6 - ((b0[b3[4] % 20] >> 1) & 102);
  b1[15] = (3 * (((b1[72] >> (b4[b1[190] % 21] & 7)) ^ (b1[72] << ((7 - (b4[b1[190] % 21] - 1)) & 7))) - (3 * b4[b1[126] % 21]))) ^ b1[15];
  b0[15] ^= b2[b1[181] % 35] * b2[b1[181] % 35] * b2[b1[181] % 35];
  b2[4] ^= div(b1[202], 3);
  A = (92 - b0[b3[0] % 20]) >>> 0;
  E = ((A & 0xc6) | (~b1[105] & 0xc6) | (A & (~b1[105]))) >>> 0;
  b2[1] += mul(E, E, E);
  b0[19] ^= div((224 | (b4[b1[92] % 21] & 27)) * b2[b1[41] % 35], 3);
  b1[140] += weirdRor8(92, b1[5] & 7);
  b2[12] += ((((~b1[4]) ^ b2[b1[12] % 35]) | b1[182]) & 192) | (((~b1[4]) ^ b2[b1[12] % 35]) & b1[182]);
  b1[36] += 125;
  b1[124] = rol8x((((74 & b1[138]) | ((74 | b1[138]) & b0[15])) & b0[b1[43] % 20]) | (((74 & b1[138]) | ((74 | b1[138]) & b0[15]) | b0[b1[43] % 20]) & 95), 4);
  b3[8] = ((((b0[b3[4] % 20] & 95)) & ((b4[b1[68] % 21] & 46) << 1)) | 16) ^ 92;
  A = (b1[177] + b4[b1[79] % 21]) >>> 0;
  D = ((((A >>> 1) | div(3 * b1[148], 5)) & b2[1]) | ((A >>> 1) & div(3 * b1[148], 5))) >>> 0;
  b3[12] = (-34 - D);
  A = 8 - (b2[22] & 7);
  B = (b1[33] >> (A & 7)) >>> 0;
  C = (b1[33] << (b2[22] & 7)) >>> 0;
  b2[16] += ((b2[b3[0] % 35] & 159) | b0[b3[4] % 20] | 8) - ((B ^ C) | 128);
  b0[14] ^= b2[b3[12] % 35];
  A = weirdRol8(b4[b0[b1[201] % 20] % 21], ((b2[b1[112] % 35] << 1) & 7));
  D = ((b0[b1[208] % 20] & 131) | (b0[b1[164] % 20] & 124)) >>> 0;
  b1[19] += (A & div(D, 5)) | ((A | div(D, 5)) & 37);
  b2[8] = weirdRor8(140, ((b4[b1[45] % 21] + 92) * (b4[b1[45] % 21] + 92)) & 7);
  b1[190] = 56;
  b2[8] ^= b3[0];
  b1[53] = ~div(b0[b1[83] % 20] | 204, 5);
  b0[13] += b0[b1[41] % 20];
  b0[10] = div((b2[b3[0] % 35] & b1[2]) | ((b2[b3[0] % 35] | b1[2]) & b3[12]), 15);
  A = ((((56 | (b4[b1[2] % 21] & 68)) | b2[b3[8] % 35]) & 42) | (((b4[b1[2] % 21] & 68) | 56) & b2[b3[8] % 35])) >>> 0;
  b3[16] = (A * A) + 110;
  b3[20] = 202 - b3[16];
  b3[24] = b1[151];
  b2[13] ^= b4[b3[0] % 21];
  B = (((b2[b1[179] % 35] - 38) & 177) | (b3[12] & 177)) >>> 0;
  C = (((b2[b1[179] % 35] - 38)) & b3[12]) >>> 0;
  b3[28] = 30 + ((B | C) * (B | C));
  b3[32] = b3[28] + 62;
  A = ((((b3[20] + (b3[0] & 74)) | ~b4[b3[0] % 21]) & 121)) >>> 0;
  B = (((b3[20] + (b3[0] & 74)) & ~b4[b3[0] % 21])) >>> 0;
  tmp3 = (A | B) >>> 0;
  C = (((((A | B) ^ 0xffffffa6) | b3[0]) & 4) | (((A | B) ^ 0xffffffa6) & b3[0])) >>> 0;
  b1[47] = (b2[b1[89] % 35] + C) ^ b1[47];
  b3[36] = ((rol8(((tmp & 179) + 68) & 0xff, 2) & b0[3]) | (tmp2 & ~b0[3])) - 15;
  b1[123] ^= 221;
  A = (div(b4[b3[0] % 21], 3) - b2[b3[4] % 35]) >>> 0;
  C = ((((b3[0] & 163) + 92) & 246) | (b3[0] & 92)) >>> 0;
  E = (((C | b3[24]) & 54) | (C & b3[24])) >>> 0;
  b3[40] = A - E;
  b3[44] = tmp3 ^ 81 ^ (((b3[0] >> 1) & 101) + 26);
  b3[48] = b2[b3[4] % 35] & 27;
  b3[52] = 27;
  b3[56] = 199;
  b3[64] = b3[4] + (((((((b3[40] | b3[24]) & 177) | (b3[40] & b3[24])) & ((((b4[b3[0] % 20] & 177) | 176)) | ((b4[b3[0] % 21]) & ~3))) | ((((b3[40] & b3[24]) | ((b3[40] | b3[24]) & 177)) & 199) | ((((b4[b3[0] % 21] & 1) + 176) | (b4[b3[0] % 21] & ~3)) & b3[56]))) & (~b3[52])) | b3[48]);
  b2[33] ^= b1[26];
  b1[106] ^= b3[20] ^ 133;
  b2[30] = ((div(b3[64], 3) - (275 | (b3[0] & 247))) ^ b0[b1[122] % 20]);
  b1[22] = (b2[b1[90] % 35] & 95) | 68;
  A = ((b4[b3[36] % 21] & 184) | (b2[b3[44] % 35] & ~184)) >>> 0;
  b2[18] += ((A * A * A) >>> 1);
  b2[5] -= b4[b1[92] % 21];
  A = ((((b1[41] & ~24) | (b2[b1[183] % 35] & 24)) & (b3[16] + 53)) | (b3[20] & b2[b3[20] % 35])) >>> 0;
  B = ((b1[17] & (~b3[44])) | (b0[b1[59] % 20] & b3[44])) >>> 0;
  b2[18] ^= mul(A, B);
  A = weirdRor8(b1[11], b2[b1[28] % 35] & 7) & 7;
  B = (((((b0[b1[93] % 20] & ~b0[14]) | (b0[14] & 150)) & ~28) | (b1[7] & 28))) >>> 0;
  b2[22] = (((((B | weirdRol8(b2[b3[0] % 35], A)) & b2[33]) | (B & weirdRol8(b2[b3[0] % 35], A))) + 74) & 0xff);
  A = b4[(b0[b1[39] % 20] ^ 217) % 21];
  b0[15] -= ((((b3[20] | b3[0]) & 214) | (b3[20] & b3[0])) & A) | ((((b3[20] | b3[0]) & 214) | (b3[20] & b3[0]) | A) & b3[32]);
  B = ((((b2[b1[57] % 35] & b0[b3[64] % 20]) | ((b0[b3[64] % 20] | b2[b1[57] % 35]) & 95) | (b3[64] & 45) | 82) & 32)) >>> 0;
  C = ((((b2[b1[57] % 35] & b0[b3[64] % 20]) | ((b2[b1[57] % 35] | b0[b3[64] % 20]) & 95)) & ((b3[64] & 45) | 82))) >>> 0;
  D = (((div(b3[0], 3) - (b3[64] | b1[22]))) ^ (b3[28] + 62) ^ ((B | C))) >>> 0;
  T_ = b0[(D & 0xff) % 20];
  b3[68] = (mul(b0[b1[99] % 20], b0[b1[99] % 20], b0[b1[99] % 20], b0[b1[99] % 20]) | b2[b3[64] % 35]);
  U = b0[b1[50] % 20];
  W = b2[b1[138] % 35];
  X = b4[b1[39] % 21];
  Y = b0[b1[4] % 20];
  Z = b4[b1[202] % 21];
  V = b0[b1[151] % 20];
  S = b2[b1[14] % 35];
  R = b0[b1[145] % 20];
  A = ((b2[b3[68] % 35] & b0[b1[209] % 20]) | ((b2[b3[68] % 35] | b0[b1[209] % 20]) & 24)) >>> 0;
  B = weirdRol8(b4[b1[127] % 21], b2[b3[68] % 35] & 7);
  C = ((A & b0[10]) | (B & ~b0[10])) >>> 0;
  D = (7 ^ (b4[b2[b3[36] % 35] % 21] << 1)) >>> 0;
  b3[72] = (C & 71) | (D & ~71);
  b2[2] += (((b0[b3[20] % 20] << 1) & 159) | (b4[b1[190] % 21] & ~159)) & ((((b4[b3[64] % 21] & 110) | (b0[b1[25] % 20] & ~110)) & ~150) | (b1[25] & 150));
  b2[14] -= ((b2[b3[20] % 35] & (b3[72] ^ b2[b1[100] % 35])) & ~34) | (b1[97] & 34);
  b0[17] = 115;
  b1[23] ^= ((((((b4[b1[17] % 21] | b0[b3[20] % 20]) & b3[72]) | (b4[b1[17] % 21] & b0[b3[20] % 20])) & div(b1[50], 3)) |
    ((((b4[b1[17] % 21] | b0[b3[20] % 20]) & b3[72]) | (b4[b1[17] % 21] & b0[b3[20] % 20]) | div(b1[50], 3)) & 246)) << 1);
  b0[13] = ((((((b0[b3[40] % 20] | b1[10]) & 82) | (b0[b3[40] % 20] & b1[10])) & 209) |
    ((b0[b1[39] % 20] << 1) & 46)) >> 1);
  b2[33] -= b1[113] & 9;
  b2[28] -= ((((2 | (b1[110] & 222)) >> 1) & ~223) | (b3[20] & 223));
  J = weirdRol8((V | Z), (U & 7));
  A = ((b2[16] & T_) | (W & (~b2[16]))) >>> 0;
  B = ((b1[33] & 17) | (X & ~17)) >>> 0;
  E = (((Y | div(A + B, 5)) & 147) | (Y & div(A + B, 5))) >>> 0;
  M = ((b3[40] & b4[((b3[8] + J + E) & 0xff) % 21]) |
    ((b3[40] | b4[((b3[8] + J + E) & 0xff) % 21]) & b2[23])) >>> 0;
  b0[15] = (((b4[b3[20] % 21] - 48) & (~b1[184])) | ((b4[b3[20] % 21] - 48) & 189) | (189 & ~b1[184])) & mul(M, M, M);
  b2[22] += b1[183];
  b3[76] = (3 * b4[b1[1] % 21]) ^ b3[0];
  A = b2[((b3[8] + (J + E)) & 0xff) % 35];
  F = mul(((b4[b1[178] % 21] & A) | ((b4[b1[178] % 21] | A) & 209)), b0[b1[13] % 20], (b4[b1[26] % 21] >> 1));
  {
    const f = (F + 0x733ffff9) >>> 0;
    G = (mul(f, 198) - ((mul(f, 396) + 212) & 212) + 85) >>> 0;
  }
  b3[80] = b3[36] + ((G ^ 148) >>> 0) + (((G ^ 107) << 1) >>> 0) - 127;
  b3[84] = ((b2[b3[64] % 35]) & 245) | (b2[b3[20] % 35] & 10);
  A = (b0[b3[68] % 20] | 81) >>> 0;
  b2[18] -= ((A * A * A) & ~b0[15]) | (div(b3[80], 15) & b0[15]);
  b3[88] = b3[8] + J + E - b0[b1[160] % 20] + div(b4[b0[((b3[8] + J + E) & 255) % 20] % 21], 3);
  B = (((R ^ b3[72]) & ~198) | ((S * S) & 198)) >>> 0;
  F = ((b4[b1[69] % 21] & b1[172]) | ((b4[b1[69] % 21] | b1[172]) & ((b3[12] - B) + 77))) >>> 0;
  b0[16] = 147 - ((b3[72] & ((F & 251) | 1)) | (((F & 250) | b3[72]) & 198));
  C = ((b4[b1[168] % 21] & b0[b1[29] % 20] & 7) | ((b4[b1[168] % 21] | b0[b1[29] % 20]) & 6)) >>> 0;
  F = ((b4[b1[155] % 21] & b1[105]) | ((b4[b1[155] % 21] | b1[105]) & 141)) >>> 0;
  b0[3] -= b4[weirdRol32(F, C) % 21];
  b1[5] = weirdRor8(b0[12], (div(b0[b1[61] % 20], 5) & 7)) ^ div((~b2[b3[84] % 35]) >>> 0, 5);
  b1[198] += b1[3];
  A = (162 | b2[b3[64] % 35]) >>> 0;
  b1[164] += div(A * A, 5);
  G = weirdRor8(139, (b3[80] & 7));
  C = ((mul(b4[b3[64] % 21], b4[b3[64] % 21], b4[b3[64] % 21]) & 95) | (b0[b3[40] % 20] & ~95)) >>> 0;
  b3[92] = (G & 12) | (b0[b3[20] % 20] & 12) | (G & b0[b3[20] % 20]) | C;
  b2[12] += div((b1[103] & 32) | (b3[92] & ((b1[103] | 60))) | 16, 3);
  b3[96] = b1[143];
  b3[100] = 27;
  b3[104] = (((b3[40] & ~b2[8]) | (b1[35] & b2[8])) & b3[64]) ^ 119;
  b3[108] = 238 & ((((b3[40] & ~b2[8]) | (b1[35] & b2[8])) & b3[64]) << 1);
  b3[112] = (~b3[64] & div(b3[84], 3)) ^ 49;
  b3[116] = 98 & ((~b3[64] & div(b3[84], 3)) << 1);
  A = ((b1[35] & b2[8]) | (b3[40] & ~b2[8])) >>> 0;
  B = ((A & b3[64]) | ((div(b3[84], 3) & ~b3[64]))) >>> 0;
  b1[143] = b3[96] - ((B & (86 + ((b1[172] & 64) >> 1))) | (((((b1[172] & 65) >> 1) ^ 86) | ((~b3[64] & div(b3[84], 3)) | (((b3[40] & ~b2[8]) | (b1[35] & b2[8])) & b3[64]))) & b3[100]));
  b2[29] = 162;
  A = ((((b4[b3[88] % 21]) & 160) | (b0[b1[125] % 20] & 95)) >> 1) >>> 0;
  B = (b2[b1[149] % 35] ^ (b1[43] * b1[43])) >>> 0;
  b0[15] += (B & A) | ((A | B) & 115);
  b3[120] = b3[64] - b0[b3[40] % 20];
  b1[95] = b4[b3[20] % 21];
  A = weirdRor8(b2[b3[80] % 35], (b2[b1[17] % 35] * b2[b1[17] % 35] * b2[b1[17] % 35]) & 7);
  b0[7] -= mul(A, A);
  b2[8] = b2[8] - b1[184] + (b4[b1[202] % 21] * b4[b1[202] % 21] * b4[b1[202] % 21]);
  b0[16] = (b2[b1[102] % 35] << 1) & 132;
  b3[124] = (b4[b3[40] % 21] >> 1) ^ b3[68];
  b0[7] -= (b0[b1[191] % 20] - (((b4[b1[80] % 21] << 1) & ~177) | (b4[b4[b3[88] % 21] % 21] & 177)));
  b0[6] = b0[b1[119] % 20];
  A = ((b4[b1[190] % 21] & ~209) | (b1[118] & 209)) >>> 0;
  B = (b0[b3[120] % 20] * b0[b3[120] % 20]) >>> 0;
  b0[12] = (b0[b3[84] % 20] ^ (b2[b1[71] % 35] + b2[b1[15] % 35])) & ((A & B) | ((A | B) & 27));
  B = ((b1[32] & b2[b3[88] % 35]) | ((b1[32] | b2[b3[88] % 35]) & 23)) >>> 0;
  D = ((((b4[b1[57] % 21] * 231) & 169) | (B & 86))) >>> 0;
  F = (((((b0[b1[82] % 20] & ~29) | (b4[b3[124] % 21] & 29)) & 190) | (b4[div(D, 5) % 21] & ~190))) >>> 0;
  H = (b0[b3[40] % 20] * b0[b3[40] % 20] * b0[b3[40] % 20]) >>> 0;
  K = ((H & b1[82]) | (H & 92) | (b1[82] & 92)) >>> 0;
  b3[128] = ((F & K) | ((F | K) & 192)) ^ div(D, 5);
  b2[25] ^= ((b0[b3[120] % 20] << 1) * b1[5]) - (weirdRol8(b3[76], (b4[b3[124] % 21] & 7)) & (b3[20] + 110));
}

function sapHash(blockIn, bo, keyOut) {
  const b0 = Uint8Array.from([0x96, 0x5F, 0xC6, 0x53, 0xF8, 0x46, 0xCC, 0x18, 0xDF, 0xBE, 0xB2, 0xF8, 0x38, 0xD7, 0xEC, 0x22, 0x03, 0xD1, 0x20, 0x8F]);
  const b1 = new Uint8Array(210);
  const b2 = Uint8Array.from([0x43, 0x54, 0x62, 0x7A, 0x18, 0xC3, 0xD6, 0xB3, 0x9A, 0x56, 0xF6, 0x1C, 0x14, 0x3F, 0x0C, 0x1D, 0x3B, 0x36, 0x83, 0xB1, 0x39, 0x51, 0x4A, 0xAA, 0x09, 0x3E, 0xFE, 0x44, 0xAF, 0xDE, 0xC3, 0x20, 0x9D, 0x42, 0x3A]);
  const b3 = new Uint8Array(132);
  const b4 = Uint8Array.from([0xED, 0x25, 0xD1, 0xBB, 0xBC, 0x27, 0x9F, 0x02, 0xA2, 0xA9, 0x11, 0x00, 0x0C, 0xB3, 0x52, 0xC0, 0xBD, 0xE3, 0x1B, 0x49, 0xC7]);
  const i0 = [18, 22, 23, 0, 5, 19, 32, 31, 10, 21, 30];
  for (let i = 0; i < 210; i++) {
    const word = rd32(blockIn, bo + (((i % 64) >> 2) << 2));
    b1[i] = (word >>> ((3 - (i % 4)) << 3)) & 0xff;
  }
  for (let i = 0; i < 840; i++) {
    const x = b1[((i - 155) >>> 0) % 210];
    const y = b1[((i - 57) >>> 0) % 210];
    const z = b1[((i - 13) >>> 0) % 210];
    const w = b1[(i >>> 0) % 210];
    b1[i % 210] = (rol8(y, 5) + (rol8(z, 3) ^ w) - rol8(x, 7)) & 0xff;
  }
  garble(b0, b1, b2, b3, b4);
  for (let i = 0; i < 16; i++) keyOut[i] = 0xE1;
  for (let i = 0; i < 11; i++) {
    if (i === 3) keyOut[i] = 0x3d;
    else keyOut[i] = (keyOut[i] + b3[i0[i] * 4]) & 0xff;
  }
  for (let i = 0; i < 20; i++) keyOut[i % 16] ^= b0[i];
  for (let i = 0; i < 35; i++) keyOut[i % 16] ^= b2[i];
  for (let i = 0; i < 210; i++) keyOut[i % 16] ^= b1[i];
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16; i++) {
      const x = keyOut[((i - 7) >>> 0) % 16];
      const y = keyOut[i % 16];
      const z = keyOut[((i - 37) >>> 0) % 16];
      const w = keyOut[((i - 177) >>> 0) % 16];
      keyOut[i] = rol8(x, 1) ^ y ^ rol8(z, 6) ^ rol8(w, 5);
    }
  }
}

function generateSessionKey(oldSap, messageIn) {
  const decrypted = decryptMessage(messageIn);
  const newSap = new Uint8Array(320);
  newSap.set(T.static_source_1.subarray(0, 0x11), 0x000);
  newSap.set(decrypted.subarray(0, 0x80), 0x011);
  newSap.set(oldSap.subarray(0x80, 0x100), 0x091);
  newSap.set(T.static_source_2.subarray(0, 0x2f), 0x111);
  const key = Uint8Array.from(T.initial_session_key);
  for (let round = 0; round < 5; round++) {
    const base = round * 64;
    const md5 = modifiedMd5(newSap, base, key);
    sapHash(newSap, base, key);
    for (let i = 0; i < 4; i++) wr32(key, i * 4, (rd32(key, i * 4) + rd32(md5, i * 4)) >>> 0);
  }
  for (let i = 0; i < 16; i += 4) {
    let t = key[i]; key[i] = key[i + 3]; key[i + 3] = t;
    t = key[i + 1]; key[i + 1] = key[i + 2]; key[i + 2] = t;
  }
  for (let i = 0; i < 16; i++) key[i] ^= 121;
  return key;
}

// keyMsg: the 164-byte second fp-setup request; ekey: the 72-byte "ekey" from SETUP.
// Returns the 16-byte AES key.
export function playfairDecrypt(keyMsg, ekey) {
  const msg = Uint8Array.from(keyMsg), cipher = Uint8Array.from(ekey);
  if (msg.length !== 164 || cipher.length !== 72) throw new Error('playfair: bad input sizes');
  const chunk1 = cipher.subarray(16, 32), chunk2 = cipher.subarray(56, 72);
  const sapKey = generateSessionKey(T.default_sap, msg);
  const ks = generateKeySchedule(sapKey);
  const block = new Uint8Array(16);
  xorKey(chunk2, 0, block, 0, T.z_key);
  cycle(block, ks);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = block[i] ^ chunk1[i];
  xorKey(out, 0, out, 0, T.x_key);
  xorKey(out, 0, out, 0, T.z_key);
  return Buffer.from(out);
}

// The FairPlay setup exchange (POST /fp-setup, from UxPlay lib/fairplay_playfair.c): a 16-byte
// request gets one of four fixed replies; the 164-byte one is the key message kept for
// playfairDecrypt, answered with a fixed header plus its last 20 bytes. Returns null if unknown.
export function fpSetupReply(req, conn) {
  if (req.length === 16) {
    const mode = req[14];
    if (req[4] !== 0x03 || mode > 3) return null;
    return Buffer.from(T.reply_message.subarray(mode * 142, mode * 142 + 142));
  }
  if (req.length === 164) {
    conn.keyMsg = Buffer.from(req);
    return Buffer.concat([Buffer.from(T.fp_header), req.subarray(144, 164)]);
  }
  return null;
}
