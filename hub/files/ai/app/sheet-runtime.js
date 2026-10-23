// Sheet artifact runtime: a small spreadsheet (cells, formulas, several sheets) kept as JSON in
// <script id="sheet-data">. Added to the page when it is shown and taken out again when it is saved.
(function () {
  var holder = document.getElementById("sheet-data");
  if (!holder) return;
  var data;
  try { data = JSON.parse(holder.textContent); } catch (e) { data = null; }
  if (!data || !Array.isArray(data.sheets) || !data.sheets.length) data = { sheets: [{ name: "Sheet1", rows: [[""]] }] };
  data.sheets.forEach(function (s, i) {
    if (!s.name) s.name = "Sheet" + (i + 1);
    if (!Array.isArray(s.rows) || !s.rows.length) s.rows = [[""]];
  });
  var cur = 0, active = { r: 0, c: 0 }, root, tabs, grid, label;

  function colName(i) { var s = ""; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colIdx(s) { var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + s.charCodeAt(i) - 64; return n - 1; }
  function sheet() { return data.sheets[cur]; }
  function width() { var w = 1; sheet().rows.forEach(function (r) { if (r.length > w) w = r.length; }); return w; }
  function raw(r, c) { var v = (sheet().rows[r] || [])[c]; return v === undefined || v === null ? "" : v; }

  // ---- formulas: numbers, "text", A1, A1:B3, + - * / ^ & comparisons, SUM AVERAGE MIN MAX COUNT ROUND ABS IF
  var TOKEN = /\s*(?:(\d+\.?\d*|\.\d+)|"([^"]*)"|([A-Za-z]+\d+:[A-Za-z]+\d+)|([A-Za-z]+\d+)|([A-Za-z]+)(?=\()|(<=|>=|<>|[-+*\/^(),<>=&]))/y;
  function tokens(src) {
    var out = [], m; TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) {
      if (m[1] !== undefined) out.push({ t: "n", v: parseFloat(m[1]) });
      else if (m[2] !== undefined) out.push({ t: "s", v: m[2] });
      else if (m[3]) out.push({ t: "range", v: m[3].toUpperCase() });
      else if (m[4]) out.push({ t: "ref", v: m[4].toUpperCase() });
      else if (m[5]) out.push({ t: "fn", v: m[5].toUpperCase() });
      else out.push({ t: "op", v: m[6] });
    }
    if (TOKEN.lastIndex < src.replace(/\s+$/, "").length) throw new Error("syntax");
    return out;
  }
  function split(ref) { var m = /^([A-Z]+)(\d+)$/.exec(ref); return { c: colIdx(m[1]), r: parseInt(m[2], 10) - 1 }; }
  function num(v) { if (v === "" || v === null || v === undefined) return 0; var n = typeof v === "number" ? v : parseFloat(v); if (isNaN(n)) throw new Error("value"); return n; }
  function flat(a) { var out = []; a.forEach(function (x) { if (Array.isArray(x)) out = out.concat(x); else out.push(x); }); return out; }
  function nums(a) { return flat(a).filter(function (v) { return v !== "" && !isNaN(parseFloat(v)); }).map(parseFloat); }

  function evalFormula(src, depth) {
    var t = tokens(src), p = 0;
    function peek() { return t[p]; }
    function take() { return t[p++]; }
    function isOp(v) { return peek() && peek().t === "op" && peek().v === v; }
    function primary() {
      var k = take();
      if (!k) throw new Error("syntax");
      if (k.t === "n" || k.t === "s") return k.v;
      if (k.t === "ref") { var a = split(k.v); return value(a.r, a.c, depth + 1); }
      if (k.t === "range") {
        var ab = k.v.split(":"), s = split(ab[0]), e = split(ab[1]), out = [];
        for (var r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) for (var c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) out.push(value(r, c, depth + 1));
        return out;
      }
      if (k.t === "fn") {
        if (!isOp("(")) throw new Error("syntax");
        take();
        var args = [];
        if (!isOp(")")) { args.push(compare()); while (isOp(",")) { take(); args.push(compare()); } }
        if (!isOp(")")) throw new Error("syntax");
        take();
        return call(k.v, args);
      }
      if (k.t === "op" && k.v === "(") { var v = compare(); if (!isOp(")")) throw new Error("syntax"); take(); return v; }
      if (k.t === "op" && k.v === "-") return -num(power());
      if (k.t === "op" && k.v === "+") return num(power());
      throw new Error("syntax");
    }
    function power() { var v = primary(); while (isOp("^")) { take(); v = Math.pow(num(v), num(primary())); } return v; }
    function mul() { var v = power(); while (isOp("*") || isOp("/")) { var o = take().v, b = num(power()); if (o === "/" && b === 0) throw new Error("div0"); v = o === "*" ? num(v) * b : num(v) / b; } return v; }
    function add() { var v = mul(); while (isOp("+") || isOp("-")) { var o = take().v, b = num(mul()); v = o === "+" ? num(v) + b : num(v) - b; } return v; }
    function concat() { var v = add(); while (isOp("&")) { take(); v = String(v) + String(add()); } return v; }
    function compare() {
      var v = concat();
      while (peek() && peek().t === "op" && ["<", ">", "=", "<=", ">=", "<>"].indexOf(peek().v) >= 0) {
        var o = take().v, b = concat(), x = v;
        if (!isNaN(parseFloat(x)) && !isNaN(parseFloat(b))) { x = parseFloat(x); b = parseFloat(b); }
        v = o === "<" ? x < b : o === ">" ? x > b : o === "=" ? x == b : o === "<=" ? x <= b : o === ">=" ? x >= b : x != b;
      }
      return v;
    }
    var result = compare();
    if (p < t.length) throw new Error("syntax");
    return result;
  }
  function call(name, a) {
    var n;
    if (name === "SUM") return nums(a).reduce(function (x, y) { return x + y; }, 0);
    if (name === "AVERAGE") { n = nums(a); if (!n.length) throw new Error("div0"); return n.reduce(function (x, y) { return x + y; }, 0) / n.length; }
    if (name === "MIN") { n = nums(a); return n.length ? Math.min.apply(null, n) : 0; }
    if (name === "MAX") { n = nums(a); return n.length ? Math.max.apply(null, n) : 0; }
    if (name === "COUNT") return nums(a).length;
    if (name === "ABS") return Math.abs(num(a[0]));
    if (name === "ROUND") { var d = Math.pow(10, a.length > 1 ? num(a[1]) : 0); return Math.round(num(a[0]) * d) / d; }
    if (name === "IF") return a[0] ? a[1] : (a.length > 2 ? a[2] : false);
    throw new Error("name");
  }
  function value(r, c, depth) {
    if (depth > 60) throw new Error("cycle");
    var v = raw(r, c);
    if (typeof v === "string" && v.charAt(0) === "=") return evalFormula(v.slice(1), depth);
    return v;
  }
  function shown(r, c) {
    var v = raw(r, c);
    if (!(typeof v === "string" && v.charAt(0) === "=")) return v === "" ? "" : String(v);
    try {
      var x = value(r, c, 0);
      if (typeof x === "number") x = Math.round(x * 1e10) / 1e10;
      return String(x);
    } catch (e) { return e.message === "cycle" ? "#CYCLE" : e.message === "div0" ? "#DIV/0!" : e.message === "name" ? "#NAME?" : "#ERROR"; }
  }

  // ---- page
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function dirty() { try { parent.postMessage({ fabra: "dirty" }, "*"); } catch (e) {} }
  function sync() { holder.textContent = JSON.stringify(data).replace(/</g, "\\u003c"); }
  function btn(text, title, fn, host) {
    var b = el("button", "fs-btn", text); b.type = "button"; b.title = title;
    b.addEventListener("click", function () { fn(); });
    host.appendChild(b);
  }
  function changed() { sync(); dirty(); }

  root = el("div", "fs-root"); root.setAttribute("data-fabra-ui", ""); root.contentEditable = "false";
  var bar = el("div", "fs-bar"); tabs = el("div", "fs-tabs"); label = el("span", "fs-label", "A1");
  var tools = el("div", "fs-tools");
  grid = el("div", "fs-grid");
  btn("+ Row", "Add a row below the selected cell", function () { var w = width(), row = []; for (var i = 0; i < w; i++) row.push(""); sheet().rows.splice(active.r + 1, 0, row); changed(); draw(); }, tools);
  btn("+ Column", "Add a column after the selected cell", function () { var w = width(); sheet().rows.forEach(function (r) { while (r.length < w) r.push(""); r.splice(active.c + 1, 0, ""); }); changed(); draw(); }, tools);
  btn("− Row", "Delete the selected row", function () { if (sheet().rows.length < 2) return; sheet().rows.splice(active.r, 1); active.r = Math.min(active.r, sheet().rows.length - 1); changed(); draw(); }, tools);
  btn("− Column", "Delete the selected column", function () { if (width() < 2) return; sheet().rows.forEach(function (r) { r.splice(active.c, 1); }); active.c = Math.min(active.c, width() - 1); changed(); draw(); }, tools);
  bar.appendChild(tabs); bar.appendChild(label); bar.appendChild(tools);
  root.appendChild(bar); root.appendChild(grid);
  document.body.appendChild(root);

  function drawTabs() {
    tabs.textContent = "";
    data.sheets.forEach(function (s, i) {
      var t = el("button", "fs-tab" + (i === cur ? " on" : ""), s.name); t.type = "button";
      t.addEventListener("click", function () { cur = i; active = { r: 0, c: 0 }; draw(); });
      t.addEventListener("dblclick", function () { var n = prompt("Sheet name", s.name); if (n && n.trim()) { s.name = n.trim().slice(0, 40); changed(); drawTabs(); } });
      tabs.appendChild(t);
    });
    var add = el("button", "fs-tab", "+"); add.type = "button"; add.title = "New sheet";
    add.addEventListener("click", function () { data.sheets.push({ name: "Sheet" + (data.sheets.length + 1), rows: [[""]] }); cur = data.sheets.length - 1; active = { r: 0, c: 0 }; changed(); draw(); });
    tabs.appendChild(add);
  }

  var inputs = {};
  function draw() {
    drawTabs();
    var rows = Math.max(sheet().rows.length + 5, 20), cols = Math.max(width() + 2, 8);
    var s = sheet();
    grid.textContent = ""; inputs = {};
    var table = el("table", "fs-table"), head = el("tr");
    head.appendChild(el("th", "fs-corner"));
    for (var c = 0; c < cols; c++) head.appendChild(el("th", "fs-col", colName(c)));
    table.appendChild(head);
    for (var r = 0; r < rows; r++) {
      var tr = el("tr"); tr.appendChild(el("th", "fs-row", String(r + 1)));
      for (var c2 = 0; c2 < cols; c2++) (function (r, c) {
        var td = el("td"), inp = document.createElement("input");
        inp.value = shown(r, c); inp.spellcheck = false;
        if (r === 0 && s.header !== false && typeof raw(0, c) === "string" && raw(0, c) !== "" && raw(0, c).charAt(0) !== "=") td.className = "fs-head";
        inp.addEventListener("focus", function () { active = { r: r, c: c }; label.textContent = colName(c) + (r + 1); var v = raw(r, c); inp.value = v === "" ? "" : String(v); inp.select(); });
        inp.addEventListener("blur", function () {
          var t = inp.value, v = t;
          if (/^-?\d+(\.\d+)?$/.test(t.trim())) v = parseFloat(t);
          if (v !== raw(r, c) && !(v === "" && raw(r, c) === "")) {
            while (s.rows.length <= r) s.rows.push([]);
            while (s.rows[r].length <= c) s.rows[r].push("");
            s.rows[r][c] = v; changed();
          }
          refresh();
        });
        inp.addEventListener("keydown", function (e) {
          var dr = e.key === "Enter" ? (e.shiftKey ? -1 : 1) : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          var dc = e.key === "Tab" ? (e.shiftKey ? -1 : 1) : 0;
          if (e.key === "Escape") { inp.value = String(raw(r, c)); inp.blur(); return; }
          if (!dr && !dc) return;
          e.preventDefault();
          var n = inputs[(r + dr) + "," + (c + dc)]; if (n) n.focus();
        });
        inputs[r + "," + c] = inp; td.appendChild(inp); tr.appendChild(td);
      })(r, c2);
      table.appendChild(tr);
    }
    grid.appendChild(table);
    var a = inputs[active.r + "," + active.c]; label.textContent = colName(active.c) + (active.r + 1);
  }
  function refresh() {
    Object.keys(inputs).forEach(function (k) {
      var i = inputs[k]; if (document.activeElement === i) return;
      var p = k.split(","); i.value = shown(+p[0], +p[1]);
    });
  }
  sync(); draw();
})();
