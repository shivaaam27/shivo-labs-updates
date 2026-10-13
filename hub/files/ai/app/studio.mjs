// Artifacts (pages, documents, diagrams with versions), PDF/Word export,
// and a hidden Edge browser the agent can use to check its own work.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import crypto from "node:crypto";

export const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

export const ARTIFACT_TYPES = ["html", "document", "markdown", "svg", "mermaid"];
const EXT = { html: "html", document: "html", markdown: "md", svg: "svg", mermaid: "mmd" };

export const STUDIO_TOOLS = [
  {
    name: "create_artifact",
    description:
      "Create something the user can see in the app's side panel: a web page, dashboard, mockup or small app (type html), " +
      "a document they can edit and export to PDF or Word, such as a CV, letter, proposal or report (type document), " +
      "notes (markdown), a vector graphic (svg) or a flowchart/diagram (mermaid). " +
      "For html/document give a complete, self-contained HTML page (inline CSS/JS; CDN scripts are fine). " +
      "Documents should look like real printed pages (A4, sensible margins). Returns the artifact id.",
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
      "Look at a file that isn't plain text: an image (png, jpg, gif, webp), a PDF, or a Word, Excel or PowerPoint file. " +
      "You see it as it really looks (layout, tables, charts, slides). Use it to check documents you made or to read ones the user gives you.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "browser",
    description:
      "Use a hidden Edge browser to check a web page the way a person would: open a URL (e.g. the dev server or an artifact), " +
      "click, type, read the page text, and see a screenshot after each step. Console errors are reported. " +
      "Use it to verify your work before telling the user it's done.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "click", "type", "press", "scroll", "text", "screenshot", "close"] },
        url: { type: "string", description: "For open. An artifact can be opened as artifact:<id>" },
        selector: { type: "string", description: "CSS selector, or text:Some button label, for click/type" },
        text: { type: "string", description: "For type (the text) or press (a key such as Enter)" },
        width: { type: "integer", description: "Viewport width for open, e.g. 390 for a phone (default 1280)" },
      },
      required: ["action"],
    },
  },
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

// ---------- hidden browser for checking work
export function makeBrowser({ baseUrl }) {
  let browser = null, page = null, consoleLines = [];
  async function ensure(width = 1280) {
    if (!EDGE) throw new Error("Microsoft Edge wasn't found, so the browser tool isn't available.");
    if (!browser) {
      const puppeteer = (await import("puppeteer-core")).default;
      browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run", "--disable-extensions"] });
    }
    if (!page) {
      page = await browser.newPage();
      page.on("console", (m) => { if (["error", "warning"].includes(m.type())) consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
      page.on("pageerror", (e) => consoleLines.push(`page error: ${String(e.message || e).slice(0, 300)}`));
    }
    await page.setViewport({ width, height: width < 600 ? 844 : 800 });
    return page;
  }
  const target = (selector) => selector?.startsWith("text:")
    ? `::-p-text(${selector.slice(5).trim()})`
    : selector;

  async function shot() {
    const b64 = await page.screenshot({ type: "jpeg", quality: 60, encoding: "base64" });
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } };
  }
  function report(text) {
    const errs = consoleLines.splice(0);
    return text + (errs.length ? `\nConsole:\n${errs.slice(-15).join("\n")}` : "\nNo console errors.");
  }

  return {
    async run({ action, url, selector, text, width }) {
      if (action === "close") { await browser?.close().catch(() => {}); browser = page = null; return [{ type: "text", text: "Browser closed." }]; }
      if (action === "open") {
        if (!url) throw new Error("open needs a url");
        if (url.startsWith("artifact:")) url = `${baseUrl}/artifact/${url.slice(9)}`;
        if (!/^(https?|file):/.test(url)) url = "http://" + url;
        const p = await ensure(width || 1280);
        const res = await p.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => { throw new Error(`Couldn't open ${url}: ${e.message}`); });
        return [{ type: "text", text: report(`Opened ${url} (status ${res?.status() ?? "?"}). Title: ${await p.title()}`) }, await shot()];
      }
      if (!page) throw new Error("Open a page first.");
      if (action === "click") { await page.click(target(selector), { timeout: 8000 }); await new Promise((r) => setTimeout(r, 700)); }
      else if (action === "type") { await page.type(target(selector), String(text || ""), { delay: 10 }); }
      else if (action === "press") { await page.keyboard.press(String(text || "Enter")); await new Promise((r) => setTimeout(r, 500)); }
      else if (action === "scroll") { await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8)); await new Promise((r) => setTimeout(r, 300)); }
      else if (action === "text") {
        const t = await page.evaluate(() => document.body.innerText);
        return [{ type: "text", text: report(t.slice(0, 12000)) }];
      }
      return [{ type: "text", text: report(`Done: ${action}${selector ? " " + selector : ""}. Page: ${page.url()}`) }, await shot()];
    },
    async close() { await browser?.close().catch(() => {}); browser = page = null; },
  };
}
