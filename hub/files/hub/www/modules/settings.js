// The hub's one Settings screen: updates, look, start with Windows, apps, Shivo Labs AI's own settings, your data.
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'x-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const ago = (t) => { if (!t) return 'not yet'; const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

import { quietReload, waitThenReload } from './quiet.js';

export function mountSettings(root, { esc, toast, openModule, list, setTheme, getTheme }) {
  root.innerHTML = '<div class="set" id="set"></div>';
  const $ = (s) => root.querySelector(s);
  let s = null, alive = true, painted = false;

  async function load() { try { s = await (await fetch('/api/settings', { cache: 'no-store' })).json(); } catch { return; } if (alive) paint(); }

  function paint() {
    // the cards pop in once; later redraws (checking, installing, toggles) must not replay that (it looked like a glitch)
    if (!painted) { painted = true; setTimeout(() => root.querySelector('#set')?.classList.add('shown'), 700); }
    const u = s.update;
    const where = u.mode === 'repo' ? 'Runs from the Shivo Labs folder (Documents\\Shivo Labs). Updates come from GitHub.' : 'Updates are checked a few times a day and only installed when you say so.';
    const status = u.installing ? 'Installing…' : u.checking ? 'Checking…' : u.error ? esc(u.error) : u.available ? `<b>Update ready: ${esc(u.available.version)}</b>` : u.lastCheck ? `Up to date · checked ${ago(u.lastCheck)}` : 'Not checked yet';
    const theme = getTheme();
    $('#set').innerHTML = `
      <section class="card set-card">
        <div class="set-h"><span class="mod-ic sm mark-ic">${shivoMark()}</span><div><b>Shivo Labs ${u.build ? `${esc(u.version.split('.').slice(0, 2).join('.'))} <span class="set-build">build ${u.build}</span>` : esc(u.version)}</b><small>${u.updatedAt ? `Updated ${esc(new Date(u.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · ` : ''}${where}</small></div></div>
        <p class="set-status${u.error ? ' bad' : ''}">${status}</p>
        ${u.aiHandOff ? `<p class="set-status${u.aiHandOff.error ? ' bad' : ''}">${u.aiHandOff.error ? `Shivo Labs AI ${esc(u.aiHandOff.version)} wasn't handed over: ${esc(u.aiHandOff.error)}` : `<b>Shivo Labs AI ${esc(u.aiHandOff.version)} is ready.</b> Open it and click <b>Update ready</b>.`}</p>` : ''}
        ${u.available?.notes?.length ? `<ul class="set-notes">${u.available.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="set-acts">
          <button class="btn sm" id="chk">${svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>')}Check now</button>
          ${u.available ? `<button class="btn pri sm" id="inst">${u.available.restart ? 'Install and restart' : 'Install now'}</button>` : ''}
          ${u.aiHandOff && !u.aiHandOff.error ? `<button class="btn sm" id="openAi">Open Shivo Labs AI</button>` : ''}
        </div>
      </section>

      <section class="card set-card">
        <h3>Look</h3>
        <div class="set-row"><span>Theme</span><div class="seg" id="theme">${['light', 'dark', 'auto'].map((t) => `<button data-t="${t}" class="${theme === t ? 'on' : ''}">${t === 'auto' ? 'Automatic' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      </section>

      <section class="card set-card">
        <h3>Start with Windows</h3>
        <div class="set-row"><span><b>Start quietly when Windows starts</b><small>So an iPhone can always send files with Beam. No window opens.</small></span><button class="sw${s.startup ? ' on' : ''}" id="startup" aria-label="Start with Windows"></button></div>
      </section>

      <section class="card set-card">
        <h3>Apps</h3>
        ${list.map((m) => `<div class="set-row"><span class="set-app">${m.mark ? `<span class="mod-ic sm mark-ic">${shivoMark()}</span>` : `<span class="mod-ic sm"><svg viewBox="0 0 24 24">${m.icon}</svg></span>`}<b>${esc(m.name)}</b></span><span class="set-state">${!m.installed ? 'Not installed' : m.running ? '<i class="dot"></i>On' : m.running === false ? 'Off' : 'Ready'}</span></div>`).join('')}
        <div class="set-row"><span><b>Shivo Labs AI settings</b><small>API keys, models, research, GitHub, secrets</small></span><button class="btn sm" id="aiSet">Open</button></div>
      </section>

      <section class="card set-card">
        <h3>Your data</h3>
        <p class="set-note">Kept on this PC. Updates never touch it.</p>
        ${s.places.map((p, i) => `<div class="set-row"><span><b>${esc(p.app)}</b><small>${esc(p.what)}</small></span>${p.exists ? `<button class="tbtn" data-rv="${i}">${svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}Show</button>` : '<span class="set-state">Nothing yet</span>'}</div>`).join('')}
      </section>

      <section class="set-foot"><button class="tbtn" id="restart">Restart Shivo Labs</button></section>`;

    $('#openAi')?.addEventListener('click', () => openModule('ai'));
    $('#chk').onclick = async () => { s.update.checking = true; paint(); s.update = await post('/api/settings/check'); paint(); toast(s.update.available ? 'An update is ready' : s.update.error ? "Couldn't check" : "You're up to date"); };
    const inst = $('#inst');
    if (inst) inst.onclick = async () => {
      inst.disabled = true; inst.textContent = 'Installing…';
      const r = await post('/api/settings/install');
      if (r.ok && r.reload) return quietReload();            // screens only: no restart
      if (r.ok) return waitThenReload(toast);                 // the server restarts behind a calm cover
      inst.disabled = false; inst.textContent = 'Install and restart';
      toast(r.error || "Couldn't install");
    };
    $('#theme').onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b) return; setTheme(b.dataset.t); paint(); };
    $('#startup').onclick = async () => { const r = await post('/api/settings/startup', { on: !s.startup }); s.startup = r.startup; paint(); toast(s.startup ? 'Shivo Labs will start with Windows' : "Shivo Labs won't start with Windows"); };
    $('#aiSet').onclick = () => openModule('ai', false, { aiSettings: true });
    root.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = () => post('/api/settings/reveal', { i: b.dataset.rv })));
    $('#restart').onclick = async () => { await post('/api/settings/restart'); waitThenReload(toast, 'Restarting Shivo Labs…'); };
  }

  load();
  const t = setInterval(() => { if (s && (s.update.checking || s.update.installing)) load(); }, 1500);
  return () => { alive = false; clearInterval(t); };
}
