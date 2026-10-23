// The hub's one Settings screen, grouped like the phone's: Labs AI (its own settings), Look, This PC (start with Windows,
// stay available), About (updates, restart), Devices, Apps, your data.
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const ago = (t) => { if (!t) return 'not yet'; const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

import { quietReload, waitThenReload } from './quiet.js';

// The one line about updates. "Up to date" and "Updated" are final: every part (the hub, Shivo Labs AI, the modules)
// was checked first (hub/api/update.mjs).
function statusOf(u, short) {
  if (u.phase === 'checking') return 'Checking…';
  if (u.phase === 'updating') return 'Updating…';
  if (u.phase === 'waiting') return 'Updating as soon as your chat finishes';
  if (u.error) return short ? "Couldn't update: " + u.error : u.error;
  if (u.done && !u.done.seen && Date.now() - u.done.at < 60 * 60 * 1000) return `Updated to ${u.done.version}${short ? '' : ` · ${ago(u.done.at)}`}`;
  return short ? "You're up to date" : u.lastCheck ? `Up to date · checked ${ago(u.lastCheck)}` : 'Not checked yet';
}

export function mountSettings(root, { esc, toast, openModule, list, setTheme, getTheme }) {
  root.innerHTML = '<div class="set" id="set"></div>';
  const $ = (s) => root.querySelector(s);
  let s = null, alive = true, painted = false, pressing = false;

  async function load() {
    try { s = await (await fetch('/api/settings', { cache: 'no-store' })).json(); } catch { return; }
    try { s.awake = (await (await fetch('/api/beam/status')).json()).awake !== false; } catch { s.awake = true; }
    if (alive) paint();
  }

  function paint() {
    // the cards pop in once; later redraws (checking, installing, toggles) must not replay that (it looked like a glitch)
    if (!painted) { painted = true; setTimeout(() => root.querySelector('#set')?.classList.add('shown'), 700); }
    const u = s.update;
    const busy = u.phase === 'checking' || u.phase === 'updating';
    const status = statusOf(u);
    const theme = getTheme();
    const ic = (d) => `<span class="s-ic">${svg(d)}</span>`;
    const chev = svg('<path d="m9 6 6 6-6 6"/>');
    const has = (id) => list.some((m) => m.id === id);
    // grouped like the phone's Settings (Labs AI, Look, Your PC, Devices, About), in two columns
    $('#set').innerHTML = `<div class="set-col">
      <div class="set-head"><div class="mkw">${shivoMark('loop')}</div><div><b>Shivo Labs</b><small>Version ${u.build ? `${esc(u.version.split('.').slice(0, 2).join('.'))} · build ${u.build}` : esc(u.version)}${u.ai ? ` · Labs AI ${esc(u.ai)}` : ''}${u.updatedAt ? ` · updated ${esc(new Date(u.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}</small></div></div>

      ${has('ai') ? `<div class="set-sub">Labs AI</div><section class="set-group">
        <button class="set-row go" id="aiSet">${ic('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>')}<span class="t"><b>Shivo Labs AI settings</b><small>Claude and Gemini keys, models, research, GitHub, secrets</small></span>${chev}</button>
      </section>` : ''}

      <div class="set-sub">Look</div><section class="set-group">
        <div class="set-row wide">${ic('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>')}<span class="t"><b>Appearance</b><small>Auto follows Windows.</small></span><div class="seg" id="theme">${['auto', 'light', 'dark'].map((t) => `<button data-t="${t}" class="${theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      </section>

      <div class="set-sub">This PC</div><section class="set-group">
        <div class="set-row">${ic('<path d="M12 3v9"/><path d="M6.3 6.6a8 8 0 1 0 11.4 0"/>')}<span class="t"><b>Start quietly with Windows</b><small>So your phone can always reach this PC. No window opens.</small></span><button class="sw${s.startup ? ' on' : ''}" id="startup" aria-label="Start with Windows"></button></div>
        <div class="set-row">${ic('<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>')}<span class="t"><b>Stay available while plugged in</b><small>The screen still turns off. On battery the PC sleeps as usual.</small></span><button class="sw${s.awake ? ' on' : ''}" id="awake" aria-label="Stay available while plugged in"></button></div>
      </section>
      </div><div class="set-col">

      <div class="set-sub">About</div><section class="set-group">
        <div class="set-row col">
          <div class="set-row-top">${ic('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>')}<span class="t"><b>Updates</b><small class="${u.error ? 'bad' : ''}">${esc(status)}</small></span>
            <button class="btn sm" id="chk"${busy ? ' disabled' : ''}>${busy ? status : 'Check for updates'}</button></div>
          <small class="set-where">Shivo Labs updates itself as soon as an update is out: every app at once.</small>
        </div>
        <button class="set-row go" id="restart">${ic('<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5"/>')}<span class="t"><b>Restart Shivo Labs</b><small>Closes and opens the apps on this PC again.</small></span>${chev}</button>
      </section>

      ${has('owner') || has('files') ? `<div class="set-sub">Devices</div><section class="set-group">
        ${has('files') ? `<button class="set-row go" id="devCloud">${ic('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>')}<span class="t"><b>Phones and computers</b><small>Which devices can open your Cloud files, and setting up a phone.</small></span>${chev}</button>` : ''}
        ${has('owner') ? `<button class="set-row go" id="devOwner">${ic('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.6M18 14.5a5 5 0 0 1 2.5 4.5"/>')}<span class="t"><b>Owner</b><small>Customers, invite codes and their devices.</small></span>${chev}</button>` : ''}
      </section>` : ''}

      <div class="set-sub">Apps</div><section class="set-group">
        ${list.map((m) => `<div class="set-row">${m.mark ? `<span class="s-ic mark-ic">${shivoMark()}</span>` : `<span class="s-ic"><svg viewBox="0 0 24 24">${m.icon}</svg></span>`}<span class="t"><b>${esc(m.name)}</b></span><span class="set-state">${!m.installed ? 'Not installed' : m.running ? '<i class="dot"></i>On' : m.running === false ? 'Off' : 'Ready'}</span></div>`).join('')}
      </section>

      <div class="set-sub">Your data</div><section class="set-group">
        ${s.places.map((p, i) => `<div class="set-row"><span class="t"><b>${esc(p.app)}</b><small>${esc(p.what)}</small></span>${p.exists ? `<button class="tbtn" data-rv="${i}">${svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}Show</button>` : '<span class="set-state">Nothing yet</span>'}</div>`).join('')}
      </section>
      <p class="set-foot">Kept on this PC. Updates never touch your data.</p>
      </div>`;

    // one press: every part is checked and whatever is new is installed; the answer comes when it is final
    $('#chk').onclick = async () => {
      s.update.phase = 'checking'; paint(); pressing = true;
      let r; try { r = await post('/api/settings/check'); } catch { return waitThenReload(toast); } finally { pressing = false; }   // the hub restarted with the update
      if (r.restarting) return waitThenReload(toast);   // the server restarts behind a calm cover, then the window comes back
      s.update = r.update; paint();
      if (r.reload) return quietReload();               // new screens: refresh quietly
      toast(statusOf(s.update, true));
    };
    $('#theme').onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b) return; setTheme(b.dataset.t); paint(); };
    $('#startup').onclick = async () => { const r = await post('/api/settings/startup', { on: !s.startup }); s.startup = r.startup; paint(); toast(s.startup ? 'Shivo Labs will start with Windows' : "Shivo Labs won't start with Windows"); };
    $('#awake').onclick = async () => {
      const on = !s.awake, r = await fetch('/api/beam/awake', { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
      if (!r.ok) return toast("Couldn't save that");
      s.awake = on; paint(); toast(on ? 'This PC stays available while plugged in' : 'This PC sleeps as usual');
    };
    $('#aiSet')?.addEventListener('click', () => openModule('ai', false, { aiSettings: true }));
    $('#devCloud')?.addEventListener('click', () => openModule('files'));
    $('#devOwner')?.addEventListener('click', () => openModule('owner'));
    root.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = () => post('/api/settings/reveal', { i: b.dataset.rv })));
    $('#restart').onclick = async () => { await post('/api/settings/restart'); waitThenReload(toast, 'Restarting Shivo Labs…'); };
  }

  load();
  // the update also runs by itself: follow it while Settings is open (redrawn only when something changed)
  let seen = '';
  const t = setInterval(async () => {
    if (!s) return;
    let u; try { u = (await (await fetch('/api/settings', { cache: 'no-store' })).json()).update; } catch { return; }
    if (pressing && (u.phase === 'idle' || u.phase === 'waiting')) return;   // the press answers with the final state itself
    const sig = JSON.stringify([u.phase, u.error, u.done, u.build, u.ai, Math.floor((Date.now() - (u.lastCheck || 0)) / 60000)]);
    if (alive && sig !== seen) { seen = sig; s.update = u; paint(); }
  }, 2000);
  return () => { alive = false; clearInterval(t); };
}
