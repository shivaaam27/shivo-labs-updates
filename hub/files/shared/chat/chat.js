// Shivo Labs Chat: the chat screen, shared by the laptop hub (and later the phone app).
// mountChat(root, { toast, haptic, home }) draws everything inside root and returns a function that cleans up.
// haptic(style) gives a light tap on phones; home(), when given, adds a button back to the app's home screen.
// getPass(), when given (the hub), returns this PC's shivo-id pass, so it joins its company's own team without a code.
// It talks to the Shivo Labs Chat server (chat/worker, on Cloudflare): HTTP for changes, a websocket for live events.

import { createDemo } from './demo.js';

// Filled in after the server is deployed, so people only type an invite code. Can be changed on the sign-in screen.
export const DEFAULT_SERVER = 'https://shivo-labs-chat.ishivamparmar.workers.dev';

const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJI_TABS = {
  '😀': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤗 🤭 🤫 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬',
  '👍': '👍 👎 👌 ✌️ 🤞 🤝 🙏 👏 🙌 👋 💪 👀 🫡 🤙 👉 👈 ☝️ ✋ 🤚 👊 ✊ 🫶 🤲 💅',
  '❤️': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💕 💯 ✨ 🔥 ⭐ 🌟 🎉 🎊 🎈 🎁 🏆 🥇',
  '☕': '☕ 🍕 🎂 🍔 🍟 🍫 🥤 🍽️ 🚀 💡 📌 📎 📷 🎵 ⚽ 💰 📅 ⏰ 🌍 ✅ ❌ 📈 💼 🏠 🚗 ✈️ 📞 💻 📱 🧾',
};
const EMOJI = '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤗 🤭 🤫 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 👍 👎 👌 ✌️ 🤞 🤝 🙏 👏 🙌 👋 💪 👀 🎉 🎊 🔥 ⭐ ✨ 💯 ✅ ❌ ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ☕ 🍕 🎂 🚀 💡 📌 📎 📷 🎵 ⚽ 🏆 💰 📅 ⏰ 🌍'.split(' ');
const IC = {
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>', arrow: '<path d="M5 12h13M13 6l6 6-6 6"/>', chev: '<path d="m9 6 6 6-6 6"/>', key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>', out: '<path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>', clip: '<path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>', back: '<path d="M15 5l-7 7 7 7"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  pin: '<path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 15v5"/>', reply: '<path d="M10 8 5 12l5 4"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>', fwd: '<path d="M14 8l5 4-5 4"/><path d="M19 12h-9a5 5 0 0 0-5 5v1"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>', file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>', mute: '<path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8"/><path d="M4 4l16 16"/>',
  star: '<path d="m12 4 2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z"/>', box: '<path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M3 4h18v4H3zM10 12h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14a5 5 0 0 1 5 5"/>', gear: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>', grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>', camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', play: '<path d="M8 5v14l11-7z"/>', pause: '<path d="M8 5v14M16 5v14"/>', clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
};
const svg = (k, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24">${IC[k]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const size = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => new Date(t).toDateString();
const dayName = (t) => {
  const d = new Date(t), now = new Date(), y = new Date(now - 864e5);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], now - d < 6 * 864e5 ? { weekday: 'long' } : { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
};
const when = (t) => { if (!t) return ''; const d = dayName(t); return d === 'Today' ? hm(t) : d === 'Yesterday' ? d : new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const ago = (t) => { if (!t) return 'offline'; const s = (Date.now() - t) / 1000; return s < 60 ? 'last seen just now' : s < 3600 ? `last seen ${Math.floor(s / 60)} min ago` : s < 86400 ? `last seen today at ${hm(t)}` : `last seen ${when(t)}`; };
const initials = (n) => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
const onlyEmoji = (s) => s && s.length <= 12 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(s) && !/^[\d#*\s]+$/.test(s);
const mark0 = (cls) => (typeof window.shivoMark === 'function' ? window.shivoMark(cls) : '');
const dur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function mountChat(root, { toast = () => {}, haptic = () => {}, home = null, getPass = null } = {}) {
  const buzz = (k = 'light') => { try { haptic(k); } catch {} };
  const cfg = store.get('shivoChat') || {};
  if (!cfg.server && DEFAULT_SERVER) cfg.server = DEFAULT_SERVER;
  const S = { users: new Map(), chats: new Map(), msgs: new Map(), more: new Map(), detached: new Set(), typing: new Map(), open: null, filter: 'all', q: '', reply: null, edit: null, info: false, pending: new Map(), files: false, att: [], drawn: new Map() };
  let demo = null;  // "Look around first": a pretend server with a sample team (demo.js)
  let ws = null, wsTry = 0, wsTimer = 0, pingTimer = 0, alive = true, typingSent = 0, typingStop = 0, readTimer = 0, rec = null;
  const listeners = [];
  const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); listeners.push(() => el.removeEventListener(ev, fn, opt)); };
  const $ = (s) => root.querySelector(s);
  root.classList.add('ch-root');

  // ---------- server calls
  const base = () => cfg.server.replace(/\/+$/, '');
  async function api(path, { method = 'GET', body, headers = {}, raw, progress } = {}) {
    if (demo) {
      if (progress) for (let i = 1; i <= 8; i++) { await new Promise((r) => setTimeout(r, 90)); progress(i / 8); }
      return demo.request(path, { method, body: raw ? body : body ? JSON.stringify(body) : undefined });
    }
    if (progress) return new Promise((ok, bad) => {
      const x = new XMLHttpRequest();
      x.open(method, base() + '/api/' + path);
      x.setRequestHeader('authorization', 'Bearer ' + cfg.token);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded / e.total);
      x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} if (x.status === 401) { signedOut(); return bad(new Error('Please sign in again')); } x.status < 300 ? ok(d) : bad(new Error(d.error || `Server error ${x.status}`)); };
      x.onerror = () => bad(new Error("Couldn't upload. Check your internet."));
      x.send(body);
    });
    const r = await fetch(base() + '/api/' + path, {
      method, headers: { ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && cfg.token) { signedOut(); throw new Error(data.error || 'Please sign in again'); }
    if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);
    return data;
  }
  const act = (type, data = {}) => api('act', { method: 'POST', body: { type, ...data } });
  const fileUrl = (key) => demo ? demo.url(key) : `${base()}/api/files/${key}?t=${encodeURIComponent(cfg.token)}`;
  const tryAct = async (type, data, ok) => { try { const r = await act(type, data); if (ok) toast(ok); return r; } catch (e) { toast(e.message); } };

  // ---------- names and faces
  const user = (id) => S.users.get(id) || { id, name: 'Someone', color: '#777' };
  const nameOf = (id) => id === S.me ? 'You' : user(id).name;
  const otherOf = (c) => c.kind === 'dm' ? (c.members.find((m) => m.user !== S.me)?.user || S.me) : null;
  const chatName = (c) => c.kind === 'group' ? c.name : otherOf(c) === S.me ? 'Notes' : user(otherOf(c)).name;
  const avatar = (c, sz = '') => {  // rounded tiles, like the module icons
    if (c.kind === 'group') return `<span class="ch-av grp ${sz}">${svg('users')}</span>`;
    const u = user(otherOf(c));
    if (u.id === S.me) return `<span class="ch-av notes ${sz}">${svg('pin')}</span>`;
    return `<span class="ch-av ${sz}" style="--c:${esc(u.color)}">${esc(initials(u.name))}${u.online ? '<i class="ch-on"></i>' : ''}</span>`;
  };
  const uAvatar = (id, sz = '') => { const u = user(id); return `<span class="ch-av ${sz}" style="--c:${esc(u.color)}">${esc(initials(u.name))}${u.online && id !== S.me ? '<i class="ch-on"></i>' : ''}</span>`; };

  // ---------- message text: safe html with links, *bold*, _italic_, ~strike~, `code`, ```blocks``` and @mentions
  function fmt(text) {
    const blocks = [];
    let s = esc(text).replace(/```([\s\S]+?)```/g, (_, c) => { blocks.push(`<pre>${c.replace(/^\n/, '')}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { blocks.push(`<code>${c}</code>`); return `\u0000${blocks.length - 1}\u0000`; });
    s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g, (u) => { blocks.push(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`); return `\u0000${blocks.length - 1}\u0000`; });
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, '$1<b>$2</b>').replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<i>$2</i>').replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?])/g, '$1<s>$2</s>');
    const names = [...S.users.values()].map((u) => u.name).sort((a, b) => b.length - a.length);
    for (const n of names) { const e = esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); s = s.replace(new RegExp(`@${e}\\b`, 'g'), (m) => `<span class="ch-at${n === user(S.me).name ? ' me' : ''}">${m}</span>`); }
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]).replace(/\n/g, '<br>');
  }
  const preview = (m) => {
    if (!m) return '';
    if (m.deleted) return '<i>Message deleted</i>';
    if (m.kind === 'system') return esc(`${nameOf(m.user)} ${m.text}`);
    const f = m.file ? (m.file.voice ? `🎤 Voice message ${dur(m.file.dur)}` : /^image\//.test(m.file.type) ? '📷 Photo' : /^video\//.test(m.file.type) ? '🎬 Video' : `📎 ${m.file.name}`) : '';
    return esc([f, m.text.replace(/[*_~`]+/g, '')].filter(Boolean).join(' · '));  // previews show plain text
  };

  // ---------- sign-in screen
  let signKeys = false;
  const signTop = (line) => `<div class="ch-sign-top"><div class="ch-hero">${mark0('play loop')}</div><div class="word">SHIVO<span>LABS</span></div>
        <h1 class="ch-h">Team chat.<span>${esc(line)}</span></h1></div>`;
  // a PC whose Shivo Labs pass has Chat joins its own company's team with the pass (getPass, from the hub); everyone
  // else (the phone, Shivam's PC) signs in with an invite code
  async function showSignIn(err) {
    if (!signKeys) { signKeys = true; on(root, 'keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.ch-sign')) $('#chGo')?.click(); }); }
    const pass = getPass && !cfg.codeOnly ? await getPass().catch(() => null) : null;
    if (!pass || !alive) return codeSignIn(err);
    if (!cfg.server) cfg.server = DEFAULT_SERVER;
    let info;
    try { info = await api('pass/info', { method: 'POST', body: { pass } }); } catch (e) { return codeSignIn(err || e.message); }
    if (!alive) return;
    if (!info.ready || info.blocked) return codeSignIn(info.blocked ? 'You were removed from this chat. Ask the team owner for an invite code.' : err);
    root.innerHTML = `<div class="ch-sign">
      ${signTop(info.team || 'Your team')}
      <div class="ch-card glass-card">
        ${info.known ? '' : `<div class="ch-kh"><span class="ch-tile">${svg('user')}</span><label for="chName"><b>Your name</b><small>${info.owner ? 'You are the first one in, so you manage the team' : 'How the team sees you'}</small></label></div>
        <input class="ch-field" id="chName" placeholder="Your name" maxlength="40">`}
        <p class="ch-err" id="chErr">${esc(err || '')}</p>
        <button class="btn pri" id="chGo">${info.known ? `Continue as ${esc(info.name)}` : 'Join the chat'}</button>
        <button class="ch-skip" id="chCodeIn">Use an invite code instead</button></div></div>`;
    $('#chCodeIn').onclick = () => { cfg.codeOnly = true; codeSignIn(); };
    $('#chGo').onclick = async () => {
      $('#chErr').textContent = ''; $('#chGo').disabled = true;
      try {
        const r = await api('pass/join', { method: 'POST', body: { pass, name: $('#chName')?.value || '' } });
        cfg.token = r.token; cfg.demo = false; store.set('shivoChat', cfg);
        start();
      } catch (e) { $('#chErr').textContent = e.message; $('#chGo').disabled = false; }
    };
  }
  async function codeSignIn(err) {
    root.innerHTML = `<div class="ch-sign">
      <div class="ch-sign-top"><div class="ch-hero">${mark0('play loop')}</div><div class="word">SHIVO<span>LABS</span></div>
        <h1 class="ch-h">Team chat.<span>Sign in with your invite.</span></h1></div>
      <div class="ch-card glass-card">
        <div class="seg ch-seg" id="chTabs" hidden><button class="on" data-m="join">Join with invite</button><button data-m="setup">Set up (owner)</button></div>
        <div class="ch-kh ${DEFAULT_SERVER ? 'hide-srv' : ''}"><span class="ch-tile">${svg('arrow')}</span><label for="chSrv"><b>Chat server</b><small>The address of your Shivo Labs Chat</small></label></div>
        <input class="ch-field ${DEFAULT_SERVER ? 'hide-srv' : ''}" id="chSrv" placeholder="https://shivo-labs-chat.….workers.dev" value="${esc(cfg.server || '')}" autocomplete="off">
        <div class="ch-kh"><span class="ch-tile">${svg('key')}</span><label for="chCode"><b id="chCodeL">Invite code</b><small id="chCodeS">From the person who invited you</small></label></div>
        <input class="ch-field" id="chCode" placeholder="e.g. K7QM-2PXA" autocomplete="off">
        <div class="ch-kh"><span class="ch-tile">${svg('user')}</span><label for="chName"><b>Your name</b><small>How the team sees you</small></label></div>
        <input class="ch-field" id="chName" placeholder="Your name" maxlength="40">
        <p class="ch-err" id="chErr">${esc(err || '')}</p>
        <button class="btn pri" id="chGo">Continue</button>
        <button class="ch-skip" id="chDemo">Look around first</button></div></div>`;
    let mode = 'join';
    const check = async () => {
      if (!$('#chSrv').value.trim()) return;
      cfg.server = $('#chSrv').value.trim();
      try { const i = await api('info'); $('#chTabs').hidden = !i.setup; if (i.setup) setMode('setup'); } catch { $('#chErr').textContent = "Can't reach that chat server. Check the address and your internet."; }
    };
    const setMode = (m) => {
      mode = m;
      root.querySelectorAll('#chTabs button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      $('#chCodeL').textContent = m === 'setup' ? 'Setup code' : 'Invite code';
      $('#chCode').placeholder = m === 'setup' ? 'The code set on the server' : 'e.g. K7QM-2PXA';
      $('#chCodeS').textContent = m === 'setup' ? 'Only the owner has it' : 'From the person who invited you';
      $('#chGo').textContent = m === 'setup' ? 'Set up the chat' : 'Continue';
    };
    $('#chTabs').onclick = (e) => e.target.dataset.m && setMode(e.target.dataset.m);
    $('#chSrv').onchange = check;
    $('#chDemo').onclick = () => { cfg.demo = true; store.set('shivoChat', cfg); start(); };
    $('#chGo').onclick = async () => {
      $('#chErr').textContent = '';
      cfg.server = $('#chSrv').value.trim();
      if (!/^https?:\/\//.test(cfg.server)) return ($('#chErr').textContent = 'Type the chat server address (starts with https://)');
      $('#chGo').disabled = true;
      try {
        const r = await api(mode, { method: 'POST', body: { code: $('#chCode').value, name: $('#chName').value } });
        cfg.token = r.token; store.set('shivoChat', cfg);
        start();
      } catch (e) { $('#chErr').textContent = e.message; $('#chGo').disabled = false; }
    };
    if (getPass) {
      // back to the pass, for a PC that has one
      $('#chDemo').insertAdjacentHTML('beforebegin', '<button class="ch-skip" id="chPassIn" hidden>Join with this computer</button>');
      getPass().then((p) => { if (p && $('#chPassIn')) { $('#chPassIn').hidden = false; $('#chPassIn').onclick = () => { cfg.codeOnly = false; showSignIn(); }; } }).catch(() => {});
    }
    check();
  }
  function signedOut() {
    const wasDemo = !!demo; demo = null; cfg.demo = false;
    cfg.token = ''; store.set('shivoChat', cfg);
    try { ws?.close(); } catch {}
    ws = null; clearTimeout(wsTimer); clearInterval(pingTimer);
    showSignIn(wasDemo ? '' : getPass ? 'You were signed out.' : 'You were signed out. Sign in again with an invite code.');
  }

  // ---------- the main screen
  function shell() {
    root.innerHTML = `<div class="ch-app" id="chApp">
      <aside class="ch-side">
        <div class="ch-side-top">
          <b class="ch-title">Chats</b>
          <button class="gbtn" id="chNew" title="New chat">${svg('edit')}</button>
          <button class="gbtn ch-me" id="chMe" title="Settings"></button>
          ${home ? `<button class="gbtn" id="chHome" title="Home">${svg('grid')}</button>` : ''}
        </div>
        ${demo ? `<button class="ch-demo" id="chDemoNote"><b>Demo</b><span>Sample team. Nothing is sent.</span><i>Set up</i></button>` : ''}
        <label class="ch-search">${svg('search')}<input id="chQ" placeholder="Search chats and messages" autocomplete="off"><button class="ch-x" id="chQx" hidden>${svg('x')}</button></label>
        <div class="ch-chips" id="chChips">${[['all', 'All'], ['unread', 'Unread'], ['groups', 'Groups'], ['fav', 'Favourites'], ['archived', 'Archived']].map(([k, n]) => `<button data-f="${k}" class="${k === 'all' ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="ch-list" id="chList"></div>
        <div class="ch-conn" id="chConn" hidden>Connecting…</div>
      </aside>
      <section class="ch-main" id="chMain"></section>
      <aside class="ch-info" id="chInfo" hidden></aside>
    </div><div class="ch-veil" id="chVeil" hidden></div>`;
    renderMain();
    $('#chMe').onclick = openSettings;
    $('#chHome')?.addEventListener('click', () => home());
    $('#chDemoNote')?.addEventListener('click', () => confirmBox('Leave the demo and set up the real chat?', 'Set up', signedOut));
    $('#chNew').onclick = openNew;
    $('#chChips').onclick = (e) => { const f = e.target.dataset.f; if (!f) return; S.filter = f; const cb = $('#chChips'), x = e.target.offsetLeft - cb.offsetLeft, w = e.target.offsetWidth; if (x < cb.scrollLeft) cb.scrollTo({ left: x - 12, behavior: 'smooth' }); else if (x + w > cb.scrollLeft + cb.clientWidth - 24) cb.scrollTo({ left: x + w - cb.clientWidth + 32, behavior: 'smooth' }); root.querySelectorAll('#chChips button').forEach((b) => b.classList.toggle('on', b.dataset.f === f)); renderList(); };
    let qT;
    $('#chQ').oninput = () => { S.q = $('#chQ').value.trim(); $('#chQx').hidden = !S.q; renderList(); clearTimeout(qT); if (S.q.length > 1) qT = setTimeout(searchAll, 300); };
    $('#chQx').onclick = () => { $('#chQ').value = ''; S.q = ''; $('#chQx').hidden = true; renderList(); };
    $('#chList').onclick = (e) => {
      if (S.noClick) return;
      const sa = e.target.closest('[data-sa]');
      if (sa) { const id = sa.closest('[data-sw]').dataset.sw, c = S.chats.get(id); closeSw(); buzz(); return tryAct('chat.prefs', { chat: id, [sa.dataset.sa]: !c[sa.dataset.sa] }); }
      if (S.sw) return closeSw();
      const r = e.target.closest('[data-chat]'); if (!r) return;
      openChat(r.dataset.chat, r.dataset.msg ? +r.dataset.msg : 0);
    };
  }

  async function sync() {
    const d = await api('sync');
    S.me = d.me; S.files = d.files;
    S.users = new Map(d.users.map((u) => [u.id, u]));
    S.chats = new Map(d.chats.map((c) => [c.id, c]));
    if (S.open && !S.chats.has(S.open)) { S.open = null; renderMain(); }
    const me = user(S.me);
    $('#chMe').innerHTML = svg('gear');
    $('#chMe').title = `${me.name} · Settings`;
    renderList(); renderHeader(); if (S.info) renderInfo();
    badge();
  }

  function sorted() {
    return [...S.chats.values()].sort((a, b) => (b.fav - a.fav) || ((b.last?.ts || b.created) - (a.last?.ts || a.created)));
  }
  function renderList() {
    const el = $('#chList'); if (!el) return;
    S.sw = null;  // rows are rebuilt below
    const q = S.q.toLowerCase();
    let list = sorted().filter((c) => S.filter === 'archived' ? c.archived : !c.archived);
    if (S.filter === 'unread') list = list.filter((c) => c.unread);
    if (S.filter === 'groups') list = list.filter((c) => c.kind === 'group');
    if (S.filter === 'fav') list = list.filter((c) => c.fav);
    if (q) list = [...S.chats.values()].filter((c) => chatName(c).toLowerCase().includes(q));
    // people you have not chatted with yet show up when searching
    const people = q ? [...S.users.values()].filter((u) => !u.removed && u.id !== S.me && u.name.toLowerCase().includes(q) && !list.some((c) => otherOf(c) === u.id)) : [];
    const arch = S.filter === 'all' && !q ? [...S.chats.values()].filter((c) => c.archived).length : 0;
    el.innerHTML = (arch ? `<button class="ch-arch" data-arch>${svg('box')}Archived<span>${arch}</span></button>` : '') +
      list.map((c) => {
        const typing = typers(c.id);
        return `<div class="ch-sw" data-sw="${c.id}"><div class="ch-sw-a l"><button data-sa="fav"><i>${svg('star')}</i><span>${c.fav ? 'Unstar' : 'Favourite'}</span></button></div>
        <div class="ch-sw-a r"><button data-sa="muted"><i>${svg(c.muted ? 'bell' : 'mute')}</i><span>${c.muted ? 'Unmute' : 'Mute'}</span></button><button data-sa="archived"><i>${svg('box')}</i><span>${c.archived ? 'Unarchive' : 'Archive'}</span></button></div>
        <button class="ch-row${c.id === S.open ? ' on' : ''}${c.unread ? ' new' : ''}" data-chat="${c.id}">${avatar(c)}
        <span class="ch-row-t"><b>${esc(chatName(c))}</b></span>
        <span class="ch-row-m"><time>${when(c.last?.ts)}</time><span class="ch-row-b">${c.muted ? svg('mute', 'ch-mut') : ''}${c.fav ? svg('star', 'ch-fav') : ''}${c.mentions ? '<i class="ch-men">@</i>' : ''}${c.unread ? `<i class="ch-badge${c.muted ? ' muted' : ''}">${c.unread > 99 ? '99+' : c.unread}</i>` : ''}</span></span>
        <span class="ch-row-s">${typing ? `<em>${esc(typing)}</em>` : `${c.last && c.last.user === S.me && c.last.kind !== 'system' && !c.last.deleted ? ticks(c, c.last) : ''}<span>${c.last && c.kind === 'group' && c.last.kind !== 'system' && !c.last.deleted ? `${esc(nameOf(c.last.user))}: ` : ''}${preview(c.last) || '<i>No messages yet</i>'}</span>`}
</span></button></div>`;
      }).join('') +
      (people.length ? `<div class="ch-sec">People</div>` + people.map((u) => `<button class="ch-row" data-person="${u.id}">${uAvatar(u.id)}<span class="ch-row-t"><b>${esc(u.name)}</b></span><span class="ch-row-s"><span>${esc(u.status || 'Start a chat')}</span></span></button>`).join('') : '') +
      (q.length > 1 ? `<div class="ch-sec">Messages</div><div id="chHits">${S.hits?.q === S.q ? S.hits.html : '<div class="ch-hint">Searching…</div>'}</div>` : '') +
      (!list.length && !people.length && !q ? emptyList() : '');
    el.querySelector('[data-arch]')?.addEventListener('click', () => { S.filter = 'archived'; root.querySelectorAll('#chChips button').forEach((b) => b.classList.toggle('on', b.dataset.f === 'archived')); renderList(); });
    el.querySelectorAll('[data-person]').forEach((b) => (b.onclick = () => dmWith(b.dataset.person)));
  }
  function emptyList() {
    const [ic, t, sub] = { all: ['edit', 'No chats yet', 'Start one with the pencil button.'], unread: ['check', 'All caught up', 'No unread messages.'], groups: ['users', 'No groups yet', 'Make one with the pencil button.'],
      fav: ['star', 'No favourites', 'Swipe a chat to the right to star it.'], archived: ['box', 'Nothing archived', 'Swipe a chat to the left to archive it.'] }[S.filter];
    return `<div class="ch-nothing"><span>${svg(ic)}</span><b>${t}</b><small>${sub}</small></div>`;
  }
  async function searchAll() {
    const q = S.q;
    try {
      const r = await api('search?q=' + encodeURIComponent(q));
      if (q !== S.q || !$('#chHits')) return;
      S.hits = { q, html: '' };
      $('#chHits').innerHTML = S.hits.html = r.messages.length ? r.messages.map((m) => { const c = S.chats.get(m.chat); return c ? `<button class="ch-row hit" data-chat="${c.id}" data-msg="${m.id}">${avatar(c)}<span class="ch-row-t"><b>${esc(chatName(c))}</b><time>${when(m.ts)}</time></span><span class="ch-row-s"><span>${m.user === S.me ? 'You: ' : c.kind === 'group' ? esc(nameOf(m.user)) + ': ' : ''}${mark(preview(m), q)}</span></span></button>` : ''; }).join('') : '<div class="ch-hint">No messages found</div>';
    } catch {}
  }
  const mark = (html, q) => html.replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);

  // ---------- a conversation
  async function openChat(id, jumpTo = 0) {
    const c = S.chats.get(id); if (!c) return;
    S.open = id; S.reply = null; S.edit = null;
    const lastRead = c.unread ? c.members.find((m) => m.user === S.me)?.last_read || 0 : 0;
    S.firstNew = null;
    $('#chApp').classList.add('open');
    renderMain(); renderList(); if (S.info) renderInfo();
    if (!S.msgs.has(id) || jumpTo || S.detached.has(id)) await load(id, jumpTo ? { around: jumpTo } : {});
    else { draw(); await catchUp(id); }
    // a "New messages" line above the first one you haven't read
    const first = lastRead && (S.msgs.get(id) || []).find((m) => m.id > lastRead && m.user !== S.me && m.kind !== 'system');
    if (first) { S.firstNew = { chat: id, id: first.id }; draw(); }
    if (jumpTo) flash(jumpTo); else scrollEnd(true);
    for (let e = root; e && e !== document.body; e = e.parentElement) if (e.scrollTop) e.scrollTop = 0;
    if (innerWidth > 760) $('#chText')?.focus({ preventScroll: true });
  }
  async function load(id, p = {}) {
    try {
      const r = await api(`messages?chat=${id}${p.before ? '&before=' + p.before : ''}${p.around ? '&around=' + p.around : ''}${p.after ? '&after=' + p.after : ''}`);
      let list = S.msgs.get(id) || [];
      if (p.before) list = [...r.messages, ...list];
      else if (p.after) list = [...list, ...r.messages];
      else list = r.messages;
      S.msgs.set(id, dedupe(list));
      if (p.around) { S.detached.add(id); S.more.set(id, true); }
      else if (p.after) { if (!r.more) S.detached.delete(id); }
      else if (!p.before) { S.detached.delete(id); S.more.set(id, r.more); }
      else S.more.set(id, r.more);
      if (S.open === id) draw();
    } catch (e) { toast(e.message); }
  }
  const dedupe = (list) => { const seen = new Set(); return list.filter((m) => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.id - b.id); };
  async function catchUp(id) { const l = S.msgs.get(id); if (l?.length && !S.detached.has(id)) await load(id, { after: l[l.length - 1].id }); }

  function renderMain() {
    const c = S.chats.get(S.open), el = $('#chMain');
    if (!c) { el.innerHTML = `<div class="ch-empty"><div class="ch-hero">${mark0('play loop')}</div><h1 class="ch-h">Team chat.<span>Pick a chat, or start one.</span></h1><button class="ch-sugg" id="chEmptyNew">${svg('edit')}New chat</button></div>`; el.querySelector('#chEmptyNew').onclick = openNew; $('#chApp')?.classList.remove('open'); return; }
    el.innerHTML = `
      <header class="ch-head" id="chHead"></header>
      <div class="ch-pinbar" id="chPinbar" hidden></div>
      <div class="ch-dayf" id="chDayF" hidden></div>
      <div class="ch-scroll" id="chScroll"><div class="ch-msgs" id="chMsgs"></div></div>
      <button class="ch-tobottom" id="chToBottom" hidden>${svg('down')}<i id="chToBottomN"></i></button>
      <div class="ch-drop" id="chDrop" hidden><span>${svg('clip')}Drop to send</span></div>
      <footer class="ch-comp" id="chComp">
        <div class="ch-ctx" id="chCtx" hidden></div>
        <div class="ch-mention" id="chMention" hidden></div>
        <div class="ch-composer" id="chBar">
          <div class="ch-att" id="chAtt" hidden></div>
          <textarea id="chText" rows="1" placeholder="Message" maxlength="4000"></textarea>
          <div class="ch-crow">
            <button class="ch-ib" id="chAttach" title="Photos and files" ${S.files ? '' : 'hidden'}>${svg('plus')}</button>
            <input type="file" id="chFile" multiple hidden><input type="file" id="chPhotos" accept="image/*,video/*" multiple hidden><input type="file" id="chCamera" accept="image/*" capture="environment" hidden>
            <button class="ch-chip" id="chEmoBtn" title="Emoji">${svg('smile')}<span>Emoji</span></button>
            <button class="ch-ib ch-mic" id="chMic" title="Voice message" ${S.files ? '' : 'hidden'}>${svg('mic')}</button>
            <button class="ch-send" id="chSend" title="Send" disabled>${svg('send')}</button>
          </div>
          <div class="ch-tray" id="chEmo" hidden><div class="ch-tray-tabs" id="chEmoTabs"></div><div class="ch-tray-grid" id="chEmoGrid"></div></div>
        </div>
        <div class="ch-composer ch-rec" id="chRec" hidden><button class="ch-ib" id="chRecX" title="Cancel">${svg('trash')}</button><i class="ch-dot"></i><span id="chRecT">0:00</span><small>Recording…</small><button class="ch-send" id="chRecGo" title="Send">${svg('send')}</button></div>
      </footer>`;
    renderHeader(); renderPinbar(); wireComposer(); wireScroll();
    const draft = (store.get('shivoChatDrafts') || {})[c.id]; if (draft) { $('#chText').value = draft; grow(); setSendIcon(); }
  }
  function renderHeader() {
    const c = S.chats.get(S.open), el = $('#chHead'); if (!c || !el) return;
    let sub;
    const t = typers(c.id);
    if (t) sub = `<em>${esc(t)}</em>`;
    else if (c.kind === 'group') { const on = c.members.filter((m) => user(m.user).online && m.user !== S.me).length; sub = `${c.members.length} member${c.members.length === 1 ? "" : "s"}${on ? ` · ${on} online` : ''}`; }
    else { const u = user(otherOf(c)); sub = u.id === S.me ? 'Messages to yourself' : u.online ? '<span class="ch-online">online</span>' : ago(u.last_seen); }
    el.innerHTML = `<button class="gbtn ch-back" id="chBack" title="Back">${svg('back')}</button>
      <button class="ch-head-who" id="chWho">${avatar(c, 'sm')}<span><b>${esc(chatName(c))}</b><small>${sub}</small></span></button>
      <button class="gbtn" id="chFind" title="Search in this chat">${svg('search')}</button>
      <button class="gbtn${S.info ? ' on' : ''}" id="chInfoBtn" title="Details">${svg('info')}</button>`;
    $('#chBack').onclick = () => { S.open = null; $('#chApp').classList.remove('open'); renderList(); };
    $('#chWho').onclick = $('#chInfoBtn').onclick = () => { S.info = !S.info; renderInfo(); renderHeader(); };
    $('#chFind').onclick = () => { S.info = true; renderInfo('search'); renderHeader(); };
    typingBubble();
  }
  function typingBubble() {
    const el = $('#chTyping'); if (!el) return;
    const t = S.open && typers(S.open), was = !el.hidden, stick = near();
    el.hidden = !t;
    if (t) el.querySelector('small').textContent = S.chats.get(S.open)?.kind === 'group' ? t.replace(/ (is|are) typing…$/, '') : '';
    if (t && !was && stick) { const s = $('#chScroll'); s.scrollTop = s.scrollHeight; }
  }
  function renderPinbar() {
    const el = $('#chPinbar'); if (!el) return;
    const pins = (S.msgs.get(S.open) || []).filter((m) => m.pinned && !m.deleted);
    const p = pins[pins.length - 1];
    el.hidden = !p;
    if (p) { el.innerHTML = `${svg('pin')}<span><b>Pinned${pins.length > 1 ? ` (${pins.length})` : ''}</b>${preview(p)}</span>`; el.onclick = () => jump(p.id); }
  }

  // ticks on your own messages: one = sent, two = seen by someone, two green = seen by everyone
  function ticks(c, m) {
    if (m.cid) return `<span class="ch-tk">${svg('clock')}</span>`;
    const others = c.members.filter((x) => x.user !== S.me);
    if (!others.length) return '';
    const seen = others.filter((x) => x.last_read >= m.id).length;
    return `<span class="ch-tk${seen === others.length ? ' all' : ''}">${svg('check')}${seen ? svg('check', 'b') : ''}</span>`;
  }

  function msgHtml(c, m, prev, firstNew, fresh) {
    let h = '';
    if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) h += `<div class="ch-day"><span>${dayName(m.ts)}</span></div>`;
    if (firstNew) h += `<div class="ch-newline" id="chNewLine"><span>New messages</span></div>`;
    if (m.kind === 'system') return h + `<div class="ch-sys" data-id="${m.id}"><span>${esc(nameOf(m.user))} ${esc(m.text)}</span></div>`;
    const mine = m.user === S.me;
    const cont = prev && prev.kind !== 'system' && prev.user === m.user && m.ts - prev.ts < 300e3 && dayKey(prev.ts) === dayKey(m.ts) && !firstNew;
    const u = user(m.user);
    let body = '';
    if (m.deleted) body = `<span class="ch-del">${svg('x')}This message was deleted</span>`;
    else {
      if (m.fwd) body += `<span class="ch-fwd">${svg('fwd')}Forwarded</span>`;
      if (m.reply) body += `<button class="ch-quote" data-jump="${m.reply.id}" style="--c:${esc(user(m.reply.user).color)}"><b>${esc(nameOf(m.reply.user))}</b><span>${m.reply.deleted ? '<i>Message deleted</i>' : esc(m.reply.text || (m.reply.file ? (m.reply.file.voice ? '🎤 Voice message' : '📎 ' + m.reply.file.name) : ''))}</span></button>`;
      if (m.file) body += fileHtml(m.file, m.local, m.cid && !m.failed);
      if (m.text) body += `<div class="ch-txt${onlyEmoji(m.text) && !m.file && !m.reply ? ' big' : ''}">${fmt(m.text)}</div>`;
    }
    const meta = `<span class="ch-meta">${m.pinned ? svg('pin', 'ch-pinned') : ''}${m.edited && !m.deleted ? 'edited · ' : ''}${hm(m.ts)}${mine && !m.deleted ? ticks(c, m) : ''}</span>`;
    const rx = Object.entries(m.rx || {}).filter(([, us]) => us.length);
    const rxh = rx.length ? `<div class="ch-rx">${rx.map(([e, us]) => `<button class="${us.includes(S.me) ? 'me' : ''}" data-rx="${esc(e)}" title="${esc(us.map(nameOf).join(', '))}">${e}<b>${us.length}</b></button>`).join('')}</div>` : '';
    const failed = m.failed ? `<button class="ch-failed" data-retry="${m.cid}">Not sent · Retry</button>` : '';
    return h + `<div class="ch-m${mine ? ' mine' : ''}${cont ? ' cont' : ''}${m.cid ? ' pend' : ''}${fresh ? ' in' : ''}" data-id="${m.id}"${m.cid ? ` data-cid="${m.cid}"` : ''}>
      ${m.deleted || m.cid ? '' : `<span class="ch-swr">${svg('reply')}</span>`}
      ${!mine && c.kind === 'group' ? (cont ? '<span class="ch-gap"></span>' : uAvatar(m.user, 'sm')) : ''}
      <div class="ch-b-wrap">
        ${!mine && c.kind === 'group' && !cont ? `<b class="ch-who" style="color:${esc(u.color)}">${esc(u.name)}</b>` : ''}
        <div class="ch-b${m.file && /^image\/|^video\//.test(m.file.type) && !m.text ? ' media' : ''}">${body}${meta}</div>${rxh}${failed}
      </div>
      ${m.deleted || m.cid ? '' : `<div class="ch-tools"><button data-t="react" title="React">${svg('smile')}</button><button data-t="reply" title="Reply">${svg('reply')}</button><button data-t="more" title="More">${svg('more')}</button></div>`}
    </div>`;
  }
  function fileHtml(f, local, sending) {
    const ring = sending ? `<span class="ch-up"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15"/><circle class="v" cx="18" cy="18" r="15"/></svg></span>` : '';
    return sending ? `<span class="ch-media${/^(image|video)\//.test(f.type) && !f.voice ? '' : ' ch-media-file'}">${fileInner(f, local)}${ring}</span>` : fileInner(f, local);
  }
  function fileInner(f, local) {
    const src = local || fileUrl(f.key);
    if (f.voice || /^audio\//.test(f.type)) return `<div class="ch-voice" data-src="${esc(src)}"><button class="ch-play">${svg('play')}</button><span class="ch-wave"><i></i></span><small>${f.dur ? dur(f.dur) : esc(f.name)}</small></div>`;
    if (/^image\//.test(f.type)) {
      const r = f.w && f.h ? Math.max(Math.min(1, 280 / f.w, 320 / f.h), 80 / Math.min(f.w, f.h)) : 0;  // tiny pictures still get a tappable size
      return `<img class="ch-img" src="${esc(src)}" alt="${esc(f.name)}" loading="lazy" data-full="${esc(src)}" ${r ? `width="${Math.round(f.w * r)}" height="${Math.round(f.h * r)}"` : ''}>`;
    }
    if (/^video\//.test(f.type)) return `<video class="ch-vid" src="${esc(src)}" controls preload="metadata"></video>`;
    return `<a class="ch-filecard" href="${esc(src)}" target="_blank" rel="noopener" download="${esc(f.name)}">${svg('file')}<span><b>${esc(f.name)}</b><small>${size(f.size)} · ${esc((f.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toUpperCase())}</small></span>${svg('down')}</a>`;
  }
  function draw() {
    const c = S.chats.get(S.open), el = $('#chMsgs'); if (!c || !el) return;
    const list = [...(S.msgs.get(c.id) || []), ...[...S.pending.values()].filter((p) => p.chat === c.id)];
    const firstNewId = S.firstNew?.chat === c.id ? S.firstNew.id : 0;
    // only messages that weren't on screen before slide in (not the whole list on every change)
    const first = !S.drawn.has(c.id), seen = S.drawn.get(c.id) || new Set();
    S.drawn.set(c.id, seen);
    el.innerHTML = (S.more.get(c.id) ? '<div class="ch-loadmore">Loading earlier messages…</div>' : `<div class="ch-start">${avatar(c, 'lg')}<b>${esc(chatName(c))}</b><small>${c.kind === 'group' ? esc(c.topic || 'Group chat') : otherOf(c) === S.me ? 'Notes, links and files for yourself' : esc(user(otherOf(c)).status || 'This is the start of your chat')}</small></div>`) +
      list.map((m, i) => msgHtml(c, m, list[i - 1], m.id === firstNewId, !first && !seen.has(m.cid || m.id))).join('') +
      (S.detached.has(c.id) ? '<div class="ch-loadmore">Loading newer messages…</div>' : '') +
      `<div class="ch-typing" id="chTyping" hidden><span class="ch-dots"><i></i><i></i><i></i></span><small></small></div>`;
    list.forEach((m) => seen.add(m.cid || m.id));
    typingBubble();
    renderPinbar();
  }
  const near = (px = 120) => { const s = $('#chScroll'); return !s || s.scrollHeight - s.scrollTop - s.clientHeight < px; };
  const posIn = (s, el) => el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
  function scrollEnd(force) {
    const s = $('#chScroll'); if (!s) return;
    if (force) {
      // open at the "New messages" line (a third down), otherwise at the newest message;
      // the list scrolls by itself, so the header and the rest of the screen never move
      const nl = force === true && $('#chNewLine');
      const go = () => { s.scrollTop = nl ? Math.max(0, posIn(s, nl) - s.clientHeight * 0.28) : s.scrollHeight; };
      go(); requestAnimationFrame(go);
      // pictures that load later should not push you off the bottom
      s.querySelectorAll('img').forEach((i) => !i.complete && i.addEventListener('load', () => { if (!nl && near(400)) s.scrollTop = s.scrollHeight; }, { once: true }));
    } else if (near()) s.scrollTop = s.scrollHeight;
    markRead();
  }
  function flash(id) {
    const el = root.querySelector(`.ch-msgs [data-id="${id}"]`);
    if (!el) return;
    const s = $('#chScroll'); s.scrollTo({ top: Math.max(0, posIn(s, el) - s.clientHeight / 2 + el.offsetHeight / 2), behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
  }
  async function jump(id) {
    if (S.info && innerWidth <= 760) { S.info = false; renderInfo(); renderHeader(); }
    if (!root.querySelector(`.ch-msgs [data-id="${id}"]`)) await load(S.open, { around: id });
    flash(id);
  }

  // read receipts: mark read when the chat is open, the window is in front and you are at the bottom
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const c = S.chats.get(S.open); if (!c || document.hidden || !near() || S.detached.has(c.id)) return;
      const l = S.msgs.get(c.id) || []; const top = l[l.length - 1]?.id || 0;
      const mine = c.members.find((m) => m.user === S.me);
      if (top && mine && mine.last_read < top) { mine.last_read = top; c.unread = 0; c.mentions = 0; renderList(); badge(); act('read', { chat: c.id, upto: top }).catch(() => {}); }
    }, 300);
  }
  function wireScroll() {
    const s = $('#chScroll');
    for (const ev of ['wheel', 'touchmove', 'keydown']) s.addEventListener(ev, () => (S.userScroll = Date.now()), { passive: true });
    s.onscroll = () => {
      const id = S.open;
      if (s.scrollTop < 80 && S.more.get(id) && !s.dataset.busy) {
        const first = S.msgs.get(id)?.[0]; if (!first) return;
        s.dataset.busy = 1; const h = s.scrollHeight;
        load(id, { before: first.id }).then(() => { s.scrollTop += s.scrollHeight - h; delete s.dataset.busy; });
      }
      if (S.detached.has(id) && s.scrollHeight - s.scrollTop - s.clientHeight < 80 && !s.dataset.busy) {
        const l = S.msgs.get(id); s.dataset.busy = 1;
        load(id, { after: l[l.length - 1].id }).then(() => delete s.dataset.busy);
      }
      // while scrolling, a small glass pill shows the day you are looking at
      let day = '';
      for (const d of s.querySelectorAll('.ch-day')) { const y = posIn(s, d) - s.scrollTop; if (y <= 8) day = d.textContent; else { if (y < 44) day = ''; break; } }  // no double when a date line is right there
      if (Date.now() - (S.userScroll || 0) > 900) day = '';
      const f = $('#chDayF'); f.style.top = s.offsetTop + 8 + 'px'; f.textContent = day; f.hidden = !day; f.classList.add('on'); clearTimeout(f.t); f.t = setTimeout(() => f.classList.remove('on'), 1100);
      const far = s.scrollHeight - s.scrollTop - s.clientHeight > 400 || S.detached.has(id);
      $('#chToBottom').hidden = !far;
      if (!far) $('#chToBottomN').textContent = '';
      markRead();
    };
    $('#chToBottom').onclick = async () => { if (S.detached.has(S.open)) await load(S.open); $('#chScroll').scrollTop = 1e9; };
    $('#chMsgs').onclick = onMsgClick;
    $('#chMsgs').oncontextmenu = (e) => { const row = e.target.closest('.ch-m:not(.pend)'), m = row && findMsg(+row.dataset.id); if (!m || m.deleted || e.target.closest('a,img,video')) return; e.preventDefault(); moreMenu(row.querySelector('.ch-b'), m, true); };
    // drag and drop files onto the conversation
    let dz = 0;
    const main = $('#chMain');
    main.ondragenter = (e) => { if (!S.files || ![...e.dataTransfer.types].includes('Files')) return; dz++; $('#chDrop').hidden = false; };
    main.ondragleave = () => { if (--dz <= 0) { dz = 0; $('#chDrop').hidden = true; } };
    main.ondragover = (e) => e.preventDefault();
    main.ondrop = (e) => { e.preventDefault(); dz = 0; $('#chDrop').hidden = true; if (S.files) addAtt([...e.dataTransfer.files]); };
  }

  // ---------- touch: swipe a chat left (mute, archive) or right (favourite); swipe a message right to reply; hold a message for the menu
  const closeSw = () => { if (S.sw) { setOff(S.sw, 0); S.sw = null; } };
  const setOff = (el, x) => { el.dataset.off = x; el.style.setProperty('--pr', Math.min(1, Math.abs(x) / (x < 0 ? 140 : 80)).toFixed(2)); el.querySelector('.ch-row').style.transform = x ? `translateX(${x}px)` : ''; el.classList.toggle('open', !!x); };
  function wireGestures() {
    let g = null;
    const noClick = () => { S.noClick = true; setTimeout(() => (S.noClick = false), 60); };
    on(root, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' || e.button) return;
      const row = e.target.closest('.ch-sw'), msg = !row && e.target.closest('.ch-m:not(.pend)');
      if (!row && !msg) return;
      if (S.sw && S.sw !== row) { closeSw(); noClick(); }
      g = { el: row || msg, row: !!row, x: e.clientX, y: e.clientY, base: +(row?.dataset.off || 0), moved: false,
        hold: msg && !e.target.closest('a,video,audio,.ch-play,[data-rx]') ? setTimeout(() => { const m = findMsg(+msg.dataset.id); if (!m || m.deleted || !g) return; g = null; noClick(); buzz('medium'); msg.classList.add('held'); setTimeout(() => msg.classList.remove('held'), 300); moreMenu(msg.querySelector('.ch-b'), m, true); }, 430) : 0 };
    }, { passive: true });
    on(root, 'pointermove', (e) => {
      if (!g) return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.moved) {
        if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
        clearTimeout(g.hold);
        if (Math.abs(dy) > Math.abs(dx) || (!g.row && dx < 0)) { g = null; return; }
        g.moved = true; g.el.classList.add('drag');
      }
      if (g.row) { const x = g.base + dx; setOff(g.el, Math.round(x < -140 ? -140 + (x + 140) * 0.3 : x > 80 ? 80 + (x - 80) * 0.3 : x)); }  // a little rubber band past the buttons
      else {
        const x = Math.min(84, dx * 0.55);
        g.el.style.transform = `translateX(${x}px)`; g.el.style.setProperty('--sw', Math.min(1, x / 56));
        if (x >= 56 && !g.hit) { g.hit = true; buzz(); }
      }
    }, { passive: true });
    const end = () => {
      if (!g) return;
      clearTimeout(g.hold);
      const { el, row, moved, hit } = g; g = null;
      if (!moved) return;
      noClick(); el.classList.remove('drag');
      if (row) {
        const x = +el.dataset.off;
        if (x < -60) { setOff(el, -140); S.sw = el; buzz(); } else if (x > 44) { setOff(el, 80); S.sw = el; buzz(); } else { setOff(el, 0); if (S.sw === el) S.sw = null; }
      } else {
        el.style.transform = ''; el.style.removeProperty('--sw');
        const m = findMsg(+el.dataset.id); if (hit && m) setReply(m);
      }
    };
    on(root, 'pointerup', end); on(root, 'pointercancel', end);
  }

  // ---------- clicks inside messages
  function onMsgClick(e) {
    if (S.noClick) return;
    const t = e.target;
    const jumpB = t.closest('[data-jump]'); if (jumpB) return jump(+jumpB.dataset.jump);
    const img = t.closest('.ch-img'); if (img) return lightbox(img.dataset.full, img.alt);
    const play = t.closest('.ch-play'); if (play) return playVoice(play.closest('.ch-voice'));
    const retry = t.closest('[data-retry]'); if (retry) return resend(retry.dataset.retry);
    const row = t.closest('.ch-m'); if (!row) return;
    const m = findMsg(+row.dataset.id); if (!m) return;
    const rx = t.closest('[data-rx]'); if (rx) return act('react', { id: m.id, emoji: rx.dataset.rx }).catch((er) => toast(er.message));
    const tool = t.closest('[data-t]'); if (!tool) return;
    if (tool.dataset.t === 'reply') return setReply(m);
    if (tool.dataset.t === 'react') return reactMenu(tool, m);
    if (tool.dataset.t === 'more') return moreMenu(tool, m);
  }
  const findMsg = (id) => (S.msgs.get(S.open) || []).find((m) => m.id === id);

  function popup(anchor, html, cls = '') {
    closePop();
    const p = document.createElement('div');
    p.className = 'ch-pop ' + cls; p.innerHTML = html;
    root.append(p);
    const r = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect();
    const w = p.offsetWidth, h = p.offsetHeight;
    const hd = $('.ch-main .ch-head')?.getBoundingClientRect(), cp = $('#chComp')?.getBoundingClientRect();
    const top = (hd && hd.height ? hd.bottom : rr.top) - rr.top + 6, bottom = (cp && cp.height ? cp.top : rr.bottom) - rr.top - 6;
    let x = r.left - rr.left + r.width / 2 - w / 2, y = r.top - rr.top - h - 8;
    if (y < top) y = r.bottom - rr.top + 8;  // no room above: below the message
    if (y + h > bottom) y = Math.max(top, bottom - h);  // still too tall: as high as it can go
    x = Math.max(6, Math.min(x, rr.width - w - 6));
    p.style.left = x + 'px'; p.style.top = y + 'px';
    // a tap outside closes the menu, and only closes it: the same tap must not also press what is underneath
    setTimeout(() => on(document, 'pointerdown', (e) => { if (p.isConnected && !p.contains(e.target)) { closePop(); swallowClick(); } }, { once: true }));
    return p;
  }
  const swallowClick = () => {
    const eat = (e) => { e.stopPropagation(); e.preventDefault(); };
    document.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', eat, { capture: true }), 450);
  };
  const closePop = () => { root.querySelectorAll('.ch-pop,.ch-pop-veil').forEach((p) => p.remove()); root.querySelectorAll('.ch-m.focus').forEach((m) => m.classList.remove('focus')); };
  function reactMenu(anchor, m) {
    const p = popup(anchor, QUICK.map((e) => `<button data-e="${e}">${e}</button>`).join('') + `<button data-e="+" class="plus">${svg('plus')}</button>`, 'ch-react');
    p.onclick = (e) => {
      const b = e.target.closest('[data-e]'); if (!b) return;
      if (b.dataset.e === '+') { p.className = 'ch-pop ch-emo-pop'; p.innerHTML = EMOJI.map((x) => `<button data-e="${x}">${x}</button>`).join(''); return; }
      closePop(); buzz(); act('react', { id: m.id, emoji: b.dataset.e }).catch((er) => toast(er.message));
    };
  }
  function moreMenu(anchor, m, withRx) {
    const c = S.chats.get(S.open), mine = m.user === S.me, admin = c.my_role === 'admin' || ['owner', 'admin'].includes(user(S.me).role);
    const items = [
      ['reply', 'Reply'], m.text && ['copy', 'Copy text'], ['fwd', 'Forward'], [m.pinned ? 'unpin' : 'pin', m.pinned ? 'Unpin' : 'Pin'],
      mine && m.text && !m.file?.voice && ['edit', 'Edit'], mine && c.kind === 'group' && ['seen', 'Seen by'], m.file && ['save', 'Download'],
      (mine || admin) && ['trash', 'Delete for everyone', 'danger'],
    ].filter(Boolean);
    const icons = { reply: 'reply', copy: 'copy', fwd: 'fwd', pin: 'pin', unpin: 'pin', edit: 'edit', seen: 'check', save: 'down', trash: 'trash' };
    const rxRow = withRx ? `<div class="ch-menu-rx">${QUICK.map((x) => `<button data-e="${x}">${x}</button>`).join('')}</div>` : '';
    const p = popup(anchor, rxRow + items.map(([k, n, cls]) => `<button data-k="${k}" class="${cls || ''}">${svg(icons[k])}${n}</button>`).join(''), 'ch-menu');
    if (withRx) {
      const v = document.createElement('div'); v.className = 'ch-pop-veil'; v.onclick = closePop;
      $('#chMain')?.append(v); anchor.closest('.ch-m')?.classList.add('focus'); hideEmo();
    }
    p.onclick = (e) => {
      const em = e.target.closest('[data-e]')?.dataset.e;
      if (em) { closePop(); buzz(); return act('react', { id: m.id, emoji: em }).catch((er) => toast(er.message)); }
      const k = e.target.closest('[data-k]')?.dataset.k; if (!k) return;
      closePop();
      if (k === 'reply') setReply(m);
      if (k === 'copy') navigator.clipboard?.writeText(m.text).then(() => toast('Copied'));
      if (k === 'fwd') forward(m);
      if (k === 'pin' || k === 'unpin') tryAct('pin', { id: m.id, on: k === 'pin' }, k === 'pin' ? 'Pinned' : 'Unpinned');
      if (k === 'edit') setEdit(m);
      if (k === 'seen') seenBy(m);
      if (k === 'save') { const a = document.createElement('a'); a.href = fileUrl(m.file.key); a.download = m.file.name; a.target = '_blank'; a.click(); }
      if (k === 'trash') confirmBox('Delete this message for everyone?', 'Delete', () => tryAct('delete', { id: m.id }));
    };
  }
  function seenBy(m) {
    const c = S.chats.get(S.open);
    const seen = c.members.filter((x) => x.user !== S.me && x.last_read >= m.id), not = c.members.filter((x) => x.user !== S.me && x.last_read < m.id);
    modal(`<h3>Seen by</h3>${seen.map((x) => `<div class="ch-person">${uAvatar(x.user, 'sm')}<b>${esc(nameOf(x.user))}</b></div>`).join('') || '<p class="ch-hint">Nobody yet</p>'}
      ${not.length ? `<h4>Not seen yet</h4>${not.map((x) => `<div class="ch-person dim">${uAvatar(x.user, 'sm')}<b>${esc(nameOf(x.user))}</b></div>`).join('')}` : ''}`);
  }

  // ---------- small dialogs
  function modal(html, cls = '') {
    const v = $('#chVeil'); v.hidden = false;
    v.innerHTML = `<div class="ch-modal ${cls}"><div class="ch-grab"></div><button class="gbtn ch-modal-x" title="Close">${svg('x')}</button><div class="ch-mbody">${html}</div></div>`;
    v.onclick = (e) => { if (e.target === v || e.target.closest('.ch-modal-x')) closeModal(); };
    return v.firstElementChild;
  }
  const closeModal = () => { const v = $('#chVeil'); if (v) { v.hidden = true; v.innerHTML = ''; } };
  function confirmBox(text, yes, fn) {
    const m = modal(`<h3>${esc(text)}</h3><div class="ch-acts"><button class="btn" data-n>Cancel</button><button class="btn pri danger" data-y>${esc(yes)}</button></div>`, 'sm');
    m.querySelector('[data-n]').onclick = closeModal;
    m.querySelector('[data-y]').onclick = () => { closeModal(); fn(); };
  }
  // for what cannot be undone: the button works only after typing DELETE
  function typedConfirm(text, yes, fn) {
    const m = modal(`<h3>${esc(text)}</h3><label class="ch-f"><span>Type DELETE to confirm</span><input id="chDelTxt" autocomplete="off" autocapitalize="characters"></label>
      <div class="ch-acts"><button class="btn" data-n>Cancel</button><button class="btn pri danger" data-y disabled>${esc(yes)}</button></div>`, 'sm');
    const inp = m.querySelector('#chDelTxt'), go = m.querySelector('[data-y]');
    inp.oninput = () => (go.disabled = inp.value.trim().toUpperCase() !== 'DELETE');
    m.querySelector('[data-n]').onclick = closeModal;
    go.onclick = () => { const v = inp.value.trim(); closeModal(); fn(v); };
    setTimeout(() => inp.focus(), 50);
  }
  function lightbox(src, name) {
    const v = $('#chVeil'); v.hidden = false;
    v.innerHTML = `<div class="ch-light"><img src="${esc(src)}" alt=""><div class="ch-light-bar"><span>${esc(name)}</span><a class="ch-ib" href="${esc(src)}" download="${esc(name)}" target="_blank">${svg('down')}</a><button class="ch-ib" data-x>${svg('x')}</button></div></div>`;
    v.onclick = (e) => { if (!e.target.closest('a')) closeModal(); };
  }
  function pickPeople(title, exclude, btn, fn, withName) {
    const people = [...S.users.values()].filter((u) => !u.removed && u.id !== S.me && !exclude.includes(u.id)).sort((a, b) => a.name.localeCompare(b.name));
    const m = modal(`<h3>${esc(title)}</h3>${withName ? '<label class="ch-f"><span>Group name</span><input id="chGName" maxlength="60" placeholder="e.g. Sales team"></label>' : ''}
      <label class="ch-search">${svg('search')}<input id="chPQ" placeholder="Search people"></label>
      <div class="ch-pick" id="chPick">${people.map((u) => `<label class="ch-person" data-n="${esc(u.name.toLowerCase())}"><input type="checkbox" value="${u.id}">${uAvatar(u.id, 'sm')}<b>${esc(u.name)}</b><small>${esc(u.status || '')}</small></label>`).join('') || '<p class="ch-hint">No one else has joined yet. Invite people in Settings.</p>'}</div>
      <button class="btn pri" id="chPickGo">${esc(btn)}</button>`);
    m.querySelector('#chPQ').oninput = (e) => m.querySelectorAll('[data-n]').forEach((l) => (l.hidden = !l.dataset.n.includes(e.target.value.toLowerCase())));
    m.querySelector('#chPickGo').onclick = () => fn([...m.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value), m.querySelector('#chGName')?.value);
  }

  // ---------- new chats
  function openNew() {
    const people = [...S.users.values()].filter((u) => !u.removed && u.id !== S.me).sort((a, b) => a.name.localeCompare(b.name));
    const m = modal(`<h3>New chat</h3>
      <button class="ch-person act" id="chNewGroup"><span class="ch-av grp sm">${svg('users')}</span><b>New group</b></button>
      <button class="ch-person act" data-u="${S.me}"><span class="ch-av notes sm">${svg('pin')}</span><b>Notes</b><small>Messages to yourself</small></button>
      <h4>People</h4>
      ${people.map((u) => `<button class="ch-person act" data-u="${u.id}">${uAvatar(u.id, 'sm')}<b>${esc(u.name)}</b><small>${u.online ? 'online' : esc(u.status || '')}</small></button>`).join('') || '<p class="ch-hint">No one else has joined yet. Invite people from Settings.</p>'}`);
    m.querySelector('#chNewGroup').onclick = () => pickPeople('New group', [], 'Create group', async (users, name) => {
      if (!name?.trim()) return toast('Give the group a name');
      const r = await tryAct('chat.group', { name, users }); if (r) { closeModal(); await sync(); openChat(r.chat); }
    }, true);
    m.querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => { closeModal(); dmWith(b.dataset.u); }));
  }
  async function dmWith(uid) {
    const r = await tryAct('chat.dm', { user: uid }); if (!r) return;
    if (!S.chats.has(r.chat)) await sync();
    $('#chQ').value = ''; S.q = ''; renderList(); openChat(r.chat);
  }
  function forward(msg) {
    const list = sorted().filter((c) => !c.archived);
    const m = modal(`<h3>Forward to</h3><div class="ch-pick">${list.map((c) => `<label class="ch-person"><input type="checkbox" value="${c.id}">${avatar(c, 'sm')}<b>${esc(chatName(c))}</b></label>`).join('')}</div><button class="btn pri" id="chFwdGo">Forward</button>`);
    m.querySelector('#chFwdGo').onclick = async () => {
      const to = [...m.querySelectorAll('input:checked')].map((i) => i.value); if (!to.length) return toast('Pick a chat');
      closeModal();
      for (const chat of to) await tryAct('send', { chat, text: msg.text, file: msg.file, fwd: true });
      toast(to.length > 1 ? `Forwarded to ${to.length} chats` : 'Forwarded');
    };
  }

  // ---------- the side panel: details, members, pinned, search in chat
  function renderInfo(tab) {
    const el = $('#chInfo'), c = S.chats.get(S.open);
    el.hidden = !S.info || !c; $('#chApp').classList.toggle('info', !el.hidden);
    if (el.hidden) return;
    const admin = c.my_role === 'admin' || ['owner', 'admin'].includes(user(S.me).role);
    const u = c.kind === 'dm' ? user(otherOf(c)) : null;
    el.innerHTML = `<div class="ch-info-top"><b>${tab === 'search' ? 'Search' : 'Details'}</b><button class="gbtn" id="chInfoX" title="Close">${svg('x')}</button></div>
      <div class="ch-info-body">
      ${tab === 'search' ? `<label class="ch-search">${svg('search')}<input id="chIQ" placeholder="Search in ${esc(chatName(c))}" autocomplete="off"></label><div id="chIHits"><div class="ch-nothing sm"><span>${svg('search')}</span><small>Words, links and file names in this chat.</small></div></div>` : `
      <div class="ch-info-who">${avatar(c, 'xl')}<b>${esc(chatName(c))}</b>
        <small>${c.kind === 'group' ? esc(c.topic || `${c.members.length} member${c.members.length === 1 ? "" : "s"}`) : u.id === S.me ? 'Messages to yourself' : esc(u.status || (u.online ? 'online' : ago(u.last_seen)))}</small>
        ${c.kind === 'group' && admin ? `<button class="tbtn" id="chRename">${svg('edit')}Edit name and description</button>` : ''}</div>
      <div class="ch-info-acts">
        <button data-p="muted">${svg(c.muted ? 'bell' : 'mute')}<span>${c.muted ? 'Unmute' : 'Mute'}</span></button>
        <button data-p="fav">${svg('star')}<span>${c.fav ? 'Unfavourite' : 'Favourite'}</span></button>
        <button data-p="archived">${svg('box')}<span>${c.archived ? 'Unarchive' : 'Archive'}</span></button>
        <button id="chISearch">${svg('search')}<span>Search</span></button>
      </div>
      ${mediaSec(c)}
      <div class="ch-info-sec"><h4>Pinned messages</h4><div id="chIPins"><p class="ch-hint">Loading…</p></div></div>
      ${c.kind === 'group' ? `<div class="ch-info-sec"><h4>${c.members.length} member${c.members.length === 1 ? "" : "s"}</h4>
        ${admin ? `<button class="ch-person act" id="chAdd"><span class="ch-av sm add">${svg('plus')}</span><b>Add people</b></button>` : ''}
        ${c.members.slice().sort((a, b) => (b.role === 'admin') - (a.role === 'admin') || nameOf(a.user).localeCompare(nameOf(b.user))).map((x) => `<div class="ch-person" data-m="${x.user}">${uAvatar(x.user, 'sm')}<b>${esc(nameOf(x.user))}</b><small>${x.role === 'admin' ? 'Group admin' : esc(user(x.user).online ? 'online' : '')}</small>
          ${admin && x.user !== S.me ? `<button class="ch-ib sm" data-mm="${x.user}">${svg('more')}</button>` : ''}</div>`).join('')}
        <button class="ch-person act danger" id="chLeave">${svg('back')}<b>Leave group</b></button></div>` : ''}`}
      </div>`;
    $('#chInfoX').onclick = () => { S.info = false; renderInfo(); renderHeader(); };
    if (tab === 'search') {
      let t; const inp = $('#chIQ'); inp.focus();
      inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
        const q = inp.value.trim(); if (q.length < 2) return;
        try { const r = await api(`search?chat=${c.id}&q=${encodeURIComponent(q)}`); $('#chIHits').innerHTML = r.messages.map((m) => `<button class="ch-hit" data-jump="${m.id}"><small>${esc(nameOf(m.user))} · ${when(m.ts)}</small><span>${mark(preview(m), q)}</span></button>`).join('') || '<p class="ch-hint">No messages found</p>'; } catch (e) { toast(e.message); }
      }, 250); };
      $('#chIHits').onclick = (e) => { const b = e.target.closest('[data-jump]'); if (b) jump(+b.dataset.jump); };
      return;
    }
    el.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => tryAct('chat.prefs', { chat: c.id, [b.dataset.p]: !c[b.dataset.p] })));
    el.querySelectorAll('.ch-thumbs [data-jump], .ch-doc').forEach((b) => (b.onclick = () => jump(+b.dataset.jump)));
    $('#chISearch').onclick = () => renderInfo('search');
    api(`messages?chat=${c.id}&pinned=1`).then((r) => {
      const p = $('#chIPins'); if (!p) return;
      p.innerHTML = r.messages.length ? r.messages.reverse().map((m) => `<button class="ch-hit" data-jump="${m.id}"><small>${esc(nameOf(m.user))} · ${when(m.ts)}</small><span>${preview(m)}</span></button>`).join('') : `<p class="ch-hint">Nothing pinned yet. ${matchMedia('(hover:none)').matches ? 'Press and hold a message' : 'Right-click a message'} to pin it.</p>`;
      p.onclick = (e) => { const b = e.target.closest('[data-jump]'); if (b) jump(+b.dataset.jump); };
    }).catch(() => {});
    $('#chRename')?.addEventListener('click', () => {
      const m = modal(`<h3>Edit group</h3><label class="ch-f"><span>Name</span><input id="chRN" maxlength="60" value="${esc(c.name)}"></label><label class="ch-f"><span>Description</span><input id="chRT" maxlength="200" value="${esc(c.topic)}"></label><button class="btn pri" id="chRGo">Save</button>`, 'sm');
      m.querySelector('#chRGo').onclick = async () => { if (await tryAct('chat.update', { chat: c.id, name: m.querySelector('#chRN').value, topic: m.querySelector('#chRT').value }, 'Saved')) closeModal(); };
    });
    $('#chAdd')?.addEventListener('click', () => pickPeople('Add people', c.members.map((x) => x.user), 'Add', async (users) => { if (users.length && await tryAct('chat.add', { chat: c.id, users })) closeModal(); }));
    $('#chLeave')?.addEventListener('click', () => confirmBox(`Leave “${c.name}”?`, 'Leave', () => tryAct('chat.remove', { chat: c.id, user: S.me })));
    el.querySelectorAll('[data-mm]').forEach((b) => (b.onclick = () => {
      const uid = b.dataset.mm, isAdm = c.members.find((x) => x.user === uid)?.role === 'admin';
      const p = popup(b, `<button data-k="dm">${svg('send')}Message</button><button data-k="role">${svg('star')}${isAdm ? 'Remove as admin' : 'Make group admin'}</button><button data-k="rm" class="danger">${svg('trash')}Remove from group</button>`, 'ch-menu');
      p.onclick = (e) => {
        const k = e.target.closest('[data-k]')?.dataset.k; if (!k) return; closePop();
        if (k === 'dm') dmWith(uid);
        if (k === 'role') tryAct('chat.role', { chat: c.id, user: uid, role: isAdm ? 'member' : 'admin' });
        if (k === 'rm') confirmBox(`Remove ${nameOf(uid)} from the group?`, 'Remove', () => tryAct('chat.remove', { chat: c.id, user: uid }));
      };
    }));
  }

  function mediaSec(c) {
    const list = (S.msgs.get(c.id) || []).filter((m) => m.file && !m.deleted && !m.file.voice).reverse();
    if (!list.length) return '';
    const pics = list.filter((m) => /^image\//.test(m.file.type)).slice(0, 6), docs = list.filter((m) => !/^(image|video)\//.test(m.file.type)).slice(0, 4);
    return `<div class="ch-info-sec"><h4>Photos and files</h4>${pics.length ? `<div class="ch-thumbs">${pics.map((m) => `<button data-jump="${m.id}"><img src="${esc(fileUrl(m.file.key))}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
      ${docs.map((m) => `<button class="ch-hit ch-doc" data-jump="${m.id}">${svg('file')}<span><b>${esc(m.file.name)}</b><small>${size(m.file.size)} · ${when(m.ts)}</small></span></button>`).join('')}</div>`;
  }

  // ---------- settings: profile, notifications, team (invites and people), sign out
  async function openSettings() {
    const me = user(S.me), owner = me.role === 'owner', admin = owner || me.role === 'admin';
    const notif = store.get('shivoChatNotify') ?? true;
    const m = modal(`<h3>Settings</h3>
      <div class="ch-s-head">${uAvatar(S.me, 'md')}<div><b>${esc(me.name)}</b><small>${demo ? 'Demo · sample team' : `${owner ? 'Owner' : me.role === 'admin' ? 'Admin' : 'Member'} · Shivo Labs Chat`}</small></div></div>
      <div class="ch-sub">PROFILE</div>
      <div class="ch-group">
        <label class="ch-srow"><span class="ch-s-ic">${svg('user')}</span><span class="ch-row-l"><b>Name</b><input id="chSN" maxlength="40" value="${esc(me.name)}"></span></label>
        <label class="ch-srow"><span class="ch-s-ic">${svg('smile')}</span><span class="ch-row-l"><b>Status</b><input id="chSS" maxlength="80" value="${esc(me.status || '')}" placeholder="e.g. In the office until 5"></span></label>
        <div class="ch-srow ch-save-row" id="chSRow" hidden><span class="ch-row-l"><small>Your team sees this</small></span><button class="ch-save" id="chSSave">Save</button></div>
      </div>
      <div class="ch-sub">NOTIFICATIONS</div>
      <div class="ch-group"><label class="ch-srow"><span class="ch-s-ic">${svg('bell')}</span><span class="ch-row-l"><b>New messages</b><small>A sound, and a notification when the window is in the background</small></span><input type="checkbox" class="ch-sw" id="chNotify" ${notif ? 'checked' : ''}></label></div>
      ${admin ? `<div class="ch-sub">INVITE PEOPLE</div>
        <div class="ch-group">
          <div class="ch-srow"><span class="ch-s-ic">${svg('key')}</span><span class="ch-row-l"><b>New invite code</b><small>They type it and their name to join</small></span></div>
          <div class="ch-srow ch-inv-new"><span class="seg" id="chIDays"><button data-v="1">1 day</button><button data-v="7" class="on">7 days</button><button data-v="30">30 days</button></span>
            <span class="ch-inv-row"><span class="seg" id="chIUses"><button data-v="1" class="on">1 person</button><button data-v="5">5 people</button><button data-v="20">20 people</button></span><button class="ch-save" id="chINew">Create</button></span></div>
          <div id="chInvites"></div>
        </div>
        <div class="ch-sub">PEOPLE</div><div class="ch-group" id="chPeople">${[...S.users.values()].filter((u) => !u.removed).sort((a, b) => a.name.localeCompare(b.name)).map((u) => `<div class="ch-srow">${uAvatar(u.id, 'sm')}<span class="ch-row-l"><b>${esc(u.name)}${u.id === S.me ? ' (you)' : ''}</b><small>${u.role === 'owner' ? 'Owner' : u.role === 'admin' ? 'Admin' : esc(u.status || 'Member')}</small></span>
          ${u.id !== S.me && u.role !== 'owner' ? `<button class="ch-ib sm" data-pu="${u.id}">${svg('more')}</button>` : ''}</div>`).join('')}</div>` : ''}
      ${demo ? `<div class="ch-sub">DEMO</div>
      <div class="ch-group"><button class="ch-srow" id="chOut"><span class="ch-s-ic">${svg('out')}</span><span class="ch-row-l"><b>Leave the demo</b><small>Set up the real chat with a server and an invite code</small></span>${svg('chev', 'ch-chev')}</button>` : `<div class="ch-sub">THIS DEVICE</div>
      <div class="ch-group">
        <div class="ch-srow"><span class="ch-s-ic">${svg('arrow')}</span><span class="ch-row-l"><b>Server</b><small>${esc(base())}</small></span></div>
        <button class="ch-srow" id="chOut"><span class="ch-s-ic">${svg('out')}</span><span class="ch-row-l"><b>Sign out here</b></span>${svg('chev', 'ch-chev')}</button>
        <button class="ch-srow danger" id="chOutAll"><span class="ch-s-ic">${svg('out')}</span><span class="ch-row-l"><b>Sign out everywhere</b><small>Every device needs a new invite code</small></span>${svg('chev', 'ch-chev')}</button>
      </div>
      <div class="ch-sub">YOUR DATA</div>
      <div class="ch-group">
        ${owner ? `<button class="ch-srow danger" id="chClose"><span class="ch-s-ic">${svg('trash')}</span><span class="ch-row-l"><b>Close the team</b><small>Deletes every message, file and account for everyone. Cannot be undone</small></span>${svg('chev', 'ch-chev')}</button>`
          : `<button class="ch-srow danger" id="chDelMe"><span class="ch-s-ic">${svg('trash')}</span><span class="ch-row-l"><b>Delete my account</b><small>Deletes your messages, files and profile. Cannot be undone</small></span>${svg('chev', 'ch-chev')}</button>`}
      `}
      </div>`, 'wide');
    const segVal = (id) => m.querySelector(`#${id} .on`)?.dataset.v;
    m.querySelectorAll('.seg').forEach((sg) => (sg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); }));
    for (const id of ['#chSN', '#chSS']) m.querySelector(id).oninput = () => (m.querySelector('#chSRow').hidden = false);
    m.querySelector('#chSSave').onclick = async () => { if (await tryAct('profile', { name: m.querySelector('#chSN').value, status: m.querySelector('#chSS').value }, 'Profile saved')) closeModal(); };
    m.querySelector('#chNotify').onchange = (e) => { store.set('shivoChatNotify', e.target.checked); if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission(); };
    m.querySelector('#chOut').onclick = () => demo ? (closeModal(), signedOut()) : confirmBox('Sign out on this device?', 'Sign out', () => { closeModal(); signedOut(); });
    if (m.querySelector('#chOutAll')) m.querySelector('#chOutAll').onclick = () => confirmBox('Sign out on every device? You will need a new invite code to sign in again.', 'Sign out everywhere', async () => { await tryAct('signout'); signedOut(); });
    if (m.querySelector('#chDelMe')) m.querySelector('#chDelMe').onclick = () => typedConfirm('Delete your account? Your messages, photos, files and profile are deleted for everyone. This cannot be undone.', 'Delete my account', async (confirm) => { if (await tryAct('account.delete', { confirm })) signedOut(); });
    if (m.querySelector('#chClose')) m.querySelector('#chClose').onclick = () => typedConfirm('Close the team? Every message, file and account is deleted for everyone, and everyone is signed out. This cannot be undone.', 'Close and delete everything', async (confirm) => { if (await tryAct('team.close', { confirm })) signedOut(); });
    if (!admin) return;
    const showInv = async () => {
      try {
        const r = await api('invites');
        m.querySelector('#chInvites').innerHTML = r.invites.map((i) => `<div class="ch-srow ch-inv"><code>${i.code.slice(0, 4)}-${i.code.slice(4)}</code><small class="ch-row-l">${i.uses} left · until ${new Date(i.expires).toLocaleDateString([], { day: 'numeric', month: 'short' })}</small>
          <button class="ch-ib sm" data-copy="${i.code}" title="Copy">${svg('copy')}</button><button class="ch-ib sm" data-rv="${i.code}" title="Cancel this code">${svg('trash')}</button></div>`).join('');
      } catch (e) { toast(e.message); }
    };
    showInv();
    m.querySelector('#chINew').onclick = async () => { const r = await tryAct('invite.create', { days: segVal('chIDays'), uses: segVal('chIUses') }); if (r) { navigator.clipboard?.writeText(r.code).catch(() => {}); toast(`Invite code ${r.code.slice(0, 4)}-${r.code.slice(4)} copied`); showInv(); } };
    m.querySelector('#chInvites').onclick = async (e) => {
      const cp = e.target.closest('[data-copy]'), rv = e.target.closest('[data-rv]');
      if (cp) navigator.clipboard?.writeText(cp.dataset.copy).then(() => toast('Copied'));
      if (rv && await tryAct('invite.revoke', { code: rv.dataset.rv }, 'Code cancelled')) showInv();
    };
    m.querySelector('#chPeople').onclick = (e) => {
      const b = e.target.closest('[data-pu]'); if (!b) return;
      const u = user(b.dataset.pu);
      const p = popup(b, `${owner ? `<button data-k="role">${svg('star')}${u.role === 'admin' ? 'Remove as admin' : 'Make admin'}</button>` : ''}<button data-k="rm" class="danger">${svg('trash')}Remove from the team</button><button data-k="erase" class="danger">${svg('trash')}Remove and delete their data</button>`, 'ch-menu');
      p.onclick = (ev) => {
        const k = ev.target.closest('[data-k]')?.dataset.k; if (!k) return; closePop();
        if (k === 'role') tryAct('user.role', { user: u.id, role: u.role === 'admin' ? 'member' : 'admin' }, 'Done').then(() => setTimeout(openSettings, 400));
        if (k === 'rm') confirmBox(`Remove ${u.name} from the team? They are signed out and leave every group. Their messages stay.`, 'Remove', () => tryAct('user.remove', { user: u.id }, `${u.name} removed`));
        if (k === 'erase') typedConfirm(`Remove ${u.name} and delete their messages, photos and files for everyone? Use this when they ask for their data to be deleted. This cannot be undone.`, 'Remove and delete', () => tryAct('user.remove', { user: u.id, erase: true }, `${u.name} removed and their data deleted`));
      };
    };
  }

  // ---------- writing: composer, emoji, @mentions, reply/edit, drafts, typing
  const grow = () => { const t = $('#chText'); if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 180) + 'px'; };
  const setSendIcon = () => { const b = $('#chSend'); if (!b) return; const empty = !$('#chText').value.trim() && !S.att.length; b.disabled = empty && !S.edit; b.innerHTML = svg(S.edit ? 'check' : 'send'); b.title = S.edit ? 'Save' : 'Send'; };
  function saveDraft() {
    const d = store.get('shivoChatDrafts') || {}, v = $('#chText')?.value || '';
    if (S.edit) return;
    if (v.trim()) d[S.open] = v; else delete d[S.open];
    store.set('shivoChatDrafts', d);
  }
  function setReply(m) { S.edit = null; S.reply = m; ctxBar(); $('#chText').focus(); }
  function setEdit(m) { S.reply = null; S.edit = m; ctxBar(); const t = $('#chText'); t.value = m.text; grow(); setSendIcon(); t.focus(); }
  function ctxBar() {
    const el = $('#chCtx'), m = S.reply || S.edit; el.hidden = !m;
    if (!m) return setSendIcon();
    el.innerHTML = `${svg(S.edit ? 'edit' : 'reply')}<span><b>${S.edit ? 'Edit message' : `Reply to ${esc(nameOf(m.user))}`}</b>${preview(m)}</span><button class="ch-ib sm" id="chCtxX">${svg('x')}</button>`;
    $('#chCtxX').onclick = clearCtx;
    setSendIcon();
  }
  function clearCtx() { const wasEdit = !!S.edit; S.reply = null; S.edit = null; ctxBar(); if (wasEdit) { $('#chText').value = ''; grow(); setSendIcon(); } }

  function wireComposer() {
    const t = $('#chText');
    t.oninput = () => {
      grow(); setSendIcon(); saveDraft(); mentionCheck();
      if (!t.value.trim()) return typing(false);
      if (Date.now() - typingSent > 3000) typing(true);
      clearTimeout(typingStop); typingStop = setTimeout(() => typing(false), 4000);
    };
    t.onkeydown = (e) => {
      const men = $('#chMention');
      if (!men.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        e.preventDefault();
        const items = [...men.querySelectorAll('button')], i = items.findIndex((b) => b.classList.contains('on'));
        if (e.key === 'Escape') return (men.hidden = true);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { items[i]?.classList.remove('on'); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.classList.add('on'); return; }
        return items[Math.max(i, 0)]?.click();
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      if (e.key === 'Escape') { if (S.reply || S.edit) clearCtx(); hideEmo(); }
      if (e.key === 'ArrowUp' && !t.value) {
        const last = [...(S.msgs.get(S.open) || [])].reverse().find((m) => m.user === S.me && m.kind === 'text' && !m.deleted && m.text && !m.file?.voice);
        if (last) { e.preventDefault(); setEdit(last); }
      }
    };
    t.onpaste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length && S.files) { e.preventDefault(); addAtt(files); } };
    t.onfocus = () => setTimeout(() => { if (near(260)) { const s = $('#chScroll'); if (s) s.scrollTop = s.scrollHeight; } }, 280);  // keyboard opening
    $('#chSend').onclick = send;
    $('#chMic').onclick = startRec;
    $('#chEmoBtn').onclick = () => ($('#chEmo').hidden ? showEmo() : hideEmo());
    $('#chEmoTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) showEmo(b.dataset.tab); };
    $('#chEmoGrid').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; insert(b.textContent); buzz('selection'); const r = [b.textContent, ...(store.get('shivoChatEmoji') || []).filter((x) => x !== b.textContent)].slice(0, 24); store.set('shivoChatEmoji', r); };
    // on the phone, tapping the text box brings the keyboard back instead of the emoji tray
    t.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') hideEmo(); });
    $('#chScroll').addEventListener('pointerdown', hideEmo);
    $('#chAttach').onclick = attachSheet;
    for (const id of ['chFile', 'chPhotos', 'chCamera']) $('#' + id).onchange = (e) => { addAtt([...e.target.files]); e.target.value = ''; };
    $('#chAtt').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; const [a] = S.att.splice(+b.dataset.rm, 1); URL.revokeObjectURL(a.url); renderAtt(); };
    $('#chRecX').onclick = () => stopRec(false);
    $('#chRecGo').onclick = () => stopRec(true);
  }
  function showEmo(tab) {
    const recent = store.get('shivoChatEmoji') || [];
    tab ||= recent.length ? 'recent' : '😀';
    $('#chEmoTabs').innerHTML = (recent.length ? `<button data-tab="recent" class="${tab === 'recent' ? 'on' : ''}" title="Recent">${svg('clock')}</button>` : '') + Object.keys(EMOJI_TABS).map((k) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${k}</button>`).join('');
    $('#chEmoGrid').innerHTML = (tab === 'recent' ? recent : EMOJI_TABS[tab].split(' ')).map((e) => `<button>${e}</button>`).join('');
    $('#chEmoGrid').scrollTop = 0;
    const was = $('#chEmo').hidden; $('#chEmo').hidden = false; $('#chEmoBtn').classList.add('on');
    if (was) { if (matchMedia('(hover:none)').matches) $('#chText').blur(); const s = $('#chScroll'); if (near(200)) requestAnimationFrame(() => (s.scrollTop = s.scrollHeight)); }
  }
  function hideEmo() { const e = $('#chEmo'); if (e && !e.hidden) { e.hidden = true; $('#chEmoBtn')?.classList.remove('on'); } }
  function insert(s) {
    const t = $('#chText'), a = t.selectionStart, b = t.selectionEnd;
    t.value = t.value.slice(0, a) + s + t.value.slice(b); t.selectionStart = t.selectionEnd = a + s.length;
    if (!matchMedia('(hover:none)').matches) t.focus(); grow(); setSendIcon(); saveDraft();  // on the phone the keyboard stays away
  }
  function mentionCheck() {
    const c = S.chats.get(S.open), t = $('#chText'), men = $('#chMention');
    const before = t.value.slice(0, t.selectionStart), m = before.match(/(^|\s)@([^\s@]{0,20})$/);
    if (!c || c.kind !== 'group' || !m) return (men.hidden = true);
    const q = m[2].toLowerCase();
    const list = c.members.map((x) => user(x.user)).filter((u) => u.id !== S.me && u.name.toLowerCase().includes(q)).slice(0, 6);
    if (!list.length) return (men.hidden = true);
    men.hidden = false;
    men.innerHTML = list.map((u, i) => `<button class="${i ? '' : 'on'}" data-n="${esc(u.name)}">${uAvatar(u.id, 'sm')}${esc(u.name)}</button>`).join('');
    men.onclick = (e) => {
      const b = e.target.closest('[data-n]'); if (!b) return;
      const pos = t.selectionStart, start = before.length - m[2].length - 1;
      t.value = t.value.slice(0, start) + '@' + b.dataset.n + ' ' + t.value.slice(pos);
      t.selectionStart = t.selectionEnd = start + b.dataset.n.length + 2;
      men.hidden = true; t.focus(); grow();
    };
  }
  function typing(onNow) {
    if (!ws || ws.readyState !== 1 || !S.open) return;
    if (onNow) typingSent = Date.now(); else { if (!typingSent) return; typingSent = 0; }
    ws.send(JSON.stringify({ t: 'typing', chat: S.open, on: onNow }));
  }
  const typers = (chat) => {
    const m = S.typing.get(chat); if (!m) return '';
    const now = Date.now(), who = [...m].filter(([u, t]) => u !== S.me && now - t < 6000).map(([u]) => user(u).name.split(' ')[0]);
    const c = S.chats.get(chat);
    if (!who.length) return '';
    if (c?.kind === 'dm') return 'typing…';
    return who.length === 1 ? `${who[0]} is typing…` : who.length === 2 ? `${who[0]} and ${who[1]} are typing…` : `${who.length} people are typing…`;
  };

  async function send() {
    const t = $('#chText'), text = t.value.trim(), c = S.chats.get(S.open);
    if (!c) return;
    if (S.edit) {
      const m = S.edit;
      if (text && text !== m.text) await tryAct('edit', { id: m.id, text });
      clearCtx(); return;
    }
    if (S.att.length) {
      const files = S.att.map((a) => a.f); S.att.forEach((a) => URL.revokeObjectURL(a.url)); S.att = []; renderAtt();
      t.value = ''; grow(); typing(false); saveDraft(); buzz();
      return sendFiles(files, text);
    }
    if (!text) return;
    buzz();
    t.value = ''; grow(); setSendIcon(); typing(false);
    const d = store.get('shivoChatDrafts') || {}; delete d[c.id]; store.set('shivoChatDrafts', d);
    const reply = S.reply; S.reply = null; ctxBar();
    await post({ chat: c.id, text, reply: reply?.id, replyMsg: reply });
  }
  // a message shows straight away (with a clock) and is swapped for the saved one when the server answers
  async function post({ chat, text = '', reply, replyMsg, file, local }) {
    const cid = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const p = { id: 9e15 + S.pending.size, cid, chat, user: S.me, ts: Date.now(), kind: 'text', text, file, local, rx: {},
      reply: replyMsg ? { id: replyMsg.id, user: replyMsg.user, text: replyMsg.text, file: replyMsg.file } : null };
    S.pending.set(cid, p);
    if (S.open === chat) { draw(); scrollEnd('bottom'); }
    return deliver(p, reply);
  }
  async function deliver(p, reply) {
    p.failed = false;
    try {
      if (p.upload) { const f = await p.upload(); p.file = f; delete p.upload; }
      const r = await act('send', { chat: p.chat, text: p.text, reply: reply ?? p.reply?.id, file: p.file, cid: p.cid });
      S.pending.delete(p.cid);
      gotMsg(r.m);
    } catch (e) {
      p.failed = true; toast(e.message);
      if (S.open === p.chat) draw();
    }
  }
  const resend = (cid) => { const p = S.pending.get(cid); if (p) { p.failed = false; draw(); deliver(p); } };

  // ---------- files: photos, documents, voice notes
  function attachSheet() {
    const touch = matchMedia('(hover:none)').matches;
    const m = modal(`<h3>Add</h3><div class="ch-tiles">
      <button data-p="chPhotos">${svg('photo')}Photos</button>${touch ? `<button data-p="chCamera">${svg('camera')}Camera</button>` : ''}<button data-p="chFile">${svg('file')}Files</button></div>
      <p class="ch-hint">Photos, videos and any file up to 25 MB. They go with your next message.</p>`, 'sm');
    m.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { closeModal(); $('#' + b.dataset.p).click(); }));
  }
  function addAtt(files) {
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`); continue; }
      if (S.att.length >= 10) { toast('Up to 10 at a time'); break; }
      S.att.push({ f, url: URL.createObjectURL(f) });
    }
    renderAtt(); $('#chText')?.focus({ preventScroll: true });
  }
  function renderAtt() {
    const el = $('#chAtt'); if (!el) return;
    el.hidden = !S.att.length;
    el.innerHTML = S.att.map((a, i) => `<span class="ch-att-t" style="--i:${i}">${/^image\//.test(a.f.type) ? `<img src="${esc(a.url)}" alt="">` : /^video\//.test(a.f.type) ? `<video src="${esc(a.url)}" muted></video>` : `<span class="ch-att-f">${svg('file')}<b>${esc(a.f.name)}</b><small>${size(a.f.size)}</small></span>`}<button data-rm="${i}" title="Remove">${svg('x')}</button></span>`).join('');
    setSendIcon();
  }
  async function measure(file) {
    if (!/^image\//.test(file.type)) return {};
    try { const b = await createImageBitmap(file); const r = { w: b.width, h: b.height }; b.close?.(); return r; } catch { return {}; }
  }
  async function sendFiles(files, caption = '') {
    const c = S.chats.get(S.open); if (!c) return;
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`); continue; }
      const dims = await measure(f);
      const local = URL.createObjectURL(f);
      const meta = { name: f.name, type: f.type || 'application/octet-stream', size: f.size, ...dims, ...(f.voice ? { voice: true, dur: f.dur } : {}) };
      const text = f === files[0] ? caption : '';  // the words go with the first file
      const cid = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const p = { id: 9e15 + S.pending.size, cid, chat: c.id, user: S.me, ts: Date.now(), kind: 'text', text, file: meta, local, rx: {}, reply: S.reply ? { id: S.reply.id, user: S.reply.user, text: S.reply.text } : null };
      S.reply = null; ctxBar();
      p.upload = async () => {
        const up = await api(`files?chat=${c.id}`, { method: 'PUT', raw: true, body: f, headers: { 'content-type': meta.type, 'x-name': encodeURIComponent(f.name) },
          progress: (x) => root.querySelector(`.ch-m[data-cid="${cid}"] .ch-up`)?.style.setProperty('--p', x) });
        return { ...meta, key: up.key };
      };
      S.pending.set(cid, p);
      if (S.open === c.id) { draw(); scrollEnd('bottom'); }
      deliver(p);
    }
  }
  async function startRec() {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Voice messages need a microphone');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Microphone not allowed'); }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((x) => window.MediaRecorder?.isTypeSupported?.(x)) || '';
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined), parts = [], t0 = Date.now();
    rec = { mr, stream, t0, send: false, tick: setInterval(() => { const el = $('#chRecT'); if (el) el.textContent = dur((Date.now() - t0) / 1000); if (Date.now() - t0 > 300e3) stopRec(true); }, 250) };
    mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
    mr.onstop = () => {
      stream.getTracks().forEach((x) => x.stop());
      clearInterval(rec.tick);
      const secs = (Date.now() - t0) / 1000, go = rec.send; rec = null;
      $('#chRec').hidden = true; $('#chBar').hidden = false;
      if (!go || secs < 0.8) return;
      const blob = new Blob(parts, { type: mr.mimeType || 'audio/webm' });
      const f = new File([blob], `Voice ${new Date().toLocaleString().replace(/[/:]/g, '-')}.${/mp4/.test(blob.type) ? 'm4a' : 'webm'}`, { type: blob.type });
      f.voice = true; f.dur = Math.round(secs);
      sendFiles([f]);
    };
    mr.start(250);
    $('#chBar').hidden = true; $('#chRec').hidden = false;
  }
  function stopRec(go) { if (!rec) return; rec.send = go; rec.mr.stop(); }
  let playing = null;
  function playVoice(box) {
    if (playing?.box === box) { playing.a.paused ? playing.a.play() : playing.a.pause(); return; }
    playing?.a.pause();
    const a = new Audio(box.dataset.src), bar = box.querySelector('.ch-wave i'), btn = box.querySelector('.ch-play'), label = box.querySelector('small');
    const orig = label.textContent;
    playing = { a, box };
    a.onplay = () => (btn.innerHTML = svg('pause'));
    a.onpause = () => (btn.innerHTML = svg('play'));
    a.ontimeupdate = () => { if (a.duration && isFinite(a.duration)) { bar.style.width = (a.currentTime / a.duration) * 100 + '%'; label.textContent = dur(a.currentTime); } };
    a.onended = () => { bar.style.width = '0'; label.textContent = orig; btn.innerHTML = svg('play'); playing = null; };
    a.play().catch(() => toast("Couldn't play this voice message"));
  }

  // ---------- live events
  function gotMsg(m) {
    let list = S.msgs.get(m.chat);
    if (list && !S.detached.has(m.chat)) { if (!list.some((x) => x.id === m.id)) list.push(m); }
    const c = S.chats.get(m.chat);
    if (!c) return sync();
    if (!c.last || c.last.id <= m.id) c.last = m;
    const meM = c.members.find((x) => x.user === S.me);
    if (m.user === S.me) { if (meM) meM.last_read = Math.max(meM.last_read, m.id); c.archived = 0; S.drawn.get(m.chat)?.add(m.id); }
    else if (m.kind !== 'system') {
      const looking = S.open === m.chat && !document.hidden && near();
      if (!looking) { c.unread = (c.unread || 0) + 1; if (m.text?.includes('@' + user(S.me).name)) c.mentions = (c.mentions || 0) + 1; notify(c, m); }
      if (!c.muted) c.archived = 0;
      if (S.open === m.chat && !near()) { const n = $('#chToBottomN'); if (n) n.textContent = (+n.textContent || 0) + 1; }
    }
    // the sender stops "typing" when the message lands
    S.typing.get(m.chat)?.delete(m.user);
    if (S.open === m.chat) { const was = near(); draw(); if (was || m.user === S.me) { const s = $('#chScroll'); s.scrollTop = s.scrollHeight; } markRead(); renderHeader(); }
    renderList(); badge();
  }
  function onEvent(ev) {
    if (ev.t === 'msg') { if (ev.cid && S.pending.has(ev.cid)) S.pending.delete(ev.cid); gotMsg(ev.m); }
    else if (ev.t === 'msg.up') {
      const list = S.msgs.get(ev.m.chat), i = list ? list.findIndex((x) => x.id === ev.m.id) : -1;
      if (i >= 0) list[i] = ev.m;
      const c = S.chats.get(ev.m.chat); if (c?.last?.id === ev.m.id) c.last = ev.m;
      if (S.open === ev.m.chat) { const s = $('#chScroll'), top = s?.scrollTop, was = near(); draw(); if (s) s.scrollTop = was ? s.scrollHeight : top; }
      if (S.edit?.id === ev.m.id && ev.m.deleted) clearCtx();
      renderList();
    } else if (ev.t === 'read') {
      const c = S.chats.get(ev.chat), mm = c?.members.find((x) => x.user === ev.user);
      if (mm) mm.last_read = Math.max(mm.last_read, ev.upto);
      if (ev.user === S.me && c) { c.unread = 0; c.mentions = 0; badge(); }
      if (S.open === ev.chat) root.querySelectorAll('.ch-m.mine').forEach((el) => { const m = findMsg(+el.dataset.id); const tk = el.querySelector('.ch-tk'); if (m && tk) tk.outerHTML = ticks(c, m); });
      renderList();
    } else if (ev.t === 'typing') {
      if (!S.typing.has(ev.chat)) S.typing.set(ev.chat, new Map());
      if (ev.on) S.typing.get(ev.chat).set(ev.user, Date.now()); else S.typing.get(ev.chat).delete(ev.user);
      renderList(); if (S.open === ev.chat) renderHeader();
    } else if (ev.t === 'presence') {
      const u = S.users.get(ev.user); if (!u) return;
      u.online = ev.online; if (ev.last_seen) u.last_seen = ev.last_seen;
      renderList(); renderHeader();
    } else if (ev.t === 'resync') sync().catch(() => {});
  }
  function connect() {
    if (!alive || !cfg.token || demo) return;
    clearTimeout(wsTimer);
    const s = new WebSocket(base().replace(/^http/, 'ws') + '/api/ws?t=' + encodeURIComponent(cfg.token));
    ws = s;
    s.onopen = async () => {
      wsTry = 0; $('#chConn') && ($('#chConn').hidden = true);
      clearInterval(pingTimer); pingTimer = setInterval(() => s.readyState === 1 && s.send('{"t":"ping"}'), 25000);
      // after being offline: refresh the list and fetch anything missed in the open chat
      try { await sync(); if (S.open) await catchUp(S.open); } catch {}
    };
    s.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (er) { console.error(er); } };
    s.onclose = (e) => {
      if (ws !== s) return;
      clearInterval(pingTimer);
      if (e.code === 4001) return signedOut();
      if (!alive) return;
      $('#chConn') && ($('#chConn').hidden = false);
      wsTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** wsTry++));
    };
  }

  // ---------- notifications, sound and the unread count in the title
  let audioCtx;
  function ding() {
    try {
      audioCtx ||= new AudioContext();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
      o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.4);
    } catch {}
  }
  function notify(c, m) {
    const mentioned = m.text?.includes('@' + user(S.me).name);
    if ((c.muted && !mentioned) || !(store.get('shivoChatNotify') ?? true)) return;
    ding();
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(c.kind === 'group' ? `${user(m.user).name} in ${chatName(c)}` : chatName(c), { body: preview(m).replace(/<[^>]+>/g, ''), tag: c.id, silent: true });
    n.onclick = () => { window.focus(); openChat(c.id); n.close(); };
  }
  const baseTitle = document.title;
  function badge() {
    const n = [...S.chats.values()].filter((c) => !c.muted).reduce((a, c) => a + (c.unread || 0), 0);
    document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  }

  // ---------- start
  async function start() {
    if (!start.g) { start.g = 1; wireGestures(); }
    if (cfg.demo && !demo) demo = createDemo((ev) => setTimeout(() => onEvent(ev), 0));
    shell();
    try { await sync(); } catch (e) { if (cfg.token) toast(e.message); }
    if (demo) return;
    if (!cfg.token) return;
    connect();
    if ((store.get('shivoChatNotify') ?? true) && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }
  on(document, 'visibilitychange', () => { if (!document.hidden) { markRead(); if (!demo && ws?.readyState !== 1) connect(); } });
  on(window, 'keydown', (e) => { if (e.key === 'Escape') { closePop(); if (!$('#chVeil')?.hidden) closeModal(); } });
  // typing labels fade by themselves if the "stopped" event never comes
  const typingSweep = setInterval(() => { if (S.typing.size) { renderList(); renderHeader(); } }, 5000);
  if (cfg.demo || (cfg.server && cfg.token)) start(); else showSignIn();

  return () => {
    alive = false; clearTimeout(wsTimer); clearInterval(pingTimer); clearInterval(typingSweep); clearTimeout(readTimer);
    try { ws?.close(); } catch {}
    if (rec) stopRec(false);
    playing?.a.pause();
    listeners.forEach((off) => off());
    document.title = baseTitle;
    root.classList.remove('ch-root');
  };
}
