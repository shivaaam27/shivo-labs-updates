// Family room on the phone (also the PC: the hub shows this screen). Two ways in, from the TV's Family tab:
//  - Video call the TV: this phone's camera and microphone go to the TV (full screen there) and to the TV's camera phone;
//    the room, seen by that camera phone, shows here.
//  - Be the TV's camera: a phone left at home, facing the room. While this screen is open it waits; when the TV answers
//    a call it sends the room's picture and sound to the caller, and plays the caller's voice (no echo from the TV).
// Set-up messages go through the TV's mailboxes (/call/send, /call/recv; tv/home Call.java); the picture and sound go
// straight between the devices (WebRTC, encrypted). Over mobile data some networks need a relay server (TURN): not set up yet.
const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gathered = (p) => new Promise((ok) => {
  if (p.iceGatheringState === 'complete') return ok();
  const t = setTimeout(ok, 3000);
  p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); ok(); } });
});

function css() {
  if (document.getElementById('tvCallCss')) return;
  const st = document.createElement('style'); st.id = 'tvCallCss';
  st.textContent = `.tvc{position:fixed;inset:0;z-index:9999;background:#000;color:#eceee9;display:flex;flex-direction:column;font:15px/1.4 system-ui,sans-serif}
    .tvc-big{flex:1;min-height:0;position:relative;background:#0e0f11}.tvc-big video{width:100%;height:100%;object-fit:cover}
    .tvc-me{position:absolute;right:14px;top:calc(env(safe-area-inset-top) + 64px);width:28vw;max-width:150px;aspect-ratio:3/4;border-radius:14px;overflow:hidden;background:#1b1c1f;box-shadow:0 6px 20px rgba(0,0,0,.5)}
    .tvc-me video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
    .tvc-top{position:absolute;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top) + 12px) 16px 12px;display:flex;align-items:center;gap:10px;background:linear-gradient(rgba(0,0,0,.6),transparent)}
    .tvc-top b{flex:1;font-size:17px}.tvc-top small{color:#c9ccc6}
    .tvc-msg{position:absolute;left:20px;right:20px;top:45%;text-align:center;color:#c9ccc6;font-size:16px}
    .tvc-bar{display:flex;justify-content:center;gap:14px;padding:14px 16px calc(env(safe-area-inset-bottom) + 16px);background:#000}
    .tvc-bar button{border:0;border-radius:99px;padding:12px 18px;background:#2a2c2f;color:#eceee9;font:600 15px system-ui,sans-serif}
    .tvc-bar .end{background:#d0453a}.tvc-bar .on{background:#eceee9;color:#141517}`;
  document.head.appendChild(st);
}

/** Calls the TV from this phone. call(path, q, opts) talks to the current TV (tv.js). */
export async function callTv({ call, tvName = 'the TV', toast = () => {} }) {
  css();
  const el = document.createElement('div'); el.className = 'tvc';
  el.innerHTML = `<div class="tvc-big"><video id="tvcRoom" autoplay playsinline></video><p class="tvc-msg" id="tvcMsg">Calling ${esc(tvName)}…</p>
      <div class="tvc-top"><b>${esc(tvName)}</b><small id="tvcState">Ringing</small></div><div class="tvc-me"><video id="tvcMe" autoplay playsinline muted></video></div></div>
    <div class="tvc-bar"><button id="tvcMute">Mute</button><button id="tvcSmall">Small on the TV</button><button class="end" id="tvcEnd">End</button></div>`;
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
  $('tvcMute').onclick = () => { const a = stream?.getAudioTracks()[0]; if (!a) return; a.enabled = !a.enabled; $('tvcMute').classList.toggle('on', !a.enabled); $('tvcMute').textContent = a.enabled ? 'Mute' : 'Muted'; };
  $('tvcSmall').onclick = async () => { small = !small; $('tvcSmall').textContent = small ? 'Big on the TV' : 'Small on the TV'; try { await call('/call/size', { a: small ? 'small' : 'big' }, { post: true }); } catch {} };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    $('tvcMe').srcObject = stream;
  } catch (e) { await finish(e.name === 'NotAllowedError' ? 'Shivo Labs needs the camera and microphone: allow them in Settings' : "This phone's camera could not start"); return; }
  const r = await call('/call/ring', {}, { post: true, body: JSON.stringify({}) }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { await finish(r.error || 'The TV could not ring'); return; }
  // an offer to each side that says it is ready (the TV, and the camera phone if there is one)
  async function offerTo(who) {
    pcs[who]?.close();
    const pc = pcs[who] = new RTCPeerConnection({ iceServers: ICE });
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
        if (m.kind === 'ready') { answered = true; $('tvcState').textContent = 'Connecting…'; offerTo(m.from).catch(() => {}); if (m.from === 'tv' && !$('tvcRoom').srcObject) say('On the TV. Waiting for the camera phone…'); }
        else if (m.kind === 'answer' && pcs[m.from]) await pcs[m.from].setRemoteDescription({ type: 'answer', sdp: m.sdp });
        else if (m.kind === 'bye') { await finish(m.why === 'declined' ? 'Not now, they said' : m.why === 'missed' ? 'Nobody answered' : 'The call ended'); return; }
      }
      if (!answered) { const st = await call('/call/state', {}, { ms: 4000 }); if (st.state === 'idle') { await finish('Nobody answered'); return; } if (Date.now() - t0 > 70000) { await finish('Nobody answered'); return; } }
    } catch {}
    await nap(answered ? 900 : 700);
  }
}

/** This phone is the TV's camera: waits for calls the TV answers, then shows the room to the caller. */
export async function beCamera({ call, tvName = 'the TV', toast = () => {} }) {
  css();
  const el = document.createElement('div'); el.className = 'tvc';
  el.innerHTML = `<div class="tvc-big"><video id="tvcCaller" autoplay playsinline></video><p class="tvc-msg" id="tvcMsg">Camera for ${esc(tvName)}. Leave this phone facing the room, with this screen open. Calls show here when the TV answers.</p>
      <div class="tvc-top"><b>TV camera</b><small id="tvcState">Waiting for a call</small></div><div class="tvc-me"><video id="tvcMe" autoplay playsinline muted></video></div></div>
    <div class="tvc-bar"><button id="tvcMute">Mute</button><button id="tvcFlip">Other camera</button><button class="end" id="tvcEnd">Stop</button></div>`;
  document.body.appendChild(el);
  const $ = (id) => el.querySelector('#' + id), say = (t) => { $('tvcMsg').textContent = t; $('tvcMsg').hidden = !t; };
  let open = true, stream = null, pc = null, facing = 'user', callId = '', sound = 'phone';
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  const startCam = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    $('tvcMe').srcObject = stream;
  };
  const hang = () => { pc?.close(); pc = null; $('tvcCaller').srcObject = null; callId = ''; $('tvcState').textContent = 'Waiting for a call'; say(`Camera for ${tvName}. Calls show here when the TV answers.`); };
  $('tvcEnd').onclick = () => { open = false; hang(); stream?.getTracks().forEach((t) => t.stop()); wake?.release?.(); el.remove(); };
  $('tvcMute').onclick = () => { const a = stream?.getAudioTracks()[0]; if (!a) return; a.enabled = !a.enabled; $('tvcMute').classList.toggle('on', !a.enabled); $('tvcMute').textContent = a.enabled ? 'Mute' : 'Muted'; };
  $('tvcFlip').onclick = async () => { facing = facing === 'user' ? 'environment' : 'user'; try { await startCam(); if (pc) pc.getSenders().forEach((s) => { const t = stream.getTracks().find((x) => x.kind === s.track?.kind); if (t) s.replaceTrack(t); }); } catch {} };
  try { await startCam(); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Shivo Labs needs the camera and microphone: allow them in Settings' : "This phone's camera could not start"); el.remove(); return; }
  while (open) {
    try {
      const msgs = await call('/call/recv', { a: 'cam' }, { ms: 5000 });   // also tells the TV this camera is here
      for (const m of msgs || []) {
        if (m.kind === 'offer') {
          pc?.close();
          pc = new RTCPeerConnection({ iceServers: ICE });
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
