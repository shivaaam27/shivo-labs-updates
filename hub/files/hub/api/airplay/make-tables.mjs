// Rebuilds playfair-tables.mjs from a UxPlay checkout:  node make-tables.mjs <UxPlay folder> playfair-tables.mjs
import fs from 'node:fs';
const [, , refDir, outFile] = process.argv;
const src = fs.readFileSync(refDir + '/lib/playfair/omg_hax.h', 'utf8') + '\n' + fs.readFileSync(refDir + '/lib/playfair/omg_hax.c', 'utf8') + '\n' + fs.readFileSync(refDir + '/lib/fairplay_playfair.c', 'utf8');
const re = /(unsigned char|unsigned long|uint32_t|char)\s+(\w+)\s*((?:\[[^\]]*\])*)\s*=\s*\{([\s\S]*?)\};/g;
const want = { message_key: 8, message_iv: 8, z_key: 8, x_key: 8, t_key: 8, table_s1: 8, table_s2: 8, table_s3: 8, table_s4: 8, table_s10: 8,
  table_s5: 32, table_s6: 32, table_s7: 32, table_s8: 32, table_s9: 32, index_mangle: 8, initial_session_key: 8, static_source_1: 8, static_source_2: 8, default_sap: 8, reply_message: 8, fp_header: 8 };
const out = {};
let m;
while ((m = re.exec(src))) {
  const name = m[2];
  if (!(name in want)) continue;
  const nums = m[4].match(/0x[0-9a-fA-F]+|\d+/g).map(s => Number(s));
  const bits = want[name];
  const buf = bits === 8 ? Buffer.from(nums.map(n => { if (n > 255) throw name; return n; })) : (() => { const b = Buffer.alloc(nums.length * 4); nums.forEach((n, i) => b.writeUInt32LE(n >>> 0, i * 4)); return b; })();
  out[name] = { bits, len: nums.length, b64: buf.toString('base64') };
}
for (const k of Object.keys(want)) if (!out[k]) throw new Error('missing ' + k);
let js = '// Data tables for playfair.mjs, converted from UxPlay lib/playfair/omg_hax.h, omg_hax.c and fairplay_playfair.c (GPL-3.0).\n// Regenerate with make-tables.mjs (next to this file); do not edit by hand.\n';
js += 'const b = s => Buffer.from(s, "base64");\nconst w = s => { const x = b(s); const o = new Uint32Array(x.length / 4); for (let i = 0; i < o.length; i++) o[i] = x.readUInt32LE(i * 4); return o; };\n';
for (const [k, v] of Object.entries(out)) js += `export const ${k} = ${v.bits === 8 ? 'b' : 'w'}("${v.b64}"); // ${v.len}\n`;
fs.writeFileSync(outFile, js);
for (const [k, v] of Object.entries(out)) console.log(k, v.bits, v.len);
