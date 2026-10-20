// A download that survives a slow or broken line: what arrived stays in the file, and the next try asks only for the
// rest (HTTP Range, which shivo-id and nodejs.org answer). A line that sends nothing for a minute counts as broken.
// Used for the module packs (id.mjs); test: node installer/test/resume.mjs.
import { existsSync, statSync, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetches url into file (carrying on from what is already there); tries `tries` times, waiting longer each time.
// A refusal (401, 403, 404) isn't tried again.
export async function download(url, file, { tries = 5, idle = 60000, wait = 5000 } = {}) {
  for (let i = 1; ; i++) {
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(new Error("the line stopped sending")), idle);
    const poke = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error("the line stopped sending")), idle); };
    try {
      const have = existsSync(file) ? statSync(file).size : 0;
      const r = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: ac.signal });
      if (r.status === 416 && have) return;   // already whole (the checksum decides)
      if (!r.ok) { const e = new Error(`the server answered ${r.status}`); e.status = r.status; throw e; }
      const total = r.status === 206 ? have + Number(r.headers.get("content-length") || 0) : Number(r.headers.get("content-length") || 0);
      const tick = new Transform({ transform(chunk, _, done) { poke(); done(null, chunk); } });
      await pipeline(Readable.fromWeb(r.body), tick, createWriteStream(file, { flags: r.status === 206 ? "a" : "w" }), { signal: ac.signal });
      if (total && statSync(file).size < total) throw new Error("the connection closed early");
      return;
    } catch (e) {
      if ([401, 403, 404].includes(e.status) || i >= tries) throw e;
      await sleep(wait * i);
    } finally { clearTimeout(timer); }
  }
}
