// Artifacts (pages, documents, diagrams with versions), PDF/Word export,
// and a hidden Edge browser the agent can use to check its own work.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { IMAGE_TOOLS } from "./imagetools.mjs";

export const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

export const ARTIFACT_TYPES = ["html", "document", "slides", "sheet", "markdown", "svg", "mermaid"];
const EXT = { html: "html", document: "html", slides: "html", sheet: "html", markdown: "md", svg: "svg", mermaid: "mmd" };
const HERE = dirname(fileURLToPath(import.meta.url));
const DECK_CSS = readFileSync(join(HERE, "deck-runtime.css"), "utf8");
const DECK_JS = readFileSync(join(HERE, "deck-runtime.js"), "utf8");
const SHEET_CSS = readFileSync(join(HERE, "sheet-runtime.css"), "utf8");
const SHEET_JS = readFileSync(join(HERE, "sheet-runtime.js"), "utf8");

export const STUDIO_TOOLS = [
  {
    name: "create_artifact",
    description:
      "Create something the user can see in the app's side panel: a web page, dashboard, mockup or small app (type html), " +
      "a document they can edit and export to PDF or Word, such as a CV, letter, proposal or report (type document), " +
      "a presentation (type slides: they can edit, reorder, present full screen and export to PDF or PowerPoint), " +
      "a spreadsheet (type sheet: they can edit cells and formulas and export to Excel or PDF), " +
      "notes (markdown), a vector graphic (svg) or a flowchart/diagram (mermaid). " +
      "For html/document give a complete, self-contained HTML page (inline CSS/JS; CDN scripts are fine). " +
      "Documents should look like real printed pages (A4, sensible margins). " +
      "For slides give only the slides, no <html>: an optional <style> for the theme, then one <section class=\"slide\"> per slide. Each slide is a fixed 1280x720 canvas (set its own background and colours in your <style>; no scripts needed; images as data: URIs or https URLs). " +
      "Put the slide title in an h1 or h2, bullets in li, and keep text short so it fits. " +
      "For a sheet give only JSON: {\"sheets\":[{\"name\":\"Budget\",\"rows\":[[\"Item\",\"Qty\",\"Price\",\"Total\"],[\"Pens\",10,2.5,\"=B2*C2\"],[\"Total\",\"\",\"\",\"=SUM(D2:D2)\"]]}]}. " +
      "The first row is the header. Numbers are numbers; a string starting with = is a live formula (+ - * / ^ & comparisons, cell refs like B2, ranges, SUM AVERAGE MIN MAX COUNT ROUND ABS IF). Returns the artifact id.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        type: { type: "string", enum: ARTIFACT_TYPES },
        content: { type: "string" },
      },
      required: ["title", "type", "content"],
    },
  },
  {
    name: "update_artifact",
    description: "Save a new version of an existing artifact with the full new content. The user can switch between versions.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, content: { type: "string" }, note: { type: "string", description: "What changed, in a few words" } },
      required: ["id", "content"],
    },
  },
  {
    name: "read_artifact",
    description: "Read the latest content of an artifact (for example after the user edited it by hand).",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "view_file",
    description:
      "Look at a file that isn't plain text: an image (png, jpg, gif, webp, bmp, tiff, heic, svg; large ones are shrunk for you), a PDF, or a Word, Excel or PowerPoint file. " +
      "You see it as it really looks (layout, tables, charts, slides). Use it to check documents you made or to read ones the user gives you. " +
      "To look at several images, pass paths (up to 12) in one call instead of one call each; for many, or to compare, use image_board.",
    input_schema: { type: "object", properties: { path: { type: "string" }, paths: { type: "array", items: { type: "string" }, description: "Several images at once" } } },
  },
  {
    name: "browser",
    description:
      "Use a hidden Edge browser, with tabs, the way a person would: open a URL (a site, the dev server or artifact:<id>), " +
      "click, type, press keys, scroll, go back/forward/reload, read the page text, find a word on the page, list its links, and see a screenshot after each step. Console errors are reported. " +
      "Use it to verify your work, and for research: new_tab opens a page in another tab (keep 2-3 open to compare), tabs lists them, switch changes tab, close_tab closes one. " +
      "The user can't see this browser; to show them a page use open_preview.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "new_tab", "tabs", "switch", "close_tab", "click", "type", "press", "scroll", "back", "forward", "reload", "wait", "find", "links", "text", "screenshot", "close"] },
        url: { type: "string", description: "For open and new_tab. An artifact can be opened as artifact:<id>" },
        index: { type: "integer", description: "Tab number for switch or close_tab (see tabs)" },
        ms: { type: "integer", description: "For wait: milliseconds (or the longest to wait for the selector)" },
        query: { type: "string", description: "For find: the word or phrase to look for on the page" },
        selector: { type: "string", description: "CSS selector, or text:Some button label, for click/type" },
        text: { type: "string", description: "For type (the text) or press (a key such as Enter)" },
        width: { type: "integer", description: "Viewport width for open, e.g. 390 for a phone (default 1280)" },
      },
      required: ["action"],
    },
  },
  ...IMAGE_TOOLS,
];

// ---------- artifact storage
export function makeArtifacts(dataDir) {
  const dir = join(dataDir, "artifacts");
  mkdirSync(dir, { recursive: true });
  const metaFile = (id) => join(dir, id, "meta.json");
  const safe = (id) => String(id || "").replace(/[^\w-]/g, "");

  const get = (id) => { try { return JSON.parse(readFileSync(metaFile(safe(id)), "utf8")); } catch { return null; } };
  const put = (m) => writeFileSync(metaFile(m.id), JSON.stringify(m, null, 2));
  const file = (m, n) => join(dir, m.id, `v${n}.${EXT[m.type]}`);

  return {
    dir,
    get,
    list() {
      return readdirSync(dir).map(get).filter(Boolean).sort((a, b) => b.updated - a.updated);
    },
    create({ title, type, content, chatId }) {
      if (!ARTIFACT_TYPES.includes(type)) throw new Error(`type must be one of ${ARTIFACT_TYPES.join(", ")}`);
      const id = crypto.randomUUID().slice(0, 8);
      mkdirSync(join(dir, id), { recursive: true });
      const m = { id, title: String(title || "Untitled").slice(0, 120), type, chatId, created: Date.now(), updated: Date.now(), versions: [] };
      writeFileSync(file(m, 1), content);
      m.versions.push({ n: 1, type, at: Date.now(), by: "ai", note: "First version" });
      put(m); return m;
    },
    update(id, content, { by = "ai", note = "", type } = {}) {
      const m = get(id); if (!m) throw new Error(`No artifact with id ${id}`);
      if (type) m.type = type;
      const n = m.versions.length + 1;
      writeFileSync(file(m, n), content);
      m.versions.push({ n, type: m.type, at: Date.now(), by, note: String(note).slice(0, 200) });
      m.updated = Date.now(); put(m); return m;
    },
    read(id, n) {
      const m = get(id); if (!m) throw new Error(`No artifact with id ${id}`);
      const v = m.versions.find((x) => x.n === Number(n)) || m.versions.at(-1);
      // Each version remembers its own type (a hand-edited markdown note is saved as a document).
      const type = v.type || m.type;
      return { meta: { ...m, type }, version: v.n, content: readFileSync(file({ ...m, type }, v.n), "utf8") };
    },
    remove(id) {
      const m = get(id); if (!m) return false;
      m.deleted = true; put(m); return true; // kept on disk; hidden from the gallery
    },
  };
}

// ---------- rendering an artifact as a page
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const PAGE = (title, body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;

export function renderArtifact(meta, content) {
  const t = meta.type;
  if (t === "html" || t === "document") {
    if (/<html[\s>]/i.test(content)) return content;
    const docCss = t === "document"
      ? `<style>@page{size:A4;margin:18mm}body{max-width:210mm;margin:24px auto;padding:18mm;background:#fff;color:#111;font:11pt/1.5 'Segoe UI',Arial,sans-serif;box-shadow:0 2px 18px rgba(0,0,0,.12)}@media print{body{box-shadow:none;margin:0;padding:0}}</style>`
      : "";
    return PAGE(meta.title, content, docCss);
  }
  if (t === "sheet") {
    const css = `<style data-fabra-deck>${SHEET_CSS}</style>`, js = `<script data-fabra-deck>${SHEET_JS}</script>`;
    let html = content;
    // A saved sheet is a whole page holding <script id="sheet-data">; a fresh one is just the JSON.
    if (!/<html[\s>]/i.test(html)) {
      let json = "{}"; try { json = JSON.stringify(JSON.parse(content)).replace(/</g, "\\u003c"); } catch {}
      html = PAGE(meta.title, `<script type="application/json" id="sheet-data">${json}</script>`);
    }
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => css + "</head>") : css + html;
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => js + "</body>") : html + js;
  }
  if (t === "slides") {
    const css = `<style data-fabra-deck>${DECK_CSS}</style>`, js = `<script data-fabra-deck>${DECK_JS}</script>`;
    let html = content;
    // A saved deck is a whole page (with <main id="deck">); a fresh one is just the slides.
    if (!/<html[\s>]/i.test(html)) html = PAGE(meta.title, `<main id="deck">${content}</main>`);
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => css + "</head>") : css + html;
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => js + "</body>") : html + js;
  }
  if (t === "markdown") {
    return PAGE(meta.title,
      `<article id="md"></article><script type="text/plain" id="src">${esc(content)}</script>
      <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
      <script>const s=document.getElementById('src').textContent.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');document.getElementById('md').innerHTML=marked.parse(s)</script>`,
      `<style>body{max-width:760px;margin:32px auto;padding:0 20px;font:15px/1.65 'Segoe UI',Arial,sans-serif;color:#1d1d1f}pre{background:#f4f4f2;padding:12px;border-radius:8px;overflow:auto}code{font-family:Consolas,monospace}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:5px 9px}</style>`);
  }
  if (t === "svg") return PAGE(meta.title, content, `<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fafaf8}svg{max-width:100%;height:auto}</style>`);
  if (t === "mermaid") {
    return PAGE(meta.title, `<pre class="mermaid">${esc(content)}</pre>
      <script type="module">import m from 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';m.initialize({startOnLoad:true,theme:'neutral'});</script>`,
      `<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;font-family:'Segoe UI',Arial,sans-serif}</style>`);
  }
  return PAGE(meta.title, `<pre>${esc(content)}</pre>`);
}

// ---------- Office files: Word, Excel and PowerPoint are converted to PDF by Office itself,
// for previews in the side panel and so the AI can look at them.
export const OFFICE = /\.(docx?|xlsx?|pptx?)$/i;
const OFFICE_PS = {
  word: `$a=New-Object -ComObject Word.Application;$a.Visible=$false;$a.DisplayAlerts=0;try{$d=$a.Documents.Open($env:SRC,$false,$true);$d.SaveAs2($env:OUT,17);$d.Close(0)}finally{$a.Quit()}`,
  excel: `$a=New-Object -ComObject Excel.Application;$a.Visible=$false;$a.DisplayAlerts=$false;try{$w=$a.Workbooks.Open($env:SRC,0,$true);$w.ExportAsFixedFormat(0,$env:OUT);$w.Close($false)}finally{$a.Quit()}`,
  ppt: `$a=New-Object -ComObject PowerPoint.Application;try{$p=$a.Presentations.Open($env:SRC,-1,0,0);$p.SaveAs($env:OUT,32);$p.Close()}finally{$a.Quit()}`,
};
export function officeToPdf(src, out) {
  const kind = /\.docx?$/i.test(src) ? "word" : /\.xlsx?$/i.test(src) ? "excel" : "ppt";
  return new Promise((resolveP, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", OFFICE_PS[kind]],
      { windowsHide: true, timeout: 90000, env: { ...process.env, SRC: src, OUT: out } },
      (err, _o, stderr) => (existsSync(out) ? resolveP(out) : reject(new Error("Couldn't convert with Microsoft Office: " + (stderr || err?.message || "unknown error").slice(0, 300)))));
  });
}

// ---------- export
export function exportPdf(url, outFile) {
  return new Promise((resolveP, reject) => {
    if (!EDGE) return reject(new Error("Microsoft Edge wasn't found, so PDF export isn't available."));
    execFile(EDGE, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=4000", `--print-to-pdf=${outFile}`, url],
      { windowsHide: true, timeout: 60000 },
      (err) => (existsSync(outFile) ? resolveP(outFile) : reject(err || new Error("PDF export failed"))));
  });
}

export async function exportDocx(html, outFile, title) {
  const { default: HTMLtoDOCX } = await import("html-to-docx");
  // Word conversion works on the page body; scripts and styles are dropped.
  const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] || html).replace(/<script[\s\S]*?<\/script>/gi, "");
  const buf = await HTMLtoDOCX(`<!doctype html><html><body>${body}</body></html>`, null, { title, table: { row: { cantSplit: true } }, footer: false, pageNumber: false });
  writeFileSync(outFile, buf);
  return outFile;
}

// Slides to an editable PowerPoint file (text, bullets, tables and pictures; deck2pptx.py, python-pptx).
// A sheet to a real Excel file (formulas stay formulas; sheet2xlsx.py, openpyxl).
export function exportXlsx(content, outFile) {
  return new Promise((resolveP, reject) => {
    let json = String(content).trim();
    if (!json.startsWith("{")) json = /<script[^>]*id="sheet-data"[^>]*>([\s\S]*?)<\/script>/i.exec(json)?.[1] || "{}";
    const src = outFile + ".json.tmp";
    writeFileSync(src, json);
    execFile("python", [join(HERE, "sheet2xlsx.py"), src, outFile], { windowsHide: true, timeout: 60000 }, (err, _o, stderr) => {
      try { unlinkSync(src); } catch {}
      const why = String(stderr || "").trim().split(String.fromCharCode(10)).pop() || (err ? err.message : "");
      existsSync(outFile) ? resolveP(outFile) : reject(new Error("Excel export failed" + (why ? ": " + why : "")));
    });
  });
}

export function exportPptx(html, outFile) {
  return new Promise((resolveP, reject) => {
    const src = outFile + ".html.tmp";
    writeFileSync(src, html);
    execFile("python", [join(HERE, "deck2pptx.py"), src, outFile], { windowsHide: true, timeout: 60000 }, (err, _o, stderr) => {
      try { unlinkSync(src); } catch {}
      const why = String(stderr || "").trim().split(String.fromCharCode(10)).pop() || (err ? err.message : "");
      existsSync(outFile) ? resolveP(outFile) : reject(new Error("PowerPoint export failed" + (why ? ": " + why : "")));
    });
  });
}

// ---------- hidden browser for checking work
export function makeBrowser({ baseUrl }) {
  let browser = null, pages = [], cur = 0, consoleLines = [];
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  const page = () => pages[cur];
  async function launch() {
    if (!EDGE) throw new Error("Microsoft Edge wasn't found, so the browser tool isn't available.");
    if (!browser) {
      const puppeteer = (await import("puppeteer-core")).default;
      browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run", "--disable-extensions"] });
    }
  }
  async function newPage(width = 1280) {
    await launch();
    const p = await browser.newPage();
    await p.setUserAgent(UA).catch(() => {});
    p.on("console", (m) => { if (["error", "warning"].includes(m.type())) consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
    p.on("pageerror", (e) => consoleLines.push(`page error: ${String(e.message || e).slice(0, 300)}`));
    await p.setViewport({ width, height: width < 600 ? 844 : 800 });
    pages.push(p); cur = pages.length - 1;
    return p;
  }
  async function ensure(width = 1280) {
    if (!page()) return newPage(width);
    await page().setViewport({ width, height: width < 600 ? 844 : 800 });
    return page();
  }
  const target = (selector) => selector?.startsWith("text:")
    ? `::-p-text(${selector.slice(5).trim()})`
    : selector;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function shot() {
    const b64 = await page().screenshot({ type: "jpeg", quality: 60, encoding: "base64" });
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } };
  }
  function report(text) {
    const errs = consoleLines.splice(0);
    return text + (errs.length ? `\nConsole:\n${errs.slice(-15).join("\n")}` : "\nNo console errors.");
  }
  async function tabList() {
    const rows = [];
    for (let i = 0; i < pages.length; i++) rows.push(`${i === cur ? "*" : " "} ${i}: ${(await pages[i].title().catch(() => "")) || "(no title)"} — ${pages[i].url()}`);
    return rows.join("\n");
  }
  const fixUrl = (url) => {
    if (!url) throw new Error("open needs a url");
    if (url.startsWith("artifact:")) url = `${baseUrl}/artifact/${url.slice(9)}`;
    return /^(https?|file):/.test(url) ? url : "http://" + url;
  };

  return {
    async run({ action, url, selector, text, width, index, ms, query }) {
      if (action === "close") { await browser?.close().catch(() => {}); browser = null; pages = []; cur = 0; return [{ type: "text", text: "Browser closed." }]; }
      if (action === "open" || action === "new_tab") {
        url = fixUrl(url);
        const p = action === "new_tab" || !page() ? await newPage(width || 1280) : await ensure(width || 1280);
        const res = await p.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => { throw new Error(`Couldn't open ${url}: ${e.message}`); });
        return [{ type: "text", text: report(`Opened ${url} in tab ${cur} (status ${res?.status() ?? "?"}). Title: ${await p.title()}`) }, await shot()];
      }
      if (action === "tabs") return [{ type: "text", text: pages.length ? await tabList() : "No tabs are open." }];
      if (action === "switch") {
        const i = Number(index);
        if (!pages[i]) throw new Error(`There is no tab ${index}.\n${await tabList()}`);
        cur = i; await page().bringToFront().catch(() => {});
        return [{ type: "text", text: report(`Now on tab ${cur}: ${page().url()}`) }, await shot()];
      }
      if (action === "close_tab") {
        const i = index === undefined ? cur : Number(index);
        if (!pages[i]) throw new Error(`There is no tab ${index}.`);
        await pages[i].close().catch(() => {}); pages.splice(i, 1); cur = Math.max(0, Math.min(cur, pages.length - 1));
        return [{ type: "text", text: pages.length ? `Closed. Tabs now:\n${await tabList()}` : "Closed the last tab." }];
      }
      if (!page()) throw new Error("Open a page first.");
      const p = page();
      if (action === "click") { await p.click(target(selector), { timeout: 8000 }); await wait(700); }
      else if (action === "type") { await p.type(target(selector), String(text || ""), { delay: 10 }); }
      else if (action === "press") { await p.keyboard.press(String(text || "Enter")); await wait(500); }
      else if (action === "scroll") { await p.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8)); await wait(300); }
      else if (action === "back") { await p.goBack({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}); }
      else if (action === "forward") { await p.goForward({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}); }
      else if (action === "reload") { await p.reload({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}); }
      else if (action === "wait") {
        if (selector) await p.waitForSelector(target(selector), { timeout: Math.min(Number(ms) || 10000, 30000) }).catch(() => { throw new Error(`${selector} didn't appear.`); });
        else await wait(Math.min(Number(ms) || 1000, 15000));
      }
      else if (action === "find") {
        const q = String(query || text || "");
        if (!q) throw new Error("find needs a query");
        const hits = await p.evaluate((needle) => {
          const body = document.body.innerText, low = body.toLowerCase(), n = needle.toLowerCase(), out = [];
          for (let i = low.indexOf(n); i >= 0 && out.length < 8; i = low.indexOf(n, i + n.length)) out.push(body.slice(Math.max(0, i - 80), i + n.length + 80).replace(/\s+/g, " "));
          return out;
        }, q);
        return [{ type: "text", text: report(hits.length ? `Found "${q}" ${hits.length}${hits.length === 8 ? "+" : ""} time(s):\n- ${hits.join("\n- ")}` : `"${q}" is not on this page.`) }];
      }
      else if (action === "links") {
        const links = await p.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => [(a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 90), a.href]).filter(([t, h]) => t && /^https?:/.test(h)).slice(0, 60));
        return [{ type: "text", text: report(links.map(([t, h]) => `${t} — ${h}`).join("\n") || "No links found.") }];
      }
      else if (action === "text") {
        const t = await p.evaluate(() => document.body.innerText);
        return [{ type: "text", text: report(t.slice(0, 12000)) }];
      }
      else if (action !== "screenshot") throw new Error(`Unknown browser action "${action}".`);
      return [{ type: "text", text: report(`Done: ${action}${selector ? " " + selector : ""}. Page: ${p.url()}`) }, await shot()];
    },
    async close() { await browser?.close().catch(() => {}); browser = null; pages = []; cur = 0; },
  };
}
