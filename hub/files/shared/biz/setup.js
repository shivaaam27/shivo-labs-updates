// First run: when /api/business/session says ready:false, one friendly page sets up the company and its owner.
// The server adds the Tanzania template (VAT 18 %, units, payment methods, chart of accounts, a main store).
import { esc, svg, I, busy, errText } from './ui.js';

const FIELDS = [
  { key: 'name', label: 'Business name', required: true, ph: 'e.g. Mlimani Wholesalers', group: 'c' },
  { key: 'tin', label: 'TIN', ph: '123-456-789', help: 'Taxpayer Identification Number from TRA (9 digits)', mode: 'numeric', max: 11, group: 'c' },
  { key: 'vrn', label: 'VRN', ph: 'e.g. 40-012345-A', help: 'Only if registered for VAT', group: 'c' },
  { key: 'phone', label: 'Phone', ph: '07XX XXX XXX', type: 'tel', group: 'c' },
  { key: 'address', label: 'Address', ph: 'Street, area, city', wide: true, group: 'c' },
  { key: 'owner', label: 'Your name', required: true, ph: 'The owner', group: 'o' },
  { key: 'pin', label: 'PIN', required: true, type: 'password', mode: 'numeric', max: 8, help: '4 to 8 digits. You use it to switch to your user.', group: 'o' },
  { key: 'pin2', label: 'PIN again', required: true, type: 'password', mode: 'numeric', max: 8, group: 'o' },
];

/** mountSetup(root, { api, toast, done(session) }) */
export function mountSetup(root, { api, toast, done }) {
  const field = (f) => `<div class="bz-fld${f.wide ? ' wide' : ''}" data-key="${f.key}"><label class="bz-lbl" for="bzs-${f.key}">${esc(f.label)}${f.required ? '<i class="req">*</i>' : ''}</label>
    <input class="bz-in" id="bzs-${f.key}" type="${f.type || 'text'}"${f.mode ? ` inputmode="${f.mode}"` : ''}${f.max ? ` maxlength="${f.max}"` : ''} placeholder="${esc(f.ph || '')}" autocomplete="off">
    ${f.help ? `<small class="bz-help">${esc(f.help)}</small>` : ''}<small class="bz-ferr" role="alert"></small></div>`;
  root.innerHTML = `<div class="bz-setup">
    <form class="bz-setcard" novalidate>
      <div class="bz-setmark" id="bzSetMark"></div>
      <h1>Set up your business<span>One page, then you're ready. You can change all of it later in Setup.</span></h1>
      <div class="bz-formerr" role="alert" hidden></div>
      <section class="bz-sec"><h3>The business</h3><div class="bz-grid c2">${FIELDS.filter((f) => f.group === 'c').map(field).join('')}</div></section>
      <section class="bz-sec"><h3>You, the owner</h3><div class="bz-grid c2">${FIELDS.filter((f) => f.group === 'o').map(field).join('')}</div></section>
      <div class="bz-setnote">${svg(I.info)}<p>We'll add Tanzania's basics for you: <b>VAT 18 %</b>, common units (Pcs, Kg, Carton…), payment methods (cash, M-Pesa, Mixx, Airtel Money, HaloPesa, bank, card), a <b>chart of accounts</b> and a <b>main store</b>.</p></div>
      <button class="btn pri" type="submit" id="bzSetGo">${svg(I.check)}Set up my business</button>
    </form></div>`;
  const form = root.querySelector('form');
  try { root.querySelector('#bzSetMark').innerHTML = window.shivoMark ? window.shivoMark('play loop') : ''; } catch {}
  const val = (k) => root.querySelector(`#bzs-${k}`).value.trim();
  const err = (k, m) => { const f = root.querySelector(`[data-key="${k}"]`); f.classList.toggle('bad', !!m); f.querySelector('.bz-ferr').textContent = m || ''; };
  root.querySelector('#bzs-name').focus();

  form.onsubmit = (e) => {
    e.preventDefault();
    const btn = root.querySelector('#bzSetGo');
    busy(btn, async () => {
      FIELDS.forEach((f) => err(f.key, ''));
      const box = root.querySelector('.bz-formerr'); box.hidden = true;
      const bad = {};
      for (const f of FIELDS) if (f.required && !val(f.key)) bad[f.key] = 'Required';
      const tin = val('tin').replace(/\D/g, '');
      if (val('tin') && tin.length !== 9) bad.tin = 'A TIN has 9 digits';
      if (val('pin') && !/^\d{4,8}$/.test(val('pin'))) bad.pin = 'Use 4 to 8 digits';
      if (!bad.pin && val('pin') !== val('pin2')) bad.pin2 = "The two PINs don't match";
      if (Object.keys(bad).length) { Object.entries(bad).forEach(([k, m]) => err(k, m)); root.querySelector('.bz-fld.bad input')?.focus(); return; }
      const company = { name: val('name'), tin: val('tin') || null, vrn: val('vrn') || null, phone: val('phone') || null, address: val('address') || null };
      try {
        const r = await api.setup({ company, owner: { name: val('owner'), pin: val('pin') } });
        toast(`${company.name} is set up`);
        done(r?.session || (r?.user ? r : null));
      } catch (e2) {
        if (e2.errors) {
          for (const [k, m] of Object.entries(e2.errors)) {
            const key = k.replace(/^(company|owner)\./, '').replace(/^owner$/, 'owner');
            const fk = key === 'name' && k.startsWith('owner') ? 'owner' : key;
            if (root.querySelector(`[data-key="${fk}"]`)) err(fk, String(m)); else { box.hidden = false; box.insertAdjacentHTML('beforeend', `<p>${esc(m)}</p>`); }
          }
        } else { box.hidden = false; box.innerHTML = `<p>${esc(errText(e2))}</p>`; }
        if (e2.status === 409) { toast('This business is already set up'); done(null); }
      }
    });
  };
}
