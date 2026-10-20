// The TV's Family and Features tabs in the phone app (also the PC's, the hub shows this same screen).
// Family: send a message, have the TV say something or play a voice note, reminders and medicine (the TV shows a
// card over any app; OK on the remote = done), birthdays and days to remember, and what happened (done, missed).
// Features: every feature on the TV with its switch and its settings, exactly as the TV describes them (/mods), so a
// newer TV's features show here without an app update. The TV keeps everything (tv/home Mods.java, Family.java).
import { callTv, beCamera } from './call.js';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  pill: svg('<rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-35 12 12)"/><path d="M9.3 8.2l5.4 7.6"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cake: svg('<path d="M4 20h16M5 20v-6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6"/><path d="M5 16c2 1.2 3.5 1.2 5 0s3-1.2 4.5 0 3 1.2 4.5 0M12 12V8.5"/><path d="M12 4.5c.8.9.8 2 0 2.6-.8-.6-.8-1.7 0-2.6z"/>'),
  heart: svg('<path d="M12 19.5s-7-4.3-7-9.5A4 4 0 0 1 12 7.6 4 4 0 0 1 19 10c0 5.2-7 9.5-7 9.5z"/>'),
  star: svg('<path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>'),
  msg: svg('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V17h0a2 2 0 0 1-2-2z"/>'),
  speak: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  send: svg('<path d="M4 12 20 4l-5 16-3-7z"/><path d="M12 13l8-9"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="2"/>'),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
  chev: svg('<path d="M9 6l6 6-6 6"/>'),
  video: svg('<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/>'),
  cam: svg('<path d="M4 8.5h3l1.5-2h7l1.5 2h3v10H4z"/><circle cx="12" cy="13" r="3.2"/>'),
  spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TYPES = [['medicine', 'Medicine', IC.pill], ['reminder', 'Reminder', IC.bell], ['chore', 'To do', IC.check]];
const WHAT = [['birthday', 'Birthday', IC.cake], ['anniversary', 'Anniversary', IC.heart], ['day', 'A day', IC.star]];
const LOGW = { done: 'Done', missed: 'Missed', later: 'Asked for later', off: 'TV was off' };
const pad = (n) => String(n).padStart(2, '0');
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const repeatText = (r) => r.date ? `Once, ${new Date(r.date + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`
  : !r.days?.length || r.days.length === 7 ? 'Every day'
  : r.days.join() === '1,2,3,4,5' ? 'Weekdays' : r.days.join() === '6,7' ? 'Weekends' : r.days.map((d) => DAYS[d - 1]).join(', ');
const when = (ms) => {
  const d = new Date(ms), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(); const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
};
const daysTo = (mmdd) => {
  const [m, d] = mmdd.split('-').map(Number), t = new Date(); t.setHours(0, 0, 0, 0);
  let x = new Date(t.getFullYear(), m - 1, d); if (x < t) x = new Date(t.getFullYear() + 1, m - 1, d);
  return Math.round((x - t) / 86400000);
};
const inText = (n) => n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 14 ? `In ${n} days` : n < 60 ? `In ${Math.round(n / 7)} weeks` : `In ${Math.round(n / 30)} months`;

// a sheet over the screen for adding and changing things (the TV tab has no sheets of its own)
function sheet(title, body, { onSave, onDelete, saveText = 'Save' } = {}) {
  const el = document.createElement('div');
  el.className = 'tvf-sheet';
  el.innerHTML = `<div class="tvf-sheet-b" role="dialog" aria-label="${esc(title)}"><div class="tvf-sheet-h"><b>${esc(title)}</b><button class="tvf-x" data-close aria-label="Close">${IC.x}</button></div>
    <div class="tvf-sheet-c">${body}</div>
    <div class="tvf-sheet-f">${onDelete ? `<button class="btn tvf-del" data-del>${IC.trash}Delete</button>` : ''}<button class="btn pri" data-save>${esc(saveText)}</button></div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); };
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  el.querySelector('[data-save]').onclick = async (e) => { const b = e.currentTarget; b.disabled = true; try { if (await onSave(el) !== false) close(); } finally { b.disabled = false; } };
  // deleting asks twice: the first tap only says what the second one does
  el.querySelector('[data-del]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.lastChild.textContent = 'Tap again to delete'; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.lastChild.textContent = 'Delete'; } }, 4000); return; }
    if (await onDelete() !== false) close();
  });
  return el;
}

export function mountFamily(box, { call, toast, buzz = () => {}, ai = null, nowPlaying = () => null, appsOnTv = () => [], pics = () => {}, tvName = () => 'the TV' }) {
  let answer = null, modsAt = 0, lastMods = null;
  let data = null, mods = {}, mode = ai ? 'ask' : 'msg', rec = null, clip = null, alive = true, timer = 0, lastSig = '';
  const api = async (path, q = {}, body) => {
    const r = await call(path, q, { post: true, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (r && r.ok === false) throw new Error(r.error || "The TV couldn't do that");
    return r;
  };
  async function load(quiet) {
    try {
      const needMods = !quiet || Date.now() - modsAt > 60000;
      const [d, m] = await Promise.all([call('/items'), needMods ? call('/mods').catch(() => null) : Promise.resolve(lastMods)]);
      if (needMods && m) { modsAt = Date.now(); lastMods = m; }
      if (!d || !Array.isArray(d.items)) throw Object.assign(new Error('old'), { old: true });
      // drawn again only when something changed (the list is asked for every few seconds)
      const sig = JSON.stringify([d.items, d.log, d.asking, m?.mods?.map((x) => x.on)]);
      if (quiet && sig === lastSig) return;
      lastSig = sig;
      data = d; mods = Object.fromEntries((m?.mods || []).map((x) => [x.id, x]));
      paint();
    } catch (e) {
      if (quiet) return;
      box.innerHTML = e.old || /404/.test(e.message) ? `<p class="tvx-none">Update the TV to use this. Shortcuts › Update the TV.</p>`
        : `<p class="tvx-none">${esc(e.message)}</p>`;
    }
  }
  const off = (id) => mods[id] && !mods[id].on;
  function paint() {
    const rem = data.items.filter((x) => x.kind === 'reminder').sort((a, b) => a.at.localeCompare(b.at));
    const days = data.items.filter((x) => x.kind === 'birthday').map((x) => ({ ...x, in: daysTo(x.date) })).sort((a, b) => a.in - b.in);
    const asking = data.asking && data.items.find((x) => x.id === data.asking);
    // today's answer for a reminder (the log is newest first)
    const stateOf = (r) => { const e = data.log.find((l) => l.id === r.id && new Date(l.due).toDateString() === new Date().toDateString()); return e ? e.what : ''; };
    const nextYear = (m, dd) => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getFullYear() + (new Date(t.getFullYear(), m - 1, dd) < t ? 1 : 0); };
    box.innerHTML = `
      ${asking ? `<section class="tvf-ask"><span>${IC.bell}</span><div><small>On the TV now</small><b>${esc(asking.title)}</b></div>
        <button class="btn sm" data-ans="later">Later</button><button class="btn sm pri" data-ans="ok">Done</button></section>` : ''}
      <section class="tvf-send">
        <div class="seg tvf-seg">${[...(ai ? [['ask', 'Ask', IC.spark]] : []), ['msg', 'Message', IC.msg], ['say', 'Say it', IC.speak], ['voice', 'Voice note', IC.mic]].map(([id, n, ic]) => `<button data-mode="${id}" class="${mode === id ? 'on' : ''}">${ic}${n}</button>`).join('')}</div>
        ${mode === 'voice' ? `<div class="tvf-voice">
            <button class="tvf-rec${rec ? ' on' : ''}" id="tvfRec" aria-label="${rec ? 'Stop' : 'Record'}">${rec ? IC.stop : IC.mic}</button>
            <div><b id="tvfRecT">${rec ? 'Recording… tap to stop' : clip ? `Voice note ready · ${clip.secs} s` : 'Tap to record'}</b><small>${clip ? 'Plays on the TV.' : 'Up to 60 seconds.'}</small></div>
            ${clip && !rec ? `<button class="tvf-x" id="tvfDrop" aria-label="Throw away">${IC.trash}</button><button class="btn pri sm" id="tvfVoiceGo">${IC.send}Send</button>` : ''}</div>`
        : mode === 'ask' ? `<textarea class="field tvf-text" id="tvfText" rows="2" maxlength="500" placeholder="Ask a question"></textarea>
           <div class="tvf-row"><small>${!ai ? 'Available in the phone app.' : off('ai') ? 'Off in Features.' : ''}</small>
           <button class="btn pri sm" id="tvfAsk" ${!ai ? 'disabled' : ''}>${IC.spark}Ask</button></div>
           ${answer ? `<div class="tvf-answer"><p>${esc(answer.text)}</p>${answer.done ? `<small>${esc(answer.done)}</small>` : ''}
             <div class="tvf-row"><span></span><button class="btn sm" id="tvfAnsSay">${IC.speak}Say it on the TV</button><button class="btn sm" id="tvfAnsShow">Show on the TV</button></div></div>` : ''}`
        : `<textarea class="field tvf-text" id="tvfText" rows="2" maxlength="${mode === 'msg' ? 400 : 300}" placeholder="${mode === 'msg' ? 'Message' : 'Text to read aloud'}"></textarea>
           <div class="tvf-row"><small>${mode === 'msg' ? off('messages') ? 'Off in Features.' : '' : off('announce') ? 'Off in Features.' : ''}</small>
           <button class="btn pri sm" id="tvfGo">${IC.send}${mode === 'msg' ? 'Send' : 'Say it'}</button></div>`}
      </section>

      <h3 class="tvx-h">Family room</h3>
      ${off('room') ? '<p class="tvf-note">Off in Features.</p>' : `<div class="tvf-room">
        <button class="tvf-roomb" id="tvfCall">${IC.video}<span><b>Video call the TV</b><small>Full screen on the TV</small></span></button>
        <button class="tvf-roomb" id="tvfCam">${IC.cam}<span><b>Be the TV's camera</b><small>Use this phone as the TV camera</small></span></button></div>`}

      <h3 class="tvx-h">Reminders and medicine<button class="tvf-add" data-add="reminder">${IC.plus}Add</button></h3>
      ${off('reminders') ? '<p class="tvf-note">Reminders are off in Features.</p>' : ''}
      ${rem.length ? `<div class="tvf-list">${rem.map((r) => { const st = stateOf(r), t = TYPES.find((x) => x[0] === r.type) || TYPES[1]; return `
        <button class="tvf-item${r.on === false ? ' off' : ''}" data-edit="${esc(r.id)}"><span class="tvf-ic ${esc(r.type || 'reminder')}">${t[2]}</span>
          <span class="tvf-main"><b>${esc(r.title)}</b><small>${esc(r.at)} · ${esc(repeatText(r))}${r.on === false ? ' · off' : ''}</small></span>
          ${st ? `<span class="tvf-st ${esc(st)}">${esc(LOGW[st] || st)}</span>` : ''}${IC.chev}</button>`; }).join('')}</div>`
      : '<p class="tvf-empty">No reminders.</p>'}

      <h3 class="tvx-h">Birthdays and days to remember<button class="tvf-add" data-add="birthday">${IC.plus}Add</button></h3>
      ${days.length ? `<div class="tvf-list">${days.map((d) => { const w = WHAT.find((x) => x[0] === d.what) || WHAT[0]; const [m, dd] = d.date.split('-').map(Number); return `
        <button class="tvf-item${d.on === false ? ' off' : ''}" data-edit="${esc(d.id)}"><span class="tvf-ic ${esc(d.what)}">${w[2]}</span>
          <span class="tvf-main"><b>${esc(d.what === 'birthday' ? `${d.title}'s birthday` : d.what === 'anniversary' ? `${d.title}'s anniversary` : d.title)}</b><small>${dd} ${MONTHS[m - 1]}${d.year && d.what !== 'day' ? ` · ${d.what === 'birthday' ? 'turns' : 'years:'} ${nextYear(m, dd) - d.year}` : ''}</small></span>
          <span class="tvf-st">${inText(d.in)}</span>${IC.chev}</button>`; }).join('')}</div>`
      : '<p class="tvf-empty">No dates.</p>'}

      <h3 class="tvx-h">Family photos<button class="tvf-add" id="tvfPhAdd">${IC.plus}Add</button></h3>
      ${off('photos') ? '<p class="tvf-note">Off in Features.</p>' : ''}
      <div id="tvfPhotos">${photosHtml()}</div>

      <h3 class="tvx-h">What happened${data.log.length ? '<button class="tvf-add" id="tvfClear">Clear</button>' : ''}</h3>
      ${data.log.length ? `<div class="tvf-log">${data.log.slice(0, 25).map((l) => `<div><span class="tvf-dot ${esc(l.what)}"></span><b>${esc(l.title)}</b>
        <small>${LOGW[l.what] || esc(l.what)} · due ${when(l.due)}${l.what === 'done' ? ` · pressed ${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</small></div>`).join('')}</div>`
      : '<p class="tvf-empty">No history.</p>'}`;
    wire();
  }
  function wire() {
    box.querySelector('#tvfPhAdd')?.addEventListener('click', addPhotos);
    box.querySelector('#tvfCall')?.addEventListener('click', () => { buzz(); callTv({ call, tvName: tvName(), toast }); });
    box.querySelector('#tvfCam')?.addEventListener('click', () => { buzz(); beCamera({ call, tvName: tvName(), toast }); });
    wirePhotos();
    box.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { mode = b.dataset.mode; buzz(); paint(); }));
    box.querySelectorAll('[data-ans]').forEach((b) => (b.onclick = async () => { try { await api('/items/answer', { a: b.dataset.ans }); buzz('success'); toast(b.dataset.ans === 'ok' ? 'Marked done' : 'The TV asks again later'); setTimeout(() => load(true), 800); } catch (e) { toast(e.message); } }));
    box.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => (b.dataset.add === 'reminder' ? editReminder() : editDay())));
    box.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { const it = data.items.find((x) => x.id === b.dataset.edit); if (it) it.kind === 'reminder' ? editReminder(it) : editDay(it); }));
    const ask = box.querySelector('#tvfAsk');
    if (ask) ask.onclick = async () => {
      const q = box.querySelector('#tvfText').value.trim(); if (!q) return toast('Enter a question');
      ask.disabled = true; ask.textContent = 'Thinking…';
      try { answer = await askTv(q); buzz('success'); }
      catch (e) { toast(e.message); }
      finally { paint(); }
    };
    box.querySelector('#tvfAnsSay')?.addEventListener('click', () => api('/say', {}, { text: answer.text }).then(() => toast('Sent')).catch((e) => toast(e.message)));
    box.querySelector('#tvfAnsShow')?.addEventListener('click', () => api('/show', {}, { title: answer.q, text: answer.text }).then(() => toast('Sent')).catch((e) => toast(e.message)));
    const go = box.querySelector('#tvfGo');
    if (go) go.onclick = async () => {
      const t = box.querySelector('#tvfText').value.trim(); if (!t) return toast(mode === 'msg' ? 'Enter a message' : 'Enter text');
      go.disabled = true;
      try {
        const r = await api(mode === 'msg' ? '/notify' : '/say', {}, { text: t });
        buzz('success'); toast(mode === 'msg' ? (r.held ? 'Quiet hours: shows at 07:00' : 'Sent') : 'Sent');
        box.querySelector('#tvfText').value = '';
      } catch (e) { toast(e.message); } finally { go.disabled = false; }
    };
    box.querySelector('#tvfClear')?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Tap again to clear'; return; }
      try { await api('/items/clearlog'); toast('Cleared'); load(true); } catch (err) { toast(err.message); }
    });
    box.querySelector('#tvfRec')?.addEventListener('click', () => (rec ? stopRec() : startRec()));
    box.querySelector('#tvfDrop')?.addEventListener('click', () => { clip = null; paint(); });
    box.querySelector('#tvfVoiceGo')?.addEventListener('click', sendVoice);
  }

  // ---- voice note: recorded here, sent in pieces (the relay takes 64 KB at a time), played on the TV ----
  async function startRec() {
    try {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) throw new Error("This phone can't record here yet.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
      const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined), parts = [], t0 = Date.now();
      mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(parts, { type: mr.mimeType || type || 'audio/mp4' });
        clip = { blob, ext: /webm/.test(blob.type) ? 'webm' : 'm4a', secs: Math.max(1, Math.round((Date.now() - t0) / 1000)) };
        rec = null; paint();
      };
      mr.start(); rec = mr; buzz(); paint();
      setTimeout(() => { if (rec === mr) stopRec(); }, 60000);
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone access is off. Allow it in Settings.' : e.message); }
  }
  function stopRec() { try { rec?.stop(); } catch {} }
  async function sendVoice() {
    if (!clip) return;
    const b = box.querySelector('#tvfVoiceGo'); if (b) { b.disabled = true; b.textContent = 'Sending…'; }
    try {
      const bytes = new Uint8Array(await clip.blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin), size = 48 * 1024, count = Math.ceil(b64.length / size);
      const name = `v${Math.random().toString(36).slice(2, 10)}.${clip.ext}`;
      for (let i = 0; i < count; i++) await callRaw('/up', { a: name, b: i, c: count }, b64.slice(i * size, (i + 1) * size));
      await api('/voice', { a: name });
      buzz('success'); toast('Playing on the TV'); clip = null; paint();
    } catch (e) { toast(e.message); if (b) { b.disabled = false; b.textContent = 'Send'; } }
  }
  async function callRaw(path, q, body) {
    const r = await call(path, q, { post: true, body });
    if (r && r.ok === false) throw new Error(r.error || "The TV couldn't take it");
    return r;
  }

  // ---- Ask the TV: Claude answers in a few sentences; if it is about watching something, it also says where to look ----
  async function askTv(q) {
    const p = nowPlaying(), appList = appsOnTv().filter((a) => a.tv || !a.system).map((a) => `${a.label} (${a.pkg})`).slice(0, 40).join(', ');
    const system = `You answer questions asked from a phone about, or in front of, a family TV in Dar es Salaam (Google TV). Today is ${new Date().toDateString()}.
${p ? `On the TV now: "${p.title}"${p.sub ? ` (${p.sub})` : ''} in ${p.pkg}.` : 'Nothing is playing on the TV now.'}
Apps on the TV: ${appList}.
Reply with JSON only: {"answer": "<at most 3 short plain sentences>", "search": null or {"app": "youtube" | "all" | "<package from the list>", "query": "<what to search>"}}.
Use "search" only when the person wants to watch or listen to something (YouTube is usually best); otherwise null. Use web search for facts you are not sure of.`;
    const raw = await ai({ system, text: q });
    let j; try { j = JSON.parse(raw.replace(/^```(json)?|```$/g, '').trim()); } catch { j = { answer: raw, search: null }; }
    const out = { q, text: String(j.answer || '').slice(0, 600), done: '' };
    if (j.search?.query) {
      try { const r = await api('/search', { a: j.search.app === 'youtube' ? 'com.google.android.youtube.tv' : j.search.app, b: j.search.query }); out.done = `Searching ${j.search.app === 'youtube' ? 'YouTube' : 'the TV'}: ${j.search.query}`; if (!r.ok) out.done = ''; }
      catch (e) { out.done = e.message; }
    } else if (out.text && !off('ai')) {
      api('/show', {}, { title: q, text: out.text }).then(() => {}).catch(() => {});
      out.done = 'Shown on the TV';
    }
    return out;
  }

  // ---- family photos for the screensaver: made small here (1920 px), sent in pieces, kept on the TV ----
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
      const k = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.84));
      const small = document.createElement('canvas'); const s = 384 / Math.max(cv.width, cv.height); small.width = Math.round(cv.width * s); small.height = Math.round(cv.height * s);
      small.getContext('2d').drawImage(cv, 0, 0, small.width, small.height);
      return { blob, thumb: small.toDataURL('image/jpeg', 0.7) };
    } finally { URL.revokeObjectURL(url); }
  }
  async function sendBlob(name, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin), size = 48 * 1024, count = Math.ceil(b64.length / size);
    for (let i = 0; i < count; i++) await callRaw('/up', { a: name, b: i, c: count }, b64.slice(i * size, (i + 1) * size));
  }
  function addPhotos() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = async () => {
      const files = [...inp.files].slice(0, 20); if (!files.length) return;
      toast('Preparing photos');
      const ready = [];
      for (const f of files) { try { ready.push({ ...(await shrink(f)), date: f.lastModified || Date.now(), caption: '' }); } catch {} }
      if (!ready.length) return toast('Photos could not be opened');
      const el = sheet(`${ready.length} photo${ready.length > 1 ? 's' : ''} for the TV`, `
        ${ai ? `<button class="btn sm" id="fCapAi">${IC.spark}Write captions with AI</button>` : ''}
        <div class="tvf-picks">${ready.map((p, i) => `<label class="tvf-pick"><img src="${p.thumb}" alt=""><input class="field" data-i="${i}" maxlength="160" placeholder="Caption (optional)"></label>`).join('')}</div>`, {
        saveText: 'Send to the TV',
        onSave: async (s) => {
          s.querySelectorAll('[data-i]').forEach((x) => (ready[+x.dataset.i].caption = x.value.trim()));
          let n = 0;
          for (const p of ready) {
            const name = `p${Math.random().toString(36).slice(2, 12)}.jpg`;
            try { await sendBlob(name, p.blob); await api('/photos/add', { a: name }, { caption: p.caption, date: p.date }); n++; toast(`Sent ${n} of ${ready.length}`); }
            catch (e) { toast(e.message); return false; }
          }
          buzz('success'); toast(`${n} photo${n > 1 ? 's' : ''} added`); loadPhotos();
        },
      });
      el.querySelector('#fCapAi')?.addEventListener('click', async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Writing…';
        for (const [i, p] of ready.entries()) {
          try {
            const t = await ai({ system: 'Write one warm, plain caption (at most 10 words, no hashtags, no quotes) for a family photo shown on the TV.', text: 'Caption this photo.', image: p.thumb.split(',')[1], web: false, maxTokens: 60 });
            const f = el.querySelector(`[data-i="${i}"]`); if (f && !f.value) f.value = t.replace(/^["']|["']$/g, '');
          } catch (err) { toast(err.message); break; }
        }
        b.textContent = 'Captions written';
      });
    };
    inp.click();
  }
  let photos = null;
  async function loadPhotos() { try { photos = await call('/photos'); } catch { photos = null; } const el = box.querySelector('#tvfPhotos'); if (el) { el.innerHTML = photosHtml(); wirePhotos(); } }
  const photosHtml = () => !Array.isArray(photos) ? '' : photos.length ? `<div class="tvf-photos">${photos.slice().reverse().map((p) => `<button class="tvf-ph" data-ph="${esc(p.id)}"><img data-tvpic="/photo/${esc(p.id)}" alt=""><small>${esc(p.caption || new Date(p.date).toLocaleDateString())}</small></button>`).join('')}</div>`
    : '<p class="tvf-empty">No photos. Added photos appear on the TV screensaver.</p>';
  function wirePhotos() {
    box.querySelectorAll('[data-ph]').forEach((b) => (b.onclick = () => {
      const p = photos.find((x) => x.id === b.dataset.ph); if (!p) return;
      const sh = sheet('Photo on the TV', `<img class="tvf-big" data-tvpic="/photo/${esc(p.id)}" alt=""><label class="tvf-f"><span>Caption</span><input class="field" id="fCap" maxlength="160" value="${esc(p.caption || '')}"></label>
        <p class="tvf-empty">${new Date(p.date).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}${p.by ? ` · from ${esc(p.by)}` : ''}</p>`, {
        onSave: async (s) => { try { await api('/photos/caption', { a: p.id }, { caption: s.querySelector('#fCap').value.trim() }); toast('Saved'); loadPhotos(); } catch (e) { toast(e.message); return false; } },
        onDelete: async () => { try { await api('/photos/del', { a: p.id }); toast('Removed'); loadPhotos(); } catch (e) { toast(e.message); return false; } },
      });
      pics(sh);
    }));
    pics();
  }

  // ---- editors ----
  function editReminder(it) {
    const r = it || { kind: 'reminder', type: 'medicine', title: '', at: '09:00', days: [], on: true };
    let type = r.type || 'reminder', rep = r.date ? 'once' : r.days?.length && r.days.length < 7 ? 'some' : 'daily', days = new Set(r.days?.length ? r.days : [1, 2, 3, 4, 5, 6, 7]);
    const speak = r.speak === true ? 'yes' : r.speak === false ? 'no' : 'def';
    const el = sheet(it ? 'Change reminder' : 'New reminder', `
      <div class="tvf-chips" id="fType">${TYPES.map(([id, n, ic]) => `<button data-v="${id}" class="${type === id ? 'on' : ''}">${ic}${n}</button>`).join('')}</div>
      <label class="tvf-f"><span>Name</span><input class="field" id="fTitle" maxlength="80" value="${esc(r.title)}" placeholder="Name"></label>
      <label class="tvf-f"><span>Note <i>(optional)</i></span><input class="field" id="fText" maxlength="300" value="${esc(r.text || '')}" placeholder="Optional"></label>
      <label class="tvf-f"><span>Time</span><input class="field" id="fAt" type="time" value="${esc(r.at)}"></label>
      <div class="tvf-f"><span>Repeat</span><div class="seg tvf-rep" id="fRep">${[['daily', 'Every day'], ['some', 'Some days'], ['once', 'Once']].map(([v, n]) => `<button data-v="${v}" class="${rep === v ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="tvf-days" id="fDays" ${rep === 'some' ? '' : 'hidden'}>${DAYS.map((d, i) => `<button data-d="${i + 1}" class="${days.has(i + 1) ? 'on' : ''}">${d.slice(0, 2)}</button>`).join('')}</div>
        <input class="field" id="fDate" type="date" value="${esc(r.date || isoToday())}" min="${isoToday()}" ${rep === 'once' ? '' : 'hidden'}></div>
      <div class="tvf-f"><span>Read it out loud</span><div class="seg" id="fSpeak">${[['def', 'As in Features'], ['yes', 'Yes'], ['no', 'No']].map(([v, n]) => `<button data-v="${v}" class="${speak === v ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <label class="tvf-sw"><span><b>On</b></span><input type="checkbox" id="fOn" ${r.on !== false ? 'checked' : ''}><i></i></label>`, {
      onSave: async (s) => {
        const body = { kind: 'reminder', type, title: s.querySelector('#fTitle').value.trim(), text: s.querySelector('#fText').value.trim(), at: s.querySelector('#fAt').value,
          days: rep === 'some' ? [...days].sort() : [], on: s.querySelector('#fOn').checked };
        if (it) body.id = it.id;
        if (rep === 'once') body.date = s.querySelector('#fDate').value;
        const sp = s.querySelector('#fSpeak .on').dataset.v; if (sp !== 'def') body.speak = sp === 'yes';
        if (!body.title) { toast('Give it a name'); return false; }
        if (rep === 'some' && !days.size) { toast('Pick at least one day'); return false; }
        try { await api('/items/save', {}, body); buzz('success'); toast(it ? 'Saved' : 'Added'); load(true); }
        catch (e) { toast(e.message); return false; }
      },
      onDelete: it ? async () => { try { await api('/items/del', { a: it.id }); toast('Deleted'); load(true); } catch (e) { toast(e.message); return false; } } : null,
    });
    const pick = (sel, fn) => el.querySelectorAll(`${sel} [data-v]`).forEach((b) => (b.onclick = () => { el.querySelectorAll(`${sel} [data-v]`).forEach((x) => x.classList.toggle('on', x === b)); fn(b.dataset.v); }));
    pick('#fType', (v) => { type = v; });
    pick('#fRep', (v) => { rep = v; el.querySelector('#fDays').hidden = v !== 'some'; el.querySelector('#fDate').hidden = v !== 'once'; });
    pick('#fSpeak', () => {});
    el.querySelectorAll('#fDays [data-d]').forEach((b) => (b.onclick = () => { const d = +b.dataset.d; days.has(d) ? days.delete(d) : days.add(d); b.classList.toggle('on', days.has(d)); }));
    if (!it) setTimeout(() => el.querySelector('#fTitle').focus(), 300);
  }
  function editDay(it) {
    const d = it || { kind: 'birthday', what: 'birthday', title: '', date: `${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`, on: true };
    let what = d.what || 'birthday';
    const [m, dd] = d.date.split('-').map(Number);
    const el = sheet(it ? 'Change' : 'New day to remember', `
      <div class="tvf-chips" id="fWhat">${WHAT.map(([id, n, ic]) => `<button data-v="${id}" class="${what === id ? 'on' : ''}">${ic}${n}</button>`).join('')}</div>
      <label class="tvf-f"><span id="fNameL">${what === 'day' ? 'What day' : 'Whose'}</span><input class="field" id="fTitle" maxlength="80" value="${esc(d.title)}" placeholder="${what === 'day' ? 'Diwali' : 'Mum'}"></label>
      <div class="tvf-f"><span>Day</span><div class="tvf-two"><select class="field" id="fDay">${Array.from({ length: 31 }, (_, i) => `<option ${i + 1 === dd ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
        <select class="field" id="fMonth">${MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
      <label class="tvf-f"><span>Year <i>(optional, shows the age)</i></span><input class="field" id="fYear" inputmode="numeric" maxlength="4" value="${d.year || ''}" placeholder="1965"></label>
      <label class="tvf-f"><span>Note <i>(optional)</i></span><input class="field" id="fText" maxlength="300" value="${esc(d.text || '')}" placeholder="Optional"></label>
      <label class="tvf-sw"><span><b>On</b></span><input type="checkbox" id="fOn" ${d.on !== false ? 'checked' : ''}><i></i></label>`, {
      onSave: async (s) => {
        const body = { kind: 'birthday', what, title: s.querySelector('#fTitle').value.trim(), date: `${pad(s.querySelector('#fMonth').value)}-${pad(s.querySelector('#fDay').value)}`,
          text: s.querySelector('#fText').value.trim(), on: s.querySelector('#fOn').checked };
        const y = +s.querySelector('#fYear').value; if (y > 1900) body.year = y;
        if (it) body.id = it.id;
        if (!body.title) { toast('Give it a name'); return false; }
        try { await api('/items/save', {}, body); buzz('success'); toast(it ? 'Saved' : 'Added'); load(true); }
        catch (e) { toast(e.message); return false; }
      },
      onDelete: it ? async () => { try { await api('/items/del', { a: it.id }); toast('Deleted'); load(true); } catch (e) { toast(e.message); return false; } } : null,
    });
    el.querySelectorAll('#fWhat [data-v]').forEach((b) => (b.onclick = () => {
      what = b.dataset.v; el.querySelectorAll('#fWhat [data-v]').forEach((x) => x.classList.toggle('on', x === b));
      el.querySelector('#fNameL').textContent = what === 'day' ? 'What day' : 'Whose'; el.querySelector('#fTitle').placeholder = what === 'day' ? 'Diwali' : 'Mum';
    }));
    if (!it) setTimeout(() => el.querySelector('#fTitle').focus(), 300);
  }

  load();
  loadPhotos();
  // while the tab is open: what is showing on the TV now, and new answers
  timer = setInterval(() => { if (!alive || !box.isConnected) { clearInterval(timer); return; } if (!document.hidden && !document.querySelector('.tvf-sheet') && !rec && document.activeElement?.id !== 'tvfText') load(true); }, 8000);
  return { stop() { alive = false; clearInterval(timer); stopRec(); } };
}

// ---- Features: the TV's own list, with switches and settings ----
export function mountFeatures(box, { call, toast, buzz = () => {} }) {
  let mods = [], open = '';
  async function load() {
    try {
      const r = await call('/mods');
      if (!r || !Array.isArray(r.mods)) throw Object.assign(new Error('old'), { old: true });
      mods = r.mods; paint();
    } catch (e) {
      box.innerHTML = `<p class="tvx-none">${e.old || /404/.test(e.message) ? 'Update the TV to use this. Shortcuts › Update the TV.' : esc(e.message)}</p>`;
    }
  }
  const field = (m, f) => {
    const v = m.settings[f.k], id = `m_${m.id}_${f.k}`;
    if (f.t === 'bool') return `<label class="tvf-sw sm"><span>${esc(f.l)}</span><input type="checkbox" data-m="${m.id}" data-k="${f.k}" ${v ? 'checked' : ''}><i></i></label>`;
    if (f.t === 'multi') return `<div class="tvf-f"><span>${esc(f.l)}</span><div class="tvf-chips sm" data-multi="${m.id}" data-k="${f.k}">${f.o.map(([val, n]) => `<button data-v="${esc(val)}" class="${(v || []).includes(val) ? 'on' : ''}">${esc(n)}</button>`).join('')}</div></div>`;
    if (f.t === 'choice') return `<label class="tvf-f"><span>${esc(f.l)}</span><select class="field" data-m="${m.id}" data-k="${f.k}">${f.o.map(([val, n]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
    if (f.t === 'number') return `<label class="tvf-f tvf-num"><span>${esc(f.l)}</span><span class="tvf-numin"><input class="field" id="${id}" type="number" inputmode="numeric" min="${f.min ?? ''}" max="${f.max ?? ''}" value="${esc(v)}" data-m="${m.id}" data-k="${f.k}"><em>${esc(f.u || '')}</em></span></label>`;
    if (f.t === 'time') return `<label class="tvf-f tvf-num"><span>${esc(f.l)}</span><input class="field" type="time" value="${esc(v)}" data-m="${m.id}" data-k="${f.k}"></label>`;
    return `<label class="tvf-f"><span>${esc(f.l)}</span><input class="field" value="${esc(v)}" data-m="${m.id}" data-k="${f.k}"></label>`;
  };
  function paint() {
    box.innerHTML = `
      <div class="tvf-mods">${mods.map((m) => `<section class="tvf-mod${m.on ? '' : ' off'}${open === m.id ? ' open' : ''}">
        <div class="tvf-mod-h"><button class="tvf-mod-t" data-open="${m.id}"><b>${esc(m.name)}</b><small>${esc(m.about)}</small></button>
          <label class="tvf-sw bare"><input type="checkbox" data-on="${m.id}" ${m.on ? 'checked' : ''} aria-label="${esc(m.name)}"><i></i></label></div>
        ${m.fields.length ? `<button class="tvf-more" data-open="${m.id}">${open === m.id ? 'Hide settings' : 'Settings'}${IC.chev}</button>
        <div class="tvf-mod-s" ${open === m.id ? '' : 'hidden'}>${m.fields.map((f) => field(m, f)).join('')}</div>` : ''}</section>`).join('')}</div>`;
    box.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => { open = open === b.dataset.open ? '' : b.dataset.open; buzz(); paint(); }));
    box.querySelectorAll('[data-on]').forEach((c) => (c.onchange = async () => {
      buzz();
      try { const r = await call('/mods/set', {}, { post: true, body: JSON.stringify({ id: c.dataset.on, on: c.checked }) }); if (!r.ok) throw new Error(r.error); const m = mods.find((x) => x.id === c.dataset.on); m.on = r.on; paint(); toast(`${m.name}: ${r.on ? 'on' : 'off'}`); }
      catch (e) { c.checked = !c.checked; toast(e.message || 'Not saved'); }
    }));
    // several of the options: each tap saves the new set
    box.querySelectorAll('[data-multi]').forEach((g) => g.querySelectorAll('[data-v]').forEach((b) => (b.onclick = async () => {
      b.classList.toggle('on');
      const m = mods.find((x) => x.id === g.dataset.multi), val = [...g.querySelectorAll('.on')].map((x) => x.dataset.v);
      try { const r = await call('/mods/set', {}, { post: true, body: JSON.stringify({ id: m.id, settings: { [g.dataset.k]: val } }) }); if (!r.ok) throw new Error(r.error); m.settings = r.settings; buzz('light'); toast('Saved'); }
      catch (e) { b.classList.toggle('on'); toast(e.message || 'Not saved'); }
    })));
    box.querySelectorAll('[data-k]:not([data-multi])').forEach((inp) => (inp.onchange = async () => {
      const m = mods.find((x) => x.id === inp.dataset.m), k = inp.dataset.k;
      const val = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
      try {
        const r = await call('/mods/set', {}, { post: true, body: JSON.stringify({ id: m.id, settings: { [k]: val } }) });
        if (!r.ok) throw new Error(r.error);
        m.settings = r.settings; buzz('light');
        if (inp.type !== 'checkbox' && String(r.settings[k]) !== String(inp.value)) { inp.value = r.settings[k]; toast('Adjusted to the allowed range'); } else toast('Saved');
      } catch (e) { toast(e.message || 'Not saved'); }
    }));
  }
  load();
  return { stop() {} };
}

// ---- TV health: a small card under the remote (memory, storage, connection, Tidy up) ----
const size = (b) => !b ? '0 MB' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
const ago = (t) => { if (!t) return 'not used this week'; const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `used ${m} min ago` : m < 1440 ? `used ${Math.round(m / 60)} h ago` : `used ${Math.round(m / 1440)} days ago`; };
export function mountHealth(box, { call, toast, buzz = () => {} }) {
  let h = null, open = false, busy = false;
  async function load(net) {
    try { h = await call('/health', net ? {} : { a: '0' }); if (!h || !h.mem) throw 0; paint(); } catch { box.innerHTML = ''; }
  }
  function paint() {
    const memPct = Math.round(100 * (1 - h.mem.free / h.mem.total));
    const link = h.link === 'wired' ? 'Wired' : h.wifi ? ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][h.wifi.level] + ' Wi-Fi' : h.link === 'wifi' ? 'Wi-Fi' : h.link === 'none' ? 'Not connected' : 'Connected';
    const up = h.up / 3600000, upT = up < 1 ? `${Math.round(up * 60)} min` : up < 48 ? `${Math.round(up)} h` : `${Math.round(up / 24)} days`;
    const [tAt, tFreed, tWhy] = (h.tidied || '').split('|');
    box.innerHTML = `<section class="tvx-ctl tvf-health${h.mem.low ? ' low' : ''}${open ? ' open' : ''}">
      <button class="tvf-health-h" id="tvhOpen"><span><b>TV health</b><small>${h.mem.low ? 'Memory low' : `${size(h.mem.free)} memory free · ${link}`}</small></span>${IC.chev}</button>
      <div class="tvx-track"><i style="width:${memPct}%"></i></div>
      ${open ? `<div class="tvf-hgrid">
        <div><small>Memory</small><b>${size(h.mem.free)} free</b><span>of ${size(h.mem.total)}</span></div>
        <div><small>Storage</small><b>${size(h.disk.free)} free</b><span>of ${size(h.disk.total)}</span></div>
        <div><small>Connection</small><b>${link}</b><span>${h.wifi ? `${h.wifi.mbps} Mbps · ${h.wifi.ghz} GHz` : ''}</span></div>
        <div><small>Internet</small><b>${h.net ? (h.net.ok ? `Answers in ${h.net.ms} ms` : 'Not answering') : 'Checking…'}</b><span>TV on for ${upT}</span></div></div>
        ${h.top?.length ? `<p class="tvf-hline"><small>Used most today</small>${h.top.map((t) => `${esc(t.label)} ${t.minutes} min`).join(' · ')}</p>` : ''}
        ${h.shield?.on ? `<p class="tvf-hline"><small>Ad blocking</small>On (${esc(h.shield.host)})</p>` : h.shield?.problem ? `<p class="tvf-hline"><small>Ad blocking</small>${esc(h.shield.problem)}</p>` : ''}
        ${tAt ? `<p class="tvf-hline"><small>Last tidy-up</small>${esc(tAt)}${+tFreed > 0 ? `, ${size(+tFreed)} came back` : ''}${tWhy === 'night' ? ' (at night)' : ''}</p>` : ''}` : ''}
      <button class="btn sm tvf-tidy" id="tvhTidy" ${busy ? 'disabled' : ''}>${busy ? 'Tidying up…' : 'Tidy up'}</button>
    </section>`;
    box.querySelector('#tvhOpen').onclick = () => { open = !open; buzz(); paint(); if (open) load(true); };
    box.querySelector('#tvhTidy').onclick = async () => {
      busy = true; paint(); buzz();
      try {
        const r = await call('/health/tidy', {}, { post: true, ms: 12000 });
        if (!r.ok) throw new Error(r.error);
        toast(r.freed > 50e6 ? `${size(r.freed)} freed` : 'Nothing to free');
      } catch (e) { toast(e.message || 'Tidy up failed'); }
      busy = false; load(open);
    };
  }
  load(false);
  return { stop() {} };
}

// ---- Get apps and App doctor, under the TV's apps ----
export function mountShop(box, { call, toast, buzz = () => {}, pics = () => {} }) {
  let shop = null, doc = null, sure = '', view = 'get';
  async function load() {
    try {
      const [s, d] = await Promise.all([call('/store'), call('/apps/doctor').catch(() => null)]);
      if (!s || !Array.isArray(s.groups)) throw 0;
      shop = s; doc = d; paint();
    } catch { box.innerHTML = ''; }
  }
  const getHtml = () => shop.on === false ? '<p class="tvf-empty">Off in Features.</p>'
    : !shop.play ? '<p class="tvf-empty">Google Play is disabled on this TV.</p>'
    : shop.groups.map((g) => `<h3 class="tvx-h">${esc(g.name)}</h3><div class="tvf-shop">${g.apps.map((a) => `
        <div class="tvf-app"><img data-tvpic="/storeicon/${esc(a.pkg)}" alt="" onerror="this.style.visibility='hidden'"><span><b>${esc(a.name)}</b><small>${esc(a.about)}</small></span>
        <button class="btn sm${a.installed ? '' : ' pri'}" data-get="${esc(a.pkg)}">${sure === a.pkg ? 'Install anyway' : a.installed ? 'Open' : 'Install'}</button></div>`).join('')}</div>`).join('')
      + '';
  const spaceHtml = () => {
    if (!doc) return '<p class="tvf-empty">Update the TV to use this.</p>';
    const rows = (doc.apps || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
    return `${doc.usage ? '' : '<p class="tvf-empty">Sizes need a one-time setup from the PC.</p>'}
      <div class="tvf-list">${rows.map((a) => `<div class="tvf-item"><img class="tvf-appic" data-tvpic="/icon/${esc(a.pkg)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="tvf-main"><b>${esc(a.label)}</b><small>${[a.size != null ? size(a.size) : '', a.minutes ? `${a.minutes} min this week` : '', ago(a.last), a.system ? 'came with the TV' : ''].filter(Boolean).join(' · ')}</small></span>
        ${a.system ? '' : `<button class="btn sm tvf-del" data-rm="${esc(a.pkg)}">${sure === 'rm:' + a.pkg ? 'Tap again' : 'Remove'}</button>`}</div>`).join('')}</div>
      `;
  };
  function paint() {
    box.innerHTML = `<div class="seg tvf-seg tvf-shopseg">${[['get', 'Get apps'], ['space', 'Space and use']].map(([id, n]) => `<button data-v="${id}" class="${view === id ? 'on' : ''}">${n}</button>`).join('')}</div>
      ${view === 'get' ? getHtml() : spaceHtml()}`;
    box.querySelectorAll('.tvf-shopseg [data-v]').forEach((b) => (b.onclick = () => { view = b.dataset.v; sure = ''; buzz(); paint(); }));
    box.querySelectorAll('[data-get]').forEach((b) => (b.onclick = async () => {
      const pkg = b.dataset.get, a = shop.groups.flatMap((g) => g.apps).find((x) => x.pkg === pkg);
      buzz(); b.disabled = true;
      try {
        const r = await call('/store/get', { a: pkg, ...(sure === pkg ? { b: 'now' } : {}) }, { post: true, ms: 9000 });
        if (r.busy) { sure = pkg; paint(); return toast('Something is playing. Tap again to install now.'); }
        if (!r.ok) throw new Error(r.error);
        sure = '';
        toast(r.opened ? `Opening ${a.name}` : `Installing ${a.name}`);
        if (r.installing) {
          let n = 0;
          const t = setInterval(async () => {
            if (++n > 30 || !box.isConnected) return clearInterval(t);
            const s = await call('/store').catch(() => null);
            if (s?.groups.flatMap((g) => g.apps).find((y) => y.pkg === pkg)?.installed) { clearInterval(t); shop = s; paint(); toast(`${a.name} installed`); }
          }, 5000);
        }
      } catch (e) { toast(e.message || 'That did not work'); } finally { b.disabled = false; }
    }));
    box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      const pkg = b.dataset.rm;
      if (sure !== 'rm:' + pkg) { sure = 'rm:' + pkg; paint(); return; }
      sure = ''; buzz();
      try { const r = await call('/store/remove', { a: pkg }, { post: true }); if (!r.ok) throw new Error(r.error); toast('Removing'); setTimeout(load, 6000); }
      catch (e) { toast(e.message || 'It could not be removed'); paint(); }
    }));
    pics();
  }
  load();
  return { stop() {} };
}

// ---- live sport at the top of For you: what is on, one tap opens SportzX or Cricfy on the TV ----
export function mountSport(box, { call, toast, buzz = () => {} }) {
  let timer = 0;
  async function load() {
    try {
      const s = await call('/sport');
      const ms = (s?.matches || []).filter((m) => m.state !== 'post' || m.followed).slice(0, 10);
      if (!s?.on || !ms.length) { box.innerHTML = ''; return; }
      const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      box.innerHTML = `<h3 class="tvx-h">Live sport<span>${ms.filter((m) => m.state === 'in').length} on now</span></h3>
        <div class="tvx-strip">${ms.map((m) => `<button class="tvf-match${m.followed ? ' mine' : ''}" data-sp="${esc(m.sport)}">
          <small>${esc(m.league)}${m.followed ? ' · your team' : ''}</small>
          <span><b>${esc(m.home)}</b><em>${m.state === 'pre' ? '' : esc(m.hs || (m.sport === 'football' ? '0' : ''))}</em></span>
          <span><b>${esc(m.away)}</b><em>${m.state === 'pre' ? '' : esc(m.as || (m.sport === 'football' ? '0' : ''))}</em></span>
          <i>${m.state === 'in' ? `<u></u>${esc(m.clock || 'Live')}` : m.state === 'pre' ? `Starts ${hm(m.start)}` : 'Finished'}</i></button>`).join('')}</div>`;
      box.querySelectorAll('[data-sp]').forEach((b) => (b.onclick = async () => {
        buzz();
        try { const r = await call('/sport/open', { a: b.dataset.sp }, { post: true }); toast(r.ok ? 'Opening' : 'Set the app in Features › Live sport'); }
        catch (e) { toast(e.message); }
      }));
    } catch { box.innerHTML = ''; }
  }
  load();
  timer = setInterval(() => { if (!box.isConnected) return clearInterval(timer); if (!document.hidden) load(); }, 60000);
  return { stop() { clearInterval(timer); } };
}

// ---- Watch together: the YouTube video on this TV, at the same moment, on your other TVs (and this phone) ----
// No server of its own: this phone talks to each TV (at home or through the relay), starts the video at the same
// point, then reads where each TV is and moves the late ones (TV seek, Home.java media "seek:<ms>").
export function mountTogether(box, { call, callOn, otherTvs = () => [], here = null, toast, buzz = () => {} }) {
  let busy = '', shown = '';
  const ytOf = async (c, fresh = true) => {
    const [now, hist] = !fresh && here ? [here().now, here().hist] : await Promise.all([c('/now'), c('/history').catch(() => [])]);
    const p = (now || []).find((x) => /youtube/.test(x.pkg));
    if (!p) return null;
    const h = (hist || []).find((x) => x.vid && x.title === p.title);
    return h ? { ...p, vid: h.vid } : { ...p, vid: '' };
  };
  async function paint() {
    const others = otherTvs();
    let p = null;
    try { p = await ytOf(call, false); } catch {}
    const key = JSON.stringify([p?.title, p?.vid, others.length, busy]);
    if (key === shown) return;   // nothing changed: not drawn again
    shown = key;
    box.innerHTML = !p ? '' : `<section class="tvf-together">
      <div class="tvf-row"><span class="tvf-tg-t"><b>Watch together</b><small>${others.length ? `${esc(p.title)} · ${others.map((t) => esc(t.name)).join(', ')}` : 'Open on this phone at the same point.'}</small></span></div>
      <div class="tvf-tg-b">
        ${others.length ? `<button class="btn sm pri" data-tg="start" ${busy ? 'disabled' : ''}>${busy === 'start' ? 'Starting…' : 'Start on the others'}</button>
        <button class="btn sm" data-tg="sync" ${busy ? 'disabled' : ''}>${busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
        <button class="btn sm" data-tg="pause">Pause all</button><button class="btn sm" data-tg="play">Play all</button>` : ''}
        ${p.vid ? `<button class="btn sm" data-tg="phone">On this phone</button>` : ''}</div></section>`;
    box.querySelectorAll('[data-tg]').forEach((b) => (b.onclick = () => act(b.dataset.tg, p)));
  }
  async function act(what, p) {
    buzz();
    const others = otherTvs();
    try {
      if (what === 'phone') {
        const fresh = await ytOf(call);
        window.open(`https://www.youtube.com/watch?v=${p.vid}&t=${Math.floor((fresh?.pos || p.pos) / 1000)}s`, '_blank');
        return;
      }
      if (what === 'pause' || what === 'play') {
        await Promise.all([call('/media', { a: p.pkg, b: what }, { post: true }), ...others.map((t) => callOn(t, '/media', { a: p.pkg, b: what }, { post: true }).catch(() => null))]);
        return toast(what === 'pause' ? 'Paused' : 'Playing');
      }
      if (!p.vid) return toast('Video not found yet. Try again shortly.');
      busy = what; paint();
      if (what === 'start') {
        const lead = await ytOf(call);
        const t = Math.floor((lead?.pos || 0) / 1000) + 3;   // the others need a few seconds to open it
        await Promise.all(others.map((tv) => callOn(tv, '/openIn', { a: 'com.google.android.youtube.tv', b: `https://www.youtube.com/watch?v=${p.vid}&t=${t}s` }, { post: true }).catch(() => null)));
        await new Promise((r) => setTimeout(r, 7000));
      }
      const moved = await sync(p, others);
      toast(moved ? `Synced ${moved} TV${moved > 1 ? 's' : ''}` : 'In sync');
    } catch (e) { toast(e.message || 'That did not work'); }
    busy = ''; paint();
  }
  // reads the leader and each other TV at almost the same time; a TV more than 1.5 s off is moved to the leader
  async function sync(p, others) {
    let moved = 0;
    for (const tv of others) {
      const t0 = Date.now();
      const [lead, them] = await Promise.all([ytOf(call), ytOf((path, q, o) => callOn(tv, path, q, o)).catch(() => null)]);
      if (!lead || !them) continue;
      const lag = (Date.now() - t0) / 2;
      if (Math.abs(lead.pos - them.pos) > 1500) { await callOn(tv, '/media', { a: them.pkg, b: `seek:${Math.round(lead.pos + lag + 400)}` }, { post: true }); moved++; }
    }
    return moved;
  }
  paint();
  const timer = setInterval(() => { if (!box.isConnected) return clearInterval(timer); if (!document.hidden && !busy) paint(); }, 5000);
  return { stop() { clearInterval(timer); } };
}
