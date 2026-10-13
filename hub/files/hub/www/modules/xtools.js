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
  ['Every 7 days: renew', `<p>Apps signed with a free Apple ID stop opening after 7 days. Plug in and press <b>Renew</b>. Nothing on the device is lost.</p>`],
  ['Which Apple ID to use', `<p>Any Apple ID works, and it's free. A <b>separate Apple ID just for installing apps</b> is a good idea: it keeps your personal account apart.</p><ul><li>Create one at <a href="https://account.apple.com" target="_blank" rel="noopener">account.apple.com</a>.</li><li>Its 6-digit sign-in codes go to that account's trusted phone number or devices.</li><li>You don't need to sign in to it on the iPhone itself.</li></ul>`],
  ['Limits of a free Apple ID', `<ul><li><b>3 apps</b> at a time on each iPhone or iPad.</li><li><b>10 new apps</b> per week per Apple ID. Renewing doesn't count.</li><li>Apps last <b>7 days</b>, then need a renew.</li></ul><p>A paid Apple Developer account ($99 a year) removes the 3-app limit and makes apps last a year.</p>`],
  ['Something went wrong', `<ul><li><b>Lost the connection:</b> unplug, plug back in, unlock, try again.</li><li><b>Asked to replace a certificate:</b> a free Apple ID holds only a few. Replacing one means apps signed by the old one need a renew.</li><li><b>App won't open:</b> check both steps under <i>After the first install</i>.</li></ul>`],
];

export function mountXtools(root, { esc, toast }) {
  const $ = (s, el = root) => el.querySelector(s);
  const st = { appleId: null, device: null, apps: [], screen: null };
  let alive = true, watching = false;

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
    pill.innerHTML = `${st.device ? `<i class="dot"></i>${esc(st.device.name)}<span class="xt-sep"></span>` : ''}<button class="tbtn" id="xtGuide">${svg(I.book)}Guide</button>`;
    document.getElementById('xtGuide').onclick = openGuide;
  }

  // ---------- events from the engine: progress and questions
  const events = new EventSource('/api/xtools/events');
  events.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === 'setup') setStep(m.data.step, m.data.pct >= 100 ? 'done' : 'active', m.data.label, m.data.pct);
    if (m.event === 'progress') { const f = $('#pFill'); if (f) { f.style.width = m.data.pct + '%'; $('#pLabel').textContent = m.data.label; $('#pPct').textContent = m.data.pct + '%'; } }
    if (m.event === 'ask') ask(m.data);
  };

  async function boot() {
    screen(`<div class="xt-center">${loader()}<p class="xt-sub">Starting X Tools…</p></div>`);
    paintBar();
    let s;
    try { s = await call('status'); }
    catch (e) { return screen(`<div class="xt-center"><h1 class="xt-h">X Tools can't start here</h1><p class="xt-sub">${esc(e.message)}</p><button class="btn pri xt-btn" id="xtRetry">Try again</button></div>`), ($('#xtRetry').onclick = boot); }
    st.appleId = s.appleId || null; st.apps = s.apps || [];
    if (!s.ready) return openSetup(s);
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

  // ---------- 2. connect the iPhone
  async function openConnect() {
    st.screen = 'connect';
    screen(`<div class="xt-center xt-hero"><div class="xt-phone"><i class="xt-notch"></i>${loader()}</div><h1 class="xt-h">Connect your iPhone</h1><p class="xt-sub">X Tools installs and renews your apps over a cable.</p>
      <ol class="xt-how"><li><b>1</b>Plug it in with a cable</li><li><b>2</b>Unlock it</li><li><b>3</b>Tap <i>Trust</i></li></ol></div>`);
    while (alive && st.screen === 'connect') {
      try { const d = await call('device'); if (d) { st.device = d; paintBar(); break; } } catch (e) { if (/in use somewhere else/.test(e.message)) return boot(); }
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (alive && st.device) route();
  }
  // keep the device pill true to what is plugged in
  const devTimer = setInterval(async () => {
    if (!alive || watching || st.screen !== 'apps') return;
    watching = true;
    try { const d = await call('device'); if ((d?.udid || null) !== (st.device?.udid || null)) { st.device = d; paintBar(); } } catch {} finally { watching = false; }
  }, 4000);

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
      <div class="xt-row-h"><h1 class="xt-h">Your apps</h1><span class="xt-slots" id="slots"></span><button class="tbtn xt-acct" id="acct">${esc(st.appleId || '')}</button></div>
      <label class="bm-drop card" id="xtDrop"><input type="file" id="xtPick" accept=".ipa" hidden><span class="mod-ic">${svg(I.up)}</span><b>Add an app</b><small>Drop an .ipa file here, or click to choose</small></label>
      <div class="card"><div id="apps"></div></div>
      <div class="card" id="found" hidden><div class="bm-h"><h2>Found on this PC</h2></div><div id="foundList"></div></div></div>`);
    renderApps(); renderFound();
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
  function renderApps() {
    $('#slots').textContent = st.apps.length ? `${st.apps.length} of 3 on a free Apple ID` : '';
    $('#apps').innerHTML = st.apps.length ? st.apps.map((a, i) => {
      const days = a.daysLeft === 0 ? 'Expired' : a.daysLeft === 1 ? '1 day left' : `${a.daysLeft} days left`;
      return appRow(a, i, { sub: esc(a.version ? 'Version ' + a.version : a.bundleId), html: `<span class="xt-days${a.daysLeft <= 1 ? ' low' : ''}">${days}</span><button class="btn sm xt-btn" data-renew="${esc(a.bundleId)}">Renew</button><button class="ibtn" data-more="${esc(a.bundleId)}" aria-label="More">${svg(I.more)}</button>` });
    }).join('') : `<p class="emptyt">No apps yet. Add an .ipa above.</p>`;
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
    box(`<h2>Install ${esc(f.name)}?</h2><p>${esc(f.version ? 'Version ' + f.version + ' · ' : '')}${(f.size / 1048576).toFixed(1)} MB</p><p>Keep your iPhone unlocked and connected.</p>
      <div class="xt-actions"><button class="btn" data-close>Cancel</button><button class="btn pri" id="goBtn">Install</button></div>`, (d) => { $('#goBtn', d).onclick = () => install({ path: f.path }); });
  }

  // ---------- install / renew, with progress
  async function install({ path, renew }) {
    if (!st.device) { closeBox(); return openConnect(); }
    box(`<div class="xt-center">${loader()}<p class="xt-plabel" id="pLabel">Preparing</p><div class="xt-track big"><i id="pFill"></i></div><p class="xt-pct" id="pPct">0%</p>
      <button class="tbtn" id="xtCancel">Cancel</button></div>`, (d) => { $('#xtCancel', d).onclick = () => call('cancel').catch(() => {}); }, true);
    try {
      const r = renew ? await call('renew', { bundleId: renew.bundleId }) : await call('install', { path });
      st.apps = r.apps; renderApps(); renderFound(); done(r.name, renew);
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
    alive = false; events.close(); clearInterval(devTimer); document.removeEventListener('keydown', onKey);
    fetch('/api/xtools/stop', { method: 'POST', headers: { 'x-hub': '1' } }).catch(() => {});
  };
}
