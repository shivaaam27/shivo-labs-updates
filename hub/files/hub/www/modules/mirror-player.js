// The iPhone picture: reads frames from /api/mirror/stream ([len u32][flags u8][ts u32][arrived u32][Annex-B H.264/H.265])
// and decodes them with the PC's graphics chip (WebCodecs) onto a canvas. Used by the Mirror page and the floating window.
// stats() says how it is keeping up: frames in and drawn per second, and the delay from the hub receiving a frame to it
// being on screen (same PC clock, so this is exact).

// ---------- reading the video format from the first full picture (for the decoder's codec string)
function nalsOf(buf) {
  const out = []; let i = 0, start = -1;
  while (i + 3 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      if (start >= 0) out.push(buf.subarray(start, i));
      i += buf[i + 2] === 1 ? 3 : 4; start = i;
    } else i++;
  }
  if (start >= 0) out.push(buf.subarray(start));
  return out;
}
const unescape = (b) => { const o = []; for (let i = 0; i < b.length; i++) { if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue; o.push(b[i]); } return Uint8Array.from(o); };
const hex = (n) => n.toString(16).padStart(2, "0");
function codecsFor(isHevc, data) {
  const nals = nalsOf(data);
  if (!isHevc) {
    const sps = nals.find((n) => (n[0] & 0x1f) === 7);
    const exact = sps ? `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}` : null;
    return [exact, "avc1.640033", "avc1.64002A", "avc1.42E01F"].filter(Boolean);
  }
  const raw = nals.find((n) => ((n[0] >> 1) & 0x3f) === 33);
  const list = [];
  if (raw) {
    const s = unescape(raw);
    const space = (s[3] >> 6) & 3, tier = (s[3] >> 5) & 1, prof = s[3] & 0x1f;
    let compat = ((s[4] << 24) | (s[5] << 16) | (s[6] << 8) | s[7]) >>> 0, rev = 0;
    for (let k = 0; k < 32; k++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    const cons = [...s.slice(8, 14)]; while (cons.length > 1 && cons.at(-1) === 0) cons.pop();
    const body = `${["", "A", "B", "C"][space]}${prof}.${(rev >>> 0).toString(16)}.${tier ? "H" : "L"}${s[14]}.${cons.map((c) => c.toString(16).toUpperCase()).join(".")}`;
    list.push("hev1." + body, "hvc1." + body);
  }
  return [...list, "hev1.1.6.L153.B0", "hvc1.1.6.L153.B0", "hev1.2.4.L153.B0"];
}

export function createPlayer(canvas, { base = "", onSize = () => {}, onError = () => {} } = {}) {
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  let alive = true, decoder = null, configured = null, how = null, waitKey = true, abort = null, drawn = 0, lastDrawn = 0;
  const arrivedAt = new Map();               // decoder timestamp -> when the hub received it
  const win = { inN: 0, drawN: 0, lag: 0, lagN: 0, at: performance.now() }, last = { inFps: 0, drawFps: 0, lagMs: 0 };

  function draw(frame) {
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; onSize(canvas.width, canvas.height);
    }
    ctx.drawImage(frame, 0, 0);
    const arr = arrivedAt.get(frame.timestamp);
    if (arr !== undefined) { arrivedAt.delete(frame.timestamp); win.lag += ((Date.now() & 0xffffffff) >>> 0) - arr; win.lagN++; }
    frame.close(); drawn++; win.drawN++; lastDrawn = performance.now();
  }
  async function configure(isHevc, data) {
    // The processor first: it shows each picture as soon as it arrives. The graphics chip's decoder held ~3 pictures
    // back (80-240 ms on Shivam's PC); it stays as the fallback (e.g. H.265 without a software decoder).
    const order = new URLSearchParams(location.search).get("hw") === "1" ? ["prefer-hardware", "no-preference"] : ["prefer-software", "no-preference"];
    for (const hardwareAcceleration of order) for (const codec of codecsFor(isHevc, data)) {
      const cfg = { codec, optimizeForLatency: true, hardwareAcceleration };
      try { if ((await VideoDecoder.isConfigSupported(cfg)).supported) { decoder.configure(cfg); configured = codec; how = hardwareAcceleration; return true; } } catch {}
    }
    return false;
  }
  function newDecoder() {
    try { decoder?.close(); } catch {}
    decoder = new VideoDecoder({ output: draw, error: (e) => { onError("decoder: " + e.message); configured = null; waitKey = true; newDecoder(); } });
  }

  let seq = 0;
  async function onFrame(flags, ts, arrived, data) {
    const key = !!(flags & 1), isHevc = !!(flags & 2);
    win.inN++;
    if (waitKey && !key) return;
    const cfgHevc = !!configured && /^h(ev|vc)1/.test(configured);
    if (!configured || cfgHevc !== isHevc) { // first picture, or the phone switched format
      if (!key) return;
      if (decoder.state === "configured") newDecoder();
      if (!(await configure(isHevc, data))) { onError("This PC can't decode the iPhone's video format (" + (isHevc ? "H.265" : "H.264") + ")"); return; }
    }
    waitKey = false;
    // every frame is decoded: skipping one would smear the picture until the phone's next full frame
    const t = ++seq * 1000;                   // our own increasing timestamps (the phone's can repeat)
    arrivedAt.set(t, arrived); if (arrivedAt.size > 300) arrivedAt.delete(arrivedAt.keys().next().value);
    decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: t, data }));
  }

  async function read() {
    while (alive) {
      abort = new AbortController();
      try {
        const r = await fetch(base + "/api/mirror/stream", { signal: abort.signal, cache: "no-store" });
        const reader = r.body.getReader();
        let buf = new Uint8Array(1 << 20), len = 0;  // grows when needed; consumed bytes are moved down, not re-copied each time
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          if (len + value.length > buf.length) { const nb = new Uint8Array(Math.max(buf.length * 2, len + value.length)); nb.set(buf.subarray(0, len)); buf = nb; }
          buf.set(value, len); len += value.length;
          let off = 0;
          while (len - off >= 4) {
            const n = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
            if (len - off - 4 < n) break;
            const dv = new DataView(buf.buffer, off + 4, 9);
            const p = onFrame(dv.getUint8(0), dv.getUint32(1), dv.getUint32(5), buf.slice(off + 13, off + 4 + n));
            if (!configured) await p;            // only the first picture waits (choosing the decoder)
            off += 4 + n;
          }
          if (off) { buf.copyWithin(0, off, len); len -= off; }
        }
      } catch {}
      if (alive) { configured = null; waitKey = true; newDecoder(); await new Promise((r) => setTimeout(r, 1000)); }
    }
  }

  if (!("VideoDecoder" in window)) { onError("This window can't decode video (WebCodecs missing). Update Microsoft Edge."); return { stop() {}, stats: () => last, showing: () => false, codec: () => null }; }
  newDecoder(); read();
  return {
    stop() { alive = false; abort?.abort(); try { decoder?.close(); } catch {} },
    showing: () => performance.now() - lastDrawn < 2500,
    drawn: () => drawn,
    codec: () => (configured ? (configured.startsWith("avc") ? "H.264" : "H.265") : null),
    stats() {
      const now = performance.now(), secs = (now - win.at) / 1000;
      if (secs >= 1) {
        last.inFps = Math.round(win.inN / secs); last.drawFps = Math.round(win.drawN / secs); last.lagMs = win.lagN ? Math.round(win.lag / win.lagN) : last.lagMs;
        last.queue = decoder?.decodeQueueSize || 0; last.decoder = how === "prefer-software" ? "processor" : "graphics chip";
        Object.assign(win, { inN: 0, drawN: 0, lag: 0, lagN: 0, at: now });
      }
      return last;
    },
  };
}
