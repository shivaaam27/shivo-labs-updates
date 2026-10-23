// Family room on the phone (also the PC: the hub shows this screen). Two ways in, from the TV's Family tab:
//  - Video call the TV: this phone's camera and microphone go to the TV (full screen there) and to the TV's camera phone;
//    the room, seen by that camera phone, shows here.
//  - Be the TV's camera: a phone left at home, facing the room. While this screen is open it waits; when the TV answers
//    a call it sends the room's picture and sound to the caller, and plays the caller's voice (no echo from the TV).
// Set-up messages go through the TV's mailboxes (/call/send, /call/recv; tv/home Call.java); the picture and sound go
// straight between the devices (WebRTC, encrypted). Over mobile data some networks need a relay server: the TV relay gives
// a paired phone short-lived passwords for Cloudflare's TURN server (tv/relay /k/<key>/turn; UNIFY-PLAN.md phase 4).
const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const iceFor = async (ice) => { try { const more = ice ? await Promise.race([ice(), nap(4000).then(() => [])]) : []; return [...ICE, ...(Array.isArray(more) ? more : [])]; } catch { return ICE; } };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gathered = (p) => new Promise((ok) => {
  if (p.iceGatheringState === 'complete') return ok();
  const t = setTimeout(ok, 3000);
  p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); ok(); } });
});

const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  mic: '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM6 11a6 6 0 0 0 12 0M12 17v4"/>',
  micOff: '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM6 11a6 6 0 0 0 12 0M12 17v4"/><path d="M4 4l16 16"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="6.5" height="5" rx="1.2"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  end: '<path d="M3.5 14.5c5-4.5 12-4.5 17 0l-2 2.5-3-1.5v-2.5a9 9 0 0 0-5 0v2.5l-3 1.5z"/>',
  flip: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><path d="M9.5 13.5a2.5 2.5 0 0 1 4.3-1.7M14.5 13.5a2.5 2.5 0 0 1-4.3 1.7"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M12 17v4"/>',
};
const dockBtn = (id, ic, label, cls = '') => `<button class="${cls}" id="${id}">${svg(ic)}<span>${label}</span></button>`;
const setBtn = (b, ic, label) => { b.innerHTML = `${svg(ic)}<span>${label}</span>`; };

function css() {
  if (document.getElementById('tvCallCss')) return;
  const st = document.createElement('style'); st.id = 'tvCallCss';
  st.textContent = `.tvc{position:fixed;inset:0;z-index:9999;background:#0B0B0C;color:#ECEDE9;display:flex;flex-direction:column;font:15px/1.4 var(--body,system-ui,sans-serif);animation:tvcin .35s var(--ease,ease) both}
    @keyframes tvcin{from{opacity:0}}
    .tvc svg{fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    .tvc-big{flex:1;min-height:0;position:relative;background:#0E0F11}.tvc-big video{width:100%;height:100%;object-fit:cover}
    .tvc-me{position:absolute;right:16px;top:calc(env(safe-area-inset-top) + 72px);width:28vw;max-width:150px;aspect-ratio:3/4;border-radius:22px;overflow:hidden;background:#1b1c1f;
      border:.5px solid rgba(255,255,255,.28);box-shadow:0 12px 30px rgba(0,0,0,.5)}
    .tvc-me video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
    .tvc-top{position:absolute;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top) + 14px) 18px 16px;display:flex;align-items:center;gap:10px;background:linear-gradient(rgba(0,0,0,.6),transparent)}
    .tvc-top b{flex:1;min-width:0;font:500 22px/1.2 var(--display,system-ui);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tvc-top small{flex:none;padding:6px 12px;border-radius:99px;font:600 12.5px var(--body,system-ui);color:#ECEDE9;background:rgba(255,255,255,.14);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
    .tvc-msg{position:absolute;left:24px;right:24px;top:40%;display:flex;flex-direction:column;align-items:center;gap:16px;margin:0;text-align:center;color:#C9CCC6;font:400 18px/1.35 var(--display,system-ui)}
    .tvc-msg::before{content:"";width:84px;height:84px;border-radius:50%;background:rgba(255,255,255,.08) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ECEDE9' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='5' width='18' height='12' rx='2.5'/%3E%3Cpath d='M8 21h8M12 17v4'/%3E%3C/svg%3E") center/38px no-repeat;
      animation:tvcring 1.8s var(--ease,ease) infinite}
    @keyframes tvcring{0%{box-shadow:0 0 0 0 rgba(127,176,139,.5)}70%,100%{box-shadow:0 0 0 26px rgba(127,176,139,0)}}
    .tvc-bar{position:absolute;left:16px;right:16px;bottom:max(18px,env(safe-area-inset-bottom));display:flex;justify-content:center;gap:22px;padding:14px 18px 12px;border-radius:38px;
      background:rgba(40,41,45,.55);border:.5px solid rgba(255,255,255,.2);-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%);box-shadow:0 18px 50px -12px rgba(0,0,0,.6)}
    .tvc-bar button{display:flex;flex-direction:column;align-items:center;gap:7px;min-width:64px;color:#ECEDE9;font:600 11.5px/1 var(--body,system-ui);transition:transform .15s var(--spring,ease)}
    .tvc-bar button:active{transform:scale(.92)}
    .tvc-bar button svg{width:58px;height:58px;padding:17px;border-radius:50%;background:rgba(255,255,255,.14);transition:background .2s,color .2s}
    .tvc-bar .on svg{background:#ECEDE9;color:#141517}
    .tvc-bar .end svg{background:#D0453A;color:#fff}`;
  document.head.appendChild(st);
}

/** Calls the TV from this phone. call(path, q, opts) talks to the current TV (tv.js). */
export async function callTv({ call, tvName = 'the TV', toast = () => {}, ice = null }) {
  css();
  const iceServers = iceFor(ice);
  const el = document.createElement('div'); el.className = 'tvc';
  el.innerHTML = `<div class="tvc-big"><video id="tvcRoom" autoplay playsinline></video><p class="tvc-msg" id="tvcMsg">Calling ${esc(tvName)}…</p>
      <div class="tvc-top"><b>${esc(tvName)}</b><small id="tvcState">Ringing</small></div><div class="tvc-me"><video id="tvcMe" autoplay playsinline muted></video></div></div>
    <div class="tvc-bar">${dockBtn('tvcMute', IC.mic, 'Mute')}${dockBtn('tvcSmall', IC.pip, 'Small on TV')}${dockBtn('tvcEnd', IC.end, 'End', 'end')}</div>`;
  document.body.appendChild(el);
  const $ = (id) => el.querySelector('#' + id), say = (t) => { $('tvcMsg').textContent = t; $('tvcMsg').hidden = !t; };
  let open = true, stream = null, small = false;
  const pcs = {};
  const finish = async (why) => {
    if (!open) return; open = false;
    Object.values(pcs).forEach((p) => p.close());
    stream?.getTracks().forEach((t) => t.stop());
    try { await call('/call/end', {}, { post: true, ms: 4000 }); } catch {}
    el.remove(); if (why) toast(why);
  };
  $('tvcEnd').onclick = () => finish();
  $('tvcMute').onclick = () => { const a = stream?.getAudioTracks()[0]; if (!a) return; a.enabled = !a.enabled; $('tvcMute').classList.toggle('on', !a.enabled); setBtn($('tvcMute'), a.enabled ? IC.mic : IC.micOff, a.enabled ? 'Mute' : 'Muted'); };
  $('tvcSmall').onclick = async () => { small = !small; setBtn($('tvcSmall'), small ? IC.expand : IC.pip, small ? 'Full on TV' : 'Small on TV'); try { await call('/call/size', { a: small ? 'small' : 'big' }, { post: true }); } catch {} };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    $('tvcMe').srcObject = stream;
  } catch (e) { await finish(e.name === 'NotAllowedError' ? 'Camera access is off. Allow it in Settings.' : 'Camera unavailable'); return; }
  const r = await call('/call/ring', {}, { post: true, body: JSON.stringify({}) }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { await finish(r.error || 'The TV could not ring'); return; }
  // an offer to each side that says it is ready (the TV, and the camera phone if there is one)
  async function offerTo(who) {
    pcs[who]?.close();
    const pc = pcs[who] = new RTCPeerConnection({ iceServers: await iceServers });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    if (who === 'cam') pc.ontrack = (e) => { $('tvcRoom').srcObject = e.streams[0]; say(''); };
    pc.onconnectionstatechange = () => { if (who === 'tv') $('tvcState').textContent = { connected: 'On the TV', connecting: 'Connecting…', failed: 'Could not connect', disconnected: 'Connection lost…' }[pc.connectionState] || ''; };
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    await call('/call/send', { a: who }, { post: true, body: JSON.stringify({ from: 'caller', kind: 'offer', sdp: pc.localDescription.sdp }) });
  }
  let answered = false;
  const t0 = Date.now();
  while (open) {
    try {
      const msgs = await call('/call/recv', { a: 'caller' }, { ms: 5000 });
      for (const m of msgs || []) {
        if (m.kind === 'ready') { answered = true; $('tvcState').textContent = 'Connecting…'; offerTo(m.from).catch(() => {}); if (m.from === 'tv' && !$('tvcRoom').srcObject) say('Connected. No camera phone at home.'); }
        else if (m.kind === 'answer' && pcs[m.from]) await pcs[m.from].setRemoteDescription({ type: 'answer', sdp: m.sdp });
        else if (m.kind === 'bye') { await finish(m.why === 'declined' ? 'Declined' : m.why === 'missed' ? 'No answer' : 'Call ended'); return; }
      }
      if (!answered) { const st = await call('/call/state', {}, { ms: 4000 }); if (st.state === 'idle') { await finish('No answer'); return; } if (Date.now() - t0 > 70000) { await finish('No answer'); return; } }
    } catch {}
    await nap(answered ? 900 : 700);
  }
}

/** This phone is the TV's camera: waits for calls the TV answers, then shows the room to the caller. */
export async function beCamera({ call, tvName = 'the TV', toast = () => {}, ice = null }) {
  css();
  const iceServers = iceFor(ice);
  const el = document.createElement('div'); el.className = 'tvc';
  el.innerHTML = `<div class="tvc-big"><video id="tvcCaller" autoplay playsinline></video><p class="tvc-msg" id="tvcMsg">Camera for ${esc(tvName)}. Keep this screen open.</p>
      <div class="tvc-top"><b>TV camera</b><small id="tvcState">Waiting for a call</small></div><div class="tvc-me"><video id="tvcMe" autoplay playsinline muted></video></div></div>
    <div class="tvc-bar">${dockBtn('tvcMute', IC.mic, 'Mute')}${dockBtn('tvcFlip', IC.flip, 'Flip')}${dockBtn('tvcEnd', IC.end, 'Stop', 'end')}</div>`;
  document.body.appendChild(el);
  const $ = (id) => el.querySelector('#' + id), say = (t) => { $('tvcMsg').textContent = t; $('tvcMsg').hidden = !t; };
  let open = true, stream = null, pc = null, facing = 'user', callId = '', sound = 'phone';
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  const startCam = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    $('tvcMe').srcObject = stream;
  };
  const hang = () => { pc?.close(); pc = null; $('tvcCaller').srcObject = null; callId = ''; $('tvcState').textContent = 'Waiting'; say(`Camera for ${tvName}. Keep this screen open.`); };
  $('tvcEnd').onclick = () => { open = false; hang(); stream?.getTracks().forEach((t) => t.stop()); wake?.release?.(); el.remove(); };
  $('tvcMute').onclick = () => { const a = stream?.getAudioTracks()[0]; if (!a) return; a.enabled = !a.enabled; $('tvcMute').classList.toggle('on', !a.enabled); setBtn($('tvcMute'), a.enabled ? IC.mic : IC.micOff, a.enabled ? 'Mute' : 'Muted'); };
  $('tvcFlip').onclick = async () => { facing = facing === 'user' ? 'environment' : 'user'; try { await startCam(); if (pc) pc.getSenders().forEach((s) => { const t = stream.getTracks().find((x) => x.kind === s.track?.kind); if (t) s.replaceTrack(t); }); } catch {} };
  try { await startCam(); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Camera access is off. Allow it in Settings.' : 'Camera unavailable'); el.remove(); return; }
  while (open) {
    try {
      const msgs = await call('/call/recv', { a: 'cam' }, { ms: 5000 });   // also tells the TV this camera is here
      for (const m of msgs || []) {
        if (m.kind === 'offer') {
          pc?.close();
          pc = new RTCPeerConnection({ iceServers: await iceServers });
          stream.getTracks().forEach((t) => pc.addTrack(t, stream));
          pc.ontrack = (e) => { const v = $('tvcCaller'); v.srcObject = e.streams[0]; v.muted = sound !== 'phone'; say(''); };
          pc.onconnectionstatechange = () => { $('tvcState').textContent = { connected: 'In a call', connecting: 'Connecting…', failed: 'Could not connect' }[pc.connectionState] || ''; };
          await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
          await pc.setLocalDescription(await pc.createAnswer());
          await gathered(pc);
          await call('/call/send', { a: 'caller' }, { post: true, body: JSON.stringify({ from: 'cam', kind: 'answer', sdp: pc.localDescription.sdp }) });
        } else if (m.kind === 'bye') hang();
      }
      const st = await call('/call/state', {}, { ms: 4000 });
      sound = st.sound || 'phone';
      if (st.state === 'active' && st.id !== callId) {
        callId = st.id; $('tvcState').textContent = `Call with ${st.who}`; say(`Connecting to ${st.who}…`);
        await call('/call/send', { a: 'caller' }, { post: true, body: JSON.stringify({ from: 'cam', kind: 'ready' }) });
      } else if (st.state !== 'active' && callId) hang();
    } catch {}
    await nap(pc ? 1500 : 1200);
  }
}
