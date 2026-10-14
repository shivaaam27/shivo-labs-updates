// Import shipment page (phase 5c, blueprint 04 §7): shown on an import shipment's record view, above its fields.
// What the server works out (store/imports.ts, GET /shipment/:id): the goods arrived with their landed cost per unit
// now and after costing, what the cost lines add (to the goods, import VAT, expenses, deposits, still estimated), the
// customs value and the import VAT base; and "Cost it", which posts one landed cost for all the cost lines (costing
// again undoes the earlier one in the same go). "Share duty by HS code" fills a cost line typed per line by each
// line's value x its duty rate.
import { esc, svg, I, busy, errText, fmt, qty, confirmBox } from './ui.js';
import { PANELS } from './form.js';

const tzs = (n) => (n === null || n === undefined ? '—' : 'TZS ' + fmt(n));
const unit = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Dar es Salaam
const KIND = { purchase_receipt: 'Goods arrived', purchase_invoice: 'Supplier bill', purchase_order: 'Purchase order' };

PANELS.import_shipment = (col, kit, doc, reload) => {
  if (!col) return;
  const sec = document.createElement('section');
  sec.className = 'card bz-sec';
  sec.innerHTML = '<h3>Goods and landed cost</h3><div class="bz-loading"><span class="bz-spin"></span></div>';
  col.prepend(sec);
  const rights = kit.stepRights;
  const mayCost = kit.can('import_shipment', 'write') && (!rights || (rights.kinds ? !!rights.kinds.landed_cost : !!rights.write));
  load();

  async function load() {
    let v;
    try { v = await kit.api.shipment(doc.id); } catch (e) {
      sec.innerHTML = `<h3>Goods and landed cost</h3><p class="bz-err">${esc(errText(e))}</p>`;
      return;
    }
    if (!sec.isConnected) return;
    const t = (id) => v.titles?.[id] ?? id;
    const manual = v.costs.filter((c) => c.distribute === 'By hand per line' && (!c.treatment || c.treatment === 'Add to the cost of the goods'));
    const hasHs = v.goods.some((g) => g.dutyWeight);
    const sh = v.shipment;
    sec.innerHTML = `<h3>Goods and landed cost</h3>
      <p class="bz-p">${[`<span class="bz-pill${sh.status === 'Costed' ? ' ok' : ''}">${esc(sh.status)}</span>`,
        sh.late ? `<span class="bz-pill bad">Late: expected ${esc(sh.eta)}</span>` : '',
        v.costed ? `Costed by landed cost <b class="bz-mono">${esc(v.costed)}</b>` : 'Not costed yet',
      ].filter(Boolean).join(' ')}</p>
      <div class="bz-kpis">
        <section class="card bz-k"><small>Goods (at their cost)</small><b>${tzs(v.totals.goods)}</b></section>
        <section class="card bz-k"><small>Added to the goods</small><b>${tzs(v.totals.toGoods)}</b></section>
        <section class="card bz-k"><small>Import VAT (claimed back)</small><b>${tzs(v.totals.vat)}</b></section>
        <section class="card bz-k"><small>Expenses · deposits</small><b>${tzs(v.totals.expense)} · ${tzs(v.totals.deposit)}</b></section>
        <section class="card bz-k"><small>Still estimated (no bill named)</small><b class="${v.totals.estimated ? 'bad' : 'ok'}">${tzs(v.totals.estimated)}</b></section>
      </div>
      ${v.customs.value !== null ? `<p class="bz-note">Customs value ${tzs(v.customs.value)}${v.customs.rate ? ` (CIF ${unit(v.customs.cif)} USD at ${unit(v.customs.rate)})` : ''};
        import VAT base with duty and excise ${tzs(v.customs.vatBase)}${v.customs.vatDue !== null ? `, so import VAT of about ${tzs(v.customs.vatDue)} (${esc(v.customs.vatRate)} %) against ${tzs(v.totals.vat)} typed` : ''}.</p>` : ''}
      ${!v.companyVatRegistered && v.totals.vat ? '<p class="bz-note">The company has no VRN: if it is not registered for VAT, book import VAT into the cost of the goods (its cost type) instead of claiming it back.</p>' : ''}
      ${v.goods.length ? `<div class="bz-mini" style="--cols:6"><div class="bz-mr bz-mh"><span>Product</span><span>HS code</span><span>Qty</span><span>Cost per unit</span><span>Landed now</span><span>After costing</span></div>
        ${v.goods.map((g) => `<div class="bz-mr"><span data-l="Product">${esc(t(g.item))}<br><small class="bz-muted">${esc(g.receipt)} · line ${g.line + 1}${g.origin ? ' · ' + esc(g.origin) : ''}</small></span>
          <span data-l="HS code">${g.hsNumber ? `${esc(g.hsNumber)}${g.dutyRate !== null ? ` <small class="bz-muted">${esc(g.dutyRate)} %</small>` : ''}` : '—'}</span>
          <span data-l="Qty">${qty(g.qty)}</span><span data-l="Cost per unit">${unit(g.rate)}</span><span data-l="Landed now">${unit(g.perUnitNow)}</span>
          <span data-l="After costing"><b>${unit(g.perUnitNew)}</b></span></div>`).join('')}</div>`
        : '<p class="bz-muted">Name the goods arrived below (Edit): the costs are added to them.</p>'}
      ${v.docs.length ? `<p class="bz-note">${v.docs.map((d) => `${esc(KIND[d.kind] || 'Document')} <span class="bz-mono">${esc(d.id)}</span>${d.date ? ' of ' + esc(d.date) : ''}${d.supplier ? ' · ' + esc(t(d.supplier)) : ''}${d.undone ? ' (undone)' : ''}`).join(' · ')}</p>` : ''}
      ${v.preview.ok ? '' : `<div class="bz-err">${esc(v.preview.problem)}</div>`}
      ${mayCost ? `<div class="bz-acts2">
        ${manual.length && hasHs ? `<button class="btn sm" id="bzImpHs">${svg(I.edit)}Share ${esc(t(manual[0].charge))} by HS code</button>` : ''}
        <label class="bz-fld" style="margin:0"><span class="bz-sr">Date of the landed cost</span><input class="bz-in" type="date" id="bzImpDate" value="${today()}" max="${today()}"></label>
        <button class="btn pri sm" id="bzImpCost"${v.preview.ok && v.goods.length && v.costs.length ? '' : ' disabled'}>${svg(I.arrived)}${v.costed ? 'Cost again' : 'Cost it'}</button></div>` : ''}`;

    sec.querySelector('#bzImpCost')?.addEventListener('click', (e) => cost(e.currentTarget, v));
    sec.querySelector('#bzImpHs')?.addEventListener('click', (e) => byHs(e.currentTarget, v, manual[0]));
  }

  async function cost(btn, v) {
    const again = !!v.costed;
    const ok = await confirmBox({ title: again ? 'Cost this shipment again?' : 'Cost this shipment?', icon: I.arrived, ok: again ? 'Cost again' : 'Cost it',
      text: `${tzs(v.totals.toGoods)} goes into the cost of the goods (what was already sold gets its share in cost of goods sold); import VAT, expenses and deposits are booked on their accounts.${again ? ' The earlier landed cost is undone in the same go.' : ''}` });
    if (!ok) return;
    await busy(btn, async () => {
      try {
        const r = await kit.api.costShipment(doc.id, sec.querySelector('#bzImpDate')?.value || undefined);
        kit.toast(`Costed ✓ (landed cost ${r.step.id})`);
        reload();
      } catch (e) { kit.toast(errText(e)); }
    });
  }

  // a cost line typed per line (duty) shared by each line's value x its HS code's duty rate; the cent left over on the last
  async function byHs(btn, v, c) {
    const lines = v.goods.filter((g) => g.dutyWeight);
    let left = c.amount;
    const shares = lines.map((g, i) => {
      const a = i === lines.length - 1 ? Math.round(left * 100) / 100 : Math.round(c.amount * g.dutyWeight * 100) / 100;
      left -= a;
      return { cost: c.line, receipt: g.receipt, line: g.line + 1, amount: a };
    });
    await busy(btn, async () => {
      try {
        const cur = (await kit.api.doc('import_shipment', doc.id))?.doc;
        const others = (cur?.shares || []).filter((s) => Number(s.cost) !== c.line);
        await kit.api.save('import_shipment', { id: doc.id, _meta: cur?._meta, shares: [...others, ...shares] });
        kit.toast('Shared by HS code ✓');
        reload();
      } catch (e) { kit.toast(errText(e)); }
    });
  }
};
