// Insights inside the hub: the phone app's own Insights screen (phone/www/insights, served by the hub at /phone/), so the
// laptop and the phone show the same thing. Numbers come from api/insights.mjs (through the Cloudflare shelf).
export function mountInsights(root, ctx) {
  if (!document.querySelector('link[data-phoneins]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/phone/insights/insights.css'; l.dataset.phoneins = ''; document.head.appendChild(l);
  }
  let api = null, gone = false;
  const load = async (range) => (await fetch(`/api/insights?range=${encodeURIComponent(range)}`, { cache: 'no-store' })).json();
  import('/phone/insights/insights.js').then((m) => {
    if (gone) return;
    api = m.mountInsights(root, { load, toast: ctx.toast });
    api.start();
  }).catch((e) => { root.innerHTML = `<p class="tv-none">Insights couldn't load (${ctx.esc(e.message)}).</p>`; });
  return () => { gone = true; api?.stop(); };
}
