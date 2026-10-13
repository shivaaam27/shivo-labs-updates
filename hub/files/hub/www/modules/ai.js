// Shivo Labs AI inside the hub: its own page (it has its own rail and header), full window.
// The page stays loaded while you're elsewhere in the hub, so a working chat keeps going and
// coming back is instant. Its chats live in the window's browser profile, which the hub window
// shares with the old AI window (see Shivo Labs.vbs), so they're all there.
let frame = null, ready = false, homeFn = null, wantSettings = false;
// Settings > Shivo Labs AI settings: ask the AI page to open its own Settings window (as soon as it's ready)
const sendSettings = () => { wantSettings = false; frame.contentWindow.postMessage({ shivo: 'settings' }, new URL(frame.src).origin); };
export function aiSettings() { if (ready && frame?.src) sendSettings(); else wantSettings = true; }

addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  if (e.data?.shivo === 'ready') { ready = true; document.getElementById('aiHome')?.remove(); if (wantSettings) sendSettings(); }
  if (e.data?.shivo === 'home') homeFn?.();
});

export function makeAiPage(goHome) {
  homeFn = goHome;
  return function mountAi(root, { toast, module: m, startModule }) {
    root.innerHTML = '';
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'aiFrame';
      frame.title = 'Shivo Labs AI';
      // what the AI page uses: voice, copy and paste, notifications, opening files
      frame.allow = 'microphone; clipboard-read; clipboard-write; fullscreen';
      document.body.append(frame);
      const wait = document.createElement('div');
      wait.id = 'aiWait';
      wait.innerHTML = `<div class="ai-wait-mark">${shivoMark('loop')}</div><p>Starting Shivo Labs AI…</p>`;
      document.body.append(wait);
      boot(m, startModule, toast);
    }
    frame.hidden = false;
    document.getElementById('aiHome')?.removeAttribute('hidden');
    document.getElementById('aiWait')?.toggleAttribute('hidden', !!frame.src);
    frame.focus();
    // until the AI page says hello (versions before 2.0.0 have no home button), offer one here
    setTimeout(() => {
      if (ready || document.getElementById('aiHome') || frame.hidden) return;
      const b = document.createElement('button');
      b.id = 'aiHome'; b.className = 'gbtn'; b.setAttribute('aria-label', 'Home');
      b.innerHTML = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>';
      b.onclick = () => homeFn?.();
      document.body.append(b);
    }, 5000);
    return () => { frame.hidden = true; document.getElementById('aiHome')?.setAttribute('hidden', ''); document.getElementById('aiWait')?.setAttribute('hidden', ''); };
  };
}

async function boot(m, startModule, toast) {
  // the hub has already asked for its server to start (openModule); wait until it answers (up to 40 s)
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('/api/modules')).json();
      if (list.find((x) => x.id === m.id)?.running) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  frame.src = m.embed;
  frame.onload = () => document.getElementById('aiWait')?.setAttribute('hidden', '');
  setTimeout(() => { if (!frame.contentWindow || !document.getElementById('aiWait')?.hidden) toast("Shivo Labs AI is taking a while to start"); }, 45000);
}
