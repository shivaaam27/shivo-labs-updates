// X Tools inside the hub: set up the PC, connect an iPhone, sign in with Apple, install and renew apps.
// Same steps as x-tools/installer/src/ui/app.js, in the hub's look. The engine runs behind /api/xtools/*.

const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const I = {
  up: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>', phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  ok: '<path d="m5 12 5 5 9-10"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>',
};

const GUIDE = [
  ['Before you start', `<ul><li>A Windows 11 PC (version 22H2 or newer).</li><li>A USB cable that carries data. Some cables only charge.</li><li>A free Apple ID. See <i>Which Apple ID to use</i> below.</li><li>The app as an <b>.ipa</b> file. Ones already on this PC show under <i>Found on this PC</i>.</li></ul>`],
  ['Connect your iPhone or iPad', `<ol><li>Plug it in and unlock it.</li><li>Tap <b>Trust</b> and enter the passcode.</li></ol><p>Not showing up? Try another cable or USB port, plugged straight into the PC. If you once tapped <i>Don't Trust</i>: Settings › General › Transfer or Reset › Reset › <b>Reset Location &amp; Privacy</b>, then plug in again.</p>`],
  ['After the first install on each device', `<p>Apps won't open until you do this, once per iPhone or iPad:</p><ol><li>Settings › Privacy &amp; Security › <b>Developer Mode</b> › On. It restarts and asks you to confirm. The switch only appears after an app is installed.</li><li>Settings › General › <b>VPN &amp; Device Management</b> › your Apple ID › <b>Trust</b>.</li></ol>`],
  ['No cable: pair over Wi-Fi', `<p>On iOS 27 and newer an iPhone can pair with this PC without a cable:</p><ol><li>On the Connect screen, press <b>Pair without a cable</b>.</li><li>On the iPhone: Settings › <b>Developer</b> › <b>Paired Macs</b>, and tap this PC under <i>Other Devices</i>.</li><li>Type the 6-digit code X Tools shows.</li></ol><p>The <i>Developer</i> menu appears once Developer Mode is on. On a brand-new iPhone that usually needs one first install with a cable.</p>`],
  ['Every 7 days: renew', `<p>Apps signed with a free Apple ID stop opening after 7 days. Press <b>Renew</b>. Nothing on the device is lost.</p><p>No cable needed after the first time: once an iPhone has been plugged in here, X Tools also reaches it over Wi-Fi while it is unlocked and on the same Wi-Fi as this PC.</p>`],
  ['Which Apple ID to use', `<p>Any Apple ID works, and it's free. A <b>separate Apple ID just for installing apps</b> is a good idea: it keeps your personal account apart.</p><ul><li>Create one at <a href="https://account.apple.com" target="_blank" rel="noopener">account.apple.com</a>.</li><li>Its 6-digit sign-in codes go to that account's trusted phone number or devices.</li><li>You don't need to sign in to it on the iPhone itself.</li></ul>`],
  ['Limits of a free Apple ID', `<ul><li><b>3 apps</b> at a time on each iPhone or iPad.</li><li><b>10 new apps</b> per week per Apple ID. Renewing doesn't count.</li><li>Apps last <b>7 days</b>, then need a renew.</li></ul><p>A paid Apple Developer account ($99 a year) removes the 3-app limit and makes apps last a year.</p>`],
  ['Something went wrong', `<ul><li><b>Lost the connection:</b> unplug, plug back in, unlock, try again.</li><li><b>Asked to replace a certificate:</b> a free Apple ID holds only a few. Replacing one means apps signed by the old one need a renew.</li><li><b>App won't open:</b> check both steps under <i>After the first install</i>.</li></ul>`],
];

export function mountXtools(root, { esc, toast }) {
  const $ = (s, el = root) => el.querySelector(s);
  const st = { appleId: null, device: null, apps: [], screen: null };
  let alive = true;

  async function call(cmd, args) {
    const r = await (await fetch('/api/xtools/call', { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cmd, args }) })).json();
    if (!r.ok) throw new Error(r.error || 'Something went wrong.');
    return r.data;
  }
  const loader = () => `<div class="xt-mark">${shivoMark('loop')}</div>`;

  root.innerHTML = `<div class="xt" id="xtScreen"></div>
    <div class="xt-veil" id="xtVeil" hidden><div class="xt-dialog card" id="xtDialog"></div></div>`;
  const screen = (html) => { $('#xtScreen').innerHTML = html; };

  // the header pill: the connected device, and a Guide button
  function paintBar() {
    const pill = document.getElementById('pageState');
    if (!pill) return;
    pill.innerHTML = `${st.device ? `<i class="dot"></i>${esc(st.device.name)}${st.device.link === 'wifi' ? ' · Wi-Fi' : ''}<span class="xt-sep"></span>` : st.waiting ? `<i class="dot wait"></i>Waiting for Trust<span class="xt-sep"></span>` : ''}<button class="tbtn" id="xtGuide">${svg(I.book)}Guide</button>`;
    document.getElementById('xtGuide').onclick = openGuide;
  }

  // ---------- events from the engine: progress and questions
  const events = new EventSource('/api/xtools/events');
  events.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === 'setup') setStep(m.data.step, m.data.pct >= 100 ? 'done' : 'active', m.data.label, m.data.pct);
    if (m.event === 'progress') { const f = $('#pFill'); if (f) { f.style.width = m.data.pct + '%'; $('#pLabel').textContent = m.data.label; $('#pPct').textContent = m.data.pct + '%'; } }
    if (m.event === 'ask') ask(m.data);
    if (m.event === 'device') onDevice(m.data);
    if (m.event === 'dev') onDevEvent(m.data);
    if (m.event === 'pair') onPair(m.data);
  };
  // the plugged-in device changed (plugged in, pulled out, another one, now trusted): follow it at once
  let gotDevice = false;
  function onDevice(d) {
    gotDevice = true;
    const before = st.device;
    st.device = d && !d.untrusted ? d : null; st.waiting = d && d.untrusted ? d : null;
    paintBar();
    if (!alive || ['setup', 'boot'].includes(st.screen)) return;
    if (!st.device) { if (st.screen !== 'connect') openConnect(); else paintConnect(); return; }
    if (st.screen === 'connect') return route();
    if (st.screen === 'apps') { if (before?.udid !== st.device.udid) openApps(); else { renderApps(); renderFound(); } }
  }
  const lookAgain = async (wifiNow) => { try { const r = await (await fetch('/api/xtools/device' + (wifiNow ? '?wifi=now' : ''), { method: 'POST', headers: { 'x-hub': '1' } })).json(); if (r.ok) onDevice(r.data); } catch {} };

  async function boot() {
    st.screen = 'boot';
    screen(`<div class="xt-center">${loader()}<p class="xt-sub">Starting X Tools…</p></div>`);
    paintBar();
    let s;
    try { s = await call('status'); }
    catch (e) { return screen(`<div class="xt-center"><h1 class="xt-h">X Tools can't start here</h1><p class="xt-sub">${esc(e.message)}</p><button class="btn pri xt-btn" id="xtRetry">Try again</button></div>`), ($('#xtRetry').onclick = boot); }
    st.appleId = s.appleId || null; st.apps = s.apps || [];
    if (!s.ready) return openSetup(s);
    if (!gotDevice) await lookAgain();
    route();
  }
  function route() { if (!st.device) return openConnect(); if (!st.appleId) return openSignIn(); openApps(); }

  // ---------- 1. set up this PC
  function openSetup(s) {
    st.screen = 'setup';
    screen(`<div class="xt-panel card"><h1 class="xt-h">Set up this PC</h1><p class="xt-sub">X Tools installs what it needs. This takes a few minutes, once.</p>
      <ol class="xt-steps">
        <li data-step="wsl"><span class="xt-state"></span><div><b>Linux for Windows</b><small></small></div></li>
        <li data-step="engine"><span class="xt-state"></span><div><b>Shivo Labs engine</b><small></small></div></li>
        <li data-step="apple"><span class="xt-state"></span><div><b>Apple iPhone drivers</b><small></small></div></li>
      </ol>
      <button class="btn pri" id="setupBtn">Set up</button>
      <p class="xt-note" id="restartNote" hidden>Restart your PC to finish, then open X Tools again.</p></div>`);
    setStep('wsl', s.wsl ? 'done' : '', s.wsl ? 'Ready' : 'Not installed');
    setStep('engine', s.engine ? 'done' : '', s.engine ? 'Ready' : 'Not installed');
    setStep('apple', s.apple ? 'done' : '', s.apple ? 'Ready' : 'Not installed');
    $('#setupBtn').onclick = async () => {
      const b = $('#setupBtn'); b.disabled = true; b.textContent = 'Setting up…';
      try {
        const r = await call('setup');
        if (r?.restart) { $('#restartNote').hidden = false; b.hidden = true; return; }
        const s2 = await call('status'); st.appleId = s2.appleId; st.apps = s2.apps || []; route();
      } catch (e) { b.disabled = false; b.textContent = 'Try again'; alertBox('Setup stopped', e.message); }
    };
  }
  function setStep(step, cls, text, pct) {
    const li = $(`[data-step="${step}"]`); if (!li) return;
    li.className = cls || '';
    $('small', li).textContent = text || '';
    let track = $('.xt-track', li);
    if (cls === 'active' && pct != null) {
      if (!track) { track = document.createElement('div'); track.className = 'xt-track'; track.innerHTML = '<i></i>'; $('div', li).append(track); }
      $('i', track).style.width = pct + '%';
    } else track?.remove();
  }

  // ---------- 2. connect an iPhone or iPad (the picture turns from one to the other)
  let morph = 0, connectPoll = 0;
  function openConnect() {
    st.screen = 'connect';
    screen(`<div class="xt-center xt-hero"><div class="xt-phone" id="xtDev"><i class="xt-notch"></i>${loader()}</div><h1 class="xt-h" id="xtConnH"></h1><p class="xt-sub" id="xtConnS"></p>
      <ol class="xt-how" id="xtHow"></ol><button class="tbtn" id="xtPairWifi">No cable? Pair over Wi-Fi</button></div>`);
    $('#xtPairWifi').onclick = pairWifi;
    paintConnect();
    clearInterval(morph); morph = setInterval(() => { const e = $('#xtDev'); if (!e || st.screen !== 'connect') return clearInterval(morph); e.classList.toggle('tablet'); }, 2600);
    clearInterval(connectPoll); connectPoll = setInterval(() => { if (st.screen !== 'connect' || !alive) return clearInterval(connectPoll); lookAgain(); }, 5000);
  }
  function paintConnect() {
    if (st.screen !== 'connect') return;
    const w = st.waiting;   // plugged in, but this PC isn't trusted yet
    $('#xtConnH').textContent = w ? `Unlock your ${w.kind === 'iPad' ? 'iPad' : 'iPhone'}` : 'Connect your iPhone or iPad';
    $('#xtConnS').textContent = w ? 'Then tap Trust and enter the passcode. X Tools carries on by itself.' : 'Plug it in once. After that X Tools also finds it over Wi-Fi when it is unlocked.';
    $('#xtHow').innerHTML = w ? '<li><b>1</b>Unlock it</li><li><b>2</b>Tap <i>Trust</i></li><li><b>3</b>Enter the passcode</li>'
      : '<li><b>1</b>Plug it in with a cable</li><li><b>2</b>Unlock it</li><li><b>3</b>Tap <i>Trust</i></li>';
  }

  // ---------- pair without a cable (iOS 27): the iPhone finds this PC in Settings and the person types the code
  async function pairWifi() {
    box(`<div class="xt-center" id="pairBox">${loader()}<h2>Pair without a cable</h2><p class="xt-sub" id="pairMsg">Getting ready…</p>
      <p class="xt-pin" id="pairPin" hidden></p><button class="tbtn" id="pairCancel">Cancel</button></div>`, (d) => {
      $('#pairCancel', d).onclick = () => { fetch('/api/xtools/pair/stop', { method: 'POST', headers: { 'x-hub': '1' } }).catch(() => {}); closeBox(); };
    }, true);
    try {
      const r = await (await fetch('/api/xtools/pair/start', { method: 'POST', headers: { 'x-hub': '1' } })).json();
      if (!r.ok) throw new Error(r.error);
    } catch (e) { alertBox("Can't pair now", e.message); }
  }
  function onPair(e) {
    const msg = $('#pairMsg'), pin = $('#pairPin');
    if (!msg) return;
    if (e.step === 'waiting') msg.innerHTML = `On your iPhone: Settings › <b>Developer</b> › <b>Paired Macs</b>, then tap <b>${esc(e.name)}</b> under <i>Other Devices</i>.`;
    if (e.step === 'iPhone connected') msg.textContent = 'Your iPhone found this PC…';
    if (e.pin) { msg.textContent = 'Type this code on your iPhone:'; pin.textContent = String(e.pin).replace(/(\d{3})(\d{3})/, '$1 $2'); pin.hidden = false; }
    if (e.paired) { closeBox(); toast(`${e.paired.name.replace(/’/g, "'")} is paired. X Tools now finds it over Wi-Fi.`); lookAgain(true); }
    if (e.error) alertBox("Couldn't pair", e.error);
  }

  // ---------- 3. sign in with Apple
  function openSignIn() {
    st.screen = 'signin';
    screen(`<form class="xt-panel card" id="signinForm" autocomplete="off"><h1 class="xt-h">Sign in with Apple</h1><p class="xt-sub">Your Apple ID signs the apps. The password goes only to Apple; X Tools never saves it.</p>
      <label class="xt-label">Apple ID<input class="xt-field" type="email" id="email" required spellcheck="false"></label>
      <label class="xt-label">Password<input class="xt-field" type="password" id="password" required></label>
      <button class="btn pri" id="signinBtn" type="submit">Sign in</button>
      <p class="xt-note">A free Apple ID works. Apps stay signed for 7 days; renew them here.</p></form>`);
    setTimeout(() => $('#email')?.focus(), 200);
    $('#signinForm').onsubmit = async (e) => {
      e.preventDefault();
      const b = $('#signinBtn'); b.disabled = true; b.textContent = 'Signing in…';
      try {
        const r = await call('signIn', { email: $('#email').value, password: $('#password').value });
        st.appleId = r.appleId; closeBox(); route();
      } catch (err) { closeBox(); if (err.message !== 'Cancelled.') alertBox("Couldn't sign in", err.message); }
      finally { const p = $('#password'); if (p) p.value = ''; if ($('#signinBtn')) { b.disabled = false; b.textContent = 'Sign in'; } }
    };
  }

  // ---------- 4. your apps
  function openApps() {
    st.screen = 'apps';
    screen(`<div class="xt-apps">
      <div class="xt-row-h"><h1 class="xt-h" id="xtAppsH">Your apps</h1><span class="xt-slots" id="slots"></span><button class="tbtn xt-acct" id="acct">${esc(st.appleId || '')}</button></div>
      <label class="bm-drop card" id="xtDrop"><input type="file" id="xtPick" accept=".ipa" hidden><span class="mod-ic">${svg(I.up)}</span><b>Add an app</b><small>Drop an .ipa file here, or click to choose</small></label>
      <div class="card"><div id="apps"></div></div>
      <div class="card" id="notOn" hidden><div class="bm-h"><h2 id="notOnH"></h2></div><div id="notOnList"></div></div>
      <div class="card" id="found" hidden><div class="bm-h"><h2>Found on this PC</h2></div><div id="foundList"></div></div>
      <div class="card" id="devCard" hidden><div class="bm-h"><h2>Shivo Labs from the source</h2></div>
        <p class="xt-note" id="devLine"></p>
        <div class="xt-actions"><button class="btn" id="devDetails" hidden>Details</button><button class="btn" id="devHub">Send laptop update</button><button class="btn" id="devOta">Send phone update</button><button class="btn pri" id="devBuild">Build iPhone app</button></div></div></div>`);
    renderApps(); renderFound(); renderDev();
    $('#acct').onclick = () => box(`<h2>Apple ID</h2><p>${esc(st.appleId)}</p><div class="xt-actions"><button class="btn" data-close>Close</button><button class="btn" id="signOutBtn">Sign out</button></div>`, (d) => {
      $('#signOutBtn', d).onclick = async () => { await call('signOut').catch(() => {}); st.appleId = null; closeBox(); route(); };
    });
    const drop = $('#xtDrop');
    $('#xtPick').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) add(f); };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondragleave = () => drop.classList.remove('drag');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); const f = [...e.dataTransfer.files].find((x) => /\.ipa$/i.test(x.name)); f ? add(f) : toast('Drop an .ipa file'); };
  }
  function appRow(a, i, actions) {
    return `<div class="xt-app" style="--i:${i}"><span class="xt-ic">${esc((a.name || '?').trim()[0].toUpperCase())}</span><div class="meta"><div class="n">${esc(a.name)}</div><div class="s">${actions.sub}</div></div>${actions.html}</div>`;
  }
  // xtool installs an app as "XTL-<team>.<its own id>": match both ways
  const onDev = (a) => (st.device?.apps || []).find((x) => x.bundleId === a.bundleId || (x.bundleId.startsWith('XTL-') && x.bundleId.endsWith('.' + a.bundleId)));
  function daysOf(installed) {
    const exp = st.device?.expiry?.[installed.bundleId];
    return exp ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : null;
  }
  function renderApps() {
    if (!$('#apps')) return;
    const kind = st.device?.kind === 'iPad' ? 'iPad' : 'iPhone';
    const here = st.apps.filter(onDev), away = st.apps.filter((a) => !onDev(a));
    const signed = (st.device?.apps || []).filter((x) => x.bundleId.startsWith('XTL-')).length;   // apps signed with a free Apple ID on this device
    $('#xtAppsH').textContent = st.device ? `On ${st.device.name}` : 'Your apps';
    $('#slots').textContent = st.device ? `${signed} of 3 on this ${kind}` : '';
    $('#apps').innerHTML = here.length ? here.map((a, i) => {
      const d = daysOf(onDev(a)), days = d == null ? '' : d === 0 ? 'Expired' : d === 1 ? '1 day left' : `${d} days left`;
      return appRow(a, i, { sub: esc(a.version ? 'Version ' + a.version : a.bundleId), html: `${days ? `<span class="xt-days${d <= 1 ? ' low' : ''}">${days}</span>` : ''}<button class="btn sm xt-btn" data-renew="${esc(a.bundleId)}">Renew</button><button class="ibtn" data-more="${esc(a.bundleId)}" aria-label="More">${svg(I.more)}</button>` });
    }).join('') : `<p class="emptyt">No apps from X Tools on this ${kind} yet. Add an .ipa above${away.length ? ', or install one from below' : ''}.</p>`;
    $('#notOn').hidden = !away.length;
    $('#notOnH').textContent = `Not on this ${kind}`;
    $('#notOnList').innerHTML = away.map((a, i) => appRow(a, i, { sub: esc(a.version ? 'Version ' + a.version : a.bundleId), html: `<button class="btn sm xt-btn" data-renew="${esc(a.bundleId)}">Install</button>` })).join('');
    root.querySelectorAll('[data-renew]').forEach((b) => (b.onclick = () => install({ renew: st.apps.find((a) => a.bundleId === b.dataset.renew) })));
    root.querySelectorAll('[data-more]').forEach((b) => (b.onclick = () => {
      const a = st.apps.find((x) => x.bundleId === b.dataset.more);
      box(`<h2>${esc(a.name)}</h2><p>${esc(a.bundleId)}</p><p>Installed ${esc(a.installedAt)}.</p><div class="xt-actions"><button class="btn" data-close>Close</button><button class="btn" id="forgetBtn">Remove from list</button></div>`, (d) => {
        $('#forgetBtn', d).onclick = async () => { st.apps = await call('forget', { bundleId: a.bundleId }); closeBox(); renderApps(); };
      });
    }));
  }
  async function renderFound() {
    let files = [];
    try { files = await call('findIpas'); } catch {}
    if (!alive || st.screen !== 'apps') return;
    const mine = new Set(st.apps.map((a) => a.bundleId));
    files = (files || []).filter((f) => !mine.has(f.bundleId));
    $('#found').hidden = !files.length;
    $('#foundList').innerHTML = files.map((f, i) => appRow(f, i, { sub: `<span title="${esc(f.path)}">${esc(f.folder)}</span>`, html: `<button class="btn sm xt-btn" data-found="${i}">Install</button>` })).join('');
    root.querySelectorAll('[data-found]').forEach((b) => (b.onclick = () => confirmInstall(files[b.dataset.found])));
  }
  async function add(file) {
    box(`<div class="xt-center">${loader()}<p class="xt-sub">Reading ${esc(file.name)}…</p></div>`, null, true);
    try {
      const r = await (await fetch(`/api/xtools/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-hub': '1' }, body: file })).json();
      if (!r.ok) throw new Error(r.error);
      confirmInstall(r.data);
    } catch (e) { alertBox("Can't open this file", e.message); }
  }
  function confirmInstall(f) {
    box(`<h2>Install ${esc(f.name)}?</h2><p>${esc(f.version ? 'Version ' + f.version + ' · ' : '')}${(f.size / 1048576).toFixed(1)} MB</p><p>${st.device?.link === 'wifi' ? 'Keep your iPhone unlocked and on this Wi-Fi.' : 'Keep your iPhone unlocked and connected.'}</p>
      <div class="xt-actions"><button class="btn" data-close>Cancel</button><button class="btn pri" id="goBtn">Install</button></div>`, (d) => { $('#goBtn', d).onclick = () => install({ path: f.path }); });
  }

  // ---------- from the source (only on a PC with the Shivo Labs code): build the iPhone app here, without a Mac or
  // GitHub's build minutes, and send the phone app's screens over the air (hub/api/xtools.mjs, phone/local-build)
  const dev = { state: null, last: '', timer: 0 };
  async function renderDev() {
    try { const r = await (await fetch('/api/xtools/dev')).json(); if (r.ok) dev.state = r.data; } catch {}
    dev.last = dev.state?.tail?.[dev.state.tail.length - 1] || '';
    paintDev();
  }
  function onDevEvent(d) {
    if (!dev.state) return;
    if (d.done) { dev.state.running = null; dev.state.result = d; if (d.kind === 'build') renderFound(); }
    else { dev.state.running = d.kind; dev.last = d.line; (dev.state.tail ||= []).push(d.line); if (dev.state.tail.length > 400) dev.state.tail.splice(0, 200); }
    paintDev();
  }
  const mins = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function paintDev() {
    const c = $('#devCard'), s = dev.state;
    clearInterval(dev.timer);
    if (!c || !s) return;
    c.hidden = !s.available;
    if (c.hidden) return;
    const run = s.running, res = s.result, line = $('#devLine');
    $('#devBuild').disabled = $('#devOta').disabled = $('#devHub').disabled = !!run;
    $('#devBuild').textContent = run === 'build' ? 'Building…' : 'Build iPhone app';
    $('#devOta').textContent = run === 'ota' ? 'Sending…' : 'Send phone update';
    $('#devHub').textContent = run === 'hub' ? 'Sending…' : 'Send laptop update';
    $('#devDetails').hidden = !(run || res);
    if (run) {
      const show = () => { line.textContent = `${run === 'build' ? 'Building the iPhone app' : run === 'hub' ? 'Sending the laptop update' : 'Sending the phone update'} · ${mins(Date.now() - (s.started || Date.now()))} · ${dev.last}`; };
      show(); dev.timer = setInterval(show, 1000);
    } else if (res && !res.ok) line.textContent = res.kind === 'build' ? "The iPhone app didn't build. Details shows why." : `The ${res.kind === 'hub' ? 'laptop' : 'phone'} update wasn't sent. Details shows why.`;
    else if (res) line.innerHTML = res.kind === 'build' ? `Built: ShivoLabs.ipa in Downloads. <button class="tbtn" id="devInstall">Install it</button>`
      : res.kind === 'hub' ? 'Laptop update sent. Installed Shivo Labs on other PCs install it within 15 minutes.' : 'Phone update sent. Phones switch to it the next time the app opens.';
    else line.textContent = "Build iPhone app: makes the app from this PC's files, ready to install. Send phone update: sends the phone app's screens, as they are on GitHub, to every phone. Send laptop update: sends Shivo Labs for Windows, as it is on GitHub, to every installed PC.";
    const inst = $('#devInstall');
    if (inst) inst.onclick = async () => { try { confirmInstall(await call('summary', { path: res.path })); } catch (e) { alertBox("Can't open the app", e.message); } };
    $('#devDetails').onclick = () => { box(`<h2>${run ? 'Working' : res?.ok ? 'Done' : 'What happened'}</h2><pre class="xt-log">${esc((run ? s.tail : res?.tail || s.tail || []).slice(-40).join('\n'))}</pre><div class="xt-actions"><button class="btn pri" data-close>Close</button></div>`); $('#xtDialog').classList.add('wide'); };
    const go = (what) => async () => {
      try {
        const r = await (await fetch('/api/xtools/dev/' + what, { method: 'POST', headers: { 'x-hub': '1' } })).json();
        if (!r.ok) throw new Error(r.error);
        dev.state = r.data; dev.last = 'Starting'; paintDev();
      } catch (e) { alertBox(what === 'build' ? "Can't build now" : "Can't send now", e.message); }
    };
    $('#devBuild').onclick = go('build');
    $('#devHub').onclick = () => box(`<h2>Send the laptop update?</h2><p>Shivo Labs for Windows, as it is on GitHub now, goes to every PC where it is installed. They install it by themselves within 15 minutes.</p><div class="xt-actions"><button class="btn" data-close>Cancel</button><button class="btn pri" id="hubGo">Send</button></div>`, (d) => { $('#hubGo', d).onclick = () => { closeBox(); go('hub')(); }; });
    $('#devOta').onclick = () => box(`<h2>Send the phone update?</h2><p>The phone app's screens, as they are on GitHub now, go to every phone with Shivo Labs. They switch to it the next time the app opens.</p><div class="xt-actions"><button class="btn" data-close>Cancel</button><button class="btn pri" id="otaGo">Send</button></div>`, (d) => { $('#otaGo', d).onclick = () => { closeBox(); go('ota')(); }; });
  }

  // ---------- install / renew, with progress
  async function install({ path, renew }) {
    if (!st.device) { closeBox(); return openConnect(); }
    box(`<div class="xt-center">${loader()}<p class="xt-plabel" id="pLabel">Preparing</p><div class="xt-track big"><i id="pFill"></i></div><p class="xt-pct" id="pPct">0%</p>
      <button class="tbtn" id="xtCancel">Cancel</button></div>`, (d) => { $('#xtCancel', d).onclick = () => call('cancel').catch(() => {}); }, true);
    try {
      const udid = st.device.udid, wasOn = renew && onDev(renew), wifi = st.device.link === 'wifi';
      const r = renew ? await call('renew', { bundleId: renew.bundleId, udid, wifi }) : await call('install', { path, udid, wifi });
      st.apps = r.apps; await lookAgain(true); renderApps(); renderFound(); done(r.name, wasOn);
    } catch (e) { if (e.message === 'Cancelled.') return closeBox(); alertBox(renew ? "Couldn't renew" : "Couldn't install", e.message); }
  }
  function done(name, renewed) {
    if (renewed) { closeBox(); return toast(`${name} renewed for 7 days`); }
    box(`<h2>${esc(name)} is installed</h2><p>First time on this iPhone or iPad? Do this once, then open the app:</p>
      <ol class="xt-tips"><li>Settings › Privacy &amp; Security › <b>Developer Mode</b> › On. It restarts and asks you to confirm.</li><li>Settings › General › <b>VPN &amp; Device Management</b> › your Apple ID › Trust.</li></ol>
      <p class="xt-note">Renew within 7 days.</p><div class="xt-actions"><button class="btn" id="doneGuide">Guide</button><button class="btn pri" data-close>Done</button></div>`, (d) => { $('#doneGuide', d).onclick = openGuide; });
  }

  // ---------- questions from the engine while it works
  function ask({ kind, data }) {
    if (kind === 'code') {
      box(`<h2>Enter the code</h2><p>Apple sent a 6-digit code to your devices.</p><input class="xt-field xt-code" id="codeIn" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
        <div class="xt-actions"><button class="btn" id="codeCancel">Cancel</button><button class="btn pri" id="codeOk">Continue</button></div>`, (d) => {
        const input = $('#codeIn', d); setTimeout(() => input.focus(), 100);
        const send = () => { if (input.value.trim().length >= 6) { call('answer', { kind, value: input.value.trim() }); box(`<div class="xt-center">${loader()}<p class="xt-plabel">Signing in</p></div>`, null, true); } };
        input.oninput = () => { input.value = input.value.replace(/\D/g, ''); if (input.value.length === 6) send(); };
        $('#codeOk', d).onclick = send;
        $('#codeCancel', d).onclick = () => { call('answer', { kind, value: '' }); closeBox(); };
      }, true);
    }
    if (kind === 'revoke') {
      const prev = $('#xtDialog').innerHTML;
      box(`<h2>Replace an old certificate?</h2><p>A free Apple ID can hold only a few. Apps signed with the old one stop opening until they are renewed.</p><p class="xt-note">${esc(data?.cert || '')}</p>
        <div class="xt-actions"><button class="btn" id="rNo">Cancel</button><button class="btn pri" id="rYes">Replace</button></div>`, (d) => {
        $('#rYes', d).onclick = () => { $('#xtDialog').innerHTML = prev; call('answer', { kind, value: 'yes' }); };
        $('#rNo', d).onclick = () => call('answer', { kind, value: 'no' });
      }, true);
    }
  }

  // ---------- guide and dialogs
  function openGuide() {
    box(`<h2>Guide</h2><p class="xt-sub">Everything you need, in order.</p>
      <div class="xt-guide">${GUIDE.map(([t, b], i) => `<details${i === 0 ? ' open' : ''}><summary>${t}</summary><div>${b}</div></details>`).join('')}</div>
      <div class="xt-actions"><span class="xt-ver" id="xtVer"></span><button class="btn pri" data-close>Close</button></div>`, (d) => {
      call('version').then((v) => { const el = $('#xtVer', d); if (el && v) el.textContent = 'X Tools ' + v.version; }).catch(() => {});
      d.querySelectorAll('details').forEach((x) => x.addEventListener('toggle', () => { if (x.open) d.querySelectorAll('details').forEach((y) => { if (y !== x) y.open = false; }); }));
    });
    $('#xtDialog').classList.add('wide');
  }
  function box(html, setup, locked = false) {
    const veil = $('#xtVeil'), d = $('#xtDialog');
    d.className = 'xt-dialog card'; d.innerHTML = html;
    d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeBox));
    veil.hidden = false;
    veil.onclick = (e) => { if (!locked && e.target === veil) closeBox(); };
    setup?.(d);
  }
  function closeBox() { $('#xtVeil').hidden = true; $('#xtDialog').innerHTML = ''; }
  function alertBox(title, msg) { box(`<h2>${esc(title)}</h2><p>${esc(msg)}</p><div class="xt-actions"><button class="btn pri" data-close>OK</button></div>`); }
  const onKey = (e) => { if (e.key === 'Escape' && !$('#xtVeil').hidden && $('[data-close]', $('#xtDialog'))) closeBox(); };
  document.addEventListener('keydown', onKey);

  boot();
  return () => {
    alive = false; events.close(); clearInterval(morph); clearInterval(dev.timer); clearInterval(connectPoll); document.removeEventListener('keydown', onKey);
    fetch('/api/xtools/stop', { method: 'POST', headers: { 'x-hub': '1' } }).catch(() => {});
  };
}
