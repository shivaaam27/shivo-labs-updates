// Insights: the website's visitors (shivolabs.com), one screen for the phone app and the laptop hub (the hub shows
// this file at /phone/insights/). The numbers come from the website's own dashboard data (its /api/apps/insights,
// read through the Shivo Labs shelf on Cloudflare); the caller says how to fetch them:
//   mountInsights(root, { load: (range) => Promise<data>, toast, haptic }) -> { start, stop }
// One column on a phone; wider screens (container from 720px) put the numbers in one row and the lists side by side.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  again: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
  up: svg('<path d="M7 17 17 7M9 7h8v8"/>'), down: svg('<path d="M7 7l10 10M17 9v8H9"/>'),
  link: svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>'),
  cloud: svg('<path d="M7 18a4.5 4.5 0 0 1-.8-8.93A6 6 0 0 1 17.6 8.5 4 4 0 0 1 17 18z"/>'),
};
const RANGES = [['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d'], ['12m', '12m']];
const SHORT = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '12 months' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PLURAL = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// the lists shown, in order, and what their number counts
const LISTS = [['pages', 'Pages', 'Views'], ['referrers', 'Where visitors come from', 'Visitors'], ['countries', 'Countries', 'Visitors'],
  ['cities', 'Cities', 'Visitors'], ['entries', 'First page seen', 'Visits'], ['browsers', 'Browsers', 'Visitors'], ['os', 'Systems', 'Visitors'], ['events', 'Actions', 'Times']];
const SEGS = [['devices', 'Devices'], ['languages', 'Languages']];

const num = (n) => Math.round(n || 0).toLocaleString('en');
const big = (n) => (n >= 10000 ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : num(n));
const pct = (n) => `${Math.round((n || 0) * 100)}%`;
const dur = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
// a flag on the phone; Windows has no flag emoji, so there the country's two letters
const FLAGS = !/Windows/.test(navigator.userAgent);
const flag = (c) => (/^[A-Z]{2}$/i.test(c || '') ? (FLAGS ? String.fromCodePoint(...c.toUpperCase().split('').map((x) => 127397 + x.charCodeAt(0))) : c.toUpperCase()) : '');
const flagTag = (c) => (flag(c) ? `<i class="ins-flag${FLAGS ? '' : ' code'}">${flag(c)}</i>` : '');
const change = (now, before) => (before ? (now - before) / before : now ? 1 : 0);
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function when(t, unit, long) {
  const d = new Date(t);
  if (unit === 'hour') return (long ? `${DAYS[(d.getDay() + 6) % 7]} ` : '') + clock(t);
  if (unit === 'month') return MONTHS[d.getMonth()] + (long ? ` ${d.getFullYear()}` : '');
  return `${long ? DAYS[(d.getDay() + 6) % 7] + ' ' : ''}${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function mountInsights(root, { load, toast = () => {}, haptic = () => {} }) {
  let range = (() => { try { return localStorage.getItem('insights.range') || '7d'; } catch { return '7d'; } })();
  let metric = 'visitors', data = null, busy = false, timer = null, alive = false, first = true, open = {};
  root.innerHTML = `<div class="ins">
    <header class="ins-top">
      <div><p class="ins-eye" id="insSite">${IC.globe}<span>shivolabs.com</span></p><h1 class="ins-h">Insights</h1></div>
      <button class="ins-again" id="insAgain" aria-label="Refresh">${IC.again}</button>
    </header>
    <div class="ins-seg" id="insSeg" role="tablist">${RANGES.map(([k, l]) => `<button role="tab" data-r="${k}"${k === range ? ' class="on"' : ''}>${l}</button>`).join('')}<i class="ins-seg-pill"></i></div>
    <div id="insBody">${skeleton()}</div>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const seg = $('#insSeg');
  const pill = () => { const b = seg.querySelector('.on'); const p = seg.querySelector('.ins-seg-pill'); if (b && p) { p.style.width = b.offsetWidth + 'px'; p.style.transform = `translateX(${b.offsetLeft}px)`; } };
  seg.onclick = (e) => {
    const b = e.target.closest('[data-r]'); if (!b || b.dataset.r === range) return;
    haptic('light'); range = b.dataset.r; try { localStorage.setItem('insights.range', range); } catch {}
    seg.querySelectorAll('[data-r]').forEach((x) => x.classList.toggle('on', x === b)); pill();
    refresh();
  };
  $('#insAgain').onclick = () => { haptic('light'); refresh(true); };

  async function refresh(fresh = false, quiet = false) {
    if (busy) return; busy = true;
    const want = range;
    root.querySelector('.ins').classList.add('busy');
    try {
      const d = await load(want);
      if (!alive && !first) return;
      if (want !== range) return;
      data = d; root.querySelector('.ins').classList.toggle('calm', quiet); paint();
      if (fresh && !d.error && !d.stale) toast('Up to date');
    } catch (e) { data = { error: 'offline', message: e.message }; paint(); }
    finally { busy = false; first = false; root.querySelector('.ins')?.classList.remove('busy'); if (want !== range) refresh(); }
  }

  function paint() {
    const body = $('#insBody'), d = data;
    if (d?.error) {
      const setup = d.error === 'setup';
      body.innerHTML = `<div class="ins-empty card"><span class="ins-empty-ic">${setup ? IC.cloud : IC.globe}</span>
        <h2>${setup ? 'Not connected yet' : "Couldn't reach the website"}</h2>
        <p>${setup ? 'Insights come through Shivo Labs Cloud, which isn\'t set up on this device.' : esc(d.message || 'Check the connection and try again.')}</p>
        ${setup ? '' : '<button class="btn pri" id="insRetry">Try again</button>'}</div>`;
      $('#insRetry')?.addEventListener('click', () => refresh(true));
      return;
    }
    const t = d.totals, p = d.previous, short = SHORT[d.range] || '';
    if (d.site?.name) $('#insSite span').textContent = d.site.name;
    const kpi = (k, label, now, before, show, lowerBetter) => {
      const c = change(now, before), good = lowerBetter ? c < 0 : c > 0, flat = Math.abs(c) < 0.005;
      return `<div class="ins-kpi${metric === k ? ' on' : ''}" ${k ? `data-m="${k}" role="button" tabindex="0"` : ''}>
        <small>${label}</small><b data-count="${now}" data-kind="${show}">${fmtKind(now, show)}</b>
        <span class="ins-delta ${flat ? '' : good ? 'good' : 'bad'}">${flat ? 'Same as before' : `${c > 0 ? IC.up : IC.down}${Math.abs(Math.round(c * 100))}%`}</span></div>`;
    };
    body.innerHTML = `
      ${d.source === 'sample' ? `<p class="ins-note warn">Sample numbers: the website couldn't read its visit data.</p>` : ''}
      ${d.stale ? `<p class="ins-note">Showing the numbers from ${clock(d.at)}. The website can't be reached right now.</p>` : ''}
      <div class="ins-live${d.live ? ' on' : ''}"><i class="dot"></i><span><b>${num(d.live)}</b> on the site now</span>${(d.liveCountries || []).slice(0, 3).map((c) => `<em>${flagTag(c.code)} ${esc(c.label)}</em>`).join('')}</div>
      <p class="ins-sum">${esc(summary(d))}</p>
      <div class="ins-kpis">
        ${kpi('visitors', 'Visitors', t.visitors, p.visitors, 'n')}
        ${kpi('pageviews', 'Page views', t.pageviews, p.pageviews, 'n')}
        ${kpi('', 'Visits', t.visits, p.visits, 'n')}
        ${kpi('', 'Time per visit', t.avgVisit, p.avgVisit, 'd')}
        ${kpi('', 'Left after one page', t.bounceRate, p.bounceRate, 'p', true)}
      </div>
      <section class="ins-card card ins-chart-card">
        <div class="ins-card-h"><h3>${metric === 'visitors' ? 'Visitors' : 'Page views'}</h3><span class="ins-key"><i></i>Last ${short}<i class="prev"></i>The ${short} before</span></div>
        <div class="ins-chart" id="insChart"></div>
      </section>
      <div class="ins-grid">
        <section class="ins-card card"><div class="ins-card-h"><h3>Busiest times</h3><small>Last 4 weeks</small></div>${rhythm(d.rhythm)}</section>
        <section class="ins-card card"><div class="ins-card-h"><h3>The last 12 months</h3><small>Visitors a day</small></div>${skyline(d.year)}</section>
      </div>
      <div class="ins-lists">
        ${LISTS.map(([k, title, unit]) => list(k, title, unit, d.lists?.[k] || [])).join('')}
        ${SEGS.map(([k, title]) => segments(title, d.lists?.[k] || [])).join('')}
      </div>
      <p class="ins-foot">Updated ${clock(d.at || Date.now())} · ${d.source === 'own' ? 'from the website\'s own visit records' : d.source === 'umami' ? 'from Umami' : 'sample'}${d.note ? ` · ${esc(d.note)}` : ''}</p>`;
    chart();
    body.querySelectorAll('[data-m]').forEach((k) => (k.onclick = k.onkeydown = (e) => {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      if (metric === k.dataset.m) return; haptic('light'); metric = k.dataset.m;
      body.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === k));
      body.querySelector('.ins-chart-card h3').textContent = metric === 'visitors' ? 'Visitors' : 'Page views'; chart();
    }));
    body.querySelectorAll('[data-more]').forEach((b) => (b.onclick = () => { open[b.dataset.more] = !open[b.dataset.more]; paint(); }));
    if (first) countUp(body);
  }

  // the main chart: this period as an area, the period before as a dashed line; touch or hover for each point
  function chart() {
    const el = $('#insChart'); if (!el || !data?.series) return;
    const s = data.series, ps = data.prevSeries || [], W = 600, H = 190, n = s.length;
    const max = Math.max(1, ...s.map((x) => x[metric]), ...ps.map((x) => x[metric]));
    const top = nice(max);
    const X = (i) => (n < 2 ? W / 2 : (i / (n - 1)) * W), Y = (v) => H - (v / top) * (H - 8);
    const line = (arr) => arr.map((x, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(x[metric]).toFixed(1)}`).join('');
    const cur = line(s);
    const ticks = [0, 0.5, 1].map((f) => Math.round(top * f));
    const every = Math.max(1, Math.ceil(n / (el.clientWidth < 520 ? 4 : 6)));   // fewer dates on a phone
    el.innerHTML = `<div class="ins-ylab">${ticks.slice().reverse().map((v) => `<span>${big(v)}</span>`).join('')}</div>
      <div class="ins-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="insFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--sage)" stop-opacity=".28"/><stop offset="1" stop-color="var(--sage)" stop-opacity="0"/></linearGradient></defs>
        ${ticks.map((v) => `<line class="ins-gl" x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}
        ${ps.length === n ? `<path class="ins-prev" d="${line(ps)}"/>` : ''}
        <path class="ins-area" d="${cur}L${X(n - 1)},${H}L${X(0)},${H}Z" fill="url(#insFill)"/>
        <path class="ins-line" d="${cur}"/>
      </svg><i class="ins-cross" hidden></i><i class="ins-pt" hidden></i><div class="ins-tip" hidden></div>
      <div class="ins-xlab">${s.map((x, i) => (i % every === 0 && (n - 1 - i >= every / 2 || i === 0) ? `<span style="left:${(X(i) / W) * 100}%">${when(x.t, data.unit)}</span>` : '')).join('')}</div></div>`;
    const plot = el.querySelector('.ins-plot'), tip = el.querySelector('.ins-tip'), cross = el.querySelector('.ins-cross'), pt = el.querySelector('.ins-pt');
    const show = (cx) => {
      const r = plot.getBoundingClientRect(); const i = Math.max(0, Math.min(n - 1, Math.round(((cx - r.left) / r.width) * (n - 1))));
      const x = (X(i) / W) * 100, y = (Y(s[i][metric]) / H) * 100, prev = ps[i]?.[metric];
      cross.hidden = pt.hidden = tip.hidden = false;
      cross.style.left = pt.style.left = x + '%'; pt.style.top = y + '%';
      tip.innerHTML = `<small>${when(s[i].t, data.unit, true)}</small><b>${num(s[i][metric])}</b>${prev != null ? `<span>${num(prev)} the ${SHORT[data.range]} before</span>` : ''}`;
      tip.style.left = Math.min(Math.max(x, 18), 82) + '%';
    };
    const hide = () => { cross.hidden = pt.hidden = tip.hidden = true; };
    plot.onpointermove = (e) => show(e.clientX); plot.onpointerdown = (e) => show(e.clientX); plot.onpointerleave = hide;
  }

  function list(key, title, unit, rows) {
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => r.value), 1), all = rows.reduce((a, r) => a + r.value, 0) || 1, more = open[key];
    const shown = more ? rows : rows.slice(0, 6);
    return `<section class="ins-card card ins-list"><div class="ins-card-h"><h3>${title}</h3><small>${unit}</small></div>
      <ol>${shown.map((r) => `<li style="--w:${(r.value / max) * 100}%"><span class="ins-lab">${key === 'countries' ? flagTag(r.code) : ''}${esc(r.label)}</span><b>${num(r.value)}</b><em>${Math.round((r.value / all) * 100)}%</em></li>`).join('')}</ol>
      ${rows.length > 6 ? `<button class="ins-more" data-more="${key}">${more ? 'Show fewer' : `Show all ${rows.length}`}</button>` : ''}</section>`;
  }
  function segments(title, rows) {
    if (!rows.length) return '';
    const all = rows.reduce((a, r) => a + r.value, 0) || 1, top = rows.slice(0, 4);
    const rest = all - top.reduce((a, r) => a + r.value, 0);
    const parts = [...top, ...(rest > 0 ? [{ label: 'Other', value: rest }] : [])];
    return `<section class="ins-card card ins-segs"><div class="ins-card-h"><h3>${title}</h3><small>Visitors</small></div>
      <div class="ins-bar">${parts.map((r, i) => `<i style="flex:${r.value};--o:${1 - i * 0.2}"></i>`).join('')}</div>
      <ul>${parts.map((r, i) => `<li style="--o:${1 - i * 0.2}"><i></i>${esc(r.label)}<b>${Math.round((r.value / all) * 100)}%</b></li>`).join('')}</ul></section>`;
  }

  function start() {
    alive = true; requestAnimationFrame(pill);
    refresh();
    clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === 'visible' && !data?.error) refresh(false, true); }, 60000);   // quietly: no entrance animations
  }
  function stop() { alive = false; clearInterval(timer); timer = null; }
  addEventListener('resize', pill);
  return { start, stop };
}

function fmtKind(v, kind) { return kind === 'd' ? dur(v) : kind === 'p' ? pct(v) : big(v); }
function nice(v) { const e = 10 ** Math.floor(Math.log10(v)), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }

// one short line on what changed and where people came from
function summary(d) {
  const t = d.totals, c = change(t.visitors, d.previous.visitors), short = SHORT[d.range];
  if (!t.visitors) return `No visitors in the last ${short}.`;
  const trend = Math.abs(c) < 0.005 ? `the same as the ${short} before` : `${c > 0 ? 'up' : 'down'} ${Math.abs(Math.round(c * 100))}% on the ${short} before`;
  const country = d.lists?.countries?.[0]?.label, ref = (d.lists?.referrers || []).find((r) => r.label && r.label !== 'Direct or unknown')?.label;
  return `${num(t.visitors)} ${t.visitors === 1 ? 'visitor' : 'visitors'}, ${trend}.${country ? ` Most from ${country}` : ''}${ref ? `${country ? ', most' : ' Most'} linked from ${ref}` : ''}${country || ref ? '.' : ''}`;
}

// page views by weekday and hour (0 = Monday), sage the busier it is
function rhythm(r) {
  if (!r?.length) return '<p class="ins-none">Nothing yet.</p>';
  const max = Math.max(1, ...r.flat());
  let bd = 0, bh = 0; r.forEach((row, d) => row.forEach((v, h) => { if (v > r[bd][bh]) { bd = d; bh = h; } }));
  return `<div class="ins-week">${r.map((row, d) => `<span class="ins-wd">${DAYS[d][0]}</span>${row.map((v, h) => `<i title="${DAYS[d]} ${String(h).padStart(2, '0')}:00 · ${num(v)} views" style="--o:${v ? 0.12 + (v / max) * 0.88 : 0}"></i>`).join('')}`).join('')}
    <span></span>${[0, 6, 12, 18].map((h) => `<span class="ins-hr" style="grid-column:${h + 2} / span 6">${String(h).padStart(2, '0')}</span>`).join('')}</div>
    ${r[bd][bh] ? `<p class="ins-cap">Busiest on ${PLURAL[bd]} around ${String(bh).padStart(2, '0')}:00</p>` : ''}`;
}

// visitors each day for a year, as a strip of bars; months underneath
function skyline(year) {
  if (!year?.length) return '<p class="ins-none">Nothing yet.</p>';
  const max = Math.max(1, ...year.map((d) => d.visitors)), n = year.length, total = year.reduce((a, d) => a + d.visitors, 0);
  const best = year.reduce((a, d) => (d.visitors > a.visitors ? d : a), year[0]);
  const marks = []; let m = -1;
  year.forEach((d, i) => { const mm = new Date(d.t).getMonth(); if (mm !== m) { m = mm; if (i > 6 && i < n - 10) marks.push(`<span style="left:${(i / n) * 100}%">${MONTHS[mm]}</span>`); } });
  return `<div class="ins-sky"><svg viewBox="0 0 ${n} 60" preserveAspectRatio="none">${year.map((d, i) => d.visitors ? `<rect x="${i + 0.15}" width=".7" y="${60 - (d.visitors / max) * 58}" height="${(d.visitors / max) * 58}"><title>${when(d.t, 'day', true)} · ${num(d.visitors)}</title></rect>` : '').join('')}</svg>
    <div class="ins-months">${marks.join('')}</div></div>
    <p class="ins-cap">${num(total)} visitors in a year · best day ${when(best.t, 'day')} (${num(best.visitors)})</p>`;
}

function skeleton() {
  return `<div class="ins-skel"><i style="height:20px;width:60%"></i><div class="ins-kpis">${'<i class="ins-kpi"></i>'.repeat(5)}</div><i style="height:240px"></i><i style="height:200px"></i></div>`;
}

// the big numbers count up the first time they show
function countUp(body) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  body.querySelectorAll('[data-count]').forEach((el) => {
    const end = Number(el.dataset.count), kind = el.dataset.kind, t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 700), e = 1 - (1 - k) ** 3; el.textContent = fmtKind(kind === 'n' ? Math.round(end * e) : end * e, kind); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
