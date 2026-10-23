// Slides artifact runtime: slide list, add/copy/delete/move, drag to reorder, present mode.
// Added to the page when it is shown and taken out again when it is saved (everything it makes is
// marked data-fabra-ui / data-fabra-deck, or has a class starting with fd-).
(function () {
  var deck = document.getElementById("deck");
  if (!deck) return;
  var cur = 0, dragFrom = -1, timer = 0;
  var dyn = document.createElement("style");
  dyn.setAttribute("data-fabra-deck", "");
  document.head.appendChild(dyn);

  function slides() { return Array.prototype.slice.call(deck.querySelectorAll(".slide")); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function button(label, title, fn, host) {
    var b = el("button", "fd-btn", label);
    b.type = "button"; b.title = title;
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });
    b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
    host.appendChild(b);
    return b;
  }
  function dirty() { try { parent.postMessage({ fabra: "dirty" }, "*"); } catch (e) {} }

  var rail = el("div", "fd-rail"), list = el("div", "fd-list"), tools = el("div", "fd-tools");
  var bar = el("div", "fd-bar"), count = el("b", "", "");
  [rail, bar].forEach(function (x) { x.setAttribute("data-fabra-ui", ""); x.contentEditable = "false"; });
  rail.appendChild(list); rail.appendChild(tools);
  button("+ New", "Add a slide after this one", add, tools);
  button("Copy", "Duplicate this slide", dup, tools);
  button("Delete", "Delete this slide", del, tools);
  button("↑", "Move up", function () { move(-1); }, tools);
  button("↓", "Move down", function () { move(1); }, tools);
  button("◀", "Previous slide", function () { show(cur - 1); }, bar);
  button("▶", "Next slide", function () { show(cur + 1); }, bar);
  bar.appendChild(count);
  button("Present (F5)", "Show the slides full screen", present, bar);
  document.body.appendChild(rail); document.body.appendChild(bar);

  function add() {
    var s = document.createElement("section");
    s.className = "slide";
    s.innerHTML = "<h2>New slide</h2><p>Press Edit, then click here and type.</p>";
    slides()[cur].after(s); cur++; changed();
  }
  function dup() {
    var c = slides()[cur].cloneNode(true);
    c.classList.remove("fd-cur");
    slides()[cur].after(c); cur++; changed();
  }
  function del() {
    if (slides().length < 2) return;
    slides()[cur].remove();
    cur = Math.min(cur, slides().length - 1); changed();
  }
  function move(d) {
    var a = slides(), j = cur + d;
    if (j < 0 || j >= a.length) return;
    if (d < 0) a[j].before(a[cur]); else a[j].after(a[cur]);
    cur = j; changed();
  }
  function changed() { dirty(); show(cur); }

  function fit() {
    var pres = document.documentElement.classList.contains("fd-present");
    var left = pres || getComputedStyle(rail).display === "none" ? 0 : 176, top = pres ? 0 : 44, pad = pres ? 0 : 28;
    var w = innerWidth - left - pad * 2, h = innerHeight - top - pad * 2;
    var s = Math.max(0.05, Math.min(w / 1280, h / 720));
    var x = left + (innerWidth - left - 1280 * s) / 2, y = top + (innerHeight - top - 720 * s) / 2;
    dyn.textContent = "@media screen{#deck .slide.fd-cur{left:" + x.toFixed(1) + "px!important;top:" + y.toFixed(1) + "px!important;transform:scale(" + s.toFixed(4) + ")!important}}";
  }

  function drawRail() {
    var a = slides();
    list.textContent = "";
    a.forEach(function (s, i) {
      var t = el("div", "fd-th" + (i === cur ? " sel" : "")), inner = el("div", "fd-thin"), c = s.cloneNode(true);
      c.classList.remove("fd-cur");
      inner.appendChild(c); t.appendChild(inner); t.appendChild(el("i", "", String(i + 1)));
      t.draggable = true;
      t.addEventListener("click", function () { show(i); });
      t.addEventListener("dragstart", function (e) { dragFrom = i; try { e.dataTransfer.setData("text/plain", String(i)); } catch (x) {} });
      t.addEventListener("dragover", function (e) { e.preventDefault(); t.classList.add("over"); });
      t.addEventListener("dragleave", function () { t.classList.remove("over"); });
      t.addEventListener("drop", function (e) {
        e.preventDefault(); t.classList.remove("over");
        var all = slides();
        if (dragFrom < 0 || dragFrom === i || !all[dragFrom]) return;
        if (dragFrom < i) all[i].after(all[dragFrom]); else all[i].before(all[dragFrom]);
        cur = i; dragFrom = -1; changed();
      });
      list.appendChild(t);
    });
  }

  function show(i) {
    var a = slides();
    if (!a.length) return;
    cur = Math.max(0, Math.min(i, a.length - 1));
    a.forEach(function (s, k) { s.classList.toggle("fd-cur", k === cur); });
    count.textContent = "Slide " + (cur + 1) + " of " + a.length;
    fit(); drawRail();
    var sel = list.querySelector(".sel");
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
  }

  function present() {
    try { document.designMode = "off"; } catch (e) {}
    document.documentElement.classList.add("fd-present");
    try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {}); } catch (e) {}
    fit();
  }
  function leave() {
    document.documentElement.classList.remove("fd-present");
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    fit();
  }
  var isPresent = function () { return document.documentElement.classList.contains("fd-present"); };

  document.addEventListener("keydown", function (e) {
    if (e.key === "F5") { e.preventDefault(); present(); return; }
    if (e.key === "Escape" && isPresent()) { leave(); return; }
    var typing = document.designMode === "on" && !isPresent();
    if (typing) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); show(cur + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); show(cur - 1); }
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(1e9);
  });
  document.addEventListener("click", function (e) {
    if (!isPresent()) return;
    show(e.clientX < innerWidth * 0.3 ? cur - 1 : cur + 1);
  });
  document.addEventListener("fullscreenchange", function () { if (!document.fullscreenElement && isPresent()) leave(); });
  addEventListener("resize", fit);
  document.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(drawRail, 500); });

  show(0);
})();
