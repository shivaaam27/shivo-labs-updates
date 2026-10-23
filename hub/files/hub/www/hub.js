// Shivo Labs hub: splash, first-run welcome, then the home of module cards (like the phone app).
// A module with a page ("page": true in modules.json) opens inside the hub; the others start their own window.
import { mountFiles } from './modules/files.js';
import { mountXtools } from './modules/xtools.js';
import { mountChat } from '/shared/chat/chat.js';
import { makeAiPage, aiSettings, aiCommand } from './modules/ai.js';
import { mountSettings } from './modules/settings.js';
import { mountMirror } from './modules/mirror.js';
import { mountTv } from './modules/tv.js';
import { mountInsights } from './modules/insights.js';
import { quietStart, quietReload } from './modules/quiet.js';
import { mountOwner } from './modules/owner.js';
import qrcode from '/shared/qrcode.mjs';
const QUIET = quietStart();   // this load follows a quiet update: no splash, no entrance animations
// Chat joins this PC's customer team with its shivo-id pass (null on Shivam's PC: the invite code screen as before)
// Chat's sign-in on this PC, for the AI app's chat tools (hub/api/mcp.mjs): the hub uses the page's own sign-in, since
// signing in again would sign this page out
let chatLinked = '';
const linkChat = () => { try { const c = JSON.parse(localStorage.getItem('shivoChat')) || {}; const v = JSON.stringify({ token: c.demo ? '' : c.token || '', server: c.server || '' }); if (v !== chatLinked) fetch('/api/chat/link', { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: v }).then(() => { chatLinked = v; }, () => {}); } catch {} };
linkChat(); setInterval(linkChat, 30000);
const chatPass = () => fetch('/api/id/chatpass', { method: 'POST', headers: { 'x-hub': '1' } }).then((r) => r.json()).then((j) => j.pass).catch(() => null);
const PAGES = { owner: mountOwner, chat: (el, o) => mountChat(el, { ...o, getPass: chatPass, joinLabel: 'Join with this computer', ai: list.some((m) => m.id === 'ai') ? { info: () => ({ sub: 'Ask anything. Documents, code, your files.', at: 0 }), open: () => o.openModule('ai') } : null }), mirror: mountMirror, files: mountFiles, xtools: mountXtools, tv: mountTv, insights: mountInsights };  // module id -> its screen (modules/<id>.js)

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let list = [], leave = null;
// nothing on the hub's screens can be dragged out of the window (pictures, links, highlighted text); files dragged in
// from Explorer still drop (Cloud, X Tools): those drags start outside the page
document.addEventListener('dragstart', (e) => { const el = e.target.nodeType === 1 ? e.target : e.target.parentElement; if (!el?.closest('[draggable=true],input,textarea')) e.preventDefault(); });

// theme: light, dark or automatic (follows Windows); chosen in Settings
const getTheme = () => store.get('theme') || 'auto';
const dark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { const t = getTheme(); document.documentElement.dataset.theme = t === 'auto' ? (dark.matches ? 'dark' : 'light') : t; };
const setTheme = (t) => { store.set('theme', t); applyTheme(); };
applyTheme(); dark.addEventListener('change', applyTheme);

let toastT;
// act: ['Undo', fn] adds a button and keeps the message a little longer (as on the phone)
function toast(msg, act) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('act', !!act);
  if (act) { const b = document.createElement('button'); b.textContent = act[0]; b.onclick = () => { t.classList.remove('on'); act[1](); }; t.append(b); }
  t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), act ? 6500 : 2800);
}
const icon = (m) => m.mark ? `<span class="mod-ic mark-ic">${shivoMark('loop')}</span>` : `<span class="mod-ic"><svg viewBox="0 0 24 24">${m.icon}</svg></span>`;

// Home, like the phone's (Shivam, 23 Oct 2026): a greeting, one "Search or ask anything" box, the doors (modules),
// then Continue (the team chats you were in). Drawn again only when what it shows has changed, so the doors don't
// replay their entrance every time you come back.
async function renderHome() {
  const hr = new Date().getHours();
  $('#hi').innerHTML = `${hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}.<span>Search or ask anything below.</span>`;
  try { list = await (await fetch('/api/modules')).json(); } catch { toast("Couldn't load the apps"); }
  const state = (m) => !m.installed ? 'Not installed' : '';   // (on: a dot on the door)
  const sig = JSON.stringify(list.map((m) => [m.id, m.name, m.installed, m.running]));
  if (renderHome.sig !== sig) {
    const first = !renderHome.sig; renderHome.sig = sig;
    $('#mods').classList.toggle('seen', !first);
    $('#mods').innerHTML = (list.length ? '' : '<p class="home-empty">Nothing is switched on for this PC yet. Contact Shivo Labs.</p>') + list.map((m, i) => `
      <button class="door${m.installed ? '' : ' off'}" data-id="${esc(m.id)}" style="--i:${i}" title="${esc(m.sub || '')}">${icon(m)}${m.running ? '<i class="door-on" aria-label="On"></i>' : ''}<b>${esc(m.name)}</b>${state(m) ? `<small>${state(m)}</small>` : ''}</button>`).join('');
    document.querySelectorAll('.door[data-id]').forEach((b) => (b.onclick = () => openModule(b.dataset.id)));
  }
  paintContinue();
  if (uiPending) quietReload();   // a screen update arrived while you were in a module: take it now, on the home screen
}

// ---------- team Chat for Home (Continue, and chats in search), read straight from the Chat server with the Chat
// page's own sign-in (the same way the Chat page does); kept a minute
let chatCache = { at: 0, list: [] };
async function teamChats() {
  if (!list.some((m) => m.id === 'chat')) return [];
  if (Date.now() - chatCache.at < 60000) return chatCache.list;
  let c = {}; try { c = JSON.parse(store.get('shivoChat')) || {}; } catch {}
  if (!c.token || c.demo) return [];
  try {
    const r = await fetch((c.server || 'https://shivo-labs-chat.ishivamparmar.workers.dev').replace(/\/+$/, '') + '/api/sync', { headers: { authorization: 'Bearer ' + c.token } });
    if (!r.ok) throw new Error();
    const s = await r.json(), name = (id) => s.users.find((u) => u.id === id)?.name || 'Someone';
    const other = (x) => (x.members || []).find((m) => m.user !== s.me)?.user;
    chatCache = { at: Date.now(), list: (s.chats || []).filter((x) => !x.archived).map((x) => ({ id: x.id, unread: x.unread || 0, at: x.last?.ts || 0,
      title: x.kind !== 'dm' ? x.name || 'Chat' : other(x) ? name(other(x)) : 'Notes to self',
      last: x.last ? (x.last.user === s.me ? 'You: ' : '') + (x.last.text || (x.last.file ? (x.last.file.voice ? 'Voice message' : x.last.file.name || 'File') : '')) : '' }))
      .sort((a, b) => b.at - a.at) };
  } catch { chatCache = { at: Date.now() - 45000, list: chatCache.list }; }
  return chatCache.list;
}
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const CHAT_IC = '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path d="M8.5 9h7M8.5 12.5h4.5"/>';
async function paintContinue() {
  const recent = (await teamChats()).filter((c) => c.at).slice(0, 4);
  const el = $('#cont'); if (!el) return;
  el.innerHTML = recent.length ? `<h4 class="home-h">Continue</h4><div class="home-rows">${recent.map((c) => `<button class="home-row" data-chat="${esc(c.id)}"><span class="mod-ic sm"><svg viewBox="0 0 24 24">${CHAT_IC}</svg></span>
    <span class="home-row-t"><b>${esc(c.title)}</b><small>${esc(c.last)}</small></span>${c.unread ? `<i class="count">${c.unread}</i>` : ''}<small>${ago(c.at)}</small></button>`).join('')}</div>` : '';
  el.querySelectorAll('[data-chat]').forEach((b) => (b.onclick = () => openChatAt(b.dataset.chat)));
}
// opens Chat, then the conversation (its row in Chat's list, once the list is there)
function openChatAt(id) {
  openModule('chat');
  let n = 0;
  const t = setInterval(() => { const r = document.querySelector(`#chList [data-chat="${CSS.escape(id)}"]`); if (r || ++n > 40) { clearInterval(t); r?.click(); } }, 100);
}

// ---------- Search or ask anything: apps, team chats and Cloud files as you type; Enter asks Shivo Labs AI
const hq = $('#hq'), hres = $('#hres');
let hits = [], hl = 0, qSeq = 0, cloudT = 0;
const isUrl = (q) => /^https?:\/\/\S+$/i.test(q) || (!/\s/.test(q) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(q) && /\.[a-z]{2,}(\/|$)/i.test(q));
function paintHits(cloudState = '') {
  paintHits.note = cloudState;
  const q = hq.value.trim();
  if (!q) { hres.hidden = true; hits = []; return; }
  const groups = [];
  let i = 0;
  const row = (h) => { h.i = i++; return `<button class="hr${h.i === hl ? ' hl' : ''}" data-h="${h.i}" role="option">${h.ic}<span class="hr-t"><b>${esc(h.title)}</b>${h.sub ? `<small>${esc(h.sub)}</small>` : ''}</span>${h.key ? `<kbd>${h.key}</kbd>` : ''}</button>`; };
  const top = hits.filter((h) => h.g === 'top'), apps = hits.filter((h) => h.g === 'apps'), chats = hits.filter((h) => h.g === 'chats'), files = hits.filter((h) => h.g === 'files');
  if (top.length) groups.push(top.map(row).join(''));
  if (apps.length) groups.push(`<div class="hr-h">Apps</div>${apps.map(row).join('')}`);
  if (chats.length) groups.push(`<div class="hr-h">Chats</div>${chats.map(row).join('')}`);
  if (files.length || cloudState) groups.push(`<div class="hr-h">Cloud</div>${files.map(row).join('')}${cloudState ? `<p class="hr-note">${esc(cloudState)}</p>` : ''}`);
  hres.innerHTML = groups.join('') || '<p class="hr-note">Nothing found.</p>';
  hres.hidden = false;
  hres.querySelectorAll('[data-h]').forEach((b) => { b.onmousemove = () => { if (hl !== +b.dataset.h) { hl = +b.dataset.h; hres.querySelectorAll('.hr').forEach((x) => x.classList.toggle('hl', x === b)); } }; b.onclick = () => pick(hits[+b.dataset.h]); });
}
async function findAll() {
  const q = hq.value.trim(), ql = q.toLowerCase(), seq = ++qSeq;
  hl = 0; hits = [];
  if (!q) return paintHits();
  const ai = list.find((m) => m.id === 'ai' && m.installed);
  if (isUrl(q)) hits.push({ g: 'top', ic: `<span class="mod-ic sm"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5s1.2-5.9 3.6-8.5z"/></svg></span>`, title: `Open ${q}`, sub: 'In your web browser', key: 'Enter', go: () => window.open(/^https?:/i.test(q) ? q : 'https://' + q, '_blank') });
  if (ai) hits.push({ g: 'top', ic: icon(ai).replace('class="mod-ic', 'class="mod-ic sm'), title: `Ask Shivo Labs AI`, sub: `“${q}”`, key: hits.length ? '' : 'Enter', go: () => openModule('ai', false, { aiAsk: q }) });
  for (const m of list) if (`${m.name} ${m.sub || ''}`.toLowerCase().includes(ql)) hits.push({ g: 'apps', ic: icon(m).replace('class="mod-ic', 'class="mod-ic sm'), title: m.name, sub: m.sub, go: () => openModule(m.id) });
  paintHits();
  const chats = (await teamChats()).filter((c) => c.title.toLowerCase().includes(ql)).slice(0, 4);
  if (seq !== qSeq) return;
  for (const c of chats) hits.push({ g: 'chats', ic: `<span class="mod-ic sm"><svg viewBox="0 0 24 24">${CHAT_IC}</svg></span>`, title: c.title, sub: c.last, go: () => openChatAt(c.id) });
  const cloud = list.some((m) => m.id === 'files') && q.length > 1;
  paintHits(cloud ? 'Looking in your Cloud…' : '');
  if (!cloud) return;
  clearTimeout(cloudT);
  cloudT = setTimeout(async () => {
    let items = null; try { const r = await fetch('/api/files/search?q=' + encodeURIComponent(q)); if (r.ok) items = (await r.json()).items || []; } catch {}
    if (seq !== qSeq) return;
    for (const it of (items || []).slice(0, 6)) hits.push({ g: 'files', ic: `<span class="mod-ic sm">${it.kind === 'folder' ? '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' : `<i class="hr-ext">${esc((it.name.match(/\.([a-z0-9]{1,4})$/i)?.[1] || 'file').toUpperCase())}</i>`}</span>`,
      title: it.name, sub: it.where ? `Cloud › ${it.where}` : 'Cloud', go: () => openModule('files', false, { item: it }) });
    paintHits(items === null ? '' : items.length ? '' : 'No files with that name.');
  }, 280);
}
function pick(h) { if (!h) return; hq.value = ''; hres.hidden = true; hits = []; hq.blur(); h.go(); }
hq.oninput = findAll;
hq.onkeydown = (e) => {
  if (e.key === 'Escape') { hq.value = ''; findAll(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!hits.length) return; e.preventDefault(); hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; paintHits(paintHits.note); hres.querySelector('.hl')?.scrollIntoView({ block: 'nearest' }); return; }
  if (e.key === 'Enter') { e.preventDefault(); pick(hits[hl]); }
};
hq.onfocus = () => { if (hq.value.trim()) hres.hidden = false; };
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#find')) hres.hidden = true; });
// typing anywhere on Home goes into the box
document.addEventListener('keydown', (e) => {
  if ($('#home').hidden || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.target.closest?.('input,textarea,[contenteditable]') || document.querySelector('.ask-veil')) return;
  hq.focus();
});

// start: launch the module's program (its window, or its background engine)
async function start(m, quiet) {
  if (!m.installed) return toast(`${m.name} isn't installed on this PC yet`);
  try {
    const r = await fetch(`/api/open/${encodeURIComponent(m.id)}`, { method: 'POST', headers: { 'x-hub': '1' } });
    if (!r.ok) throw new Error();
    if (!quiet) toast(`Opening ${m.name}…`);
  } catch { toast(`Couldn't open ${m.name}`); }
}

function openModule(id, startEngine, opts = {}) {
  const m = list.find((x) => x.id === id); if (!m) return;
  if (!PAGES[id]) { start(m); setTimeout(renderHome, 2500); return; }
  // the page needs the module's background program: start it if it isn't on
  if (startEngine || (m.installed && m.running === false)) start(m, true).then(() => startEngine && toast(`Starting ${m.name}…`));
  if (startEngine) return;
  leave?.();
  $('#pageIc').outerHTML = icon(m).replace('class="mod-ic', 'id="pageIc" class="mod-ic sm');
  $('#pageName').textContent = m.name;
  $('#pageState').innerHTML = '';
  $('#home').hidden = true; $('#page').hidden = false;
  $('#page').classList.toggle('full', !!m.full);
  $('#page').classList.toggle('own', OWN_HEAD.has(id));
  leave = PAGES[id]($('#pageBody'), { esc, toast, openModule, module: m, startModule: start, goHome, open: opts.item || null });
  // a module may keep its own place after its id (#<module>/<place>); keep it when it is already there
  if (!location.hash.startsWith(`#${id}/`)) history.replaceState(null, '', `#${id}`);
  if (opts.aiSettings && id === 'ai') aiSettings();
  if (opts.aiCmd && id === 'ai') aiCommand(opts.aiCmd);
  if (opts.aiAsk && id === 'ai') aiCommand('ask', { text: opts.aiAsk });   // from Home's search box: a new chat with the question
}
// screens that bring their own title row (the phone's one-header rule): the hub's title steps aside and the Home
// button sits at the start of that row
const OWN_HEAD = new Set(['chat', 'tv']);
function goHome() {
  leave?.(); leave = null;
  $('#page').hidden = true; $('#page').classList.remove('full', 'own'); $('#pageBody').innerHTML = ''; $('#home').hidden = false;
  history.replaceState(null, '', '/');
  renderHome();
}
$('#homeBtn').onclick = goHome;
PAGES.ai = makeAiPage(goHome);
// Settings: a page like a module's, opened from the gear on the home screen
function openSettings() {
  leave?.();
  $('#pageIc').outerHTML = '<span id="pageIc" class="mod-ic sm"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg></span>';
  $('#pageName').textContent = 'Settings';
  $('#pageState').innerHTML = '';
  $('#home').hidden = true; $('#page').hidden = false; $('#page').classList.remove('full', 'own');
  leave = mountSettings($('#pageBody'), { esc, toast, openModule, list, setTheme, getTheme });
  history.replaceState(null, '', '#settings');
}
$('#setOpen').onclick = openSettings;

// splash, then welcome (first time) or home (or straight back into the module you were on)
$('#splashMark').innerHTML = shivoMark('play');
setTimeout(async () => {
  $('#splash').classList.add('out');
  let id = null; try { id = await (await fetch('/api/id')).json(); } catch {}
  if (id?.enrolling) return showJoining();
  if (id?.needCode) return showGate();
  if (id?.fetching?.length) toast('Getting your modules ready…');
  if (!store.get('welcomed')) {
    $('#welcomeMark').innerHTML = shivoMark('play loop');
    $('#welcome').hidden = false;
    $('#startBtn').onclick = () => { store.set('welcomed', '1'); $('#welcome').hidden = true; showHome(); };
  } else showHome();
}, QUIET ? 0 : 1100);
// the first start after Setup: the hub is joining with the code typed in the setup window (offline: it keeps trying)
async function showJoining() {
  $('#gateMark').innerHTML = shivoMark('play loop'); $('#gate').hidden = false;
  $('#gateCode').hidden = true; $('#gateBtn').hidden = true;
  $('#gate .wl-h').innerHTML = 'Setting up<span>Getting your modules ready. This needs the internet.</span>';
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 2000));
    let s = null; try { s = await (await fetch('/api/id', { cache: 'no-store' })).json(); } catch {}   // (the hub restarts once at the end)
    if (s && !s.enrolling) { store.set('welcomed', '1'); location.replace('/'); return; }
    if (s?.error) $('#gateMsg').textContent = s.error;
  }
}
// the invite code (installed copies without a pass): joins this PC, fetches its modules, then the hub restarts
function showGate() {
  $('#gateMark').innerHTML = shivoMark('play loop'); $('#gate').hidden = false;
  const msg = (t, bad) => { $('#gateMsg').textContent = t; $('#gateMsg').classList.toggle('bad', !!bad); };
  const input = $('#gateCode'); input.focus();
  input.oninput = () => { const c = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); input.value = c.length > 5 ? `${c.slice(0, 5)}-${c.slice(5)}` : c; msg(''); };
  // done: the hub restarts with this PC's modules; wait for it, then the home screen
  const started = async (customer) => {
    msg(`Welcome, ${customer}. Starting…`);
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      try { const s = await (await fetch('/api/id', { cache: 'no-store' })).json(); if (!s.needCode) { store.set('welcomed', '1'); location.replace('/'); return; } } catch {}
    }
    location.replace('/');
  };
  // or a phone that is already joined scans the QR and approves this PC (UNIFY-PLAN.md): checked every 3 seconds
  let qrTimer = 0;
  const post = (u) => fetch(u, { method: 'POST', headers: { 'x-hub': '1' } }).then((r) => r.json()).catch(() => null);
  const showQr = async () => {
    const j = await post('/api/id/join');
    if (!j?.link) { $('#gateQr').hidden = true; qrTimer = setTimeout(showQr, 30000); return; }   // offline: try again
    const q = qrcode(0, 'M'); q.addData(j.link); q.make();
    $('#gateQrImg').innerHTML = q.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    $('#gateCheck').textContent = j.check; $('#gateQr').hidden = false;
    const wait = async () => {
      const r = await post('/api/id/join/wait');
      if (r?.ok) { $('#gateQr').hidden = true; $('#gateBtn').disabled = true; msg('Getting your modules ready… this can take a few minutes'); return started(r.customer); }
      qrTimer = setTimeout(r?.expired ? showQr : wait, r?.expired ? 0 : 3000);
    };
    qrTimer = setTimeout(wait, 3000);
  };
  showQr();
  const go = async () => {
    const code = input.value.replace(/[^A-Z0-9]/gi, '');
    if (code.length < 10) return msg('The code has 10 letters and numbers', true);
    clearTimeout(qrTimer); $('#gateQr').hidden = true;
    $('#gateBtn').disabled = true; msg('Getting your modules ready… this can take a few minutes');
    let r = null; try { r = await (await fetch('/api/id/enrol', { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).json(); } catch {}
    if (!r?.ok) { $('#gateBtn').disabled = false; showQr(); return msg(r?.error || "Couldn't reach Shivo Labs. Check the internet and try again", true); }
    started(r.customer);
  };
  $('#gateBtn').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
}
async function showHome() {
  $('#homeMark').innerHTML = shivoMark('play loop'); $('#home').hidden = false;
  await renderHome();
  let back = location.hash.slice(1).split('/')[0]; if (back === 'beam') back = 'files';   // (Beam is part of Shivo Labs Cloud now)
  if (back === 'settings') openSettings(); else if (PAGES[back]) openModule(back);
}
// Screen updates arrive by themselves (the hub installs them as soon as they're published; see api/update.mjs). When
// the version of the screens changes, refresh quietly right away, unless you're using a module at that moment
// (you could be typing): then as soon as you switch to another window or come back to the home screen.
let uiNow = null, uiPending = false;
const idle = () => (!$('#home').hidden && !location.hash.slice(1)) || document.hidden || !document.hasFocus();
async function watchUpdates() {
  let s; try { s = await (await fetch('/api/settings', { cache: 'no-store' })).json(); } catch { return; }
  const ui = s.update?.ui;
  if (!ui) return;
  if (uiNow === null) { uiNow = ui; return; }
  if (ui !== uiNow) { uiPending = true; if (idle()) quietReload(); }
}
watchUpdates(); setInterval(watchUpdates, 5000);
const takeUpdate = () => { if (uiPending && idle()) quietReload(); };
addEventListener('blur', takeUpdate); document.addEventListener('visibilitychange', takeUpdate);

// keep the "On" dots honest when you come back to the window
addEventListener('focus', () => { if (!$('#home').hidden) renderHome(); });

// ---------- "Accept files from an iPhone?": asked by the Beam engine, shown on any hub screen
const asked = new Set();
async function checkAsks() {
  let list = [];
  try { list = await (await fetch('/api/beam/asks')).json(); } catch {}
  if (!Array.isArray(list)) list = [];   // (a PC without Beam in its pass answers 403)
  checkKeyAsks();
  for (const a of list) {
    if (asked.has(a.id)) continue;
    asked.add(a.id);
    const d = document.createElement('div');
    d.className = 'ask-veil';
    d.innerHTML = `<div class="ask card"><div class="ask-mark">${shivoMark('play loop')}</div><h2>Accept files from <span>an iPhone?</span></h2>
      <p>A device on your Wi-Fi (${esc(a.ip)}) wants to send you files. Accept once and it's trusted from now on.</p>
      <div class="ask-acts"><button class="btn" data-ok="0">Decline</button><button class="btn pri" data-ok="1">Accept</button></div></div>`;
    d.onclick = async (e) => {
      const b = e.target.closest('[data-ok]'); if (!b) return;
      d.remove();
      await fetch('/api/beam/answer', { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id, ok: b.dataset.ok === '1' }) }).catch(() => {});
      toast(b.dataset.ok === '1' ? 'iPhone accepted. It can send files now' : 'Declined');
    };
    document.body.append(d);
    window.focus();
  }
}
// "Allow ... to open your Cloud files?": another computer or phone of the company joined Shivo Labs Cloud and needs the key
// (hub/api/files.mjs); allowing seals it so only that computer can open it
let keyAskAt = 0;
async function checkKeyAsks() {
  if (Date.now() - keyAskAt < 8000) return; keyAskAt = Date.now();
  let list = [];
  try { list = await (await fetch('/api/files/asks')).json(); } catch {}
  for (const a of Array.isArray(list) ? list : []) {
    if (asked.has(a.id)) continue;
    asked.add(a.id);
    const d = document.createElement('div');
    d.className = 'ask-veil';
    d.innerHTML = `<div class="ask card"><div class="ask-mark">${shivoMark('play loop')}</div><h2>Allow ${esc(a.name)} <span>to open your Cloud files?</span></h2>
      <p>A new ${a.kind === 'phone' ? 'phone' : 'computer'} of your company joined Shivo Labs Cloud. Allow it only if you know it.</p>
      <div class="ask-acts"><button class="btn" data-ok="0">Don't allow</button><button class="btn pri" data-ok="1">Allow</button></div></div>`;
    d.onclick = async (e) => {
      const b = e.target.closest('[data-ok]'); if (!b) return;
      d.remove();
      const r = await fetch('/api/files/answer', { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id, ok: b.dataset.ok === '1' }) }).catch(() => null);
      toast(!r?.ok ? "Couldn't answer. Check the internet" : b.dataset.ok === '1' ? `${a.name} can open your Cloud files now` : `${a.name} was not allowed`);
    };
    document.body.append(d);
    window.focus();
  }
}
checkAsks(); setInterval(checkAsks, 2000);