// Image tools: look at several images at once (any common type, shrunk to save tokens), mood boards and
// side-by-side comparisons (imgtool.py, Pillow), and an upscaler (Real-ESRGAN when installed, else a plain resize).
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, writeFileSync, unlinkSync, createWriteStream } from "node:fs";
import { join, resolve, extname, basename, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(HERE, "imgtool.py");
const NATIVE = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|heic|heif|avif|svg)$/i;
const MAX_VIEW = 1568; // longest side sent to the AI: sharp enough to judge, and the cheapest size that still is
const REALESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";

export const IMAGE_TOOLS = [
  {
    name: "image_board",
    description:
      "Put several images on one sheet so you and the user can see them together: a mood board / contact sheet (layout grid) or a side-by-side comparison (layout compare, 2-4 images, " +
      "with diff: true for two images it adds a heat map of what changed, good for spotting what went wrong between versions). Paths can be image files or folders (all images in the folder). " +
      "Labels show file names and sizes. The sheet opens in the user's preview panel and you see it too. Handles png, jpg, gif, webp, bmp, tiff, heic and more.",
    input_schema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Image files and/or folders" },
        layout: { type: "string", enum: ["grid", "compare"], description: "grid (default): mood board; compare: side by side" },
        columns: { type: "integer", description: "Grid columns (default: a square-ish grid)" },
        cell: { type: "integer", description: "Grid cell size in pixels (default 360) or compare height (default 700)" },
        labels: { type: "boolean", description: "Show file names and sizes (default true)" },
        diff: { type: "boolean", description: "compare with exactly 2 images: add a difference heat map" },
        save_to: { type: "string", description: "Where to save the sheet (default: the app's own folder)" },
      },
      required: ["paths"],
    },
  },
  {
    name: "upscale_image",
    description:
      "Make an image bigger (2x or 4x). With the Real-ESRGAN engine (a free open-source AI upscaler, about 45 MB, needs a normal graphics driver) it adds real detail; " +
      "without it, a plain high-quality resize is used. engine auto uses Real-ESRGAN if it is installed. If it isn't, ask the user first (ask_user), then call again with install: true to download it from GitHub. " +
      "The result is saved next to the original as name-x2.png (or the folder the user names) and opens in the preview.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        scale: { type: "integer", enum: [2, 4], description: "Default 2" },
        engine: { type: "string", enum: ["auto", "basic"], description: "basic = plain resize only" },
        install: { type: "boolean", description: "Download Real-ESRGAN now (only after the user agreed)" },
        save_to: { type: "string" },
      },
      required: ["path"],
    },
  },
];

const run = (file, args, opts = {}) => new Promise((done) => {
  execFile(file, args, { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => done({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
});

export function makeImageTools({ dataDir, chatId, workDir, isAllowed, previewTo = () => {}, edge = null }) {
  const out = join(dataDir, "boards", String(chatId || "chat").replace(/[^\w-]/g, ""));
  const tmp = join(dataDir, "tmp");
  mkdirSync(out, { recursive: true }); mkdirSync(tmp, { recursive: true });
  const abs = (p) => resolve(workDir, String(p || ""));
  const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex");

  async function py(cmd, job) {
    const file = join(tmp, `job-${crypto.randomUUID().slice(0, 8)}.json`);
    writeFileSync(file, JSON.stringify(job));
    const r = await run("python", [PY, cmd, file]);
    try { unlinkSync(file); } catch {}
    try { return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); }
    catch { return { error: r.err ? `Python failed: ${r.err.message}` : "Python gave no answer (is it installed?)." }; }
  }
  // An SVG drawn by Edge, since Pillow can't.
  async function svgToPng(file) {
    if (!edge) return null;
    const png = join(tmp, `svg-${crypto.randomUUID().slice(0, 8)}.png`);
    await run(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=FFFFFFFF", "--window-size=1200,900", `--screenshot=${png}`, "file:///" + file.replace(/\\/g, "/")], { timeout: 30000 });
    return existsSync(png) ? png : null;
  }

  // One image as a block the AI can see: small normal images go as they are, everything else is shrunk (or converted) first.
  async function oneImage(file) {
    const ext = extname(file).toLowerCase();
    if (!existsSync(file)) return { text: `${file}: not found.` };
    const size = statSync(file).size;
    if (NATIVE[ext] && size < 20 * 1024) return { text: `${file}`, block: { type: "image", source: { type: "base64", media_type: NATIVE[ext], data: readFileSync(file).toString("base64") } } };
    let src = file, made = [];
    if (ext === ".svg") { src = await svgToPng(file); if (!src) return { text: `${file}: couldn't draw this SVG (Edge wasn't found).` }; made.push(src); }
    const dest = join(tmp, `view-${crypto.randomUUID().slice(0, 8)}.jpg`);
    const r = await py("convert", { in: src, out: dest, max: MAX_VIEW });
    made.push(dest);
    try {
      if (!r.error && !r.resized && NATIVE[ext] && size <= 5e6) return { text: `${file} (${r.w}x${r.h})`, block: { type: "image", source: { type: "base64", media_type: NATIVE[ext], data: readFileSync(file).toString("base64") } } }; // already a sensible size
      if (!r.error && existsSync(dest)) return { text: `${file} (${r.w}x${r.h} shown)`, block: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(dest).toString("base64") } } };
      if (NATIVE[ext] && size <= 5e6) return { text: `${file}`, block: { type: "image", source: { type: "base64", media_type: NATIVE[ext], data: readFileSync(file).toString("base64") } } };
      return { text: `${file}: ${r.error || "couldn't open"}${size > 5e6 ? " (over 5 MB, and it can't be shrunk without Pillow)" : ""}.` };
    } finally { for (const m of made) try { unlinkSync(m); } catch {} }
  }

  async function viewImages(files) {
    const list = files.slice(0, 12);
    const rows = await Promise.all(list.map(oneImage));
    const content = [];
    rows.forEach((r, i) => { content.push({ type: "text", text: `Image ${i + 1} of ${list.length}: ${r.text}` }); if (r.block) content.push(r.block); });
    if (files.length > list.length) content.push({ type: "text", text: `(${files.length - list.length} more not shown; at most 12 per step. Use image_board to see many at once.)` });
    return { text: rows.map((r) => r.text).join("\n"), content, isError: rows.every((r) => !r.block) };
  }

  // Folders become the images inside them.
  function expand(paths) {
    const files = [];
    for (const p of paths) {
      const f = abs(p);
      if (!existsSync(f)) continue;
      if (statSync(f).isDirectory()) files.push(...readdirSync(f).filter((n) => IMAGE_EXT.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((n) => join(f, n)));
      else files.push(f);
    }
    return files;
  }
  function outPath(save_to, fallbackName) {
    if (!save_to) return join(out, fallbackName);
    const f = abs(save_to);
    if (!isAllowed(f)) throw new Error(`${f} is outside the folders this chat may use.`);
    mkdirSync(dirname(f), { recursive: true });
    return f;
  }

  async function board(input) {
    const made = [];
    let files = expand(Array.isArray(input.paths) ? input.paths : [input.paths]);
    if (!files.length) throw new Error("No images found in those paths.");
    const names = files.map((f) => basename(f));
    files = await Promise.all(files.map(async (f) => { if (extname(f).toLowerCase() !== ".svg") return f; const png = await svgToPng(f); if (png) { made.push(png); return png; } return f; }));
    const layout = input.layout === "compare" ? "compare" : "grid";
    const sheet = outPath(input.save_to, `board-${stamp()}.jpg`), view = join(tmp, `boardview-${stamp()}.jpg`);
    const r = await py("board", { paths: files.slice(0, layout === "compare" ? 4 : 80), names, layout, cols: input.columns, cell: input.cell, labels: input.labels !== false, diff: !!input.diff, out: sheet, view, view_max: MAX_VIEW });
    if (r.error) throw new Error(r.error);
    for (const m of made) try { unlinkSync(m); } catch {}
    previewTo(sheet);
    const block = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(view).toString("base64") } };
    try { unlinkSync(view); } catch {}
    const note = `${layout === "compare" ? "Comparison" : "Board"} of ${r.count} image(s), ${r.w}x${r.h}, saved to ${sheet} and open in the user's preview.${r.skipped?.length ? " Couldn't open: " + r.skipped.join("; ") : ""}`;
    return { text: note, content: [{ type: "text", text: note }, block], isError: false };
  }

  // ---- upscaling
  const esrDir = join(homedir(), ".fabra-labs-ai", "tools", "realesrgan");
  const esrExe = join(esrDir, "realesrgan-ncnn-vulkan.exe");
  async function installEsrgan() {
    mkdirSync(esrDir, { recursive: true });
    const zip = join(tmp, "realesrgan.zip");
    const res = await fetch(REALESRGAN_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`Download failed (${res.status}).`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    const x = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${esrDir}' -Force`], { timeout: 180000 });
    try { unlinkSync(zip); } catch {}
    if (!existsSync(esrExe)) throw new Error("The download didn't unpack: " + (x.stderr || x.err?.message || "").slice(0, 200));
  }

  async function upscale(input) {
    const src = abs(input.path);
    if (!existsSync(src)) throw new Error(`${src} doesn't exist.`);
    const scale = Number(input.scale) === 4 ? 4 : 2;
    const info = await py("info", { in: src });
    if (info.error) throw new Error(info.error);
    const base = basename(src, extname(src));
    const dest = input.save_to ? outPath(input.save_to, "") : (isAllowed(dirname(src)) ? join(dirname(src), `${base}-x${scale}.png`) : join(out, `${base}-x${scale}.png`));
    let engine = "basic", note = "";
    const wantAi = input.engine !== "basic";
    if (wantAi && !existsSync(esrExe) && input.install) { try { await installEsrgan(); } catch (e) { note = `Couldn't install Real-ESRGAN (${e.message}). `; } }
    if (wantAi && existsSync(esrExe)) {
      if (info.w * info.h > 4e6) note += "This image is large (over 4 megapixels), so the AI upscaler was skipped. ";
      else {
        // The detailed model first; graphics cards with little memory can't run it, so the compact one is tried next
        // (and remembered, so the slow failure isn't repeated).
        const memo = join(esrDir, "model.txt");
        let order = ["realesrgan-x4plus", "realesr-animevideov3"];
        try { const m = readFileSync(memo, "utf8").trim(); if (order.includes(m)) order = [m, ...order.filter((x) => x !== m)]; } catch {}
        let last = "";
        for (const model of order) {
          const big = join(tmp, `esr-${stamp()}.png`), s = model === "realesrgan-x4plus" ? 4 : scale;
          const r = await run(esrExe, ["-i", src, "-o", big, "-n", model, "-s", String(s), "-f", "png"], { cwd: esrDir, timeout: 300000 });
          if (!existsSync(big)) { last = (r.stderr || r.err?.message || "no graphics support?").trim().split("\n").pop().slice(0, 160); continue; }
          const z = s === scale ? await py("convert", { in: big, out: dest, max: 100000 }) : await py("resize", { in: big, out: dest, factor: scale / s });
          try { unlinkSync(big); } catch {}
          if (z.error) throw new Error(z.error);
          try { writeFileSync(memo, model); } catch {}
          engine = model === "realesrgan-x4plus" ? "Real-ESRGAN" : "Real-ESRGAN (compact model: this graphics card is too small for the detailed one)";
          break;
        }
        if (engine === "basic") note += `Real-ESRGAN didn't produce a result (${last}), so a plain resize was used. `;
      }
    } else if (wantAi && !existsSync(esrExe)) note += "The AI upscaler (Real-ESRGAN) isn't installed; ask the user and call again with install: true to get it. A plain resize was used. ";
    if (engine === "basic") { const r = await py("upscale", { in: src, out: dest, scale }); if (r.error) throw new Error(r.error); }
    const after = await py("info", { in: dest });
    previewTo(dest);
    const text = `Saved ${dest} (${info.w}x${info.h} → ${after.w}x${after.h}, ${scale}x, ${engine === "basic" ? "plain resize" : engine}). ${note}Opened in the preview.`;
    return { text, isError: false };
  }

  return { viewImages, board, upscale };
}
