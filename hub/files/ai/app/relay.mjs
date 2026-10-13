// Preview relay: lets the preview panel show local dev servers that forbid being embedded
// (X-Frame-Options / CSP frame-ancestors, common in Next.js and other frameworks).
// Each target port gets its own relay port, so the site's absolute paths (/_next/..., /assets/...)
// keep working. Only localhost targets are relayed; WebSocket upgrades (live reload) are piped through.
// Requests are rewritten to look like they come from localhost:<port> itself, because dev servers
// (e.g. Next.js 15+) refuse live-reload connections from unfamiliar origins. Without live reload the
// page can stay in a half-loaded, washed-out state.
import http from "node:http";
import net from "node:net";

const relays = new Map(); // target port -> relay port

// A tiny helper added to every HTML page: it tells the app which page is showing (so the address
// bar follows navigation and Refresh stays on the same page), and handles back/forward/reload.
const NAV_HELPER = `(() => {
  if (window.parent === window) return;
  const tell = () => parent.postMessage({ fabra: "nav", href: location.href, title: document.title }, "*");
  let pickOn = false, pickBox = null;
  const pickSel = (el) => { const parts = []; while (el && el.nodeType === 1 && parts.length < 4) { if (el.id) { parts.unshift("#" + el.id); break; } let s = el.tagName.toLowerCase(); const cl = [...el.classList].slice(0, 2); if (cl.length) s += "." + cl.join("."); const sib = el.parentElement ? [...el.parentElement.children].filter((x) => x.tagName === el.tagName) : []; if (sib.length > 1) s += ":nth-of-type(" + (sib.indexOf(el) + 1) + ")"; parts.unshift(s); el = el.parentElement; } return parts.join(" > "); };
  const pickMove = (e) => { const r = e.target.getBoundingClientRect(); Object.assign(pickBox.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", display: "block" }); };
  const pickStop = () => { pickOn = false; if (pickBox) pickBox.remove(); pickBox = null; removeEventListener("mousemove", pickMove, true); removeEventListener("click", pickClick, true); removeEventListener("keydown", pickKey, true); };
  const pickReply = (msg) => { pickStop(); parent.postMessage(msg, "*"); };
  function pickClick(e) { e.preventDefault(); e.stopPropagation(); pickReply({ fabra: "picked", selector: pickSel(e.target), html: e.target.outerHTML.slice(0, 1500) }); }
  function pickKey(e) { if (e.key === "Escape") { e.preventDefault(); pickReply({ fabra: "picked", cancelled: true }); } }
  const pickStart = () => { if (pickOn) return; pickOn = true; pickBox = document.createElement("div"); pickBox.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,.12);border-radius:3px;display:none"; document.documentElement.appendChild(pickBox); addEventListener("mousemove", pickMove, true); addEventListener("click", pickClick, true); addEventListener("keydown", pickKey, true); };
  addEventListener("message", (e) => { if (e.source !== parent || !e.data || e.data.fabra !== "pick") return; if (e.data.on) pickStart(); else pickStop(); });
  const logTo = (level, args) => { try { const text = args.map((a) => { try { return typeof a === "string" ? a : a instanceof Error ? (a.stack || a.message) : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 2000); parent.postMessage({ fabra: "log", level, text }, "*"); } catch {} };
  for (const lv of ["error", "warn", "log", "info"]) { const o = console[lv]; console[lv] = function (...a) { logTo(lv, a); return o.apply(this, a); }; }
  addEventListener("error", (e) => { if (e.message) logTo("error", [e.message + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "")]); });
  addEventListener("unhandledrejection", (e) => logTo("error", ["Unhandled promise rejection: " + ((e.reason && e.reason.message) || e.reason)]));
  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k];
    history[k] = function (...a) { const r = orig.apply(this, a); setTimeout(tell, 0); return r; };
  }
  addEventListener("popstate", tell); addEventListener("hashchange", tell); addEventListener("load", tell);
  tell();
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.fabra !== "navcmd") return;
    if (e.data.cmd === "back") history.back();
    else if (e.data.cmd === "forward") history.forward();
    else if (e.data.cmd === "reload") location.reload();
  });
})();`;

function cleanHeaders(headers, targetPort) {
  const h = { ...headers };
  delete h["x-frame-options"];
  for (const k of ["content-security-policy", "content-security-policy-report-only"]) {
    if (!h[k]) continue;
    // Drop only the frame-ancestors rule; keep the rest of the site's policy.
    const v = [].concat(h[k]).map((p) => p.split(";").filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(";")).filter((p) => p.trim());
    if (v.length) h[k] = v; else delete h[k];
  }
  // A redirect to http://localhost:<port>/x should stay inside the relay.
  if (h.location) h.location = String(h.location).replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${targetPort}`, "i"), "");
  return h;
}

// Make the request look like it was made to localhost:<port> directly.
function upstreamHeaders(reqHeaders, targetPort, relayOrigin) {
  const h = { ...reqHeaders, host: `localhost:${targetPort}`, "accept-encoding": "identity" };
  const local = `http://localhost:${targetPort}`;
  if (h.origin) h.origin = local;
  if (h.referer) h.referer = String(h.referer).replace(relayOrigin, local);
  return h;
}

export function relayFor(targetPort) {
  targetPort = Number(targetPort);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) return Promise.reject(new Error("Bad port"));
  if (relays.has(targetPort)) return Promise.resolve(relays.get(targetPort));
  return new Promise((resolveP, reject) => {
    let relayOrigin = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/__fabra_nav.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); return res.end(NAV_HELPER); }
      const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url,
        headers: upstreamHeaders(req.headers, targetPort, relayOrigin) }, (r) => {
        const headers = cleanHeaders(r.headers, targetPort);
        const isHtml = /text\/html/i.test(r.headers["content-type"] || "") && req.method === "GET";
        if (!isHtml) { res.writeHead(r.statusCode || 502, headers); return r.pipe(res); }
        // HTML: add the navigation helper (served from this same address, so the site's CSP allows it).
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8");
          const tag = `<script src="/__fabra_nav.js"></script>`;
          // At the very end: frameworks that "hydrate" the page (React/Next) warn about extra tags in <head>.
          html = /<\/html>\s*$/i.test(html) ? html.replace(/<\/html>\s*$/i, tag + "</html>") : html + tag;
          delete headers["content-length"]; delete headers["content-encoding"];
          res.writeHead(r.statusCode || 200, headers);
          res.end(html);
        });
      });
      up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/html" }); res.end(`<p style="font-family:sans-serif;padding:20px">Nothing is answering on port ${targetPort} yet. If the dev server is still starting, press reload in a few seconds.</p>`); });
      req.pipe(up);
    });
    // Live reload (Vite, Next.js, webpack) uses WebSockets: pass them straight through.
    server.on("upgrade", (req, socket, head) => {
      const up = net.connect(targetPort, "127.0.0.1", () => {
        const headers = upstreamHeaders(req.headers, targetPort, relayOrigin);
        delete headers["accept-encoding"];
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(socket); socket.pipe(up);
      });
      up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const p = server.address().port; relayOrigin = `http://127.0.0.1:${p}`;
      relays.set(targetPort, p); resolveP(p);
    });
  });
}
