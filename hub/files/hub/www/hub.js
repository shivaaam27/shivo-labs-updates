// Shivo Labs hub: splash, first-run welcome, then the home of module cards (like the phone app).
// A module with a page ("page": true in modules.json) opens inside the hub; the others start their own window.
import { mountFiles } from './modules/files.js';
import { mountXtools } from './modules/xtools.js';
import { mountChat } from '/shared/chat/chat.js';
import { makeAiPage, aiSettings, aiCommand } from './modules/ai.js';
import { mountSettings } from './modules/settings.js';
import { mountMirror } from './modules/mirror.js';
import { mountBusiness } from './modules/business.js';
import { mountTv } from './modules/tv.js';
import { quietStart, quietReload } from './modules/quiet.js';
const QUIET = quietStart();   // this load follows a quiet update: no splash, no entrance animations
const PAGES = { business: mountBusiness, chat: mountChat, mirror: mountMirror, files: mountFiles, xtools: mountXtools, tv: mountTv };  // module id -> its screen (modules/<id>.js)

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let list = [], leave = null;

// theme: light, dark or automatic (follows Windows); chosen in Settings
const getTheme = () => store.get('theme') || 'auto';
const dark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { const t = getTheme(); document.documentElement.dataset.theme = t === 'auto' ? (dark.matches ? 'dark' : 'light') : t; };
const setTheme = (t) => { store.set('theme', t); applyTheme(); };
applyTheme(); dark.addEventListener('change', applyTheme);

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }
const icon = (m) => m.mark ? `<span class="mod-ic mark-ic">${shivoMark('loop')}</span>` : `<span class="mod-ic"><svg viewBox="0 0 24 24">${m.icon}</svg></span>`;

async function renderHome() {
  const hr = new Date().getHours();
  $('#hi').innerHTML = `${hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}.<span>What would you like to open?</span>`;
  try { list = await (await fetch('/api/modules')).json(); } catch { toast("Couldn't load the apps"); }
  const state = (m) => !m.installed ? '<span class="state">Not installed</span>' : m.running ? '<span class="state"><i class="dot"></i>On</span>' : '';
  $('#mods').innerHTML = list.map((m, i) => `
    <button class="mod${m.installed ? '' : ' off'}" data-id="${esc(m.id)}" style="--i:${i}">${icon(m)}${state(m)}<b>${esc(m.name)}</b><small>${esc(m.sub)}</small></button>`).join('') +
    `<div class="mod ghost" style="--i:${list.length}"><span class="mod-ic"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><b>More apps</b><small>Coming here next</small></div>`;
  document.querySelectorAll('.mod[data-id]').forEach((b) => (b.onclick = () => openModule(b.dataset.id)));
  // a dot on the Settings button when an update is ready
  fetch('/api/settings').then((r) => r.json()).then((s) => { $('#setDot').hidden = !s.update?.available; }).catch(() => {});
  if (uiPending) quietReload();   // a screen update arrived while you were in a module: take it now, on the home screen
}

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
  leave = PAGES[id]($('#pageBody'), { esc, toast, openModule, module: m, startModule: start, goHome });
  // a module may keep its own place after its id (#business/l/product); keep it when it is already there
  if (!location.hash.startsWith(`#${id}/`)) history.replaceState(null, '', `#${id}`);
  if (opts.aiSettings && id === 'ai') aiSettings();
  if (opts.aiCmd && id === 'ai') aiCommand(opts.aiCmd);
}
function goHome() {
  leave?.(); leave = null;
  $('#page').hidden = true; $('#page').classList.remove('full'); $('#pageBody').innerHTML = ''; $('#home').hidden = false;
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
  $('#home').hidden = true; $('#page').hidden = false; $('#page').classList.remove('full');
  leave = mountSettings($('#pageBody'), { esc, toast, openModule, list, setTheme, getTheme });
  history.replaceState(null, '', '#settings');
}
$('#setOpen').onclick = openSettings;

// splash, then welcome (first time) or home (or straight back into the module you were on)
$('#splashMark').innerHTML = shivoMark('play');
setTimeout(() => {
  $('#splash').classList.add('out');
  if (!store.get('welcomed')) {
    $('#welcomeMark').innerHTML = shivoMark('play loop');
    $('#welcome').hidden = false;
    $('#startBtn').onclick = () => { store.set('welcomed', '1'); $('#welcome').hidden = true; showHome(); };
  } else showHome();
}, QUIET ? 0 : 1100);
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
  try { list = await (await fetch('/api/beam/asks')).json(); } catch { return; }
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
checkAsks(); setInterval(checkAsks, 2000);