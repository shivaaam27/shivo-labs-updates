// TV inside the hub, two tabs:
// - "Your TV": the phone app's own TV screen (phone/www/tv, served by the hub at /phone/). The laptop finds, pairs with
//   and uses a Shivo Labs TV exactly like the phone does: same code, same relay from anywhere, shortcuts, pointer.
// - "Set up a TV" (mountSetup below): puts the Shivo Labs home screen on a new Android / Google TV and manages its apps
//   with Google's adb over Wi-Fi (api/tv.mjs).

const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const I = {
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  home: '<path d="M4 11 12 4l8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
  apps: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  remote: '<rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="9" r="2.2"/><path d="M10 15h4M10 18h4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>', plus: '<path d="M12 5v14M5 12h14"/>', again: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', left: '<path d="m15 6-6 6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', power: '<path d="M12 3v9"/><path d="M6.3 6.6a8 8 0 1 0 11.4 0"/>',
  volup: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>', voldown: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m16 9 5 6M21 9l-5 6"/>', play: '<path d="M6 4v16l7-8z"/><path d="M15 5v14M19 5v14"/>',
  rew: '<path d="M11 6 4 12l7 6zM20 6l-7 6 7 6z"/>', ff: '<path d="m13 6 7 6-7 6zM4 6l7 6-7 6z"/>', input: '<path d="M3 12h11M10 8l4 4-4 4"/><path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  kbd: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
};
const KEY_OF = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Escape: 'back', Backspace: 'back', Home: 'home', ' ': 'play' };

export function mountTv(root, ctx) {
  if (!document.querySelector('link[data-phonetv]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/phone/tv/tv.css'; l.dataset.phonetv = ''; document.head.appendChild(l);
  }
  root.innerHTML = `<div class="tvw"><div id="tvwBody" class="tvw-body"></div></div>`;
  let leaveInner = null, which = null;
  const show = async (w) => {
    if (which === w) return;
    which = w;
    leaveInner?.(); leaveInner = null;
    const body = root.querySelector('#tvwBody'); body.innerHTML = '';
    if (w === 'setup') {
      body.innerHTML = `<button class="tvw-back" id="tvwBack">${svg(I.left)}Your TV</button><div id="tvwSetup"></div>`;
      body.querySelector('#tvwBack').onclick = () => show('your');
      leaveInner = mountSetup(body.querySelector('#tvwSetup'), ctx);
      return;
    }
    try {
      const m = await import('/phone/tv/tv.js');
      if (which !== 'your') return;
      const api = m.mountTv(body, { toast: ctx.toast, haptic: () => {}, setup: () => show('setup') });
      api.start();
      const stopKeys = remoteKeys(body, ctx.toast);
      leaveInner = () => { stopKeys(); api.stop(); };
    } catch (e) { body.innerHTML = `<p class="tv-none">The TV screen couldn't load (${ctx.esc(e.message)}).</p>`; }
  };
  show('your');
  return () => { leaveInner?.(); };
}

// The remote (phone/www/tv/remote.js, the same as the phone's) with the PC's keyboard: arrows and Enter press the touch
// surface as a tap on that side or in the middle would, Backspace or Esc is Back, Home is the TV button, Space plays or
// pauses, + and - (or the volume keys) change the volume, M mutes. Only while the remote is on screen and nothing is typed.
const PADKEY = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], Enter: [0, 0] };
function remoteKeys(body, toast) {
  const q = (s) => body.querySelector(s);
  const press = (el) => { if (!el) return false; el.click(); return true; };
  const tap = (dx, dy) => {
    const sf = q('#rcSurface'); if (!sf) return false;
    const r = sf.getBoundingClientRect(), o = { bubbles: true, pointerId: 41, isPrimary: true,
      clientX: r.left + r.width / 2 + dx * r.width * 0.38, clientY: r.top + r.height / 2 + dy * r.height * 0.38 };
    sf.dispatchEvent(new PointerEvent('pointerdown', o)); sf.dispatchEvent(new PointerEvent('pointerup', o));
    return true;
  };
  const vol = (v) => { const b = q(`[data-v="${v}"]`); if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return true; };
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !q('.tvr') || e.target.closest?.('input,textarea,select,[contenteditable]')) return;
    if (document.querySelector('.tvf-sheet, .xt-veil:not([hidden]), .ask-veil') || q('#tvwSetup')) return;
    const k = e.key;
    const done = PADKEY[k] ? tap(...PADKEY[k])
      : k === 'Backspace' || k === 'Escape' || k === 'BrowserBack' ? press(q('[data-k="back"]'))
      : k === 'Home' ? press(q('[data-k="home"]'))
      : k === ' ' || k === 'MediaPlayPause' ? press(q('[data-k="playPause"]'))
      : k === '+' || k === '=' || k === 'AudioVolumeUp' ? vol(1)
      : k === '-' || k === '_' || k === 'AudioVolumeDown' ? vol(-1)
      : k === 'm' || k === 'M' || k === 'AudioVolumeMute' ? press(q('[data-x="mute"]')) : false;
    if (done) e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  // once: say so the first time the remote is on screen
  const hint = setInterval(() => {
    if (!q('.tvr')) return;
    clearInterval(hint);
    try { if (localStorage.getItem('tv.keysHint')) return; localStorage.setItem('tv.keysHint', '1'); } catch { return; }
    toast('Your keyboard works too: arrows, Enter, Backspace, + and −');
  }, 1000);
  return () => { document.removeEventListener('keydown', onKey); clearInterval(hint); };
}

// Set up a TV: find Android / Google TVs, put the Shivo Labs home screen on them, manage their apps (adb over Wi-Fi)
function mountSetup(root, { esc, toast }) {
  const $ = (s, el = root) => el.querySelector(s);
  const get = async (p) => (await fetch('/api/tv/' + p, { cache: 'no-store' })).json();
  const post = async (p, body) => (await fetch('/api/tv/' + p, { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  const st = { tvs: [], adb: {}, ip: localStorage.getItem('tv.ip') || '', tab: localStorage.getItem('tv.tab') || 'home', conn: null, apps: null, filter: '', shot: 0 };
  let alive = true, timer = null, shotTimer = null;
  // what each TV showed the last time it answered: with no connection the screen still opens and can be looked through
  const readCache = (ip) => { try { return JSON.parse(localStorage.getItem('tv.cache') || '{}')[ip] || null; } catch { return null; } };
  const writeCache = (ip, part) => { try { const all = JSON.parse(localStorage.getItem('tv.cache') || '{}'); all[ip] = { ...(all[ip] || {}), ...part }; localStorage.setItem('tv.cache', JSON.stringify(all)); } catch {} };
  const live = () => st.conn?.state === 'device';

  root.innerHTML = `<div class="tv">
      <aside class="tv-side">
        <div class="tv-side-h"><b>TVs on your Wi-Fi</b><button class="tbtn" id="tvFind">${svg(I.again)}Look again</button></div>
        <div id="tvList" class="tv-list"></div>
        <form class="tv-add" id="tvAdd"><input id="tvAddIp" placeholder="Add by address, like 192.168.1.20" inputmode="decimal" autocomplete="off"><button class="btn sm" title="Add">${svg(I.plus)}</button></form>
      </aside>
      <section class="tv-main" id="tvMain"></section>
    </div>
    <div class="xt-veil" id="tvVeil" hidden><div class="xt-dialog card" id="tvDialog"></div></div>`;

  // ---------- small dialog: ask before anything that changes the TV
  function confirmBox(title, body, yes, danger) {
    return new Promise((done) => {
      $('#tvDialog').innerHTML = `<h2>${esc(title)}</h2><p>${body}</p><div class="tv-dlg-acts"><button class="btn sm" data-a="0">Cancel</button><button class="btn sm pri${danger ? ' warn' : ''}" data-a="1">${esc(yes)}</button></div>`;
      $('#tvVeil').hidden = false;
      $('#tvDialog').querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => { $('#tvVeil').hidden = true; done(b.dataset.a === '1'); }));
      $('#tvDialog [data-a="1"]').focus();
    });
  }

  // ---------- the list of TVs
  async function loadStatus() {
    let s; try { s = await get('status'); } catch { return; }
    if (!alive) return;
    st.tvs = s.tvs || []; st.adb = s.adb || {}; st.apk = s.apk; st.latest = s.latest; st.scanning = s.scanning;
    if (!st.ip && st.tvs.length) select(st.tvs[0].ip, true);
    paintList();
    if (!st.adb.ready && !st.adb.busy && !st.adb.error) post('adb');
  }
  function paintList() {
    const list = st.tvs.map((t) => `<button class="tv-item${t.ip === st.ip ? ' on' : ''}" data-ip="${esc(t.ip)}">
        <span class="mod-ic sm">${svg(I.tv)}</span><span class="tv-item-t"><b>${esc(t.name || t.ip)}</b><small>${esc([t.maker, t.model].filter(Boolean).join(' ') || 'Android TV')} · ${esc(t.ip)}</small></span>
        <i class="dot${t.online === false ? ' wait' : ''}" title="${t.online === false ? 'Not answering (off or asleep)' : 'On the Wi-Fi'}"></i></button>`).join('');
    $('#tvList').innerHTML = list || `<p class="tv-none">${st.scanning ? 'Looking…' : 'No Android TV found yet. The TV must be on and on the same Wi-Fi as this PC.'}</p>`;
    $('#tvList').querySelectorAll('[data-ip]').forEach((b) => (b.onclick = () => select(b.dataset.ip)));
    $('#tvFind').disabled = !!st.scanning;
  }
  $('#tvFind').onclick = async () => { st.scanning = true; paintList(); await post('find'); loadStatus(); };
  $('#tvAdd').onsubmit = async (e) => {
    e.preventDefault();
    const ip = $('#tvAddIp').value.trim();
    const r = await post('add', { ip });
    if (!r.ok) return toast(r.error || 'No TV there');
    $('#tvAddIp').value = ''; await loadStatus(); select(ip);
  };

  function select(ip, quiet) {
    if (st.ip !== ip) { st.apps = null; st.conn = null; }
    st.ip = ip; localStorage.setItem('tv.ip', ip);
    paintList();
    if (!quiet || !st.conn) checkTv();
  }
  const current = () => st.tvs.find((t) => t.ip === st.ip) || { ip: st.ip, name: st.ip };

  // ---------- one TV: connect, then the tabs
  async function checkTv() {
    if (!st.ip) return paintMain();
    if (!st.conn) paintMain();
    let r; try { r = await get('info?ip=' + encodeURIComponent(st.ip)); } catch { r = { state: 'error' }; }
    if (!alive) return;
    const was = st.conn?.state;
    st.conn = r;
    if (r.state === 'device') { writeCache(st.ip, { conn: { maker: r.maker, model: r.model, android: r.android, home: r.home } }); if (was !== 'device') st.apps = null; }
    if (was !== undefined && was === r.state && r.state !== 'device') return;   // same answer: leave the screen (and anything being typed) alone
    paintMain();
  }
  function paintBar() {
    const pill = document.getElementById('pageState');
    if (!pill) return;
    const s = st.conn?.state;
    pill.innerHTML = !st.ip ? '' : `<i class="dot${s === 'device' ? '' : ' wait'}"></i>${esc(current().name)}${s === 'device' ? '' : s === 'unauthorized' ? ' · waiting for OK on the TV' : ' · not connected'}`;
  }
  function paintMain() {
    paintBar();
    const m = $('#tvMain');
    if (!st.ip) return (m.innerHTML = `<div class="card tv-empty"><span class="mod-ic">${svg(I.tv)}</span><h2>Find your TV</h2><p>Turn the TV on. It needs to be on the same Wi-Fi as this PC. It shows up on the left within a few seconds.</p><p class="tv-fine">Works with Android TV and Google TV (TCL, Sony, Philips, Hisense, Xiaomi, Chromecast with Google TV and others).</p></div>`);
    const c = st.conn;
    if (!c) return (m.innerHTML = `<div class="card tv-empty"><div class="xt-mark">${shivoMark('loop')}</div><p>Connecting to ${esc(current().name)}…</p></div>`);
    // not connected: with something remembered, the same screen opens from it (nothing can be changed), under the reason
    const mem = !live() && readCache(st.ip)?.conn;
    if (!live() && !mem) return (m.innerHTML = connectHelp(c.state));
    const k = live() ? c : mem;
    const h = k.home || {};
    m.innerHTML = (live() ? '' : `<div class="tv-off">${connectHelp(c.state)}<p class="tv-fine">Showing what ${esc(current().name)} had the last time it was connected.</p></div>`) + `<div class="tv-head card">
        <span class="mod-ic">${svg(I.tv)}</span>
        <div class="tv-head-t"><b>${esc(current().name)}</b><small>${esc([k.maker, k.model].filter(Boolean).join(' '))}${k.android ? ` · Android ${esc(k.android)}` : ''}</small></div>
        <div class="seg" id="tvTabs">${[['home', 'Home screen', I.home], ['apps', 'Apps', I.apps], ['remote', 'Remote', I.remote]].map(([id, label, ic]) => `<button data-t="${id}" class="${st.tab === id ? 'on' : ''}">${svg(ic)}${label}</button>`).join('')}</div>
      </div>
      <div id="tvTab"${live() ? '' : ' class="tv-frozen"'}></div>`;
    m.querySelectorAll('#tvTabs [data-t]').forEach((b) => (b.onclick = () => { st.tab = b.dataset.t; localStorage.setItem('tv.tab', st.tab); paintMain(); }));
    stopShots();
    if (st.tab === 'home') paintHome(h);
    if (st.tab === 'apps') paintApps();
    if (st.tab === 'remote') paintRemote();
    if (!live()) $('#tvTab').querySelectorAll('button,input:not(#tvQ)').forEach((el) => (el.disabled = true));
  }
  function connectHelp(state) {
    const name = esc(current().name);
    const retry = `<button class="btn sm pri" id="tvRetry">Try again</button>`;
    let body;
    if (state === 'noadb') body = st.adb.error
      ? `<h2>Couldn't get the TV tool</h2><p>${esc(st.adb.error)}</p><p>Check this PC is online, then try again.</p>${retry}`
      : `<div class="xt-mark">${shivoMark('loop')}</div><h2>Getting ready</h2><p>Downloading Google's TV tool (adb, about 8 MB). Only the first time.</p>`;
    else if (state === 'unauthorized') body = `<h2>Say OK on the TV</h2><p>${name} is asking <b>"Allow USB debugging?"</b>. Tick <b>Always allow from this computer</b> and press <b>OK</b> on the remote.</p><p class="tv-fine">Don't see it? Press Home on the remote, then try again.</p>${retry}`;
    else if (state === 'pair') body = `<h2>Pair with the code on the TV</h2><p>On ${name}: <b>Developer options › Wireless debugging › Pair device with pairing code</b>. Type the 6 numbers it shows:</p>
        <form class="tv-pair" id="tvPair"><input id="tvCode" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off"><button class="btn sm pri">Pair</button></form>
        <p class="tv-fine">Keep the code on the TV's screen until this says it's paired. Only the first time on this PC.</p>`;
    else if (state === 'closed') body = `<h2>One step on the TV, once</h2><p>${name} is on the Wi-Fi but doesn't let this PC in yet. On the TV:</p>
        <ol><li><b>Settings › System › About</b> (on some TVs: Device Preferences › About).</li><li>Press OK on <b>Android TV OS build</b> (or Build) 7 times until it says you're a developer.</li><li>Back to <b>System › Developer options</b>. Switch on <b>Wireless debugging</b> (Google TV and newer TVs). Older TVs only have <b>USB debugging</b>: switch that on.</li></ol>
        <p class="tv-fine">This only lets this PC talk to the TV. You can switch it off again any time.</p>${retry}`;
    else body = `<h2>${name} isn't answering</h2><p>It may be off or asleep. Turn it on with its remote, then try again.</p>${retry}`;
    setTimeout(() => {
      const b = $('#tvRetry'); if (b) b.onclick = () => { st.conn = null; post('adb'); checkTv(); };
      const f = $('#tvPair');
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Pairing…';
        const r = await post('pair', { ip: st.ip, code: $('#tvCode').value.trim() });
        if (!r.ok) { btn.disabled = false; btn.textContent = 'Pair'; return toast(r.error || 'Pairing failed'); }
        toast('Paired'); st.conn = null; checkTv();
      };
    });
    return `<div class="card tv-empty">${body}</div>`;
  }

  // ---------- tab: home screen
  function paintHome(h) {
    const old = h.installed && h.latest && h.code < h.latest;
    const state = !h.installed ? 'Not on this TV yet.' : h.active ? 'Installed, and it is the home screen.' : 'Installed, but the TV still opens its own home screen.';
    $('#tvTab').innerHTML = `<div class="tv-home">
      <div class="tv-hero card"><div class="tv-hero-pic">${heroPic()}</div>
        <div class="tv-hero-t"><h2>Shivo Labs home screen</h2><p>A clean home screen for the TV: <b>Continue watching</b>, recent apps, your favourites and every app, in the Shivo Labs look. No ads, no suggestions.</p>
          <p class="tv-state"><i class="dot${h.active ? '' : ' wait'}"></i>${state}${h.installed ? ` <small>Version ${h.code}${old ? ` · a newer one (${h.latest}) is ready` : ''}</small>` : ''}</p>
          <div class="tv-acts">
            ${!h.installed || old ? `<button class="btn sm pri" data-h="install"${st.apk ? '' : ' disabled'}>${h.installed ? 'Update' : 'Put it on the TV'}</button>` : ''}
            ${h.installed && !h.active ? `<button class="btn sm pri" data-h="make">Make it the home screen</button>` : ''}
            ${h.installed && (h.active || h.stockOff) ? `<button class="btn sm" data-h="undo">Bring back the TV's own home screen</button>` : ''}
          </div>
          ${st.apk ? '' : '<p class="tv-fine">The home screen app isn\'t on this PC yet (build it with tv\\home\\build.ps1).</p>'}
        </div></div>
      <div class="tv-tips card"><b>On the TV</b><ul><li>Arrows move, OK opens.</li><li><b>Hold OK</b> on an app to pin it to Favourites, move it, or uninstall it.</li><li>Home on the remote always comes back here.</li></ul></div>
    </div>`;
    $('#tvTab').querySelectorAll('[data-h]').forEach((b) => (b.onclick = () => homeDo(b.dataset.h, b)));
  }
  const heroPic = () => `<div class="tv-mock"><div class="tv-mock-top"><span class="tv-mock-mk">${shivoMark()}</span><span class="tv-mock-clock">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    <div class="tv-mock-row wide"><i></i><i></i><i></i></div><div class="tv-mock-row"><i></i><i></i><i></i><i></i><i></i></div><div class="tv-mock-row"><i></i><i></i><i></i><i></i><i></i></div></div>`;
  async function homeDo(what, btn) {
    if (what === 'make' && !(await confirmBox('Make it the home screen?', `The TV's own home screen is switched off (not removed) and Home on the remote opens Shivo Labs. You can bring it back here any time.`, 'Make it the home screen'))) return;
    if (what === 'undo' && !(await confirmBox('Bring back the TV\'s own home screen?', 'The Shivo Labs home screen stays installed; the TV just opens its own one again.', 'Bring it back'))) return;
    btn.disabled = true; btn.textContent = what === 'install' ? 'Putting it on the TV…' : 'Working…';
    const r = await post('home', { ip: st.ip, do: what });
    toast(r.ok ? (what === 'install' ? 'Installed on the TV' : what === 'make' ? 'Shivo Labs is now the home screen' : 'The TV\'s own home screen is back') : (r.error || 'That didn\'t work'));
    if (r.ok && what === 'install' && !st.conn.home?.active && await confirmBox('Make it the home screen now?', 'Installed. Make Shivo Labs open when Home is pressed? The TV\'s own home screen is switched off, not removed.', 'Yes, make it home')) {
      await post('home', { ip: st.ip, do: 'make' });
    }
    checkTv();
  }

  // ---------- tab: apps
  async function paintApps() {
    $('#tvTab').innerHTML = `<div class="tv-apps card"><div class="tv-apps-top"><label class="tv-search">${svg(I.search)}<input id="tvQ" placeholder="Find an app" value="${esc(st.filter)}"></label><span class="tv-count" id="tvCount"></span></div><div id="tvAppList"><div class="tv-loading"><div class="xt-mark">${shivoMark('loop')}</div><p>Reading the TV's apps…</p></div></div></div>`;
    $('#tvQ').oninput = (e) => { st.filter = e.target.value; paintAppList(); };
    if (!st.apps && !live()) st.apps = readCache(st.ip)?.apps || [];
    else if (!st.apps) {
      try { st.apps = (await get('apps?ip=' + encodeURIComponent(st.ip))).apps || []; writeCache(st.ip, { apps: st.apps }); } catch { st.apps = []; }
    }
    if (alive && st.tab === 'apps') paintAppList();
  }
  function paintAppList() {
    const box = $('#tvAppList');
    if (!box || !st.apps) return;
    const f = st.filter.trim().toLowerCase();
    const match = (a) => !f || a.label.toLowerCase().includes(f) || a.pkg.includes(f);
    const groups = [
      ['Apps you can open', st.apps.filter((a) => a.on && !a.keep && (a.open || !a.system))],
      ['Switched off', st.apps.filter((a) => !a.on)],
      ['Parts of the TV', st.apps.filter((a) => a.on && a.keep)],
    ];
    const named = st.apps.some((a) => a.named);
    $('#tvCount').textContent = st.apps.length ? `${st.apps.length} on the TV` : '';
    box.innerHTML = (named ? '' : `<p class="tv-fine tv-note">Put the Shivo Labs home screen on the TV to see every app's real name and icon, and to manage apps that came with the TV.</p>`) +
      groups.map(([title, list], gi) => {
        const shown = list.filter(match);
        if (!shown.length) return '';
        const rows = shown.map((a) => appRow(a)).join('');
        return gi === 2 ? `<details class="tv-group"><summary>${title} <small>${shown.length} · kept on, the TV needs them</small></summary>${rows}</details>`
          : `<div class="tv-group"><h3>${title} <small>${shown.length}</small></h3>${rows}</div>`;
      }).join('') || `<p class="tv-none">${st.apps.length ? 'No app matches.' : live() ? 'No apps.' : 'The apps show here once the TV has been connected.'}</p>`;
    box.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => appDo(b.dataset.pkg, b.dataset.do, b); b.disabled = !live(); });
  }
  function appRow(a) {
    const acts = [];
    if (a.on && a.open !== false && !(a.system && a.open === null)) acts.push(['open', 'Open']);
    if (!a.on) acts.push(['on', 'Switch on']);
    else if (!a.system) acts.push(['uninstall', 'Uninstall', 'warn']);
    else if (!a.keep) acts.push(['off', 'Switch off', 'warn']);
    return `<div class="tv-app"><img src="/api/tv/icon?ip=${encodeURIComponent(st.ip)}&pkg=${encodeURIComponent(a.pkg)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'tv-app-ic'}))">
      <span class="tv-app-t"><b>${esc(a.label)}</b><small>${esc(a.pkg)}${a.system ? ' · came with the TV' : ''}</small></span>
      <span class="tv-app-acts">${acts.map(([d, l, c]) => `<button class="btn sm${c ? ' ' + c : ''}" data-do="${d}" data-pkg="${esc(a.pkg)}">${l}</button>`).join('')}</span></div>`;
  }
  async function appDo(pkg, what, btn) {
    const a = st.apps.find((x) => x.pkg === pkg);
    if (what === 'off' && !(await confirmBox(`Switch off ${a.label}?`, `It disappears from the TV and stops running. Nothing is deleted: it comes back with <b>Switch on</b> under "Switched off".`, 'Switch off', true))) return;
    if (what === 'uninstall' && !(await confirmBox(`Uninstall ${a.label}?`, 'The app and its data are removed from the TV. You can install it again from the Play Store.', 'Uninstall', true))) return;
    btn.disabled = true;
    const r = await post('app', { ip: st.ip, pkg, do: what });
    if (!r.ok) { btn.disabled = false; return toast(r.error || 'That didn\'t work'); }
    if (what === 'open') return toast(`Opening ${a.label} on the TV`);
    if (what === 'uninstall') st.apps = st.apps.filter((x) => x.pkg !== pkg);
    else a.on = what === 'on';
    toast(what === 'off' ? `${a.label} is switched off` : what === 'on' ? `${a.label} is back` : `${a.label} is uninstalled`);
    paintAppList();
  }

  // ---------- tab: remote, with the TV's picture
  function paintRemote() {
    const k = (key, ic, label, cls = '') => `<button class="rk ${cls}" data-k="${key}" title="${label}">${ic ? svg(ic) : ''}${ic ? '' : label}</button>`;
    $('#tvTab').innerHTML = `<div class="tv-remote">
      <div class="tv-screen card"><img id="tvShot" alt=""><p id="tvShotNote" class="tv-fine">Loading the TV's picture…</p></div>
      <div class="tv-pad card">
        <div class="rk-row">${k('power', I.power, 'Power', 'red')}<span class="sp"></span>${k('input', I.input, 'Input')}${k('settings', I.gear, 'Settings')}</div>
        <div class="dpad">${k('up', I.up, 'Up', 'u')}${k('left', I.left, 'Left', 'l')}${k('ok', '', 'OK', 'c')}${k('right', I.right, 'Right', 'r')}${k('down', I.down, 'Down', 'd')}</div>
        <div class="rk-row">${k('back', I.back, 'Back')}${k('home', I.home, 'Home')}${k('apps', I.apps, 'All apps')}</div>
        <div class="rk-row">${k('rew', I.rew, 'Rewind')}${k('play', I.play, 'Play / pause')}${k('ff', I.ff, 'Forward')}</div>
        <div class="rk-row">${k('voldown', I.voldown, 'Volume down')}${k('mute', I.mute, 'Mute')}${k('volup', I.volup, 'Volume up')}</div>
        <form class="tv-type" id="tvType"><span>${svg(I.kbd)}</span><input id="tvText" placeholder="Type on the TV" autocomplete="off"><button class="btn sm">Send</button></form>
        <p class="tv-fine">Your keyboard works too: arrows, Enter, Esc for back, Space to play or pause.</p>
      </div></div>`;
    $('#tvTab').querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => key(b.dataset.k, b)));
    $('#tvType').onsubmit = async (e) => { e.preventDefault(); const t = $('#tvText').value; if (!t) return; await post('key', { ip: st.ip, text: t }); $('#tvText').value = ''; shotSoon(); };
    if (live()) startShots(); else $('#tvShotNote').textContent = 'Not connected, so no picture.';
  }
  async function key(k, btn) {
    btn?.classList.add('hit'); setTimeout(() => btn?.classList.remove('hit'), 160);
    await post('key', { ip: st.ip, key: k });
    shotSoon();
  }
  const onKey = (e) => {
    if (st.tab !== 'remote' || st.conn?.state !== 'device' || !$('#tvVeil').hidden) return;
    if (e.target.closest?.('input,textarea')) return;
    const k = KEY_OF[e.key];
    if (!k) return;
    e.preventDefault();
    key(k, $(`[data-k="${k}"]`));
  };
  document.addEventListener('keydown', onKey);
  // the picture: after each key, and every few seconds while the remote is open
  async function shot() {
    const img = $('#tvShot');
    if (!img || !alive) return;
    const url = `/api/tv/screen?ip=${encodeURIComponent(st.ip)}&t=${Date.now()}`;
    const pic = new Image();
    pic.onload = () => { if ($('#tvShot')) { img.src = url; $('#tvShotNote').hidden = true; } };
    pic.onerror = () => { const n = $('#tvShotNote'); if (n) { n.hidden = false; n.textContent = 'No picture right now (the TV may be asleep).'; } };
    pic.src = url;
  }
  let soon = null;
  const shotSoon = () => { clearTimeout(soon); soon = setTimeout(shot, 450); };
  function startShots() { stopShots(); shot(); shotTimer = setInterval(() => { if (!document.hidden) shot(); }, 3000); }
  function stopShots() { clearInterval(shotTimer); shotTimer = null; }

  loadStatus().then(() => { if (st.ip) checkTv(); else paintMain(); });
  timer = setInterval(() => { loadStatus(); if (st.conn && st.conn.state !== 'device') checkTv(); }, 5000);
  return () => { alive = false; clearInterval(timer); stopShots(); document.removeEventListener('keydown', onKey); };
}
