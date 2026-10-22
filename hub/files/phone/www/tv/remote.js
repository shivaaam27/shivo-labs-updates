// The TV remote in the phone app (and the PC's TV page): one card, like a real remote.
// Buttons: the round pad with OK, then Back, Home, Play; volume; Type, Inputs, Apps.
// Touchpad: the round pad becomes a touch area (slide moves a pointer on the TV, tap presses, two fingers scroll; the
// phone's motion can move it too); every other button stays where it is.
// Where a button goes: Google's own TV remote link when it is set up on this phone (fastest, works in every app), else
// our TV app presses it (Remote.java /key: works from anywhere, also through the relay; arrows in other apps need
// Android 13 on the TV, so this card offers the one-time remote setup when they don't work).
import * as atv from './atvremote.js';
import { deviceName } from '../engine/beam.js';

const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const I = {
  up: svg('<path d="M6 15l6-6 6 6"/>'), down: svg('<path d="M6 9l6 6 6-6"/>'), left: svg('<path d="M15 6l-6 6 6 6"/>'), right: svg('<path d="M9 6l6 6-6 6"/>'),
  back: svg('<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>'),
  home: svg('<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>'),
  play: svg('<path d="M5 6v12l7-6zM15 6v12M19 6v12"/>'),
  minus: svg('<path d="M6 12h12"/>'), plus: svg('<path d="M12 6v12M6 12h12"/>'),
  vol: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/>'),
  mute: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  kbd: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>'),
  input: svg('<path d="M4 8h16v5l-2 3H6l-2-3z"/><path d="M8 11h8"/>'),
  apps: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
  screen: svg('<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M7 14l3-3.5 2.5 2.5 2-2L17 14M8 21h8"/>'),
  pointer: svg('<path d="M5 3.5l13 6.2-5.6 1.7-1.7 5.6z"/><path d="M12.6 12.6l5.4 5.4"/>'),
  motion: svg('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M3 9c-1 2-1 4 0 6M21 9c1 2 1 4 0 6"/>'),
  del: svg('<path d="M20 6H9l-5 6 5 6h11z"/><path d="M12 10l4 4M16 10l-4 4"/>'),
};
const GKEY = { recents: 'menu' };   // our names -> Google's remote names, where they differ

export function makeRemote(ctx) {
  // ctx: call(path, q, opts), cur() (the TV), away() (through the relay), dev() ({vol, volMax, muted}), toast, buzz,
  //      openLive(), setTab(id), port
  const { call, toast, buzz } = ctx;
  let mode = 'keys';
  try { mode = localStorage.getItem('sl.tvRemoteMode') || 'keys'; } catch {}
  let holding = false, laterPaint = false;
  let rc = null, rcBusy = null, rcPair = null, ws = null, typing = false, motionOn = false, needSetup = false, box = null;
  const host = () => ctx.cur()?.host;
  const google = () => atv.available() && !ctx.away() && host() && atv.isPaired(host());

  // ---- Google's remote link ----
  function remote() {
    if (rc) return Promise.resolve(rc);
    if (rcBusy) return rcBusy;
    rcBusy = atv.connect(host(), { onClose: () => { rc = null; } }).then(async (r) => { await r.ready; rc = r; return r; }).finally(() => { rcBusy = null; });
    return rcBusy;
  }
  // one code to pair: our TV app's helper reads Google's code off the TV and this phone types it itself
  async function autoPair(say = () => {}) {
    if (!atv.available() || ctx.away() || !host() || atv.isPaired(host())) return;
    const before = (await call('/atvcode', {}, { ms: 3000 }).catch(() => ({})))?.code || null;
    say('Connecting…');
    rcPair = await atv.pair(host(), deviceName() || 'Shivo Labs phone', say);
    say('Pairing…');
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const r = await call('/atvcode', {}, { ms: 3000 }).catch(() => null);
      if (r && r.helper === false) break;
      if (r?.code && r.code !== before) { await rcPair.finish(r.code); rcPair = null; needSetup = false; buzz('success'); toast('Remote ready'); return; }
    }
  }

  // ---- one way to press a button ----
  async function key(k) {
    buzz();
    if (google()) {
      try { const r = await remote(); await r.key(atv.KEY[GKEY[k] || k]); return; }
      catch (e) { rc = null; if (/certificate|refused|closed|failed/i.test(e.message)) { atv.forget(host()); toast('Remote pairing expired. Set it up again.'); paint(); return; } }
    }
    const r = await call('/key', { a: k }, { post: true }).catch((e) => { toast(e.message); return null; });
    if (r && r.ok === false && !needSetup && ['up', 'down', 'left', 'right', 'ok'].includes(k)) {
      needSetup = true;
      if (holding) laterPaint = true; else paint();   // never redrawn under a thumb that is dragging OK
      toast(atv.available() ? 'Set up the full remote for arrows in all apps.' : 'Arrows in other apps: use the phone app.');
    }
  }
  async function volume(step) {
    buzz();
    try {
      const r = await call('/volume', { a: step }, { post: true });
      const d = ctx.dev(); d.vol = r.vol;
      const n = box?.querySelector('#rvN'), bar = box?.querySelector('#rvBar');
      if (n) n.textContent = r.vol;
      if (bar) bar.style.width = `${d.volMax ? Math.round(100 * r.vol / d.volMax) : 0}%`;
    } catch (e) { toast(e.message); }
  }

  // ---- the touchpad's link (home Wi-Fi only) ----
  let dx = 0, dy = 0, raf = 0;
  function openWs() {
    if (ws && ws.readyState <= 1) return ws;
    if (ctx.away() || !host()) return null;
    ws = new WebSocket(`ws://${host()}:${ctx.port}/mouse?${new URLSearchParams({ k: ctx.cur().key })}`);
    ws.onmessage = (e) => { const m = String(e.data); if (m.startsWith('x ') && m !== 'x type') key(m.slice(2)); };
    ws.onclose = () => { ws = null; };
    return ws;
  }
  const wsSend = (m) => { const w = openWs(); if (w?.readyState === 1) w.send(m); else w?.addEventListener('open', () => w.send(m), { once: true }); };
  const moveSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (ws?.readyState === 1 && (Math.abs(dx) >= 1 || Math.abs(dy) >= 1)) { ws.send(`m ${dx.toFixed(1)} ${dy.toFixed(1)}`); dx = 0; dy = 0; } }); };
  function closeWs() { stopMotion(); try { ws?.readyState === 1 && ws.send('h'); ws?.close(); } catch {} ws = null; }

  // phone motion moves the pointer: turning left/right is the spin around the up direction (so it works however the
  // phone is held), tilting is the spin across it; tiny shakes are ignored, slow turns move finely, fast ones far
  let upv = [0, 0, 1], sx = 0, sy = 0, nativeSub = null, nMotion = 0, padTouch = false, motionQuietUntil = 0;
  const curve = (v) => { const a = Math.abs(v); if (a < 1.2) return 0; const q = a - 1.2; return Math.sign(v) * (q < 20 ? q * (0.7 + q / 66) : q); };
  const onMotion = (e) => {
    nMotion++;
    const g = e.accelerationIncludingGravity, r = e.rotationRate;
    if (g && g.x != null) {
      const n = Math.hypot(g.x, g.y, g.z) || 1;
      let u = [g.x / n, g.y / n, g.z / n];
      if (u[2] + u[1] < 0) u = u.map((v) => -v);
      upv = upv.map((v, i) => v * 0.85 + u[i] * 0.15);
    }
    if (!motionOn || !r) return;
    // a finger on the pad (and a moment after) holds the pointer still: tapping the glass jolts the phone, and the jolt
    // moved the pointer onto the next button just before the click (Shivam, 22 Oct)
    if (padTouch || Date.now() < motionQuietUntil) { sx = 0; sy = 0; return; }
    const t = (e.interval > 1 ? e.interval / 1000 : e.interval) || 0.016;
    const yaw = (r.beta || 0) * upv[0] + (r.gamma || 0) * upv[1] + (r.alpha || 0) * upv[2];
    sx = sx * 0.4 + curve(yaw) * 0.6; sy = sy * 0.4 + curve(r.beta || 0) * 0.6;
    dx += -sx * t * 30; dy += -sy * t * 30; moveSoon();
  };
  async function startMotion() {
    const T = window.Capacitor?.Plugins?.ShivoTls;
    try {
      if (T?.motionStart) {
        if (!nativeSub) nativeSub = await T.addListener('motion', (m) => onMotion({ interval: 1 / 60, rotationRate: { alpha: m.rz, beta: m.rx, gamma: m.ry }, accelerationIncludingGravity: { x: m.gx, y: m.gy, z: m.gz } }));
        await T.motionStart(); nMotion = 0;
        setTimeout(() => { if (!nMotion) addEventListener('devicemotion', onMotion); }, 1200);
        return true;
      }
      if (typeof DeviceMotionEvent?.requestPermission === 'function' && (await DeviceMotionEvent.requestPermission()) !== 'granted') return false;
      if (!('DeviceMotionEvent' in window)) return false;
      addEventListener('devicemotion', onMotion); return true;
    } catch { return false; }
  }
  function stopMotion() { removeEventListener('devicemotion', onMotion); window.Capacitor?.Plugins?.ShivoTls?.motionStop?.().catch(() => {}); nativeSub?.remove?.(); nativeSub = null; }

  // ---- drawing ----
  function html() {
    const d = ctx.dev(), v = d.volMax ? Math.round(100 * d.vol / d.volMax) : 0, away = ctx.away();
    const pad = mode === 'pad' && !away;
    const setup = rcPair ? `<div class="tvr-setup pair"><b>Enter the code shown on the TV</b>
        <div class="tvr-pairrow"><input class="field" id="rcCode" maxlength="6" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="A1B2C3"><button class="btn pri sm" id="rcFinish">Pair</button></div>
        <button class="tvr-link" id="rcCancel">Cancel</button></div>`
      : !away && atv.available() && host() && !atv.isPaired(host()) ? `<div class="tvr-setup${needSetup ? ' hi' : ''}"><span>Full remote: arrows in every app</span><button class="btn sm${needSetup ? ' pri' : ''}" id="rcSetup">Set up</button></div>`
      : needSetup && !atv.available() ? '' : '';
    return `<section class="tvr" data-view="${pad ? 'pad' : 'keys'}">
      <div class="tvr-head">
        <div class="tvr-mode" role="tablist">${[['keys', 'Buttons'], ['pad', 'Touchpad']].map(([id, n]) => `<button data-mode="${id}" class="${(pad ? 'pad' : 'keys') === id ? 'on' : ''}" ${id === 'pad' && away ? 'disabled title="At home only"' : ''}>${n}</button>`).join('')}</div>
        <button class="tvr-mini" data-x="live" aria-label="See the TV screen" title="See the TV screen">${I.screen}</button>
      </div>
      ${setup}
      <div class="tvr-stage">${pad ? `
        <div class="tvr-pad" id="rcPad"><span class="tvr-pad-ic">${I.pointer}</span><p>Slide to move · Tap to select</p><small>Two fingers to scroll</small>
          <button class="tvr-chip${motionOn ? ' on' : ''}" id="rcMotion">${I.motion}${motionOn ? 'Motion on' : 'Motion'}</button></div>` : `
        <div class="tvr-dpad">
          <button class="tvr-dk up" data-k="up" aria-label="Up">${I.up}</button><button class="tvr-dk left" data-k="left" aria-label="Left">${I.left}</button>
          <button class="tvr-dk right" data-k="right" aria-label="Right">${I.right}</button><button class="tvr-dk down" data-k="down" aria-label="Down">${I.down}</button>
          <button class="tvr-okk" id="rcJoy" aria-label="OK. Drag to move.">OK</button></div>`}
      </div>
      <div class="tvr-row">
        <button class="tvr-b" data-k="back">${I.back}<span>Back</span></button>
        <button class="tvr-b" data-k="home">${I.home}<span>Home</span></button>
        <button class="tvr-b" data-k="playPause">${I.play}<span>Play</span></button>
      </div>
      <div class="tvr-vol">
        <button class="tvr-round" data-v="-1" aria-label="Quieter">${I.minus}</button>
        <div class="tvr-volm"><div class="tvr-volt"><span>${d.muted ? I.mute : I.vol}</span><b id="rvN">${d.vol ?? '–'}</b></div><div class="tvx-track"><i id="rvBar" style="width:${v}%"></i></div></div>
        <button class="tvr-round" data-v="1" aria-label="Louder">${I.plus}</button>
        <button class="tvr-round${d.muted ? ' on' : ''}" data-x="mute" aria-label="Mute">${I.mute}</button>
      </div>
      <div class="tvr-row">
        <button class="tvr-b${typing ? ' on' : ''}" data-x="type">${I.kbd}<span>Type</span></button>
        <button class="tvr-b" data-x="inputs">${I.input}<span>Inputs</span></button>
        <button class="tvr-b" data-k="recents">${I.apps}<span>Apps</span></button>
      </div>
      <form class="tvr-type" id="rcType" ${typing ? '' : 'hidden'}><input class="field" id="rcText" placeholder="Type on the TV" autocomplete="off" autocorrect="off" autocapitalize="off"><button class="tvr-round" type="button" id="rcDel" aria-label="Delete">${I.del}</button><button class="btn pri sm" type="submit">Enter</button></form>
    </section>`;
  }
  function paint() { if (box) { box.innerHTML = html(); wire(); fit(); } }
  function wire() {
    const q = (s) => box.querySelector(s);
    box.querySelectorAll('.tvr-mode [data-mode]').forEach((b) => (b.onclick = () => {
      if (b.disabled) return;
      mode = b.dataset.mode; try { localStorage.setItem('sl.tvRemoteMode', mode); } catch {}
      buzz(); if (mode === 'pad') openWs(); else closeWs(); paint();
    }));
    box.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => key(b.dataset.k)));
    box.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => volume(b.dataset.v)));
    box.querySelectorAll('[data-x]').forEach((b) => (b.onclick = async () => {
      const x = b.dataset.x;
      if (x === 'live') return ctx.openLive();
      if (x === 'inputs') { buzz(); return ctx.setTab('inputs'); }
      if (x === 'type') { typing = !typing; buzz(); paint(); if (typing) setTimeout(() => q('#rcText')?.focus(), 50); return; }
      if (x === 'mute') { buzz(); try { const r = await call('/mute', {}, { post: true }); ctx.dev().muted = r.muted; paint(); } catch (e) { toast(e.message); } }
    }));
    q('#rcSetup')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { await autoPair((m) => { b.textContent = m; }); } catch (err) { toast(err.message); }
      paint(); if (rcPair) setTimeout(() => q('#rcCode')?.focus(), 200);
    });
    q('#rcFinish')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { await rcPair.finish(q('#rcCode').value); rcPair = null; needSetup = false; buzz('success'); toast('Remote ready'); }
      catch (err) { b.disabled = false; toast(err.message); }
      paint();
    });
    q('#rcCancel')?.addEventListener('click', () => { rcPair?.cancel(); rcPair = null; paint(); });
    // typing: each letter goes to the TV's focused box as it is typed
    const input = q('#rcText');
    input?.addEventListener('input', async (e) => {
      const t = e.data || ''; if (!t) return;
      if (google()) { try { (await remote()).text(t); } catch (err) { toast(err.message); } return; }
      if (ctx.away()) return;
      wsSend(`t ${t}`);
    });
    q('#rcDel')?.addEventListener('click', () => { buzz(); if (input) input.value = input.value.slice(0, -1); if (google()) remote().then((r) => r.key(atv.KEY.del)).catch(() => {}); else wsSend('t \b'); });
    q('#rcType')?.addEventListener('submit', (e) => { e.preventDefault(); key('ok'); });
    // OK is also a joystick: drag it and the TV moves that way, again and again while it is held (faster further out);
    // let go and it springs back. A tap without dragging is OK.
    const joy = q('#rcJoy');
    if (joy) {
      const ring = joy.parentElement;
      let start = null, dir = '', rep = 0, moved = false;
      const stopRep = () => { clearTimeout(rep); rep = 0; };
      const step = (d, dist, max) => {
        key(d);
        const t = 430 - 320 * Math.min(1, Math.max(0, (dist - 16) / Math.max(1, max - 16)));
        rep = setTimeout(() => step(dir, lastDist, max), Math.round(t));
      };
      let lastDist = 0;
      joy.addEventListener('pointerdown', (e) => { holding = true; start = [e.clientX, e.clientY]; moved = false; dir = ''; try { joy.setPointerCapture(e.pointerId); } catch {} joy.classList.add('held'); });
      joy.addEventListener('pointermove', (e) => {
        if (!start) return;
        const max = ring.offsetWidth * 0.22;
        let x = e.clientX - start[0], y = e.clientY - start[1];
        const dist = Math.hypot(x, y);
        if (dist > max) { x = x * max / dist; y = y * max / dist; }
        joy.style.transform = `translate(${x}px, ${y}px)`;
        lastDist = Math.min(dist, max);
        if (dist < 16) return;
        moved = true;
        const d = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
        if (d !== dir) { dir = d; ring.dataset.go = d; stopRep(); step(d, lastDist, max); }
      });
      const end = () => {
        if (!start) return;
        stopRep(); start = null; joy.classList.remove('held'); joy.style.transform = ''; delete ring.dataset.go;
        holding = false;
        if (!moved) key('ok');
        if (laterPaint) { laterPaint = false; paint(); }
      };
      joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
      joy.addEventListener('click', (e) => { if (e.detail === 0) key('ok'); });   // Enter or Space on a keyboard
    }
    // the touchpad
    const pad = q('#rcPad');
    if (pad) {
      openWs();
      q('#rcMotion').onclick = async (e) => {
        e.stopPropagation();
        motionOn = !motionOn;
        if (motionOn && !(await startMotion())) { motionOn = false; toast('Motion sensor not available'); }
        if (!motionOn) stopMotion();
        buzz(); paint();
      };
      const pts = new Map();
      let down = 0, moved = 0, two = false, sAcc = 0, sX = 0, sT = 0;
      pad.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#rcMotion')) return;
        try { pad.setPointerCapture(e.pointerId); } catch {}
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        holding = true;
        if (motionOn) { padTouch = true; dx = 0; dy = 0; }
        if (pts.size === 1) { down = Date.now(); moved = 0; two = false; } else two = true;
        pad.classList.add('touch');
      });
      pad.addEventListener('pointermove', (e) => {
        const p = pts.get(e.pointerId); if (!p) return;
        const mx = e.clientX - p[0], my = e.clientY - p[1]; pts.set(e.pointerId, [e.clientX, e.clientY]); moved += Math.abs(mx) + Math.abs(my);
        if (pts.size >= 2) {   // two fingers: added up and sent a few times a second (each is a whole scroll step on the TV)
          sAcc += my / pts.size; sX += mx / pts.size;
          if (!sT) sT = setTimeout(() => { sT = 0; if (Math.abs(sAcc) >= 8 || Math.abs(sX) >= 8) { wsSend(`S ${(sX * 3).toFixed(0)} ${(sAcc * 3).toFixed(0)}`); buzz(); } sAcc = 0; sX = 0; }, 160);
          return;
        }
        dx += mx * 2.6; dy += my * 2.6; openWs(); moveSoon();
      });
      const up = (e) => {
        if (!pts.delete(e.pointerId)) return;
        if (!pts.size) { padTouch = false; motionQuietUntil = Date.now() + 250; pad.classList.remove('touch'); holding = false; if (laterPaint) { laterPaint = false; setTimeout(paint, 0); } }
        if (!pts.size && !two && moved < 24 && Date.now() - down < 400) { wsSend('c'); buzz('medium'); }
      };
      pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
    }
  }
  // tablet and PC: everything on the left fits the window without scrolling. The round pad (and the touchpad) takes
  // what height is left; if even a small pad does not fit, now playing makes room.
  function fit() {
    const side = box?.closest('.tvx-side');
    if (!side || !matchMedia('(min-width: 760px)').matches) { side?.classList.remove('tight'); box?.querySelector('.tvr')?.style.removeProperty('--pad'); return; }
    const r = box.querySelector('.tvr'); if (!r) return;
    side.classList.remove('tight');
    r.style.setProperty('--pad', '250px');
    const sc = side.closest('.scroll') || document.documentElement;
    const top = side.getBoundingClientRect().top;
    // the remote's column has its own height limit (tv.css): fit inside that too, so its bottom is never cut off
    const maxH = parseFloat(getComputedStyle(side).maxHeight) || Infinity;
    const bottom = Math.min(innerHeight, sc.getBoundingClientRect().bottom || innerHeight, top + maxH);
    const over = top + side.scrollHeight - bottom + 14;
    let pad = Math.round(Math.max(130, Math.min(250, 250 - over)));
    if (250 - over < 200) { side.classList.add('tight'); const over2 = top + side.scrollHeight - bottom + 14; pad = Math.round(Math.max(120, Math.min(250, 250 - over2))); }
    r.style.setProperty('--pad', pad + 'px');
  }
  let fitT = 0;
  addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fit, 120); });
  return {
    html,
    mount(el) { box = el; if (box) { box.innerHTML = html(); wire(); requestAnimationFrame(fit); } },
    fit,
    refresh() { const t = box?.querySelector('#rcText'); if (document.activeElement && document.activeElement === t) return; paint(); },
    afterPair() { return autoPair().then(paint).catch(() => {}); },
    // a phone-side key for other screens (Live view's Back/Home)
    key,
    stop() { closeWs(); rc?.close?.(); rc = null; },
    forget() { atv.forget(host()); closeWs(); rc?.close?.(); rc = null; },
  };
}
