// Updates without a show: a calm cover while the hub refreshes (and, if needed, its server restarts), and a
// reload that skips the splash and the entrance animations. Like the phone app picking up an over-the-air update.
const KEY = 'shivo-quiet';

function cover(text) {
  let c = document.getElementById('quietCover');
  if (!c) {
    c = document.createElement('div');
    c.id = 'quietCover';
    c.innerHTML = '<div class="qc-box"><span class="qc-spin"></span><span class="qc-text"></span></div>';
    document.body.append(c);
    requestAnimationFrame(() => c.classList.add('on'));
  }
  c.querySelector('.qc-text').textContent = text;
  return c;
}

// reload now, quietly (the next page load sees the flag and skips the splash and animations)
export function quietReload(text = 'Updating Shivo Labs…') {
  cover(text);
  try { sessionStorage.setItem(KEY, '1'); } catch {}
  setTimeout(() => location.reload(), 180);
}

// the server is restarting: keep the cover up until it answers, then reload quietly
export async function waitThenReload(toast, text = 'Updating Shivo Labs…') {
  cover(text);
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch('/api/settings', { cache: 'no-store' })).ok) return quietReload(text); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  document.getElementById('quietCover')?.remove();
  toast("Shivo Labs didn't come back. Open it again from the Desktop");
}

// called first thing on load: true if this load is a quiet one
export function quietStart() {
  let q = false;
  try { q = sessionStorage.getItem(KEY) === '1'; sessionStorage.removeItem(KEY); } catch {}
  if (q) { document.documentElement.classList.add('calm'); setTimeout(() => document.documentElement.classList.remove('calm'), 1500); }
  return q;
}
