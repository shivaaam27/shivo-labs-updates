// Mirror: the iPhone's screen, wirelessly (AirPlay screen mirroring to "Shivo Labs"), any iOS version.
// When the phone connects the picture opens by itself in a floating window (see api/mirror.mjs); this page shows it
// too when that window is closed, and holds the settings and the speed numbers.
import { createPlayer } from "./mirror-player.js";
const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const post = (what, body) => fetch("/api/mirror/" + what, { method: "POST", headers: { "x-hub": "1", "content-type": "application/json" }, body: JSON.stringify(body || {}) });

export function mountMirror(root, { toast }) {
  root.innerHTML = `
    <div class="mr">
      <div class="mr-stage" id="mrStage"><canvas id="mrCanvas" hidden></canvas>
        <div class="mr-wait card" id="mrWait">
          <span class="mod-ic">${svg('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>')}</span>
          <h2>Show your iPhone here</h2>
          <ol><li>iPhone and this PC on the same Wi-Fi.</li><li>On the iPhone, open <b>Control Center</b> (swipe down from the top-right corner).</li><li>Tap <b>Screen Mirroring</b>, then <b id="mrName">Shivo Labs</b>.</li></ol>
          <p class="mr-note" id="mrNote"></p>
          <div class="mr-acts" id="mrActs"></div>
        </div>
      </div>
      <div class="mr-bar"><span id="mrStat">Starting…</span><span class="sp"></span>
        <label class="mr-auto"><input type="checkbox" id="mrAuto"> Float when the phone connects</label>
        <button class="btn sm" id="mrPop" title="The phone in its own window, on top of everything (or double-click the picture)">${svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="7" height="6" rx="1.2"/>')}<span>Float</span></button>
        <details class="mr-log"><summary>Details</summary><pre id="mrLog"></pre></details></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const canvas = $("#mrCanvas");
  let player = null, floating = false, alive = true, last = null;

  // the picture plays here only while the floating window is closed (one decoder at a time)
  function play(on) {
    if (on && !player) { player = createPlayer(canvas, { onError: (m) => { $("#mrLog").textContent += "\n" + m; } }); }
    if (!on && player) { player.stop(); player = null; canvas.hidden = true; }
  }
  const setFloat = async (open) => { await post("float", { open }); setTimeout(status, 600); };
  $("#mrPop").onclick = () => setFloat(!floating);
  canvas.ondblclick = () => setFloat(true);
  $("#mrAuto").onchange = (e) => post("settings", { autoFloat: e.target.checked });

  async function status() {
    let s; try { s = await (await fetch("/api/mirror/status", { cache: "no-store" })).json(); } catch { return; }
    if (!alive) return;
    last = s; floating = s.float;
    play(!floating);
    const showing = !!s.client && !!player && player.drawn() > 0;   // a still screen sends nothing new, so ask the receiver
    $("#mrStage").classList.toggle("floating", floating && !!s.client);
    $("#mrWait").hidden = showing || (floating && !!s.client);
    canvas.hidden = !showing;
    $("#mrPop span").textContent = floating ? "Bring back" : "Float";
    $("#mrAuto").checked = s.autoFloat;
    $("#mrName").textContent = s.name;
    const acts = [];
    let note = "";
    if (!s.running) { note = "The receiver isn't running."; acts.push(`<button class="btn sm" data-a="start">Start it</button>`); }
    else if (s.client && s.paused) note = `${s.client}'s screen is locked or asleep. Unlock it to carry on.`;
    else if (s.client && !showing) note = `Connecting to ${s.client}…`;
    else if (!s.firewall) { note = "If Shivo Labs doesn't appear in Screen Mirroring, Windows' firewall is blocking it. Allow it once (Windows asks you to confirm)."; acts.push(`<button class="btn sm" data-a="firewall">Allow on this network</button>`); }
    $("#mrNote").textContent = note;
    const html = acts.join("");
    if ($("#mrActs").dataset.html !== html) {   // redraw only on change, so a click isn't lost
      $("#mrActs").innerHTML = $("#mrActs").dataset.html = html;
      $("#mrActs").querySelectorAll("[data-a]").forEach((b) => (b.onclick = async () => { await post(b.dataset.a); toast(b.dataset.a === "firewall" ? "Confirm in the Windows prompt" : "Starting…"); setTimeout(status, 1500); }));
    }
    const sp = s.speed || {};
    const speed = sp.drawFps !== undefined ? ` · ${sp.drawFps} fps · ${sp.lagMs} ms delay` : "";
    $("#mrStat").innerHTML = s.client && (showing || floating)
      ? `<i class="dot"></i>${floating ? "Floating" : "Showing"}: ${esc(s.client)} · ${s.codec === "h265" ? "H.265" : "H.264"} · ${s.width}×${s.height}${speed}`
      : s.running ? `<i class="dot"></i>Ready: choose <b>${esc(s.name)}</b> in Screen Mirroring` : "Receiver off";
    $("#mrLog").textContent = [`phone sends ${sp.phoneFps ?? 0} pictures/s, ${sp.kbps ?? 0} kbit/s` +
      (sp.where ? ` · shown in the ${sp.where === "float" ? "floating window" : "hub"}: ${sp.inFps} in/s, ${sp.drawFps} drawn/s, ${sp.lagMs} ms from hub to screen, ${sp.queue} waiting` : ""), "", ...s.log].join("\n");
    // this page's own numbers, when it is the one showing the picture
    if (player && showing) post("seen", { where: "hub", ...player.stats() }).catch(() => {});
  }
  status();
  const timer = setInterval(status, 1000);
  return () => { alive = false; clearInterval(timer); play(false); };
}
